import * as THREE from 'three';
import { Entity } from './Entity.js';
import { buildWarrior, buildSword } from './Models.js';
import { AttackState } from '../combat/AttackState.js';
import { SKILLS } from '../skills/SkillDefs.js';
import { TILE } from '../world/LevelBuilder.js';

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
   * Continuous hold-to-move/hold-to-attack order -- the F1 gate fix. Diablo
   * players hold the left button down; main.js's input block calls this
   * every frame the button is down (see the report for the exact one-line
   * snippet, main.js is not mine to edit), instead of only issuing an order
   * on the down-edge. A single click is just a hold that happens to last one
   * frame, so this one method covers both -- "a single click still works as
   * a discrete order" falls out for free rather than needing a second code
   * path.
   *
   * @param {number} worldX/worldZ  live cursor ground position, re-supplied
   *   every frame as the cursor moves.
   * @param {*} nav  world.nav (NavGrid) -- used both for A* and lineOfSight.
   * @param {Entity|null} [hoveredHostile]  the live entity under the cursor
   *   this frame, if any and hostile -- holding over it attacks it
   *   continuously instead of walking into it.
   *
   * Responsiveness: for a target in open line of sight this steers straight
   * at the live cursor position every frame (setPath() on a single waypoint
   * is just writing an array -- no A* call, so no per-frame repath hitch).
   * A* only runs when the direct line is blocked, and even then only when
   * the held point has actually moved enough to matter or the current path
   * has run out -- not on every single blocked frame.
   */
  orderHold(worldX, worldZ, nav, hoveredHostile = null) {
    if (hoveredHostile && hoveredHostile.alive) {
      // Re-affirm only on a NEW target -- once engaged, Entity/Player's own
      // update() already re-paths toward a moving live target every frame
      // (see update() below) and main.js's auto-swing handles the actual
      // hits, so calling orderAttack() again here every single held frame
      // would just be redundant re-pathing work for the same outcome.
      if (this.target !== hoveredHostile) this.orderAttack(hoveredHostile, nav);
      this._heldGroundTarget = null;
      return;
    }

    this.target = null;
    this.moveOrder = { x: worldX, z: worldZ };

    const dx = worldX - this.position.x, dz = worldZ - this.position.z;
    if (Math.hypot(dx, dz) < this.arriveRadius) {
      // Already basically there -- let friction settle instead of chasing a
      // fractional-unit target forever, which would read as a jitter/vibrate
      // right under the cursor.
      this.clearPath();
      this._heldGroundTarget = null;
      return;
    }

    if (this._hasLineOfSight(worldX, worldZ, nav)) {
      this._heldGroundTarget = null;
      this.setPath([{ x: worldX, z: worldZ }]);
      return;
    }

    // Blocked: only re-run A* when the held point has drifted enough to
    // matter, or the existing path has run out -- a cursor held roughly
    // still (or jittering by a pixel) over the same rough spot must not
    // re-path every frame, which is exactly the hitch the mission calls out.
    const last = this._heldGroundTarget;
    const drifted = !last || Math.hypot(last.x - worldX, last.z - worldZ) > 0.75;
    const exhausted = !this.path || this.pathIndex >= this.path.length - 1;
    if (drifted || exhausted) {
      const p = nav?.path(this.position.x, this.position.z, worldX, worldZ);
      if (p) {
        this.setPath(p);
        this._heldGroundTarget = { x: worldX, z: worldZ };
      }
    }
  }

  /**
   * Straight-line-of-sight test between the player and a world point, using
   * the same world<->grid conversion nav.path() applies internally --
   * NavGrid.lineOfSight() takes grid cell coordinates, not world units.
   */
  _hasLineOfSight(worldX, worldZ, nav) {
    if (!nav || typeof nav.lineOfSight !== 'function') return false;
    return nav.lineOfSight(
      Math.round(this.position.x / TILE), Math.round(this.position.z / TILE),
      Math.round(worldX / TILE), Math.round(worldZ / TILE)
    );
  }

  /**
   * Can a *new* swing start (or cancel into) right now? True either with no
   * swing in flight, or once the in-flight swing has passed its damage event
   * -- see AttackState. This is deliberately looser than "!animator.busy":
   * that would keep gating input on the full follow-through animation
   * finishing, which is exactly the dead-frame bug the back-half cancel
   * window exists to fix.
   *
   * @param {import('../core/Input.js').Input} [input] When given, a frame on
   *   which the player has a skill hotkey freshly pressed refuses -- this is
   *   the fix for the root cause of "spells don't hit anything": main.js's
   *   auto-swing re-issues `attack()` every single frame a live target sits
   *   in melee range, so it was re-locking the animator into an unbroken
   *   attackSwing chain and stealing the cancellable window before the
   *   skills subsystem (which polls input later in the same frame, see
   *   skills/index.js) ever got a chance to claim it. canCast()/cast() were
   *   made to accept the cancellable window (mirroring melee's own
   *   cancel-into-itself rule) in the same fix, but that only matters if
   *   auto-swing yields the window in the first place -- hence this check.
   *   A direct attack() call from an explicit click order does not pass
   *   `input` and is unaffected; only the passive auto-swing-while-in-range
   *   path needs to yield.
   */
  canAttack(input) {
    if (input && this._wantsSkillCast(input)) return false;
    return this._attackState.canAct(this);
  }

  /** True if any Gate-1 skill hotkey was freshly pressed this frame. */
  _wantsSkillCast(input) {
    for (const id in SKILLS) {
      if (input.pressed(SKILLS[id].key)) return true;
    }
    return false;
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
