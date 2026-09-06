#!/usr/bin/env node
'use strict';

// Терминал VS Code (и любой процесс, запущенный из Electron-приложения) наследует
// ELECTRON_RUN_AS_NODE=1. С этой переменной бинарник electron стартует как обычный
// Node, require('electron') возвращает строку с путём, и приложение падает.
// Поэтому запускаем через собственный лаунчер с очищенным окружением.

const { spawn } = require('node:child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
});

child.on('close', (code, signal) => process.exit(signal ? 1 : code ?? 0));
