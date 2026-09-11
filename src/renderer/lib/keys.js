// Единая раскладка клавиш для обоих окон: кликер шлёт PageUp/PageDown/стрелки
// в то окно, которое сейчас в фокусе, поэтому слушают оба.

const NEXT = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n']);
const PREV = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p']);

/** Клавиша нажата в любой раскладке: сравниваем и по букве, и по коду. */
const isKey = (e, letter, code) => e.key.toLowerCase() === letter || e.code === code;

/**
 * @param {(key: string, e: KeyboardEvent) => boolean} [onLocal]
 *   Вернуть true, если клавиша обработана локально и дальше идти не нужно.
 */
export function bindKeys(onLocal) {
  let digits = '';
  let digitsTimer = null;

  const resetDigits = () => {
    digits = '';
    clearTimeout(digitsTimer);
  };

  const flushDigits = () => {
    const typed = digits;
    resetDigits();
    if (typed) window.deck.cmd('goto', { page: Number(typed) });
  };

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;

    // Переключение вкладок — до отсечки по модификаторам, иначе Ctrl+Tab
    // отсеклась бы вместе с остальными сочетаниями. Голый Tab не трогаем:
    // он должен ходить по кнопкам, да и меню обещает именно Ctrl+Tab.
    if (e.key === 'Tab' && (e.ctrlKey || e.shiftKey)) {
      window.deck.cmd(e.shiftKey ? 'tab:prev' : 'tab:next');
      e.preventDefault();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key;
    if (onLocal && onLocal(k, e)) {
      // Клавишу забрал обработчик окна — набор номера слайда прерван, иначе
      // недобранные цифры сработают таймером уже после перехода.
      resetDigits();
      e.preventDefault();
      return;
    }

    // Набор номера слайда: 1 2 → Enter (или пауза 900 мс).
    if (/^[0-9]$/.test(k)) {
      digits += k;
      clearTimeout(digitsTimer);
      digitsTimer = setTimeout(flushDigits, 900);
      e.preventDefault();
      return;
    }
    if (k === 'Enter' && digits) {
      flushDigits();
      e.preventDefault();
      return;
    }
    if (k === 'Escape' && digits) {
      // Esc отменяет набор номера — и только его. Без return он проваливался
      // ниже и завершал показ прямо посреди доклада.
      resetDigits();
      e.preventDefault();
      return;
    }

    if (NEXT.has(k)) window.deck.cmd('next');
    else if (PREV.has(k)) window.deck.cmd('prev');
    else if (k === 'Home') window.deck.cmd('first');
    else if (k === 'End') window.deck.cmd('last');
    else if (isKey(e, 'b', 'KeyB')) window.deck.cmd('blank', { mode: 'black' });
    else if (isKey(e, 'f', 'KeyF')) window.deck.cmd('freeze:toggle');
    else if (isKey(e, 'o', 'KeyO')) window.deck.cmd('open');
    else if (k === 'F5') window.deck.cmd('audience:toggleFullscreen');
    else if (k === 'Escape') window.deck.cmd('audience:exitFullscreen');
    else return;

    e.preventDefault();
  });
}

/**
 * Листание колесом мыши.
 *
 * Порог нужен из-за трекпада: он сыплет десятками мелких событий там, где
 * мышь даёт один щелчок, и без накопления один жест пролистал бы полдоклада.
 * Пауза после перехода добивает ту же беду с другой стороны: у трекпада
 * события продолжают идти по инерции уже после того, как палец убрали.
 */
const WHEEL_STEP = 50;
const WHEEL_QUIET = 250;

/** Над чем колесо листает содержимое, а не слайды. */
const SCROLLABLE = '.filmstrip, .notes-body, .overview-grid, .modal, .display-list';

export function bindWheel() {
  let acc = 0;
  let quietUntil = 0;

  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return; // масштабирование, не листание
      if (e.target instanceof Element && e.target.closest(SCROLLABLE)) return;

      const now = Date.now();
      if (now < quietUntil) {
        acc = 0; // инерция после перехода — не листаем дальше
        return;
      }
      acc += e.deltaY;
      if (Math.abs(acc) < WHEEL_STEP) return;

      window.deck.cmd(acc > 0 ? 'next' : 'prev');
      acc = 0;
      quietUntil = now + WHEEL_QUIET;
    },
    { passive: true },
  );
}

/** Открытие PDF перетаскиванием в окно — сразу несколькими файлами. */
export function bindDropOpen() {
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const file of e.dataTransfer?.files || []) {
      const p = window.deck.pathForFile(file);
      if (p && p.toLowerCase().endsWith('.pdf')) window.deck.cmd('openPath', { path: p });
    }
  });
}
