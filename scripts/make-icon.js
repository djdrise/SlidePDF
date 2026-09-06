#!/usr/bin/env node
'use strict';

// Собирает assets/icon.png из assets/icon.svg силами Chromium: сторонних
// конвертеров SVG в системе может не быть, а Electron уже установлен.
// Скрипт самозапускается: под обычным Node он перезапускает себя в Electron.

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const PNG = path.join(ROOT, 'assets', 'icon.png');
const SIZE = 1024;

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

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, 'utf8');
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // Даём кадру отрисоваться, иначе снимок может выйти пустым.
  await win.webContents.executeJavaScript(
    'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))',
  );

  let image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  if (width !== SIZE || height !== SIZE) image = image.resize({ width: SIZE, height: SIZE });

  fs.writeFileSync(PNG, image.toPNG());
  console.log(`assets/icon.png — ${SIZE}×${SIZE} (снимок ${width}×${height})`);
  app.quit();
});
