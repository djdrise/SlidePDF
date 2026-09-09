#!/usr/bin/env node
'use strict';

// Собирает значки приложения и PDF-файла из SVG силами Chromium: сторонних
// конвертеров SVG в системе может не быть, а Electron уже установлен.
// Скрипт самозапускается — под обычным Node он перезапускает себя в Electron.
//
//   assets/icon.png        1024×1024, из неё electron-builder делает .icns
//   assets/icon.ico        16…256 для Windows
//   assets/file-icon.png   1024×1024
//   assets/file-icon.ico   16…256, значок PDF в проводнике Windows
//   assets/file-icon.icns  16…1024, значок PDF в Finder (собирается только на macOS)
//
// Свои .ico и .icns нужны потому, что electron-builder ужимает одну картинку
// 1024×1024 до всех размеров сразу, а уменьшение в 64 раза размывает детали.
// Здесь каждый размер растрируется из вектора отдельно, в натуральную величину,
// а мелкие — из упрощённых исходников: на 16 пикселях наклон даёт «лесенку»,
// тонкие элементы пропадают, а надпись «PDF» превращается в грязь.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

/** Наборы: крупный исходник, упрощённый для мелких размеров и куда писать. */
const ICONS = {
  app: { big: 'icon.svg', small: 'icon-small.svg', png: 'icon.png', ico: 'icon.ico' },
  file: {
    big: 'file-icon.svg',
    small: 'file-icon-small.svg',
    png: 'file-icon.png',
    ico: 'file-icon.ico',
    icns: 'file-icon.icns',
  },
};

const PNG_SIZE = 1024;
/** Размеры внутри .ico: 16 и 24 Windows берёт для списка файлов, 32 и 48 — для крупных значков. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Размеры внутри .icns, как их ждёт iconutil. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];
/** До какого размера включительно рисуем упрощённым исходником. */
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

const { app, BrowserWindow, screen } = require('electron');
app.disableHardwareAcceleration();

const read = (name) => fs.readFileSync(path.join(ASSETS, name), 'utf8');

/** Инлайним SVG несколько раз на одной странице — id градиента должен быть свой. */
function unique(source, suffix) {
  return source.replace(/id="tile"/g, `id="tile${suffix}"`).replace(/url\(#tile\)/g, `url(#tile${suffix})`);
}

function sourceFor(kind, size) {
  const set = ICONS[kind];
  return read(size <= SMALL_UPTO ? set.small : set.big);
}

async function capture(html, cssW, cssH) {
  const win = new BrowserWindow({
    width: cssW,
    height: cssH,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(
    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))',
  );
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

/**
 * Рисует всё одним кадром и нарезает. Размеры задаём в CSS-пикселях с поправкой
 * на плотность экрана, чтобы в пикселях устройства вышло ровно то, что нужно:
 * SVG растрируется сразу в нужном размере, без единого уменьшения.
 *
 * Всё в одном окне не для красоты: в песочнице этой машины второе окно Electron
 * не поднимается (mach_port_rendezvous: Permission denied), и разбивка на два
 * кадра просто не работает.
 */
async function renderAll(cells, scale) {
  const cell = (kind, size, id) => {
    const svg = unique(sourceFor(kind, size), id).replace(
      /width="1024" height="1024"/,
      'width="100%" height="100%"',
    );
    const css = size / scale;
    return `<div style="width:${css}px;height:${css}px;overflow:hidden">${svg}</div>`;
  };

  const stripHeight = cells.reduce((a, c) => a + c.size, 0);
  const stripWidth = Math.max(...cells.map((c) => c.size));
  const sheetWidth = PNG_SIZE * 2 + stripWidth;
  const sheetHeight = Math.max(PNG_SIZE, stripHeight);

  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent}
    .row{display:flex;align-items:flex-start}
    .col{display:flex;flex-direction:column}
    div svg{display:block}
  </style>
  <div class="row">
    ${cell('app', PNG_SIZE, 'A')}
    ${cell('file', PNG_SIZE, 'F')}
    <div class="col">${cells.map((c, i) => cell(c.kind, c.size, i)).join('')}</div>
  </div>`;

  const sheet = await capture(html, sheetWidth / scale, sheetHeight / scale);
  const got = sheet.getSize();
  if (got.width !== sheetWidth || got.height !== sheetHeight) {
    throw new Error(`кадр ${got.width}×${got.height}, ожидался ${sheetWidth}×${sheetHeight}`);
  }

  const out = new Map();
  out.set(`app:${PNG_SIZE}`, sheet.crop({ x: 0, y: 0, width: PNG_SIZE, height: PNG_SIZE }));
  out.set(`file:${PNG_SIZE}`, sheet.crop({ x: PNG_SIZE, y: 0, width: PNG_SIZE, height: PNG_SIZE }));
  let y = 0;
  for (const { kind, size } of cells) {
    out.set(`${kind}:${size}`, sheet.crop({ x: PNG_SIZE * 2, y, width: size, height: size }));
    y += size;
  }
  return out;
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

function writeIco(file, images) {
  const entries = ICO_SIZES.map((size) => ({
    size,
    // От 128 и выше кладём PNG, ниже — DIB, его читают вообще все версии
    // Windows. Дело не только в размере файла: app-builder, вшивая значок в
    // .exe, пишет длину записи в 16 бит, и всё, что больше 65535 байт,
    // обрезается. DIB 128×128 весит 67624 байта и попадал ровно под это —
    // в ресурсах .exe длина превращалась в 2088, и значок такого размера
    // не читался. PNG-версия весит единицы килобайт и под ограничение не идёт.
    data: size >= 128 ? images.get(size).toPNG() : dibFromBgra(images.get(size).toBitmap(), size),
  }));
  fs.writeFileSync(file, packIco(entries));
}

/** .icns собирает системный iconutil — он есть только на macOS. */
function writeIcns(file, images) {
  if (process.platform !== 'darwin') {
    console.log('assets/file-icon.icns — пропущено: iconutil есть только на macOS');
    return false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iconset-')) + '.iconset';
  fs.mkdirSync(dir, { recursive: true });
  const pairs = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of pairs) {
    fs.writeFileSync(path.join(dir, name), images.get(size).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', file]);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------

async function build() {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;

  const appSizes = [...ICO_SIZES].sort((a, b) => a - b);
  const fileSizes = [...new Set([...ICO_SIZES, ...ICNS_SIZES])]
    .filter((s) => s < PNG_SIZE)
    .sort((a, b) => a - b);
  const cells = [
    ...appSizes.map((size) => ({ kind: 'app', size })),
    ...fileSizes.map((size) => ({ kind: 'file', size })),
  ];
  for (const { size } of [...cells, { size: PNG_SIZE }]) {
    if (!Number.isInteger(size / scale)) {
      throw new Error(`размер ${size} не делится на плотность экрана ${scale} без остатка`);
    }
  }

  const shots = await renderAll(cells, scale);
  const appImages = new Map(appSizes.map((s) => [s, shots.get(`app:${s}`)]));
  const fileImages = new Map(fileSizes.map((s) => [s, shots.get(`file:${s}`)]));
  fileImages.set(PNG_SIZE, shots.get(`file:${PNG_SIZE}`));

  fs.writeFileSync(path.join(ASSETS, ICONS.app.png), shots.get(`app:${PNG_SIZE}`).toPNG());
  writeIco(path.join(ASSETS, ICONS.app.ico), appImages);
  fs.writeFileSync(path.join(ASSETS, ICONS.file.png), shots.get(`file:${PNG_SIZE}`).toPNG());
  writeIco(path.join(ASSETS, ICONS.file.ico), fileImages);
  const icns = writeIcns(path.join(ASSETS, ICONS.file.icns), fileImages);

  console.log(`плотность экрана ${scale}`);
  console.log(`assets/icon.png, assets/file-icon.png — ${PNG_SIZE}×${PNG_SIZE}`);
  console.log(`assets/icon.ico, assets/file-icon.ico — размеры: ${ICO_SIZES.join(', ')}`);
  if (icns) console.log(`assets/file-icon.icns — размеры: ${ICNS_SIZES.join(', ')}`);
}

app.whenReady().then(async () => {
  try {
    await build();
  } catch (err) {
    console.error('сборка значков не удалась:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
