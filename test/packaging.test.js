'use strict';

// Проверки того, что расходится молча: сборка и код хранят одни и те же
// значения в разных файлах, и рассинхрон виден только на готовом установщике.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('идентификатор для панели задач Windows совпадает с appId', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const m = /setAppUserModelId\('([^']+)'\)/.exec(main);
  assert.ok(m, 'вызов setAppUserModelId не найден');
  assert.equal(m[1], pkg.build.appId);
});

/**
 * Разбирает оглавление .ico: размер, чем закодировано и объявленную длину.
 * @param {string} file
 */
function icoEntries(file) {
  const b = fs.readFileSync(file);
  const count = b.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const offset = b.readUInt32LE(at + 12);
    out.push({
      size: b[at] || 256,
      bytes: b.readUInt32LE(at + 8),
      png: b.readUInt32BE(offset) === 0x89504e47,
    });
  }
  return out;
}

for (const name of ['icon.ico', 'file-icon.ico']) {
  test(`${name}: ни одна запись не превышает 65535 байт`, () => {
    const entries = icoEntries(path.join(root, 'assets', name));
    assert.ok(entries.length > 0, 'значок пуст');
    for (const e of entries) {
      // app-builder, вшивая значок в .exe, пишет длину записи в 16 бит.
      // Всё, что больше, обрезается, и Windows такой размер не отрисовывает.
      assert.ok(
        e.bytes <= 0xffff,
        `запись ${e.size}px весит ${e.bytes} байт — длина не влезет в 16 бит`,
      );
    }
  });

  test(`${name}: крупные размеры сжаты в PNG, мелкие оставлены DIB`, () => {
    for (const e of icoEntries(path.join(root, 'assets', name))) {
      assert.equal(e.png, e.size >= 128, `${e.size}px закодирован не тем способом`);
    }
  });
}
