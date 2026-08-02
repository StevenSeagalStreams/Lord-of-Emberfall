import * as THREE from 'three';
import { Animator } from './Animation.js';
import { computeDamage } from '../combat/Damage.js';
import { knockbackForce } from '../combat/Knockback.js';
import { HitStop } from '../combat/HitStop.js';

let _nextId = 1;

/**
 * Base actor: transform, stats, steering, path following, collision response.
 *
 * Movement is force-free (no rigid body integration). ARPG feel comes from
 * direct velocity control with acceleration limits -- physics-driven movement
 * gives you ice-skating and makes precise melee spacing impossible.
 */
export class Entity {
  constructor(opts = {}) {
    this.id = _nextId++;
    this.type = opts.type ?? 'entity';
    this.faction = opts.faction ?? 'neutral';

    this.object = new THREE.Group();
    this.object.name = `${this.type}#${this.id}`;

    this.position = this.object.position;
    this.velocity = new THREE.Vector3();
    this.facing = 0;              // yaw, radians
    this.targetFacing = 0;
    this.turnRate = opts.turnRate ?? 11.0;

    this.radius = opts.radius ?? 0.42;
    this.height = opts.height ?? 1.85;
    this.mass = opts.mass ?? 1.0;

    this.moveSpeed = opts.moveSpeed ?? 4.4;
    this.acceleration = opts.acceleration ?? 34.0;
    this.friction = opts.friction ?? 26.0;

    this.maxHealth = opts.maxHealth ?? 100;
    this.health = this.maxHealth;
    this.alive = true;
    this.deathTimer = 0;

    // Combat stats. Physical damage, armour reduction and crits are all
    // resolved centrally in damage() via src/combat/Damage.js -- these are
    // just the per-entity inputs to that one auditable formula.
    this.armor = opts.armor ?? 0;
    this.critChance = opts.critChance ?? 0;
    this.critMultiplier = opts.critMultiplier ?? 1.5;

    /** Cached from the most recent update(dt, world) call. damage() can be
     *  invoked outside of update() (e.g. from an attack's onImpact callback
     *  earlier in the same frame), so this is refreshed every tick rather
     *  than captured once at construction time. */
    this._world = null;
    /** Directional, varied death collapse -- see kill(). */
    this._collapse = null;

    /** @type {{x:number,z:number}[]|null} */
    this.path = null;
    this.pathIndex = 0;
    this.arriveRadius = opts.arriveRadius ?? 0.30;

    this.rig = null;
    this.animator = null;

    this.stunTimer = 0;
    this.knockback = new THREE.Vector3();

    // --- status effects (skills pillar reaches these via applySlow/applyDot,
    // never by poking timers directly) --------------------------------------
    /** Movement-speed multiplier while `slowTimer > 0` (e.g. Frost Nova). */
    this.slowTimer = 0;
    this.slowFactor = 1;
    /** @type {{tickInterval:number,tickTimer:number,ticksLeft:number,amount:number,source:*}[]} */
    this.dots = [];

    this._desired = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    /** Distance accumulator for footstep fx -- see `_emitFootstepFx`. */
    this._stepDist = 0;
  }

  setRig(rig, animOpts = {}) {
    this.rig = rig;
    this.object.add(rig.root);
    this.animator = new Animator(rig, animOpts);
    return this;
  }

  /**
   * How tall this body *looks*, as opposed to `height`, which is the physics
   * capsule combat reasons about.
   *
   * These stopped being the same number when G1 scaled the art up: Models.js
   * multiplies the height it feeds `CharacterRig` by `VISUAL_SCALE`, quite
   * deliberately, because the collision size and monster spacing belong to
   * combat and are under a parked feel gate. The consequence is that anything
   * anchoring to a body -- a floating nameplate, a blood spurt, a death puff
   * -- lands at roughly half the model if it uses `height`, which is why
   * nameplates were sitting at the skeletons' waists.
   *
   * So: use `height` for anything physical, and this for anything you are
   * placing *on the visible body*.
   */
  get visualHeight() {
    return this.rig?.spec?.height ?? this.height;
  }

  /**
   * Total planar motion, for animation gait-blending and footstep fx --
   * includes the current knockback contribution (even though knockback is
   * deliberately NOT folded into `velocity` for position integration, see
   * `update()`) so a body sliding from a shove still reads as moving instead
   * of idle-standing-while-drifting.
   */
  get speed() {
    return Math.hypot(this.velocity.x + this.knockback.x, this.velocity.z + this.knockback.z);
  }

  setPath(waypoints) {
    this.path = waypoints && waypoints.length ? waypoints : null;
    this.pathIndex = 0;
  }

  clearPath() {
    this.path = null;
    this.pathIndex = 0;
  }

  faceTowards(x, z) {
    this.targetFacing = Math.atan2(x - this.position.x, z - this.position.z);
  }

  applyKnockback(dirX, dirZ, force) {
    const inv = 1 / Math.max(0.2, this.mass);
    this.knockback.x += dirX * force * inv;
    this.knockback.z += dirZ * force * inv;
  }

  /**
   * Slow: a bounded movement-speed multiplier for `duration` seconds. A
   * second application while one is already active takes the *stronger*
   * factor (lower number) and the *longer* remaining duration -- refreshing
   * with a weaker slow must never undo a stronger one already in flight,
   * same "never cut a stronger effect short" rule HitStop uses.
   */
  applySlow(duration, factor) {
    const f = THREE.MathUtils.clamp(Number.isFinite(factor) ? factor : 1, 0, 1);
    const d = Math.max(0, Number.isFinite(duration) ? duration : 0);
    if (d <= 0) return;
    if (this.slowTimer <= 0 || f < this.slowFactor) this.slowFactor = f;
    this.slowTimer = Math.max(this.slowTimer, d);
  }

  /**
   * Damage-over-time stack (e.g. the builder skill's burn debuff). Capped at
   * `maxStacks` -- a new stack beyond the cap evicts the oldest rather than
   * stacking without bound, so a spammed builder cannot produce infinite DPS.
   */
  applyDot({ amount, ticks = 3, interval = 0.5, source = null, maxStacks = 3 }) {
    if (this.dots.length >= maxStacks) this.dots.shift();
    this.dots.push({ tickInterval: interval, tickTimer: interval, ticksLeft: ticks, amount, source });
  }

  /**
   * The one auditable place damage is computed and applied. Every hit in the
   * game -- player swinging on a monster, a monster swinging on the player --
   * ends up calling `victim.damage(rawAmount, attacker, opts)`, so armour
   * reduction (victim.armor), crit rolls (attacker.critChance/Multiplier),
   * knockback (mass-scaled), hit-stop, camera shake and the `combat:hit`
   * event all happen exactly once, right here, regardless of which call site
   * triggered it. See computeDamage() in src/combat/Damage.js for the actual
   * math and its self-test for the guarantees (no NaN, bounded armour).
   */
  damage(amount, source = null, opts = {}) {
    if (!this.alive) return 0;

    const rngFn = (this._world && this._world.rng && typeof this._world.rng.next === 'function')
      ? () => this._world.rng.next()
      : Math.random;

    const result = computeDamage({
      baseAmount: amount,
      armor: this.armor,
      critChance: source?.critChance ?? 0,
      critMultiplier: source?.critMultiplier ?? this.critMultiplier,
      forceCrit: typeof opts.crit === 'boolean' ? opts.crit : undefined,
      rng: rngFn,
    });

    const dealt = result.amount;
    this.health = Math.max(0, this.health - dealt);

    if (opts.direction) {
      const force = knockbackForce(dealt, { crit: result.crit, flat: opts.knockback ?? 0 });
      this.applyKnockback(opts.direction.x, opts.direction.z, force);
    }
    if (this.animator && opts.direction) {
      const strength = result.crit
        ? 1
        : Math.min(1, 0.35 + (dealt / Math.max(1, this.maxHealth)) * 1.8);
      this.animator.hit(opts.direction, opts.stagger ?? strength);
    }
    if (opts.stun) this.stunTimer = Math.max(this.stunTimer, opts.stun);

    // Hit-stop: the single highest-leverage trick for melee to read as
    // connecting. Crits freeze harder and longer; a merely "heavy" hit (a big
    // chunk of the victim's max health in one blow) gets a shorter, lighter
    // slow. Both numbers are in real frames -- see HitStop.js for why that
    // guarantees release.
    const heavyFrac = this.maxHealth > 0 ? dealt / this.maxHealth : 0;
    if (result.crit) HitStop.trigger(5, 0.04);
    else if (heavyFrac >= 0.16) HitStop.trigger(3, 0.15);

    // Camera feedback. `world.bus` is the documented channel; `window.__game`
    // is the mission-specified fallback straight to the rig's own trauma
    // accumulator, since `world` does not carry a reference to the rig.
    if (result.crit || heavyFrac >= 0.12) {
      const trauma = Math.min(1, (result.crit ? 0.22 : 0.10) + heavyFrac * 0.3);
      this._world?.bus?.emit?.('camera:shake', { trauma });
      if (typeof window !== 'undefined') {
        try { window.__game?.rig?.addTrauma?.(trauma); } catch { /* non-browser/headless: no-op */ }
      }
    }

    this._world?.bus?.emit?.('combat:hit', {
      attacker: source, victim: this, amount: dealt, direction: opts.direction ?? null, crit: result.crit,
    });

    // fx:request -- see ARCHITECTURE.md's bus contract. Combat never imports
    // src/fx; it only describes *what happened* (kind/position/direction/
    // scale) and leaves how it looks to the vfx pillar. Only fired for a hit
    // that actually landed (dealt > 0) -- a 0-damage graze draws nothing.
    if (dealt > 0 && this._world?.bus) {
      // visualHeight, not height -- blood belongs on the body you can see.
      const hitPos = { x: this.position.x, y: this.position.y + this.visualHeight * 0.55, z: this.position.z };
      const fxDir = opts.direction ? { x: opts.direction.x, y: 0, z: opts.direction.z } : null;
      // Armoured targets (skeleton/brute/the player) read as metal-on-metal;
      // unarmoured ones (swarmer) read as flesh. One deterministic rule off
      // stats we already have, no new per-entity flag needed.
      const hitScale = Math.min(1.8, Math.max(0.35, 0.45 + heavyFrac * 1.1 + (result.crit ? 0.35 : 0)));
      this._world.bus.emit('fx:request', {
        kind: this.armor > 0 ? 'spark_metal' : 'blood_hit',
        position: hitPos, direction: fxDir, scale: hitScale,
      });
      // Same "heavy or crit" threshold as hit-stop above -- the flash is the
      // visual half of the same beat the freeze is the temporal half of.
      if (result.crit || heavyFrac >= 0.16) {
        const flashScale = Math.min(1.6, Math.max(0.5, (result.crit ? 1.0 : 0.6) + heavyFrac * 0.5));
        this._world.bus.emit('fx:request', {
          kind: 'impact_flash', position: hitPos, direction: fxDir, scale: flashScale,
        });
      }
    }

    if (this.health <= 0) {
      this.health = 0;
      this._deathDirection = opts.direction ? { x: opts.direction.x, z: opts.direction.z } : null;
      this._deathForce = dealt;
      this.kill(source);
    }
    return dealt;
  }

  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  /**
   * Not literal rigid-body ragdoll -- a directional, varied tip-over of the
   * whole entity container, layered on top of whatever Animation.js's own
   * `_poseDeath` does to individual bones (we do not own Animation.js, so
   * this happens one level up: `this.object` is the group Entity itself
   * owns, and `rig.root` is just a child of it, so the two transforms
   * compose). A body killed by a hit from the left falls to the right,
   * because the tip direction comes straight from the killing blow's
   * direction; force and a little randomness vary how hard/fast it goes.
   */
  kill(source = null) {
    if (!this.alive) return;
    this.alive = false;
    this.deathTimer = 0;
    this.clearPath();
    this.velocity.set(0, 0, 0);
    this.animator?.die();

    const dir = this._deathDirection;
    const forceFrac = THREE.MathUtils.clamp(
      (this._deathForce ?? 0) / Math.max(1, this.maxHealth * 0.5), 0.35, 1.6
    );
    this._collapse = {
      // Fall away from the blow; if we don't know a direction (e.g. a scripted
      // kill with no hit direction), fall forward along current facing.
      dirX: dir ? dir.x : Math.sin(this.facing),
      dirZ: dir ? dir.z : Math.cos(this.facing),
      twist: (Math.random() - 0.5) * 0.6,
      amount: THREE.MathUtils.clamp(0.95 + forceFrac * 0.3 + Math.random() * 0.25, 0.85, 1.5),
      duration: THREE.MathUtils.clamp(0.9 - forceFrac * 0.25 + Math.random() * 0.2, 0.45, 1.0),
    };

    // Diablo rule: corpses persist. This entity does not despawn itself on a
    // timer -- see the note in the mission report about main.js's reaper.
    this._world?.bus?.emit?.('combat:kill', { attacker: source, victim: this });

    // fx:request -- always a "blood_kill", even for an armoured/bony target;
    // the vfx pillar decides per-model whether that reads as blood, bone
    // shards, or dust, this just marks "this is the kill beat". Direction
    // reuses `this._collapse`'s already-resolved fallback (killing blow's
    // direction, or facing if the kill had none) rather than re-deriving it.
    if (this._world?.bus) {
      const killPos = { x: this.position.x, y: this.position.y + this.visualHeight * 0.4, z: this.position.z };
      const killScale = THREE.MathUtils.clamp(0.8 + forceFrac * 0.6, 0.8, 2.0);
      this._world.bus.emit('fx:request', {
        kind: 'blood_kill',
        position: killPos,
        direction: { x: this._collapse.dirX, y: 0, z: this._collapse.dirZ },
        scale: killScale,
      });
    }
  }

  /** Steering toward the current path waypoint. Returns desired velocity. */
  _followPath(dt) {
    this._desired.set(0, 0, 0);
    if (!this.path) return this._desired;

    let wp = this.path[this.pathIndex];
    while (wp) {
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const distSq = dx * dx + dz * dz;
      // The final waypoint gets a tighter arrival radius; intermediate ones
      // can be cut generously, which is what makes corners look smooth.
      const isLast = this.pathIndex === this.path.length - 1;
      const r = isLast ? this.arriveRadius : Math.max(this.arriveRadius, this.radius * 1.2);
      if (distSq <= r * r) {
        this.pathIndex++;
        wp = this.path[this.pathIndex];
        if (!wp) { this.clearPath(); return this._desired; }
        continue;
      }

      const dist = Math.sqrt(distSq);
      this._desired.set(dx / dist, 0, dz / dist);
      // Arrival damping on the last leg only, so we do not crawl through
      // every intermediate corner.
      if (isLast && dist < 1.4) this._desired.multiplyScalar(Math.max(0.25, dist / 1.4));
      this.targetFacing = Math.atan2(dx, dz);
      return this._desired;
    }
    return this._desired;
  }

  update(dt, world) {
    this._world = world;

    if (!this.alive) {
      this.deathTimer += dt;
      this.animator?.update(dt, { speed: 0, facing: this.facing });
      if (this._collapse) {
        const c = this._collapse;
        const t = Math.min(1, this.deathTimer / c.duration);
        const e = 1 - Math.pow(1 - t, 3); // ease-out settle
        this.object.rotation.x = c.dirZ * c.amount * e;
        this.object.rotation.z = -c.dirX * c.amount * e;
        this.object.rotation.y = this.facing + c.twist * e;
      }
      return;
    }

    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      if (this.slowTimer <= 0) { this.slowTimer = 0; this.slowFactor = 1; }
    }

    // Damage-over-time: ticks in real time (not hit-stop scaled -- a status
    // effect should not get "free" extra time just because a hit landed
    // elsewhere this frame). Iterated back-to-front so a tick that expires a
    // stack can splice it out mid-loop safely.
    if (this.dots.length) {
      for (let i = this.dots.length - 1; i >= 0; i--) {
        const d = this.dots[i];
        d.tickTimer -= dt;
        if (d.tickTimer <= 0) {
          d.tickTimer += d.tickInterval;
          d.ticksLeft -= 1;
          this.damage(d.amount, d.source, {});
          if (d.ticksLeft <= 0) this.dots.splice(i, 1);
        }
      }
      // A dot tick can be the killing blow. kill() already zeroed velocity,
      // cleared the path and started the death pose -- bail out here rather
      // than running this frame's movement/animator update on a corpse; the
      // `!this.alive` branch at the top of update() takes over next frame.
      if (!this.alive) { this.dots.length = 0; return; }
    }

    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
      this._desired.set(0, 0, 0);
    } else {
      this._followPath(dt);
    }

    // Hit-stop scales physics AND animation together, in this one place --
    // that is the whole trick. Status timers above (stun) intentionally keep
    // running in real time; only motion and the animator's own clock freeze.
    const hitStopScale = HitStop.scale;
    const sdt = dt * hitStopScale;

    // --- velocity integration ----------------------------------------------
    // Slow (e.g. Frost Nova) scales the *target* speed, not acceleration --
    // a slowed body still turns and starts moving crisply, it just tops out
    // lower, which reads as "hindered" rather than "sluggish to respond".
    const effSpeed = this.slowTimer > 0 ? this.moveSpeed * this.slowFactor : this.moveSpeed;
    const target = this._tmp.copy(this._desired).multiplyScalar(effSpeed);
    const accel = this._desired.lengthSq() > 0.0001 ? this.acceleration : this.friction;
    const dv = target.sub(this.velocity);
    const maxDelta = accel * sdt;
    if (dv.lengthSq() > maxDelta * maxDelta) dv.setLength(maxDelta);
    this.velocity.add(dv);
    this.velocity.y = 0;

    // Knockback is a decaying *displacement* impulse, kept deliberately
    // separate from `velocity` (steering's own target-tracking state) rather
    // than folded into it. Folding it in used to mean: each frame re-adds
    // whatever is left of the still-large, slowly-decaying knockback on top
    // of a `velocity` that friction can only bleed off a little at a time --
    // the two compounded into a multi-second, tens-of-metres runaway fling
    // instead of a bounded shove (a light body could end up rocketing across
    // the whole level from one crit). Contributing it only to *this frame's*
    // position delta, then decaying it on its own, bounds the total knockback
    // displacement to knockback0/9 (the decay constant below) regardless of
    // friction -- a real shove, not a resonance.
    const kx = this.knockback.x, kz = this.knockback.z;
    if (this.knockback.lengthSq() > 0.0001) {
      this.knockback.multiplyScalar(Math.exp(-9 * sdt));
    }

    // --- collision-aware move ----------------------------------------------
    const nx = this.position.x + (this.velocity.x + kx) * sdt;
    const nz = this.position.z + (this.velocity.z + kz) * sdt;
    // `noclip` is set by the debug console (src/core/Console.js) straight
    // onto `player.noclip`, but nothing honoured it -- it was stored and
    // never read. Any entity can carry the flag (only the player ever will
    // in practice), so this lives here rather than duplicated per-caller.
    const colliders = this.noclip ? null : world?.colliders;

    if (colliders) {
      // Axis-separated resolution lets the body slide along walls instead of
      // sticking. Sticking on corners is the number one thing that makes
      // click-to-move feel broken.
      if (!colliders.isBlocked(nx, this.position.z, this.radius)) {
        this.position.x = nx;
      } else {
        this.velocity.x *= -0.05;
      }
      if (!colliders.isBlocked(this.position.x, nz, this.radius)) {
        this.position.z = nz;
      } else {
        this.velocity.z *= -0.05;
      }
    } else {
      this.position.x = nx;
      this.position.z = nz;
    }

    // --- facing --------------------------------------------------------------
    let diff = this.targetFacing - this.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = THREE.MathUtils.clamp(diff, -this.turnRate * sdt, this.turnRate * sdt);
    this.facing += turn;
    this.object.rotation.y = this.facing;

    this.animator?.update(sdt, { speed: this.speed, facing: this.facing });
    this._emitFootstepFx(sdt);
  }

  /**
   * fx:request('dust_step') -- distance-accumulated, not time-accumulated,
   * so a sprinting swarmer kicks up dust more often than a plodding skeleton
   * without any separate per-kind timer. Reads `animator.strideLength`
   * (public field Animation.js already sets from the profile) rather than
   * duplicating stride tuning here; a rig-less entity (tests) falls back to a
   * sane default so this never throws.
   */
  _emitFootstepFx(sdt) {
    if (!this._world?.bus) return;
    // Total planar motion (steering velocity + any residual knockback), same
    // basis as the `speed` getter -- using `velocity` alone here while
    // thresholding/scaling off `speed` (which includes knockback) could
    // produce a "moving" footstep with a near-zero direction vector.
    const mx = this.velocity.x + this.knockback.x;
    const mz = this.velocity.z + this.knockback.z;
    const spd = Math.hypot(mx, mz);
    if (spd < 0.25) { this._stepDist = 0; return; }
    this._stepDist += spd * sdt;
    const stride = Math.max(0.5, (this.animator?.strideLength ?? 1.4)) * 0.5;
    if (this._stepDist < stride) return;
    this._stepDist -= stride;
    const speedFrac = THREE.MathUtils.clamp(spd / Math.max(0.1, this.moveSpeed), 0, 1.4);
    this._world.bus.emit('fx:request', {
      kind: 'dust_step',
      position: { x: this.position.x, y: 0.02, z: this.position.z },
      direction: { x: mx / spd, y: 0, z: mz / spd },
      scale: THREE.MathUtils.clamp(0.4 + speedFrac * 0.7, 0.4, 1.2),
    });
  }

  distanceTo(other) {
    const dx = other.position.x - this.position.x;
    const dz = other.position.z - this.position.z;
    return Math.hypot(dx, dz);
  }

  dispose() {
    this.rig?.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Separation steering so a pack of monsters does not converge into one
 * flickering z-fighting pile at the player's feet.
 *
 * main.js calls this exactly once per real frame (it is the load-bearing
 * "overlap resolution" phase in the fixed update order), which makes it the
 * one safe place to burn a single frame off the global hit-stop counter --
 * see HitStop.js for why that guarantees the freeze always releases.
 */
export function resolveOverlaps(entities, iterations = 2) {
  HitStop.tickFrame();
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < entities.length; i++) {
      const a = entities[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < entities.length; j++) {
        const b = entities[j];
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const minDist = a.radius + b.radius;
        const dSq = dx * dx + dz * dz;
        if (dSq >= minDist * minDist || dSq < 1e-8) continue;
        const d = Math.sqrt(dSq);
        const push = (minDist - d) * 0.5;
        const ux = dx / d, uz = dz / d;
        // Heavier bodies shove lighter ones; a boss should not be jostled by
        // the fodder around it.
        const total = a.mass + b.mass;
        const aShare = b.mass / total;
        const bShare = a.mass / total;
        a.position.x -= ux * push * 2 * aShare;
        a.position.z -= uz * push * 2 * aShare;
        b.position.x += ux * push * 2 * bShare;
        b.position.z += uz * push * 2 * bShare;
      }
    }
  }
}
