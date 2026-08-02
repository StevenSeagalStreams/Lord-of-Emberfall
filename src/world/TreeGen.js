import * as THREE from 'three';
import { box, segment, blob, merge } from './GeoKit.js';
// Materials agent owns TextureGen.js. Namespace-import it (rather than named
// imports) so a renamed/removed export degrades to a fallback instead of
// throwing at module-load time -- this file must never be the reason the
// forest fails to build.
import * as TextureGen from '../render/TextureGen.js';

/**
 * Tree archetype geometry: five distinct blighted-forest silhouettes, each
 * built from a shared trunk/branch/canopy kit so the *system* stays cheap
 * (every archetype ends up as exactly one merged trunk+branch geometry and,
 * where it has one, one merged canopy geometry -- Foliage.js instances both
 * per archetype, so total draw calls for the whole forest is a small fixed
 * number regardless of instance count).
 *
 * Every archetype gets, at minimum:
 *   - a tapered, gently bent multi-segment trunk with a root-flare base
 *     (buttress roots reaching into the ground, not a pole stuck in a plane)
 *   - a two-level branch hierarchy: primary limbs off the trunk, secondary
 *     stubs off some of those -- silhouette-breaking structure, not a single
 *     stick
 *   - (except the bare snag) a canopy built from several overlapping,
 *     noise-jittered ellipsoid masses clustered asymmetrically, with some
 *     fraction of branch tips left bare so broken structure actually shows
 *     through a sparse/blighted crown
 */

const _up = new THREE.Vector3(0, 1, 0);

function sphericalDir(yaw, rise) {
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(rise), Math.sin(rise), Math.cos(yaw) * Math.cos(rise));
}

// ---------------------------------------------------------------------------
// bark normal map (procedural, matches the materials agent's height-field ->
// normal-map pipeline so bark reads as relief rather than a flat tint)
// ---------------------------------------------------------------------------

let _barkNormalCache = null;

/**
 * Vertical ridged-noise bark normal map, generated straight from TextureGen's
 * noise + height-to-normal pipeline. Every call after the first returns the
 * cached texture. Returns `null` (never throws) if TextureGen's surface has
 * changed shape -- callers must treat a null normal map as "flat bark", not
 * as a fatal error.
 */
export function getBarkNormalMap(size = 256) {
  if (_barkNormalCache !== null) return _barkNormalCache;
  try {
    const makeValueNoise = TextureGen.makeValueNoise;
    const anisoFbm = TextureGen.anisoFbm;
    const ridge = TextureGen.ridge;
    const generateHeight = TextureGen.generateHeight;
    const heightToNormal = TextureGen.heightToNormal;
    const toTexture = TextureGen.toTexture;
    if (!makeValueNoise || !generateHeight || !heightToNormal || !toTexture) {
      throw new Error('TextureGen missing height/normal pipeline exports');
    }
    const noise = makeValueNoise(90210);
    const noiseFine = makeValueNoise(11020);
    const height = generateHeight(size, (u, v) => {
      // Vertical ridges: heavy stretch along the (u,v)-rotated Y axis so the
      // pattern barely varies along texture-V (the trunk's height axis) and
      // varies fast along texture-U (around the trunk) -- the definition of
      // bark fissures that run the length of the trunk.
      const vertical = anisoFbm
        ? anisoFbm(noise, u, v, 0, 9, { octaves: 4, basePeriod: 5, lacunarity: 2.1, gain: 0.55 })
        : noise(u * 5, v * 5, 5);
      const ridged = ridge ? ridge(vertical, 1.9) : vertical;
      const fine = noise(u * 26 + 4, v * 9 + 11, 26) - 0.5;
      const grain = noiseFine(u * 60 + 2, v * 4 + 6, 60) - 0.5;
      return ridged * 0.78 + fine * 0.14 + grain * 0.08;
    });
    const canvas = heightToNormal(height, size, 2.6);
    const tex = toTexture(canvas, { srgb: false, repeat: 1, aniso: 8 });
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    _barkNormalCache = tex;
  } catch (err) {
    console.warn('[TreeGen] bark normal map synthesis failed, bark will be flat-normal:', err);
    _barkNormalCache = null;
  }
  return _barkNormalCache;
}

// ---------------------------------------------------------------------------
// trunk / branch / canopy kit
// ---------------------------------------------------------------------------

/**
 * Tapered, gently bent trunk with a root-flare base. `taperRatio` is
 * top-radius / base-radius measured at the very top of the trunk (where
 * branches leave it) -- ~0.35 per spec. The bend is a genuine 2-3 segment
 * polyline (each joint offset horizontally by up to `bendAmt`), never a
 * straight cylinder.
 */
function buildTrunk(rng, { height, baseR, segs = 3, bendAmt = 0.5, taperRatio = 0.35, radial = 7 }) {
  const parts = [];
  const flareH = height * 0.11;

  // Root flare: a flanged collar plus a few buttress roots splaying into the
  // ground -- this is what keeps the trunk from reading as a pole stuck
  // through a flat plane.
  parts.push(segment(baseR * 1.05, baseR * 2.3, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, flareH, 0), Math.max(6, radial - 1), false));
  const buttresses = 3 + rng.int(0, 2);
  for (let i = 0; i < buttresses; i++) {
    const a = (i / buttresses) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const len = baseR * rng.range(1.7, 2.6);
    const from = new THREE.Vector3(0, flareH * 0.2, 0);
    const to = new THREE.Vector3(Math.cos(a) * len, 0.015, Math.sin(a) * len);
    const s = segment(baseR * 0.1, baseR * 0.4, from, to, 4, false);
    if (s) parts.push(s);
  }

  let cur = new THREE.Vector3(0, flareH, 0);
  let r = baseR * 1.0;
  const segH = (height - flareH) / segs;
  for (let i = 0; i < segs; i++) {
    const t = (i + 1) / segs;
    const rNext = THREE.MathUtils.lerp(baseR, baseR * taperRatio, t);
    const next = new THREE.Vector3(
      cur.x + rng.range(-1, 1) * bendAmt * segH * 0.55,
      cur.y + segH,
      cur.z + rng.range(-1, 1) * bendAmt * segH * 0.55
    );
    const isTop = i === segs - 1;
    const s = segment(rNext, r, cur, next, radial, !isTop);
    if (s) parts.push(s);
    cur = next; r = rNext;
  }
  return { parts, topY: cur.y, topPos: cur, topR: r, height };
}

/**
 * Primary branch hierarchy off a trunk (or trunk fork). Returns a list of
 * `{ origin, tip, branchTips, foliagePts }` records. `branchTips` is every
 * tip (primary + secondary stubs), for silhouette/structure purposes;
 * `foliagePts` is the subset the canopy pass is allowed to hang leaf mass
 * from -- a deliberate ~25% of secondary stub tips are excluded so *some*
 * bare twig always pokes past the leaf silhouette regardless of how the
 * defoliation roll lands (spec: exposed branch tips on blighted trees).
 * `minAngleDeg`/`maxAngleDeg` bound the leave-angle off the trunk (spec:
 * 30-60 degrees). `startFrac` is deliberately low by default -- branches
 * starting near mid-trunk are what create the "umbrella on a bare pole"
 * silhouette; real crowns start filling in well below their own top.
 */
function buildBranches(rng, parts, trunk, {
  count = 4, minAngleDeg = 30, maxAngleDeg = 60,
  lenFrac = 0.34, startFrac = 0.28, baseR, subChance = 0.55,
}) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const t = THREE.MathUtils.clamp(
      THREE.MathUtils.lerp(startFrac, 0.95, count <= 1 ? 0.6 : i / (count - 1)) + rng.range(-0.05, 0.05),
      0.05, 0.99
    );
    const oy = trunk.topY * t;
    const origin = new THREE.Vector3(trunk.topPos.x * t, oy, trunk.topPos.z * t);
    const yaw = rng.range(0, Math.PI * 2);
    const rise = THREE.MathUtils.degToRad(rng.range(minAngleDeg, maxAngleDeg));
    const len = trunk.height * lenFrac * rng.range(0.75, 1.3) * (1 - t * 0.2);
    const r0 = baseR * rng.range(0.24, 0.36) * (1 - t * 0.3);
    const dir = sphericalDir(yaw, rise);
    const tip = origin.clone().addScaledVector(dir, len);
    const s = segment(Math.max(0.02, r0 * 0.3), r0, origin, tip, 5, true);
    if (s) parts.push(s);

    const branchTips = [tip];
    const foliagePts = [tip];
    const subCount = rng.bool(subChance) ? 1 + rng.int(0, 1) : 0;
    for (let k = 0; k < subCount; k++) {
      const subT = rng.range(0.35, 0.8);
      const subOrigin = origin.clone().lerp(tip, subT);
      const subYaw = yaw + rng.range(-1.1, 1.1);
      const subRise = rise + rng.range(0.05, 0.55);
      const subLen = len * rng.range(0.35, 0.6);
      const subR0 = r0 * rng.range(0.32, 0.55);
      const subDir = sphericalDir(subYaw, subRise);
      const subTip = subOrigin.clone().addScaledVector(subDir, subLen);
      const subSeg = segment(Math.max(0.01, subR0 * 0.25), subR0, subOrigin, subTip, 4, true);
      if (subSeg) parts.push(subSeg);
      branchTips.push(subTip);
      // ~25% of secondary stubs stay permanently bare -- guaranteed exposed
      // structure, not left to the defoliation dice roll.
      if (!rng.bool(0.25)) foliagePts.push(subTip);
    }
    records.push({ origin, tip, branchTips, foliagePts, t });
  }
  return records;
}

/**
 * Canopy: several overlapping noise-jittered ellipsoid masses that read as
 * ONE lumpy, vertically-distributed crown -- not a single high cap floating
 * over a bare pole (the "mushroom/umbrella" failure) and not scattered
 * separate plates.
 *
 * Two distinct failure modes, two distinct fixes:
 *   - Tips fan out in random yaw around the whole trunk, so a blob sized to
 *     its own tip with nothing pulling it toward its neighbours floats alone
 *     -- fixed by pulling each blob HORIZONTALLY toward the trunk axis
 *     (not toward a single 3D centroid). Pulling horizontally only, at each
 *     anchor's own height, makes neighbours at similar heights overlap into
 *     one mass while *preserving* the natural height spread between low
 *     branch origins and high branch tips.
 *   - Anchoring blobs only at branch *tips* leaves the whole lower half of
 *     the branch structure -- and the gap between trunk-top and canopy-
 *     bottom -- bare, which is exactly the mushroom read. Fixed by anchoring
 *     roughly half the blobs at branch *origins* (where limbs leave the
 *     trunk) instead of tips, so leaf mass hangs down into the branch
 *     structure and interpenetrates the upper trunk rather than capping it.
 *
 * `defoliation` (0-1) is the fraction of slots deliberately left empty, and
 * `foliagePts` (passed in per branch record) already permanently excludes
 * some secondary-stub tips -- between the two, bare structure is guaranteed
 * to show, not left to chance.
 */
function buildCanopy(rng, branchRecords, { canopyScale, blobRange = [4, 9], defoliation = 0, droop = 0 }) {
  const tipAnchors = [];
  const originAnchors = [];
  for (const b of branchRecords) {
    for (const p of b.foliagePts) tipAnchors.push(p);
    originAnchors.push(b.origin);
  }
  if (!tipAnchors.length) return null;

  const targetCount = rng.int(blobRange[0], blobRange[1]);
  const parts = [];
  let placed = 0;
  const maxBare = Math.max(0, Math.floor(targetCount * defoliation));
  let bareUsed = 0;
  for (let i = 0; i < targetCount; i++) {
    // Roughly half the blobs hang from branch origins (low, against the
    // trunk) and half from tips (high, at the crown edge) -- mass spans the
    // whole branch structure instead of capping it.
    const fromOrigin = originAnchors.length > 0 && rng.bool(0.45);
    const pool = fromOrigin ? originAnchors : tipAnchors;
    const anchor = pool[rng.int(0, pool.length - 1)];
    if (bareUsed < maxBare && rng.next() < defoliation) { bareUsed++; continue; }
    // Pull 20-45% of the way toward the trunk axis at this anchor's OWN
    // height (not toward a shared centroid) -- neighbours at similar
    // heights overlap without collapsing the whole crown to one Y level.
    const pull = rng.range(0.2, 0.45);
    const axisTarget = new THREE.Vector3(0, anchor.y, 0);
    const center = anchor.clone().lerp(axisTarget, pull);
    const rx = canopyScale * rng.range(0.7, 1.2);
    const ry = canopyScale * rng.range(0.55, 0.9);
    const rz = canopyScale * rng.range(0.7, 1.2);
    const ox = rng.range(-0.3, 0.3) * canopyScale;
    const oy = (rng.range(-0.3, 0.35) - droop) * canopyScale;
    const oz = rng.range(-0.3, 0.3) * canopyScale;
    parts.push(blob(rng, {
      rx, ry, rz, wSeg: 7, hSeg: 6,
      cx: center.x + ox, cy: center.y + oy, cz: center.z + oz,
      jitter: 0.26,
    }));
    placed++;
  }
  // Never fully bald when a canopy was actually requested -- guarantee one
  // clump at the highest tip so the tree doesn't silently become a snag.
  if (!placed) {
    const top = tipAnchors.reduce((a, b) => (b.y > a.y ? b : a), tipAnchors[0]);
    parts.push(blob(rng, {
      rx: canopyScale * 0.9, ry: canopyScale * 0.7, rz: canopyScale * 0.9,
      cx: top.x, cy: top.y, cz: top.z, jitter: 0.24,
    }));
  }
  return merge(parts);
}

/** A jagged fractured top -- broken-off trunk read, shared by snags and any
 * archetype that rolls a "storm damage" top. */
function buildFracture(rng, parts, topPos, topR, topY, height) {
  const shardN = 3 + rng.int(0, 2);
  for (let i = 0; i < shardN; i++) {
    const a = (i / shardN) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = topR * rng.range(0.5, 0.95);
    const shardH = height * rng.range(0.05, 0.13);
    parts.push(box(
      topR * 0.5, shardH, topR * 0.5,
      topPos.x + Math.cos(a) * r * 0.5, topY + shardH * 0.4, topPos.z + Math.sin(a) * r * 0.5,
      a
    ));
  }
}

// ---------------------------------------------------------------------------
// archetypes
// ---------------------------------------------------------------------------

/** 1. Tall gaunt -- the dominant canopy-tree read: tall, thin, sparse high
 * crown, exposed upper branch tips. */
export function buildTallGaunt(rng) {
  const height = rng.range(9.5, 14.5);
  const baseR = rng.range(0.34, 0.48);
  const trunk = buildTrunk(rng, { height, baseR, segs: 3, bendAmt: 0.4, taperRatio: 0.35, radial: 7 });
  const parts = [...trunk.parts];
  const branches = buildBranches(rng, parts, trunk, {
    count: 4 + rng.int(0, 2), minAngleDeg: 32, maxAngleDeg: 58,
    lenFrac: 0.32, startFrac: 0.26, baseR, subChance: 0.55,
  });
  const canopy = buildCanopy(rng, branches, {
    canopyScale: height * 0.17, blobRange: [4, 6], defoliation: rng.range(0.35, 0.55),
  });
  return { trunk: merge(parts), canopy, height, kind: 'tallGaunt' };
}

/** 2. Broad dying -- wide, low, sagging crown; the most "healthy-shaped"
 * silhouette but sick: heavy horizontal limbs and a drooping, holed canopy. */
export function buildBroadDying(rng) {
  const height = rng.range(6.5, 9.5);
  const baseR = rng.range(0.5, 0.7);
  const trunk = buildTrunk(rng, { height, baseR, segs: 2, bendAmt: 0.3, taperRatio: 0.4, radial: 7 });
  const parts = [...trunk.parts];
  const branches = buildBranches(rng, parts, trunk, {
    count: 5 + rng.int(0, 1), minAngleDeg: 35, maxAngleDeg: 62,
    lenFrac: 0.4, startFrac: 0.28, baseR, subChance: 0.6,
  });
  const canopy = buildCanopy(rng, branches, {
    canopyScale: height * 0.22, blobRange: [6, 9], defoliation: rng.range(0.25, 0.4), droop: 0.18,
  });
  return { trunk: merge(parts), canopy, height, kind: 'broadDying' };
}

/** 3. Split trunk -- co-dominant fork partway up, each leader carrying its
 * own smaller branch set and canopy. */
export function buildSplitTrunk(rng) {
  const height = rng.range(8.5, 12.5);
  const baseR = rng.range(0.46, 0.62);
  const forkT = rng.range(0.42, 0.58);
  const lowerHeight = height * forkT;
  const lower = buildTrunk(rng, { height: lowerHeight, baseR, segs: 2, bendAmt: 0.35, taperRatio: 0.8, radial: 7 });
  const parts = [...lower.parts];

  const leaders = 2;
  const branchRecords = [];
  for (let leader = 0; leader < leaders; leader++) {
    const leaderR = lower.topR * rng.range(0.75, 0.92);
    const splitAngle = THREE.MathUtils.degToRad(rng.range(16, 32)) * (leader === 0 ? -1 : 1);
    const yaw = rng.range(0, Math.PI * 2);
    const leaderLen = height * (1 - forkT) * rng.range(0.9, 1.05);
    const dir = sphericalDir(yaw, Math.PI / 2 - splitAngle - THREE.MathUtils.degToRad(rng.range(0, 10)));
    const tip = lower.topPos.clone().addScaledVector(dir, leaderLen);
    const s = segment(leaderR * 0.3, leaderR, lower.topPos, tip, 6, false);
    if (s) parts.push(s);
    const leaderTrunk = { topY: tip.y, topPos: tip, topR: leaderR * 0.3, height: leaderLen };
    const recs = buildBranches(rng, parts, leaderTrunk, {
      count: 2 + rng.int(0, 1), minAngleDeg: 30, maxAngleDeg: 55,
      lenFrac: 0.5, startFrac: 0.28, baseR: leaderR, subChance: 0.45,
    });
    branchRecords.push(...recs);
  }
  const canopy = buildCanopy(rng, branchRecords, {
    canopyScale: height * 0.19, blobRange: [5, 8], defoliation: rng.range(0.3, 0.5),
  });
  return { trunk: merge(parts), canopy, height, kind: 'splitTrunk' };
}

/** 4. Bare snag -- fully dead, no canopy, but still a two-level branch
 * hierarchy of bare stubs plus a fractured top. Pure silhouette structure. */
export function buildBareSnag(rng) {
  const height = rng.range(3.4, 6.6);
  const baseR = rng.range(0.38, 0.58);
  const trunk = buildTrunk(rng, { height, baseR, segs: 2, bendAmt: 0.32, taperRatio: 0.45, radial: 6 });
  const parts = [...trunk.parts];
  buildFracture(rng, parts, trunk.topPos, trunk.topR, trunk.topY, height);
  // Bare branch stubs -- no canopy, but the hierarchy still has to read: a
  // couple of primaries, each occasionally with a bare secondary stub.
  buildBranches(rng, parts, trunk, {
    count: 2 + rng.int(0, 2), minAngleDeg: 30, maxAngleDeg: 60,
    lenFrac: rng.range(0.22, 0.4), startFrac: 0.25, baseR, subChance: 0.7,
  });
  return { trunk: merge(parts), canopy: null, height, kind: 'bareSnag' };
}

/** 5. Sapling -- small, young, thin -- understory scale variety and a sign
 * new growth is trying (and mostly failing) against the blight. */
export function buildSapling(rng) {
  const height = rng.range(2.0, 3.6);
  const baseR = rng.range(0.09, 0.15);
  const trunk = buildTrunk(rng, { height, baseR, segs: 2, bendAmt: 0.5, taperRatio: 0.4, radial: 6 });
  const parts = [...trunk.parts];
  const branches = buildBranches(rng, parts, trunk, {
    count: 3 + rng.int(0, 1), minAngleDeg: 38, maxAngleDeg: 62,
    lenFrac: 0.42, startFrac: 0.3, baseR, subChance: 0.35,
  });
  const canopy = buildCanopy(rng, branches, {
    canopyScale: height * 0.3, blobRange: [3, 5], defoliation: rng.range(0.1, 0.25),
  });
  return { trunk: merge(parts), canopy, height, kind: 'sapling' };
}

/** name -> builder, in the fixed order Foliage.js instances them (one trunk
 * InstancedMesh + one optional canopy InstancedMesh per archetype). */
export const ARCHETYPES = [
  { name: 'tallGaunt', build: buildTallGaunt, weight: 0.30 },
  { name: 'broadDying', build: buildBroadDying, weight: 0.24 },
  { name: 'splitTrunk', build: buildSplitTrunk, weight: 0.12 },
  { name: 'bareSnag', build: buildBareSnag, weight: 0.16 },
  { name: 'sapling', build: buildSapling, weight: 0.18 },
];

export function pickArchetype(rng) {
  const roll = rng.next();
  let acc = 0;
  for (const a of ARCHETYPES) {
    acc += a.weight;
    if (roll < acc) return a;
  }
  return ARCHETYPES[0];
}
