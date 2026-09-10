// Очередь отрисовки миниатюр.
//
// Раньше каждая миниатюра уходила в pdf.js сразу, как попадала в поле зрения:
// два десятка задач начинались одновременно, воркер делил время между всеми, и
// лента стояла пустой до тех пор, пока не заканчивалась последняя. Суммарной
// работы столько же, но видит её пользователь совсем иначе. Так же устроен и
// штатный просмотрщик pdf.js: у него единая очередь, и страницы появляются по
// одной, начиная с той, что перед глазами.
//
// Очередь одна на все ленты, поэтому сетка обзора и полоса внизу не отбирают
// время друг у друга, а идут по приоритету: то, что пользователь видит сейчас,
// рисуется первым.

export class RenderQueue {
  /** @param {number} limit сколько задач выполняется одновременно */
  constructor(limit = 1) {
    this.limit = limit;
    this.pending = [];
    this.active = new Set();
    this.seq = 0;
    /** До какого момента не начинать новые задачи, см. pause(). */
    this.until = 0;
  }

  /**
   * Ставит задачу в очередь.
   * @param {(signal: AbortSignal) => Promise<void>} job
   * @param {{priority?: number}} [opts] больший приоритет уходит в работу раньше
   * @returns {() => void} отмена: снимает задачу из очереди или прерывает начатую
   */
  add(job, { priority = 0 } = {}) {
    const item = { job, priority, seq: this.seq++, ctrl: new AbortController() };
    this.pending.push(item);
    this._pump();
    return () => {
      item.ctrl.abort();
      const i = this.pending.indexOf(item);
      if (i !== -1) this.pending.splice(i, 1);
    };
  }

  /**
   * Придерживает очередь: новые задачи не стартуют, пока не пройдёт срок.
   * Нужно на смене слайда — зал должен получить страницу первым, а миниатюры
   * подождут пару десятых секунды, этого никто не заметит.
   */
  pause(ms) {
    this.until = Math.max(this.until || 0, Date.now() + ms);
    setTimeout(() => this._pump(), ms + 5);
  }

  /** Снимает всё, что не начато, и прерывает то, что уже идёт. */
  cancelAll() {
    for (const item of this.pending) item.ctrl.abort();
    this.pending.length = 0;
    for (const item of this.active) item.ctrl.abort();
  }

  _pump() {
    if (this.until && Date.now() < this.until) return;
    while (this.active.size < this.limit && this.pending.length) {
      const item = this.pending.splice(this._next(), 1)[0];
      if (item.ctrl.signal.aborted) continue;
      this.active.add(item);
      Promise.resolve()
        .then(() => item.job(item.ctrl.signal))
        .catch(() => {
          // Отменённая или сломанная страница не должна ронять очередь:
          // остальные миниатюры обязаны дорисоваться.
        })
        .then(() => {
          this.active.delete(item);
          this._pump();
        });
    }
  }

  /** Индекс следующей задачи: сначала приоритет, при равном — кто раньше встал. */
  _next() {
    let best = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const a = this.pending[i];
      const b = this.pending[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return best;
  }
}
