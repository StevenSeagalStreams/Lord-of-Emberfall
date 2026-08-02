import * as THREE from 'three';
import { GPUParticles } from './GPUParticles.js';
import { rng } from '../core/RNG.js';

/**
 * Ground-hugging fog wisps that pool in low ground near the player.
 *
 * This is deliberately zone-agnostic: rather than reading a heightfield API
 * this pillar does not own, it periodically raycasts straight down at a ring
 * of sample points around the player, keeps the lowest few, and seeds slow,
 * long-lived soft particles there. That works identically for the forest's
 * terrain mesh and the catacombs' floor without either zone having to
 * declare "here is a hollow" -- the geometry already says so.
 *
 * One GPUParticles pool (one draw call). Refresh is throttled hard: the
 * raycast pass runs every couple of seconds, not per frame, and touches a
 * small fixed sample count.
 */
export class GroundFog {
  constructor({ scene, capacity = 160 } = {}) {
    this._scene = scene;
    this.particles = new GPUParticles({
      capacity,
      shape: 'soft',
      blending: THREE.NormalBlending,
      renderOrder: 4,
      gradient: [
        [0.0, 0.55, 0.58, 0.62],
        [1.0, 0.62, 0.66, 0.70],
      ],
      alphaGradient: [
        [0.0, 0.0],
        [0.25, 0.16],
        [0.7, 0.13],
        [1.0, 0.0],
      ],
    });
    this.particles.points.raycast = () => {};

    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = 90;
    this._down = new THREE.Vector3(0, -1, 0);
    this._origin = new THREE.Vector3();
    this._refreshTimer = 0;
    this._t = 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} focus usually the player's position
   */
  update(dt, focus) {
    this._t += dt;
    this.particles.setTime(this._t);

    this._refreshTimer -= dt;
    if (this._refreshTimer <= 0 && focus) {
      this._refreshTimer = 2.2 + rng.next() * 1.2;
      this._seedClusters(focus);
    }

    this.particles.flush();
  }

  _seedClusters(focus) {
    const SAMPLES = 12;
    const hits = [];
    for (let i = 0; i < SAMPLES; i++) {
      const ang = (i / SAMPLES) * Math.PI * 2 + rng.next() * 0.5;
      const r = 4 + rng.next() * 18;
      const x = focus.x + Math.cos(ang) * r;
      const z = focus.z + Math.sin(ang) * r;
      this._origin.set(x, focus.y + 45, z);
      this._raycaster.set(this._origin, this._down);
      const hit = this._raycaster.intersectObjects(this._scene.children, true)[0];
      if (!hit) continue;
      // Reject anything absurdly far from the player's own altitude -- a
      // stray hit on a skybox or distant cliff face is not "low ground".
      if (Math.abs(hit.point.y - focus.y) > 14) continue;
      hits.push(hit.point);
    }
    if (!hits.length) return;
    hits.sort((a, b) => a.y - b.y);
    const clusters = hits.slice(0, Math.min(3, hits.length));
    for (const c of clusters) this._spawnCluster(c);
  }

  _spawnCluster(center) {
    const n = 4 + rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const [dx, dz] = rng.disc();
      const pos = _p.set(center.x + dx * 2.6, center.y + 0.12 + rng.next() * 0.5, center.z + dz * 2.6);
      const speed = 0.12 + rng.next() * 0.18;
      const a = rng.next() * Math.PI * 2;
      this.particles.spawn(this._t, {
        position: pos,
        velocity: _v.set(Math.cos(a) * speed, 0.015, Math.sin(a) * speed),
        life: 11 + rng.next() * 6,
        sizeStart: 2.4 + rng.next() * 1.6,
        sizeEnd: 3.6 + rng.next() * 2.0,
        drag: 0.15,
        seed: rng.next(),
      });
    }
  }

  get mesh() { return this.particles.points; }

  setViewport(h) { this.particles.setViewport(h); }

  dispose() { this.particles.dispose(); }
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
