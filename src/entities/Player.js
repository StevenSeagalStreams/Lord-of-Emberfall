import * as THREE from 'three';
import { Entity } from './Entity.js';
import { buildWarrior, buildSword } from './Models.js';
import { AttackState } from '../combat/AttackState.js';

/** Seconds since the last combat action before life regen resumes -- the D1
 *  rule ("life does not regenerate in combat") needs a definition of
 *  "in combat" narrower than "has ever been hit". A retreat that survives
 *  this long has genuinely disengaged. */
const COMBAT_LOCKOUT = 5.0;

/**
 * The player character.
 *
 * Input model follows the genre: left-click moves, left-click on a hostile
 * attacks, holding left-click re-issues the order each frame. Force-stand
 * (shift) attacks in place. The critical detail is the *attack lunge*: when
 * the target is just out of reach, the character steps in rather than
 * refusing to swing, which is what makes melee feel responsive.
 *
 * Attack timing (input buffering + animation cancelling) is delegated to
 * `AttackState` (src/combat/AttackState.js) rather than reimplemented here --
 * see that file for the actual front-half-locked / back-half-cancellable /
 * single-slot-buffer mechanics.
 */
export class Player extends Entity {
  constructor(opts = {}) {
    super({
      type: 'player',
      faction: 'player',
      radius: 0.42,
      height: 1.9,
      mass: 1.6,
      moveSpeed: 5.0,
      acceleration: 42,
      friction: 34,
      maxHealth: 220,
      armor: 5,
      critChance: 0.12,
      critMultiplier: 2.0,
      ...opts,
    });

    const { rig, materials } = buildWarrior({ height: this.height, build: 1.18 });
    this.setRig(rig, { strideLength: 1.25, bounce: 1.0, weight: 1.25 });
    this.materials = materials;

    this.weapon = buildSword({ materials });
    // Grip pose: the blade points up-forward out of the fist, not straight
    // down the arm axis.
    this.weapon.rotation.set(-Math.PI * 0.52, 0, 0.12);
    this.weapon.position.set(0, -0.06, 0.02);
    rig.bones.handR.add(this.weapon);

    this.attackRange = opts.attackRange ?? 2.25;
    this.attackDuration = opts.attackDuration ?? 0.62;
    // impactAt=0.42 matches the swing's own damage-event timing (see
    // attack() below) -- that is the frame the back half becomes cancellable.
    this._attackState = new AttackState({ impactAt: 0.42, whooshAt: 0.30 });

    this.maxMana = opts.maxMana ?? 90;
    this.mana = this.maxMana;
    this.manaRegen = 3.2;
    // D1 rule: life does NOT regenerate in combat -- potions and leech only.
    // See `inCombat` / COMBAT_LOCKOUT below for what "in combat" means here.
    this.healthRegen = 0.6;
    this._combatTimer = COMBAT_LOCKOUT + 1; // start fully "out of combat"

    this.level = 1;
    this.experience = 0;

    /** @type {Entity|null} */
    this.target = null;
    this.moveOrder = null;

    this._tmpDir = new THREE.Vector3();
  }

  /** True while a fight is live enough that health regen must stay off. */
  get inCombat() {
    return this._combatTimer < COMBAT_LOCKOUT || !!(this.target && this.target.alive);
  }

  /** Any hit landing on the player restarts the no-regen clock. */
  damage(amount, source = null, opts = {}) {
    this._combatTimer = 0;
    return super.damage(amount, source, opts);
  }

  /** Issue a move order to a world position. */
  orderMove(worldX, worldZ, nav) {
    this.target = null;
    this.moveOrder = { x: worldX, z: worldZ };
    const p = nav.path(this.position.x, this.position.z, worldX, worldZ);
    if (p) this.setPath(p);
  }

  /** Issue an attack order against an entity. */
  orderAttack(entity, nav) {
    this.target = entity;
    this.moveOrder = null;
    if (this.distanceTo(entity) > this.attackRange * 0.85) {
      const p = nav.path(this.position.x, this.position.z, entity.position.x, entity.position.z);
      if (p) this.setPath(p);
    } else {
      this.clearPath();
    }
  }

  /**
   * Can a *new* swing start (or cancel into) right now? True either with no
   * swing in flight, or once the in-flight swing has passed its damage event
   * -- see AttackState. This is deliberately looser than "!animator.busy":
   * that would keep gating input on the full follow-through animation
   * finishing, which is exactly the dead-frame bug the back-half cancel
   * window exists to fix.
   */
  canAttack() {
    return this._attackState.canAct(this);
  }

  /**
   * Attack lunge: a target sitting just past comfortable range still gets
   * closed on and hit, rather than the swing whiffing or the order silently
   * refusing. Combat readability lives and dies on this -- a click that
   * visibly doesn't connect reads as broken input, not as "out of range".
   * This is a direct, decaying velocity nudge (reuses the knockback impulse
   * channel) rather than a teleport, so it still looks like a real step.
   */
  _lungeToward(target) {
    if (!target || !target.alive) return;
    const d = this.distanceTo(target);
    const gap = d - this.attackRange * 0.55;
    if (gap <= 0) return;
    const lunge = Math.min(gap, this.attackRange * 0.55);
    const dx = target.position.x - this.position.x;
    const dz = target.position.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    this.knockback.x += (dx / len) * lunge * 9;
    this.knockback.z += (dz / len) * lunge * 9;
  }

  /**
   * @param onImpact called at the frame the blade should connect ('impact')
   *   and at the telegraph frame ('whoosh').
   * @returns true if a swing started THIS call, false if it was buffered (or
   *   refused outright -- dead/stunned). A buffered request is not lost: it
   *   fires on its own the instant the in-flight swing's damage event lands,
   *   see AttackState._fireEvent -- the caller does not need to retry it.
   */
  attack(onImpact) {
    return this._attackState.request(this, {
      name: 'attackSwing',
      duration: this.attackDuration,
      onStart: () => { this._combatTimer = 0; this._lungeToward(this.target); },
      onImpact,
    });
  }

  update(dt, world) {
    // A stagger should cancel a queued follow-up swing, not politely honour
    // it once the stun wears off -- see AttackState.request's own guard too,
    // this covers the case where the stun lands *between* attack() calls.
    if (this.stunTimer > 0) this._attackState.clearBuffer();
    // Flush a buffered swing the instant the animator frees up, even when it
    // was freed by something other than a swing finishing (a skill cast has
    // no impact-event hook back into AttackState) -- see tick()'s own note.
    else this._attackState.tick(this);

    this._combatTimer += dt;
    if (this.alive) {
      this.mana = Math.min(this.maxMana, this.mana + this.manaRegen * dt);
      // D1 rule: no health regen while in combat -- potions/leech only.
      if (!this.inCombat) {
        this.health = Math.min(this.maxHealth, this.health + this.healthRegen * dt);
      }
    }

    // Re-path toward a moving target, but only when it has drifted far enough
    // to matter -- repathing every frame burns CPU and produces jitter.
    if (this.target && this.target.alive) {
      const d = this.distanceTo(this.target);
      if (d <= this.attackRange) {
        this.clearPath();
        this.faceTowards(this.target.position.x, this.target.position.z);
      } else if (!this.path || this.pathIndex >= this.path.length - 1) {
        const p = world.nav?.path(
          this.position.x, this.position.z,
          this.target.position.x, this.target.position.z
        );
        if (p) this.setPath(p);
      }
    } else if (this.target && !this.target.alive) {
      this.target = null;
    }

    super.update(dt, world);
  }
}
