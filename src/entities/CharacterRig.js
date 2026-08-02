import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural humanoid rig.
 *
 * A hierarchy of bone Objects with primitive geometry parented to them. At an
 * ARPG camera distance the difference between this and a skinned mesh is
 * mostly at the shoulder and hip creases, and this buys us fully procedural
 * animation: every pose is computed, so we can blend hit reactions, aim
 * offsets and gait speed continuously instead of crossfading fixed clips.
 *
 * Proportions follow an 7.5-head heroic figure, which is what the Diablo
 * character art uses -- slightly squat, heavy shoulders, small head. A
 * realistic 8-head figure reads as spindly from above.
 */

export const BONES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'lowerArmL', 'handL',
  'shoulderR', 'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
];

export class CharacterRig {
  /**
   * @param {object} spec
   * @param {number} spec.height   total height in world units
   * @param {number} spec.build    0.7 lean .. 1.5 hulking
   */
  constructor(spec = {}) {
    this.spec = {
      height: spec.height ?? 1.85,
      build: spec.build ?? 1.0,
      headScale: spec.headScale ?? 1.0,
      armLength: spec.armLength ?? 1.0,
      legLength: spec.legLength ?? 1.0,
      ...spec,
    };

    this.root = new THREE.Group();
    this.root.name = 'CharacterRig';
    this.bones = {};
    this.parts = [];
    /** @type {{cloth: import('./Cloth.js').VerletCloth, anchorBone: string}[]} */
    this.cloths = [];

    this._buildSkeleton();

    // Rest pose is captured so animation can express everything as an offset
    // from rest, which makes additive blending trivial.
    this.restPose = {};
    for (const [name, bone] of Object.entries(this.bones)) {
      this.restPose[name] = {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
      };
    }
  }

  _buildSkeleton() {
    const s = this.spec;
    const H = s.height;
    // Segment lengths as fractions of total height (heroic proportions).
    const L = {
      pelvisY: H * 0.50,
      spine: H * 0.11,
      chest: H * 0.11,
      neck: H * 0.04,
      head: H * 0.12 * s.headScale,
      shoulderX: H * 0.115 * s.build,
      upperArm: H * 0.155 * s.armLength,
      lowerArm: H * 0.145 * s.armLength,
      hand: H * 0.055,
      hipX: H * 0.058 * s.build,
      thigh: H * 0.235 * s.legLength,
      shin: H * 0.225 * s.legLength,
      foot: H * 0.075,
    };
    this.lengths = L;

    const bone = (name, parent, x = 0, y = 0, z = 0) => {
      const b = new THREE.Group();
      b.name = name;
      b.position.set(x, y, z);
      (parent || this.root).add(b);
      this.bones[name] = b;
      return b;
    };

    bone('root', null, 0, 0, 0);
    bone('pelvis', this.bones.root, 0, L.pelvisY, 0);
    bone('spine', this.bones.pelvis, 0, L.spine, 0);
    bone('chest', this.bones.spine, 0, L.chest, 0);
    bone('neck', this.bones.chest, 0, L.neck, 0);
    bone('head', this.bones.neck, 0, L.head * 0.35, 0);

    for (const side of [-1, 1]) {
      const S = side < 0 ? 'L' : 'R';
      bone(`shoulder${S}`, this.bones.chest, L.shoulderX * side, L.neck * 0.5, 0);
      bone(`upperArm${S}`, this.bones[`shoulder${S}`], 0, 0, 0);
      bone(`lowerArm${S}`, this.bones[`upperArm${S}`], 0, -L.upperArm, 0);
      bone(`hand${S}`, this.bones[`lowerArm${S}`], 0, -L.lowerArm, 0);

      bone(`thigh${S}`, this.bones.pelvis, L.hipX * side, 0, 0);
      bone(`shin${S}`, this.bones[`thigh${S}`], 0, -L.thigh, 0);
      bone(`foot${S}`, this.bones[`shin${S}`], 0, -L.shin, 0);
    }
  }

  /**
   * Add an extra bone beyond the base humanoid set (cloak anchors, jaw,
   * clavicles, tails, horns...). Safe to call any time after construction --
   * the rest pose is captured immediately so `resetPose`/`setRot` work on it
   * exactly like a base-skeleton bone.
   */
  addBone(name, parentName, x = 0, y = 0, z = 0) {
    const b = new THREE.Group();
    b.name = name;
    b.position.set(x, y, z);
    (this.bones[parentName] || this.root).add(b);
    this.bones[name] = b;
    this.restPose[name] = { position: b.position.clone(), quaternion: b.quaternion.clone() };
    return b;
  }

  /**
   * World-space quaternion of a bone, safe to call at any point in the frame
   * (forces the matrix chain up to date rather than trusting the renderer to
   * have refreshed it already). Used to rotate global forces -- gravity,
   * wind, movement drag -- into a bone's local frame for cloth simulation.
   */
  getWorldQuaternion(boneName, target = new THREE.Quaternion()) {
    const b = this.bones[boneName];
    if (!b) return target.identity();
    b.updateWorldMatrix(true, false);
    return b.getWorldQuaternion(target);
  }

  /**
   * Attach a mesh to a bone. Geometry is expected to be authored around the
   * origin; `pivot` shifts it so it hangs from the joint correctly.
   */
  attach(boneName, geometry, material, { pivot = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0] } = {}) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...pivot);
    mesh.scale.set(...scale);
    mesh.rotation.set(...rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.bones[boneName].add(mesh);
    this.parts.push(mesh);
    return mesh;
  }

  resetPose() {
    for (const [name, rest] of Object.entries(this.restPose)) {
      this.bones[name].position.copy(rest.position);
      this.bones[name].quaternion.copy(rest.quaternion);
    }
  }

  /** Euler rotation applied on top of the rest pose. */
  setRot(name, x, y, z) {
    const b = this.bones[name];
    if (!b) return;
    b.quaternion.copy(this.restPose[name].quaternion);
    _q.setFromEuler(_e.set(x, y, z));
    b.quaternion.multiply(_q);
  }

  /** Additive blend toward an euler offset, weight in [0,1]. */
  addRot(name, x, y, z, weight = 1) {
    const b = this.bones[name];
    if (!b) return;
    _q.setFromEuler(_e.set(x * weight, y * weight, z * weight));
    b.quaternion.multiply(_q);
  }

  offsetPos(name, x, y, z) {
    const b = this.bones[name];
    if (!b) return;
    b.position.copy(this.restPose[name].position).add(_v.set(x, y, z));
  }

  /**
   * Two-bone analytic IK. Used for foot planting on uneven floors and for
   * making both hands converge on a two-handed weapon grip.
   */
  solveIK(upperName, lowerName, endName, targetLocal, poleAngle = 0) {
    const upper = this.bones[upperName];
    const lower = this.bones[lowerName];
    const l1 = Math.abs(lower.position.y) || 0.001;
    const l2 = Math.abs(this.bones[endName].position.y) || 0.001;

    const dist = THREE.MathUtils.clamp(targetLocal.length(), 0.001, (l1 + l2) * 0.999);

    // Law of cosines for the two interior angles.
    const cosA = THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
    const cosB = THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - dist * dist) / (2 * l1 * l2), -1, 1);
    const a = Math.acos(cosA);
    const b = Math.acos(cosB);

    _v.copy(targetLocal).normalize();
    // Bone chains hang along -Y, so build the rotation that maps -Y onto the
    // target direction, then rotate back by `a` to open the joint.
    _q.setFromUnitVectors(_down, _v);
    upper.quaternion.copy(_q);
    upper.rotateX(-a);
    if (poleAngle) upper.rotateY(poleAngle);
    lower.quaternion.setFromEuler(_e.set(Math.PI - b, 0, 0));
  }

  // -------------------------------------------------------------------
  // draw-call hygiene: merge static per-bone parts into fewer meshes
  // -------------------------------------------------------------------
  //
  // Every character rig is ~15-25 separate Mesh objects parented to bones,
  // and every one of those is its own draw call -- with 56 monsters on
  // screen that is the overwhelming majority of the frame's draws (see
  // VISION.md "Open findings"). Parts that never move independently of the
  // bone they're attached to (the normal case for `attach()`) are safe to
  // bake into a single geometry *per bone, per material identity* -- two
  // meshes on the same bone sharing the same Material object always move
  // together and always look the same, so collapsing them costs nothing.
  //
  // This is deliberately bone-scoped, not rig-wide: sibling bones (e.g.
  // 'chest' and 'pelvis') rotate independently of each other during
  // animation, so merging across them would freeze that relative motion.

  /**
   * Merge a flat list of Mesh objects into as few draw calls as possible by
   * combining geometry within each distinct **material identity** (`===`,
   * not colour equality -- reuse the same `characterMaterials()` entry
   * across parts to benefit). Meshes that cannot be merged (InstancedMesh,
   * non-indexed geometry, or the lone member of a material group) pass
   * through unchanged. Geometries that get folded into a combo mesh are
   * disposed; the original Mesh objects that pass through untouched are
   * not. Returns the replacement list -- same visual result, fewer draws.
   */
  static mergeByMaterial(meshes) {
    const eligible = [];
    const passthrough = [];
    for (const m of meshes) {
      if (m && m.isMesh && !m.isInstancedMesh && m.geometry?.index) eligible.push(m);
      else if (m) passthrough.push(m);
    }
    const byMat = new Map();
    for (const mesh of eligible) {
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat).push(mesh);
    }
    const out = [...passthrough];
    for (const [mat, group] of byMat) {
      if (group.length === 1) { out.push(group[0]); continue; }
      // Bake each mesh's local (bone-relative) transform into its geometry
      // before merging -- matrix is not auto-updated until the first render,
      // and we are doing this synchronously at construction time.
      const geos = group.map((m) => {
        m.updateMatrix();
        const g = m.geometry.clone();
        g.applyMatrix4(m.matrix);
        return g;
      });
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) { out.push(...group); continue; } // mismatched attributes -- bail safely
      for (const m of group) m.geometry.dispose();
      const combo = new THREE.Mesh(merged, mat);
      combo.castShadow = true;
      combo.receiveShadow = true;
      out.push(combo);
    }
    return out;
  }

  /**
   * Walk every bone and collapse its direct Mesh children (as attached via
   * `attach()`) per the rule above. Call once, after all `attach()` calls
   * for a build are done. Cloth panels and anything tagged
   * `userData.noMerge` (the cloak/rag meshes -- their geometry is rewritten
   * every frame by the verlet sim and must stay a standalone BufferGeometry)
   * and InstancedMesh hardware (rivets, ribs -- already one draw call each)
   * are left alone.
   */
  mergeStaticParts() {
    for (const boneName of Object.keys(this.bones)) {
      const bone = this.bones[boneName];
      const meshChildren = bone.children.filter((c) => c.isMesh && !c.isInstancedMesh && !c.userData?.noMerge);
      if (meshChildren.length < 2) continue;
      const merged = CharacterRig.mergeByMaterial(meshChildren);
      if (merged.length >= meshChildren.length) continue; // nothing collapsed
      for (const c of meshChildren) bone.remove(c);
      for (const c of merged) bone.add(c);
      this.parts = this.parts.filter((p) => !meshChildren.includes(p)).concat(merged);
    }
  }

  // -------------------------------------------------------------------
  // gear seam: weapon + armor tier swapping
  // -------------------------------------------------------------------
  //
  // Registered by the archetype builder (buildWarrior today; a future
  // buildCaster/buildRogue or a monster builder tomorrow) at construction
  // time, so CharacterRig itself stays agnostic of what a "sword" or
  // "pauldron" is -- it only knows how to mount, swap and dispose gear on a
  // bone. See Models.js `buildWarrior` for the reference wiring.
  //
  // Public API for callers outside this pillar (the items pillar):
  //   rig.setWeapon(spec)          -- spec = { tier?: 0-3, ...factory opts }
  //   rig.setArmorTier(slot, tier) -- slot: 'helm' | 'shoulders' | 'gauntlets' | 'boots'
  // Both are safe no-ops if the rig never registered that slot (e.g. a
  // monster with no boots).

  /** Register where a held weapon mounts (bone + local pivot/scale/rotation)
   * and the factory that turns a weapon spec into an Object3D. `factory`
   * should build fresh geometry on every call (no shared mutable state). */
  defineWeaponSlot(boneName, factory, mount = {}) {
    this._weaponSlot = { boneName, factory, mount };
  }

  /**
   * Swap the held weapon. `spec` (e.g. `{ tier: 3 }`) is forwarded verbatim
   * to the factory registered via `defineWeaponSlot`; pass `spec.object3D`
   * instead to mount a pre-built Object3D directly, bypassing the factory.
   * Clears *everything* currently mounted on the weapon bone first -- not
   * just a weapon this method itself placed -- so the first call cleanly
   * takes over even from gear attached by hand before the seam existed.
   * No-op (returns null) if no slot/factory is registered yet.
   */
  setWeapon(spec = {}) {
    const slot = this._weaponSlot;
    if (!slot || !slot.factory) return null;
    const bone = this.bones[slot.boneName];
    if (!bone) return null;
    for (const child of [...bone.children]) {
      bone.remove(child);
      child.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    }
    const obj = spec.object3D || slot.factory(spec);
    if (!obj) return null;
    const m = { ...slot.mount, ...(spec.mount || {}) };
    obj.position.set(...(m.pivot || [0, 0, 0]));
    obj.scale.set(...(m.scale || [1, 1, 1]));
    obj.rotation.set(...(m.rotation || [0, 0, 0]));
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    bone.add(obj);
    this._weaponObj = obj;
    this.weaponTier = spec.tier ?? this.weaponTier ?? 2;
    return obj;
  }

  /** Register an armor slot: a bone + `factory(tier) -> Object3D |
   * Object3D[]` that builds that slot's geometry for tier 0 (plain) .. 3
   * (best-in-slot). */
  defineArmorSlot(name, boneName, factory, mount = {}) {
    this._armorSlots = this._armorSlots || {};
    this._armorSlots[name] = { boneName, factory, mount, group: null, tier: null };
  }

  /** Alias a set of slot names under one group name, e.g.
   * `aliasArmorGroup('shoulders', ['shoulderL', 'shoulderR'])` so a single
   * `setArmorTier('shoulders', tier)` call fans out to both pauldrons. */
  aliasArmorGroup(groupName, slotNames) {
    this._armorGroups = this._armorGroups || {};
    this._armorGroups[groupName] = slotNames;
  }

  /**
   * Swap a slot (or an aliased group of slots, e.g. `'shoulders'`) to a new
   * tier 0..3, disposing the outgoing geometry. Internally bakes the new
   * tier's parts down with `mergeByMaterial` too, so swapping gear never
   * costs more draw calls than the slot's distinct material count. No-op
   * (returns null) on an unregistered name -- safe to call speculatively.
   */
  setArmorTier(name, tier) {
    if (this._armorGroups && this._armorGroups[name]) {
      return this._armorGroups[name].map((n) => this._setArmorSlotTier(n, tier));
    }
    return this._setArmorSlotTier(name, tier);
  }

  _setArmorSlotTier(name, tier) {
    const slot = this._armorSlots && this._armorSlots[name];
    if (!slot || !slot.factory) return null;
    const bone = this.bones[slot.boneName];
    if (!bone) return null;
    if (slot.group) {
      bone.remove(slot.group);
      slot.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    }
    const built = slot.factory(tier);
    const parts = (Array.isArray(built) ? built : [built]).filter(Boolean);
    const merged = CharacterRig.mergeByMaterial(parts);
    const group = new THREE.Group();
    group.name = `armor:${name}`;
    for (const p of merged) { p.castShadow = true; p.receiveShadow = true; group.add(p); }
    group.position.set(...(slot.mount.pivot || [0, 0, 0]));
    group.scale.set(...(slot.mount.scale || [1, 1, 1]));
    group.rotation.set(...(slot.mount.rotation || [0, 0, 0]));
    bone.add(group);
    slot.group = group;
    slot.tier = tier;
    return group;
  }

  dispose() {
    for (const m of this.parts) {
      m.geometry?.dispose?.();
    }
    for (const c of this.cloths) {
      c.cloth?.dispose?.();
    }
    if (this._weaponSlot) {
      const bone = this.bones[this._weaponSlot.boneName];
      bone?.children.forEach((c) => c.traverse?.((o) => { if (o.isMesh) o.geometry?.dispose?.(); }));
    }
    if (this._armorSlots) {
      for (const slot of Object.values(this._armorSlots)) {
        slot.group?.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
      }
    }
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
