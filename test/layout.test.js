'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planLayout, centeredBounds } = require('../src/main/lib/layout');

/** Обычная связка: два экрана, показ идёт на внешнем. */
const base = {
  displayIds: [1, 2],
  primaryId: 1,
  presenterDisplayId: 1,
  audienceDisplayId: 2,
  audiencePinned: false,
  showing: true,
  presenterFullscreen: false,
  presenterOn: 1,
  audienceOn: 2,
};
const plan = (over) => planLayout({ ...base, ...over });

test('идущий показ не трогаем, когда ничего не изменилось', () => {
  // Регрессия: скрытие строки меню меняет рабочую область и присылает
  // display-metrics-changed. Прежняя версия принимала это за перестройку и
  // выходила из показа через доли секунды после запуска.
  assert.equal(plan().audience, 'keep');
  assert.equal(plan().presenter, 'keep');
});

test('проектор выдернули посреди показа — выходим и откатываем раскладку', () => {
  const r = plan({ displayIds: [1], audienceOn: 2 });
  assert.equal(r.audience, 'exit');
  assert.equal(r.audienceDisplayId, 1, 'остаётся единственный экран');
  assert.equal(r.audiencePinned, false, 'ручной выбор снят вместе с экраном');
});

test('экран показа сменили во время показа — переносим, не прерывая', () => {
  const r = plan({ displayIds: [1, 2, 3], audienceDisplayId: 3, audienceOn: 2 });
  assert.equal(r.audience, 'enter');
  assert.equal(r.audienceDisplayId, 3);
});

test('без показа окно зрителей просто переставляется на свой экран', () => {
  assert.equal(plan({ showing: false, audienceOn: 1 }).audience, 'center');
  assert.equal(plan({ showing: false, audienceOn: 2 }).audience, 'keep', 'уже на месте');
});

test('подключили проектор — зрители уходят на него сами', () => {
  const r = plan({
    displayIds: [1, 2],
    presenterDisplayId: 1,
    audienceDisplayId: 1,
    showing: false,
    audienceOn: 1,
  });
  assert.equal(r.audienceDisplayId, 2);
  assert.equal(r.presenterDisplayId, 1);
});

test('ручной выбор экрана автоматика не переопределяет', () => {
  const r = plan({
    displayIds: [1, 2],
    presenterDisplayId: 1,
    audienceDisplayId: 1,
    audiencePinned: true,
    showing: false,
    audienceOn: 1,
  });
  assert.equal(r.audienceDisplayId, 1, 'лектор выбрал этот экран сам');
  assert.equal(r.audiencePinned, true);
});

test('окно лектора не двигаем, пока оно развёрнуто', () => {
  assert.equal(plan({ presenterOn: 2, presenterFullscreen: true }).presenter, 'keep');
  assert.equal(plan({ presenterOn: 2, presenterFullscreen: false }).presenter, 'center');
});

test('несуществующих окон план не касается', () => {
  const r = plan({ presenterOn: null, audienceOn: null, showing: false });
  assert.equal(r.presenter, 'keep');
  assert.equal(r.audience, 'keep');
});

test('centeredBounds центрирует прямоугольник в рабочей области', () => {
  assert.deepEqual(centeredBounds({ x: 0, y: 0, width: 1000, height: 800 }, 0.5), {
    x: 250,
    y: 200,
    width: 500,
    height: 400,
  });
});

test('centeredBounds учитывает смещение экрана', () => {
  // Второй монитор начинается не в нуле — окно должно уехать на него, а не
  // остаться на первом.
  assert.deepEqual(centeredBounds({ x: 1440, y: 25, width: 1000, height: 800 }, 1), {
    x: 1440,
    y: 25,
    width: 1000,
    height: 800,
  });
});
