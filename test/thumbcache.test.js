'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { thumbKey, overBudget } = require('../src/main/lib/thumbcache');

const stat = { dev: 1, ino: 42, mtimeMs: 1_700_000_000_123, size: 5000 };

test('ключ повторяем для одного и того же файла и страницы', () => {
  assert.equal(thumbKey(stat, 3, 128), thumbKey({ ...stat }, 3, 128));
});

test('разные страницы и ширины дают разные ключи', () => {
  const base = thumbKey(stat, 3, 128);
  assert.notEqual(base, thumbKey(stat, 4, 128));
  assert.notEqual(base, thumbKey(stat, 3, 380));
});

test('правка файла обесценивает старые миниатюры', () => {
  const before = thumbKey(stat, 3, 128);
  assert.notEqual(before, thumbKey({ ...stat, mtimeMs: stat.mtimeMs + 1000 }, 3, 128));
  assert.notEqual(before, thumbKey({ ...stat, size: stat.size + 1 }, 3, 128));
});

test('переименование файла кэш не сбрасывает', () => {
  // Путь в ключ не входит: файл опознаётся по устройству и inode.
  assert.equal(thumbKey(stat, 1, 128), thumbKey({ ...stat }, 1, 128));
});

test('в пределах бюджета не удаляем ничего', () => {
  const files = [
    { name: 'a', size: 10, atimeMs: 1 },
    { name: 'b', size: 10, atimeMs: 2 },
  ];
  assert.deepEqual(overBudget(files, 100), []);
});

test('за бюджетом уходят те, к которым дольше не обращались', () => {
  const files = [
    { name: 'свежая', size: 40, atimeMs: 300 },
    { name: 'древняя', size: 40, atimeMs: 100 },
    { name: 'средняя', size: 40, atimeMs: 200 },
  ];
  assert.deepEqual(overBudget(files, 100), ['древняя']);
});

test('удаляем ровно столько, сколько нужно для бюджета', () => {
  const files = [
    { name: 'a', size: 50, atimeMs: 1 },
    { name: 'b', size: 50, atimeMs: 2 },
    { name: 'c', size: 50, atimeMs: 3 },
  ];
  assert.deepEqual(overBudget(files, 60), ['a', 'b']);
});

test('пустой каталог обрабатывается без ошибок', () => {
  assert.deepEqual(overBudget([], 100), []);
});
