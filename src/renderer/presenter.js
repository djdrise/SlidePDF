import { loadDoc, SlideView, renderThumb, pageText } from './lib/pdfview.js';
import { RenderQueue } from './lib/renderqueue.js';
import { bindKeys, bindDropOpen } from './lib/keys.js';

const $ = (id) => document.getElementById(id);

const els = {
  tabs: $('tabs'),
  pages: $('pages'),
  chip: $('display-chip'),
  chipName: $('chip-name'),
  chipMeta: $('chip-meta'),
  blankFlag: $('blank-flag'),
  freezeFlag: $('freeze-flag'),
  nextNum: $('next-num'),
  notes: $('notes'),
  filmstrip: $('filmstrip'),
  overview: $('overview'),
  overviewGrid: $('overview-grid'),
  overviewTotal: $('overview-total'),
  empty: $('empty'),
  settings: $('settings'),
  displayList: $('display-list'),
  reopenLast: $('reopen-last'),
  showBtn: $('btn-fullscreen'),
};

const currentView = new SlideView($('stage-current'));
const nextView = new SlideView($('stage-next'));

/** Разобранные документы живут по id вкладки, чтобы переключение было мгновенным.
 *  В кэше лежат промисы: пока файл читается, повторный заход не начинает вторую
 *  загрузку того же документа. */
const cache = new Map();
let activePdf = null;
let loadedId = null;
let loadingId = null;
let state = null;
let overviewOpen = false;
let overviewSel = 1;
let lastRenderKey = '';
let lastTabsKey = '';
let lastDisplaysKey = '';
let settingsOpen = false;

// ---------------------------------------------------------------------------
// Полоса миниатюр — порядок слайдов. Рендерится лениво, по мере прокрутки,
// и обязательно по одной за раз: см. lib/renderqueue.js.
// ---------------------------------------------------------------------------

/**
 * Одна очередь на полосу и на сетку, чтобы они не отбирали время друг у друга.
 *
 * Четыре задачи разом — не на глаз, а по замеру: время страницы почти целиком
 * уходит на поход в воркер, а не на счёт, поэтому параллельные задачи почти не
 * мешают друг другу. На тяжёлом документе двенадцать миниатюр занимают 216 мс
 * по одной и 101 мс по четыре, а первая появляется одинаково быстро — около
 * 30 мс. Дальше четырёх выигрыша уже нет, зато первая миниатюра начинает
 * ждать: при восьми — 64 мс, при двенадцати — 97 мс. Это ровно то, из-за чего
 * лента и казалась медленной, когда все видимые миниатюры стартовали разом.
 */
const thumbQueue = new RenderQueue(4);

/** Насколько далеко от видимой области миниатюру ещё имеет смысл рисовать. */
const NEAR_MARGIN = 600;

/** Копия канвы: одну и ту же нельзя показать в двух местах разметки. */
function copyCanvas(src) {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.style.width = src.style.width;
  out.style.height = src.style.height;
  out.getContext('2d', { alpha: false }).drawImage(src, 0, 0);
  return out;
}

class ThumbGrid {
  constructor(container, { width, onPick, priority = 0, preview = null }) {
    this.container = container;
    this.width = width;
    this.onPick = onPick;
    this.priority = priority;
    /** Откуда взять готовую картинку, пока рисуется своя. */
    this.preview = preview;
    this.items = [];
    this.observer = null;
    this.pdf = null;
    /** Страница → отмена начатой отрисовки. */
    this.jobs = new Map();
    /** Страница → готовая канва. */
    this.done = new Map();
  }

  clear() {
    this.observer?.disconnect();
    this.observer = null;
    for (const cancel of this.jobs.values()) cancel();
    this.jobs.clear();
    this.done.clear();
    this.container.replaceChildren();
    this.items = [];
    this.pdf = null;
  }

  /** Готовая миниатюра страницы — сетка берёт её как временную заглушку. */
  canvasFor(n) {
    return this.done.get(n) || null;
  }

  /**
   * Снимает незаконченные задачи, не теряя уже нарисованного: сетку закрыли,
   * и её миниатюры больше не нужны — очередь должна вернуться к полосе.
   */
  suspend() {
    for (const [n, cancel] of this.jobs) {
      cancel();
      const el = this.items[n - 1];
      if (el && !this.done.has(n)) this.observer?.observe(el);
    }
    this.jobs.clear();
  }

  build(pdf, count) {
    this.clear();
    this.pdf = pdf;
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= count; n++) {
      const btn = document.createElement('button');
      btn.className = 'thumb';
      btn.dataset.page = String(n);
      btn.type = 'button';
      const ph = document.createElement('div');
      ph.className = 'ph';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(n);
      btn.append(ph, num);
      btn.addEventListener('click', () => this.onPick(n));
      frag.appendChild(btn);
      this.items.push(btn);
    }
    this.container.appendChild(frag);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.observer.unobserve(e.target);
          this._render(e.target);
        }
      },
      { root: this.container, rootMargin: '400px' },
    );
    for (const el of this.items) this.observer.observe(el);
  }

  _render(el) {
    const n = Number(el.dataset.page);
    const pdf = this.pdf;
    if (this.jobs.has(n) || this.done.has(n)) return;

    // Пока рисуется своя, резкая, показываем растянутую из полосы: сетка
    // открывается сразу с картинками, а не с пустыми плитками.
    const ready = this.preview?.(n);
    if (ready) this._place(el, copyCanvas(ready));

    const cancel = thumbQueue.add(
      async (signal) => {
        try {
          // Пока задача ждала очереди, ленту могли пролистнуть далеко вперёд.
          if (!this._near(el)) {
            if (this.pdf === pdf) this.observer?.observe(el);
            return;
          }
          const canvas = await renderThumb(pdf, n, this.width, signal);
          if (!canvas || this.pdf !== pdf) return; // отменили или сменили вкладку
          this._place(el, canvas);
          this.done.set(n, canvas);
        } finally {
          if (this.jobs.get(n) === cancel) this.jobs.delete(n);
        }
      },
      { priority: this.priority },
    );

    this.jobs.set(n, cancel);
  }

  /** Ставит картинку на место заглушки или предыдущей, менее чёткой. */
  _place(el, canvas) {
    const old = el.querySelector(':scope > .ph, :scope > canvas');
    if (old) old.replaceWith(canvas);
    else el.prepend(canvas);
  }

  /** Миниатюра рядом с видимой областью — значит, её стоит рисовать. */
  _near(el) {
    const root = this.container.getBoundingClientRect();
    if (!root.width || !root.height) return false; // лента скрыта
    const r = el.getBoundingClientRect();
    return (
      r.bottom > root.top - NEAR_MARGIN &&
      r.top < root.bottom + NEAR_MARGIN &&
      r.right > root.left - NEAR_MARGIN &&
      r.left < root.right + NEAR_MARGIN
    );
  }

  setCurrent(n, { scroll = true, cls = 'current' } = {}) {
    for (const el of this.items) el.classList.toggle(cls, Number(el.dataset.page) === n);
    if (!scroll) return;
    this.items[n - 1]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  /** Слайд, на котором держится зал. null — стоп-кадра нет. */
  setFrozen(n) {
    for (const el of this.items) el.classList.toggle('frozen', Number(el.dataset.page) === n);
  }
}

const strip = new ThumbGrid(els.filmstrip, {
  width: 128,
  onPick: (n) => window.deck.cmd('goto', { page: n }),
});
const grid = new ThumbGrid(els.overviewGrid, {
  width: 380,
  // Сетка открыта поверх всего — она и есть то, на что смотрит лектор,
  // поэтому её миниатюры уходят в очередь раньше, чем миниатюры полосы.
  priority: 1,
  preview: (n) => strip.canvasFor(n),
  onPick: (n) => {
    window.deck.cmd('goto', { page: n });
    closeOverview();
  },
});

// ---------------------------------------------------------------------------
// Вкладки
// ---------------------------------------------------------------------------
function renderTabs(s) {
  const key = s.docs.map((d) => `${d.id}:${d.name}`).join('|') + '#' + s.activeId;
  if (key === lastTabsKey) return;
  lastTabsKey = key;

  const frag = document.createDocumentFragment();
  for (const d of s.docs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab' + (d.id === s.activeId ? ' active' : '');
    tab.title = d.path;
    tab.addEventListener('click', () => window.deck.cmd('tab:activate', { id: d.id }));

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = d.name;

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Закрыть вкладку';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.deck.cmd('tab:close', { id: d.id });
    });

    tab.append(name, close);
    frag.appendChild(tab);
  }
  els.tabs.replaceChildren(frag);
  els.tabs.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Настройки: выбор экрана для показа
// ---------------------------------------------------------------------------
function renderDisplays(s) {
  const key =
    s.displays.map((d) => `${d.id}:${d.width}x${d.height}:${d.primary}`).join('|') +
    `#${s.audienceDisplayId}#${s.presenterDisplayId}`;
  if (key === lastDisplaysKey) return;
  lastDisplaysKey = key;

  const frag = document.createDocumentFragment();
  for (const d of s.displays) {
    const isAudience = d.id === s.audienceDisplayId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'display-option' + (isAudience ? ' active' : '');
    btn.addEventListener('click', () => window.deck.cmd('display:setAudience', { id: d.id }));

    const dot = document.createElement('span');
    dot.className = 'display-dot';

    const text = document.createElement('span');
    text.className = 'display-text';
    const name = document.createElement('span');
    name.className = 'display-name';
    name.textContent = d.label + (d.primary ? ' · основной' : '');
    const meta = document.createElement('span');
    meta.className = 'display-meta';
    meta.textContent = `${d.width} × ${d.height}`;
    text.append(name, meta);

    btn.append(dot, text);

    const tag = isAudience ? 'показ' : d.id === s.presenterDisplayId ? 'лектор' : '';
    if (tag) {
      const badge = document.createElement('span');
      badge.className = 'display-tag';
      badge.textContent = tag;
      btn.appendChild(badge);
    }
    frag.appendChild(btn);
  }
  els.displayList.replaceChildren(frag);
}

function openSettings() {
  settingsOpen = true;
  els.settings.hidden = false;
}

function closeSettings() {
  settingsOpen = false;
  els.settings.hidden = true;
}

// ---------------------------------------------------------------------------
// Документ активной вкладки
// ---------------------------------------------------------------------------
function getPdf(id) {
  let promise = cache.get(id);
  if (!promise) {
    promise = (async () => {
      const payload = await window.deck.docBytes(id);
      if (!payload) throw new Error('нет данных документа');
      return loadDoc(payload.bytes);
    })();
    cache.set(id, promise);
  }
  return promise;
}

function useDoc(id, pdf) {
  activePdf = pdf;
  loadedId = id;
  lastRenderKey = '';
  currentView.setDoc(pdf);
  nextView.setDoc(pdf);
  strip.build(pdf, pdf.numPages);
  grid.clear();
  setSlideAspect(pdf);
  els.overviewTotal.textContent = String(pdf.numPages);
  closeOverview();
  // Сообщаем каждый раз: документ мог догрузиться уже после того, как активной
  // стала другая вкладка, и тогда main так и не узнал бы его число страниц.
  window.deck.cmd('doc:meta', { id, pageCount: pdf.numPages });
}

/**
 * Плитки сетки принимают форму страниц этого документа: у презентации 16/9
 * они заполнены целиком, у портретного PDF — вытянуты вверх, и в обоих случаях
 * слайд виден весь, без полей в пол-плитки.
 */
function setSlideAspect(pdf) {
  pdf
    .getPage(1)
    .then((page) => {
      const v = page.getViewport({ scale: 1 });
      document.documentElement.style.setProperty('--slide-aspect', `${v.width} / ${v.height}`);
      page.cleanup();
    })
    .catch(() => {
      document.documentElement.style.removeProperty('--slide-aspect');
    });
}

async function ensureActive(s) {
  const id = s.activeId;
  if (!id) {
    activePdf = null;
    loadedId = null;
    currentView.clear();
    nextView.clear();
    strip.clear();
    grid.clear();
    return;
  }
  if (loadedId === id || loadingId === id) return;

  loadingId = id;
  try {
    const pdf = await getPdf(id);
    if (state?.activeId !== id) return; // вкладку успели переключить
    useDoc(id, pdf);
    renderSlides(state);
  } catch (err) {
    // Файл не разобрался. Молча оставлять на экране прошлую презентацию нельзя:
    // main закроет вкладку и покажет ошибку.
    cache.delete(id);
    window.deck.cmd('doc:failed', { id, message: err?.message });
  } finally {
    if (loadingId === id) loadingId = null;
  }
}

/**
 * Освобождает документы закрытых вкладок. Без этого каждая открытая за доклад
 * презентация оставалась бы разобранной в памяти до выхода из программы —
 * и здесь, и в worker-е pdf.js.
 */
function pruneCache(st) {
  const alive = new Set(st.docs.map((d) => d.id));
  for (const [id, promise] of cache) {
    if (alive.has(id)) continue;
    cache.delete(id);
    promise.then((pdf) => pdf.destroy?.()).catch(() => {});
    if (loadedId === id) {
      activePdf = null;
      loadedId = null;
    }
  }
}


let notesSeq = 0;
async function showNotes(pdf, n) {
  const my = ++notesSeq;
  const text = await pageText(pdf, n);
  if (my !== notesSeq) return;
  els.notes.textContent = text || '—';
  els.notes.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
function renderChrome(s) {
  renderTabs(s);
  renderDisplays(s);
  els.empty.hidden = s.docs.length > 0;

  // Счётчик прячем целиком, пока считать нечего.
  const doc = s.docs.find((d) => d.id === s.activeId) || null;
  els.reopenLast.checked = Boolean(s.reopenLast);

  // Без открытого файла показывать нечего — кнопку гасим.
  els.showBtn.disabled = !doc;
  els.pages.hidden = !doc || !doc.pageCount;
  if (!els.pages.hidden) els.pages.textContent = `${doc.page} / ${doc.pageCount}`;

  els.blankFlag.hidden = s.blank === 'none';

  // Стоп-кадр: показываем, на чём остался зал. Если он застыл на другой
  // вкладке, без имени файла было бы непонятно, о каком слайде речь.
  const frozenDoc = s.freeze ? s.docs.find((d) => d.id === s.freeze.docId) : null;
  els.freezeFlag.hidden = !frozenDoc;
  if (frozenDoc) {
    els.freezeFlag.textContent =
      frozenDoc.id === s.activeId
        ? `Зал видит слайд ${s.freeze.page}`
        : `Зал видит ${frozenDoc.name}, слайд ${s.freeze.page}`;
  }
  strip.setFrozen(frozenDoc && frozenDoc.id === s.activeId ? s.freeze.page : null);

  // Чип отвечает на вопрос «куда пойдёт показ», а не «нашёлся ли второй экран»:
  // сам факт наличия внешнего экрана лектору ничего не говорит, а вот какой
  // именно из них выбран — говорит, и это видно не открывая настройки.
  const target = s.displays.find((d) => d.id === s.audienceDisplayId);
  els.chip.hidden = !target;
  if (target) {
    els.chipName.textContent = target.label;
    els.chipMeta.textContent = `${target.width} × ${target.height}`;
    els.chip.classList.toggle('live', s.audienceFullscreen);
    els.chip.title = s.audienceFullscreen
      ? `Идёт показ на «${target.label}»`
      : `Показ пойдёт на «${target.label}» — выбрать другой можно в настройках`;
  }
}

function renderSlides(s) {
  if (!s || !activePdf || loadedId !== s.activeId) return;
  const doc = s.docs.find((d) => d.id === s.activeId);
  if (!doc) return;

  const page = Math.min(Math.max(1, doc.page), activePdf.numPages);
  const key = `${s.activeId}:${page}`;
  if (key === lastRenderKey) return;
  lastRenderKey = key;

  currentView.show(page);
  if (page < activePdf.numPages) {
    nextView.show(page + 1);
    els.nextNum.textContent = `${page + 1} / ${activePdf.numPages}`;
  } else {
    nextView.clear();
    nextView.setDoc(activePdf);
    els.nextNum.textContent = 'последний слайд';
  }
  strip.setCurrent(page);
  if (overviewOpen) grid.setCurrent(page, { cls: 'current', scroll: false });
  showNotes(activePdf, page);
}

function applyState(s) {
  state = s;
  pruneCache(s);
  renderChrome(s);
  ensureActive(s);
  renderSlides(s);
}

// ---------------------------------------------------------------------------
// Сетка всех слайдов
// ---------------------------------------------------------------------------
function openOverview() {
  if (!activePdf) return;
  overviewOpen = true;
  const doc = state?.docs.find((d) => d.id === state.activeId);
  overviewSel = doc?.page || 1;
  els.overview.hidden = false;
  if (!grid.items.length) grid.build(activePdf, activePdf.numPages);
  grid.setCurrent(overviewSel, { cls: 'selected' });
}

function closeOverview() {
  overviewOpen = false;
  els.overview.hidden = true;
  // Сетки не видно — её недорисованные миниатюры уступают очередь полосе.
  grid.suspend();
}

function moveOverviewSel(delta) {
  if (!activePdf) return;
  overviewSel = Math.min(activePdf.numPages, Math.max(1, overviewSel + delta));
  grid.setCurrent(overviewSel, { cls: 'selected' });
}

/** Сколько миниатюр помещается в строке — чтобы ↑/↓ шли по строкам. */
function overviewColumns() {
  const first = grid.items[0];
  if (!first) return 1;
  return Math.max(1, Math.round(els.overviewGrid.clientWidth / (first.getBoundingClientRect().width + 14)));
}

// ---------------------------------------------------------------------------
// Ввод
// ---------------------------------------------------------------------------
bindKeys((key, e) => {
  if (key === 'g' || key === 'G' || key === 'п' || key === 'П' || e.code === 'KeyG') {
    overviewOpen ? closeOverview() : openOverview();
    return true;
  }
  if (key === 'Escape') {
    // Esc снимает сначала настройки и сетку, потом чёрный экран; если снимать
    // нечего — отдаём клавишу общему обработчику, который завершает показ.
    if (settingsOpen) {
      closeSettings();
      return true;
    }
    if (overviewOpen) {
      closeOverview();
      return true;
    }
    if (state?.blank !== 'none') {
      window.deck.cmd('blank', { mode: state.blank });
      return true;
    }
    return false;
  }
  if (!overviewOpen) return false;

  // Внутри сетки стрелки двигают выделение, а не слайд у зрителей.
  if (key === 'ArrowRight') return moveOverviewSel(1), true;
  if (key === 'ArrowLeft') return moveOverviewSel(-1), true;
  if (key === 'ArrowDown') return moveOverviewSel(overviewColumns()), true;
  if (key === 'ArrowUp') return moveOverviewSel(-overviewColumns()), true;
  if (key === 'Home') return moveOverviewSel(-1e9), true;
  if (key === 'End') return moveOverviewSel(1e9), true;
  if (key === 'Enter' || key === ' ') {
    window.deck.cmd('goto', { page: overviewSel });
    closeOverview();
    return true;
  }
  return false;
});

bindDropOpen();

$('btn-open').addEventListener('click', () => window.deck.cmd('open'));
$('btn-fullscreen').addEventListener('click', () => window.deck.cmd('audience:toggleFullscreen'));
$('btn-overview').addEventListener('click', () => (overviewOpen ? closeOverview() : openOverview()));
$('btn-settings').addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
$('settings-close').addEventListener('click', closeSettings);
els.reopenLast.addEventListener('change', (e) =>
  window.deck.cmd('settings:set', { reopenLast: e.target.checked }));
els.settings.addEventListener('click', (e) => {
  // Клик мимо карточки закрывает окно.
  if (e.target === els.settings) closeSettings();
});

window.deck.onState(applyState);
window.deck.getState().then(applyState);
