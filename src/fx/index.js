import * as THREE from 'three';

import { GPUParticles } from './GPUParticles.js';
import { Decals } from './Decals.js';
import { PointFlashPool } from './PointFlash.js';
import { LootBeams, resolveRarity } from './LootBeams.js';
import { TorchFire } from './TorchFire.js';
import { GroundFog } from './GroundFog.js';
import * as HitFX from './HitFX.js';
import { SKILL_HANDLERS } from './SkillFX.js';
import { rng } from '../core/RNG.js';

/**
 * VFX subsystem entry point.
 *
 * `main.js` constructs this once and calls `update(dt)` in the fx phase.
 * This file owns nothing visual itself -- it builds the GPU-driven pools
 * (particles, decals, beams, flames), wires them to the event bus, and pumps
 * their clocks every frame. Combat/items/skills never import this directory;
 * they describe *what happened* through `combat:hit`/`item:dropped`/
 * `fx:request` and this pillar decides what it looks like.
 *
 * Draw-call discipline: every mesh below is either a single `THREE.Points`
 * (one GPUParticles pool = one draw call, capacity fixed at construction) or
 * a single `InstancedMesh` (Decals, LootBeams' two meshes). Nothing here
 * allocates a geometry, material or per-particle object after construction --
 * spawning only writes into pre-allocated typed arrays.
 *
 * Effect catalogue:
 *   - blood_hit / spark_metal / impact_flash / blood_kill / dust_step
 *     (combat's documented fx:request kinds -- HitFX.js)
 *   - item:dropped -> rarity-coloured loot beam (LootBeams.js)
 *   - scene.userData.flameRequests -> visible torch flame + embers (TorchFire.js)
 *   - ground fog volumes pooling in low terrain (GroundFog.js)
 *   - fireball_cast/travel/impact, frost_cast/travel/impact,
 *     lightning_cast/arc/impact (SkillFX.js -- skills is still a stub, this
 *     is the contract it will call into)
 *
 * `?fxdemo=1` fires a standing rotation of every effect so a screenshot/
 * capture pass has something to look at even before items/skills exist.
 * Left in as a permanent diagnostic, per the mission brief.
 */
export function createFX(ctx) {
  const { scene, bus, renderer, world } = ctx;

  // ---- shared particle pools ---------------------------------------------
  const dust = new GPUParticles({
    capacity: 500,
    shape: 'soft',
    blending: THREE.NormalBlending,
    renderOrder: 4,
    gradient: [[0, 0.42, 0.34, 0.22], [1, 0.55, 0.46, 0.32]],
    alphaGradient: [[0, 0], [0.12, 0.55], [1, 0]],
  });
  const blood = new GPUParticles({
    capacity: 600,
    shape: 'soft',
    blending: THREE.NormalBlending,
    renderOrder: 5,
    gradient: [[0, 0.55, 0.02, 0.02], [0.35, 0.32, 0.01, 0.01], [1, 0.12, 0.004, 0.004]],
    alphaGradient: [[0, 0], [0.08, 1], [0.55, 0.75], [1, 0]],
  });
  const spark = new GPUParticles({
    capacity: 700,
    shape: 'spark',
    blending: THREE.AdditiveBlending,
    renderOrder: 6,
    gradient: [[0, 1, 1, 1], [1, 1, 1, 1]],
    alphaGradient: [[0, 1], [0.5, 0.6], [1, 0]],
  });
  const glow = new GPUParticles({
    capacity: 900,
    shape: 'glow',
    blending: THREE.AdditiveBlending,
    renderOrder: 6,
    gradient: [[0, 1, 1, 1], [1, 1, 1, 1]],
    alphaGradient: [[0, 0], [0.15, 1], [0.6, 0.5], [1, 0]],
  });

  const decals = new Decals({ capacity: 220 });
  const flash = new PointFlashPool(scene, { capacity: 6 });
  const lootBeams = new LootBeams({ capacity: 24 });
  const torchFire = new TorchFire({ capacity: 160 });
  const groundFog = new GroundFog({ scene, capacity: 160 });

  for (const p of [dust, blood, spark, glow]) p.points.raycast = () => {};
  decals.mesh.raycast = () => {};

  scene.add(dust.points, blood.points, spark.points, glow.points);
  scene.add(decals.mesh);
  scene.add(lootBeams.meshes[0], lootBeams.meshes[1]);
  scene.add(torchFire.points);
  scene.add(groundFog.mesh);

  const pools = { dust, blood, spark, glow, decals, flash };

  // ---- viewport-dependent uniforms ---------------------------------------
  const applyViewport = () => {
    const size = renderer.getSize(_size);
    const h = size.y || 800;
    dust.setViewport(h); blood.setViewport(h); spark.setViewport(h); glow.setViewport(h);
    groundFog.setViewport(h);
    torchFire.setViewport(h);
  };
  applyViewport();
  addEventListener('resize', applyViewport);

  // ---- fx:request dispatch -------------------------------------------------
  let t = 0;

  function handleFxRequest(payload) {
    if (!payload || !payload.kind) return;
    switch (payload.kind) {
      case 'blood_hit': HitFX.bloodHit(pools, payload, t); return;
      case 'spark_metal': HitFX.sparkMetal(pools, payload, t); return;
      case 'impact_flash': HitFX.impactFlash(pools, payload, t); return;
      case 'blood_kill': HitFX.bloodKill(pools, payload, t); return;
      case 'dust_step': HitFX.dustStep(pools, payload, t); return;
      default: {
        const handler = SKILL_HANDLERS[payload.kind];
        if (handler) handler(pools, payload, t);
      }
    }
  }

  function handleItemDropped({ item, position } = {}) {
    if (!position) return;
    const rarity = resolveRarity(item);
    lootBeams.spawn(position, rarity, t);
  }

  const off = [
    bus.on('fx:request', handleFxRequest),
    bus.on('item:dropped', handleItemDropped),
  ];

  // ---- torch flame consumption -------------------------------------------
  // Catacombs pushes {position, kind} onto scene.userData.flameRequests as
  // it places torches (during zone construction, before this subsystem is
  // built). Track a cursor so a re-entrant push (unlikely, but cheap to
  // support) is picked up on a later frame instead of requiring a rebuild.
  let flameCursor = 0;
  function consumeFlameRequests() {
    const reqs = scene.userData.flameRequests;
    if (!reqs) return;
    while (flameCursor < reqs.length) {
      const r = reqs[flameCursor++];
      torchFire.addFlame(r.position, r.kind === 'magic' ? 'magic' : 'torch');
    }
  }

  function emitEmber(position, kind) {
    const magic = kind === 'magic';
    const [dx, dz] = rng.disc();
    glow.spawn(t, {
      position: _emberPos.set(position.x + dx * 0.06, position.y, position.z + dz * 0.06),
      velocity: _emberVel.set(dx * 0.3, 0.7 + rng.next() * 0.6, dz * 0.3),
      life: 0.7 + rng.next() * 0.6,
      sizeStart: 0.045 + rng.next() * 0.02,
      sizeEnd: 0.0,
      gravity: -0.4,
      drag: 0.6,
      tint: magic ? { r: 0.5, g: 0.9, b: 2.6 } : { r: 2.6, g: 1.1, b: 0.25 },
      seed: rng.next(),
    });
  }

  function emitMote(slot, color) {
    const [dx, dz] = rng.disc();
    glow.spawn(t, {
      position: _motePos.set(slot.x + dx * 0.3, slot.y + 0.05, slot.z + dz * 0.3),
      velocity: _moteVel.set(dx * 0.15, 1.1 + rng.next() * 0.5, dz * 0.15),
      life: 0.9 + rng.next() * 0.5,
      sizeStart: 0.06,
      sizeEnd: 0.0,
      drag: 0.3,
      tint: { r: color[0], g: color[1], b: color[2] },
      seed: rng.next(),
    });
  }

  // ---- ?fxdemo=1 diagnostic hook -----------------------------------------
  // Fires a standing rotation of every effect so a headless capture always
  // has something live to grade -- item drops and skill casts have no real
  // emitter yet (items/skills are still stubs). Left in permanently.
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const demo = params?.get('fxdemo') === '1';
  let demoTimer = 0;
  let demoStep = 0;
  if (demo) {
    // Seed one flame even in zones with no torches (forest), so the fire
    // pillar is visible without needing the catacombs.
    const p = world?.player?.position;
    if (p && (!scene.userData.flameRequests || scene.userData.flameRequests.length === 0)) {
      scene.userData.flameRequests = [{ position: new THREE.Vector3(p.x + 2.2, p.y + 1.1, p.z - 1.5), kind: 'torch' }];
    }
  }

  function runDemo(dt) {
    const p = world?.player?.position;
    if (!p) return;
    if (demoStep === 0) {
      demoStep = 1;
      const rarities = ['normal', 'magic', 'rare', 'unique', 'set'];
      rarities.forEach((rarity, i) => {
        const pos = { x: p.x + 3 + i * 1.6, y: p.y, z: p.z + 3 };
        bus.emit('item:dropped', { item: { rarity }, position: pos });
      });
    }
    demoTimer -= dt;
    if (demoTimer > 0) return;
    demoTimer = 0.45;
    const forward = { x: Math.sin(t * 0.7), z: Math.cos(t * 0.7) };
    const cycle = Math.floor(t / 0.45) % 6;
    const base = { x: p.x - 2.5, y: p.y + 0.9, z: p.z + 1.5 };
    switch (cycle) {
      case 0: bus.emit('fx:request', { kind: 'blood_hit', position: base, direction: forward, scale: 1 }); break;
      case 1: bus.emit('fx:request', { kind: 'spark_metal', position: base, direction: forward, scale: 1.1 }); break;
      case 2: bus.emit('fx:request', { kind: 'impact_flash', position: base, direction: forward, scale: 1.2 }); break;
      case 3: bus.emit('fx:request', { kind: 'blood_kill', position: base, direction: forward, scale: 1.3 }); break;
      case 4: bus.emit('fx:request', { kind: 'fireball_impact', position: { x: p.x + 2, y: p.y + 0.5, z: p.z - 2 }, direction: forward, scale: 1.2 }); break;
      case 5: bus.emit('fx:request', { kind: 'lightning_arc', position: { x: p.x - 1, y: p.y + 1.2, z: p.z - 2 }, direction: forward, scale: 1.4 }); break;
      default: break;
    }
  }

  return {
    update(dt) {
      t += dt;

      consumeFlameRequests();

      dust.setTime(t); blood.setTime(t); spark.setTime(t); glow.setTime(t);

      lootBeams.update(dt, t, emitMote);
      torchFire.update(dt, t, emitEmber);
      groundFog.update(dt, world?.player?.position);
      flash.update(dt);

      if (demo) runDemo(dt);

      dust.flush(); blood.flush(); spark.flush(); glow.flush();
      decals.setTime(t);
      decals.flush();
      lootBeams.flush();
    },
    dispose() {
      off.forEach((f) => f());
      removeEventListener('resize', applyViewport);
      for (const p of [dust, blood, spark, glow]) { scene.remove(p.points); p.dispose(); }
      scene.remove(decals.mesh); decals.dispose();
      flash.dispose();
      scene.remove(lootBeams.meshes[0], lootBeams.meshes[1]); lootBeams.dispose();
      scene.remove(torchFire.points); torchFire.dispose();
      scene.remove(groundFog.mesh); groundFog.dispose();
    },
  };
}

const _size = new THREE.Vector2();
const _emberPos = new THREE.Vector3();
const _emberVel = new THREE.Vector3();
const _motePos = new THREE.Vector3();
const _moteVel = new THREE.Vector3();
