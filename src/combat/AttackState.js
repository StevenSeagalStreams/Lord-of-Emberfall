/**
 * Attack timing state machine: front-half commit, back-half cancel window,
 * and single-slot input buffering.
 *
 * Duck-typed like AggroPack.js -- works on any actor shaped like
 * `{ alive, stunTimer, animator: { busy, play(name, duration, opts) } }`, so
 * it is directly unit-testable under plain node (no THREE/browser needed)
 * and reusable by anything that swings (Player today; Monster could adopt it
 * later without a rewrite).
 *
 * The whole point: a click during the front half (wind-up + strike, not yet
 * cancellable) must not be silently dropped just because `busy` was true the
 * instant it arrived. It queues in `this.buffered` and fires the moment the
 * swing becomes cancellable -- which for a *new* swing request means "cancel
 * the recovery tail immediately and start the next swing this same frame".
 * A click that arrives once the window is already open just fires directly,
 * no buffering needed.
 */
export class AttackState {
  /**
   * @param {number} impactAt  normalized [0,1] progress at which the damage
   *   event fires and the recovery becomes cancellable (the "back half").
   * @param {number} whooshAt  normalized progress for the whoosh/telegraph
   *   event (cosmetic only, does not affect gating).
   */
  constructor({ impactAt = 0.42, whooshAt = 0.28 } = {}) {
    this.impactAt = impactAt;
    this.whooshAt = whooshAt;
    /** True once the in-flight swing has passed its damage event. */
    this.cancellable = false;
    /** Queued { name, duration, onImpact, onStart, extraEvents } or null. */
    this.buffered = null;
  }

  /**
   * Is `actor` free to start (or cancel into) a new swing right now?
   *
   * The `cancellable` flag only ever describes a swing THIS state machine
   * started (see `_start`/`_fireEvent`) -- if the animator is busy playing
   * something else entirely (a skill's `cast` pose, say), that is a hard
   * lock regardless of whatever `cancellable` happened to be left at from
   * the last swing. Without this check, a skill cast (animation-locked, no
   * cancel window of its own) would leak a stale `cancellable=true` from an
   * earlier completed swing and let a melee attack interrupt the cast --
   * exactly the animation-lock violation the skill's own lock exists to
   * prevent.
   */
  canAct(actor) {
    if (!actor.alive || actor.stunTimer > 0) return false;
    const action = actor.animator?.action;
    if (action && action.name !== 'attackSwing') return false;
    if (action && !this.cancellable) return false;
    return true;
  }

  /**
   * Request a swing. Fires immediately if the actor is free; otherwise
   * buffers so it fires the instant the current swing's damage event lands
   * (see `_fireEvent`). Returns true if it fired THIS call, false if
   * buffered or refused outright (dead/stunned -- stunning clears any
   * pending buffer too, since a stagger should cancel a queued follow-up,
   * not politely wait it out).
   */
  request(actor, { name = 'attackSwing', duration, onImpact, onStart, extraEvents = [] } = {}) {
    if (!actor.alive || actor.stunTimer > 0) {
      this.buffered = null;
      return false;
    }
    const req = { name, duration, onImpact, onStart, extraEvents };
    if (!this.canAct(actor)) {
      this.buffered = req; // latest request wins -- overwrites any earlier queue
      return false;
    }
    this.buffered = null;
    this._start(actor, req);
    return true;
  }

  /** Drop anything queued -- called on death/stun so a buffer never fires late. */
  clearBuffer() {
    this.buffered = null;
  }

  /**
   * Call once per actor update tick (independent of whether anyone calls
   * `request()` again). `_fireEvent` already flushes the buffer the instant
   * a swing's own impact fires, but if the lock was held by something this
   * state machine did NOT start (e.g. a skill's `cast` pose, which has no
   * impact-event hook back into this class), nothing would otherwise ever
   * flush a request buffered during it. This is the fallback that guarantees
   * a buffered click is never silently stranded once the actor frees up.
   */
  tick(actor) {
    if (this.buffered && this.canAct(actor)) {
      const next = this.buffered;
      this.buffered = null;
      this._start(actor, next);
    }
  }

  _start(actor, req) {
    this.cancellable = false;
    req.onStart?.();
    actor.animator.play(req.name, req.duration, {
      events: [
        { at: this.whooshAt, name: 'whoosh' },
        { at: this.impactAt, name: 'impact' },
        ...req.extraEvents,
      ],
      onEvent: (evName, data) => this._fireEvent(actor, req, evName, data),
    });
  }

  _fireEvent(actor, req, evName, data) {
    // Forward this swing's own event first (e.g. deal its damage) --------
    req.onImpact?.(evName, data);
    if (evName !== 'impact') return;

    this.cancellable = true;
    // The instant the recovery opens, a buffered click cancels the tail and
    // starts the next swing THIS SAME FRAME -- that is the "fires
    // immediately on recovery" guarantee.
    if (this.buffered && actor.alive && actor.stunTimer <= 0) {
      const next = this.buffered;
      this.buffered = null;
      this._start(actor, next);
    }
  }
}
