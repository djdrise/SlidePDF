'use strict';

// Решение о раскладке окон по дисплеям, отделённое от самих окон.
//
// Вынесено сюда не ради красоты: именно в этом ветвлении показ однажды
// схлопывался сам. Скрытие строки меню меняет рабочую область, прилетает
// display-metrics-changed, и прежняя версия принимала это за «экран остался
// один» и выходила из показа через долю секунды после запуска. Чистая функция
// без Electron проверяется тестами, а не запуском с проектором.

const { chooseLayout } = require('./deck');

/**
 * @param {object} input
 * @param {number[]} input.displayIds      экраны, которые сейчас подключены
 * @param {number}   input.primaryId       основной экран системы
 * @param {number}   input.presenterDisplayId  назначенный экран лектора
 * @param {number}   input.audienceDisplayId   назначенный экран показа
 * @param {boolean}  input.audiencePinned  экран показа выбран вручную
 * @param {boolean}  input.showing         показ идёт прямо сейчас
 * @param {boolean}  input.presenterFullscreen окно лектора развёрнуто
 * @param {number|null} input.presenterOn  где окно лектора находится сейчас
 * @param {number|null} input.audienceOn   где окно зрителей находится сейчас
 * @returns {{presenterDisplayId: number, audienceDisplayId: number,
 *            audiencePinned: boolean,
 *            presenter: 'keep'|'center',
 *            audience: 'keep'|'center'|'enter'|'exit'}}
 */
function planLayout({
  displayIds,
  primaryId,
  presenterDisplayId,
  audienceDisplayId,
  audiencePinned,
  showing,
  presenterFullscreen,
  presenterOn,
  audienceOn,
}) {
  const connected = (id) => displayIds.includes(id);
  const audienceLost = !connected(audienceDisplayId);

  let pinned = audiencePinned;
  let presenterId = presenterDisplayId;
  let audienceId = audienceDisplayId;

  // Выбранного вручную экрана больше нет — ручной выбор снимается вместе с ним.
  if (audienceLost) pinned = false;
  if (audienceLost || !connected(presenterId)) {
    ({ presenterDisplayId: presenterId, audienceDisplayId: audienceId } = chooseLayout(displayIds, primaryId));
  }
  // Проектор подключили, когда оба окна сидели на одном экране. Ручной выбор
  // это не трогает.
  if (!pinned && presenterId === audienceId && displayIds.length > 1) {
    ({ presenterDisplayId: presenterId, audienceDisplayId: audienceId } = chooseLayout(displayIds, primaryId));
  }

  // Окно двигаем, только если оно оказалось не на своём экране: иначе каждая
  // смена разрешения сбрасывала бы размер, выставленный руками.
  const presenter =
    presenterOn !== null && presenterOn !== presenterId && !presenterFullscreen ? 'center' : 'keep';

  let audience;
  if (showing && audienceLost) {
    audience = 'exit'; // проектор выдернули посреди доклада
  } else if (showing) {
    // Идущий показ не прерываем — только переносим, если экран сменился.
    audience = audienceOn !== audienceId ? 'enter' : 'keep';
  } else {
    audience = audienceOn !== null && audienceOn !== audienceId ? 'center' : 'keep';
  }

  return {
    presenterDisplayId: presenterId,
    audienceDisplayId: audienceId,
    audiencePinned: pinned,
    presenter,
    audience,
  };
}

/** Прямоугольник указанной доли рабочей области, по центру экрана. */
function centeredBounds(workArea, scale) {
  const width = Math.round(workArea.width * scale);
  const height = Math.round(workArea.height * scale);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

module.exports = { planLayout, centeredBounds };
