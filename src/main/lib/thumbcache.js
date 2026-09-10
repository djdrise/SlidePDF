'use strict';

// Дисковый кэш миниатюр: чистая часть — как назвать файл и что удалять,
// когда каталог разросся. Работа с файловой системой живёт в main.js.

const crypto = require('node:crypto');

/** Сколько места отдаём под кэш. */
const BUDGET = 200 * 1024 * 1024;

/**
 * Имя файла миниатюры. В ключ входит всё, от чего зависит картинка: сам файл
 * (устройство и inode вместо пути — файл могли переименовать), его время и
 * размер (правленый документ обязан перерисоваться), номер страницы и ширина.
 * @param {{dev: number, ino: number, mtimeMs: number, size: number}} stat
 */
function thumbKey(stat, page, width) {
  const id = `${stat.dev}:${stat.ino}:${Math.round(stat.mtimeMs)}:${stat.size}:${page}:${width}`;
  return crypto.createHash('sha1').update(id).digest('hex') + '.jpg';
}

/**
 * Какие файлы удалить, чтобы уложиться в бюджет. Сначала уходят те, к которым
 * дольше всего не обращались.
 * @param {Array<{name: string, size: number, atimeMs: number}>} files
 * @returns {string[]} имена на удаление
 */
function overBudget(files, budget = BUDGET) {
  let total = 0;
  for (const f of files) total += f.size;
  if (total <= budget) return [];

  const oldestFirst = [...files].sort((a, b) => a.atimeMs - b.atimeMs);
  const doomed = [];
  for (const f of oldestFirst) {
    if (total <= budget) break;
    doomed.push(f.name);
    total -= f.size;
  }
  return doomed;
}

module.exports = { thumbKey, overBudget, BUDGET };
