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
    frostnova: (p, def) => bus?.emit?.('fx:request', { kind: def.castFx, position: headPos(p), scale: 1.3 }),
  };

  // ---- per-skill resolution (runs on the cast's 'impact' animation event) -
  const RESOLVE = {
    firebolt(p, def) {
      const target = pickTarget(p, def.range);
      if (!target) return; // a whiffed builder still visibly casts, just finds nothing to hit
      const dir = dirTo(p, target);
      const dmg = rollDamage(def.damage);
      target.damage(dmg, p, { direction: dir });
      target.applyDot?.({
        amount: def.burn.amount, ticks: def.burn.ticks, interval: def.burn.interval,
        source: p, maxStacks: def.burn.maxStacks,
      });
      bus?.emit?.('fx:request', { kind: def.impactFx, position: headPos(target), direction: { x: dir.x, y: 0, z: dir.z }, scale: 1 });
    },

    arcstorm(p, def) {
      const hits = hostilesInRadius(p, def.radius);
      for (const target of hits) {
        const dir = dirTo(p, target);
        const dmg = rollDamage(def.damage);
        target.damage(dmg, p, { direction: dir, knockback: def.knockback });
        bus?.emit?.('fx:request', { kind: def.arcFx, position: headPos(p), direction: { x: dir.x, y: 0, z: dir.z }, scale: 1.2 });
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
