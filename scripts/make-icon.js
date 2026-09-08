#!/usr/bin/env node
'use strict';

// Собирает иконки приложения из SVG силами Chromium: сторонних конвертеров SVG
// в системе может не быть, а Electron уже установлен. Скрипт самозапускается —
// под обычным Node он перезапускает себя в Electron.
//
//   assets/icon.png  1024×1024 — из неё electron-builder делает .icns для macOS
//   assets/icon.ico  16…256    — для Windows собираем сами
//
// Свой .ico нужен потому, что electron-builder ужимает одну картинку 1024×1024
// до всех размеров сразу. Уменьшение в 64 раза размывает тонкие детали, а на
// 16 пикселях Windows показывает иконку в заголовке окна и в панели задач.
// Здесь каждый размер растрируется из вектора отдельно, а мелкие — из
// упрощённого знака icon-small.svg.

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SVG_BIG = path.join(ROOT, 'assets', 'icon.svg');
const SVG_SMALL = path.join(ROOT, 'assets', 'icon-small.svg');
const PNG = path.join(ROOT, 'assets', 'icon.png');
const ICO = path.join(ROOT, 'assets', 'icon.ico');

const PNG_SIZE = 1024;
/** Размеры внутри .ico. Windows берёт 16 и 24 для заголовка, 32 и 48 — для панели задач. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** До какого размера включительно рисуем упрощённым знаком. */
const SMALL_UPTO = 32;

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const electron = require('electron');
  const env = { ...process.env };
  // Терминал VS Code выставляет эту переменную, с ней electron стартует как Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename], { stdio: 'inherit', env });
  child.on('close', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

/** Инлайним SVG несколько раз на одной странице — id градиента должен быть свой. */
function svgWithUniqueIds(source, suffix) {
  return source.replace(/id="tile"/g, `id="tile${suffix}"`).replace(/url\(#tile\)/g, `url(#tile${suffix})`);
}

/**
 * Страница со всеми нужными размерами в столбик: один кадр, потом нарезаем.
 * Размеры задаём в CSS-пикселях с поправкой на плотность экрана, чтобы в
 * пикселях устройства вышло ровно то, что нужно: SVG растрируется сразу в
 * нужном размере, без единого уменьшения.
 */
function buildPage(sizes, scale) {
  const big = fs.readFileSync(SVG_BIG, 'utf8');
  const small = fs.readFileSync(SVG_SMALL, 'utf8');
  const blocks = sizes.map((size, i) => {
    const svg = svgWithUniqueIds(size <= SMALL_UPTO ? small : big, i);
    const css = size / scale;
    return `<div class="cell" style="width:${css}px;height:${css}px">${svg}</div>`;
  });
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    .cell{overflow:hidden}
    .cell svg{display:block;width:100%;height:100%}
  </style>${blocks.join('')}`;
}

// ---------------------------------------------------------------------------
// Упаковка .ico
// ---------------------------------------------------------------------------

/**
 * 32-битный DIB для одного размера. В .ico картинка хранится «вверх ногами»,
 * а следом идёт маска прозрачности — для 32 бит она нулевая, прозрачность
 * берётся из альфа-канала.
 * @param {Buffer} bgra пиксели BGRA сверху вниз
 */
function dibFromBgra(bgra, size) {
  const rowBytes = size * 4;
  const xor = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    bgra.copy(xor, (size - 1 - y) * rowBytes, y * rowBytes, (y + 1) * rowBytes);
  }
  const maskRow = Math.ceil(size / 8 / 4) * 4;
  const and = Buffer.alloc(maskRow * size); // нули: непрозрачность решает альфа

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: картинка + маска
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(xor.length + and.length, 20); // biSizeImage
  return Buffer.concat([header, xor, and]);
}

function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // зарезервировано
  header.writeUInt16LE(1, 2); // тип: иконка
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at); // 0 означает 256
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    dir.writeUInt8(0, at + 2); // палитра не используется
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4); // плоскости
    dir.writeUInt16LE(32, at + 6); // бит на пиксель
    dir.writeUInt32LE(e.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------------------

async function build() {
  const { screen } = require('electron');
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const sizes = ICO_SIZES;
  const totalHeight = sizes.reduce((a, b) => a + b, 0);
  const width = Math.max(...sizes);
  for (const size of sizes) {
    if (!Number.isInteger(size / scale)) {
      throw new Error(`размер ${size} не делится на плотность экрана ${scale} без остатка`);
    }
  }

  const win = new BrowserWindow({
    width: width / scale,
    height: totalHeight / scale,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildPage(sizes, scale)));
  await win.webContents.executeJavaScript(
    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))',
  );

  const sheet = await win.webContents.capturePage();
  const sheetSize = sheet.getSize();
  console.log(`плотность экрана ${scale}, кадр ${sheetSize.width}×${sheetSize.height} (ожидался ${width}×${totalHeight})`);
  if (sheetSize.width !== width || sheetSize.height !== totalHeight) {
    throw new Error('масштаб кадра не совпал: нарезка дала бы не те пиксели');
  }

  const entries = [];
  let y = 0;
  for (const size of sizes) {
    const crop = sheet.crop({ x: 0, y, width: size, height: size });
    y += size;
    // 256 кладём как PNG — так принято и файл меньше; мелкие как DIB, их
    // читают вообще все версии Windows.
    entries.push({
      size,
      data: size === 256 ? crop.toPNG() : dibFromBgra(crop.toBitmap(), size),
    });
  }
  fs.writeFileSync(ICO, packIco(entries));

  // Крупная картинка для macOS и Linux — отдельным кадром в натуральную величину.
  const bigWin = new BrowserWindow({
    width: PNG_SIZE / scale,
    height: PNG_SIZE / scale,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  const bigSvg = fs.readFileSync(SVG_BIG, 'utf8');
  await bigWin.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
         svg{display:block;width:${PNG_SIZE / scale}px;height:${PNG_SIZE / scale}px}</style>${bigSvg}`,
      ),
  );
  await bigWin.webContents.executeJavaScript(
    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))',
  );
  const bigImage = await bigWin.webContents.capturePage();
  fs.writeFileSync(PNG, bigImage.toPNG());

  console.log(`assets/icon.png — ${bigImage.getSize().width}×${bigImage.getSize().height}`);
  console.log(`assets/icon.ico — размеры: ${sizes.join(', ')}`);
}

app.whenReady().then(async () => {
  try {
    await build();
  } catch (err) {
    console.error('сборка иконок не удалась:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
