import * as THREE from 'three';
import { box, merge } from './GeoKit.js';
import { smoothstep } from '../render/TextureGen.js';
import { segment } from './GeoKit.js';
import { ARCHETYPES, pickArchetype, getBarkNormalMap } from './TreeGen.js';

/**
 * Blighted-forest foliage: five tree archetypes built once in TreeGen.js
 * (trunk+branch hierarchy merged into one geometry, canopy -- where the
 * archetype has one -- merged into a second), each instanced through exactly
 * one (or two) `InstancedMesh` draw calls no matter how many thousand
 * instances are scattered. Everything else here is placement: where trees
 * go, which archetype, what per-instance scale/lean/hue variance, plus the
 * undergrowth and leaf-litter scatter that keeps the ground from reading as
 * empty (or as bare rock) between them.
 *
 * M2 rebuild: the M1 trees were flat hexagonal-slab canopies on bare poles
 * (gate-2 critic: "a canyon, a dry wash, or a cave interior"). This pass
 * replaces that geometry wholesale -- see TreeGen.js for the archetype
 * builders -- and keeps the same InstancedMesh-per-archetype discipline so
 * total draw calls for the whole forest stay in the single digits.
 */

// ---------------------------------------------------------------------------
// silhouette diagnostic
// ---------------------------------------------------------------------------

/**
 * `?silhouette=1` forces every tree material to pure black unlit. This is
 * the actual pass/fail test for tree geometry: render flat black against the
 * sky and ask whether the shapes read as trees with zero material/lighting
 * information to lean on. Left in permanently as a diagnostic, not a one-off
 * hack -- silhouette readability regresses silently otherwise.
 */
const SILHOUETTE_MODE = (() => {
  try {
    return typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('silhouette') === '1';
  } catch {
    return false;
  }
})();

const _up = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// per-instance color: hue jitter (+/-5%) driven by one shared random value
// per tree so bark and canopy shift together (a given tree reads as
// consistently warmer/cooler, not bark and leaves jittered independently).
// ---------------------------------------------------------------------------

function jitterFromBase(baseColor, t, { hue = 0.05, sat = 0.12, light = 0.15 } = {}) {
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  const h = (hsl.h + t * hue + 1) % 1;
  const s = THREE.MathUtils.clamp(hsl.s * (1 + t * sat), 0, 1);
  const l = THREE.MathUtils.clamp(hsl.l * (1 + t * light), 0, 1);
  return new THREE.Color().setHSL(h, s, l);
}

// ---------------------------------------------------------------------------
// placement helpers
// ---------------------------------------------------------------------------

/** Cheap deterministic 2D hash-noise (no tiling requirement here). */
function hashNoise(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Straight-line distance to the nearest sample on the authored trail
 * polyline. O(samples) per call -- only ever used at build time over a few
 * thousand candidate cells, never per-frame. */
function nearestPathDist(terrain, wx, wz) {
  let best = Infinity;
  const s = terrain.path.samples;
  for (let i = 0; i < s.length; i++) {
    const dx = wx - s[i].x, dz = wz - s[i].z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** 0 right at the Dead Great-Tree / shrine landmarks, ramping to 1 clear of
 * them -- these are the two places the brief calls out by name for "pools of
 * light", so they get an explicit carve rather than relying on the noise
 * mask to happen to open up there. */
function landmarkClearing(terrain, wx, wz) {
  const fork = terrain.path.fork, shrine = terrain.path.shrine;
  const dFork = Math.hypot(wx - fork.x, wz - fork.z);
  const dShrine = Math.hypot(wx - shrine.x, wz - shrine.z);
  return Math.min(smoothstep(dFork, 7, 17), smoothstep(dShrine, 6, 14));
}

/**
 * Density is deliberately low and deliberately contrasty: thicket, clearing,
 * thicket, never a uniform lawn. `pathDist` is threaded in from the caller
 * so it is only computed once per candidate cell.
 */
function treeDensityAt(terrain, wx, wz, pathDist) {
  const slope = terrain.slopeAt(wx, wz);
  const water = terrain.waterAt(wx, wz);
  const edge = terrain.edgeAt(wx, wz);
  if (water > 0.3) return 0;
  if (slope > 0.34) return 0.02;

  const u = wx / terrain.worldSize, v = wz / terrain.worldSize;
  const clump = hashNoise(u * 3.0 + 11, v * 3.0 + 4);
  const thicket = smoothstep(clump, 0.5, 0.7);
  const fine = hashNoise(u * 9.3 + 51, v * 9.3 + 23);
  // Interior thicket cap raised relative to the boundary treeline (below):
  // the boundary ring is a long unbroken strip, so even a lower per-cell
  // density there out-clusters a patchy interior thicket by sheer contiguous
  // length. An establishing shot auto-framed on "the densest cluster" was
  // consistently locking onto the boundary ring, aiming half the frame past
  // the sealed edge into open sky/fog instead of at the readable interior
  // forest mass. Keeping the boundary present but sparser fixes what the
  // auto-framer actually points at without touching the framer itself.
  let interior = thicket * (0.5 + 0.5 * fine) * 0.62;

  interior *= smoothstep(pathDist, 6, 15);
  interior *= landmarkClearing(terrain, wx, wz);

  const edgeDensity = edge * 0.3;
  let d = Math.max(interior, edgeDensity);
  d *= 1 - THREE.MathUtils.clamp(slope * 1.6, 0, 0.6);
  return THREE.MathUtils.clamp(d, 0, 1);
}

// ---------------------------------------------------------------------------
// forest build: five archetypes, each one (trunk InstancedMesh) + optional
// (canopy InstancedMesh) -- <= 10 draw calls total regardless of instance
// count, per the M2 budget.
// ---------------------------------------------------------------------------

export function buildForestFoliage({ rng, terrain }) {
  const group = new THREE.Group();
  group.name = 'Foliage';
  const worldSize = terrain.worldSize;

  // Build each archetype's geometry exactly once. A dedicated rng fork keeps
  // "which tree shapes exist" independent of "where they get placed".
  const archRng = rng.fork ? rng.fork('archetypes') : rng;
  const archetypes = ARCHETYPES.map((a) => ({ name: a.name, weight: a.weight, geo: a.build(archRng) }));

  const silhouetteMat = SILHOUETTE_MODE ? new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }) : null;

  const barkBase = new THREE.Color(0x3a3226);
  const leafBase = new THREE.Color(0x545c3c);
  const litterBase = new THREE.Color(0x4a3722);

  const barkMat = silhouetteMat || (() => {
    const m = (terrain.materials?.bark || terrain.materials?.woodBeams || terrain.materials?.floor).clone();
    m.color = new THREE.Color(0xffffff); // per-instance color carries the actual hue -- see jitterFromBase
    m.roughness = 0.9;
    const normal = getBarkNormalMap();
    if (normal) {
      m.normalMap = normal;
      m.normalScale = new THREE.Vector2(1.1, 1.1);
    }
    return m;
  })();

  const leafMat = silhouetteMat || (() => {
    const m = (terrain.materials?.deadLeaves || terrain.materials?.roughRock || terrain.materials?.floor).clone();
    m.color = new THREE.Color(0xffffff);
    m.roughness = 0.95;
    return m;
  })();

  const litterMat = silhouetteMat || (() => {
    const m = (terrain.materials?.deadLeaves || terrain.materials?.bark || terrain.materials?.floor).clone();
    m.color = new THREE.Color(litterBase);
    m.roughness = 1.0;
    return m;
  })();

  // --- placement pass: jittered grid, density-gated, archetype-weighted ----
  // Coarser than the old tier system (4.4m -> 5.6m) and, per archetype, a
  // single always-full-detail geometry rather than a cheap distance-LOD
  // variant -- every tree placed now has real branch/canopy structure, so
  // total tree count (not per-tree cost) is the budget lever.
  const cellSize = 6.0;
  const cells = Math.round(worldSize / cellSize);
  const archXf = archetypes.map(() => []); // [{ m, hueT }]
  const litterXf = [];
  const counts = Object.fromEntries(archetypes.map((a) => [a.name, 0]));

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const wx = (i + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      const wz = (j + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      if (wx < 1 || wz < 1 || wx > worldSize - 1 || wz > worldSize - 1) continue;

      const pathDist = nearestPathDist(terrain, wx, wz);
      const density = treeDensityAt(terrain, wx, wz, pathDist);
      if (rng.next() >= density) continue;

      // Pick ONCE, then locate it. Calling pickArchetype() inside the
      // findIndex predicate re-rolls a different archetype per comparison, so
      // the match depends on which element happens to be tested when the roll
      // lands -- and returns -1 whenever none does. ARCHETYPES and this local
      // list are 1:1 by construction, so indexOf is exact.
      const picked = pickArchetype(rng);
      const archIdx = Math.max(0, ARCHETYPES.indexOf(picked));
      const arch = archetypes[archIdx];
      const groundY = terrain.heightAt(wx, wz);
      const yaw = rng.range(0, Math.PI * 2);
      const scale = rng.range(0.8, 1.3);

      // Per-instance lean variance: 2-4 degrees baseline (spec), plus an
      // occasional dramatic topple so the blighted read isn't uniform --
      // the bend itself lives in the archetype geometry, this is the
      // instance-level tilt on top of it.
      const dramatic = rng.bool(0.1);
      const leanDeg = rng.range(2, 4) + (dramatic ? rng.range(8, 22) : 0);
      const leanRad = THREE.MathUtils.degToRad(leanDeg);
      const leanDir = rng.range(0, Math.PI * 2);
      const qYaw = new THREE.Quaternion().setFromAxisAngle(_up, yaw);
      const leanAxis = new THREE.Vector3(Math.cos(leanDir), 0, Math.sin(leanDir));
      const qLean = new THREE.Quaternion().setFromAxisAngle(leanAxis, leanRad);
      const q = new THREE.Quaternion().multiplyQuaternions(qLean, qYaw);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(wx, groundY, wz), q, new THREE.Vector3(scale, scale, scale));

      const hueT = rng.range(-1, 1);
      archXf[archIdx].push({ m, hueT });
      counts[arch.name]++;
      if (scale > 1.0) terrain.markSolidDisc(wx, wz, 0.32 * scale);

      // Leaf litter under canopy: only where there is a canopy to drop it.
      if (arch.geo.canopy && rng.bool(0.5)) {
        const litterScale = scale * arch.geo.height * 0.12;
        const litterM = new THREE.Matrix4().compose(
          new THREE.Vector3(wx, groundY + 0.01, wz),
          new THREE.Quaternion().setFromAxisAngle(_up, rng.range(0, Math.PI * 2)),
          new THREE.Vector3(litterScale, 1, litterScale)
        );
        litterXf.push({ m: litterM, color: jitterFromBase(litterBase, rng.range(-1, 1), { hue: 0.03, sat: 0.15, light: 0.2 }) });
      }
    }
  }

  // --- the landmark: one hand-placed dead great-tree, bigger and unique,
  // folded into the split-trunk archetype's own instance list (not a new
  // draw call) at the authored fork clearing. ------------------------------
  const landmarkIdx = archetypes.findIndex((a) => a.name === 'splitTrunk');
  if (landmarkIdx >= 0) {
    const gtPos = terrain.path.fork;
    const gtY = terrain.heightAt(gtPos.x, gtPos.z);
    const gtScale = 2.35;
    const gtYaw = rng.range(0, Math.PI * 2);
    const gtM = new THREE.Matrix4().compose(
      new THREE.Vector3(gtPos.x, gtY, gtPos.z),
      new THREE.Quaternion().setFromAxisAngle(_up, gtYaw),
      new THREE.Vector3(gtScale, gtScale, gtScale)
    );
    archXf[landmarkIdx].push({ m: gtM, hueT: -1 });
    counts.splitTrunk++;
    terrain.markSolidDisc(gtPos.x, gtPos.z, 1.6 * gtScale * 0.4);
  }

  // --- instance + draw: one trunk mesh + (optional) one canopy mesh per
  // archetype, regardless of how many instances landed in it. -------------
  let drawCalls = 0;
  for (let a = 0; a < archetypes.length; a++) {
    const { geo, name } = archetypes[a];
    const xfs = archXf[a];
    const trunkXf = xfs.map((e) => ({ m: e.m, color: jitterFromBase(barkBase, e.hueT) }));
    group.add(makeInstancedMesh(geo.trunk, barkMat, trunkXf, `Tree_${name}_Trunk`));
    drawCalls++;
    if (geo.canopy) {
      const canopyXf = xfs.map((e) => ({ m: e.m, color: jitterFromBase(leafBase, e.hueT) }));
      group.add(makeInstancedMesh(geo.canopy, leafMat, canopyXf, `Tree_${name}_Canopy`));
      drawCalls++;
    }
  }

  const litterGeo = buildLeafLitterGeometry(rng.fork ? rng.fork('litter') : rng);
  group.add(makeInstancedMesh(litterGeo, litterMat, litterXf, 'LeafLitter'));
  drawCalls++;

  return {
    group,
    counts: { ...counts, leafLitter: litterXf.length },
    drawCalls,
  };
}

// ---------------------------------------------------------------------------
// ground: leaf-litter scatter under canopies
// ---------------------------------------------------------------------------

/** A small overlapping scatter of flat dead-leaf flecks -- one merged
 * geometry instanced once per canopied tree, at a scale keyed to that tree's
 * canopy footprint. Cheap: ~10-14 flattened boxes, ~2 triangles each. */
function buildLeafLitterGeometry(rng) {
  const parts = [];
  const n = 9 + rng.int(0, 6);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * rng.range(0.7, 1.0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const s = rng.range(0.1, 0.22);
    const rotY = rng.range(0, Math.PI * 2);
    parts.push(box(s, 0.012, s * rng.range(0.55, 1.0), x, 0.006, z, rotY));
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// instancing
// ---------------------------------------------------------------------------

export function makeInstancedMesh(geo, mat, transforms, name) {
  const count = Math.max(1, transforms.length);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const color = new THREE.Color();
  for (let i = 0; i < transforms.length; i++) {
    mesh.setMatrixAt(i, transforms[i].m);
    if (transforms[i].color) {
      mesh.setColorAt(i, transforms[i].color);
    } else {
      const t = 1 + (transforms[i].tint ?? 0);
      color.setRGB(t, t, t);
      mesh.setColorAt(i, color);
    }
  }
  if (transforms.length === 0) mesh.count = 0;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// undergrowth: ferns, dead shrubs, dead-grass tufts, fallen logs, root snags
// ---------------------------------------------------------------------------

/** A small cluster of thin curled blades radiating from a point. */
function buildBladeClusterGeometry(rng, { count, height, curl, width }) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const h = height * rng.range(0.7, 1.15);
    const lean = rng.range(0.15, curl);
    const from = new THREE.Vector3(Math.cos(a) * width * 0.15, 0, Math.sin(a) * width * 0.15);
    const to = new THREE.Vector3(
      from.x + Math.cos(a) * Math.sin(lean) * h,
      h * Math.cos(lean),
      from.z + Math.sin(a) * Math.sin(lean) * h
    );
    const seg = segment(width * 0.02, width * 0.09, from, to, 3);
    if (seg) parts.push(seg);
  }
  return merge(parts);
}

function buildFallenLogGeometry(rng) {
  const len = rng.range(2.2, 4.2);
  const r = rng.range(0.18, 0.3);
  const parts = [
    (function cyl() {
      const from = new THREE.Vector3(-len / 2, r, 0);
      const to = new THREE.Vector3(len / 2, r, 0);
      return segment(r, r * 1.08, from, to, 7, false);
    })(),
  ];
  const n = 2 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const x = rng.range(-len * 0.4, len * 0.4);
    parts.push(box(r * 0.5, r * 0.35, r * 1.7, x, r * 1.7, rng.range(-r * 0.3, r * 0.3), rng.range(0, Math.PI)));
  }
  return merge(parts.filter(Boolean));
}

function buildRootSnagGeometry(rng) {
  const parts = [];
  const n = 3 + rng.int(0, 2);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const len = rng.range(0.5, 1.1);
    const from = new THREE.Vector3(0, 0.05, 0);
    const to = new THREE.Vector3(Math.cos(a) * len, len * rng.range(0.15, 0.4), Math.sin(a) * len);
    const seg = segment(0.03, 0.11, from, to, 5);
    if (seg) parts.push(seg);
  }
  return merge(parts);
}

function undergrowthDensityAt(terrain, wx, wz, kind) {
  const slope = terrain.slopeAt(wx, wz);
  const path = terrain.pathAt(wx, wz);
  const water = terrain.waterAt(wx, wz);
  if (water > 0.4 || slope > 0.32) return 0;
  const u = wx / terrain.worldSize, v = wz / terrain.worldSize;
  const patch = Math.pow(hashNoise(u * 8.1 + 31 + kind, v * 8.1 + 17), 1.2);
  return patch * (1 - path * 0.85) * (1 - slope * 2);
}

export function buildUndergrowth({ rng, terrain }) {
  const group = new THREE.Group();
  group.name = 'Undergrowth';
  const worldSize = terrain.worldSize;

  const silhouetteMat = SILHOUETTE_MODE ? new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }) : null;

  const fernMat = silhouetteMat || (terrain.materials?.deadLeaves || terrain.materials?.roughRock || terrain.materials?.floor).clone();
  if (!silhouetteMat) fernMat.color = new THREE.Color(0x616a44);
  const shrubMat = silhouetteMat || (terrain.materials?.bark || terrain.materials?.woodBeams || terrain.materials?.floor).clone();
  if (!silhouetteMat) shrubMat.color = new THREE.Color(0x342f26);
  const logMat = silhouetteMat || shrubMat.clone();
  if (!silhouetteMat) logMat.color = new THREE.Color(0x3c3629);
  const rootMat = silhouetteMat || shrubMat.clone();
  if (!silhouetteMat) rootMat.color = new THREE.Color(0x2c281f);

  const fernGeo = buildBladeClusterGeometry(rng, { count: 6, height: 0.55, curl: 0.9, width: 0.5 });
  const tuftGeo = buildBladeClusterGeometry(rng, { count: 8, height: 0.35, curl: 0.55, width: 0.4 });
  const shrubGeo = (() => {
    const parts = [];
    const n = 4 + rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const len = rng.range(0.35, 0.75);
      const from = new THREE.Vector3(0, 0.05, 0);
      const to = new THREE.Vector3(Math.cos(a) * len * 0.5, len, Math.sin(a) * len * 0.5);
      const seg = segment(0.02, 0.05, from, to, 4);
      if (seg) parts.push(seg);
    }
    return merge(parts);
  })();
  const logGeo = buildFallenLogGeometry(rng);
  const rootGeo = buildRootSnagGeometry(rng);

  const placements = { fern: [], tuft: [], shrub: [], log: [], root: [] };
  const cellSize = 3.4;
  const cells = Math.round(worldSize / cellSize);

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const wx = (i + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      const wz = (j + 0.5 + rng.range(-0.5, 0.5)) * cellSize;
      if (wx < 1 || wz < 1 || wx > worldSize - 1 || wz > worldSize - 1) continue;
      const groundY = terrain.heightAt(wx, wz);
      const yaw = rng.range(0, Math.PI * 2);

      const roll = rng.next();
      let kind = null;
      if (roll < 0.22 && undergrowthDensityAt(terrain, wx, wz, 1) > 0.35) kind = 'fern';
      else if (roll < 0.5 && undergrowthDensityAt(terrain, wx, wz, 2) > 0.3) kind = 'tuft';
      else if (roll < 0.6 && undergrowthDensityAt(terrain, wx, wz, 3) > 0.45) kind = 'shrub';
      else if (roll < 0.63 && undergrowthDensityAt(terrain, wx, wz, 4) > 0.55) kind = 'log';
      else if (roll < 0.68 && undergrowthDensityAt(terrain, wx, wz, 5) > 0.5) kind = 'root';
      if (!kind) continue;

      const scale = rng.range(0.75, 1.4);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(wx, groundY, wz),
        new THREE.Quaternion().setFromAxisAngle(_up, yaw),
        new THREE.Vector3(scale, scale, scale)
      );
      placements[kind].push({ m, tint: rng.range(-0.08, 0.1) });
    }
  }

  group.add(makeInstancedMesh(fernGeo, fernMat, placements.fern, 'Ferns'));
  group.add(makeInstancedMesh(tuftGeo, fernMat, placements.tuft, 'GrassTufts'));
  group.add(makeInstancedMesh(shrubGeo, shrubMat, placements.shrub, 'DeadShrubs'));
  group.add(makeInstancedMesh(logGeo, logMat, placements.log, 'FallenLogs'));
  group.add(makeInstancedMesh(rootGeo, rootMat, placements.root, 'RootSnags'));

  return {
    group,
    drawCalls: 5,
    counts: Object.fromEntries(Object.entries(placements).map(([k, v]) => [k, v.length])),
  };
}
