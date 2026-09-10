// Обёртка над pdf.js: загрузка документа, отрисовка слайда «по размеру» и миниатюр.

// legacy-сборка: в обычной pdf.js 5.7 использует Map.prototype.getOrInsertComputed,
// которого ещё нет в V8 у Electron 38. В legacy этот метод полифиллится.
import * as pdfjs from '../../../node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const BASE = new URL('../../../node_modules/pdfjs-dist/', import.meta.url);

pdfjs.GlobalWorkerOptions.workerSrc = new URL('legacy/build/pdf.worker.mjs', BASE).href;

const DOC_OPTS = {
  cMapUrl: new URL('cmaps/', BASE).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('standard_fonts/', BASE).href,
  wasmUrl: new URL('wasm/', BASE).href,
  iccUrl: new URL('iccs/', BASE).href,
  // Без этого pdf.js, даже читая документ по частям, всё равно дотягивает его
  // до конца в фоне. Нам это ни к чему: файл лежит на диске рядом, и читать
  // из него стоит только то, что показываем.
  disableAutoFetch: true,
};

/**
 * Чтение документа по кускам через главный процесс.
 *
 * Штатное чтение по ссылке тут не годится: pdf.js включает запрос диапазонов
 * только для http-адресов, а файл на диске под такой не подходит. Зато у
 * библиотеки есть ровно этот приём для встраивания — свой транспорт, который
 * сам решает, откуда брать байты.
 */
class IpcRange extends pdfjs.PDFDataRangeTransport {
  constructor(id, length) {
    // progressiveDone: сообщаем сразу, что потока «вдогонку» не будет, —
    // всё приходит только ответами на запросы кусков.
    super(length, new Uint8Array(0), true);
    this.id = id;
  }

  requestDataRange(begin, end) {
    window.deck
      .docRange(this.id, begin, end)
      .then((chunk) => {
        if (chunk) this.onDataRange(begin, chunk);
      })
      .catch(() => {});
  }
}

/**
 * Загружает документ: либо {id, length} для чтения кусками через главный
 * процесс, либо {data} с готовыми байтами.
 * @param {{id?: string, length?: number, data?: Uint8Array}} source
 */
export function loadDoc(source) {
  if (source.data) return pdfjs.getDocument({ data: source.data, ...DOC_OPTS }).promise;
  const range = new IpcRange(source.id, source.length);
  return pdfjs.getDocument({ range, ...DOC_OPTS }).promise;
}

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

// ---------------------------------------------------------------------------
// Горячие страницы
// ---------------------------------------------------------------------------
// page.cleanup() выбрасывает разобранную страницу, и следующий рендер той же
// страницы стоит столько же, сколько первый — замер показал ровно те же 17 мс.
// А одну и ту же страницу мы рисуем не раз: в полосу, в сетку, в крупный слайд.
// Поэтому несколько последних держим разобранными, а чистим только те, что уже
// никем не рисуются, — иначе cleanup обрывает чужую отрисовку на полуслове.

const HOT_PAGES = 12;
const pageCaches = new WeakMap();
let clock = 0;

/** Берёт страницу и помечает занятой. Освобождать обязательно через release. */
export async function acquirePage(doc, n) {
  let cache = pageCaches.get(doc);
  if (!cache) {
    cache = new Map();
    pageCaches.set(doc, cache);
  }
  let entry = cache.get(n);
  if (!entry) {
    entry = { promise: doc.getPage(n), refs: 0, used: 0 };
    cache.set(n, entry);
  }
  entry.refs += 1;
  entry.used = ++clock;
  try {
    return await entry.promise;
  } catch (err) {
    cache.delete(n);
    entry.refs -= 1;
    throw err;
  }
}

/** Отпускает страницу и вычищает самые давние из незанятых. */
export function releasePage(doc, n) {
  const cache = pageCaches.get(doc);
  const entry = cache?.get(n);
  if (!entry) return;
  entry.refs -= 1;
  if (cache.size <= HOT_PAGES) return;

  const idle = [...cache.entries()]
    .filter(([, e]) => e.refs <= 0)
    .sort((a, b) => a[1].used - b[1].used);
  for (const [num, e] of idle) {
    if (cache.size <= HOT_PAGES) break;
    cache.delete(num);
    e.promise.then((page) => page.cleanup()).catch(() => {});
  }
}

/**
 * Один слайд, вписанный в контейнер. Держит две канвы и меняет их местами,
 * чтобы при переходе не было вспышки пустого экрана.
 */
export class SlideView {
  constructor(container) {
    this.container = container;
    this.doc = null;
    this.pageNum = 0;
    this.task = null;
    this.seq = 0;
    /** @type {((n: number, canvas: HTMLCanvasElement, doc: unknown) => void)|null} */
    this.onRender = null;

    this.front = this._makeCanvas();
    this.back = this._makeCanvas();
    this.back.style.visibility = 'hidden';

    this._resizeTimer = null;
    this._lastSize = null;
    this._ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      const prev = this._lastSize;
      this._lastSize = { w: box.width, h: box.height };
      clearTimeout(this._resizeTimer);
      // Плавное перетаскивание рамки окна дребезжит — его гасим таймером.
      // Скачок размера (переход в полный экран) перерисовываем сразу, иначе
      // слайд остаётся мелким и «догоняет» новый размер уже на глазах у зала.
      const jumped =
        !prev ||
        Math.abs(box.width - prev.w) > prev.w * 0.2 ||
        Math.abs(box.height - prev.h) > prev.h * 0.2;
      if (jumped) this.redraw();
      else this._resizeTimer = setTimeout(() => this.redraw(), 120);
    });
    this._ro.observe(container);
  }

  _makeCanvas() {
    const c = document.createElement('canvas');
    c.className = 'slide-canvas';
    this.container.appendChild(c);
    return c;
  }

  setDoc(doc) {
    this.doc = doc;
    this.pageNum = 0;
    this._sizeHint = null;
  }

  clear() {
    this.doc = null;
    this.pageNum = 0;
    for (const c of [this.front, this.back]) {
      c.width = c.height = 0;
      c.style.width = c.style.height = '0px';
    }
  }

  redraw() {
    if (this.doc && this.pageNum) this.show(this.pageNum, { force: true });
  }

  /** Перерисовать немедленно и дождаться, пока не останется рендеров в полёте. */
  async redrawNow() {
    clearTimeout(this._resizeTimer);
    if (!this.doc || !this.pageNum) return;
    await this.show(this.pageNum, { force: true });
    // ResizeObserver мог перебить наш рендер своим — дожидаемся и его.
    for (let i = 0; i < 5 && this.task; i++) {
      const pending = this.task;
      try {
        await pending.promise;
      } catch {
        /* отменён более свежим рендером */
      }
      if (this.task === pending) break; // задача не сменилась — ждать больше нечего
    }
  }

  /** @param {number} n номер страницы, 1-based */
  async show(n, { force = false } = {}) {
    if (!this.doc) return;
    if (n === this.pageNum && !force) return;
    const my = ++this.seq;

    this.pageNum = n;
    if (this.task) {
      try {
        this.task.cancel();
      } catch {}
      this.task = null;
    }

    const doc = this.doc;
    const page = await acquirePage(doc, n);
    if (my !== this.seq) {
      releasePage(doc, n);
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(rect.width / base.width, rect.height / base.height);
    if (!(fit > 0)) return;

    const ratio = dpr();
    const viewport = page.getViewport({ scale: fit * ratio });
    const target = this.back;
    target.width = Math.max(1, Math.floor(viewport.width));
    target.height = Math.max(1, Math.floor(viewport.height));
    target.style.width = `${Math.floor(viewport.width / ratio)}px`;
    target.style.height = `${Math.floor(viewport.height / ratio)}px`;

    const ctx = target.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);

    const task = page.render({ canvas: target, canvasContext: ctx, viewport });
    this.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') {
        // Одна страница не отрисовалась — приложение остаётся рабочим, а вот
        // проброс наверх никто не ловит и он оседает unhandled rejection.
        console.error(`не удалось отрисовать страницу ${n}:`, err);
      }
      return;
    } finally {
      // Сбрасываем только свою задачу: более свежий рендер уже записал сюда
      // свою, и обнуление вслепую лишало бы его возможности быть отменённым
      // и обманывало бы redrawNow, будто рисовать больше нечего.
      if (this.task === task) this.task = null;
      releasePage(doc, n);
    }
    if (my !== this.seq) return;

    // Показываем свежую канву и прячем старую.
    target.style.visibility = 'visible';
    const old = this.front;
    this.front = target;
    this.back = old;
    old.style.visibility = 'hidden';

    // Страница уже отрисована — из неё можно сделать миниатюру уменьшением,
    // не гоняя pdf.js второй раз ради того же самого изображения.
    this.onRender?.(n, target, doc);
  }
}

/**
 * Отрисовка страницы в отдельную канву фиксированной ширины (для миниатюр).
 * Прерывается по signal: пролистнули ленту дальше — начатый рендер незачем
 * доводить до конца, он только задерживает те миниатюры, что уже перед глазами.
 * @returns {Promise<HTMLCanvasElement|null>} null, если работу отменили
 */
export async function renderThumb(doc, n, cssWidth, signal) {
  if (signal?.aborted) return null;
  const page = await acquirePage(doc, n);
  if (signal?.aborted) {
    releasePage(doc, n);
    return null;
  }
  const base = page.getViewport({ scale: 1 });
  const ratio = dpr();
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const task = page.render({ canvas, canvasContext: ctx, viewport });
  const stop = () => task.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await task.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return null;
    throw err;
  } finally {
    signal?.removeEventListener('abort', stop);
    releasePage(doc, n);
  }
  return canvas;
}

/** Текст страницы — используется как заметки лектора, если их нет отдельно. */
export async function pageText(doc, n) {
  try {
    const page = await acquirePage(doc, n);
    try {
      const content = await page.getTextContent();
      return content.items.map((i) => i.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
    } finally {
      releasePage(doc, n);
    }
  } catch {
    return '';
  }
}
