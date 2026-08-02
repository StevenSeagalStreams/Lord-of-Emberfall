import * as THREE from 'three';
import { rng } from '../core/RNG.js';
import { sampleEmissionShape } from './GPUParticles.js';

/**
 * Skill cast/travel/impact chains, driven entirely by `fx:request` kinds.
 *
 * `src/skills/*` is still a stub, so nothing calls these yet -- but the
 * contract has to exist before that pillar can be built without importing
 * this one. Each element (fire, frost, lightning) gets three beats: `_cast`
 * at the caster, `_travel` fired repeatedly as the projectile advances (a
 * skill loop calling this once every frame or two along the path), and
 * `_impact` at the hit point, which also leaves an aftermath decal so a
 * fight's scorch/frost marks accumulate on the floor the way blood does.
 *
 * Kinds handled: fireball_cast, fireball_travel, fireball_impact,
 * frost_cast, frost_travel, frost_impact, lightning_cast, lightning_arc,
 * lightning_impact.
 */

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _outPos = new THREE.Vector3();
const _outDir = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _off = new THREE.Vector3();
const _decalPos = new THREE.Vector3();

function toVec3(p, out) { return out.set(p.x, p.y, p.z); }
function toDir(d, out, fallback) {
  if (!d) return out.copy(fallback);
  const len = Math.hypot(d.x, d.y || 0, d.z);
  return len > 1e-5 ? out.set(d.x, d.y || 0, d.z).multiplyScalar(1 / len) : out.copy(fallback);
}

const FIRE_TINT = { r: 3.4, g: 1.3, b: 0.2 };
const FROST_TINT = { r: 0.4, g: 1.4, b: 3.2 };
const LIGHT_TINT = { r: 1.6, g: 1.9, b: 3.6 };

function burst(glow, t, pos, tint, count, speed, life, size) {
  for (let i = 0; i < count; i++) {
    sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    _off.copy(pos).addScaledVector(_outPos, 0.1);
    _vel.copy(_outDir).multiplyScalar(speed.min + rng.next() * (speed.max - speed.min));
    glow.spawn(t, {
      position: _off, velocity: _vel,
      life: life.min + rng.next() * (life.max - life.min),
      sizeStart: size, sizeEnd: size * 0.15,
      drag: 1.6, tint, seed: rng.next(),
    });
  }
}

export function fireballCast(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.glow, t, _pos, FIRE_TINT, Math.round(8 + scale * 6), { min: 0.6, max: 2.2 }, { min: 0.18, max: 0.3 }, 0.22 * scale);
  pools.flash.trigger(payload.position, { color: 0xff7a2c, intensity: 26 * scale, distance: 4, life: 0.14 });
}

export function fireballTravel(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.glow, t, _pos, FIRE_TINT, 2 + Math.round(scale * 2), { min: 0.1, max: 0.6 }, { min: 0.1, max: 0.18 }, 0.16 * scale);
}

export function fireballImpact(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = THREE.MathUtils.clamp(payload.scale ?? 1, 0.6, 2.4);
  burst(pools.glow, t, _pos, FIRE_TINT, Math.round(16 + scale * 12), { min: 1.2, max: 4.5 }, { min: 0.22, max: 0.42 }, 0.3 * scale);
  const n = Math.round(10 + scale * 8);
  for (let i = 0; i < n; i++) {
    sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    _vel.copy(_outDir).multiplyScalar((3 + rng.next() * 4) * scale);
    pools.spark.spawn(t, {
      position: _pos, velocity: _vel,
      life: 0.2 + rng.next() * 0.25, sizeStart: 0.05, sizeEnd: 0.0,
      gravity: 8, drag: 1.8, tint: { r: 3, g: 1.4, b: 0.3 }, seed: rng.next(),
    });
  }
  pools.flash.trigger(payload.position, { color: 0xff5a1a, intensity: 60 * scale, distance: 6 + scale * 2, life: 0.28 });
  pools.decals.spawn(_decalPos.set(payload.position.x, 0.02, payload.position.z), 1,
    { radius: 0.5 + scale * 0.6, rotation: rng.next() * Math.PI * 2, time: t, life: 30, seed: rng.next() });
}

export function frostCast(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.glow, t, _pos, FROST_TINT, Math.round(6 + scale * 5), { min: 0.4, max: 1.6 }, { min: 0.2, max: 0.32 }, 0.2 * scale);
}

export function frostTravel(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.glow, t, _pos, FROST_TINT, 2 + Math.round(scale * 2), { min: 0.05, max: 0.4 }, { min: 0.15, max: 0.25 }, 0.15 * scale);
}

export function frostImpact(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = THREE.MathUtils.clamp(payload.scale ?? 1, 0.6, 2.4);
  burst(pools.glow, t, _pos, FROST_TINT, Math.round(14 + scale * 10), { min: 0.8, max: 3.2 }, { min: 0.3, max: 0.55 }, 0.26 * scale);
  const n = Math.round(8 + scale * 6);
  for (let i = 0; i < n; i++) {
    sampleEmissionShape('sphere', { radius: 1 }, rng, _outPos, _outDir);
    _vel.copy(_outDir).multiplyScalar((2 + rng.next() * 3) * scale);
    pools.spark.spawn(t, {
      position: _pos, velocity: _vel,
      life: 0.3 + rng.next() * 0.3, sizeStart: 0.05, sizeEnd: 0.0,
      gravity: 5, drag: 1.2, tint: { r: 1.2, g: 1.8, b: 2.6 }, seed: rng.next(),
    });
  }
  pools.flash.trigger(payload.position, { color: 0x8fd0ff, intensity: 40 * scale, distance: 5 + scale, life: 0.22 });
  pools.decals.spawn(_decalPos.set(payload.position.x, 0.02, payload.position.z), 2,
    { radius: 0.45 + scale * 0.55, rotation: rng.next() * Math.PI * 2, time: t, life: 22, seed: rng.next() });
}

export function lightningCast(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.spark, t, _pos, LIGHT_TINT, Math.round(10 + scale * 8), { min: 1.0, max: 3.2 }, { min: 0.08, max: 0.16 }, 0.05);
  pools.flash.trigger(payload.position, { color: 0x9fd8ff, intensity: 22 * scale, distance: 3.5, life: 0.08 });
}

/** A jagged line of sparks from `position` along `direction`, length scaled by `scale`. */
export function lightningArc(pools, payload, t) {
  toVec3(payload.position, _pos);
  toDir(payload.direction, _dir, _fwd);
  const scale = payload.scale ?? 1;
  const length = 3 + scale * 5;
  const segments = 10 + Math.round(scale * 6);
  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    const jitter = (1 - Math.abs(u - 0.5) * 2) * 0.35;
    const perpX = -_dir.z, perpZ = _dir.x;
    const off = (rng.next() * 2 - 1) * jitter;
    _off.set(
      _pos.x + _dir.x * length * u + perpX * off,
      _pos.y + (rng.next() * 2 - 1) * jitter * 0.4,
      _pos.z + _dir.z * length * u + perpZ * off
    );
    pools.spark.spawn(t, {
      position: _off,
      velocity: _zero,
      life: 0.1 + rng.next() * 0.08,
      sizeStart: 0.09,
      sizeEnd: 0.0,
      drag: 4,
      tint: { r: 1.4 + rng.next() * 0.6, g: 1.8 + rng.next() * 0.6, b: 3.8 },
      seed: rng.next(),
    });
  }
  if (segments > 0) {
    const endX = _pos.x + _dir.x * length, endZ = _pos.z + _dir.z * length;
    pools.flash.trigger({ x: endX, y: _pos.y, z: endZ }, { color: 0xbfe6ff, intensity: 30 * scale, distance: 4, life: 0.1 });
  }
}

export function lightningImpact(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = THREE.MathUtils.clamp(payload.scale ?? 1, 0.6, 2.2);
  burst(pools.spark, t, _pos, LIGHT_TINT, Math.round(14 + scale * 10), { min: 1.5, max: 4.5 }, { min: 0.1, max: 0.2 }, 0.06);
  pools.flash.trigger(payload.position, { color: 0xcfe9ff, intensity: 55 * scale, distance: 6, life: 0.16 });
}

const _fwd = new THREE.Vector3(0, 0, 1);
const _zero = new THREE.Vector3(0, 0.4, 0);

export const SKILL_HANDLERS = {
  fireball_cast: fireballCast,
  fireball_travel: fireballTravel,
  fireball_impact: fireballImpact,
  frost_cast: frostCast,
  frost_travel: frostTravel,
  frost_impact: frostImpact,
  lightning_cast: lightningCast,
  lightning_arc: lightningArc,
  lightning_impact: lightningImpact,
};
