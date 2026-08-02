import * as THREE from 'three';

/**
 * Minimal verlet cloth for capes, tabards, and robe hems.
 *
 * The grid is simulated in the *local space of the bone it hangs from* (the
 * caller re-anchors the pinned row every frame via `setPinTransform`). Forces
 * (gravity, drag from movement, ambient draft) must therefore also be supplied
 * already rotated into that same local frame -- see Animation.js, which does
 * that rotation once per character per frame using the anchor bone's current
 * world quaternion.
 *
 * This is deliberately not a general physics engine: fixed timestep, a
 * handful of Jakobsen relaxation iterations, structural + shear + one bend
 * constraint per vertex. That is enough to sell "cloth" at ARPG camera
 * distance and costs a few dozen vector ops per character per frame.
 *
 * --- Playtest G2 postmortem: why this read as "a flat board" ------------
 * Diagnosed against the actual sim rather than just retuning numbers. Five
 * things were true at once, and all five needed fixing -- any one alone
 * would still have looked rigid:
 *  1. **Every column of the top row was pinned** (`pinned: r === 0`, no
 *     narrowing). That holds the *entire* top edge dead straight across the
 *     full shoulder width, like a curtain rod -- physically nothing below it
 *     can ever look like draped fabric, no matter how loose the rest of the
 *     sim is, because the one edge a viewer's eye anchors on never moves.
 *     Real cloaks clasp at one or two points near the throat and the rest of
 *     the top edge sags between/around them. Fixed via `spec.pinCols`.
 *  2. **Bend/shear constraints were full-stiffness**, same as the structural
 *     ones. A Jakobsen solver with an unweighted bend constraint resists
 *     *any* local curvature almost as hard as it resists stretching, which
 *     is exactly "acts like a board by construction." Bend is now a soft
 *     constraint; shear is slightly soft too.
 *  3. **Drag could outweigh gravity.** At the run speeds this actually gets
 *     driven at, the old `dragScale`/lift added up to roughly the same order
 *     of magnitude as the 9.8 gravity constant -- so the sheet spent as much
 *     time being blown backward-and-up as it did hanging down, which reads
 *     precisely as "spread out flat behind him" instead of "hanging". Drag
 *     is now deliberately a minority force (see Animation.js).
 *  4. **No body collision.** With nothing to drape against, a gust could
 *     carry the whole sheet away from the back with nothing pulling it back
 *     in. There is no real collider here (still not a physics engine): the
 *     first attempt at this was a spring pulling every free point *toward*
 *     its authored (flat, unsimulated) rest X/Z every frame -- which quietly
 *     recreated the exact "flat board" defect this pass exists to fix, by
 *     holding the sheet's horizontal footprint locked to its flat design
 *     shape regardless of how correctly it hung in Y. Replaced with
 *     `spreadLimit`: a one-sided safety rail that only clamps a point back
 *     once it has drifted past a generous multiple of its own authored
 *     half-width, so it never fights the natural gather/fold gravity and the
 *     soft bend constraint already produce below the clasp -- it just stops
 *     the sheet flying off sideways under sustained drag. `flare` widens the
 *     rail so a sprint or hard turn can still visibly swing the cloth out.
 *  5. **Too few segments for the flat parts of the story**, notably the
 *     skeleton's rag scraps at 3 columns -- a 3-wide strip cannot curve at
 *     all, only pivot as a rigid fan. Bumped in Models.js alongside this.
 */
export class VerletCloth {
  /**
   * @param {object} spec
   * @param {number} spec.cols   particles across
   * @param {number} spec.rows   particles down
   * @param {number} spec.width  rest width
   * @param {number} spec.length rest length (hang distance)
   * @param {number} spec.curve  lateral bow, 0 = flat panel
   * @param {number} spec.forwardBias initial Z of the free end (front/back)
   * @param {number} [spec.hemWidth] width at the free (bottom) edge, if
   *   different from `width` at the pinned edge -- a real cloak/cape flares
   *   toward the hem rather than hanging as a rectangle, and that flare is
   *   most of what reads as "cloth mass" rather than "cardboard cutout"
   *   from the top-down-ish gameplay camera.
   * @param {number} [spec.pinCols] how many columns of the top row are real
   *   anchor points, centred on the row (default: every column, i.e. the old
   *   full-width pin -- still fine for a tiny scrap). Pass 1-2 for anything
   *   meant to read as a real hanging cloak: two clasps at the throat, the
   *   fabric between and beyond them free to sag and fold.
   * @param {number} [spec.spreadLimit] how many multiples of a point's own
   *   authored half-width it may drift from the centreline before being
   *   clamped back -- a one-sided safety rail (never an attractive spring),
   *   the cheap stand-in for "drapes against the body" noted above. Widened
   *   at runtime by `flare` in `update()`. Default 1.6 (generous -- a
   *   naturally-hanging, gathering cloak should rarely if ever touch it).
   */
  constructor(spec = {}) {
    const cols = this.cols = Math.max(2, spec.cols ?? 5);
    const rows = this.rows = Math.max(2, spec.rows ?? 6);
    const width = spec.width ?? 0.5;
    const hemWidth = spec.hemWidth ?? width;
    const length = spec.length ?? 0.6;
    const curve = spec.curve ?? 0;
    const fwd = spec.forwardBias ?? 0;
    const maxForwardZ = spec.maxForwardZ ?? 0.18;
    this.maxForwardZ = maxForwardZ;
    this.spreadLimit = spec.spreadLimit ?? 1.6;

    // Clasp columns: centred span of `pinCols` columns in the top row.
    // Everything outside that span (including the rest of row 0) is a free
    // point like any other -- see postmortem item 1 above.
    const pinCols = Math.max(1, Math.min(cols, Math.round(spec.pinCols ?? cols)));
    const pinStart = Math.floor((cols - pinCols) / 2);
    const isPinCol = (c) => c >= pinStart && c < pinStart + pinCols;

    this.points = [];
    for (let r = 0; r < rows; r++) {
      const rt = rows > 1 ? r / (rows - 1) : 0;
      const rowWidth = width + (hemWidth - width) * rt;
      for (let c = 0; c < cols; c++) {
        const u = cols > 1 ? c / (cols - 1) : 0.5;
        const x = (u - 0.5) * rowWidth;
        const y = -r * (length / (rows - 1));
        const z = Math.sin(u * Math.PI) * curve + rt * fwd;
        const p = new THREE.Vector3(x, y, z);
        this.points.push({ pos: p.clone(), prev: p.clone(), pinned: r === 0 && isPinCol(c) });
      }
    }
    // Rest shape, captured once, used only as the reference half-width the
    // `spreadLimit` rail measures against (postmortem item 4) -- never
    // mutated after this.
    this._home = this.points.map((p) => p.pos.clone());

    this.constraints = [];
    const idx = (r, c) => r * cols + c;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1) this._addC(idx(r, c), idx(r, c + 1), 1);
        if (r < rows - 1) this._addC(idx(r, c), idx(r + 1, c), 1);
        if (r < rows - 1 && c < cols - 1) this._addC(idx(r, c), idx(r + 1, c + 1), 0.65);
        if (r < rows - 1 && c > 0) this._addC(idx(r, c), idx(r + 1, c - 1), 0.65);
        // Bend constraint: deliberately the softest of the three (postmortem
        // item 2) -- it exists to stop the sheet folding through itself, not
        // to resist every fold, which is what made it read as a board.
        if (r < rows - 2) this._addC(idx(r, c), idx(r + 2, c), 0.3);
      }
    }

    const n = this.points.length;
    const idxArr = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = idx(r, c), b = idx(r, c + 1), cc = idx(r + 1, c), d = idx(r + 1, c + 1);
        idxArr.push(a, cc, b, b, cc, d);
      }
    }
    const uv = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        uv[idx(r, c) * 2] = cols > 1 ? c / (cols - 1) : 0;
        uv[idx(r, c) * 2 + 1] = rows > 1 ? r / (rows - 1) : 0;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setIndex(idxArr);
    this._writePositions();
    this.geometry.computeVertexNormals();
  }

  _addC(a, b, stiffness = 1) {
    const d = this.points[a].pos.distanceTo(this.points[b].pos);
    this.constraints.push([a, b, d, stiffness]);
  }

  /** fn(index, THREE.Vector3 out) -- called for each pinned point, once per update. */
  setPinTransform(fn) { this._pinFn = fn; }

  _writePositions() {
    const arr = this.geometry.attributes.position.array;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i].pos;
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  /**
   * @param {object} forces
   * @param {number} [forces.flare] 0 (standing still) .. 1 (sprinting / mid
   *   hard turn) -- see Animation.js. Widens `spreadLimit` so the cloak can
   *   actually swing out during motion instead of snapping straight back,
   *   and brightens the ambient breeze the same way, which is what gives
   *   "flares when moving fast or turning hard, settles when still".
   */
  update(dt, { gravity, drag, damping = 0.98, iterations = 3, flare = 0, spreadLimit } = {}) {
    const g = gravity || _zero;
    const d = drag || _zero;
    const dt2 = Math.min(dt, 1 / 30);
    const ax = (g.x + d.x) * dt2 * dt2;
    const ay = (g.y + d.y) * dt2 * dt2;
    const az = (g.z + d.z) * dt2 * dt2;

    if (this._pinFn) {
      for (let i = 0; i < this.points.length; i++) {
        if (this.points[i].pinned) this._pinFn(i, this.points[i].pos);
      }
    }

    for (const pt of this.points) {
      if (pt.pinned) continue;
      const vx = (pt.pos.x - pt.prev.x) * damping;
      const vy = (pt.pos.y - pt.prev.y) * damping;
      const vz = (pt.pos.z - pt.prev.z) * damping;
      const nx = pt.pos.x + vx + ax;
      const ny = pt.pos.y + vy + ay;
      const nz = pt.pos.z + vz + az;
      pt.prev.copy(pt.pos);
      pt.pos.set(nx, ny, nz);
    }

    for (let it = 0; it < iterations; it++) {
      for (const [a, b, rest, stiffness] of this.constraints) {
        const pa = this.points[a], pb = this.points[b];
        if (pa.pinned && pb.pinned) continue;
        const dx = pb.pos.x - pa.pos.x, dy = pb.pos.y - pa.pos.y, dz = pb.pos.z - pa.pos.z;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = ((dist - rest) / dist) * (stiffness ?? 1);
        const wa = pa.pinned ? 0 : (pb.pinned ? 1 : 0.5);
        const wb = pb.pinned ? 0 : (pa.pinned ? 1 : 0.5);
        pa.pos.x += dx * diff * wa; pa.pos.y += dy * diff * wa; pa.pos.z += dz * diff * wa;
        pb.pos.x -= dx * diff * wb; pb.pos.y -= dy * diff * wb; pb.pos.z -= dz * diff * wb;
      }
    }

    // "Body collision" stand-in (postmortem item 4) -- a one-sided rail, NOT
    // a spring: only clamps a point's lateral (X) position back once it has
    // drifted past `spreadLimit` multiples of its own authored half-width.
    // A naturally hanging/gathering cloak stays well inside this on its own;
    // this only exists to stop sustained drag carrying the sheet arbitrarily
    // far sideways with nothing to stop it. `flare` widens the rail so a
    // sprint or hard pivot still visibly swings the cloth out.
    const spread = (spreadLimit ?? this.spreadLimit) + THREE.MathUtils.clamp(flare, 0, 1) * 0.9;
    for (let i = 0; i < this.points.length; i++) {
      const pt = this.points[i];
      if (pt.pinned) continue;
      const limX = Math.abs(this._home[i].x) * spread + 0.03;
      if (pt.pos.x > limX) pt.pos.x = limX;
      else if (pt.pos.x < -limX) pt.pos.x = -limX;
    }

    // Keep the cloth from swinging through the body it hangs against.
    for (const pt of this.points) {
      if (pt.pinned) continue;
      if (pt.pos.z > this.maxForwardZ) pt.pos.z = this.maxForwardZ;
    }

    this._writePositions();
    this.geometry.computeVertexNormals();
  }

  dispose() { this.geometry.dispose(); }
}

const _zero = new THREE.Vector3();
