'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { clampPage, nextTabId, tabAfterClose, chooseLayout } = require('./lib/deck');
const { planLayout, centeredBounds } = require('./lib/layout');

const IS_MAC = process.platform === 'darwin';
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');
// На macOS иконку окна берёт бандл, здесь она нужна Windows и Linux.
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

/** @type {BrowserWindow|null} */ let presenterWin = null;
/** @type {BrowserWindow|null} */ let audienceWin = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Единый источник правды. Оба окна — только отражение этого объекта.
// Вкладка = открытый документ со своей текущей страницей.
// ---------------------------------------------------------------------------
const state = {
  /** @type {{id: string, path: string, name: string, pageCount: number, page: number}[]} */
  docs: [],
  activeId: null,
  blank: 'none', // none | black
  /**
   * Стоп-кадр: зал остаётся на этом слайде, пока лектор листает у себя.
   * Держим и вкладку, и страницу — иначе переключение вкладок утащило бы
   * зал за собой, а весь смысл в обратном.
   * @type {{docId: string, page: number}|null}
   */
  freeze: null,
  /** Открывать вкладки прошлого запуска. Настройка из окна настроек. */
  reopenLast: false,
  /** Список экранов для окна настроек. */
  displays: [],
  /** Экран показа выбран вручную — автоматика его больше не переназначает. */
  audiencePinned: false,
  presenterDisplayId: null,
  audienceDisplayId: null,
  displayCount: 1,
  audienceFullscreen: false,
  audienceVisible: false,
};

let nextDocId = 1;

function activeDoc() {
  return state.docs.find((d) => d.id === state.activeId) || null;
}

function docById(id) {
  return state.docs.find((d) => d.id === id) || null;
}

/** Пункт меню «Показ» гаснет вместе с кнопкой, когда показывать нечего. */
let menuHasDoc = null;
function syncMenu() {
  const has = Boolean(activeDoc());
  if (has === menuHasDoc) return;
  menuHasDoc = has;
  buildMenu();
}

// Настройки переживают перезапуск: лежат рядом с остальными данными программы.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8'));
    state.reopenLast = Boolean(saved.reopenLast);
    return Array.isArray(saved.files) ? saved : { files: [], activePath: null };
  } catch {
    // Файла ещё нет или он испорчен — остаёмся на значениях по умолчанию.
    return { files: [], activePath: null };
  }
}

function saveSettings() {
  // Пути запоминаем только при включённой опции: выключил — программа и не
  // помнит, что вы открывали.
  const active = activeDoc();
  const data = state.reopenLast
    ? { reopenLast: true, files: state.docs.map((d) => d.path), activePath: active ? active.path : null }
    : { reopenLast: false };
  try {
    fsSync.writeFileSync(settingsFile(), JSON.stringify(data, null, 2));
  } catch {
    /* не смогли сохранить — на работу программы это не влияет */
  }
}

function broadcast() {
  syncMenu();
  const payload = {
    ...state,
    docs: state.docs.map((d) => ({ ...d })),
    displays: state.displays.map((d) => ({ ...d })),
  };
  for (const win of [presenterWin, audienceWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state', payload);
  }
}

// ---------------------------------------------------------------------------
// Дисплеи
// ---------------------------------------------------------------------------
function displayById(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || null;
}

/** Пересобирает список экранов для окна настроек. */
function refreshDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  state.displays = screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `Дисплей ${i + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
    primary: d.id === primaryId,
  }));
}

/** Раскладка по умолчанию: лектор на основном, зрители на внешнем. */
function defaultDisplayLayout() {
  return chooseLayout(
    screen.getAllDisplays().map((d) => d.id),
    screen.getPrimaryDisplay().id,
  );
}

/**
 * Показывает окно зрителей, когда оно уже перерисовалось под новый размер.
 * Всё время смены геометрии окно держится прозрачным, поэтому ни растягивание
 * рамки, ни «догоняющий» размер слайда наружу не видны.
 */
/** Счётчик запусков показа: по нему отложенное проявление узнаёт, что его отменили. */
let showEpoch = 0;

async function revealAudience(win, epoch) {
  const { width, height } = win.getBounds();
  try {
    await Promise.race([
      win.webContents.executeJavaScript(
        `window.__slidePrepare ? window.__slidePrepare(${width}, ${height}) : null`,
        true,
      ),
      // Страховка: renderer мог ещё не загрузиться или зависнуть на рендере.
      new Promise((r) => setTimeout(r, 600)),
    ]);
  } catch {
    /* окно закрылось или скрипт недоступен — показываем как есть */
  }
  if (!win || win.isDestroyed()) return;
  // Показ могли завершить, пока мы ждали отрисовку: тогда окно уже спрятано,
  // и проявлять его, да ещё забирать фокус у лектора, точно не надо.
  if (epoch !== showEpoch) return;
  win.setOpacity(1);
  win.moveTop();
  win.focus();
}

function enterPresentationFullscreen(win, display) {
  if (!win || win.isDestroyed() || !display) return;
  showEpoch += 1;

  // Состояние — раньше геометрии: renderer должен успеть убрать полоску-заголовок
  // и перерисовать слайд под полный экран, пока окно ещё невидимо.
  state.audienceFullscreen = true;
  broadcast();

  win.setOpacity(0);
  if (!win.isVisible()) win.showInactive();
  // Порядок важен: на macOS setVisibleOnAllWorkspaces переустанавливает уровень
  // окна, поэтому alwaysOnTop должен идти после него — иначе показ остаётся под
  // строкой меню и Dock.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBounds(display.bounds);
  // На macOS обычный fullscreen создаёт отдельный Space с анимацией перехода;
  // simpleFullScreen разворачивает окно на весь экран мгновенно.
  if (IS_MAC) win.setSimpleFullScreen(true);
  else win.setFullScreen(true);
  win.setAlwaysOnTop(true, 'screen-saver');

  // Фокус сразу на полноэкранном окне: кликер и клавиши бьют в показ.
  revealAudience(win, showEpoch);
}

function exitPresentationFullscreen(win, display) {
  if (!win || win.isDestroyed()) return;
  showEpoch += 1;
  state.audienceFullscreen = false;
  state.freeze = null;
  broadcast();

  win.setOpacity(0);
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(false);
  if (IS_MAC) win.setSimpleFullScreen(false);
  else win.setFullScreen(false);
  if (display) centerOn(win, display, 0.5);
  win.hide();
  // Прозрачность возвращаем: иначе окно, показанное потом вручную, окажется
  // невидимым — setOpacity переживает hide.
  win.setOpacity(1);
}

function isFullscreenNow(win) {
  if (!win || win.isDestroyed()) return false;
  return IS_MAC ? win.isSimpleFullScreen() : win.isFullScreen();
}

/**
 * Приводит окна в соответствие с выбранными дисплеями. Показ отсюда никогда
 * не запускается: окно зрителей появляется только по команде «Показ».
 */
function applyDisplayLayout() {
  const displays = screen.getAllDisplays();
  state.displayCount = displays.length;
  refreshDisplays();

  const plan = planLayout({
    displayIds: displays.map((d) => d.id),
    primaryId: screen.getPrimaryDisplay().id,
    presenterDisplayId: state.presenterDisplayId,
    audienceDisplayId: state.audienceDisplayId,
    audiencePinned: state.audiencePinned,
    showing: state.audienceFullscreen,
    presenterFullscreen: Boolean(
      presenterWin && !presenterWin.isDestroyed() && presenterWin.isFullScreen(),
    ),
    presenterOn: displayIdOf(presenterWin),
    audienceOn: displayIdOf(audienceWin),
  });

  state.presenterDisplayId = plan.presenterDisplayId;
  state.audienceDisplayId = plan.audienceDisplayId;
  state.audiencePinned = plan.audiencePinned;

  const presenterDisplay = displayById(state.presenterDisplayId);
  const audienceDisplay = displayById(state.audienceDisplayId);

  if (plan.presenter === 'center') centerOn(presenterWin, presenterDisplay, 0.85);

  if (audienceWin && !audienceWin.isDestroyed()) {
    if (plan.audience === 'exit') {
      // Проектор отключили прямо в показе — возвращаем лектора к его интерфейсу.
      exitPresentationFullscreen(audienceWin, audienceDisplay);
      presenterWin?.focus();
    } else if (plan.audience === 'enter') {
      enterPresentationFullscreen(audienceWin, audienceDisplay);
    } else if (plan.audience === 'center') {
      centerOn(audienceWin, audienceDisplay, 0.5);
    }
  }
  broadcast();
}

/** На каком дисплее окно находится сейчас. null — окна нет. */
function displayIdOf(win) {
  if (!win || win.isDestroyed()) return null;
  return screen.getDisplayMatching(win.getBounds()).id;
}

function centerOn(win, display, scale = 0.8) {
  if (!win || win.isDestroyed() || !display) return;
  win.setBounds(centeredBounds(display.workArea, scale));
}

// ---------------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------------
function createWindows() {
  Object.assign(state, defaultDisplayLayout());
  state.displayCount = screen.getAllDisplays().length;
  refreshDisplays();
  const presenterDisplay = displayById(state.presenterDisplayId);
  const audienceDisplay = displayById(state.audienceDisplayId);

  presenterWin = new BrowserWindow({
    title: 'SlidePDF',
    icon: ICON,
    backgroundColor: '#ffffff',
    show: false,
    minWidth: 900,
    minHeight: 560,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  centerOn(presenterWin, presenterDisplay, 0.85);
  presenterWin.loadFile(path.join(RENDERER, 'presenter.html'));
  presenterWin.once('ready-to-show', () => presenterWin.show());
  presenterWin.on('closed', () => {
    presenterWin = null;
    app.quit();
  });

  audienceWin = new BrowserWindow({
    title: 'SlidePDF — экран зрителей',
    icon: ICON,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    // Без рамки: в показе окна не должно быть видно вовсе, а в режиме превью
    // его заменяет собственная полоска-заголовок в audience.html.
    frame: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  centerOn(audienceWin, audienceDisplay, 0.5);
  audienceWin.loadFile(path.join(RENDERER, 'audience.html'));
  audienceWin.once('ready-to-show', () => {
    // Окно зрителей на старте не показываем вовсе: оно появляется только по
    // «Показ» (F5). Иначе второе окно всплывает поверх рабочего стола ещё до
    // того, как докладчик к нему готов. Открыть его заранее можно вручную —
    // пункт «Показать/скрыть окно зрителей» в меню.
    presenterWin?.focus();
    broadcast();
  });
  audienceWin.on('close', (e) => {
    // Окно зрителей не закрываем — прячем, иначе посреди доклада его не вернуть.
    if (!quitting) {
      e.preventDefault();
      audienceWin.hide();
      state.audienceVisible = false;
      broadcast();
    }
  });
  if (!IS_MAC) {
    audienceWin.on('enter-full-screen', () => {
      state.audienceFullscreen = true;
      broadcast();
    });
    audienceWin.on('leave-full-screen', () => {
      state.audienceFullscreen = false;
      audienceWin.setAlwaysOnTop(false);
      broadcast();
    });
  }
  audienceWin.on('show', () => {
    state.audienceVisible = true;
    broadcast();
  });
  audienceWin.on('hide', () => {
    state.audienceVisible = false;
    broadcast();
  });

  if (process.argv.includes('--dev')) {
    for (const win of [presenterWin, audienceWin]) {
      const tag = win === presenterWin ? 'presenter' : 'audience';
      win.webContents.on('console-message', (...args) => {
        // Сигнатура события менялась между версиями Electron.
        const d = args[1];
        const msg =
          typeof d === 'object' && d !== null ? `${d.message} (${d.sourceId}:${d.lineNumber})` : args[2];
        console.log(`[${tag}] ${msg}`);
      });
      win.webContents.on('render-process-gone', (_e, details) =>
        console.error(`[${tag}] render-process-gone`, details));
    }
  }

  for (const win of [presenterWin, audienceWin]) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }
}

// ---------------------------------------------------------------------------
// Вкладки
// ---------------------------------------------------------------------------
async function openPath(filePath, { silent = false } = {}) {
  if (!filePath) return;
  const full = path.resolve(filePath);

  // Отпечаток файла — том и inode. Сравнивать пути строками нельзя: на macOS и
  // Windows файловая система нечувствительна к регистру, и «Deck.pdf» открылся
  // бы второй вкладкой того же файла. Заодно так распознаются симлинки.
  let key = null;
  try {
    const stats = await fs.stat(full);
    key = `${stats.dev}:${stats.ino}`;
  } catch (err) {
    // При восстановлении вкладок файл мог переехать или исчезнуть — молча
    // пропускаем, диалог на каждый такой файл только раздражал бы на старте.
    if (!silent) dialog.showErrorBox('Не удалось открыть файл', `${full}\n\n${err.message}`);
    return;
  }

  // Файл уже открыт — просто переключаемся на его вкладку.
  const existing = state.docs.find((d) => (d.key ? d.key === key : d.path === full));
  if (existing) {
    state.activeId = existing.id;
    state.blank = 'none';
    broadcast();
    return;
  }

  const doc = {
    id: `d${nextDocId++}`,
    path: full,
    key,
    name: path.basename(full),
    pageCount: 0,
    page: 1,
  };
  state.docs.push(doc);
  state.activeId = doc.id;
  state.blank = 'none';
  app.addRecentDocument(full);
  saveSettings();
  broadcast();
}

async function openDialog() {
  const res = await dialog.showOpenDialog(presenterWin, {
    title: 'Открыть презентацию',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return;
  for (const p of res.filePaths) await openPath(p);
}

function closeDoc(id) {
  const i = state.docs.findIndex((d) => d.id === id);
  if (i === -1) return;
  // Замороженной вкладки больше нет — держать зал не на чем.
  if (state.freeze && state.freeze.docId === id) state.freeze = null;
  const nextActive = tabAfterClose(state.docs, id, state.activeId);
  state.docs.splice(i, 1);
  if (nextActive !== state.activeId) {
    state.activeId = nextActive;
    state.blank = 'none';
  }
}

function stepTab(delta) {
  const id = nextTabId(state.docs, state.activeId, delta);
  if (!id) return;
  state.activeId = id;
  state.blank = 'none';
}

// ---------------------------------------------------------------------------
// Команды из renderer
// ---------------------------------------------------------------------------
const commands = {
  open: () => openDialog(),
  openPath: ({ path: p }) => openPath(p),

  next: () => {
    const doc = activeDoc();
    if (!doc) return;
    doc.page = clampPage(doc.pageCount, doc.page + 1);
    state.blank = 'none';
  },
  prev: () => {
    const doc = activeDoc();
    if (!doc) return;
    doc.page = clampPage(doc.pageCount, doc.page - 1);
    state.blank = 'none';
  },
  goto: ({ page }) => {
    const doc = activeDoc();
    if (!doc) return;
    doc.page = clampPage(doc.pageCount, page);
    state.blank = 'none';
  },
  first: () => {
    const doc = activeDoc();
    if (!doc) return;
    doc.page = 1;
    state.blank = 'none';
  },
  last: () => {
    const doc = activeDoc();
    if (!doc) return;
    doc.page = clampPage(doc.pageCount, doc.pageCount);
    state.blank = 'none';
  },

  blank: ({ mode }) => {
    state.blank = state.blank === mode ? 'none' : mode;
  },

  /**
   * Приватная навигация: зал замирает на текущем слайде, лектор листает
   * свободно. Ни переходы, ни смена вкладки стоп-кадр не снимают — только
   * повторное нажатие, закрытие этой вкладки или конец показа.
   */
  'freeze:toggle': () => {
    if (state.freeze) {
      state.freeze = null;
      return;
    }
    const doc = activeDoc();
    if (!doc) return;
    state.freeze = { docId: doc.id, page: doc.page };
  },

  'doc:meta': ({ id, pageCount }) => {
    const doc = docById(id);
    if (!doc) return;
    doc.pageCount = Number(pageCount) || 0;
    doc.page = clampPage(doc.pageCount, doc.page);
  },

  /** Renderer не смог разобрать файл: закрываем вкладку и говорим об этом вслух. */
  'doc:failed': ({ id, message }) => {
    const doc = docById(id);
    if (!doc) return;
    closeDoc(id);
    dialog.showErrorBox(
      'Не удалось открыть файл',
      `${doc.path}\n\n${message || 'файл повреждён или защищён паролем'}`,
    );
  },

  'tab:activate': ({ id }) => {
    if (!docById(id)) return;
    state.activeId = id;
    state.blank = 'none';
  },
  'tab:next': () => stepTab(1),
  'tab:prev': () => stepTab(-1),
  'tab:close': ({ id }) => {
    closeDoc(id || state.activeId);
    saveSettings();
  },

  /** Галочка «открывать последние файлы» из окна настроек. */
  'settings:set': ({ reopenLast }) => {
    if (typeof reopenLast !== 'boolean' || reopenLast === state.reopenLast) return;
    state.reopenLast = reopenLast;
    saveSettings();
  },

  'audience:toggleFullscreen': () => {
    if (!audienceWin || audienceWin.isDestroyed()) return;
    if (isFullscreenNow(audienceWin)) {
      commands['audience:exitFullscreen']();
      return;
    }
    // Пустой показ запускать незачем: на проектор ушло бы приглашение открыть
    // файл. Выход из показа при этом не блокируем — он выше по коду.
    if (!activeDoc()) return;
    enterPresentationFullscreen(audienceWin, displayById(state.audienceDisplayId));
  },

  'audience:exitFullscreen': () => {
    if (!audienceWin || audienceWin.isDestroyed()) return;
    if (!isFullscreenNow(audienceWin)) return;
    exitPresentationFullscreen(audienceWin, displayById(state.audienceDisplayId));
    presenterWin?.focus();
  },

  /** Выбор экрана показа из окна настроек. */
  'display:setAudience': ({ id }) => {
    const target = Number(id);
    const display = displayById(target);
    if (!display) return;

    const wasShowing = state.audienceFullscreen;
    if (wasShowing && audienceWin && !audienceWin.isDestroyed()) {
      // Гасим окно на время переезда, иначе видно, как оно прыгает между экранами.
      audienceWin.setOpacity(0);
      if (IS_MAC) audienceWin.setSimpleFullScreen(false);
      else audienceWin.setFullScreen(false);
    }

    state.audienceDisplayId = target;
    state.audiencePinned = true;
    // Лектору отдаём любой другой экран; если он один — оба окна на нём.
    const other = screen.getAllDisplays().find((d) => d.id !== target);
    state.presenterDisplayId = other ? other.id : target;

    if (wasShowing) enterPresentationFullscreen(audienceWin, display);
    applyDisplayLayout();
  },

  'audience:toggleVisible': () => {
    if (!audienceWin || audienceWin.isDestroyed()) return;
    if (audienceWin.isVisible()) audienceWin.hide();
    else audienceWin.show();
    presenterWin?.focus();
  },

  'presenter:toggleFullscreen': () => {
    if (!presenterWin || presenterWin.isDestroyed()) return;
    presenterWin.setFullScreen(!presenterWin.isFullScreen());
  },
};

ipcMain.on('cmd', async (_e, msg) => {
  const fn = commands[msg?.type];
  if (!fn) return;
  try {
    await fn(msg.payload || {});
  } catch (err) {
    // Без этого упавшая команда пропускала бы broadcast и оба окна замирали
    // на устаревшем состоянии, а reject оседал необработанным.
    console.error(`команда ${msg.type} завершилась ошибкой:`, err);
  }
  broadcast();
});

ipcMain.handle('state:get', () => ({ ...state, docs: state.docs.map((d) => ({ ...d })) }));

/** Байты документа по требованию окна: каждое окно рендерит PDF само. */
ipcMain.handle('doc:bytes', async (_e, id) => {
  const doc = docById(id);
  if (!doc) return null;
  try {
    const bytes = await fs.readFile(doc.path);
    return { id: doc.id, name: doc.name, bytes: new Uint8Array(bytes) };
  } catch (err) {
    dialog.showErrorBox('Не удалось прочитать файл', `${doc.path}\n\n${err.message}`);
    return null;
  }
});

// ---------------------------------------------------------------------------
// Меню
// ---------------------------------------------------------------------------
function buildMenu() {
  const send = (type, payload) => () => {
    commands[type]?.(payload || {});
    broadcast();
  };
  // Клавиши обрабатывает renderer: если зарегистрировать акселератор здесь,
  // меню перехватит его глобально, и стрелки в сетке слайдов будут листать
  // показ вместо перемещения выделения. registerAccelerator: false оставляет
  // подсказку в меню, но не занимает клавишу.
  const hint = (accelerator) => ({ accelerator, registerAccelerator: false });
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть PDF…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: send('tab:close') },
        {
          label: 'Недавние',
          role: 'recentDocuments',
          submenu: [{ label: 'Очистить', role: 'clearRecentDocuments' }],
        },
        { type: 'separator' },
        IS_MAC ? { role: 'quit' } : { role: 'quit' },
      ],
    },
    {
      label: 'Показ',
      submenu: [
        {
          label: 'Начать / завершить показ',
          ...hint('F5'),
          enabled: Boolean(activeDoc()),
          click: send('audience:toggleFullscreen'),
        },
        { type: 'separator' },
        { label: 'Следующий слайд', ...hint('Right'), click: send('next') },
        { label: 'Предыдущий слайд', ...hint('Left'), click: send('prev') },
        { type: 'separator' },
        { label: 'Чёрный экран', ...hint('B'), click: send('blank', { mode: 'black' }) },
        {
          label: 'Стоп-кадр для зала',
          ...hint('F'),
          enabled: Boolean(activeDoc()),
          click: send('freeze:toggle'),
        },
      ],
    },
    {
      label: 'Вкладки',
      submenu: [
        { label: 'Следующая вкладка', ...hint('Ctrl+Tab'), click: send('tab:next') },
        { label: 'Предыдущая вкладка', ...hint('Shift+Tab'), click: send('tab:prev') },
      ],
    },
    {
      label: 'Окна',
      submenu: [
        { label: 'Показать/скрыть окно зрителей', click: send('audience:toggleVisible') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Жизненный цикл
// ---------------------------------------------------------------------------
let pendingFiles = process.argv.slice(1).filter((a) => a.toLowerCase().endsWith('.pdf'));

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) openPath(filePath);
  else pendingFiles.push(filePath);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    for (const f of argv.filter((a) => a.toLowerCase().endsWith('.pdf'))) await openPath(f);
    presenterWin?.focus();
  });
}

app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  const saved = loadSettings();
  createWindows();
  buildMenu();

  screen.on('display-added', () => applyDisplayLayout());
  screen.on('display-removed', () => applyDisplayLayout());
  screen.on('display-metrics-changed', () => applyDisplayLayout());

  // Файлы из командной строки важнее сохранённых: пользователь открыл их сам.
  const restore = pendingFiles.length ? pendingFiles : state.reopenLast ? saved.files : [];
  const silent = pendingFiles.length === 0;
  if (restore.length) {
    // Даём окнам дойти до did-finish-load, иначе состояние уйдёт в пустоту.
    const ready = [presenterWin, audienceWin].map(
      (w) => new Promise((res) => w.webContents.once('did-finish-load', res)),
    );
    Promise.all(ready).then(async () => {
      for (const f of restore) await openPath(f, { silent });
      // Возвращаем ту вкладку, на которой закончили прошлый раз.
      if (silent && saved.activePath) {
        const doc = state.docs.find((d) => d.path === path.resolve(saved.activePath));
        if (doc) state.activeId = doc.id;
      }
      broadcast();
    });
  }

  app.on('activate', () => {
    if (presenterWin) presenterWin.show();
  });
});

app.on('window-all-closed', () => app.quit());
