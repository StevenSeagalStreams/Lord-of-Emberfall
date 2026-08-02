/**
 * Level dressing: braziers, rubble, bones, pillars, arches, chains, banners,
 * sarcophagi, broken flagstones, cobwebs.
 *
 * Called once after the level geometry is built. Must respect the collision
 * grid (do not block corridors) and must instance anything placed more than a
 * handful of times.
 *
 * STUB -- replaced by the world pass.
 */
export function decorate(_ctx) {
  return { group: null, update(_dt) {} };
}

// ---------------------------------------------------------------------------
// forest dressing: rocks, bones, a reclaimed fence line, a standing-stone
// shrine, and the single saturated blight-fungus accent.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  box, cylinder, sphere, merge,
  buildRubbleGeometry, buildBonePileGeometry,
} from './GeoKit.js';
import { makeInstancedMesh } from './Foliage.js';

const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

function pick(materials, ...names) {
  for (const n of names) if (materials?.[n]) return materials[n];
  return materials?.floor;
}

/** A single leaning fence post, optionally with a broken crossbar stub. */
function buildFencePostGeometry(rng, broken) {
  const h = rng.range(1.1, 1.5);
  const r = rng.range(0.05, 0.08);
  const parts = [cylinder(r * 0.7, r, h, 6, 0, h / 2, 0)];
  if (!broken) {
    parts.push(box(0.7, 0.06, 0.05, 0.35, h * rng.range(0.55, 0.75), 0, 0));
  } else {
    parts.push(box(r * 3, r * 1.4, r * 1.4, 0, h * rng.range(0.3, 0.5), 0, rng.range(0, 1)));
  }
  return merge(parts);
}

/** Tapered monolith -- the shrine ring uses several at varying scale. */
function buildStandingStoneGeometry(rng) {
  const h = rng.range(1.6, 2.6);
  const w = rng.range(0.4, 0.6);
  const parts = [
    box(w, h * 0.9, w * 0.8, 0, h * 0.45, 0),
    box(w * 0.7, h * 0.12, w * 0.6, 0, h * 0.9 + h * 0.06, 0, Math.PI / 5),
  ];
  return merge(parts);
}

/** Small glow cluster: a dull stem holding 1-3 bioluminescent fungal caps.
 * This is the only saturated colour note in the zone, so it is deliberately
 * sparse and always paired with an emissive value that clears the bloom
 * threshold (>1.05 scene-referred radiance). */
function buildFungusCapGeometry(rng) {
  const parts = [];
  const n = 1 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const h = rng.range(0.14, 0.3);
    const capR = rng.range(0.05, 0.11);
    const ox = rng.range(-0.12, 0.12), oz = rng.range(-0.12, 0.12);
    parts.push(cylinder(0.012, 0.02, h, 4, ox, h / 2, oz));
    parts.push(sphere(capR, 6, 4, ox, h, oz, 0.6));
  }
  return merge(parts);
}
function buildFungusStemGeometry(rng) {
  // Stems reuse the same layout but only the thin cylinders, kept in a
  // separate (non-emissive) draw so the glow material stays pure.
  const parts = [];
  const n = 1 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const h = rng.range(0.14, 0.3);
    const ox = rng.range(-0.12, 0.12), oz = rng.range(-0.12, 0.12);
    parts.push(cylinder(0.012, 0.02, h, 4, ox, h / 2, oz));
  }
  return merge(parts);
}

/** No prop, of any kind, is allowed to spawn within this radius of the
 * player's start position -- the player must spawn with a clear view of the
 * landmark, not inside or behind a prop. */
const SPAWN_CLEAR_RADIUS = 6.5;

function scatterField(rng, terrain, { cellSize, accept }) {
  const worldSize = terrain.worldSize;
  const cells = Math.round(worldSize / cellSize);
  const entry = terrain.path.entry;
  const out = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const wx = (i + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      const wz = (j + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      if (wx < 1 || wz < 1 || wx > worldSize - 1 || wz > worldSize - 1) continue;
      if (Math.hypot(wx - entry.x, wz - entry.z) < SPAWN_CLEAR_RADIUS) continue;
      if (!accept(wx, wz, rng)) continue;
      out.push({ wx, wz });
    }
  }
  return out;
}

/**
 * Rocks, bone scatter, the reclaimed fence line at the trailhead, the
 * standing-stone shrine landmark, and sparse blight-fungus glow. Returns a
 * group plus rough draw-call/instance accounting for the zone report.
 */
export function buildForestDressing({ rng, materials, terrain }) {
  const group = new THREE.Group();
  group.name = 'ForestDressing';
  let drawCalls = 0;
  const counts = {};

  // -- rocks: rubble scattered on steep ground and hollow rims --------------
  const rockMat = pick(materials, 'rock', 'roughRock', 'floor').clone();
  rockMat.color = new THREE.Color(0x767c7e);
  const rockGeoA = buildRubbleGeometry(rng);
  const rockGeoB = buildRubbleGeometry(rng);
  const rockSpots = scatterField(rng, terrain, {
    cellSize: 4.2,
    accept: (wx, wz, r) => {
      const slope = terrain.slopeAt(wx, wz);
      const hollow = terrain.hollowAt(wx, wz);
      const path = terrain.pathAt(wx, wz);
      const chance = Math.max(slope * 1.6, hollow * 0.5) * (1 - path * 0.9);
      return r.next() < chance;
    },
  });
  const rockXfA = [], rockXfB = [];
  for (const s of rockSpots) {
    const scale = rng.range(0.7, 1.6);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(s.wx, terrain.heightAt(s.wx, s.wz) - 0.05, s.wz),
      new THREE.Quaternion().setFromAxisAngle(_up, rng.range(0, Math.PI * 2)),
      new THREE.Vector3(scale, scale, scale)
    );
    (rng.bool(0.5) ? rockXfA : rockXfB).push({ m, tint: rng.range(-0.08, 0.08) });
  }
  group.add(makeInstancedMesh(rockGeoA, rockMat, rockXfA, 'RocksA'));
  group.add(makeInstancedMesh(rockGeoB, rockMat, rockXfB, 'RocksB'));
  drawCalls += 2;
  counts.rocks = rockXfA.length + rockXfB.length;

  // -- bones: sparse, biased toward the path -- something happened here ----
  const boneMat = pick(materials, 'bone', 'floor').clone();
  boneMat.color = new THREE.Color(0x9c9276);
  boneMat.roughness = Math.min(1, (boneMat.roughness ?? 0.7) + 0.05);
  const boneGeo = buildBonePileGeometry(rng);
  const boneSpots = scatterField(rng, terrain, {
    cellSize: 7.5,
    accept: (wx, wz, r) => {
      const path = terrain.pathAt(wx, wz);
      const water = terrain.waterAt(wx, wz);
      if (water > 0.3) return false;
      return r.next() < (0.1 + path * 0.5);
    },
  });
  const boneXf = boneSpots.map((s) => ({
    m: new THREE.Matrix4().compose(
      new THREE.Vector3(s.wx, terrain.heightAt(s.wx, s.wz), s.wz),
      new THREE.Quaternion().setFromAxisAngle(_up, rng.range(0, Math.PI * 2)),
      new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.8, 1.3))
    ),
    tint: rng.range(-0.05, 0.05),
  }));
  group.add(makeInstancedMesh(boneGeo, boneMat, boneXf, 'Bones'));
  drawCalls += 1;
  counts.bones = boneXf.length;

  // -- reclaimed fence line near the trailhead -------------------------------
  // Offset well clear of spawn (SPAWN_CLEAR_RADIUS is a hard per-instance
  // guard below) and shifted *behind* the player relative to the path, so it
  // reads as an old homestead boundary off to one side rather than sitting
  // in the sightline toward the landmark. Posts are ~1.1-1.5m tall, spaced
  // 1.8m apart -- small dressing, never meant to fill a close-up frame.
  const fenceMat = pick(materials, 'woodBeams', 'floor').clone();
  fenceMat.color = new THREE.Color(0x4a463c);
  const postGeo = buildFencePostGeometry(rng, false);
  const stumpGeo = buildFencePostGeometry(rng, true);
  const entry = terrain.path.entry;
  const fenceDir = new THREE.Vector3().subVectors(terrain.path.hollowPt, entry).normalize();
  const perp = new THREE.Vector3(-fenceDir.z, 0, fenceDir.x);
  const fenceYaw = Math.atan2(-fenceDir.z, fenceDir.x); // aligns the crossbar with the line
  const perpDist = 17;
  const centerAlong = -9; // behind spawn, away from the forward sightline
  const postXf = [], stumpXf = [];
  const postCount = 9;
  for (let i = 0; i < postCount; i++) {
    if (rng.bool(0.22)) continue; // gaps in the fence line
    const along = centerAlong + (i - postCount / 2) * 1.8;
    const wx = entry.x + perp.x * perpDist + fenceDir.x * along;
    const wz = entry.z + perp.z * perpDist + fenceDir.z * along;
    if (Math.hypot(wx - entry.x, wz - entry.z) < SPAWN_CLEAR_RADIUS) continue;
    if (terrain.slopeAt(wx, wz) > 0.3 || terrain.waterAt(wx, wz) > 0.3) continue;
    const broken = rng.bool(0.35);
    const lean = rng.range(0, broken ? 0.5 : 0.18);
    const q = new THREE.Quaternion()
      .multiplyQuaternions(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), lean * rng.range(-1, 1)),
        new THREE.Quaternion().setFromAxisAngle(_up, fenceYaw + rng.range(-0.12, 0.12))
      );
    const m = new THREE.Matrix4().compose(new THREE.Vector3(wx, terrain.heightAt(wx, wz), wz), q, _one);
    (broken ? stumpXf : postXf).push({ m, tint: rng.range(-0.06, 0.06) });
  }
  group.add(makeInstancedMesh(postGeo, fenceMat, postXf, 'FencePosts'));
  group.add(makeInstancedMesh(stumpGeo, fenceMat, stumpXf, 'FenceStumps'));
  drawCalls += 2;
  counts.fence = postXf.length + stumpXf.length;

  // -- shrine: a ring of standing stones around a glowing altar -------------
  const stoneMat = pick(materials, 'roughRock', 'floor').clone();
  stoneMat.color = new THREE.Color(0x6c7274);
  const stoneGeo = buildStandingStoneGeometry(rng);
  const shrinePos = terrain.path.shrine;
  const shrineY = terrain.heightAt(shrinePos.x, shrinePos.z);
  const ringN = 6;
  const stoneXf = [];
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2;
    const r = 3.4;
    const wx = shrinePos.x + Math.cos(a) * r;
    const wz = shrinePos.z + Math.sin(a) * r;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(wx, terrain.heightAt(wx, wz), wz),
      new THREE.Quaternion().setFromAxisAngle(_up, a + rng.range(-0.15, 0.15)),
      new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.85, 1.15))
    );
    stoneXf.push({ m, tint: rng.range(-0.05, 0.07) });
  }
  group.add(makeInstancedMesh(stoneGeo, stoneMat, stoneXf, 'ShrineStones'));
  drawCalls += 1;
  terrain.markSolidDisc(shrinePos.x, shrinePos.z, 3.9);

  // Altar: a low slab at the shrine's centre, unique mesh, with a fungal
  // glow patch on top -- the landmark's focal point.
  const altarMat = pick(materials, 'roughRock', 'floor').clone();
  altarMat.color = new THREE.Color(0x5c6264);
  const altarGeo = merge([
    box(1.3, 0.45, 0.8, 0, 0.225, 0),
    box(1.1, 0.12, 0.62, 0, 0.51, 0),
  ]);
  const altar = new THREE.Mesh(altarGeo, altarMat);
  altar.position.set(shrinePos.x, shrineY, shrinePos.z);
  altar.castShadow = true; altar.receiveShadow = true;
  group.add(altar);
  drawCalls += 1;

  const altarGlowMat = pick(materials, 'bone', 'floor').clone();
  altarGlowMat.color = new THREE.Color(0x11150f);
  altarGlowMat.emissive = new THREE.Color(0x5dffb0);
  altarGlowMat.emissiveIntensity = 2.6;
  altarGlowMat.roughness = 0.6;
  const altarGlow = new THREE.Mesh(box(0.55, 0.06, 0.34, 0, 0, 0), altarGlowMat);
  altarGlow.position.set(shrinePos.x, shrineY + 0.6, shrinePos.z);
  group.add(altarGlow);
  drawCalls += 1;

  // -- the single saturated note: sparse bioluminescent blight fungus ------
  const fungusStemMat = pick(materials, 'bark', 'woodBeams', 'floor').clone();
  fungusStemMat.color = new THREE.Color(0x2a2620);
  const fungusCapMat = pick(materials, 'bone', 'floor').clone();
  fungusCapMat.color = new THREE.Color(0x0c1410);
  fungusCapMat.emissive = new THREE.Color(0x49ffb4);
  fungusCapMat.emissiveIntensity = 2.2;
  fungusCapMat.roughness = 0.55;

  const fungusStemGeo = buildFungusStemGeometry(rng);
  const fungusCapGeo = buildFungusCapGeometry(rng);
  const fungusSpots = scatterField(rng, terrain, {
    cellSize: 5.6,
    accept: (wx, wz, r) => {
      const hollow = terrain.hollowAt(wx, wz);
      const water = terrain.waterAt(wx, wz);
      const nearShrine = shrinePos.distanceTo(new THREE.Vector3(wx, 0, wz)) < 6;
      if (water > 0.55) return false; // not floating on open water
      const chance = Math.max(hollow * 0.22, nearShrine ? 0.5 : 0);
      return r.next() < chance;
    },
  });
  const fungusXf = fungusSpots.slice(0, 90).map((s) => ({
    m: new THREE.Matrix4().compose(
      new THREE.Vector3(s.wx, terrain.heightAt(s.wx, s.wz), s.wz),
      new THREE.Quaternion().setFromAxisAngle(_up, rng.range(0, Math.PI * 2)),
      new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.7, 1.5))
    ),
    tint: 0,
  }));
  group.add(makeInstancedMesh(fungusStemGeo, fungusStemMat, fungusXf, 'FungusStems'));
  group.add(makeInstancedMesh(fungusCapGeo, fungusCapMat, fungusXf, 'FungusCaps'));
  drawCalls += 2;
  counts.fungus = fungusXf.length;

  let pulseT = 0;
  return {
    group,
    drawCalls,
    counts,
    update(dt) {
      // Slow, uneven bioluminescent pulse -- the one saturated note in the
      // frame should feel alive, not like a static emissive sticker.
      pulseT += dt;
      const p = Math.sin(pulseT * 1.3) * 0.5 + Math.sin(pulseT * 2.9 + 1.7) * 0.3;
      const glow = 2.2 + p * 0.6;
      fungusCapMat.emissiveIntensity = glow;
      altarGlowMat.emissiveIntensity = 2.6 + p * 0.7;
    },
  };
}
