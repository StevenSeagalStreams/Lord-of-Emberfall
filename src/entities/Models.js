import * as THREE from 'three';
import { CharacterRig } from './CharacterRig.js';
import {
  taperedLimb, mass, plate, lathe, extrude, tasset, finBlade, trimRing,
  rivetRing, characterMaterials,
} from './GeoKit.js';
import { VerletCloth } from './Cloth.js';
import { buildSwarmer } from './monsters/Swarmer.js';

/**
 * Character construction.
 *
 * Bodies are assembled from tapered capsules, beveled plates, lathed shells
 * and extruded plates rather than boxes -- see GeoKit.js for the primitives.
 * Proportions are exaggerated on purpose: this is the WoW silhouette rule.
 * Oversized pauldrons/helm/weapon and a deliberately small head read at
 * gameplay zoom; a realistic 8-head figure goes spindly and unreadable from
 * an isometric camera.
 *
 * `characterMaterials` and the shared geometry primitives now live in
 * GeoKit.js (still owned here) so that the monster builders under
 * monsters/ can use them without a circular import against this file.
 */
export { taperedLimb, mass, plate, lathe, extrude, tasset, finBlade, trimRing, characterMaterials };

/** Attach a pre-built Object3D (groups, InstancedMesh) to a bone and register
 * every mesh inside it for disposal -- `CharacterRig.attach()` only covers the
 * single-geometry case. */
function attachObject(rig, boneName, obj) {
  rig.bones[boneName].add(obj);
  if (obj.isMesh || obj.isInstancedMesh) {
    rig.parts.push(obj);
  } else {
    obj.traverse((o) => { if (o.isMesh || o.isInstancedMesh) rig.parts.push(o); });
  }
  return obj;
}

/** Wires a cloak/tabard cloth panel to an anchor bone and registers it on the
 * rig so Animation.js drives it every frame (gravity + motion drag rotated
 * into the anchor bone's local space -- see Cloth.js and Animator._updateCloths). */
function addCloak(rig, anchorBoneName, clothSpec, material, opts = {}) {
  const cloth = new VerletCloth(clothSpec);
  const mat = material.clone();
  mat.side = THREE.DoubleSide;
  if (opts.tint) mat.color.multiply(new THREE.Color(opts.tint));
  const meshObj = new THREE.Mesh(cloth.geometry, mat);
  meshObj.castShadow = true;
  meshObj.receiveShadow = true;
  rig.bones[anchorBoneName].add(meshObj);
  rig.parts.push(meshObj);
  rig.cloths.push({
    cloth, anchorBone: anchorBoneName,
    damping: opts.damping, iterations: opts.iterations, dragScale: opts.dragScale,
  });
  return cloth;
}

// ---------------------------------------------------------------------------
// archetypes
// ---------------------------------------------------------------------------

/** Armoured melee hero -- the exaggerated heroic silhouette. */
export function buildWarrior(opts = {}) {
  const rig = new CharacterRig({
    height: opts.height ?? 1.9,
    build: opts.build ?? 1.24,
    headScale: opts.headScale ?? 0.84, // deliberately small head; broad frame reads huge next to it
    archetype: 'warrior',
  });
  const M = characterMaterials(opts.palette, opts.seed ?? 11);
  const L = rig.lengths;
  const s = rig.spec;
  const H = s.height;

  // ---- torso: broad tapered V, layered plate over a leather underlayer ----
  rig.attach('pelvis', mass(H * 0.080 * s.build, H * 0.050, H * 0.062), M.leather,
    { pivot: [0, H * 0.016, 0] });
  rig.attach('spine', mass(H * 0.090 * s.build, H * 0.070, H * 0.066), M.metalDark,
    { pivot: [0, H * 0.036, 0] });
  rig.attach('chest', mass(H * 0.116 * s.build, H * 0.086, H * 0.080), M.metal,
    { pivot: [0, H * 0.030, 0] });

  // Curved breastplate shell: a half-lathe (phiLength=PI) so the front reads
  // as a real curved plate, chamfered at the rim to catch rim light.
  const chestProfile = [
    [H * 0.006, -H * 0.078], [H * 0.088 * s.build, -H * 0.055], [H * 0.102 * s.build, -H * 0.008],
    [H * 0.098 * s.build, H * 0.046], [H * 0.072 * s.build, H * 0.082], [H * 0.028, H * 0.096],
  ];
  rig.attach('chest', lathe(chestProfile, 14, -Math.PI / 2, Math.PI), M.metal, { pivot: [0, H * 0.008, 0] });
  rig.attach('chest', plate(H * 0.016, H * 0.11, H * 0.02, 0.007), M.metalDark,
    { pivot: [0, H * 0.032, H * 0.086 * s.build] });
  attachObject(rig, 'chest', rivetRing(M.metalDark, 8, H * 0.05 * s.build, H * 0.05, H * 0.006, H * 0.09 * s.build));

  // Belt + layered fauld lames -- breaks the waist into readable bands.
  rig.attach('pelvis', trimRing(H * 0.074 * s.build, H * 0.030, 0.25, 18), M.accent,
    { pivot: [0, H * 0.048, 0] });
  attachObject(rig, 'pelvis', rivetRing(M.metalDark, 12, H * 0.076 * s.build, H * 0.048, H * 0.006));
  rig.attach('pelvis', tasset(H * 0.090 * s.build, H * 0.12, 0.55), M.metal,
    { pivot: [0, -H * 0.010, H * 0.050] });
  for (const side of [-1, 1]) {
    rig.attach('pelvis', tasset(H * 0.058 * s.build, H * 0.155, 0.4), M.metal,
      { pivot: [side * H * 0.050 * s.build, -H * 0.015, H * 0.026] });
  }

  // Scabbard slung across the back-left hip.
  const scabbard = rig.addBone('scabbard', 'pelvis', -H * 0.058, H * 0.030, -H * 0.020);
  scabbard.rotation.set(0.18, 0.55, -2.35);
  rig.attach('scabbard', lathe([[H * 0.016, 0], [H * 0.022, H * 0.028], [H * 0.015, H * 0.05]], 10), M.metalDark,
    { pivot: [0, H * 0.018, 0] });
  rig.attach('scabbard', taperedLimb(H * 0.026, H * 0.017, H * 0.52, 8), M.leather, { pivot: [0, H * 0.30, 0] });

  // ---- head: small, so the frame around it reads huge -------------------
  rig.attach('head', mass(H * 0.044 * s.headScale, H * 0.052 * s.headScale, H * 0.048 * s.headScale), M.skin,
    { pivot: [0, H * 0.022 * s.headScale, 0] });

  const helmProfile = [
    [H * 0.006, -H * 0.012], [H * 0.050, 0], [H * 0.060, H * 0.028],
    [H * 0.052, H * 0.058], [H * 0.022, H * 0.074], [0.0005, H * 0.080],
  ];
  rig.attach('head', lathe(helmProfile, 16), M.metal, { pivot: [0, H * 0.048, 0] });
  // crest, running front-to-back along the skull ridge
  rig.attach('head', finBlade(H * 0.11, H * 0.052, { thickness: H * 0.010 }), M.accent,
    { pivot: [0, H * 0.098, -H * 0.010], rotation: [0, Math.PI / 2, 0] });
  // visor plate + dark eye slit so the face reads as hidden, not blank
  rig.attach('head', extrude([
    [-H * 0.030, -H * 0.012], [H * 0.030, -H * 0.012], [H * 0.033, H * 0.018], [0, H * 0.028], [-H * 0.033, H * 0.018],
  ], { depth: H * 0.012 }), M.metalDark, { pivot: [0, H * 0.044, H * 0.050], rotation: [0.18, 0, 0] });
  rig.attach('head', plate(H * 0.052, H * 0.008, H * 0.006, 0.002), new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 }),
    { pivot: [0, H * 0.050, H * 0.058] });

  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    const big = side < 0; // asymmetric pauldrons: left is the oversized "hero" shoulder

    if (big) {
      rig.attach(`shoulder${S}`, lathe([
        [H * 0.012, -H * 0.022], [H * 0.072, 0], [H * 0.078, H * 0.024], [H * 0.052, H * 0.050], [0.0005, H * 0.056],
      ], 14), M.metal, { pivot: [side * H * 0.022, H * 0.012, 0] });
      rig.attach(`shoulder${S}`, finBlade(H * 0.10, H * 0.055, { thickness: H * 0.010 }), M.accent,
        { pivot: [side * H * 0.080, H * 0.020, 0], rotation: [0, Math.PI / 2, side * 0.35] });
      rig.attach(`shoulder${S}`, finBlade(H * 0.075, H * 0.042, { thickness: H * 0.008 }), M.accent,
        { pivot: [side * H * 0.062, H * 0.006, H * 0.032], rotation: [0, Math.PI / 2 + side * 0.5, side * 0.15] });
    } else {
      rig.attach(`shoulder${S}`, lathe([
        [H * 0.010, -H * 0.018], [H * 0.050, 0], [H * 0.052, H * 0.018], [H * 0.032, H * 0.032], [0.0005, H * 0.036],
      ], 12), M.metal, { pivot: [side * H * 0.016, H * 0.008, 0] });
    }

    rig.attach(`upperArm${S}`, taperedLimb(H * 0.036 * s.build, H * 0.029, L.upperArm), M.metalDark);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.029, H * 0.023, L.lowerArm), M.leather);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.031, H * 0.027, L.lowerArm * 0.45), M.metal,
      { pivot: [0, -L.lowerArm * 0.5, 0] });
    rig.attach(`hand${S}`, mass(H * 0.027, H * 0.031, H * 0.023), M.leather, { pivot: [0, -H * 0.020, 0] });

    rig.attach(`thigh${S}`, taperedLimb(H * 0.050 * s.build, H * 0.037, L.thigh), M.cloth);
    rig.attach(`shin${S}`, taperedLimb(H * 0.037, H * 0.027, L.shin), M.leather);
    rig.attach(`shin${S}`, lathe([
      [H * 0.019, 0], [H * 0.036, H * 0.022], [H * 0.031, H * 0.16], [H * 0.021, H * 0.20],
    ], 12), M.metal, { pivot: [0, -L.shin * 0.02, H * 0.004] });
    rig.attach(`foot${S}`, plate(H * 0.044 * s.build, H * 0.023, L.foot * 1.5, 0.009), M.metalDark,
      { pivot: [0, -H * 0.008, L.foot * 0.3] });
  }

  // ---- cloak: verlet cloth, oversized so it reads from above ------------
  rig.addBone('cloakAnchor', 'chest', 0, H * 0.088, -H * 0.058);
  addCloak(rig, 'cloakAnchor', {
    cols: 7, rows: 9,
    width: H * 0.68, length: H * 0.72,
    curve: H * 0.05, forwardBias: H * 0.03, maxForwardZ: H * 0.06,
  }, M.cloth, { tint: 0xbfc4cc, dragScale: 0.65 });

  return { rig, materials: M };
}

/** Undead skeleton -- upright, gaunt, rattling; the archetypal early-dungeon
 * enemy. Must read utterly differently from the hunched swarmer. */
export function buildSkeleton(opts = {}) {
  const rig = new CharacterRig({
    height: opts.height ?? 1.78,
    build: opts.build ?? 0.74,
    headScale: opts.headScale ?? 0.92,
    archetype: 'skeleton',
  });
  const M = characterMaterials({ bone: opts.boneColor ?? 0xc9c0a6, ...opts.palette }, opts.seed ?? 21);
  const L = rig.lengths;
  const s = rig.spec;
  const H = s.height;

  // Ribcage as a single instanced ring of tori -- one draw call instead of
  // five, and reads as bone from any angle.
  rig.attach('pelvis', mass(H * 0.062, H * 0.040, H * 0.050), M.bone, { pivot: [0, H * 0.012, 0] });
  {
    const ribGeo = new THREE.TorusGeometry(1, H * 0.006, 6, 14, Math.PI * 1.25);
    const ribCount = 5;
    const ribs = new THREE.InstancedMesh(ribGeo, M.bone, ribCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < ribCount; i++) {
      const t = i / (ribCount - 1);
      const rx = H * (0.070 - t * 0.018);
      dummy.position.set(0, H * (0.020 + t * 0.075), 0);
      dummy.rotation.set(Math.PI / 2, 0, Math.PI * 0.375);
      dummy.scale.set(rx, 1, rx);
      dummy.updateMatrix();
      ribs.setMatrixAt(i, dummy.matrix);
    }
    ribs.instanceMatrix.needsUpdate = true;
    ribs.castShadow = true;
    ribs.receiveShadow = true;
    attachObject(rig, 'spine', ribs);
  }
  rig.attach('spine', taperedLimb(H * 0.014, H * 0.016, L.spine + L.chest), M.bone,
    { pivot: [0, L.spine + L.chest, -H * 0.012] });

  // skull
  rig.attach('head', mass(H * 0.046 * s.headScale, H * 0.050 * s.headScale, H * 0.050 * s.headScale, 16), M.bone,
    { pivot: [0, H * 0.026 * s.headScale, 0] });
  rig.attach('head', mass(H * 0.029 * s.headScale, H * 0.019 * s.headScale, H * 0.021 * s.headScale, 12), M.bone,
    { pivot: [0, H * 0.007 * s.headScale, H * 0.035 * s.headScale] });
  const socket = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });
  for (const side of [-1, 1]) {
    rig.attach('head', mass(H * 0.011, H * 0.012, H * 0.008, 10), socket,
      { pivot: [side * H * 0.018 * s.headScale, H * 0.028 * s.headScale, H * 0.038 * s.headScale] });
  }
  // a dented, rust-scabbed helm fragment -- half the skull is bare bone, half
  // still wears its last battle's armour.
  rig.attach('head', extrude([
    [-H * 0.030, -H * 0.01], [H * 0.006, -H * 0.01], [H * 0.020, H * 0.03], [-H * 0.006, H * 0.05], [-H * 0.032, H * 0.02],
  ], { depth: H * 0.05 }), M.metalDark, { pivot: [-H * 0.006, H * 0.048, -H * 0.006], rotation: [0.1, 0.5, 0.15] });

  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    rig.attach(`shoulder${S}`, mass(H * 0.022, H * 0.016, H * 0.020, 10), M.bone);
    rig.attach(`upperArm${S}`, taperedLimb(H * 0.017, H * 0.013, L.upperArm, 8), M.bone);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.014, H * 0.011, L.lowerArm, 8), M.bone);
    rig.attach(`hand${S}`, mass(H * 0.016, H * 0.020, H * 0.012, 10), M.bone, { pivot: [0, -H * 0.016, 0] });
    rig.attach(`thigh${S}`, taperedLimb(H * 0.022, H * 0.016, L.thigh, 8), M.bone);
    rig.attach(`shin${S}`, taperedLimb(H * 0.017, H * 0.012, L.shin, 8), M.bone);
    rig.attach(`foot${S}`, mass(H * 0.018, H * 0.010, L.foot * 0.9, 10), M.bone, { pivot: [0, -H * 0.006, L.foot * 0.25] });
  }
  // a cracked round-shield fragment, still strapped to the off-hand forearm
  rig.attach('lowerArmL', lathe([[H * 0.001, -H * 0.01], [H * 0.052, 0], [H * 0.001, H * 0.01]], 12, 0, Math.PI * 1.4),
    M.metalDark, { pivot: [-H * 0.02, -L.lowerArm * 0.3, H * 0.01], rotation: [0, 0.3, Math.PI / 2] });

  // Tattered cloak scraps, now real cloth (was a static plane) so it swings
  // and settles with movement instead of reading as a cardboard cutout.
  rig.addBone('ragAnchorL', 'spine', -H * 0.03, L.spine * 0.6, -H * 0.02);
  rig.addBone('ragAnchorR', 'spine', H * 0.026, L.spine * 0.55, -H * 0.02);
  addCloak(rig, 'ragAnchorL', { cols: 3, rows: 6, width: H * 0.10, length: H * 0.30, curve: 0.01 }, M.cloth,
    { tint: 0x8a8578, dragScale: 0.5, damping: 0.94 });
  addCloak(rig, 'ragAnchorR', { cols: 3, rows: 5, width: H * 0.08, length: H * 0.24, curve: -0.01 }, M.cloth,
    { tint: 0x8a8578, dragScale: 0.5, damping: 0.94 });

  return { rig, materials: M };
}

/** Simple sword: blade, fuller, guard, grip, pommel -- ~20% oversized so it
 * breaks the hero's silhouette rather than disappearing next to the armour. */
export function buildSword(opts = {}) {
  const g = new THREE.Group();
  const len = opts.length ?? 1.16;
  const M = opts.materials ?? characterMaterials();

  const blade = new THREE.BoxGeometry(0.088, len, 0.021, 1, 8, 1);
  const pos = blade.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + len / 2) / len;
    const taper = t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1 - t * 0.18;
    v.x *= Math.max(0.05, taper);
    v.z *= Math.max(0.25, taper);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  blade.computeVertexNormals();
  blade.translate(0, len / 2, 0);
  const bladeMesh = new THREE.Mesh(blade, M.metal);
  bladeMesh.castShadow = true;
  g.add(bladeMesh);

  // Fuller: a shallow inset channel down the centre so the blade reads as
  // forged steel rather than a flat slab.
  const fuller = new THREE.Mesh(new THREE.BoxGeometry(0.020, len * 0.78, 0.006), M.metalDark);
  fuller.position.set(0, len * 0.44, 0.009);
  fuller.castShadow = true;
  g.add(fuller);

  const guard = new THREE.Mesh(plate(0.36, 0.042, 0.06, 0.012), M.metalDark);
  guard.castShadow = true;
  g.add(guard);

  const grip = new THREE.Mesh(taperedLimb(0.026, 0.030, 0.24, 8), M.leather);
  grip.position.y = 0;
  g.add(grip);

  const pommel = new THREE.Mesh(mass(0.042, 0.042, 0.036, 10), M.metalDark);
  pommel.position.y = -0.25;
  g.add(pommel);

  return g;
}

// ---------------------------------------------------------------------------
// monster dispatch
// ---------------------------------------------------------------------------

/**
 * Build a monster rig by kind string. Zones spawn entities with a `kind`
 * string (currently `'swarmer'` and `'skeleton'`); unknown kinds fall back to
 * the skeleton build rather than throwing, so a typo or a future zone's new
 * kind degrades gracefully instead of crashing spawn.
 */
export function buildMonster(kind, opts = {}) {
  switch (kind) {
    case 'swarmer': return buildSwarmer(opts);
    case 'skeleton': return buildSkeleton(opts);
    default: return buildSkeleton(opts);
  }
}
