import * as THREE from 'three';

/**
 * Procedural animator.
 *
 * No clips. Every pose is a function of (phase, speed, state), so gait scales
 * continuously with movement speed, and one-shot actions (attack, hit, death)
 * are layered on top of locomotion rather than replacing it. That layering is
 * why a character can stagger mid-stride here instead of snapping to a
 * separate hit animation the way clip-based ARPGs of the era had to.
 *
 * Posture (hunch, stance width, gait "voice") is driven by `rig.spec.archetype`
 * rather than by the caller's opts. That matters because the entities that
 * construct an Animator (Player.js / Monster.js) pass the *same* handful of
 * numeric knobs (strideLength/bounce/weight/idleSway) to every monster kind --
 * archetype-level character has to come from somewhere those callers do not
 * touch, or a skeleton and a swarmer would move identically.
 */

const ARCHETYPE_DEFAULTS = {
  heroic:   { strideLength: 1.25, bounce: 1.00, weight: 1.25, idleSway: 1.00, hunch: 0.00, stance: 1.00, gaitStyle: 'heroic' },
  warrior:  { strideLength: 1.25, bounce: 1.00, weight: 1.25, idleSway: 1.00, hunch: 0.00, stance: 1.00, gaitStyle: 'heroic' },
  skeleton: { strideLength: 1.05, bounce: 0.70, weight: 0.55, idleSway: 0.35, hunch: -0.10, stance: 0.90, gaitStyle: 'undead' },
  swarmer:  { strideLength: 1.65, bounce: 1.70, weight: 0.30, idleSway: 1.45, hunch: 0.62, stance: 1.65, gaitStyle: 'scuttle' },
};

export class Animator {
  constructor(rig, opts = {}) {
    this.rig = rig;
    const archetype = rig?.spec?.archetype;
    const defaults = ARCHETYPE_DEFAULTS[archetype] || ARCHETYPE_DEFAULTS.heroic;
    const merged = { ...defaults, ...opts };

    this.phase = Math.random() * Math.PI * 2;
    this.speed = 0;             // world units/sec, set by the entity
    this.strideLength = merged.strideLength ?? 1.35;
    this.bounce = merged.bounce ?? 1.0;
    this.weight = merged.weight ?? 1.0;     // heavier = slower, lower arcs
    this.idleSway = merged.idleSway ?? 1.0;

    // Posture/character knobs -- deliberately taken from the archetype only
    // (never from caller opts) so every kind reads distinctly even when the
    // entity that spawned it only ever passes the four knobs above.
    this.hunch = defaults.hunch ?? 0;
    this.stance = defaults.stance ?? 1;
    this.gaitStyle = defaults.gaitStyle ?? 'heroic';

    this.time = 0;
    this.facing = 0;

    /** @type {{name:string,t:number,dur:number,onEvent?:Function,fired:Set}|null} */
    this.action = null;
    this.actionBlend = 0;

    this.dead = false;
    this.deathTime = 0;
    this.deathSeed = null;

    this.hitFlash = 0;
    this.hitDir = new THREE.Vector3();

    // Foot-plant IK state: per-leg world anchor captured at touchdown so the
    // sole holds still on the ground instead of sliding as the FK leg swing
    // and the entity's own translation disagree.
    this._feet = {
      L: { anchor: new THREE.Vector3(), planted: false },
      R: { anchor: new THREE.Vector3(), planted: false },
    };

    // Head-lag secondary motion: the head's actual quaternion trails whatever
    // the pose/action/hit layers computed this frame.
    this._headActual = new THREE.Quaternion();
    this._headActualInit = false;

    // Per-instance phase offset so a pack of the same monster kind doesn't
    // sway/breathe/billow in unison.
    this._windSeed = Math.random() * 20;
  }

  play(name, duration, opts = {}) {
    this.action = {
      name,
      t: 0,
      dur: duration,
      events: opts.events || [],
      fired: new Set(),
      onEvent: opts.onEvent,
      data: opts.data || {},
    };
    return this.action;
  }

  cancel() { this.action = null; }
  get busy() { return !!this.action; }

  hit(direction, strength = 1) {
    this.hitFlash = Math.min(1, this.hitFlash + strength);
    if (direction) this.hitDir.copy(direction).normalize();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.deathTime = 0;
    this.action = null;

    // Randomize the collapse so no two deaths -- even of the same monster
    // kind -- look identical. When we know which way the killing blow came
    // from, the body falls away from it; otherwise pick a plausible random
    // fall direction off the current facing.
    const dirKnown = this.hitDir.lengthSq() > 1e-5;
    const jitter = (Math.random() - 0.5) * 1.6;
    this.deathSeed = {
      style: Math.floor(Math.random() * 3), // 0 backward, 1 sideways, 2 forward crumple
      side: Math.random() < 0.5 ? -1 : 1,
      twist: (Math.random() - 0.5) * 0.6,
      settlePhase: Math.random() * Math.PI * 2,
      fallX: dirKnown ? this.hitDir.x : Math.sin(this.facing + jitter),
      fallZ: dirKnown ? this.hitDir.z : Math.cos(this.facing + jitter),
      armSpread: 0.7 + Math.random() * 0.6,
    };
  }

  update(dt, { speed = 0, facing = 0 } = {}) {
    this.time += dt;
    this.speed = speed;
    this.facing = facing;

    const rig = this.rig;
    rig.resetPose();

    if (this.dead) {
      this.deathTime += dt;
      this._poseDeath(Math.min(1, this.deathTime / 0.9));
      this._applyHeadLag(dt);
      this._updateCloths(dt, 0, facing);
      return;
    }

    // --- locomotion base layer ---------------------------------------------
    const gait = THREE.MathUtils.clamp(speed / 4.2, 0, 1.6);
    // Stride frequency rises with the square root of speed, which is how real
    // gait works -- doubling speed does not double cadence, it lengthens the
    // stride too.
    const freq = (1.1 + Math.sqrt(gait) * 2.6) / Math.max(0.6, this.weight * 0.5 + 0.5);
    this.phase += dt * freq * Math.PI * 2;

    if (gait > 0.02) {
      this._poseWalk(gait);
    } else {
      this._poseIdle();
      this._feet.L.planted = false;
      this._feet.R.planted = false;
    }

    // --- action layer -------------------------------------------------------
    if (this.action) {
      const a = this.action;
      a.t += dt;
      const u = THREE.MathUtils.clamp(a.t / a.dur, 0, 1);

      for (const ev of a.events) {
        if (u >= ev.at && !a.fired.has(ev)) {
          a.fired.add(ev);
          a.onEvent?.(ev.name, a.data);
        }
      }

      // Ease actions in fast and out slow so impacts land crisply.
      const w = u < 0.15 ? u / 0.15 : 1 - Math.pow((u - 0.15) / 0.85, 2);
      switch (a.name) {
        case 'attackSwing': this._poseAttackSwing(u, w); break;
        case 'attackThrust': this._poseAttackThrust(u, w); break;
        case 'cast': this._poseCast(u, w); break;
        default: break;
      }

      if (u >= 1) this.action = null;
    }

    // --- hit reaction (additive, always on top) -----------------------------
    if (this.hitFlash > 0.001) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 3.2);
      // A touch of decaying oscillation on top of the monotonic recoil so a
      // heavy hit reads as a snap-back rather than a slow lean.
      const wobble = 1 + 0.25 * Math.sin(this.hitFlash * 11);
      const k = this.hitFlash * this.hitFlash * wobble;
      // Recoil away from the blow, in the character's local frame.
      const local = Math.atan2(this.hitDir.x, this.hitDir.z) - this.facing;
      rig.addRot('spine', Math.cos(local) * 0.45, 0, -Math.sin(local) * 0.35, k);
      rig.addRot('chest', Math.cos(local) * 0.30, 0, -Math.sin(local) * 0.25, k);
      rig.addRot('head', Math.cos(local) * 0.25, 0, -Math.sin(local) * 0.20, k);
      rig.offsetPos('root', -Math.sin(local) * 0.02 * k, -0.05 * k, -Math.cos(local) * 0.02 * k);
    }

    this._applyHeadLag(dt);
    this._updateCloths(dt, speed, facing);
  }

  _poseIdle() {
    const rig = this.rig;
    const t = this.time;
    const s = this.idleSway;
    const hunch = this.hunch;
    // Breathing: a slow chest lift with a counter-rotation in the pelvis, plus
    // a barely-there weight shift so the character never looks frozen.
    const breath = Math.sin(t * 1.35) * 0.5 + 0.5;
    const shift = Math.sin(t * 0.42) * s;
    const stanceKick = (this.stance - 1) * 0.30;

    rig.offsetPos('root', shift * 0.008 * s, breath * 0.012 * s, 0);
    rig.setRot('pelvis', hunch * 0.12, shift * 0.05, shift * 0.03);
    rig.setRot('spine', -0.04 - breath * 0.02 + hunch * 0.34, -shift * 0.03, 0);
    rig.setRot('chest', -0.02 + breath * 0.035 + hunch * 0.22, -shift * 0.02, 0);
    rig.setRot('head', 0.03 - breath * 0.02 - hunch * 0.16, shift * 0.10, 0);

    if (this.gaitStyle === 'undead') {
      // Stiff and uneven: joints don't breathe smoothly, they tick, like bone
      // settling rather than a chest rising and falling.
      const tick = Math.sin(t * 2.3 + this._windSeed) > 0.86 ? 1 : 0;
      rig.addRot('neck', tick * 0.05, tick * 0.03, 0, 1);
      rig.setRot('upperArmL', 0.16, 0, 0.20);
      rig.setRot('upperArmR', 0.16, 0, -0.20);
      rig.setRot('lowerArmL', -0.14, 0, 0.03);
      rig.setRot('lowerArmR', -0.14, 0, -0.03);
    } else if (this.gaitStyle === 'scuttle') {
      // Low, wide, coiled -- reads as barely-restrained energy even standing
      // still, which is the whole point of a "many but weak" swarmer.
      const twitch = Math.sin(t * 3.4 + this._windSeed) * 0.10;
      rig.setRot('upperArmL', 0.65 + twitch, 0.10, 0.55);
      rig.setRot('upperArmR', 0.65 - twitch, -0.10, -0.55);
      rig.setRot('lowerArmL', -1.15, 0, 0);
      rig.setRot('lowerArmR', -1.15, 0, 0);
    } else {
      // Arms hang with a slight outward flare from the lats.
      rig.setRot('upperArmL', 0.08 + breath * 0.02, 0, 0.14 + shift * 0.02);
      rig.setRot('upperArmR', 0.08 + breath * 0.02, 0, -0.14 - shift * 0.02);
      rig.setRot('lowerArmL', -0.22, 0, 0.06);
      rig.setRot('lowerArmR', -0.22, 0, -0.06);
    }

    rig.setRot('thighL', -0.02 + hunch * 0.08, 0, 0.03 + stanceKick);
    rig.setRot('thighR', -0.02 + hunch * 0.08, 0, -0.03 - stanceKick);
    rig.setRot('shinL', 0.04 + Math.max(0, hunch) * 0.22, 0, 0);
    rig.setRot('shinR', 0.04 + Math.max(0, hunch) * 0.22, 0, 0);
  }

  _poseWalk(gait) {
    const rig = this.rig;
    const p = this.phase;
    const amp = Math.min(1, gait) * this.strideLength;
    const run = THREE.MathUtils.clamp((gait - 0.55) / 0.7, 0, 1);
    const hunch = this.hunch;
    const stanceKick = (this.stance - 1) * 0.28;

    const sin = Math.sin(p);
    const cos = Math.cos(p);

    // Vertical bob peaks twice per stride (once per footfall).
    const bob = -Math.abs(cos) * 0.055 * amp * this.bounce;
    // Lateral sway once per stride, opposite the planted foot.
    const sway = sin * 0.022 * amp;
    rig.offsetPos('root', sway, bob + run * 0.03, 0);

    // Forward lean scales with speed: walking is upright, running pitches in.
    // A hunched archetype (swarmer) leans further forward at every speed; a
    // stiff one (skeleton) resists leaning at all.
    const lean = 0.06 + run * 0.30 + hunch * 0.5;
    rig.setRot('pelvis', lean * 0.3, -sin * 0.20 * amp, cos * 0.05 * amp);
    rig.setRot('spine', lean * 0.4, sin * 0.10 * amp, -sway * 0.6);
    rig.setRot('chest', lean * 0.3, sin * 0.16 * amp, 0);
    rig.setRot('head', -lean * 0.5, -sin * 0.05 * amp, 0);

    // Legs: thigh swings as a sine, shin flexes only on the recovery half so
    // the leg stays straight when it is bearing weight. Wide-stance
    // archetypes (swarmer) splay the thighs outward on top of the swing.
    const legSwing = 0.62 * amp;
    const thighL = sin * legSwing;
    const thighR = -sin * legSwing;
    rig.setRot('thighL', thighL, 0, 0.03 + stanceKick);
    rig.setRot('thighR', thighR, 0, -0.03 - stanceKick);
    rig.setRot('shinL', Math.max(0, -sin) * 1.05 * amp + 0.05, 0, 0);
    rig.setRot('shinR', Math.max(0, sin) * 1.05 * amp + 0.05, 0, 0);
    rig.setRot('footL', -thighL * 0.45 + 0.08, 0, 0);
    rig.setRot('footR', -thighR * 0.45 + 0.08, 0, 0);

    // Arms counter-swing the legs.
    const armSwing = 0.55 * amp * (0.6 + run * 0.6);
    if (this.gaitStyle === 'scuttle') {
      // Swarmers run on all fours in spirit: arms drive forward hard and low
      // instead of a calm counter-swing, like a hunched sprint.
      rig.setRot('upperArmL', 0.55 - sin * armSwing * 1.3, 0.1, 0.35);
      rig.setRot('upperArmR', 0.55 + sin * armSwing * 1.3, -0.1, -0.35);
      rig.setRot('lowerArmL', -1.0 - Math.max(0, sin) * 0.4, 0, 0);
      rig.setRot('lowerArmR', -1.0 - Math.max(0, -sin) * 0.4, 0, 0);
    } else if (this.gaitStyle === 'undead') {
      // Loose, rattling swing with almost no elbow bend -- bone has no muscle
      // to drive a natural counter-swing.
      rig.setRot('upperArmL', -sin * armSwing * 0.7 + 0.10, 0, 0.16);
      rig.setRot('upperArmR', sin * armSwing * 0.7 + 0.10, 0, -0.16);
      rig.setRot('lowerArmL', -0.10 - Math.max(0, -sin) * 0.15, 0, 0);
      rig.setRot('lowerArmR', -0.10 - Math.max(0, sin) * 0.15, 0, 0);
    } else {
      rig.setRot('upperArmL', -sin * armSwing + 0.05, 0, 0.12 + run * 0.10);
      rig.setRot('upperArmR', sin * armSwing + 0.05, 0, -0.12 - run * 0.10);
      rig.setRot('lowerArmL', -0.30 - run * 0.55 - Math.max(0, -sin) * 0.3, 0, 0);
      rig.setRot('lowerArmR', -0.30 - run * 0.55 - Math.max(0, sin) * 0.3, 0, 0);
    }

    // Foot-plant IK: hold the stance-phase sole at the world position it
    // touched down at instead of letting the FK swing above drag it across
    // the ground. Applied last so it overrides (and blends against) the FK
    // rotations just set above.
    this._footPlant('L', sin);
    this._footPlant('R', -sin);
  }

  _footPlant(side, legSin) {
    const rig = this.rig;
    const thigh = rig.bones[`thigh${side}`];
    const shin = rig.bones[`shin${side}`];
    const foot = rig.bones[`foot${side}`];
    const pelvis = rig.bones.pelvis;
    if (!thigh || !shin || !foot || !pelvis) return;

    const st = this._feet[side];
    if (legSin < 0) { st.planted = false; return; } // swing phase: foot is lifted, let FK drive it

    if (!st.planted) {
      // Just touched down -- capture the sole's current world position and
      // hold the leg there for the rest of stance.
      foot.updateWorldMatrix(true, false);
      foot.getWorldPosition(st.anchor);
      st.planted = true;
    }

    // Ease the correction in and out across the stance window so touchdown
    // and toe-off blend smoothly with the FK swing either side of it, rather
    // than popping into a locked leg.
    const w = Math.sin(THREE.MathUtils.clamp(legSin, 0, 1) * Math.PI);
    if (w < 0.03) return;

    _fkThighQ.copy(thigh.quaternion);
    _fkShinQ.copy(shin.quaternion);

    pelvis.updateWorldMatrix(true, false);
    _ikTarget.copy(st.anchor);
    pelvis.worldToLocal(_ikTarget);
    _ikTarget.sub(thigh.position);
    if (_ikTarget.lengthSq() < 1e-6) return;

    rig.solveIK(`thigh${side}`, `shin${side}`, `foot${side}`, _ikTarget);
    thigh.quaternion.slerp(_fkThighQ, 1 - w);
    shin.quaternion.slerp(_fkShinQ, 1 - w);
  }

  _poseAttackSwing(u, w) {
    const rig = this.rig;
    // Anticipation (wind back) then a fast arc through, then follow-through.
    // The curve is deliberately asymmetric, and its exact ratios shift by
    // archetype so a skeleton's telegraphed chop and a swarmer's scrappy
    // flurry don't share one generic "swing" timing.
    let swing;
    if (this.gaitStyle === 'undead') {
      // Long, heavy wind-up; a slow, committed chop.
      if (u < 0.5) swing = -Math.pow(u / 0.5, 0.6) * 1.05;
      else if (u < 0.62) swing = -1.05 + Math.pow((u - 0.5) / 0.12, 0.55) * 2.6;
      else swing = 1.55 - ((u - 0.62) / 0.38) * 1.55;
    } else if (this.gaitStyle === 'scuttle') {
      // Barely any wind-up, a quick scrappy snap and a fast reset -- reads as
      // cheap and frequent rather than heavy.
      if (u < 0.18) swing = -Math.pow(u / 0.18, 0.7) * 0.6;
      else if (u < 0.32) swing = -0.6 + Math.pow((u - 0.18) / 0.14, 0.5) * 2.0;
      else swing = 1.4 - ((u - 0.32) / 0.68) * 1.4;
    } else {
      if (u < 0.35) swing = -Math.pow(u / 0.35, 0.7) * 1.0;
      else if (u < 0.5) swing = -1.0 + Math.pow((u - 0.35) / 0.15, 0.6) * 2.6;
      else swing = 1.6 - ((u - 0.5) / 0.5) * 1.6;
    }

    const twist = swing * 0.55;
    rig.addRot('pelvis', 0, -twist * 0.5, 0, w);
    rig.addRot('spine', swing * 0.12, -twist * 0.7, 0, w);
    rig.addRot('chest', swing * 0.10, -twist * 0.9, 0, w);
    rig.addRot('head', 0, -twist * 0.3, 0, w);

    rig.addRot('upperArmR', -1.3 + swing * 1.55, -0.35 - twist * 0.4, -0.5 + swing * 0.5, w);
    rig.addRot('lowerArmR', -1.5 + Math.max(0, swing) * 1.2, 0, 0, w);
    rig.addRot('upperArmL', -0.35 + swing * 0.5, 0.4, 0.45, w);
    rig.addRot('lowerArmL', -0.9, 0, 0, w);

    // Step into the blow.
    rig.addRot('thighL', Math.max(0, swing) * 0.30, 0, 0, w);
    rig.addRot('thighR', -Math.max(0, swing) * 0.18, 0, 0, w);
  }

  _poseAttackThrust(u, w) {
    const rig = this.rig;
    let ext;
    if (u < 0.4) ext = -Math.pow(u / 0.4, 0.8) * 0.8;
    else if (u < 0.55) ext = -0.8 + Math.pow((u - 0.4) / 0.15, 0.5) * 2.3;
    else ext = 1.5 - ((u - 0.55) / 0.45) * 1.5;

    rig.addRot('pelvis', 0, -ext * 0.25, 0, w);
    rig.addRot('spine', ext * 0.10, -ext * 0.35, 0, w);
    rig.addRot('chest', ext * 0.06, -ext * 0.45, 0, w);
    rig.addRot('upperArmR', -1.45 - ext * 0.1, -0.15, -0.15, w);
    rig.addRot('lowerArmR', -1.6 + Math.max(0, ext) * 1.55, 0, 0, w);
    rig.addRot('thighL', Math.max(0, ext) * 0.45, 0, 0, w);
  }

  _poseCast(u, w) {
    const rig = this.rig;
    // Gather (arms in, spine curls), release (arms thrown forward and out).
    const gather = u < 0.55 ? Math.pow(u / 0.55, 0.8) : 1 - Math.pow((u - 0.55) / 0.45, 0.5);
    const release = u < 0.55 ? 0 : Math.pow((u - 0.55) / 0.45, 0.4);

    rig.addRot('spine', -gather * 0.28 + release * 0.20, 0, 0, w);
    rig.addRot('chest', -gather * 0.20 + release * 0.16, 0, 0, w);
    rig.addRot('head', -gather * 0.15 + release * 0.10, 0, 0, w);

    const armUp = -1.1 * gather - 0.9 * release;
    rig.addRot('upperArmR', armUp, -0.25 + release * 0.3, -0.45 + gather * 0.35, w);
    rig.addRot('upperArmL', armUp, 0.25 - release * 0.3, 0.45 - gather * 0.35, w);
    rig.addRot('lowerArmR', -1.35 + release * 1.05, 0, 0, w);
    rig.addRot('lowerArmL', -1.35 + release * 1.05, 0, 0, w);
  }

  _poseDeath(u) {
    const rig = this.rig;
    const ds = this.deathSeed || {
      style: 0, side: 1, twist: 0, settlePhase: 0, fallX: 0, fallZ: 1, armSpread: 1,
    };
    const H = rig.spec.height;
    const e = 1 - Math.pow(1 - u, 3);
    const knee = Math.min(1, u / 0.35);
    const fold = THREE.MathUtils.clamp((u - 0.15) / 0.5, 0, 1);
    // A last small twitch as the body settles, fully decayed well before u=1
    // so the corpse actually comes to rest instead of animating forever.
    const settle = Math.sin(u * 26 + ds.settlePhase) * Math.exp(-u * 9) * (1 - u) * 0.05;
    const fallYaw = Math.atan2(ds.fallX, ds.fallZ) - this.facing;

    if (ds.style === 0) {
      // Backward topple: knees buckle, the whole body rotates onto its back
      // along the line the killing blow travelled.
      rig.offsetPos('root', 0, -H * 0.40 * e, -0.1 * e);
      rig.setRot('root', -1.4 * e * Math.cos(fallYaw), fallYaw * 0.3 * e, 1.3 * e * Math.sin(fallYaw) + settle);
      rig.setRot('pelvis', 0.4 * fold, 0, ds.twist * fold);
      rig.setRot('spine', 0.3 * fold, ds.twist * 0.5 * fold, 0);
      rig.setRot('chest', 0.2 * fold, 0, 0);
      rig.setRot('head', 0.35 * fold + settle, -ds.twist * fold, 0.1 * ds.side * fold);
      rig.setRot('thighL', -1.3 * knee, 0, 0.2 * knee);
      rig.setRot('thighR', -1.1 * knee, 0, -0.15 * knee);
      rig.setRot('shinL', 1.7 * knee, 0, 0);
      rig.setRot('shinR', 1.5 * knee, 0, 0);
      rig.setRot('upperArmL', 1.1 * e * ds.armSpread, 0.4 * e, 0.9 * e);
      rig.setRot('upperArmR', 0.9 * e * ds.armSpread, -0.4 * e, -1.0 * e);
      rig.setRot('lowerArmL', -0.3 * e, 0, 0);
      rig.setRot('lowerArmR', -0.25 * e, 0, 0);
    } else if (ds.style === 1) {
      // Sideways crumple: one leg gives first, the body folds onto its flank.
      const side = ds.side;
      rig.offsetPos('root', side * H * 0.12 * e, -H * 0.38 * e, 0);
      rig.setRot('root', -0.3 * e, side * 0.4 * e, side * 1.5 * e + settle);
      rig.setRot('pelvis', 0.15 * fold, 0, side * 0.5 * fold);
      rig.setRot('spine', 0.25 * fold, side * 0.2 * fold, side * 0.35 * fold);
      rig.setRot('chest', 0.15 * fold, 0, side * 0.2 * fold);
      rig.setRot('head', 0.2 * fold + settle, side * 0.3 * fold, side * 0.4 * fold);
      const downLeg = side < 0 ? 'L' : 'R';
      const upLeg = side < 0 ? 'R' : 'L';
      rig.setRot(`thigh${downLeg}`, -1.6 * knee, 0, side * 0.3 * knee);
      rig.setRot(`shin${downLeg}`, 1.8 * knee, 0, 0);
      rig.setRot(`thigh${upLeg}`, -0.8 * knee, 0, -side * 0.2 * knee);
      rig.setRot(`shin${upLeg}`, 1.1 * knee, 0, 0);
      rig.setRot('upperArmL', 0.6 * e, side < 0 ? 0.7 * e : -0.2 * e, 0.6 * e);
      rig.setRot('upperArmR', 0.6 * e, side > 0 ? -0.7 * e : 0.2 * e, -0.6 * e);
    } else {
      // Forward crumple: buckles onto its knees, then folds face-down.
      rig.offsetPos('root', 0, -H * 0.36 * e, 0.15 * e);
      rig.setRot('root', 1.2 * e, ds.twist * 0.5 * e, ds.twist * 0.3 * e + settle);
      rig.setRot('pelvis', -0.3 * fold, 0, 0);
      rig.setRot('spine', -0.55 * fold, ds.twist * fold, 0);
      rig.setRot('chest', -0.45 * fold, 0, 0);
      rig.setRot('head', -0.3 * fold + settle, ds.twist * 1.2 * fold, 0);
      rig.setRot('thighL', -0.9 * knee, 0, 0.1 * knee);
      rig.setRot('thighR', -1.0 * knee, 0, -0.1 * knee);
      rig.setRot('shinL', 1.9 * knee, 0, 0);
      rig.setRot('shinR', 2.0 * knee, 0, 0);
      rig.setRot('upperArmL', -0.9 * e, 0.3 * e, 0.6 * e * ds.armSpread);
      rig.setRot('upperArmR', -0.9 * e, -0.3 * e, -0.6 * e * ds.armSpread);
      rig.setRot('lowerArmL', -0.7 * e, 0, 0);
      rig.setRot('lowerArmR', -0.7 * e, 0, 0);
    }
  }

  /**
   * Secondary motion: the head trails whatever rotation the pose/action/hit
   * layers computed for it this frame instead of snapping straight there.
   * Runs after everything else touches the head bone, and is agnostic to how
   * that rotation was produced.
   */
  _applyHeadLag(dt) {
    const head = this.rig.bones.head;
    if (!head) return;
    if (!this._headActualInit) {
      this._headActual.copy(head.quaternion);
      this._headActualInit = true;
    }
    const rate = this.dead ? 3.2 : 9.5;
    const k = 1 - Math.exp(-rate * dt);
    this._headActual.slerp(head.quaternion, k);
    head.quaternion.copy(this._headActual);
  }

  /**
   * Drive every cloth sim registered on the rig (cloaks, tabards, rag scraps).
   * Gravity and motion drag are world-space vectors, rotated into each
   * anchor bone's local frame right before stepping the solver -- see
   * Cloth.js for why that rotation has to happen here rather than in the
   * cloth itself.
   */
  _updateCloths(dt, speed, facing) {
    const rig = this.rig;
    if (!rig.cloths || !rig.cloths.length) return;
    const fwdX = Math.sin(facing);
    const fwdZ = Math.cos(facing);
    const t = this.time;
    const spd = Math.min(speed, 7);
    const ws = this._windSeed;

    for (const entry of rig.cloths) {
      const cloth = entry.cloth;
      const bone = rig.bones[entry.anchorBone];
      if (!cloth || !bone) continue;

      _gWorld.set(0, -9.8, 0);
      // Motion drag: the cloth trails opposite the direction of travel, with
      // a little lift so it billows rather than just hanging straight back.
      _dWorld.set(-fwdX, 0.35, -fwdZ).multiplyScalar(spd * (entry.dragScale ?? 0.6));
      // Ambient breeze, out of phase per character so a pack doesn't ripple
      // in unison.
      _dWorld.x += Math.sin(t * 0.6 + ws) * 0.55;
      _dWorld.z += Math.cos(t * 0.44 + ws * 1.7) * 0.45;

      rig.getWorldQuaternion(entry.anchorBone, _qInv).invert();
      _gLocal.copy(_gWorld).applyQuaternion(_qInv);
      _dLocal.copy(_dWorld).applyQuaternion(_qInv);

      cloth.update(dt, {
        gravity: _gLocal,
        drag: _dLocal,
        damping: entry.damping ?? 0.96,
        iterations: entry.iterations ?? 3,
      });
    }
  }
}

const _ikTarget = new THREE.Vector3();
const _fkThighQ = new THREE.Quaternion();
const _fkShinQ = new THREE.Quaternion();
const _gWorld = new THREE.Vector3();
const _dWorld = new THREE.Vector3();
const _gLocal = new THREE.Vector3();
const _dLocal = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
