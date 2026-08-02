import * as THREE from 'three';
import { CharacterRig } from '../CharacterRig.js';
import { taperedLimb, mass, finBlade, characterMaterials } from '../GeoKit.js';

/**
 * Fallen-imp swarmer -- the "weak but many" archetype.
 *
 * Everything about the shape argues against the skeleton: short instead of
 * tall, hunched instead of upright, a head/ear silhouette bigger than its own
 * torso instead of a deliberately small one, a wide low stance instead of a
 * narrow upright gait. It should be identifiable as "the fast, cheap one"
 * from a black silhouette alone, at a glance, in the dark.
 *
 * Deliberately depends only on GeoKit.js + CharacterRig.js, not Models.js --
 * Models.js imports this module for `buildMonster()`'s dispatch, so importing
 * back from Models.js here would be a circular import.
 */
export function buildSwarmer(opts = {}) {
  const rig = new CharacterRig({
    height: opts.height ?? 1.02,
    build: opts.build ?? 0.60,
    headScale: opts.headScale ?? 1.55, // oversized head -- the opposite exaggeration from the hero
    archetype: 'swarmer',
  });
  const M = characterMaterials({
    skin: opts.skinColor ?? 0x4d3f2c,
    cloth: 0x241c14,
    leather: 0x2c2018,
    metalDark: 0x35322c,
    accent: 0x8a2a1e,
    ...opts.palette,
  }, opts.seed ?? 31);
  const L = rig.lengths;
  const s = rig.spec;
  const H = s.height;

  rig.attach('pelvis', mass(H * 0.078 * s.build, H * 0.050, H * 0.062), M.skin, { pivot: [0, H * 0.014, 0] });
  // Spine/chest pivots are pulled forward and down -- the hunch is baked
  // straight into the model, not left entirely to the animator.
  rig.attach('spine', mass(H * 0.072 * s.build, H * 0.076, H * 0.062), M.skin, { pivot: [0, H * 0.032, -H * 0.012] });
  rig.attach('chest', mass(H * 0.064 * s.build, H * 0.058, H * 0.054), M.leather, { pivot: [0, H * 0.018, -H * 0.018] });

  // Head: oversized, low-set, jutting forward -- the dominant silhouette read.
  rig.attach('head', mass(H * 0.076 * s.headScale, H * 0.066 * s.headScale, H * 0.072 * s.headScale), M.skin,
    { pivot: [0, H * 0.018 * s.headScale, H * 0.014] });

  // Ears or horns depending on seed, so a pack of swarmers isn't one clone
  // repeated fourteen times.
  const hornMode = (opts.seed ?? 31) % 2 === 0;
  for (const side of [-1, 1]) {
    if (hornMode) {
      rig.attach('head', finBlade(H * 0.055, H * 0.022, { thickness: H * 0.009 }), M.bone,
        { pivot: [side * H * 0.052 * s.headScale, H * 0.052 * s.headScale, 0], rotation: [0.3, side > 0 ? 0.5 : -0.5, side * 0.4] });
    } else {
      rig.attach('head', finBlade(H * 0.095, H * 0.05, { thickness: H * 0.006, tipLift: 0.15 }), M.skin,
        { pivot: [side * H * 0.070 * s.headScale, H * 0.014 * s.headScale, 0], rotation: [0, side > 0 ? -0.25 : 0.25, side * 1.15] });
    }
  }
  // Eyes: tiny, bright, the one saturated note on an otherwise drab body.
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff8010, emissiveIntensity: 1.6, roughness: 0.4 });
  for (const side of [-1, 1]) {
    rig.attach('head', mass(H * 0.013 * s.headScale, H * 0.010 * s.headScale, H * 0.006), eyeMat,
      { pivot: [side * H * 0.028 * s.headScale, H * 0.010 * s.headScale, H * 0.060 * s.headScale] });
  }
  // A ragged jaw/underbite reads as "feral" at a glance.
  rig.attach('head', mass(H * 0.030 * s.headScale, H * 0.016 * s.headScale, H * 0.026 * s.headScale, 10), M.skin,
    { pivot: [0, -H * 0.030 * s.headScale, H * 0.032 * s.headScale] });

  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    rig.attach(`shoulder${S}`, mass(H * 0.030, H * 0.024, H * 0.030, 10), M.leather);
    rig.attach(`upperArm${S}`, taperedLimb(H * 0.023, H * 0.017, L.upperArm, 8), M.skin);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.019, H * 0.014, L.lowerArm, 8), M.skin);
    rig.attach(`hand${S}`, mass(H * 0.021, H * 0.026, H * 0.019, 8), M.skin, { pivot: [0, -H * 0.017, 0] });

    rig.attach(`thigh${S}`, taperedLimb(H * 0.031, H * 0.023, L.thigh, 8), M.leather);
    rig.attach(`shin${S}`, taperedLimb(H * 0.023, H * 0.015, L.shin, 8), M.skin);
    rig.attach(`foot${S}`, mass(H * 0.025, H * 0.014, H * 0.042, 8), M.skin, { pivot: [0, -H * 0.006, L.foot * 0.3] });
  }

  // Crude weapon: a lashed, sharpened bone shiv -- opportunistic, not forged.
  const weapon = buildCrudeWeapon(H, M);
  weapon.position.set(0, -H * 0.02, H * 0.02);
  weapon.rotation.set(-0.3, 0, 0.2);
  rig.bones.handR.add(weapon);
  weapon.traverse((o) => { if (o.isMesh) rig.parts.push(o); });

  // A single ragged loincloth scrap for cheap movement flair -- a static
  // plane is enough at this size; the hero's cloak is where the cloth sim
  // budget goes.
  const rag = M.cloth.clone();
  rag.side = THREE.DoubleSide;
  rig.attach('pelvis', new THREE.PlaneGeometry(H * 0.09, H * 0.13, 2, 3), rag, { pivot: [0, -H * 0.05, H * 0.02] });

  return { rig, materials: M };
}

function buildCrudeWeapon(H, M) {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(taperedLimb(H * 0.012, H * 0.016, H * 0.16, 6), M.leather);
  g.add(handle);
  const head = new THREE.Mesh(mass(H * 0.020, H * 0.052, H * 0.018, 6), M.bone);
  head.position.y = H * 0.13;
  head.rotation.z = 0.3;
  g.add(head);
  return g;
}
