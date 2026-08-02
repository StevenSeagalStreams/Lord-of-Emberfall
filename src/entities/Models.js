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
 * gameplay zoom (camera sits ~34 units back at 34 degrees -- see
 * CameraRig.js); a realistic 8-head figure goes spindly and unreadable from
 * that distance. Playtest F5/F6 pushed this further: the hero must be
 * recognisable as a silhouette alone, the cloak must read as a moving mass,
 * and gear tiers must be visibly, not just numerically, different -- see
 * the gear-tier factories below and `CharacterRig.setWeapon` /
 * `setArmorTier` for the swap seam the items pillar will drive.
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
 * into the anchor bone's local space -- see Cloth.js and Animator._updateCloths).
 * `opts.color`, if given, hard-sets the cloth colour (used for the hero's
 * cloak, which wants a real saturated accent rather than a tinted neutral --
 * see VISION.md's "one saturated accent per scene" and the Diablo 1 palette).
 * `opts.tint` instead multiplies the base cloth colour, for the subtler
 * weathered-scrap look on monster rags. */
function addCloak(rig, anchorBoneName, clothSpec, material, opts = {}) {
  const cloth = new VerletCloth(clothSpec);
  const mat = material.clone();
  mat.side = THREE.DoubleSide;
  if (opts.color !== undefined) mat.color.set(opts.color);
  else if (opts.tint) mat.color.multiply(new THREE.Color(opts.tint));
  if (opts.roughness !== undefined) mat.roughness = opts.roughness;
  const meshObj = new THREE.Mesh(cloth.geometry, mat);
  meshObj.castShadow = true;
  meshObj.receiveShadow = true;
  // The verlet sim rewrites this geometry's position buffer every frame --
  // it must never be swept into CharacterRig.mergeStaticParts()'s bake.
  meshObj.userData.noMerge = true;
  rig.bones[anchorBoneName].add(meshObj);
  rig.parts.push(meshObj);
  rig.cloths.push({
    cloth, anchorBone: anchorBoneName,
    damping: opts.damping, iterations: opts.iterations, dragScale: opts.dragScale,
  });
  return cloth;
}

// ---------------------------------------------------------------------------
// gear tiers -- shared between the weapon and the armor-slot factories
// ---------------------------------------------------------------------------

/** Linear size multiplier per tier: 0 (starting gear) .. 3 (best-in-slot).
 * The jump from tier 0 to tier 3 is deliberately large (>2x) -- the whole
 * point of the seam is that a player can tell a new drop apart from across
 * the room, not just read a tooltip. */
const TIER_SCALE = [0.58, 0.80, 1.0, 1.32];
/** Ornate tiers (2-3) get an accent-metal trim pass; plain tiers (0-1) stay
 * dull leather/iron. A recolour alone is not enough per the playtest note
 * ("so you can tell when you put on a new armor or weapon") -- shape and
 * material both have to change. */
const TIER_ORNATE = [false, false, true, true];

function tierScale(tier) { return TIER_SCALE[THREE.MathUtils.clamp(Math.round(tier ?? 2), 0, 3)]; }
function tierOrnate(tier) { return TIER_ORNATE[THREE.MathUtils.clamp(Math.round(tier ?? 2), 0, 3)]; }

/** Shared, stateless -- safe to reuse across every rig instead of allocating
 * a fresh flat-black material per character. */
const EYE_SLIT_MAT = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });

// ---------------------------------------------------------------------------
// archetypes
// ---------------------------------------------------------------------------

/**
 * Armoured melee hero -- the exaggerated heroic silhouette.
 *
 * `opts.silhouette` is the extensibility seam: every gross-shape multiplier
 * below reads from it rather than a hardcoded constant, so a future
 * buildCaster()/buildRogue() can call the same body-building code with a
 * different silhouette (e.g. `{ pauldronScale: 0.4, cloakScale: 1.3,
 * crestScale: 0.3 }` for a robed caster) and land on a genuinely different
 * shape rather than this warrior recoloured. Today only buildWarrior exists,
 * so every default below IS the warrior's look.
 */
export function buildWarrior(opts = {}) {
  const SIL = {
    pauldronScale: 1, crestScale: 1, gauntletScale: 1, bootScale: 1,
    cloakScale: 1, cloakColor: 0x6b2420,
    ...opts.silhouette,
  };
  const rig = new CharacterRig({
    height: opts.height ?? 1.9,
    build: opts.build ?? 1.30,
    headScale: opts.headScale ?? 0.78, // deliberately small head; broad frame reads huge next to it
    archetype: 'warrior',
  });
  const M = characterMaterials(opts.palette, opts.seed ?? 11);
  const L = rig.lengths;
  const s = rig.spec;
  const H = s.height;
  const PS = SIL.pauldronScale, CS = SIL.crestScale, GS = SIL.gauntletScale, BS = SIL.bootScale;

  // ---- torso: broad tapered V, layered plate over a leather underlayer ----
  rig.attach('pelvis', mass(H * 0.088 * s.build, H * 0.054, H * 0.066), M.leather,
    { pivot: [0, H * 0.016, 0] });
  rig.attach('spine', mass(H * 0.098 * s.build, H * 0.074, H * 0.070), M.metalDark,
    { pivot: [0, H * 0.036, 0] });
  rig.attach('chest', mass(H * 0.126 * s.build, H * 0.092, H * 0.086), M.metal,
    { pivot: [0, H * 0.030, 0] });

  // Curved breastplate shell: a half-lathe (phiLength=PI) so the front reads
  // as a real curved plate, chamfered at the rim to catch rim light.
  const chestProfile = [
    [H * 0.007, -H * 0.080], [H * 0.096 * s.build, -H * 0.056], [H * 0.112 * s.build, -H * 0.008],
    [H * 0.108 * s.build, H * 0.048], [H * 0.080 * s.build, H * 0.086], [H * 0.032, H * 0.100],
  ];
  rig.attach('chest', lathe(chestProfile, 14, -Math.PI / 2, Math.PI), M.metal, { pivot: [0, H * 0.008, 0] });
  rig.attach('chest', plate(H * 0.018, H * 0.12, H * 0.022, 0.007), M.metalDark,
    { pivot: [0, H * 0.034, H * 0.092 * s.build] });
  attachObject(rig, 'chest', rivetRing(M.metalDark, 8, H * 0.054 * s.build, H * 0.05, H * 0.007, H * 0.096 * s.build));

  // Belt + layered fauld lames -- breaks the waist into readable bands.
  rig.attach('pelvis', trimRing(H * 0.080 * s.build, H * 0.032, 0.25, 18), M.accent,
    { pivot: [0, H * 0.050, 0] });
  attachObject(rig, 'pelvis', rivetRing(M.metalDark, 12, H * 0.082 * s.build, H * 0.050, H * 0.007));
  rig.attach('pelvis', tasset(H * 0.098 * s.build, H * 0.13, 0.55), M.metal,
    { pivot: [0, -H * 0.010, H * 0.052] });
  for (const side of [-1, 1]) {
    rig.attach('pelvis', tasset(H * 0.064 * s.build, H * 0.165, 0.4), M.metal,
      { pivot: [side * H * 0.054 * s.build, -H * 0.015, H * 0.028] });
  }

  // Scabbard slung across the back-left hip.
  const scabbard = rig.addBone('scabbard', 'pelvis', -H * 0.058, H * 0.030, -H * 0.020);
  scabbard.rotation.set(0.18, 0.55, -2.35);
  rig.attach('scabbard', lathe([[H * 0.018, 0], [H * 0.025, H * 0.030], [H * 0.017, H * 0.054]], 10), M.metalDark,
    { pivot: [0, H * 0.018, 0] });
  rig.attach('scabbard', taperedLimb(H * 0.028, H * 0.019, H * 0.55, 8), M.leather, { pivot: [0, H * 0.30, 0] });

  // ---- head: small, so the frame around it reads huge -------------------
  rig.attach('head', mass(H * 0.044 * s.headScale, H * 0.052 * s.headScale, H * 0.048 * s.headScale), M.skin,
    { pivot: [0, H * 0.022 * s.headScale, 0] });

  // Helm + shoulders + gauntlets + boots are wired through the tiered
  // armor-slot seam (CharacterRig.defineArmorSlot / setArmorTier) instead of
  // being one-shot `attach()` calls -- this is what lets the items pillar
  // later call `rig.setArmorTier('shoulders', 3)` and get a visibly bigger,
  // ornate pauldron instead of nothing happening. Tier 2 (below) is the
  // "current gear" baseline, i.e. what shipped before this seam existed.

  rig.defineArmorSlot('helm', 'head', (tier) => {
    const t = tierScale(tier) * CS;
    const ornate = tierOrnate(tier);
    const parts = [];
    const helmProfile = [
      [H * 0.007, -H * 0.012], [H * 0.052 * t, 0], [H * 0.064 * t, H * 0.030 * t],
      [H * 0.056 * t, H * 0.062 * t], [H * 0.024 * t, H * 0.080 * t], [0.0005, H * 0.088 * t],
    ];
    const dome = new THREE.Mesh(lathe(helmProfile, 16), ornate ? M.metal : M.metalDark);
    parts.push(dome);
    // Crest: tall enough to break the head's outline entirely, running
    // front-to-back along the skull ridge -- the single biggest legibility
    // fix from the playtest note ("more recognizable").
    const crestLen = H * (ornate ? 0.30 : 0.16) * t;
    const crestH = H * (ornate ? 0.17 : 0.08) * t;
    const crest = new THREE.Mesh(finBlade(crestLen, crestH, { thickness: H * 0.012 }), M.accent);
    crest.position.set(0, H * 0.108 * t, -H * 0.012);
    crest.rotation.y = Math.PI / 2;
    parts.push(crest);
    // Visor plate + dark eye slit so the face reads as hidden, not blank.
    const visor = new THREE.Mesh(extrude([
      [-H * 0.032 * t, -H * 0.013 * t], [H * 0.032 * t, -H * 0.013 * t], [H * 0.035 * t, H * 0.020 * t],
      [0, H * 0.030 * t], [-H * 0.035 * t, H * 0.020 * t],
    ], { depth: H * 0.013 }), M.metalDark);
    visor.position.set(0, H * 0.048 * t, H * 0.054 * t);
    visor.rotation.x = 0.18;
    parts.push(visor);
    const slit = new THREE.Mesh(plate(H * 0.056 * t, H * 0.009, H * 0.007, 0.002), EYE_SLIT_MAT);
    slit.position.set(0, H * 0.054 * t, H * 0.062 * t);
    parts.push(slit);
    return parts;
  });

  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    // Both pauldrons are now genuinely oversized -- the left keeps its
    // hero-flourish extra fin, but "big vs small" reads as "big vs slightly
    // less big" rather than "armoured vs bare", which was disappearing
    // entirely at gameplay zoom.
    const bigger = side < 0;
    rig.defineArmorSlot(`shoulder${S}`, `shoulder${S}`, (tier) => {
      const t = tierScale(tier) * PS * (bigger ? 1.0 : 0.86);
      const ornate = tierOrnate(tier);
      const parts = [];
      const domeMat = ornate ? M.metal : M.metalDark;
      const dome = new THREE.Mesh(lathe([
        [H * 0.016, -H * 0.028], [H * 0.100, 0], [H * 0.110, H * 0.032],
        [H * 0.076, H * 0.068], [0.0005, H * 0.078],
      ], 14), domeMat);
      dome.position.set(side * H * 0.026, H * 0.014, 0);
      dome.scale.set(t, t, t);
      parts.push(dome);
      if (ornate) {
        const fin1 = new THREE.Mesh(finBlade(H * 0.13, H * 0.070, { thickness: H * 0.012 }), M.accent);
        fin1.position.set(side * H * 0.110 * t, H * 0.024 * t, 0);
        fin1.rotation.set(0, Math.PI / 2, side * 0.35);
        fin1.scale.set(t, t, t);
        parts.push(fin1);
        if (bigger) {
          const fin2 = new THREE.Mesh(finBlade(H * 0.095, H * 0.052, { thickness: H * 0.009 }), M.accent);
          fin2.position.set(side * H * 0.084 * t, H * 0.008 * t, H * 0.040 * t);
          fin2.rotation.set(0, Math.PI / 2 + side * 0.5, side * 0.15);
          fin2.scale.set(t, t, t);
          parts.push(fin2);
        }
      }
      return parts;
    });
  }

  rig.aliasArmorGroup('shoulders', ['shoulderL', 'shoulderR']);

  for (const side of [-1, 1]) {
    const S = side < 0 ? 'L' : 'R';
    rig.attach(`upperArm${S}`, taperedLimb(H * 0.040 * s.build, H * 0.032, L.upperArm), M.metalDark);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.032, H * 0.025, L.lowerArm), M.leather);
    rig.attach(`lowerArm${S}`, taperedLimb(H * 0.034, H * 0.030, L.lowerArm * 0.45), M.metal,
      { pivot: [0, -L.lowerArm * 0.5, 0] });

    rig.defineArmorSlot(`gauntlet${S}`, `hand${S}`, (tier) => {
      const t = tierScale(tier) * GS;
      const ornate = tierOrnate(tier);
      const parts = [];
      const fist = new THREE.Mesh(mass(H * 0.033 * t, H * 0.038 * t, H * 0.028 * t), ornate ? M.metal : M.leather);
      fist.position.set(0, -H * 0.020, 0);
      parts.push(fist);
      if (ornate) {
        const cuff = new THREE.Mesh(trimRing(H * 0.028 * t, H * 0.030 * t, 0.3, 10), M.metalDark);
        cuff.position.set(0, H * 0.006, 0);
        parts.push(cuff);
      }
      return parts;
    });

    rig.attach(`thigh${S}`, taperedLimb(H * 0.054 * s.build, H * 0.040, L.thigh), M.cloth);
    rig.attach(`shin${S}`, taperedLimb(H * 0.040, H * 0.030, L.shin), M.leather);
    rig.attach(`shin${S}`, lathe([
      [H * 0.021, 0], [H * 0.040, H * 0.024], [H * 0.035, H * 0.18], [H * 0.024, H * 0.22],
    ], 12), M.metal, { pivot: [0, -L.shin * 0.02, H * 0.004] });

    rig.defineArmorSlot(`boot${S}`, `foot${S}`, (tier) => {
      const t = tierScale(tier) * BS;
      const ornate = tierOrnate(tier);
      const parts = [];
      const boot = new THREE.Mesh(plate(H * 0.052 * t, H * 0.028 * t, L.foot * 1.65, 0.010), ornate ? M.metalDark : M.leather);
      boot.position.set(0, -H * 0.008, L.foot * 0.3);
      parts.push(boot);
      if (ornate) {
        // A short cuff rising off the boot top -- distinct from the shin's
        // own greave (attached to the shin bone above), this is what makes
        // the *boot itself* look upgraded rather than only the foot plate.
        const cuff = new THREE.Mesh(lathe([
          [H * 0.024, 0], [H * 0.040, H * 0.026], [H * 0.032, H * 0.12],
        ], 10), M.metal);
        cuff.position.set(0, H * 0.012, -H * 0.010);
        cuff.scale.set(t, t, t);
        parts.push(cuff);
      }
      return parts;
    });
  }

  rig.aliasArmorGroup('gauntlets', ['gauntletL', 'gauntletR']);
  rig.aliasArmorGroup('boots', ['bootL', 'bootR']);

  // Build the current gear at tier 2 ("shipped" baseline) so the model looks
  // the same on spawn as it did before this seam existed. Any tier 0-3 works
  // here; the items pillar drives this later via rig.setArmorTier(slot, n).
  rig.setArmorTier('helm', opts.helmTier ?? 2);
  rig.setArmorTier('shoulders', opts.shoulderTier ?? 2);
  rig.setArmorTier('gauntlets', opts.gauntletTier ?? 2);
  rig.setArmorTier('boots', opts.bootTier ?? 2);

  // Weapon mount: a dedicated sub-bone off the hand, *not* the hand bone
  // itself, so `setWeapon()` can safely clear "everything on this bone"
  // without also deleting the gauntlet slot above. Only *registered* here --
  // Player.js (combat pillar, not ours to edit) still attaches its starting
  // sword by hand directly to `handR`; the first `rig.setWeapon(...)` call
  // from the items pillar takes over cleanly from there. See the class
  // docblock in CharacterRig.js and this file's report for the exact
  // contract.
  rig.addBone('weaponMount', 'handR', 0, 0, 0);
  rig.defineWeaponSlot('weaponMount', (spec) => buildSword({ ...spec, materials: M }),
    { pivot: [0, -0.06, 0.02], rotation: [-Math.PI * 0.52, 0, 0.12] });

  // ---- cloak: verlet cloth, a real hanging mass with visible sway -------
  // Wider at the hem than the yoke (a trapezoid, not a rectangle) so it
  // reads as cloth catching the air rather than a stiff cardboard flag, and
  // tinted a saturated dried-blood red -- the one warm accent VISION.md asks
  // for -- so it pops as "character" against grey stone even from the
  // top-down-ish gameplay camera, instead of disappearing as another grey
  // lump next to the armour.
  rig.addBone('cloakAnchor', 'chest', 0, H * 0.092, -H * 0.062);
  addCloak(rig, 'cloakAnchor', {
    cols: 9, rows: 12,
    width: H * 0.92 * SIL.cloakScale, hemWidth: H * 1.30 * SIL.cloakScale,
    length: H * 1.02 * SIL.cloakScale,
    curve: H * 0.09, forwardBias: H * 0.05, maxForwardZ: H * 0.10,
  }, M.cloth, { color: SIL.cloakColor, roughness: 0.85, dragScale: 1.05, damping: 0.955, iterations: 4 });

  // Everything above this line was attached with plain `attach()` calls that
  // share material identity within a bone (chest metal x2, pelvis metal x3,
  // shoulder accent fins, ...) -- bake those down to one draw call per
  // (bone, material) pair now that the body is fully built. Armor slots and
  // the cloak opted out on purpose (see their own comments) and are
  // untouched by this.
  rig.mergeStaticParts();

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

  // Same draw-call bake as buildWarrior -- this rig is spawned up to ~56x
  // in a dungeon room, so every merged pair here is a real, multiplied win
  // (see this file's report for the before/after probe numbers).
  rig.mergeStaticParts();

  return { rig, materials: M };
}

/** Simple sword: blade, fuller, guard, grip, pommel.
 *
 * `opts.tier` (0-3) scales *and reshapes* the blade so gear progression is
 * visible at a glance, not just in a tooltip: tier 0 is a short, plain
 * spike with no fuller or accent; tier 3 is a long, wide, gemmed blade
 * roughly double its linear size. The un-tiered default (tier 2, ~20%
 * oversized over "realistic") is what a starting warrior spawns holding.
 */
export function buildSword(opts = {}) {
  const g = new THREE.Group();
  const tier = opts.tier ?? 2;
  const t = tierScale(tier);
  const ornate = tierOrnate(tier);
  const len = opts.length ?? 1.32 * t;
  const M = opts.materials ?? characterMaterials();

  const bladeWidth = 0.076 + 0.052 * t;
  const bladeThick = 0.016 + 0.010 * t;
  const blade = new THREE.BoxGeometry(bladeWidth, len, bladeThick, 1, 8, 1);
  const pos = blade.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const tt = (v.y + len / 2) / len;
    const taper = tt > 0.82 ? 1 - (tt - 0.82) / 0.18 : 1 - tt * 0.18;
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
  // forged steel rather than a flat slab. Plain low-tier blades skip it --
  // an unadorned spike is exactly the "obviously plainer" read tier 0 needs.
  if (ornate) {
    const fuller = new THREE.Mesh(new THREE.BoxGeometry(bladeWidth * 0.22, len * 0.78, bladeThick * 0.4), M.metalDark);
    fuller.position.set(0, len * 0.44, bladeThick * 0.5 + 0.001);
    fuller.castShadow = true;
    g.add(fuller);
  }

  const guardW = 0.28 + 0.18 * t;
  const guard = new THREE.Mesh(plate(guardW, 0.044, 0.062, 0.012), ornate ? M.accent : M.metalDark);
  guard.castShadow = true;
  g.add(guard);

  const grip = new THREE.Mesh(taperedLimb(0.024 + 0.010 * t, 0.028 + 0.010 * t, 0.22 + 0.06 * t, 8), M.leather);
  grip.position.y = 0;
  g.add(grip);

  const pommel = new THREE.Mesh(mass(0.036 + 0.016 * t, 0.036 + 0.016 * t, 0.030 + 0.014 * t, 10), M.metalDark);
  pommel.position.y = -(0.22 + 0.06 * t);
  g.add(pommel);

  if (ornate) {
    // A small gem-like accent orb at the pommel -- the tier-3 "this is
    // obviously a better sword" read, not just a bigger version of tier 0.
    const gem = new THREE.Mesh(mass(0.020 * t, 0.020 * t, 0.020 * t, 8), M.accent);
    gem.position.y = -(0.22 + 0.06 * t);
    gem.castShadow = true;
    g.add(gem);
  }

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
