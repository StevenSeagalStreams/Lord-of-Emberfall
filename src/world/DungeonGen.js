import { RNG } from '../core/RNG.js';

/** All [x,y] cells in an w*h rectangle anchored at (x0,y0). */
function rectCells(x0, y0, w, h) {
  const out = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
  return out;
}

export const CELL = {
  ROCK: 0,   // solid, never rendered as interior
  FLOOR: 1,
  WALL: 2,   // solid cell adjacent to at least one floor cell
  DOOR: 3,
};

/**
 * Grid dungeon generator: room placement + corridor carving + wall derivation.
 *
 * Deliberately not a pure BSP. BSP fills the rectangle it is given, which makes
 * every level read as one big block. Diablo's catacombs feel like something
 * *dug*, so we scatter rooms with rejection sampling, leave rock between them,
 * and connect with dog-legged corridors that occasionally wander.
 */
export class DungeonGen {
  constructor(opts = {}) {
    this.width = opts.width ?? 96;
    this.height = opts.height ?? 96;
    this.rng = opts.rng instanceof RNG ? opts.rng : new RNG(opts.seed ?? 1337);

    this.roomAttempts = opts.roomAttempts ?? 220;
    this.minRoom = opts.minRoom ?? 6;
    this.maxRoom = opts.maxRoom ?? 15;
    this.roomPadding = opts.roomPadding ?? 2;
    this.extraLoopChance = opts.extraLoopChance ?? 0.18;
    this.corridorWander = opts.corridorWander ?? 0.30;
  }

  generate() {
    const { width: W, height: H, rng } = this;
    const grid = new Uint8Array(W * H); // CELL.ROCK everywhere
    const at = (x, y) => y * W + x;

    /** @type {{x:number,y:number,w:number,h:number,cx:number,cy:number,id:number,kind:string}[]} */
    const rooms = [];

    for (let attempt = 0; attempt < this.roomAttempts; attempt++) {
      // Bias toward non-square rooms; long halls read better in an iso view.
      let w = rng.int(this.minRoom, this.maxRoom);
      let h = rng.int(this.minRoom, this.maxRoom);
      if (rng.bool(0.35)) {
        if (rng.bool()) w = Math.min(this.maxRoom + 6, Math.round(w * 1.7));
        else h = Math.min(this.maxRoom + 6, Math.round(h * 1.7));
      }

      const x = rng.int(2, W - w - 3);
      const y = rng.int(2, H - h - 3);

      const pad = this.roomPadding;
      let overlaps = false;
      for (const r of rooms) {
        if (
          x - pad < r.x + r.w && x + w + pad > r.x &&
          y - pad < r.y + r.h && y + h + pad > r.y
        ) { overlaps = true; break; }
      }
      if (overlaps) continue;

      rooms.push({
        x, y, w, h,
        cx: Math.floor(x + w / 2),
        cy: Math.floor(y + h / 2),
        id: rooms.length,
        kind: 'room',
      });
    }

    if (rooms.length === 0) throw new Error('DungeonGen: produced no rooms');

    for (const r of rooms) {
      for (let yy = r.y; yy < r.y + r.h; yy++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) grid[at(xx, yy)] = CELL.FLOOR;
      }
    }

    // --- connectivity -------------------------------------------------------
    // Minimum spanning tree over room centres (guarantees the level is
    // completable), then a few extra edges so the map has loops instead of
    // being a strict tree that forces backtracking.
    const connected = [rooms[0]];
    const pending = rooms.slice(1);
    const corridors = [];

    while (pending.length) {
      let best = null;
      for (const a of connected) {
        for (let i = 0; i < pending.length; i++) {
          const b = pending[i];
          const d = (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2;
          if (!best || d < best.d) best = { a, b, i, d };
        }
      }
      this._carveCorridor(grid, best.a, best.b);
      corridors.push([best.a.id, best.b.id]);
      connected.push(best.b);
      pending.splice(best.i, 1);
    }

    for (const a of rooms) {
      if (!rng.bool(this.extraLoopChance)) continue;
      const b = rng.pick(rooms);
      if (b === a) continue;
      this._carveCorridor(grid, a, b);
      corridors.push([a.id, b.id]);
    }

    // --- wall derivation ----------------------------------------------------
    // Any solid cell touching a floor cell (8-neighbourhood) becomes a wall.
    // The 8-neighbourhood matters: 4 leaves diagonal pinholes you can see
    // straight through at this camera angle.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (grid[at(x, y)] !== CELL.ROCK) continue;
        let touching = false;
        for (let dy = -1; dy <= 1 && !touching; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (grid[at(nx, ny)] === CELL.FLOOR) { touching = true; break; }
          }
        }
        if (touching) grid[at(x, y)] = CELL.WALL;
      }
    }

    // --- room roles ---------------------------------------------------------
    const sorted = rooms.slice().sort((a, b) => b.w * b.h - a.w * a.h);
    sorted[0].kind = 'hall';
    let far = rooms[0], farD = -1;
    for (const r of rooms) {
      const d = (r.cx - sorted[0].cx) ** 2 + (r.cy - sorted[0].cy) ** 2;
      if (d > farD) { farD = d; far = r; }
    }
    far.kind = 'boss';

    // Entrance is the room furthest from the boss.
    let entrance = rooms[0], entD = -1;
    for (const r of rooms) {
      const d = (r.cx - far.cx) ** 2 + (r.cy - far.cy) ** 2;
      if (d > entD) { entD = d; entrance = r; }
    }
    entrance.kind = 'entrance';

    for (const r of rooms) {
      if (r.kind !== 'room') continue;
      if (rng.bool(0.14)) r.kind = 'treasure';
      else if (rng.bool(0.12)) r.kind = 'shrine';
    }

    // --- per-cell room ownership ---------------------------------------
    // -1 means "corridor" (carved floor that belongs to no room rectangle).
    // Consumers (wall tiering, prop density, room-identity dressing) key off
    // this rather than re-deriving it from room rectangles every time.
    const roomIndexGrid = new Int16Array(W * H).fill(-1);
    for (const r of rooms) {
      for (let yy = r.y; yy < r.y + r.h; yy++) {
        for (let xx = r.x; xx < r.x + r.w; xx++) roomIndexGrid[at(xx, yy)] = r.id;
      }
    }
    const roomAt = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      const i = roomIndexGrid[at(x, y)];
      return i >= 0 ? rooms[i] : null;
    };

    // --- doorways --------------------------------------------------------
    // Cells just outside a room's rectangle that are carved floor: this is
    // where a corridor pierces the wall shell. Used to hang archways so a
    // room reads as *entered* rather than just adjoined.
    const rawDoorways = [];
    for (const r of rooms) {
      const edges = [
        { cells: rectCells(r.x, r.y - 1, r.w, 1), dx: 0, dy: -1, axis: 'h' },
        { cells: rectCells(r.x, r.y + r.h, r.w, 1), dx: 0, dy: 1, axis: 'h' },
        { cells: rectCells(r.x - 1, r.y, 1, r.h), dx: -1, dy: 0, axis: 'v' },
        { cells: rectCells(r.x + r.w, r.y, 1, r.h), dx: 1, dy: 0, axis: 'v' },
      ];
      for (const e of edges) {
        for (const [x, y] of e.cells) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (grid[at(x, y)] === CELL.FLOOR) {
            rawDoorways.push({ x, y, dx: e.dx, dy: e.dy, axis: e.axis, roomId: r.id });
          }
        }
      }
    }
    // Greedy declutter: a wide corridor mouth produces several adjacent
    // qualifying cells; keep one per ~2.5-cell cluster so arches don't stack.
    const doorways = [];
    for (const d of rawDoorways) {
      if (doorways.some((k) => Math.hypot(k.x - d.x, k.y - d.y) < 2.5)) continue;
      doorways.push(d);
    }

    // --- main route (entrance -> boss) -----------------------------------
    // Cheap 4-directional BFS over the floor graph. Used purely for cosmetic
    // wear (polished/worn tint, drainage channels along the spine) -- not
    // authoritative pathing, that is NavGrid's job.
    const mainRoute = new Set();
    {
      const prev = new Int32Array(W * H).fill(-2);
      const sIdx = at(entrance.cx, entrance.cy), gIdx = at(far.cx, far.cy);
      const q = [sIdx];
      prev[sIdx] = -1;
      let qi = 0;
      while (qi < q.length) {
        const cur = q[qi++];
        if (cur === gIdx) break;
        const cx = cur % W, cy = (cur - cx) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = at(nx, ny);
          if (grid[ni] !== CELL.FLOOR || prev[ni] !== -2) continue;
          prev[ni] = cur;
          q.push(ni);
        }
      }
      if (prev[gIdx] !== -2) {
        let cur = gIdx;
        while (cur !== -1) { mainRoute.add(cur); cur = prev[cur]; }
      }
      // Dilate by one ring so the worn strip has some width instead of
      // reading as a single-pixel scratch down the corridor centreline.
      for (const idx of [...mainRoute]) {
        const x = idx % W, y = (idx - x) / W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (grid[at(nx, ny)] === CELL.FLOOR) mainRoute.add(at(nx, ny));
        }
      }
    }

    return {
      width: W,
      height: H,
      grid,
      rooms,
      corridors,
      entrance,
      boss: far,
      seed: this.rng.seed,
      at,
      roomIndexGrid,
      roomAt,
      doorways,
      mainRoute,
      isFloor: (x, y) =>
        x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === CELL.FLOOR,
      isSolid: (x, y) =>
        x < 0 || y < 0 || x >= W || y >= H || grid[y * W + x] !== CELL.FLOOR,
    };
  }

  _carveCorridor(grid, a, b) {
    const W = this.width, H = this.height, rng = this.rng;
    const at = (x, y) => y * W + x;

    let x = a.cx, y = a.cy;
    const tx = b.cx, ty = b.cy;

    // Corridors are 2 cells wide (or 3 occasionally). One-cell corridors read
    // as cracks at a 34 degree camera -- you cannot see the character in them.
    const halfWidth = rng.bool(0.22) ? 1 : 0;
    const paint = (px, py) => {
      for (let dy = -halfWidth; dy <= halfWidth + 1; dy++) {
        for (let dx = -halfWidth; dx <= halfWidth + 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx > 0 && ny > 0 && nx < W - 1 && ny < H - 1) grid[at(nx, ny)] = CELL.FLOOR;
        }
      }
    };

    let horizontalFirst = rng.bool();
    let guard = 0;
    while ((x !== tx || y !== ty) && guard++ < 4000) {
      paint(x, y);
      // Occasional axis flip mid-run gives staircase corridors rather than
      // the tell-tale single L of every roguelike tutorial.
      if (rng.bool(this.corridorWander * 0.1)) horizontalFirst = !horizontalFirst;

      if (horizontalFirst) {
        if (x !== tx) x += Math.sign(tx - x);
        else if (y !== ty) y += Math.sign(ty - y);
      } else {
        if (y !== ty) y += Math.sign(ty - y);
        else if (x !== tx) x += Math.sign(tx - x);
      }
    }
    paint(tx, ty);
  }
}
