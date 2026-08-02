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
   */
  constructor(spec = {}) {
    const cols = this.cols = Math.max(2, spec.cols ?? 5);
    const rows = this.rows = Math.max(2, spec.rows ?? 6);
    const width = spec.width ?? 0.5;
    const length = spec.length ?? 0.6;
    const curve = spec.curve ?? 0;
    const fwd = spec.forwardBias ?? 0;
    const maxForwardZ = spec.maxForwardZ ?? 0.18;
    this.maxForwardZ = maxForwardZ;

    this.points = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u = cols > 1 ? c / (cols - 1) : 0.5;
        const x = (u - 0.5) * width;
        const y = -r * (length / (rows - 1));
        const z = Math.sin(u * Math.PI) * curve + (r / (rows - 1)) * fwd;
        const p = new THREE.Vector3(x, y, z);
        this.points.push({ pos: p.clone(), prev: p.clone(), pinned: r === 0 });
      }
    }

    this.constraints = [];
    const idx = (r, c) => r * cols + c;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1) this._addC(idx(r, c), idx(r, c + 1));
        if (r < rows - 1) this._addC(idx(r, c), idx(r + 1, c));
        if (r < rows - 1 && c < cols - 1) this._addC(idx(r, c), idx(r + 1, c + 1));
        if (r < rows - 1 && c > 0) this._addC(idx(r, c), idx(r + 1, c - 1));
        if (r < rows - 2) this._addC(idx(r, c), idx(r + 2, c));
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

  _addC(a, b) {
    const d = this.points[a].pos.distanceTo(this.points[b].pos);
    this.constraints.push([a, b, d]);
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

  update(dt, { gravity, drag, damping = 0.98, iterations = 3 } = {}) {
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
      for (const [a, b, rest] of this.constraints) {
        const pa = this.points[a], pb = this.points[b];
        if (pa.pinned && pb.pinned) continue;
        const dx = pb.pos.x - pa.pos.x, dy = pb.pos.y - pa.pos.y, dz = pb.pos.z - pa.pos.z;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (dist - rest) / dist;
        const wa = pa.pinned ? 0 : (pb.pinned ? 1 : 0.5);
        const wb = pb.pinned ? 0 : (pa.pinned ? 1 : 0.5);
        pa.pos.x += dx * diff * wa; pa.pos.y += dy * diff * wa; pa.pos.z += dz * diff * wa;
        pb.pos.x -= dx * diff * wb; pb.pos.y -= dy * diff * wb; pb.pos.z -= dz * diff * wb;
      }
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
