/**
 * Central hit-stop.
 *
 * Frame-counted, not time-counted: each call to `tickFrame()` -- made exactly
 * once per real game frame, from `resolveOverlaps()` in Entity.js, which
 * main.js already calls exactly once per tick -- burns exactly one stored
 * frame off the freeze. There is no code path that adds frames without a
 * matching external decrement, and the counter is clamped on write, so it is
 * structurally impossible for this to freeze the sim forever: worst case is
 * MAX_FRAMES real frames, then it releases on its own.
 *
 * `Entity#update` reads `.scale` and multiplies its own dt by it, so physics
 * (velocity integration, position) and animation (the Animator update call,
 * which lives in the same function) freeze together, in one place, exactly
 * as the brief asks.
 */
const MAX_FRAMES = 10; // hard ceiling: never allow a runaway freeze request

export const HitStop = {
  frames: 0,
  factor: 1,

  /**
   * Request a freeze/slow. A stronger or longer request wins over whatever is
   * currently in flight; a weaker one never cuts an existing freeze short.
   * @param {number} frames  how many real frames to hold the slow-down for
   * @param {number} factor  dt multiplier during the freeze (0 = hard freeze)
   */
  trigger(frames = 3, factor = 0.08) {
    const f = Math.max(0, Math.min(MAX_FRAMES, Math.round(Number(frames) || 0)));
    const k = Math.min(1, Math.max(0, Number(factor)));
    if (f <= 0) return;
    if (f >= this.frames) {
      this.frames = f;
      this.factor = Number.isFinite(k) ? k : 1;
    } else {
      this.frames = Math.max(this.frames, f);
    }
  },

  /** Burn exactly one frame of any active freeze. Call once per real frame. */
  tickFrame() {
    if (this.frames > 0) {
      this.frames -= 1;
      if (this.frames <= 0) {
        this.frames = 0;
        this.factor = 1;
      }
    }
  },

  get active() {
    return this.frames > 0;
  },

  /** dt multiplier to apply to physics/animation this frame. */
  get scale() {
    return this.frames > 0 ? this.factor : 1;
  },

  reset() {
    this.frames = 0;
    this.factor = 1;
  },
};

export const HITSTOP_MAX_FRAMES = MAX_FRAMES;
