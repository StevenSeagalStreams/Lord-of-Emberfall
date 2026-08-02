import * as THREE from 'three';
import { Entity } from './Entity.js';
import * as Models from './Models.js';
import { getMonsterProfile } from '../combat/MonsterProfiles.js';
import { canCommitToAttack, propagateAggro } from '../combat/AggroPack.js';

/**
 * Hostile actor with a small behaviour state machine, driven by a per-`kind`
 * profile (src/combat/MonsterProfiles.js).
 *
 * States: idle -> alert -> chase -> attack -> reposition, plus `flank` for
 * pack members that want to fight but do not currently have an attack slot
 * (see `_canCommit`). That is the M1 pack-coordination behaviour: rather than
 * everyone queuing up to swing one at a time, only `profile.packMaxAttackers`
 * monsters commit to `attack` at once and the rest circle at a wider radius,
 * waiting for an opening -- which is what makes a pack feel like it is
 * surrounding you instead of politely taking turns.
 *
 * Two M1 kinds, genuinely different to fight:
 *   swarmer  -- fast, erratic (weaves while closing, see _followPath), low
 *               health, packs up to 3 attackers at once.
 *   skeleton -- slower, holds ground, long telegraphed wind-up, hits harder,
 *               only 2 attackers commit at once.
 * `buildMonster(kind, opts)` is used for the model if Models.js exports it
 * yet (it is being rewritten in parallel); otherwise this falls back to
 * `buildSkeleton` for every kind, per the mission brief, so a missing export
 * degrades to "wrong-looking monster" rather than a crash.
 */
export class Monster extends Entity {
  constructor(opts = {}) {
    const kind = opts.kind ?? 'skeleton';
    const profile = getMonsterProfile(kind);

    // NOTE for the report: main.js currently spawns every non-`brute` monster
    // with the same flat maxHealth fallback (46) because it does not know
    // about the swarmer/skeleton split -- it only branches on `kind ===
    // 'brute'`. If we honoured opts.maxHealth here, swarmer and skeleton
    // would have identical health and the "genuinely different to fight"
    // requirement would be dead on arrival. So the profile wins for every
    // stat that defines how a kind *fights*; only `height` (harmless per-
    // spawn visual variety) still takes the caller's value.
    super({
      type: 'monster',
      faction: 'hostile',
      radius: profile.radius,
      height: opts.height ?? profile.height,
      mass: profile.mass,
      moveSpeed: profile.moveSpeed,
      acceleration: profile.acceleration,
      friction: profile.friction,
      maxHealth: profile.maxHealth,
      armor: profile.armor,
      critChance: profile.critChance,
      critMultiplier: profile.critMultiplier,
    });

    this.kind = kind;
    this.profile = profile;

    const { rig, materials } = Monster._buildModel(kind, this.height);
    this.setRig(rig, {
      strideLength: profile.strideLength,
      bounce: profile.bounce,
      weight: profile.weight,
      idleSway: profile.idleSway,
    });
    this.materials = materials;

    this.state = 'idle';
    this.stateTime = 0;

    this.aggroRange = opts.aggroRange ?? profile.aggroRange;
    this.leashRange = opts.leashRange ?? profile.leashRange;
    this.attackRange = opts.attackRange ?? profile.attackRange;
    this.attackDamage = opts.attackDamage ?? profile.attackDamage;
    this.attackDuration = profile.attackDuration;
    this.attackCooldown = 0;
    this.attackInterval = profile.attackInterval;

    this.experienceValue = opts.experienceValue ?? profile.experienceValue;
    this.spawnPoint = new THREE.Vector3();

    this._repathTimer = 0;
    // Desynchronise the pack: without a per-monster offset, a group repaths on
    // the same frame and you get a visible hitch every time they all think.
    this._repathOffset = Math.random() * 0.4;
    this._circleDir = Math.random() < 0.5 ? -1 : 1;
    this._erraticPhase = Math.random() * Math.PI * 2;
  }

  static _buildModel(kind, height) {
    if (typeof Models.buildMonster === 'function') {
      try {
        const built = Models.buildMonster(kind, { height });
        if (built && built.rig) return built;
      } catch (err) {
        console.warn(`[Monster] buildMonster('${kind}') failed, falling back to buildSkeleton`, err);
      }
    }
    return Models.buildSkeleton({ height });
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
  }

  /** Is there an open attack slot for this pack right now? */
  _canCommit(world) {
    return canCommitToAttack(this, world.monsters || [], this.profile.packMaxAttackers);
  }

  /**
   * Aggro propagation: taking a hit wakes idle neighbours within
   * `profile.alertRadius`, and wakes the victim itself if it was still idle.
   * That single override is what makes "hit one, wake the pack" work for
   * both kinds without any change to Entity.damage().
   */
  damage(amount, source = null, opts = {}) {
    if (!this.alive) return 0;
    const dealt = super.damage(amount, source, opts);
    if (this._world) {
      if (this.state === 'idle') this.setState('alert');
      propagateAggro(this, this._world.monsters || [], this.profile.alertRadius);
    }
    return dealt;
  }

  /**
   * Swarmers weave side to side while closing distance instead of beelining,
   * which is most of what makes them read as erratic/darting rather than
   * just "fast skeleton". Skeletons barely weave (profile.erratic is small),
   * so they read as deliberate.
   */
  _followPath(dt) {
    const desired = super._followPath(dt);
    if (this.profile.erratic > 0.25 && desired.lengthSq() > 0.0001) {
      this._erraticPhase += dt * (3 + this.profile.erratic * 4);
      const jag = Math.sin(this._erraticPhase) * this.profile.erratic * 0.55;
      const px = -desired.z, pz = desired.x; // perpendicular to travel
      desired.x += px * jag;
      desired.z += pz * jag;
      if (desired.lengthSq() > 0.0001) desired.normalize();
    }
    return desired;
  }

  update(dt, world) {
    if (!this.alive) { super.update(dt, world); return; }

    this.stateTime += dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    this._repathTimer -= dt;

    const player = world.player;
    const playerUp = !!(player && player.alive);
    const dist = playerUp ? this.distanceTo(player) : Infinity;

    // Every state past 'idle' assumes a live player to react to. If the
    // player dies (or is simply absent, e.g. a stray monster in a scene
    // without one) mid-behaviour, fall back to idle rather than dereferencing
    // a dead/missing target.
    if (this.state !== 'idle' && !playerUp) {
      this.setState('idle');
      this.clearPath();
      super.update(dt, world);
      return;
    }

    switch (this.state) {
      case 'idle':
        if (playerUp && dist < this.aggroRange) this.setState('alert');
        break;

      case 'alert':
        // A beat of hesitation before charging. Instant aggro reads as robotic;
        // a short tell lets the player see the pack wake up.
        this.faceTowards(player.position.x, player.position.z);
        if (this.stateTime > 0.28) this.setState('chase');
        break;

      case 'chase': {
        if (dist > this.leashRange) { this.setState('idle'); this.clearPath(); break; }
        if (dist <= this.attackRange) {
          this.setState(this._canCommit(world) ? 'attack' : 'flank');
          this.clearPath();
          break;
        }
        if (this._repathTimer <= 0) {
          this._repathTimer = 0.35 + this._repathOffset;
          const p = world.nav?.path(
            this.position.x, this.position.z,
            player.position.x, player.position.z
          );
          if (p) this.setPath(p);
        }
        break;
      }

      // Not enough attack slots free right now -- circle at a wider radius,
      // watching for an opening, instead of queueing into the player's face.
      case 'flank': {
        if (dist > this.leashRange) { this.setState('idle'); this.clearPath(); break; }
        if (dist > this.attackRange * 2.6) { this.setState('chase'); break; }
        this.faceTowards(player.position.x, player.position.z);
        if (dist <= this.attackRange * 1.15 && this._canCommit(world)) {
          this.setState('attack');
          this.clearPath();
          break;
        }
        this._erraticPhase += dt * (1.4 + this.profile.erratic * 2.6);
        const ang = Math.atan2(
          this.position.x - player.position.x,
          this.position.z - player.position.z
        ) + this._circleDir * (0.65 + Math.sin(this._erraticPhase) * 0.3 * this.profile.erratic);
        const r = this.attackRange * this.profile.circleRadiusMul * 1.6;
        this.setPath([{
          x: player.position.x + Math.sin(ang) * r,
          z: player.position.z + Math.cos(ang) * r,
        }]);
        break;
      }

      case 'attack': {
        this.clearPath();
        this.faceTowards(player.position.x, player.position.z);
        if (dist > this.attackRange * 1.25) { this.setState('chase'); break; }
        // stunTimer gate: a stunned monster must not be able to *start* a new
        // swing just because its cooldown happened to expire mid-stun -- the
        // player's stun (Frost Nova) needs to actually stop attacks, not just
        // footwork, or "barely recoverable by skill" is a lie.
        if (this.attackCooldown <= 0 && this.stunTimer <= 0 && !this.animator.busy) {
          this.attackCooldown = this.attackInterval;
          const p = this.profile;
          // The wind-up must be visible: skeletons get a long, deliberate
          // telegraph (impact fires late in a long swing), swarmers get a
          // quick snap. Both are just the animation timing this monster
          // requests -- no separate "telegraph" system needed.
          this.animator.play('attackSwing', this.attackDuration, {
            events: [
              { at: p.whooshEventAt, name: 'whoosh' },
              { at: p.windupEventAt, name: 'impact' },
            ],
            onEvent: (name) => {
              if (name !== 'impact') return;
              if (!player.alive) return;
              if (this.distanceTo(player) > this.attackRange * 1.3) return;
              const dir = new THREE.Vector3(
                player.position.x - this.position.x, 0, player.position.z - this.position.z
              ).normalize();
              const variance = 1 + (Math.random() * 2 - 1) * p.attackVariance;
              player.damage(this.attackDamage * variance, this, { direction: dir, stagger: p.stagger });
              // Knockback, hit-stop, crit, camera shake and combat:hit are all
              // resolved centrally inside player.damage() -> Entity.damage().
            },
          });
          this.setState('reposition');
        }
        break;
      }

      case 'reposition': {
        // Strafe around the player while the swing recovers, then re-offer
        // the attack slot to the pack coordinator.
        if (this.stateTime > this.profile.repositionTime) {
          if (dist <= this.attackRange * 1.2 && this._canCommit(world)) this.setState('attack');
          else this.setState(dist <= this.attackRange * 2.2 ? 'flank' : 'chase');
          break;
        }
        this.faceTowards(player.position.x, player.position.z);
        const ang = Math.atan2(
          this.position.x - player.position.x,
          this.position.z - player.position.z
        ) + this._circleDir * 0.9;
        const r = this.attackRange * this.profile.circleRadiusMul * 0.95;
        this.setPath([{
          x: player.position.x + Math.sin(ang) * r,
          z: player.position.z + Math.cos(ang) * r,
        }]);
        break;
      }
      default: break;
    }

    super.update(dt, world);
  }

  kill(source) {
    const wasAlive = this.alive;
    super.kill(source);
    if (wasAlive) this._deathAt = performance.now();
  }
}
