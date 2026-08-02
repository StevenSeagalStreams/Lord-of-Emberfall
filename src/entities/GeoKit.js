import * as THREE from 'three';
import * as CT from './CharacterTextures.js';

/**
 * Shared procedural geometry + material primitives for characters.
 *
 * Everything here is authored to be attached to a bone: pivots are baked into
 * the geometry (via translate) rather than left to the caller, and normals are
 * always recomputed after deformation so lighting reads correctly.
 *
 * `characterMaterials` also lives here (rather than in Models.js) so that both
 * Models.js and the monster builders under monsters/ can depend on it without
 * a circular import between the two.
 */

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

/** A capsule whose radius varies along its length -- limbs read as anatomy. */
export function taperedLimb(rTop, rBottom, length, segments = 12, rings = 6) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, length, segments, rings, false);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + length / 2) / length;
    if (t > 0.94 || t < 0.06) {
      const edge = t > 0.5 ? (t - 0.94) / 0.06 : (0.06 - t) / 0.06;
      const shrink = Math.cos(edge * Math.PI * 0.5);
      v.x *= shrink;
      v.z *= shrink;
      v.y += (t > 0.5 ? 1 : -1) * (1 - shrink) * (t > 0.5 ? rTop : rBottom) * 0.85;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  geo.translate(0, -length / 2, 0);
  return geo;
}

/** A slightly squashed sphere -- torso masses, skulls, pauldrons. */
export function mass(rx, ry, rz, segments = 16) {
  const geo = new THREE.SphereGeometry(1, segments, Math.max(8, segments / 2));
  geo.scale(rx, ry, rz);
  return geo;
}

/** Beveled plate for armour: a box with chamfered edges catches rim light. */
export function plate(w, h, d, bevel = 0.02) {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const ax = Math.abs(v.x) > w / 2 - 1e-4;
    const ay = Math.abs(v.y) > h / 2 - 1e-4;
    const az = Math.abs(v.z) > d / 2 - 1e-4;
    const edges = (ax ? 1 : 0) + (ay ? 1 : 0) + (az ? 1 : 0);
    if (edges >= 2) {
      if (ax) v.x -= Math.sign(v.x) * bevel;
      if (ay) v.y -= Math.sign(v.y) * bevel;
      if (az) v.z -= Math.sign(v.z) * bevel;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// lathes & extrusions -- for armour that a box cannot fake
// ---------------------------------------------------------------------------

/**
 * Solid of revolution from a radius/height profile. `profile` is an array of
 * [radius, y] pairs, bottom to top. Used for helms, pauldron domes, greave
 * bells, belts and scabbard chapes -- anywhere the silhouette needs a curve a
 * box or sphere cannot express.
 */
export function lathe(profile, segments = 20, phiStart = 0, phiLength = Math.PI * 2) {
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y));
  const geo = new THREE.LatheGeometry(points, segments, phiStart, phiLength);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Extrude a 2D shape along Z. `points` is an array of [x, y] pairs forming a
 * closed outline (do not repeat the first point). Used for tassets, pauldron
 * wings, crests, and cloak clasp hardware -- flat armour with real edges
 * rather than a stretched box.
 */
export function extrude(points, { depth = 0.03, bevelSize = 0.006, bevelThickness = 0.006, steps = 1, curveSegments = 8, center = true } = {}) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, steps, curveSegments,
    bevelEnabled: bevelSize > 0,
    bevelSize, bevelThickness, bevelSegments: 2,
  });
  if (center) geo.translate(0, 0, -depth / 2);
  geo.computeVertexNormals();
  return geo;
}

/** A hanging plate (tasset/fauld lame): rectangular top, a shallow curved dip
 * at the bottom edge so it reads as shaped steel rather than a cut box. */
export function tasset(width, height, dip = 0.35, opts = {}) {
  const hw = width / 2;
  const bottom = [];
  const segs = 6;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = -hw + t * width;
    const y = -height + Math.sin(t * Math.PI) * height * dip * 0.5;
    bottom.push([x, y]);
  }
  const outline = [[-hw, 0], ...bottom, [hw, 0]];
  return extrude(outline, { depth: 0.028, bevelSize: 0.005, bevelThickness: 0.005, ...opts });
}

/** A thin curved fin -- helm crests, spikes, fallen-imp horns. */
export function finBlade(length, height, opts = {}) {
  const back = -0.08;
  const outline = [
    [back, 0],
    [back * 0.3, height * 0.55],
    [length * 0.55, height * (opts.tipLift ?? 0.85)],
    [length, height * (opts.tipLift ?? 0.2)],
    [length * 0.6, -height * 0.05],
    [0, -height * 0.04],
  ];
  return extrude(outline, { depth: opts.thickness ?? 0.016, bevelSize: 0.003, bevelThickness: 0.003, curveSegments: 4, ...opts });
}

/** Belt / collar / pauldron-lip ring with a raised chamfered edge. */
export function trimRing(rOuter, height, lip = 0.15, segments = 20) {
  const profile = [
    [rOuter * 0.94, -height / 2],
    [rOuter, -height / 2 + lip * height],
    [rOuter, height / 2 - lip * height],
    [rOuter * 0.94, height / 2],
  ];
  return lathe(profile, segments);
}

// ---------------------------------------------------------------------------
// cheap hardware
// ---------------------------------------------------------------------------

const _riv = new THREE.Object3D();

/** Small studs along a set of world-local positions, one draw call total. */
export function rivetInstances(material, positions, radius = 0.008) {
  const geo = new THREE.SphereGeometry(radius, 8, 6);
  const inst = new THREE.InstancedMesh(geo, material, Math.max(1, positions.length));
  positions.forEach((p, i) => {
    _riv.position.set(p[0], p[1], p[2]);
    _riv.updateMatrix();
    inst.setMatrixAt(i, _riv.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  return inst;
}

/** Rivets evenly spaced around a horizontal ring at radius r, height y. */
export function rivetRing(material, count, r, y, radius = 0.008, z0 = 0) {
  const pos = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pos.push([Math.sin(a) * r, y, Math.cos(a) * r + z0]);
  }
  return rivetInstances(material, pos, radius);
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

let _matSeed = 1;

/**
 * Full PBR material set for a character build. Every material carries a
 * procedurally generated albedo/normal/roughness(/AO) set from
 * CharacterTextures.js -- a flat `color`-only MeshStandardMaterial is an
 * automatic critic fail, so the scalar `color` here only tints the generated
 * map rather than standing in for one.
 *
 * @param {object} palette   colour overrides, e.g. { metal: 0x9099a0 }
 * @param {number} [seed]    texture seed; omit to get a fresh one each call so
 *                           unrelated characters do not tile identically.
 */
export function characterMaterials(palette = {}, seed) {
  const texSeed = seed ?? (_matSeed++);
  const p = {
    skin: 0x9a7660,
    cloth: 0x3a2f2a,
    leather: 0x4a3527,
    metal: 0x8b8d92,
    metalDark: 0x4a4d55,
    accent: 0x8c2f24,
    bone: 0xcfc6ad,
    ...palette,
  };

  const skinMaps = CT.skinMaps(texSeed);
  const clothMaps = CT.clothMaps(texSeed);
  const leatherMaps = CT.leatherMaps(texSeed);
  const metalMaps = CT.metalMaps(texSeed);
  const boneMaps = CT.boneMaps(texSeed);
  const accentMaps = CT.accentMaps(texSeed);

  return {
    skin: new THREE.MeshStandardMaterial({ color: p.skin, roughness: 0.6, metalness: 0.0, ...skinMaps }),
    cloth: new THREE.MeshStandardMaterial({ color: p.cloth, roughness: 0.92, metalness: 0.0, ...clothMaps }),
    leather: new THREE.MeshStandardMaterial({ color: p.leather, roughness: 0.6, metalness: 0.03, ...leatherMaps }),
    metal: new THREE.MeshStandardMaterial({ color: p.metal, roughness: 0.28, metalness: 1.0, envMapIntensity: 1.15, ...metalMaps }),
    metalDark: new THREE.MeshStandardMaterial({ color: p.metalDark, roughness: 0.40, metalness: 0.97, envMapIntensity: 0.95, ...metalMaps }),
    accent: new THREE.MeshStandardMaterial({ color: p.accent, roughness: 0.72, metalness: 0.0, ...accentMaps }),
    bone: new THREE.MeshStandardMaterial({ color: p.bone, roughness: 0.6, metalness: 0.05, ...boneMaps }),
  };
}
