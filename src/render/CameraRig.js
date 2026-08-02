import * as THREE from 'three';

function hash1(n) {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
}
function noise1D(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i);
  const b = hash1(i + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/**
 * Fixed-angle ARPG camera.
 *
 * Diablo II is a 2:1 dimetric projection (26.57 deg elevation, 45 deg yaw).
 * A literal 26.57 deg in 3D foreshortens floors so hard that geometry reads as
 * mush, so we sit at ~34 deg -- the angle D2:R settled on -- and use a narrow
 * FOV at long distance. The narrow FOV keeps verticals nearly parallel (the
 * orthographic "board game" feel of the originals) while retaining just enough
 * perspective divergence to sell depth on tall props and pillars.
 *
 * The FOV is opened up slightly from the original dungeon tuning (26 -> 29):
 * a corridor doesn't need to show sky, but an outdoor zone reads as a diorama
 * seen through a straw at 26 -- there is nowhere for the sky dome or the
 * canopy god rays to exist. 29 is still narrow enough to keep the dimetric,
 * near-orthographic feel indoors. `maxDistance` is opened similarly (52 -> 66)
 * so an outdoor establishing shot has room to pull back far enough to read
 * treelines as silhouette masses.
 */
export class CameraRig {
  constructor(opts = {}) {
    this.elevation = THREE.MathUtils.degToRad(opts.elevation ?? 34);
    this.azimuth = THREE.MathUtils.degToRad(opts.azimuth ?? 45);
    this.distance = opts.distance ?? 34;
    this.minDistance = opts.minDistance ?? 20;
    this.maxDistance = opts.maxDistance ?? 66;

    this.camera = new THREE.PerspectiveCamera(29, innerWidth / innerHeight, 1, 400);
    this.camera.name = 'MainCamera';

    this.target = new THREE.Vector3();      // where we want to look
    this.smoothed = new THREE.Vector3();    // damped look-at
    this.velocity = new THREE.Vector3();    // spring velocity for the damper

    // Trauma-driven screen shake: trauma decays linearly, offset scales with
    // trauma^2 so small hits are subtle and big hits are violent. Built from
    // value noise (not a sum-of-sines) so it never settles into a visible
    // repeating pattern on a sustained shake (e.g. a boss channel).
    this.trauma = 0;
    this.traumaDecay = 1.6;
    this.shakeAmplitude = 0.55;
    this.shakeRollAmplitude = opts.shakeRollAmplitude ?? 0.05; // radians, dutch-angle kick
    this._shakeTime = 0;
    this._shakeOffset = new THREE.Vector3();
    this._shakeRoll = 0;

    // Hit-stop: a brief full freeze of the camera's own motion so an impact
    // reads as a held beat rather than the spring smoothing straight through
    // it. Combat/skills call `rig.hitStop(seconds)` on crits/heavy hits,
    // typically alongside `addTrauma` so the shake lands the instant motion
    // resumes.
    this._hitStopTimer = 0;

    // Look-ahead biases the camera toward the cursor, the way ARPGs let you
    // peek down the corridor you are about to fight in.
    this.lookAhead = new THREE.Vector3();
    this.lookAheadStrength = opts.lookAheadStrength ?? 0.22;
    this.lookAheadMax = opts.lookAheadMax ?? 5.0;

    this.stiffness = opts.stiffness ?? 9.0;

    this._offset = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this.updateOffset();
    this.camera.position.copy(this._offset);
    this.camera.lookAt(0, 0, 0);
  }

  updateOffset() {
    const h = Math.sin(this.elevation) * this.distance;
    const r = Math.cos(this.elevation) * this.distance;
    this._offset.set(Math.cos(this.azimuth) * r, h, Math.sin(this.azimuth) * r);
  }

  /** Screen-space directions on the ground plane, for WASD-style movement. */
  groundBasis(outForward, outRight) {
    outForward.set(-Math.cos(this.azimuth), 0, -Math.sin(this.azimuth)).normalize();
    outRight.set(outForward.z, 0, -outForward.x).normalize();
  }

  zoom(delta) {
    this.distance = THREE.MathUtils.clamp(
      this.distance + delta * 2.5, this.minDistance, this.maxDistance
    );
    this.updateOffset();
  }

  /** trauma in [0,1]; additive, clamped. */
  addTrauma(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Freeze camera motion for `seconds` -- an impact reads as a held beat
   *  rather than the spring smoothing straight through it. Extends rather
   *  than restarts, so overlapping hits don't cut a stop short. */
  hitStop(seconds = 0.05) {
    this._hitStopTimer = Math.max(this._hitStopTimer, seconds);
  }

  setTarget(v) { this.target.copy(v); }
  snapTo(v) { this.target.copy(v); this.smoothed.copy(v); this.velocity.set(0, 0, 0); }

  /** @param cursor optional world-space ground point under the pointer */
  update(dt, cursor = null) {
    if (this._hitStopTimer > 0) {
      this._hitStopTimer -= dt;
      // Hold last frame's pose exactly -- matrixWorld is already current, so
      // there is nothing else to do this frame.
      return;
    }

    // Critically-damped spring toward the target: no overshoot, frame-rate
    // independent, and it never "swims" when the player stands still.
    const k = this.stiffness;
    const damp = 2 * Math.sqrt(k);
    this._tmp.copy(this.target).sub(this.smoothed).multiplyScalar(k);
    this._tmp.addScaledVector(this.velocity, -damp);
    this.velocity.addScaledVector(this._tmp, dt);
    this.smoothed.addScaledVector(this.velocity, dt);

    if (cursor) {
      this._tmp.copy(cursor).sub(this.target).multiplyScalar(this.lookAheadStrength);
      this._tmp.y = 0;
      if (this._tmp.length() > this.lookAheadMax) this._tmp.setLength(this.lookAheadMax);
      this.lookAhead.lerp(this._tmp, 1 - Math.exp(-4 * dt));
    } else {
      this.lookAhead.multiplyScalar(Math.exp(-4 * dt));
    }

    // shake: 3-axis value noise (aperiodic, unlike a sum-of-sines) plus a
    // small roll around the view axis for a dutch-angle "kick" on big hits.
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    const shake = this.trauma * this.trauma;
    if (shake > 0.0001) {
      this._shakeTime += dt * 30;
      const t = this._shakeTime;
      const nx = noise1D(t + 0.0) * 2 - 1;
      const ny = noise1D(t + 50.0) * 2 - 1;
      const nz = noise1D(t + 130.0) * 2 - 1;
      const nr = noise1D(t * 0.8 + 200.0) * 2 - 1;
      this._shakeOffset.set(nx, ny * 0.6, nz).multiplyScalar(shake * this.shakeAmplitude);
      this._shakeRoll = nr * shake * this.shakeRollAmplitude;
    } else {
      this._shakeOffset.set(0, 0, 0);
      this._shakeRoll = 0;
    }

    const look = this._tmp.copy(this.smoothed).add(this.lookAhead);
    this.camera.position.copy(look).add(this._offset).add(this._shakeOffset);
    this.camera.lookAt(look.x + this._shakeOffset.x * 0.4, look.y, look.z + this._shakeOffset.z * 0.4);
    if (this._shakeRoll !== 0) this.camera.rotateZ(this._shakeRoll);
    this.camera.updateMatrixWorld();
  }
}
