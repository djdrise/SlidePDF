import { loadDoc, SlideView } from './lib/pdfview.js';
import { bindKeys, bindDropOpen } from './lib/keys.js';

const stage = document.getElementById('stage');
const blank = document.getElementById('blank');
const hint = document.getElementById('hint');
const view = new SlideView(stage);

/** В кэше лежат промисы: повторный заход не начинает вторую загрузку файла. */
let cursorTimer = null;
const cache = new Map();
let activePdf = null;
let loadedId = null;
let loadingId = null;
let state = null;
let lastKey = '';

function getPdf(id) {
  let promise = cache.get(id);
  if (!promise) {
    promise = (async () => {
      const source = await window.deck.docSource(id);
      if (!source) throw new Error('нет данных документа');
      return loadDoc({ id: source.id, length: source.length });
    })();
    cache.set(id, promise);
  }
  return promise;
}

/**
 * Что должен показывать зал: замороженный слайд, если стоп-кадр включён,
 * иначе текущий. Стоп-кадр держит и вкладку, поэтому лектор может уйти
 * в другую презентацию, а зал этого не заметит.
 */
function shown(s) {
  if (s.freeze) {
    const frozen = s.docs.find((d) => d.id === s.freeze.docId);
    if (frozen) return { id: frozen.id, page: s.freeze.page };
  }
  const doc = s.docs.find((d) => d.id === s.activeId);
  return doc ? { id: doc.id, page: doc.page } : null;
}

async function ensureActive(s) {
  const id = shown(s)?.id ?? null;
  if (!id) {
    activePdf = null;
    loadedId = null;
    lastKey = '';
    view.clear();
    hint.hidden = false;
    return;
  }
  if (loadedId === id || loadingId === id) return;

  loadingId = id;
  try {
    const pdf = await getPdf(id);
    if (shown(state)?.id !== id) return; // показываемый документ успели сменить
    use(id, pdf);
  } catch (err) {
    // Об ошибке сообщает окно лектора; здесь просто не держим битый документ.
    cache.delete(id);
    if (loadedId === id) {
      activePdf = null;
      loadedId = null;
    }
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
      lastKey = '';
    }
  }
}


function use(id, pdf) {
  activePdf = pdf;
  loadedId = id;
  lastKey = '';
  view.setDoc(pdf);
  hint.hidden = true;
  renderSlide(state);
}

function renderSlide(s) {
  const target = shown(s);
  if (!s || !activePdf || !target || loadedId !== target.id) return;
  const page = Math.min(Math.max(1, target.page), activePdf.numPages);
  const key = `${target.id}:${page}`;
  if (key === lastKey) return;
  lastKey = key;
  view.show(page);
}

let wasShowing = false;

function applyState(s) {
  state = s;
  pruneCache(s);
  const showing = !!s.audienceFullscreen;
  document.body.classList.toggle('showing', showing);
  // На старте показа курсор прячем сразу: смена размера окна сама шлёт mousemove,
  // и без сброса курсор торчал бы на экране ещё две секунды.
  if (showing && !wasShowing) {
    clearTimeout(cursorTimer);
    document.body.classList.remove('cursor-visible');
  }
  wasShowing = showing;

  if (s.blank === 'none') {
    blank.hidden = true;
  } else {
    blank.hidden = false;
    blank.dataset.mode = s.blank;
  }

  ensureActive(s);
  renderSlide(s);
}

window.deck.onState(applyState);
window.deck.getState().then(applyState);

bindKeys();
bindDropOpen();

document.getElementById('bar-close').addEventListener('click', () => window.close());

/**
 * Вызывается из main перед тем, как показать окно: ждём, пока layout догонит
 * новый размер окна и слайд перерисуется под него. Пока промис не разрешён,
 * окно держится прозрачным — показ появляется сразу готовым, без «дотягивания».
 * @param {number} w ожидаемая ширина окна в CSS-пикселях
 * @param {number} h ожидаемая высота окна
 */
window.__slidePrepare = (w, h) =>
  new Promise((resolve) => {
    const deadline = performance.now() + 400;
    const waitLayout = () => {
      const fits = Math.abs(window.innerWidth - w) <= 2 && Math.abs(window.innerHeight - h) <= 2;
      if (!fits && performance.now() < deadline) {
        requestAnimationFrame(waitLayout);
        return;
      }
      view.redrawNow().then(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    requestAnimationFrame(waitLayout);
  });

// В показе курсор скрыт, но возвращается на пару секунд при движении мыши.
window.addEventListener('mousemove', () => {
  document.body.classList.add('cursor-visible');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('cursor-visible'), 2000);
});
