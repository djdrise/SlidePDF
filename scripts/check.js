#!/usr/bin/env node
'use strict';

// Синтаксическая проверка всех исходников. Тестов в проекте нет, это
// минимальный барьер, который ловит опечатки до запуска приложения.
// Код renderer-а — ES-модули, main и preload — CommonJS, поэтому проверяем
// каждый файл в его собственном режиме.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d))).sort();
let failed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const isModule = rel.startsWith(path.join('src', 'renderer'));
  const args = isModule ? ['--input-type=module', '--check'] : ['--check', file];
  try {
    if (isModule) execFileSync(process.execPath, args, { input: fs.readFileSync(file) });
    else execFileSync(process.execPath, args);
    console.log(`  ok  ${rel}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${rel}\n${err.stderr?.toString() || err.message}`);
  }
}

console.log(`\n${files.length - failed} из ${files.length} файлов без ошибок`);
process.exit(failed ? 1 : 0);
