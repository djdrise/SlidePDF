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
    else if (isKey(e, 'o', 'KeyO')) window.deck.cmd('open');
    else if (k === 'F5') window.deck.cmd('audience:toggleFullscreen');
    else if (k === 'Escape') window.deck.cmd('audience:exitFullscreen');
    else return;

    e.preventDefault();
  });
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
