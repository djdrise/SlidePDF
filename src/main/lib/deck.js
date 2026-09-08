'use strict';

// Чистая логика показа: номера страниц, порядок вкладок, выбор экранов.
// Вынесена из main.js, чтобы её можно было проверить тестами — остальной
// main завязан на окна и дисплеи Electron и проверяется только запуском.

/** Номер страницы в границах документа. Пустой документ — всегда первая. */
function clampPage(pageCount, n) {
  if (!pageCount) return 1;
  const num = Number(n);
  if (!Number.isFinite(num)) return 1;
  return Math.min(pageCount, Math.max(1, Math.trunc(num)));
}

/**
 * id вкладки через delta от активной, по кругу.
 * @returns {string|null} null, если переключать не на что
 */
function nextTabId(docs, activeId, delta) {
  if (!Array.isArray(docs) || docs.length < 2) return null;
  const i = docs.findIndex((d) => d.id === activeId);
  if (i === -1) return docs[0].id;
  const n = docs.length;
  return docs[(((i + delta) % n) + n) % n].id;
}

/**
 * Какая вкладка станет активной после закрытия. Закрыли не активную — активная
 * не меняется; закрыли последнюю — не остаётся ничего.
 * @returns {string|null}
 */
function tabAfterClose(docs, closedId, activeId) {
  const i = docs.findIndex((d) => d.id === closedId);
  if (i === -1) return activeId;
  if (closedId !== activeId) return activeId;
  const next = docs[i + 1] || docs[i - 1];
  return next ? next.id : null;
}

/**
 * Раскладка по умолчанию: зрителям внешний экран, лектору основной.
 * Экран один — оба окна на нём.
 */
function chooseLayout(displayIds, primaryId) {
  const external = displayIds.find((id) => id !== primaryId);
  return {
    presenterDisplayId: primaryId,
    audienceDisplayId: external === undefined ? primaryId : external,
  };
}

module.exports = { clampPage, nextTabId, tabAfterClose, chooseLayout };
