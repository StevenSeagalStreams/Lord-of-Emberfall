import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Small procedural-geometry kit shared by LevelBuilder and Props.
 *
 * Every "prop" in this game is a handful of primitives merged into one
 * static BufferGeometry, then driven by an InstancedMesh. That is what keeps
 * "a sarcophagus in every boss room" or "a pilaster every 3 cells" from
 * costing a draw call each -- the detail is baked into the geometry once,
 * instancing just stamps it around.
 */

/** Box centred at (cx,cy,cz), optionally yawed, as a standalone geometry. */
export function box(w, h, d, cx = 0, cy = 0, cz = 0, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(cx, cy, cz);
  return g;
}

export function cylinder(rt, rb, h, radial, cx = 0, cy = 0, cz = 0, rotY = 0, rotZ = 0, openEnded = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, radial, 1, openEnded);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(cx, cy, cz);
  return g;
}

export function sphere(r, wSeg, hSeg, cx = 0, cy = 0, cz = 0, squashY = 1) {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  g.scale(1, squashY, 1);
  g.translate(cx, cy, cz);
  return g;
}

const _upAxis = new THREE.Vector3(0, 1, 0);
const _unitScale = new THREE.Vector3(1, 1, 1);

/**
 * A tapered cylinder spanning two explicit world-space points, built by
 * aligning a default Y-axis CylinderGeometry with a quaternion rather than
 * composing Euler rotY/rotZ guesses -- exact for an arbitrary direction, and
 * it means the "tip" used to chain sub-branches/canopy is the same point the
 * mesh actually ends at. Shared by trunk/branch/blade builders (Foliage.js,
 * TreeGen.js) so every stem-like part uses the same math once.
 */
export function segment(rTop, rBottom, from, to, radial = 6, openEnded = true) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 1e-5) return null;
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, radial, 1, openEnded);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(_upAxis, dir.multiplyScalar(1 / len));
  g.applyMatrix4(new THREE.Matrix4().compose(from, q, _unitScale));
  return g;
}

/**
 * A noise-jittered ellipsoid "blob" -- the building block of a broken-canopy
 * mass. Each vertex is pushed in/out along its own radial direction *before*
 * the ellipsoid scale is applied, so the jitter reads as lumpy/torn volume
 * rather than a stretched sphere with a wobbly equator. Cheap on purpose:
 * default 7x5 segments is ~120 triangles, enough facets to look organic at
 * a chunky low-poly budget without threatening the triangle budget when
 * dozens of these are merged per tree.
 */
export function blob(rng, { rx = 1, ry = 1, rz = 1, wSeg = 7, hSeg = 5, cx = 0, cy = 0, cz = 0, jitter = 0.24 } = {}) {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const j = 1 + (rng ? rng.range(-jitter, jitter) : 0);
    v.multiplyScalar(j);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  g.scale(rx, ry, rz);
  g.translate(cx, cy, cz);
  g.computeVertexNormals();
  return g;
}

/** Merge parts into one non-grouped geometry (single material assumed). */
export function merge(parts) {
  return mergeGeometries(parts, false);
}

/**
 * Wall unit: plinth + shaft + cornice, authored directly at `height` so the
 * plinth/cornice proportions stay correct across height tiers instead of
 * being squashed by non-uniform instance scaling.
 */
export function buildWallUnitGeometry({ tile = 2.0, height = 4.6, baseY = -0.6 } = {}) {
  const baseH = Math.max(0.22, height * 0.11);
  const corniceH = Math.max(0.18, height * 0.085);
  const shaftH = Math.max(0.3, height - baseH - corniceH);
  const parts = [
    box(tile * 0.99, baseH, tile * 0.99, 0, baseY + baseH / 2, 0),
    box(tile * 0.88, shaftH, tile * 0.88, 0, baseY + baseH + shaftH / 2, 0),
    box(tile * 0.99, corniceH, tile * 0.99, 0, baseY + baseH + shaftH + corniceH / 2, 0),
  ];
  return merge(parts);
}

/** Engaged pilaster: base + shaft + capital, protruding off one tile face. */
export function buildPilasterGeometry({ tile = 2.0, height = 4.2, baseY = -0.6 } = {}) {
  const w = tile * 0.30, d = 0.30;
  const faceZ = tile * 0.44; // sits just proud of the wall shaft face
  const baseH = height * 0.08, capH = height * 0.09;
  const shaftH = height - baseH - capH;
  const parts = [
    box(w * 1.35, baseH, d * 1.4, 0, baseY + baseH / 2, faceZ),
    box(w, shaftH, d, 0, baseY + baseH + shaftH / 2, faceZ),
    box(w * 1.35, capH, d * 1.4, 0, baseY + baseH + shaftH + capH / 2, faceZ),
  ];
  return merge(parts);
}

/** A simple Gothic-ish archway frame spanning one doorway tile. */
export function buildArchGeometry({ tile = 2.0, height = 4.0, baseY = -0.6, openW = 1.35 } = {}) {
  const postW = (tile - openW) / 2;
  const postH = height * 0.72;
  const parts = [
    box(postW * 0.9, postH, postW * 0.9, -(openW / 2 + postW / 2), baseY + postH / 2, 0),
    box(postW * 0.9, postH, postW * 0.9, (openW / 2 + postW / 2), baseY + postH / 2, 0),
    // lintel
    box(tile * 0.98, height * 0.14, tile * 0.62, 0, baseY + postH + height * 0.07, 0),
    // shallow peaked cap so it reads as an archway, not a door frame
    box(tile * 0.7, height * 0.16, tile * 0.5, 0, baseY + postH + height * 0.14 + height * 0.08, 0, Math.PI / 4),
  ];
  return merge(parts);
}

/** Column: base + fluted-feeling shaft + capital, for hall/boss rows. */
export function buildColumnGeometry({ tile = 2.0, height = 4.6, baseY = -0.6, radius = 0.42 } = {}) {
  const baseH = height * 0.09, capH = height * 0.10;
  const shaftH = height - baseH - capH;
  const parts = [
    box(tile * 0.62, baseH, tile * 0.62, 0, baseY + baseH / 2, 0),
    cylinder(radius * 0.86, radius, shaftH, 10, 0, baseY + baseH + shaftH / 2, 0),
    box(tile * 0.7, capH, tile * 0.7, 0, baseY + baseH + shaftH + capH / 2, 0),
  ];
  return merge(parts);
}

/** A single small rubble chunk cluster (3 overlapping shards). */
export function buildRubbleGeometry(rng) {
  const parts = [];
  const n = 3 + (rng ? rng.int(0, 2) : 1);
  for (let i = 0; i < n; i++) {
    const s = 0.22 + (rng ? rng.range(0, 0.3) : 0.15);
    const x = (rng ? rng.range(-0.35, 0.35) : 0);
    const z = (rng ? rng.range(-0.35, 0.35) : 0);
    const rotY = rng ? rng.range(0, Math.PI * 2) : 0;
    parts.push(box(s * 1.4, s, s * 1.2, x, s * 0.5, z, rotY));
  }
  return merge(parts);
}

/** A toppled or standing broken column drum stack. */
export function buildBrokenColumnGeometry({ radius = 0.4, standingHeight = 1.4 } = {}) {
  const parts = [
    cylinder(radius, radius * 1.05, standingHeight, 10, 0, standingHeight / 2, 0),
    // a fallen drum segment lying beside the stump
    cylinder(radius * 0.98, radius * 0.98, radius * 2.2, 10, radius * 1.9, radius, 0.6, Math.PI / 2),
  ];
  return merge(parts);
}

/** Bone pile: a few crossed "long bones" plus a skull-like sphere. */
export function buildBonePileGeometry(rng) {
  const parts = [];
  const bones = 4 + (rng ? rng.int(0, 2) : 2);
  for (let i = 0; i < bones; i++) {
    const a = (rng ? rng.range(0, Math.PI) : (i / bones) * Math.PI);
    const len = 0.5 + (rng ? rng.range(0, 0.25) : 0.1);
    parts.push(cylinder(0.045, 0.06, len, 5, Math.cos(a) * 0.12, 0.06, Math.sin(a) * 0.12, a));
  }
  parts.push(sphere(0.14, 8, 6, rng ? rng.range(-0.15, 0.15) : 0, 0.12, rng ? rng.range(-0.15, 0.15) : 0.2, 0.85));
  return merge(parts);
}

/** Sarcophagus: tapered base + lid ridge. Boss/treasure centrepiece. */
export function buildSarcophagusGeometry({ w = 1.0, d = 2.0, h = 0.9 } = {}) {
  const parts = [
    box(w, h * 0.78, d, 0, h * 0.39, 0),
    box(w * 0.86, h * 0.22, d * 0.92, 0, h * 0.78 + h * 0.11, 0),
    box(w * 0.2, h * 0.1, d * 0.7, 0, h + h * 0.05, 0),
  ];
  return merge(parts);
}

/** A short hanging chain: alternating links approximated as flattened boxes. */
export function buildChainGeometry({ length = 1.6, links = 7 } = {}) {
  const parts = [];
  const step = length / links;
  for (let i = 0; i < links; i++) {
    const rotY = (i % 2) * (Math.PI / 2);
    parts.push(box(0.09, step * 0.92, 0.16, 0, -i * step - step / 2, 0, rotY));
  }
  return merge(parts);
}

/** Two crossed cobweb planes for a room corner. */
export function buildCobwebGeometry(size = 0.7) {
  const parts = [
    box(size, 0.01, size * 0.02, 0, 0, 0, Math.PI / 4),
    box(size, 0.01, size * 0.02, 0, 0, 0, -Math.PI / 4),
  ];
  return merge(parts);
}

/** BFS reachability over a solid grid (0 = walkable). Used to keep prop
 * placement from ever sealing off a route the collision grid needs. */
export function floodReachable(solid, width, height, startX, startY) {
  const seen = new Uint8Array(width * height);
  const idx = (x, y) => y * width + x;
  if (solid[idx(startX, startY)]) return seen;
  const q = [idx(startX, startY)];
  seen[q[0]] = 1;
  let qi = 0;
  while (qi < q.length) {
    const cur = q[qi++];
    const cx = cur % width, cy = (cur - cx) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (solid[ni] || seen[ni]) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return seen;
}

/**
 * Try to mark cells solid without disconnecting any checkpoint from the
 * anchor. Mutates `solid` in place; returns true if the cells were kept
 * solid, false if they were reverted because they sealed off a checkpoint.
 */
export function trySolidify(solid, width, height, cells, anchor, checkpoints) {
  const idx = (x, y) => y * width + x;
  const prior = cells.map((c) => solid[idx(c.x, c.y)]);
  for (const c of cells) solid[idx(c.x, c.y)] = 1;
  const reach = floodReachable(solid, width, height, anchor.x, anchor.y);
  let ok = true;
  for (const cp of checkpoints) {
    if (!reach[idx(cp.x, cp.y)]) { ok = false; break; }
  }
  if (!ok) {
    cells.forEach((c, i) => { solid[idx(c.x, c.y)] = prior[i]; });
  }
  return ok;
}
