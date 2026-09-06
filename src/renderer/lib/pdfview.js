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
};

/** @param {Uint8Array} bytes */
export function loadDoc(bytes) {
  return pdfjs.getDocument({ data: bytes, ...DOC_OPTS }).promise;
}

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

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
      try {
        await this.task.promise;
      } catch {
        /* отменён более свежим рендером */
      }
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

    const page = await this.doc.getPage(n);
    if (my !== this.seq) return;

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

    this.task = page.render({ canvas: target, canvasContext: ctx, viewport });
    try {
      await this.task.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') throw err;
      return;
    } finally {
      this.task = null;
      page.cleanup();
    }
    if (my !== this.seq) return;

    // Показываем свежую канву и прячем старую.
    target.style.visibility = 'visible';
    const old = this.front;
    this.front = target;
    this.back = old;
    old.style.visibility = 'hidden';
  }
}

/** Отрисовка страницы в отдельную канву фиксированной ширины (для миниатюр). */
export async function renderThumb(doc, n, cssWidth) {
  const page = await doc.getPage(n);
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
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

/** Текст страницы — используется как заметки лектора, если их нет отдельно. */
export async function pageText(doc, n) {
  try {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const out = content.items.map((i) => i.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
    page.cleanup();
    return out;
  } catch {
    return '';
  }
}
