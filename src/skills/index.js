import { SKILLS } from './SkillDefs.js';

/**
 * Skills subsystem entry point.
 *
 * Owns cooldowns, mana costs, and the hotbar binding that turns a keypress
 * into a cast for the three Gate 1 skills (SkillDefs.js). The animation lock
 * itself is just the player's own animator ('cast' pose, same layering
 * Animation.js already gives 'attackSwing') -- no separate lock timer to
 * desync from it. Visual results are requested via `fx:request` only; this
 * file never imports src/fx.
 *
 * main.js's fixed phase order does not call `skills.cast(slot)` for us (see
 * the mission report), so `update(dt)` polls `ctx.input.pressed(...)` itself
 * every frame -- `pressed()` is already edge-triggered and cleared at the end
 * of the real frame by `Input.endFrame()`, so this is exactly as responsive
 * as an explicit event would be, just read here instead of pushed here.
 */
export function createSkills(ctx) {
  const { bus, input, world, rng } = ctx;

  const cooldowns = Object.create(null);
  for (const id in SKILLS) cooldowns[id] = 0;

  function player() {
    return world.player;
  }

  /** Same animation-lock contract as melee: cannot cast through a cast, a
   *  stun, death, a cooldown, or insufficient mana. Unlike melee attacks,
   *  skills are NOT buffered/cancellable once THEY are the thing in flight --
   *  "animation lock ... actually blocks" is the explicit Gate 1
   *  verification requirement, and a cast is a deliberate commitment, not a
   *  filler swing.
   *
   *  A melee swing's own CANCELLABLE back half is the one exception, and it
   *  is load-bearing, not a nicety: main.js's auto-swing re-issues attack()
   *  every frame a live target sits in melee range, which used to mean the
   *  animator was locked into an unbroken attackSwing chain for the entire
   *  fight -- a skill hotkey press was silently swallowed by `p.animator
   *  ?.busy` every single frame, with no mana spent, no cooldown started,
   *  nothing. That is the actual root cause behind "the spells and attacks
   *  are not hitting the mobs": the RESOLVE functions below were never even
   *  reached, because canCast() never once returned true while the player
   *  had a target in range -- see the report and Player.canAttack()'s own
   *  doc comment (Player.js is the other half of this fix: it makes the
   *  auto-swing yield the window on the frame a skill key is pressed, so
   *  that window is actually open here when polled). Treating "busy but the
   *  swing is in its cancellable back half" as castable, exactly the same
   *  rule AttackState already applies to melee cancelling into melee, is
   *  what lets a skill actually interrupt an attack instead of queueing
   *  behind an auto-swing chain that never ends. */
  function canCast(id) {
    const def = SKILLS[id];
    const p = player();
    if (!def || !p || !p.alive) return false;
    if (p.stunTimer > 0) return false;
    if (cooldowns[id] > 0) return false;
    if (p.mana < def.manaCost) return false;
    const swingGate = p._attackState ? p._attackState.canAct(p) : !p.animator?.busy;
    if (!swingGate) return false;
    return true;
  }

  function dirTo(from, to) {
    const dx = to.position.x - from.position.x;
    const dz = to.position.z - from.position.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  function headPos(e) {
    return { x: e.position.x, y: e.position.y + e.height * 0.55, z: e.position.z };
  }

  function rollDamage([lo, hi]) {
    return rng && typeof rng.range === 'function' ? rng.range(lo, hi) : lo + Math.random() * (hi - lo);
  }

  /** The player's current target if alive and in range, else the nearest
   *  live hostile in range -- a ranged skill should not require re-clicking
   *  a target you already have selected. */
  function pickTarget(p, range) {
    if (p.target && p.target.alive && p.distanceTo(p.target) <= range) return p.target;
    let best = null, bestD = range;
    for (const m of world.monsters || []) {
      if (!m.alive) continue;
      const d = p.distanceTo(m);
      if (d <= bestD) { bestD = d; best = m; }
    }
    return best;
  }

  function hostilesInRadius(p, radius) {
    const out = [];
    for (const m of world.monsters || []) {
      if (m.alive && p.distanceTo(m) <= radius) out.push(m);
    }
    return out;
  }

  // ---- cast-beat fx (runs on the 'whoosh' event, early in the lock -- the
  // caster visibly gathers energy well before the hit lands, same as the
  // melee swing's own whoosh/impact split) ---------------------------------
  const CASTFX = {
    firebolt: (p, def) => bus?.emit?.('fx:request', { kind: def.castFx, position: headPos(p), scale: 1 }),
    arcstorm: (p, def) => bus?.emit?.('fx:request', { kind: def.castFx, position: headPos(p), scale: 1.2 }),
    frostnova: (p, def) => {
      bus?.emit?.('fx:request', { kind: def.castFx, position: headPos(p), scale: 1.3 });
      // G4's sibling fix: an expanding ring so the player can SEE the radius
      // and who it is about to catch, not just find out from the numbers
      // afterwards. `scale` here IS the ring's terminal radius, not a generic
      // magnitude multiplier -- see SkillFX.frostRing's own doc comment.
      bus?.emit?.('fx:request', { kind: def.ringFx, position: headPos(p), scale: def.radius });
    },
  };

  // ---- in-flight projectiles ----------------------------------------------
  // Firebolt no longer resolves on cast (G3): the cast's 'impact' animation
  // event only LAUNCHES a travelling bolt (launchFirebolt, below); the bolt
  // itself carries the damage/burn roll and applies it on arrival, in
  // updateProjectiles(). This is the thing that makes a projectile feel like
  // a projectile instead of two puffs with nothing between them -- see G3 in
  // PLAYTEST_FEEDBACK.md and the "Projectile stages" section of
  // ARCHITECTURE.md.
  const projectiles = [];

  function findMonsterById(id) {
    for (const m of world.monsters || []) if (m.id === id) return m;
    return null;
  }

  function lerp(a, b, u) { return a + (b - a) * u; }

  /** Launches on the cast's 'impact' animation event (the frame the hand
   *  releases the bolt) -- NOT a resolve. No target in range still means a
   *  whiffed builder that visibly casts and hits nothing. */
  function launchFirebolt(p, def) {
    const target = pickTarget(p, def.range);
    if (!target) return;
    const start = headPos(p);
    const dest = headPos(target);
    const dist = Math.hypot(dest.x - start.x, dest.z - start.z) || 0.001;
    const speed = def.travelSpeed ?? 30;
    const duration = Math.min(def.travelMax ?? 0.3, Math.max(def.travelMin ?? 0.15, dist / speed));
    projectiles.push({
      def, source: p, targetId: target.id,
      x0: start.x, y0: start.y, z0: start.z,
      // Re-homing fallback (ARCHITECTURE.md's `targetId`): tracks the live
      // target's head position every tick below; if the target dies or is
      // removed from the world before arrival, flight freezes on the last
      // point it was actually seen at, instead of flying at a stale spot
      // forever or damaging a target that no longer exists.
      lastX: dest.x, lastY: dest.y, lastZ: dest.z,
      t: 0, duration,
      dmg: rollDamage(def.damage),
    });
  }

  /** Advances every in-flight bolt, emits its travel fx for the frame, and
   *  resolves damage/impact fx exactly once on arrival. Runs every tick
   *  regardless of animator/input state so a bolt already in the air keeps
   *  flying even if, say, the caster is stunned the instant after release. */
  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      pr.t += dt;
      const u = Math.min(1, pr.t / pr.duration);

      const live = findMonsterById(pr.targetId);
      if (live && live.alive) {
        const hp = headPos(live);
        pr.lastX = hp.x; pr.lastY = hp.y; pr.lastZ = hp.z;
      }

      const curX = lerp(pr.x0, pr.lastX, u);
      const curY = lerp(pr.y0, pr.lastY, u);
      const curZ = lerp(pr.z0, pr.lastZ, u);

      bus?.emit?.('fx:request', {
        kind: pr.def.travelFx,
        position: { x: curX, y: curY, z: curZ },
        target: { x: pr.lastX, y: pr.lastY, z: pr.lastZ },
        scale: 1,
      });

      if (u >= 1) {
        projectiles.splice(i, 1);
        const dl = Math.hypot(pr.lastX - pr.x0, pr.lastZ - pr.z0) || 1;
        const dir = { x: (pr.lastX - pr.x0) / dl, z: (pr.lastZ - pr.z0) / dl };
        if (live && live.alive) {
          live.damage(pr.dmg, pr.source, { direction: dir });
          live.applyDot?.({
            amount: pr.def.burn.amount, ticks: pr.def.burn.ticks, interval: pr.def.burn.interval,
            source: pr.source, maxStacks: pr.def.burn.maxStacks,
          });
          bus?.emit?.('fx:request', { kind: pr.def.impactFx, position: headPos(live), direction: { x: dir.x, y: 0, z: dir.z }, scale: 1 });
        } else {
          // Target died or was removed mid-flight -- impact at the last
          // point it was actually seen at rather than hitting nothing.
          bus?.emit?.('fx:request', { kind: pr.def.impactFx, position: { x: pr.lastX, y: pr.lastY, z: pr.lastZ }, direction: { x: dir.x, y: 0, z: dir.z }, scale: 1 });
        }
      }
    }
  }

  // ---- per-skill resolution (runs on the cast's 'impact' animation event) -
  const RESOLVE = {
    // Firebolt's 'impact' event only releases the bolt now -- see
    // launchFirebolt/updateProjectiles above.
    firebolt: launchFirebolt,

    arcstorm(p, def) {
      const hits = hostilesInRadius(p, def.radius);
      for (const target of hits) {
        const dir = dirTo(p, target);
        const dmg = rollDamage(def.damage);
        target.damage(dmg, p, { direction: dir, knockback: def.knockback });
        // Lightning is instant -- no travel stage -- but it must terminate
        // ON the victim (G4): `target` is the endpoint every arc actually
        // spans to, not a hardcoded length down `direction`.
        bus?.emit?.('fx:request', { kind: def.arcFx, position: headPos(p), direction: { x: dir.x, y: 0, z: dir.z }, target: headPos(target), scale: 1.2 });
        bus?.emit?.('fx:request', { kind: def.impactFx, position: headPos(target), direction: { x: dir.x, y: 0, z: dir.z }, scale: 1 });
      }
    },

    frostnova(p, def) {
      const hits = hostilesInRadius(p, def.radius);
      for (const target of hits) {
        const dir = dirTo(p, target);
        const dmg = rollDamage(def.damage);
        target.damage(dmg, p, { direction: dir, stun: def.stun });
        target.applySlow?.(def.slow.duration, def.slow.factor);
        bus?.emit?.('fx:request', { kind: def.impactFx, position: headPos(target), direction: { x: dir.x, y: 0, z: dir.z }, scale: 1 });
      }
    },
  };

  /** Attempt to cast `id` right now. Returns true if it actually fired. */
  function cast(id) {
    const def = SKILLS[id];
    const p = player();
    if (!canCast(id)) return false;

    p.mana -= def.manaCost;
    cooldowns[id] = def.cooldown;
    // Casting is a combat action -- restart the D1 no-regen-in-combat clock
    // the same way a melee swing does (Player.attack()'s onStart does this
    // for swings; skills need the same guard or you could kite-and-cast your
    // way to free regen).
    if (typeof p._combatTimer === 'number') p._combatTimer = 0;

    p.animator.play('cast', def.lockDuration, {
      events: [{ at: def.whooshAt, name: 'whoosh' }, { at: def.impactAt, name: 'impact' }],
      onEvent: (name) => {
        if (name === 'whoosh') CASTFX[id]?.(p, def);
        if (name === 'impact') RESOLVE[id]?.(p, def);
      },
    });
    return true;
  }

  return {
    update(dt) {
      for (const id in cooldowns) {
        if (cooldowns[id] > 0) cooldowns[id] = Math.max(0, cooldowns[id] - dt);
      }
      // Bolts already in flight keep flying regardless of input/player state
      // -- a projectile that has left the caster's hand does not care that,
      // say, the caster is stunned the instant after release.
      updateProjectiles(dt);
      if (!player() || !input) return;
      for (const id in SKILLS) {
        if (input.pressed(SKILLS[id].key)) cast(id);
      }
    },
    /** Explicit slot API, keyed by skill id (also reachable by key via update()). */
    cast,
    canCast,
    cooldowns,
    dispose() {},
  };
}
