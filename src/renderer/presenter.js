import { loadDoc, SlideView, renderThumb, pageText } from './lib/pdfview.js';
import { bindKeys, bindDropOpen } from './lib/keys.js';

const $ = (id) => document.getElementById(id);

const els = {
  tabs: $('tabs'),
  pages: $('pages'),
  badge: $('display-badge'),
  blankFlag: $('blank-flag'),
  nextNum: $('next-num'),
  notes: $('notes'),
  filmstrip: $('filmstrip'),
  overview: $('overview'),
  overviewGrid: $('overview-grid'),
  overviewTotal: $('overview-total'),
  empty: $('empty'),
  settings: $('settings'),
  displayList: $('display-list'),
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
// Полоса миниатюр — порядок слайдов. Рендерится лениво, по мере прокрутки.
// ---------------------------------------------------------------------------
class ThumbGrid {
  constructor(container, { width, onPick }) {
    this.container = container;
    this.width = width;
    this.onPick = onPick;
    this.items = [];
    this.observer = null;
    this.pdf = null;
  }

  clear() {
    this.observer?.disconnect();
    this.observer = null;
    this.container.replaceChildren();
    this.items = [];
    this.pdf = null;
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

  async _render(el) {
    const n = Number(el.dataset.page);
    const pdf = this.pdf;
    try {
      const canvas = await renderThumb(pdf, n, this.width);
      if (this.pdf !== pdf) return; // вкладку успели переключить
      el.querySelector('.ph')?.replaceWith(canvas);
    } catch {
      /* страница могла не отрисоваться — оставляем заглушку */
    }
  }

  setCurrent(n, { scroll = true, cls = 'current' } = {}) {
    for (const el of this.items) el.classList.toggle(cls, Number(el.dataset.page) === n);
    if (!scroll) return;
    this.items[n - 1]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

const strip = new ThumbGrid(els.filmstrip, {
  width: 128,
  onPick: (n) => window.deck.cmd('goto', { page: n }),
});
const grid = new ThumbGrid(els.overviewGrid, {
  width: 380,
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
  els.overviewTotal.textContent = String(pdf.numPages);
  closeOverview();
  // Сообщаем каждый раз: документ мог догрузиться уже после того, как активной
  // стала другая вкладка, и тогда main так и не узнал бы его число страниц.
  window.deck.cmd('doc:meta', { id, pageCount: pdf.numPages });
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
  } catch {
    cache.delete(id);
  } finally {
    if (loadingId === id) loadingId = null;
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
  els.pages.hidden = !doc || !doc.pageCount;
  if (!els.pages.hidden) els.pages.textContent = `${doc.page} / ${doc.pageCount}`;

  els.blankFlag.hidden = s.blank === 'none';

  // На одном экране сообщать нечего — значок показываем только когда есть внешний.
  els.badge.hidden = s.displayCount < 2;
  if (!els.badge.hidden) {
    els.badge.textContent = s.audienceFullscreen ? 'Показ на внешнем экране' : 'Внешний экран найден';
    els.badge.classList.toggle('ok', s.audienceFullscreen);
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
els.settings.addEventListener('click', (e) => {
  // Клик мимо карточки закрывает окно.
  if (e.target === els.settings) closeSettings();
});

window.deck.onState(applyState);
window.deck.getState().then(applyState);
