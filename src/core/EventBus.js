/**
 * Minimal synchronous pub/sub. Every subsystem talks through this so that
 * combat, fx, audio and ui stay decoupled -- an agent can rewrite one side
 * without touching the other.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    let list = this._handlers.get(type);
    if (!list) this._handlers.set(type, (list = []));
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const list = this._handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._handlers.get(type);
    if (!list) return;
    // iterate a copy so handlers may unsubscribe during dispatch
    for (const fn of list.slice()) fn(payload);
  }

  clear() {
    this._handlers.clear();
  }
}
