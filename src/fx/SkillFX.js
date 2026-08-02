import * as THREE from 'three';
import { rng } from '../core/RNG.js';
import { sampleEmissionShape } from './GPUParticles.js';

/**
 * Skill cast/travel/impact chains, driven entirely by `fx:request` kinds.
 *
 * `src/skills/index.js` is the caller now (G3/G4 fix pass): each element
 * (fire, frost, lightning) gets three beats -- `_cast` at the caster,
 * `_travel`/`_arc` carrying both `position` (the effect's current point) and
 * `target` (its destination), and `_impact` at the hit point, which also
 * leaves an aftermath decal so a fight's scorch/frost marks accumulate on the
 * floor the way blood does.
 *
 * Firebolt is a real projectile: `skills/index.js` calls `fireball_travel`
 * once per frame while the bolt is in flight, at the bolt's current
 * interpolated position. Because the trail is just "whatever the last few
 * frames' worth of travel particles haven't finished decaying yet", calling
 * this every frame along the path IS the trail -- no separate trail system
 * needed.
 *
 * Lightning has no travel stage (it is instant) but must still terminate ON
 * the victim: `lightningArc` draws from `position` to `target` exactly,
 * rather than guessing a length down `direction`.
 *
 * Frost Nova has no travel or target -- it is a self-centred AoE -- so
 * instead it gets `frost_ring`, an expanding ring at the caster so the
 * player can read the radius and see who it caught.
 *
 * Kinds handled: fireball_cast, fireball_travel, fireball_impact,
 * frost_cast, frost_ring, frost_travel, frost_impact, lightning_cast,
 * lightning_arc, lightning_impact.
 */

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _end = new THREE.Vector3();
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

/** Called once per frame while a firebolt is in flight, at its current
 *  interpolated position -- the bolt itself, PLUS a cooling trail behind it.
 *  Two distinct layers, by design:
 *   - `glow` core: warm, tint components run well above 1.0 so bloom catches
 *     it (the bolt must read as a hot, glowing thing crossing the room).
 *   - `dust` wake: deliberately BELOW 1.0 radiance (ordinary NormalBlending,
 *     no bloom) -- ash/smoke cooling off behind the core, exactly the
 *     "ember/smoke falloff, cooling as it decays" the fix calls for. Using a
 *     separate non-bloom pool for this is what keeps the trail from just
 *     being a second, redundant glow smear.
 */
export function fireballTravel(pools, payload, t) {
  toVec3(payload.position, _pos);
  const scale = payload.scale ?? 1;
  burst(pools.glow, t, _pos, FIRE_TINT, 2 + Math.round(scale * 2), { min: 0.1, max: 0.6 }, { min: 0.1, max: 0.18 }, 0.16 * scale);

  const n = 1 + Math.round(scale);
  for (let i = 0; i < n; i++) {
    sampleEmissionShape('sphere', { radius: 0.7 }, rng, _outPos, _outDir);
    _off.copy(_pos).addScaledVector(_outPos, 0.1);
    _vel.copy(_outDir).multiplyScalar(0.15 + rng.next() * 0.35);
    pools.dust.spawn(t, {
      position: _off,
      velocity: _vel,
      life: 0.2 + rng.next() * 0.2,
      sizeStart: 0.07 * scale,
      sizeEnd: 0.24 * scale,
      gravity: -0.35,
      drag: 1.1,
      tint: { r: 0.5, g: 0.26, b: 0.15 },
      seed: rng.next(),
    });
  }
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

/**
 * A jagged, forked bolt that spans `position` to `target` EXACTLY (G4): the
 * bolt must read as a line connecting two specific things, the caster and
 * the victim, not a line of arbitrary length pointed vaguely their way.
 *
 * `target` is required to hit the actual endpoint; `direction`+a guessed
 * length is kept only as a fallback for a caller that has no endpoint to
 * give (e.g. the `?fxdemo=1` diagnostic rotation), so this never regresses
 * to "throws an error" for an old-shape payload.
 *
 * Two passes down the same path, plus forks branching off it:
 *  - a wide, dim `glow` halo (soft skirt, lower tint) laid first so the...
 *  - ...tight, bright `spark` core (hot tint, higher radiance) draws over it
 *    and reads as the line's hot centre.
 *  - 2-4 short forks peel off the core at random points, because a real
 *    bolt never travels as one clean stroke.
 */
export function lightningArc(pools, payload, t) {
  toVec3(payload.position, _pos);
  if (payload.target) {
    _end.set(payload.target.x, payload.target.y ?? _pos.y, payload.target.z);
  } else {
    toDir(payload.direction, _dir, _fwd);
    const guessLength = 3 + (payload.scale ?? 1) * 5;
    _end.set(_pos.x + _dir.x * guessLength, _pos.y, _pos.z + _dir.z * guessLength);
  }
  const scale = payload.scale ?? 1;
  const dx = _end.x - _pos.x, dz = _end.z - _pos.z;
  const length = Math.max(0.4, Math.hypot(dx, dz));
  _dir.set(dx / length, 0, dz / length);
  const perpX = -_dir.z, perpZ = _dir.x;
  const segments = 10 + Math.round(scale * 6);

  // -- dim halo: wide, soft, laid down first so the core reads brighter by contrast --
  for (let s = 0; s <= segments; s += 2) {
    const u = s / segments;
    const jitter = (1 - Math.abs(u - 0.5) * 2) * 0.35 * scale;
    const off = (rng.next() * 2 - 1) * jitter;
    _off.set(
      _pos.x + _dir.x * length * u + perpX * off,
      _pos.y + (rng.next() * 2 - 1) * jitter * 0.4,
      _pos.z + _dir.z * length * u + perpZ * off
    );
    pools.glow.spawn(t, {
      position: _off, velocity: _zero,
      life: 0.09 + rng.next() * 0.05,
      sizeStart: 0.24, sizeEnd: 0.0,
      drag: 3,
      tint: { r: 0.6, g: 0.85, b: 1.7 },
      seed: rng.next(),
    });
  }

  // -- bright core: tight, hot, jagged --
  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    const jitter = (1 - Math.abs(u - 0.5) * 2) * 0.35;
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

  // -- forks: short branches peeling off the core, a real bolt is never one clean stroke --
  const forkCount = 2 + Math.round(rng.next() * 2);
  for (let f = 0; f < forkCount; f++) {
    const u0 = 0.2 + rng.next() * 0.55;
    const baseX = _pos.x + _dir.x * length * u0 + perpX * ((rng.next() * 2 - 1) * 0.3);
    const baseZ = _pos.z + _dir.z * length * u0 + perpZ * ((rng.next() * 2 - 1) * 0.3);
    const forkLen = length * (0.12 + rng.next() * 0.18);
    const ang = (rng.next() * 2 - 1) * 0.9;
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    const fx = _dir.x * cosA - _dir.z * sinA;
    const fz = _dir.x * sinA + _dir.z * cosA;
    const forkSegs = 3 + Math.round(rng.next() * 2);
    for (let s = 0; s <= forkSegs; s++) {
      const uu = s / forkSegs;
      _off.set(
        baseX + fx * forkLen * uu + (rng.next() * 2 - 1) * 0.06,
        _pos.y + (rng.next() * 2 - 1) * 0.15,
        baseZ + fz * forkLen * uu + (rng.next() * 2 - 1) * 0.06
      );
      pools.spark.spawn(t, {
        position: _off, velocity: _zero,
        life: 0.06 + rng.next() * 0.05,
        sizeStart: 0.06, sizeEnd: 0.0,
        drag: 4,
        tint: { r: 1.3, g: 1.6, b: 3.4 },
        seed: rng.next(),
      });
    }
  }

  // Terminal flash lands ON the target -- the actual endpoint, not a guess.
  pools.flash.trigger({ x: _end.x, y: _end.y, z: _end.z }, { color: 0xbfe6ff, intensity: 30 * scale, distance: 4, life: 0.1 });
}

/**
 * Frost Nova's expanding ring (frost's sibling to G3/G4's legibility fix):
 * particles spawned all along a circle of radius 0 with purely radial
 * outward velocity sized so each one traces exactly `payload.scale` (the
 * spell's `radius`, NOT a generic magnitude multiplier -- see
 * skills/index.js's CASTFX.frostnova) over its own short life. Because
 * displacement with zero drag is just `velocity * age`, the whole ring
 * reaches the real hit radius at the same instant, reading as a single
 * expanding shockwave the player can watch and gauge -- rather than
 * inferring the radius after the fact from who took damage.
 */
export function frostRing(pools, payload, t) {
  toVec3(payload.position, _pos);
  const radius = Math.max(0.5, payload.scale ?? 4);
  const life = 0.3;
  const speed = radius / life;
  const count = 40;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rng.next() * 0.08;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    _vel.set(dx * speed, 0, dz * speed);
    pools.glow.spawn(t, {
      position: _pos,
      velocity: _vel,
      life: life * (0.92 + rng.next() * 0.12),
      sizeStart: 0.06,
      sizeEnd: 0.4,
      drag: 0,
      tint: { r: 0.55, g: 1.5, b: 3.0 },
      seed: rng.next(),
    });
  }
  // A second, sparser pass slightly behind the main ring reinforces the
  // radius read without doubling the particle cost of the main pass.
  for (let i = 0; i < count / 2; i++) {
    const ang = (i / (count / 2)) * Math.PI * 2 + rng.next() * 0.2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const r = radius * (0.85 + rng.next() * 0.1);
    _vel.set(dx * (r / life), 0, dz * (r / life));
    pools.spark.spawn(t, {
      position: _pos,
      velocity: _vel,
      life: life * (0.85 + rng.next() * 0.15),
      sizeStart: 0.04,
      sizeEnd: 0.0,
      drag: 0,
      tint: { r: 1.0, g: 1.9, b: 2.6 },
      seed: rng.next(),
    });
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
  frost_ring: frostRing,
  frost_travel: frostTravel,
  frost_impact: frostImpact,
  lightning_cast: lightningCast,
  lightning_arc: lightningArc,
  lightning_impact: lightningImpact,
};
