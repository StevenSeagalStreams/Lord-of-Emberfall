import { TILE } from './LevelBuilder.js';

/**
 * Grid navigation: A* with octile heuristic, corner-cutting prevention, and a
 * string-pulling smoothing pass.
 *
 * The smoothing pass is what separates an ARPG from a roguelike. Raw A* output
 * is a staircase of grid cells; walking it literally produces the jerky
 * zig-zag that makes cheap games feel cheap. We line-of-sight test waypoints
 * and drop any that the previous one can already see, which turns the
 * staircase into the diagonal a human would actually walk.
 */
export class NavGrid {
  constructor(colliders) {
    this.w = colliders.width;
    this.h = colliders.height;
    this.solid = colliders.solid;
    this.colliders = colliders;

    const n = this.w * this.h;
    this._g = new Float32Array(n);
    this._f = new Float32Array(n);
    this._came = new Int32Array(n);
    this._state = new Uint8Array(n); // 0 unvisited, 1 open, 2 closed
    this._stamp = new Uint32Array(n);
    this._epoch = 0;
  }

  idx(x, y) { return y * this.w + x; }

  walkable(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.solid[y * this.w + x] === 0;
  }

  /** Nearest walkable cell to a blocked target, so clicks on walls still move. */
  nearestWalkable(x, y, maxRadius = 12) {
    if (this.walkable(x, y)) return { x, y };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx, ny = y + dy;
          if (this.walkable(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /**
   * @returns {{x:number,y:number}[]|null} cell path including the goal, or null
   */
  findPath(sx, sy, gx, gy, maxNodes = 8000) {
    if (!this.walkable(gx, gy)) {
      const near = this.nearestWalkable(gx, gy);
      if (!near) return null;
      gx = near.x; gy = near.y;
    }
    if (!this.walkable(sx, sy)) {
      const near = this.nearestWalkable(sx, sy);
      if (!near) return null;
      sx = near.x; sy = near.y;
    }
    if (sx === gx && sy === gy) return [{ x: gx, y: gy }];

    const epoch = ++this._epoch;
    const { _g: g, _f: f, _came: came, _state: state, _stamp: stamp } = this;
    const start = this.idx(sx, sy);
    const goal = this.idx(gx, gy);

    const open = new BinaryHeap((i) => f[i]);
    g[start] = 0;
    f[start] = this._heuristic(sx, sy, gx, gy);
    came[start] = -1;
    state[start] = 1;
    stamp[start] = epoch;
    open.push(start);

    let expanded = 0;
    const D = 1, D2 = Math.SQRT2;

    while (open.size > 0) {
      const cur = open.pop();
      if (cur === goal) return this._reconstruct(came, goal);
      state[cur] = 2;
      if (++expanded > maxNodes) break;

      const cx = cur % this.w;
      const cy = (cur - cx) / this.w;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (!this.walkable(nx, ny)) continue;
          // No squeezing between two diagonal walls -- the body has width.
          if (dx !== 0 && dy !== 0) {
            if (!this.walkable(cx + dx, cy) || !this.walkable(cx, cy + dy)) continue;
          }
          const ni = this.idx(nx, ny);
          if (stamp[ni] === epoch && state[ni] === 2) continue;

          const step = dx !== 0 && dy !== 0 ? D2 : D;
          const tentative = g[cur] + step;

          if (stamp[ni] !== epoch) {
            stamp[ni] = epoch;
            state[ni] = 0;
            g[ni] = Infinity;
          }
          if (tentative < g[ni]) {
            came[ni] = cur;
            g[ni] = tentative;
            f[ni] = tentative + this._heuristic(nx, ny, gx, gy);
            if (state[ni] !== 1) {
              state[ni] = 1;
              open.push(ni);
            } else {
              open.rescore(ni);
            }
          }
        }
      }
    }
    return null;
  }

  _heuristic(x, y, gx, gy) {
    const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
    // Octile distance, nudged by a hair to break ties toward straighter paths.
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy) * 1.0 + (dx + dy) * 0.001;
  }

  _reconstruct(came, goal) {
    const path = [];
    let cur = goal;
    while (cur !== -1) {
      const x = cur % this.w;
      path.push({ x, y: (cur - x) / this.w });
      cur = came[cur];
    }
    return path.reverse();
  }

  /** Bresenham-ish supercover line-of-sight between cells. */
  lineOfSight(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let x = x0, y = y0;
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let guard = 0;
    while (guard++ < 4096) {
      if (!this.walkable(x, y)) return false;
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
      // A pure Bresenham step can slip through a diagonal gap; require both
      // orthogonal neighbours when the line moves diagonally.
      if (e2 > -dy && e2 < dx) {
        if (!this.walkable(x - sx, y) && !this.walkable(x, y - sy)) return false;
      }
    }
    return false;
  }

  /** Drop redundant waypoints, then convert to world-space positions. */
  smooth(path) {
    if (!path || path.length <= 2) return path || [];
    const out = [path[0]];
    let anchor = 0;
    for (let i = 2; i < path.length; i++) {
      if (!this.lineOfSight(path[anchor].x, path[anchor].y, path[i].x, path[i].y)) {
        out.push(path[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(path[path.length - 1]);
    return out;
  }

  toWorld(path) {
    return path.map((p) => ({ x: p.x * TILE, z: p.y * TILE }));
  }

  /** Convenience: world coords in, smoothed world waypoints out. */
  path(fromX, fromZ, toX, toZ) {
    const p = this.findPath(
      Math.round(fromX / TILE), Math.round(fromZ / TILE),
      Math.round(toX / TILE), Math.round(toZ / TILE)
    );
    if (!p) return null;
    return this.toWorld(this.smooth(p));
  }
}

/** Binary min-heap with a rescore path for A*'s decrease-key. */
class BinaryHeap {
  constructor(scoreFn) {
    this.content = [];
    this.score = scoreFn;
  }
  get size() { return this.content.length; }
  push(el) { this.content.push(el); this._up(this.content.length - 1); }
  pop() {
    const first = this.content[0];
    const last = this.content.pop();
    if (this.content.length > 0) { this.content[0] = last; this._down(0); }
    return first;
  }
  rescore(el) {
    const i = this.content.indexOf(el);
    if (i >= 0) this._up(i);
  }
  _up(n) {
    const el = this.content[n];
    const score = this.score(el);
    while (n > 0) {
      const parentN = ((n + 1) >> 1) - 1;
      const parent = this.content[parentN];
      if (score >= this.score(parent)) break;
      this.content[parentN] = el;
      this.content[n] = parent;
      n = parentN;
    }
  }
  _down(n) {
    const length = this.content.length;
    const el = this.content[n];
    const score = this.score(el);
    for (;;) {
      const c2 = (n + 1) << 1;
      const c1 = c2 - 1;
      let swap = -1;
      let best = score;
      if (c1 < length) {
        const s1 = this.score(this.content[c1]);
        if (s1 < best) { swap = c1; best = s1; }
      }
      if (c2 < length) {
        const s2 = this.score(this.content[c2]);
        if (s2 < best) { swap = c2; }
      }
      if (swap === -1) break;
      this.content[n] = this.content[swap];
      this.content[swap] = el;
      n = swap;
    }
  }
}
