import * as THREE from 'three';
import { rng } from '../core/RNG.js';
import { sampleEmissionShape } from './GPUParticles.js';

/**
 * Translates combat's `fx:request` payloads into particle bursts.
 *
 * Every function here is a pure "spawn a handful of particles" call against
 * pools owned and pumped by `index.js` -- nothing in this file allocates a
 * geometry, a material, or holds a reference across frames. `direction` may
 * be null (a scripted or omni-directional hit); every branch below has to
 * cope with that or a hit with no attacker-supplied vector would silently
 * draw nothing.
 */

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _off = new THREE.Vector3();
const _outPos = new THREE.Vector3();
const _outDir = new THREE.Vector3();
const _vel = new THREE.Vector3();

function toVec3(p, out) { return out.set(p.x, p.y, p.z); }

/** Directional flesh spray along the hit vector. */
export function bloodHit(pools, payload, t) {
  const { blood } = pools;
  toVec3(payload.position, _pos);
  const hasDir = !!payload.direction;
  if (hasDir) _dir.set(payload.direction.x, payload.direction.y || 0.15, payload.direction.z).normalize();
  const scale = payload.scale ?? 1;
  const n = Math.round(8 + scale * 10);
  for (let i = 0; i < n; i++) {
    if (hasDir) {
      sampleEmissionShape('cone', { axis: _dir, angle: Math.PI / 5.5 }, rng, _outPos, _outDir);
    } else {
      sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    }
    const speed = (2.2 + rng.next() * 3.4) * scale;
    _vel.copy(_outDir).multiplyScalar(speed);
    blood.spawn(t, {
      position: _pos,
      velocity: _vel,
      life: 0.35 + rng.next() * 0.35,
      sizeStart: 0.05 + rng.next() * 0.05 * scale,
      sizeEnd: 0.02,
      gravity: 9.0,
      drag: 1.4,
      seed: rng.next(),
    });
  }
}

/** Metal-on-armour sparks along the hit vector. */
export function sparkMetal(pools, payload, t) {
  const { spark } = pools;
  toVec3(payload.position, _pos);
  const hasDir = !!payload.direction;
  if (hasDir) _dir.set(payload.direction.x, payload.direction.y || 0.1, payload.direction.z).normalize();
  const scale = payload.scale ?? 1;
  const n = Math.round(10 + scale * 12);
  for (let i = 0; i < n; i++) {
    if (hasDir) {
      sampleEmissionShape('cone', { axis: _dir, angle: Math.PI / 4 }, rng, _outPos, _outDir);
    } else {
      sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    }
    const speed = (3.5 + rng.next() * 5.5) * scale;
    _vel.copy(_outDir).multiplyScalar(speed);
    const heat = 1.6 + rng.next() * 1.4;
    spark.spawn(t, {
      position: _pos,
      velocity: _vel,
      life: 0.18 + rng.next() * 0.22,
      sizeStart: 0.06 + rng.next() * 0.04,
      sizeEnd: 0.0,
      gravity: 14.0,
      drag: 2.4,
      tint: { r: heat, g: heat * 0.75, b: heat * 0.25 },
      seed: rng.next(),
    });
  }
}

/** Crit / heavy-hit point-light flash plus a tight sparkle core. */
export function impactFlash(pools, payload, t) {
  const { glow, flash } = pools;
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  flash.trigger(payload.position, {
    color: 0xfff2d8,
    intensity: 55 * scale,
    distance: 5 + scale * 2,
    life: 0.16 + scale * 0.05,
  });
  const n = Math.round(6 + scale * 6);
  for (let i = 0; i < n; i++) {
    sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    _off.copy(_pos).addScaledVector(_outPos, 0.08);
    _vel.copy(_outDir).multiplyScalar(1.2 + rng.next() * 1.8 * scale);
    glow.spawn(t, {
      position: _off,
      velocity: _vel,
      life: 0.12 + rng.next() * 0.1,
      sizeStart: 0.18 * scale,
      sizeEnd: 0.02,
      drag: 3.0,
      tint: { r: 3.2, g: 2.6, b: 1.8 },
      seed: rng.next(),
    });
  }
}

/** Arterial burst on death, plus a persistent ground decal. */
export function bloodKill(pools, payload, t) {
  const { blood, decals } = pools;
  toVec3(payload.position, _pos);
  const hasDir = !!payload.direction;
  if (hasDir) _dir.set(payload.direction.x, 0.1, payload.direction.z).normalize();
  const scale = THREE.MathUtils.clamp(payload.scale ?? 1, 0.5, 2.2);
  const n = Math.round(26 + scale * 20);
  for (let i = 0; i < n; i++) {
    if (hasDir && rng.next() < 0.7) {
      sampleEmissionShape('cone', { axis: _dir, angle: Math.PI / 3.2 }, rng, _outPos, _outDir);
    } else {
      sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    }
    const speed = (2.6 + rng.next() * 5.2) * scale;
    _vel.copy(_outDir).multiplyScalar(speed);
    blood.spawn(t, {
      position: _pos,
      velocity: _vel,
      life: 0.45 + rng.next() * 0.5,
      sizeStart: 0.06 + rng.next() * 0.07 * scale,
      sizeEnd: 0.02,
      gravity: 10.5,
      drag: 1.1,
      seed: rng.next(),
    });
  }

  const dx = hasDir ? payload.direction.x : 0;
  const dz = hasDir ? payload.direction.z : 0;
  decals.spawn(
    _decalPos.set(payload.position.x + dx * 0.4, 0.02, payload.position.z + dz * 0.4),
    0,
    { radius: 0.55 + scale * 0.55, rotation: rng.next() * Math.PI * 2, time: t, life: 40, seed: rng.next() }
  );
}

/** Footfall dust kicked up behind the direction of motion. */
export function dustStep(pools, payload, t) {
  const { dust } = pools;
  toVec3(payload.position, _pos);
  const hasDir = !!payload.direction;
  if (hasDir) _dir.set(-payload.direction.x, 0.4, -payload.direction.z).normalize();
  const scale = payload.scale ?? 1;
  const n = Math.round(3 + scale * 4);
  for (let i = 0; i < n; i++) {
    if (hasDir) {
      sampleEmissionShape('cone', { axis: _dir, angle: Math.PI / 3 }, rng, _outPos, _outDir);
    } else {
      sampleEmissionShape('disc', { radius: 0.3 }, rng, _outPos, _outDir);
      _outDir.set(0, 1, 0);
    }
    _off.copy(_pos).addScaledVector(_outPos, 0.15);
    const speed = (0.6 + rng.next() * 1.0) * scale;
    _vel.copy(_outDir).multiplyScalar(speed);
    dust.spawn(t, {
      position: _off,
      velocity: _vel,
      life: 0.5 + rng.next() * 0.5,
      sizeStart: 0.12 + rng.next() * 0.1 * scale,
      sizeEnd: 0.35 + rng.next() * 0.15 * scale,
      gravity: 1.4,
      drag: 1.8,
      seed: rng.next(),
    });
  }
}

const _decalPos = new THREE.Vector3();
