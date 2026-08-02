/**
 * Deterministic seeded RNG (mulberry32) plus derived helpers.
 * Everything procedural -- dungeons, loot, textures -- pulls from a seeded
 * stream so a given seed reproduces an identical world. This is what makes
 * visual regression screenshots comparable between critic iterations.
 */
export class RNG {
  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this._s = this.seed;
  }

  /** Fork an independent stream, labelled so unrelated systems never desync. */
  fork(label = '') {
    let h = this._s >>> 0;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    }
    return new RNG(h ^ (this.int32() >>> 0));
  }

  reset() {
    this._s = this.seed;
  }

  int32() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** [0,1) */
  next() {
    return this.int32() / 4294967296;
  }

  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** inclusive integer range */
  int(min, max) {
    return Math.floor(this.range(min, max + 1 - Number.EPSILON));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }

  /** Pick by weight: entries are [value, weight] or objects with .weight */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += Array.isArray(e) ? e[1] : e.weight;
    let r = this.next() * total;
    for (const e of entries) {
      r -= Array.isArray(e) ? e[1] : e.weight;
      if (r <= 0) return Array.isArray(e) ? e[0] : e;
    }
    const last = entries[entries.length - 1];
    return Array.isArray(last) ? last[0] : last;
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Box-Muller normal deviate. */
  gaussian(mean = 0, stdev = 1) {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + stdev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Random point in unit disc -- used constantly for particle emission. */
  disc() {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next());
    return [Math.cos(a) * r, Math.sin(a) * r];
  }
}

/** Shared global stream for cosmetic, non-reproducible jitter. */
export const rng = new RNG(0x5eed1234);
