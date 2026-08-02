import * as THREE from 'three';

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

  dispose() {
    for (const m of this.parts) {
      m.geometry?.dispose?.();
    }
    for (const c of this.cloths) {
      c.cloth?.dispose?.();
    }
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
