'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampPage, nextTabId, tabAfterClose, chooseLayout } = require('../src/main/lib/deck');

test('clampPage держит номер в границах документа', () => {
  assert.equal(clampPage(9, 5), 5);
  assert.equal(clampPage(9, 0), 1, 'меньше первой — первая');
  assert.equal(clampPage(9, 42), 9, 'больше последней — последняя');
  assert.equal(clampPage(9, -3), 1);
});

test('clampPage переживает пустой документ и мусор на входе', () => {
  assert.equal(clampPage(0, 5), 1, 'число страниц ещё не известно');
  assert.equal(clampPage(9, NaN), 1);
  assert.equal(clampPage(9, undefined), 1);
  assert.equal(clampPage(9, '4'), 4, 'номер приходит из набора цифр строкой');
  assert.equal(clampPage(9, 4.7), 4, 'дробный номер обрезается, а не округляется вверх');
});

const docs = [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }];

test('nextTabId ходит по кругу в обе стороны', () => {
  assert.equal(nextTabId(docs, 'd1', 1), 'd2');
  assert.equal(nextTabId(docs, 'd3', 1), 'd1', 'с последней — на первую');
  assert.equal(nextTabId(docs, 'd1', -1), 'd3', 'с первой — на последнюю');
});

test('nextTabId ничего не делает, когда переключать не на что', () => {
  assert.equal(nextTabId([], null, 1), null);
  assert.equal(nextTabId([{ id: 'd1' }], 'd1', 1), null, 'одна вкладка');
  assert.equal(nextTabId(docs, 'нет такой', 1), 'd1', 'активная потерялась — берём первую');
});

test('tabAfterClose выбирает соседа справа, потом слева', () => {
  assert.equal(tabAfterClose(docs, 'd2', 'd2'), 'd3');
  assert.equal(tabAfterClose(docs, 'd3', 'd3'), 'd2', 'закрыли последнюю — уходим влево');
});

test('tabAfterClose не трогает активную вкладку, если закрыли другую', () => {
  assert.equal(tabAfterClose(docs, 'd1', 'd3'), 'd3');
  assert.equal(tabAfterClose(docs, 'нет такой', 'd3'), 'd3');
});

test('tabAfterClose возвращает null, когда закрыли единственную', () => {
  assert.equal(tabAfterClose([{ id: 'd1' }], 'd1', 'd1'), null);
});

test('chooseLayout отдаёт зрителям внешний экран', () => {
  assert.deepEqual(chooseLayout([1, 2], 1), { presenterDisplayId: 1, audienceDisplayId: 2 });
  assert.deepEqual(
    chooseLayout([1, 2, 3], 2),
    { presenterDisplayId: 2, audienceDisplayId: 1 },
    'основной не обязан быть первым в списке',
  );
});

test('chooseLayout при одном экране оставляет оба окна на нём', () => {
  assert.deepEqual(chooseLayout([1], 1), { presenterDisplayId: 1, audienceDisplayId: 1 });
});

test('chooseLayout переживает нулевой id экрана', () => {
  // id === 0 ложен, и наивная проверка external ? ... отправила бы показ
  // обратно на экран лектора.
  assert.deepEqual(chooseLayout([7, 0], 7), { presenterDisplayId: 7, audienceDisplayId: 0 });
});
