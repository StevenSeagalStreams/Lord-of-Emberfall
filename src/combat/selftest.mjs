#!/usr/bin/env node
/**
 * Plain-node self-test for the combat pillar. No browser, no THREE renderer,
 * no harness -- run with:
 *
 *   node src/combat/selftest.mjs
 *
 * Entity.js only depends on THREE's CPU-side math classes (Vector3, Group,
 * MathUtils) and Animation.js (also pure), so real Entity instances can be
 * constructed and driven here without a rig/canvas/WebGL context. This tests
 * the actual production code, not a reimplementation of it.
 */
import * as THREE from 'three';
import { Entity, resolveOverlaps } from '../entities/Entity.js';
import { armorReduction, computeDamage, DAMAGE_TUNING } from './Damage.js';
import { knockbackForce } from './Knockback.js';
import { HitStop, HITSTOP_MAX_FRAMES } from './HitStop.js';
import { committedAttackers, canCommitToAttack, propagateAggro } from './AggroPack.js';
import { AttackState } from './AttackState.js';
import { Player } from '../entities/Player.js';
import { Monster } from '../entities/Monster.js';
import { createSkills } from '../skills/index.js';
import { SKILLS } from '../skills/SkillDefs.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}

function isCleanNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n);
}

// ---------------------------------------------------------------------------
console.log('\n[1] damage never produces NaN, across adversarial inputs');
// ---------------------------------------------------------------------------
{
  const adversarial = [
    { baseAmount: 0 },
    { baseAmount: -50 },
    { baseAmount: NaN },
    { baseAmount: Infinity },
    { baseAmount: 20, armor: NaN },
    { baseAmount: 20, armor: -100 },
    { baseAmount: 20, armor: Infinity },
    { baseAmount: 20, critChance: NaN },
    { baseAmount: 20, critChance: -5 },
    { baseAmount: 20, critChance: 5 },
    { baseAmount: 20, critMultiplier: NaN },
    { baseAmount: 20, critMultiplier: -3 },
    { baseAmount: 20, critChance: 1, critMultiplier: 0 },
    { baseAmount: undefined },
    { baseAmount: null },
    {},
  ];
  let allClean = true;
  for (const input of adversarial) {
    const r = computeDamage(input);
    if (!isCleanNumber(r.amount) || r.amount < 0) {
      allClean = false;
      console.log('    bad result for', input, '->', r);
    }
  }
  check('computeDamage(...) is always a finite, non-negative number', allClean);

  // rollCrit with a garbage rng (returns NaN/undefined) must not crash and
  // must not silently always-crit.
  const weirdRng = () => NaN;
  const r2 = computeDamage({ baseAmount: 30, critChance: 0.5, rng: weirdRng });
  check('computeDamage tolerates a broken rng function', isCleanNumber(r2.amount));
}

// ---------------------------------------------------------------------------
console.log('\n[2] armour reduction is monotonic and bounded');
// ---------------------------------------------------------------------------
{
  const samples = [0, 1, 2, 5, 10, 20, 45, 80, 150, 400, 1000, 1e6];
  let monotonic = true;
  let bounded = true;
  let prev = -Infinity;
  for (const a of samples) {
    const r = armorReduction(a);
    if (r < prev - 1e-9) monotonic = false;
    if (r < 0 || r > DAMAGE_TUNING.MAX_ARMOR_REDUCTION + 1e-9) bounded = false;
    prev = r;
  }
  check('armorReduction(armor) is non-decreasing as armor rises', monotonic);
  check(`armorReduction(armor) never exceeds MAX_ARMOR_REDUCTION (${DAMAGE_TUNING.MAX_ARMOR_REDUCTION})`, bounded);
  check('armorReduction(0) === 0 (no free mitigation)', armorReduction(0) === 0);
  check('armorReduction handles negative/NaN armour without going negative or NaN',
    armorReduction(-50) === 0 && armorReduction(NaN) === 0);

  // Bounded reduction means armour can never fully negate a hit.
  const hit = computeDamage({ baseAmount: 100, armor: 1e9 });
  check('even absurd armour leaves some damage through', hit.amount > 0);
}

// ---------------------------------------------------------------------------
console.log('\n[3] knockback scales inversely with mass');
// ---------------------------------------------------------------------------
{
  // (a) the pure force function: same damage in, mass is not even a param --
  // it must not appear here, since Entity.applyKnockback owns the division.
  const fLight = knockbackForce(40, { crit: false });
  const fHeavy = knockbackForce(40, { crit: false });
  check('knockbackForce(damage) is deterministic for identical inputs', fLight === fHeavy);
  check('knockbackForce(0 damage) is not negative', knockbackForce(0) >= 0);
  check('knockbackForce never returns NaN for garbage input', isCleanNumber(knockbackForce(NaN, { flat: NaN })));

  // (b) end-to-end through the real Entity/applyKnockback pipeline: a light
  // body (swarmer-like mass) must travel further than a heavy body
  // (brute-like mass) from an identical hit.
  const light = new Entity({ mass: 0.55, maxHealth: 24 });
  const heavy = new Entity({ mass: 2.4, maxHealth: 140 });
  const dir = { x: 1, z: 0 };
  const dmg = 30;
  const force = knockbackForce(dmg, { crit: false });
  light.applyKnockback(dir.x, dir.z, force);
  heavy.applyKnockback(dir.x, dir.z, force);
  const lightKb = light.knockback.length();
  const heavyKb = heavy.knockback.length();
  check('a lighter body receives more knockback than a heavier body from an identical hit',
    lightKb > heavyKb);
  check('knockback ratio roughly tracks the inverse mass ratio (within 15%)',
    Math.abs((lightKb / heavyKb) - (2.4 / 0.55)) / (2.4 / 0.55) < 0.15);

  // (c) full pipeline through Entity#damage(): a swarmer-mass victim should
  // actually be thrown (move a meaningful distance next tick); a brute-mass
  // victim should barely shift. maxHealth here is deliberately generous (not
  // the real swarmer/skeleton numbers) so the hit is non-lethal for both --
  // a killing blow goes through the death-collapse branch instead of live
  // knockback flight, which would be a different (and already covered)
  // code path, not what this check is isolating.
  HitStop.reset();
  const swarmer = new Entity({ mass: 0.55, maxHealth: 200, armor: 0 });
  const brute = new Entity({ mass: 2.4, maxHealth: 200, armor: 0 });
  const attacker = { critChance: 0, critMultiplier: 1 };
  swarmer.damage(30, attacker, { direction: dir });
  brute.damage(30, attacker, { direction: dir });
  swarmer.update(1 / 60, { colliders: null });
  brute.update(1 / 60, { colliders: null });
  check('a heavy hit throws a low-mass body (swarmer) meaningfully',
    Math.abs(swarmer.position.x) > Math.abs(brute.position.x) * 1.5);

  // (d) knockback must be a BOUNDED shove, not an unbounded/resonant fling.
  // Regression guard for a real bug this suite's own feeltest instrumentation
  // caught: folding the decaying knockback vector permanently into `velocity`
  // every frame (instead of only contributing it to that frame's position
  // delta) compounded into a multi-second, hundreds-of-metres runaway from a
  // single crit on a light body. Run a light body for many frames after one
  // hit and check total displacement stays within a small, sane multiple of
  // the theoretical impulse bound (force/mass / decayRate), never diverging.
  HitStop.reset();
  const flungLight = new Entity({ mass: 0.55, maxHealth: 1000, armor: 0, friction: 16 });
  const flingForce = knockbackForce(30, { crit: true });
  flungLight.applyKnockback(1, 0, flingForce);
  const theoreticalBound = (flingForce / Math.max(0.2, flungLight.mass)) / 9; // matches the 9 in Entity's decay
  for (let i = 0; i < 300; i++) flungLight.update(1 / 60, { colliders: null }); // 5 simulated seconds
  check(`a single knockback impulse produces a bounded total displacement (got ${flungLight.position.x.toFixed(2)}m, bound ~${theoreticalBound.toFixed(2)}m)`,
    flungLight.position.x < theoreticalBound * 3 && flungLight.position.x < 15);
  // Entity.js stops multiplying the knockback vector once it's already below
  // the "may as well be zero" epsilon guard (lengthSq < 0.0001, i.e. length
  // < 0.01) rather than paying to decay an already-imperceptible residual
  // forever -- so it settles just under that epsilon, not at exact 0.
  check('knockback decays down to (and stays at) a negligible, imperceptible residual',
    flungLight.knockback.length() < 0.01);
}

// ---------------------------------------------------------------------------
console.log('\n[4] hit-stop always releases, never permanently freezes the sim');
// ---------------------------------------------------------------------------
{
  HitStop.reset();
  check('HitStop starts released (scale 1, inactive)', HitStop.scale === 1 && !HitStop.active);

  HitStop.trigger(1000, 0); // pathological: someone asks for a 1000-frame hard freeze
  check(`trigger() clamps an absurd request to HITSTOP_MAX_FRAMES (${HITSTOP_MAX_FRAMES})`,
    HitStop.frames === HITSTOP_MAX_FRAMES);
  check('a hard freeze (factor 0) reads as fully frozen this frame', HitStop.scale === 0);

  let framesBurned = 0;
  const budget = HITSTOP_MAX_FRAMES + 5; // deliberately tick past the theoretical max
  while (HitStop.active && framesBurned < budget) {
    HitStop.tickFrame();
    framesBurned++;
  }
  check(`released within HITSTOP_MAX_FRAMES real ticks (took ${framesBurned})`,
    framesBurned <= HITSTOP_MAX_FRAMES);
  check('scale returns to 1 after release', HitStop.scale === 1);
  check('active is false after release', !HitStop.active);

  // A weaker request must never cut a stronger one short.
  HitStop.reset();
  HitStop.trigger(5, 0.04); // crit-tier freeze
  HitStop.trigger(1, 0.5);  // a trivial hit landing the same frame
  check('a weaker/shorter request does not shorten an in-flight freeze', HitStop.frames === 5);

  // Overlapping hit-stops (e.g. a cleave that lands on two monsters the same
  // frame, or a second hit landing mid-freeze) must EXTEND the freeze, not
  // deadlock the counter or get lost. Prove this two ways: (a) a longer
  // request arriving mid-freeze pushes the release further out than either
  // request alone would have, and (b) hammering trigger() every single frame
  // -- the worst-case "does this ever stop counting down" scenario -- still
  // releases within a bounded number of frames after the requests stop.
  HitStop.reset();
  HitStop.trigger(3, 0.1);
  HitStop.tickFrame();               // 1 frame burned -> 2 left
  HitStop.tickFrame();               // 2 frames burned -> 1 left
  check('mid-extend setup: 1 frame left before the overlapping trigger', HitStop.frames === 1);
  HitStop.trigger(4, 0.1);           // a second, overlapping hit lands now
  check('an overlapping request extends the freeze past where the first alone would have ended',
    HitStop.frames === 4);
  let extendBurned = 0;
  while (HitStop.active && extendBurned < HITSTOP_MAX_FRAMES + 5) { HitStop.tickFrame(); extendBurned++; }
  check('the extended freeze still releases within HITSTOP_MAX_FRAMES of its own extension',
    extendBurned <= HITSTOP_MAX_FRAMES && !HitStop.active);

  HitStop.reset();
  // Worst case: something buggy re-triggers hit-stop every single frame for a
  // while (e.g. a pack all landing hits on consecutive frames). The frame
  // counter is clamped on every write, so this can never accumulate into an
  // unbounded or permanent freeze -- it must still fully drain soon after the
  // spam stops.
  for (let i = 0; i < 50; i++) { HitStop.trigger(5, 0.05); HitStop.tickFrame(); }
  check('hammering trigger() every frame for 50 frames never exceeds HITSTOP_MAX_FRAMES',
    HitStop.frames <= HITSTOP_MAX_FRAMES);
  let drainBurned = 0;
  while (HitStop.active && drainBurned < HITSTOP_MAX_FRAMES + 5) { HitStop.tickFrame(); drainBurned++; }
  check('once the spam stops, the sim is not permanently frozen -- it drains and releases',
    drainBurned <= HITSTOP_MAX_FRAMES && !HitStop.active);
  HitStop.reset();

  // Entity.update()/resolveOverlaps() integration: with hit-stop hard-frozen,
  // an entity with velocity should barely move, and resolveOverlaps() (which
  // is the one place that ticks the frame counter) must still burn it down.
  HitStop.reset();
  HitStop.trigger(3, 0);
  const e = new Entity({ mass: 1, moveSpeed: 10, acceleration: 1000, friction: 1000 });
  e.velocity.set(5, 0, 0);
  const before = e.position.x;
  e.update(1 / 60, { colliders: null });
  const movedWhileFrozen = Math.abs(e.position.x - before);
  resolveOverlaps([], 1); // burns 1 frame, same call main.js makes every tick
  e.update(1 / 60, { colliders: null });
  resolveOverlaps([], 1);
  e.update(1 / 60, { colliders: null });
  resolveOverlaps([], 1); // 3rd tick -> hit-stop should be released now
  check('position barely advances during a hard freeze (< 10% of unfrozen distance)',
    movedWhileFrozen < (5 * (1 / 60)) * 0.1);
  check('HitStop released after exactly the requested number of resolveOverlaps() calls',
    !HitStop.active);
  HitStop.reset();
}

// ---------------------------------------------------------------------------
console.log('\n[5] pack coordination (AggroPack) helpers');
// ---------------------------------------------------------------------------
{
  const mk = (state, x, z) => ({ state, alive: true, position: { x, z }, setState(s) { this.state = s; } });
  const a = mk('attack', 0, 0);
  const b = mk('attack', 1, 0);
  const c = mk('chase', 2, 0);
  const pack = [a, b, c];
  check('committedAttackers counts only monsters in the committed state', committedAttackers(pack) === 2);
  check('canCommitToAttack refuses a 3rd attacker when max is 2', !canCommitToAttack(c, pack, 2));
  check('canCommitToAttack allows a 3rd attacker when max is 3', canCommitToAttack(c, pack, 3));

  const source = mk('chase', 0, 0);
  const near = mk('idle', 2, 0);
  const far = mk('idle', 50, 0);
  const woken = propagateAggro(source, [source, near, far], 10);
  check('propagateAggro wakes an idle neighbour within radius', near.state === 'alert');
  check('propagateAggro leaves a distant idle monster alone', far.state === 'idle');
  check('propagateAggro returns exactly the monsters it woke', woken.length === 1 && woken[0] === near);
}

// ---------------------------------------------------------------------------
console.log('\n[6] crit multiplier applies exactly once');
// ---------------------------------------------------------------------------
{
  // Direct math check: a forced crit multiplies the mitigated damage by
  // exactly critMultiplier -- not squared, not applied to armour, not
  // applied twice by some second code path.
  const base = 40;
  const armor = 10;
  const critMultiplier = 1.75;
  const noCrit = computeDamage({ baseAmount: base, armor, critMultiplier, forceCrit: false });
  const crit = computeDamage({ baseAmount: base, armor, critMultiplier, forceCrit: true });
  const expectedMitigated = base * (1 - armorReduction(armor));
  check('a non-crit hit deals exactly the mitigated amount (multiplier 1x)',
    Math.abs(noCrit.amount - expectedMitigated) < 1e-9);
  check('a forced crit deals exactly mitigated * critMultiplier, no more, no less',
    Math.abs(crit.amount - expectedMitigated * critMultiplier) < 1e-9);
  check('crit is not "double-applied": crit.amount / noCrit.amount === critMultiplier exactly',
    Math.abs(crit.amount / noCrit.amount - critMultiplier) < 1e-9);

  // End-to-end through Entity#damage(): even with the attacker rolling a
  // guaranteed crit AND the victim's own multiplier set very differently,
  // only the attacker's critMultiplier is used, applied exactly once, and
  // the `crit` flag on the emitted combat:hit event is set exactly once.
  let hitEvents = 0;
  let lastAmount = 0;
  const bus = { emit(type, payload) { if (type === 'combat:hit') { hitEvents++; lastAmount = payload.amount; } } };
  const victim = new Entity({ maxHealth: 1000, armor: 10, critMultiplier: 99 /* must be ignored -- attacker's wins */ });
  victim._world = { bus };
  const attacker = { critChance: 1, critMultiplier: 2 };
  const dealt = victim.damage(40, attacker, { crit: true });
  const expected = 40 * (1 - armorReduction(10)) * 2;
  check('Entity#damage applies the attacker\'s crit multiplier exactly once end-to-end',
    Math.abs(dealt - expected) < 1e-6);
  check('exactly one combat:hit event is emitted per damage() call', hitEvents === 1);
  check('the emitted amount matches the returned amount (single source of truth)',
    Math.abs(lastAmount - dealt) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log('\n[7] fx:request contract -- combat emits the documented vfx events');
// ---------------------------------------------------------------------------
{
  const seen = [];
  const bus = { emit(type, payload) { if (type === 'fx:request') seen.push(payload); } };

  // (a) a non-lethal hit on an unarmoured target -> blood_hit, well-shaped
  // payload, no spark, no kill.
  HitStop.reset();
  const swarmerLike = new Entity({ maxHealth: 200, armor: 0, height: 1.5 });
  swarmerLike._world = { bus };
  seen.length = 0;
  swarmerLike.damage(10, { critChance: 0 }, { direction: { x: 1, z: 0 } });
  const kinds = seen.map((e) => e.kind);
  check('a hit on an unarmoured target requests blood_hit', kinds.includes('blood_hit'));
  check('a hit on an unarmoured target does NOT request spark_metal', !kinds.includes('spark_metal'));
  for (const e of seen) {
    check(`fx:request(${e.kind}) has a well-shaped payload (position x/y/z, finite scale)`,
      isCleanNumber(e.position?.x) && isCleanNumber(e.position?.y) && isCleanNumber(e.position?.z) &&
      isCleanNumber(e.scale) && e.scale > 0);
  }

  // (b) a non-lethal hit on an armoured target -> spark_metal, not blood_hit.
  HitStop.reset();
  const skeletonLike = new Entity({ maxHealth: 200, armor: 6, height: 1.8 });
  skeletonLike._world = { bus };
  seen.length = 0;
  skeletonLike.damage(10, { critChance: 0 }, { direction: { x: 1, z: 0 } });
  const kinds2 = seen.map((e) => e.kind);
  check('a hit on an armoured target requests spark_metal, not blood_hit',
    kinds2.includes('spark_metal') && !kinds2.includes('blood_hit'));

  // (c) a heavy/crit hit also requests impact_flash, on top of the blood/spark.
  HitStop.reset();
  const critTarget = new Entity({ maxHealth: 200, armor: 0 });
  critTarget._world = { bus };
  seen.length = 0;
  critTarget.damage(20, { critChance: 0 }, { direction: { x: 1, z: 0 }, crit: true });
  const kinds3 = seen.map((e) => e.kind);
  check('a crit hit also requests impact_flash', kinds3.includes('impact_flash'));

  // (d) a killing blow requests blood_kill, with a direction matching the
  // collapse direction (the killing blow's direction).
  HitStop.reset();
  const dying = new Entity({ maxHealth: 20, armor: 0 });
  dying._world = { bus };
  seen.length = 0;
  dying.damage(999, { critChance: 0 }, { direction: { x: -1, z: 0 } });
  const killEvent = seen.find((e) => e.kind === 'blood_kill');
  check('a killing blow requests blood_kill', !!killEvent);
  check('blood_kill direction matches the killing blow\'s direction',
    killEvent && Math.sign(killEvent.direction.x) === -1);

  // (e) footstep dust: a moving entity eventually requests dust_step, a
  // stationary one never does.
  HitStop.reset();
  // NB: update(dt, world) unconditionally sets `this._world = world` at the
  // top (Entity.js needs the fresh reference every tick since damage() can
  // be invoked outside of update() too) -- so the bus has to travel in via
  // the `world` argument here, not a pre-set `_world`, or it gets clobbered.
  const walker = new Entity({ moveSpeed: 4, acceleration: 1000, friction: 1000, maxHealth: 100 });
  walker.setPath([{ x: 1000, z: 0 }]); // far waypoint -> steady desired velocity every frame
  seen.length = 0;
  for (let i = 0; i < 120; i++) walker.update(1 / 60, { colliders: null, bus }); // 2s of walking
  const steps = seen.filter((e) => e.kind === 'dust_step');
  check('a moving entity eventually requests dust_step', steps.length > 0);

  const stillEntity = new Entity({ maxHealth: 100 });
  seen.length = 0;
  for (let i = 0; i < 60; i++) stillEntity.update(1 / 60, { colliders: null, bus });
  check('a stationary entity never requests dust_step', seen.filter((e) => e.kind === 'dust_step').length === 0);

  // (f) never lets a bad direction (0-length, NaN) escape as a bad payload --
  // fx consumers should never have to defend against NaN from us.
  HitStop.reset();
  const nanDirVictim = new Entity({ maxHealth: 100, armor: 0 });
  nanDirVictim._world = { bus };
  seen.length = 0;
  nanDirVictim.damage(10, { critChance: 0 }, {}); // no direction supplied at all
  check('fx:request tolerates a hit with no direction (direction: null, not NaN)',
    seen.every((e) => e.direction === null || (isCleanNumber(e.direction.x) && isCleanNumber(e.direction.z))));
}

// ---------------------------------------------------------------------------
console.log('\n[8] AttackState -- input buffering + back-half animation cancel');
// ---------------------------------------------------------------------------
{
  // A minimal duck-typed actor mirroring the shape AttackState expects, in
  // the same spirit as AggroPack.js's mocks -- exercises the real state
  // machine, not a reimplementation of it.
  function mockAnimator() {
    return {
      action: null,
      get busy() { return !!this.action; },
      play(name, dur, opts) {
        this.action = { name, t: 0, dur, events: opts.events, fired: new Set(), onEvent: opts.onEvent };
      },
      step(dt) {
        const a = this.action;
        if (!a) return;
        a.t += dt;
        const u = Math.min(1, a.t / a.dur);
        for (const ev of a.events) {
          if (u >= ev.at && !a.fired.has(ev)) { a.fired.add(ev); a.onEvent?.(ev.name); }
        }
        if (u >= 1) this.action = null;
      },
    };
  }
  function mockActor() { return { alive: true, stunTimer: 0, animator: mockAnimator() }; }

  // (a) a request while nothing is in flight fires immediately.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    const fired = as.request(actor, { duration: 0.6, onImpact: () => {} });
    check('an attack request with no swing in flight fires immediately', fired === true);
  }

  // (b) a request during the front half (before impact) is buffered, not
  // dropped and not fired early.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    let impacts = 0;
    as.request(actor, { duration: 0.6, onImpact: (n) => { if (n === 'impact') impacts++; } });
    for (let i = 0; i < 5; i++) actor.animator.step(1 / 60); // well before impact at u=0.4 (~14 frames in)
    check('front-half swing is not yet cancellable', !as.cancellable);
    const firedNow = as.request(actor, { duration: 0.6, onImpact: () => {} });
    check('a click during the front half does not fire this call', firedNow === false);
    check('a click during the front half is queued, not dropped', as.buffered !== null);
    check('impact has not fired yet for the first swing', impacts === 0);
  }

  // (c) the buffered click fires on the FIRST available frame -- the exact
  // frame the first swing's impact event lands, not one frame later and not
  // only once the whole animation finishes.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    let swing1Impacts = 0;
    let swing2StartFrame = -1;
    let frame = 0;
    as.request(actor, { duration: 0.6, onImpact: (n) => { if (n === 'impact') swing1Impacts++; } });
    let bufferedAt = -1;
    for (frame = 1; frame <= 40; frame++) {
      actor.animator.step(1 / 60);
      if (bufferedAt < 0 && frame === 5) {
        as.request(actor, {
          duration: 0.6,
          onStart: () => { swing2StartFrame = frame; },
          onImpact: () => {},
        }); // click mid front-half -- queues, does not fire this call
        bufferedAt = frame;
      }
    }
    check('swing1 impact fired exactly once', swing1Impacts === 1);
    // impactAt=0.4 of a 0.6s swing = 0.24s -> frame ceil(0.24*60)=15 is when
    // `step()` first observes u>=0.4 and fires the event -- swing2 must
    // start on that exact frame, not frame 16 (one late) and not frame 40
    // (only once swing1's follow-through finishes on its own).
    check(`buffered swing2 starts on the very frame swing1 becomes cancellable (frame ${swing2StartFrame}, expected 15)`,
      swing2StartFrame === 15);
  }

  // (d) once cancellable, a NEW request fires directly (no buffering needed)
  // and cancels the recovery tail immediately -- the recovery is cancellable
  // after the damage event, not before.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    as.request(actor, { duration: 0.6, onImpact: () => {} });
    for (let i = 0; i < 40; i++) actor.animator.step(1 / 60); // past impact (u=0.4), still mid-recovery (u<1)
    check('mid-recovery (past impact) is cancellable', as.cancellable === true);
    const startedDirectly = as.request(actor, { duration: 0.6, onImpact: () => {} });
    check('a request during the cancellable back half fires THIS call (no buffering needed)', startedDirectly === true);
  }

  // (e) stunning the actor clears any pending buffer -- a stagger cancels a
  // queued follow-up rather than honouring it once the stun wears off.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    as.request(actor, { duration: 0.6, onImpact: () => {} });
    for (let i = 0; i < 5; i++) actor.animator.step(1 / 60);
    as.request(actor, { duration: 0.6, onImpact: () => {} }); // buffered
    check('buffer is populated before the stun', as.buffered !== null);
    actor.stunTimer = 0.5;
    const refused = as.request(actor, { duration: 0.6, onImpact: () => {} });
    check('a request while stunned is refused outright', refused === false);
    check('a request while stunned clears any pending buffer', as.buffered === null);
  }

  // (f) an actor busy with a DIFFERENT action (e.g. a skill cast) is a hard
  // lock -- a stale `cancellable=true` from an earlier completed swing must
  // not leak through and let a new swing interrupt it.
  {
    const actor = mockActor();
    const as = new AttackState({ impactAt: 0.4, whooshAt: 0.2 });
    as.request(actor, { duration: 0.2, onImpact: () => {} });
    for (let i = 0; i < 20; i++) actor.animator.step(1 / 60); // finishes; cancellable left at true
    check('AttackState.cancellable is stale-true after a completed swing', as.cancellable === true);
    actor.animator.play('cast', 0.3, { events: [], onEvent: () => {} }); // something else takes the lock
    const duringCast = as.request(actor, { duration: 0.6, onImpact: () => {} });
    check('a swing request is refused while a non-swing action holds the animator lock',
      duringCast === false);
    check('it is buffered, not silently dropped, so it still fires once the lock frees', as.buffered !== null);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[9] status effects -- slow scales movement, dots tick and expire');
// ---------------------------------------------------------------------------
{
  // A killing dot tick later in this section deals a huge overkill hit,
  // which would otherwise trigger HitStop -- and unlike every other test in
  // this section, nothing here calls resolveOverlaps() to tick it back down
  // (that is deliberately Entity/Monster/AttackState's own concern, not
  // status effects'), so isolate this section's timing from any freeze a
  // previous section left active, and reset again after.
  HitStop.reset();

  // Slow scales the effective top speed, does not just zero movement.
  const walker = new Entity({ moveSpeed: 4, acceleration: 1000, friction: 1000, maxHealth: 100 });
  walker.setPath([{ x: 1000, z: 0 }]);
  for (let i = 0; i < 30; i++) walker.update(1 / 60, { colliders: null }); // reach full speed unslowed
  const unslowedX = walker.position.x;

  const slowed = new Entity({ moveSpeed: 4, acceleration: 1000, friction: 1000, maxHealth: 100 });
  slowed.setPath([{ x: 1000, z: 0 }]);
  slowed.applySlow(10, 0.5); // 50% slow, long enough to cover the test window
  for (let i = 0; i < 30; i++) slowed.update(1 / 60, { colliders: null });
  check('applySlow(duration, 0.5) roughly halves distance covered vs unslowed',
    Math.abs(slowed.position.x - unslowedX * 0.5) < unslowedX * 0.15);

  const noFactor = new Entity({ maxHealth: 100 });
  noFactor.applySlow(1, 2); // garbage factor > 1 must clamp, never speed the target up
  check('applySlow clamps an out-of-range factor into [0,1]', noFactor.slowFactor <= 1);

  // A stronger/longer slow must not be shortened by a weaker one arriving
  // later -- same "never cut a stronger effect short" rule as HitStop.
  const kited = new Entity({ maxHealth: 100 });
  kited.applySlow(5, 0.3);
  kited.applySlow(1, 0.8); // weaker, shorter -- must not overwrite
  check('a weaker/shorter slow does not overwrite a stronger one already active',
    kited.slowFactor === 0.3 && kited.slowTimer === 5);

  // Slow expires on its own.
  const expiring = new Entity({ maxHealth: 100 });
  expiring.applySlow(0.05, 0.4);
  for (let i = 0; i < 10; i++) expiring.update(1 / 60, { colliders: null }); // 0.166s > 0.05s duration
  check('slow expires back to factor 1 once its duration elapses',
    expiring.slowTimer === 0 && expiring.slowFactor === 1);

  // Dots: tick for damage, respect stack cap, and expire after their ticks.
  const burning = new Entity({ maxHealth: 1000, armor: 0 });
  burning.applyDot({ amount: 5, ticks: 3, interval: 0.1, maxStacks: 3 });
  const hpBefore = burning.health;
  for (let i = 0; i < 40; i++) burning.update(1 / 60, { colliders: null }); // 0.667s > 3*0.1s
  check('a dot deals its ticks worth of damage over time (3 ticks x 5dmg = 15)',
    Math.abs((hpBefore - burning.health) - 15) < 0.01);
  check('a fully-ticked dot removes itself', burning.dots.length === 0);

  const stacked = new Entity({ maxHealth: 1000, armor: 0 });
  for (let i = 0; i < 5; i++) stacked.applyDot({ amount: 1, ticks: 10, interval: 5, maxStacks: 3 });
  check('applyDot never exceeds maxStacks (evicts oldest instead of growing unbounded)',
    stacked.dots.length === 3);

  // A dot tick that lands the killing blow must not leave the entity running
  // this frame's movement/animator update as if still alive (regression
  // guard for the mid-update early-return added alongside dot processing).
  const dyingToDot = new Entity({ maxHealth: 4, armor: 0 });
  dyingToDot.applyDot({ amount: 999, ticks: 1, interval: 0.0001 });
  dyingToDot.update(1 / 60, { colliders: null });
  check('a killing dot tick actually kills (alive=false) within update()', dyingToDot.alive === false);

  // That killing blow was a heavy overkill hit and would have triggered
  // HitStop -- nothing in this section calls resolveOverlaps() to tick it
  // back down (deliberately: that is not what status effects own), so reset
  // it explicitly rather than leaking a stuck freeze into section [10].
  HitStop.reset();
}

// ---------------------------------------------------------------------------
console.log('\n[10] Player integration -- real class, not a mock (buffering, D1 no-regen, skills)');
// ---------------------------------------------------------------------------
{
  // Player.js pulls in the full procedural rig (Models.js/CharacterRig.js),
  // which -- unlike a browser canvas texture -- has no DOM dependency, so the
  // *real* Player/Monster classes construct and run under plain node. Using
  // them here (rather than bare Entity mocks) proves the actual production
  // wiring: AttackState behind Player.attack()/canAttack(), the D1 combat
  // clock, and the skills subsystem's mana/cooldown/lock gates.
  const DT = 1 / 60;
  HitStop.reset();

  const p = new Player();
  check('a real Player constructs headlessly (no canvas/DOM needed)', p.type === 'player' && !!p.animator);

  // Buffering through the real Player API (not the raw AttackState mock).
  // No combat damage happens in this sub-test (no target), so HitStop cannot
  // be triggered/left stuck here -- dt passes through at full scale.
  let impacts = 0;
  p.attack((name) => { if (name === 'impact') impacts++; });
  for (let i = 0; i < 10; i++) p.update(DT, { colliders: null });
  const bufferedNow = p.attack((name) => { if (name === 'impact') impacts++; }); // mid front-half of swing1
  check('Player.attack() buffers (does not fire) a click mid front-half', bufferedNow === false);
  for (let i = 0; i < 30; i++) p.update(DT, { colliders: null });
  check('the buffered click fired via the real Player/AttackState wiring (2 impacts total)', impacts === 2);

  // D1 rule: no health regen in combat, through the real Player class.
  const p2 = new Player();
  p2.health = 50;
  p2.damage(1, { critChance: 0 }, {}); // any hit marks combat active
  for (let i = 0; i < 120; i++) p2.update(DT, { colliders: null }); // 2s, well under COMBAT_LOCKOUT
  check('Player.health does not regenerate for 2s immediately after taking a hit',
    p2.health <= 50 - 1 + 0.01);

  const p3 = new Player();
  p3.health = 50;
  for (let i = 0; i < 120; i++) p3.update(DT, { colliders: null }); // never hit, never targeted -> out of combat
  check('Player.health DOES regenerate when never in combat', p3.health > 50);

  // Skills: mana/cooldown/animation-lock gating, and canCast() denies what it should.
  const p4 = new Player();
  const m = new Monster({ kind: 'skeleton' });
  m.position.set(1, 0, 0);
  p4.position.set(0, 0, 0);
  // world4.rng deliberately fixed (never crits: 0.999 is above every combat
  // stat's critChance in this suite) -- without it, Entity.damage() falls
  // back to real Math.random() for the crit roll (see its own doc comment),
  // which made this whole sub-test flaky: an unlucky crit on the buffered
  // melee swing below triggers extra HitStop freeze frames and can push its
  // completion past the fixed 60-frame window the "lock releases" check
  // relies on. Pre-existing gap, not something introduced by this session's
  // changes -- fixed while in the neighbourhood since a flaky selftest is
  // worse than a slow one.
  const world4 = { player: p4, monsters: [m], bus: { emit() {} }, rng: { next: () => 0.999 } };
  const input4 = { _p: new Set(), pressed(c) { return this._p.has(c); } };
  const skills4 = createSkills({ bus: world4.bus, input: input4, world: world4, rng: { range: (a, b) => (a + b) / 2 } });

  check('canCast is true when off cooldown, affordable, and idle', skills4.canCast('firebolt'));
  const manaBefore = p4.mana;
  const castOk = skills4.cast('firebolt');
  check('cast() fires and deducts mana', castOk === true && p4.mana === manaBefore - SKILLS.firebolt.manaCost);
  check('cast() locks the animator (busy) for its lockDuration', p4.animator.busy === true);
  check('canCast refuses the SAME skill again immediately (cooldown)', skills4.canCast('firebolt') === false);

  const meleeWhileCasting = p4.attack(() => {});
  check('a melee swing cannot fire while a skill cast holds the animation lock',
    meleeWhileCasting === false && p4.animator.busy === true);

  // The cast's damage is heavy enough to trigger HitStop -- tick
  // resolveOverlaps() every frame, exactly as main.js's real phase order
  // does (entities update, THEN overlap resolution burns one hit-stop
  // frame), so the freeze releases on schedule instead of stalling dt.
  // Watch for the CAST's lock lifting, rather than asserting the animator is
  // idle at an arbitrary frame.
  //
  // Those are not the same claim, and conflating them made this fail for a
  // correct reason. The `p4.attack()` above is refused during the cast -- and
  // being refused, it is BUFFERED, which is exactly what input buffering is
  // for. So the instant the cast lock lifts, that buffered swing fires and the
  // animator is legitimately busy again:
  //
  //     f=0  busy=true   cast lock
  //     f=17 busy=false  cast lock releases      <- what this test means
  //     f=18 busy=true   buffered swing fires    <- also correct
  //     f=57 busy=false  swing completes
  //
  // Firebolt's damage now lands on projectile arrival rather than on cast, so
  // its hit-stop occurs later and can push that swing past frame 60. Assert
  // the thing that matters instead: the lock released within its own duration.
  const lockFrames = Math.ceil(SKILLS.firebolt.lockDuration / DT);
  let lockReleasedAt = -1;
  for (let i = 0; i < 60; i++) {
    skills4.update(DT);
    p4.update(DT, { colliders: null });
    m.update(DT, { colliders: null, monsters: [m], player: p4 });
    resolveOverlaps([p4, m], 1);
    if (lockReleasedAt < 0 && p4.animator.busy === false) lockReleasedAt = i;
  }
  check('the cast lock releases once lockDuration elapses (a buffered melee swing may legitimately follow it)',
    lockReleasedAt >= 0 && lockReleasedAt <= lockFrames + 4);
  check('the skeleton took damage from the resolved cast', m.health < m.maxHealth);
  HitStop.reset();
}

// ---------------------------------------------------------------------------
console.log('\n[11] Spell resolution -- a cast actually lands damage on a monster in range, and misses one beyond it');
// ---------------------------------------------------------------------------
{
  // F3 verification, per the mission brief: "a test that only asserts 'the
  // skill fired' is worthless here -- assert the monster's health actually
  // dropped." Drives the REAL Player/Monster/createSkills wiring, not a
  // reimplementation of RESOLVE.firebolt/arcstorm.
  const DT = 1 / 60;

  function driveCastToImpact(p, skills, world, id, frames = 40) {
    for (let i = 0; i < frames; i++) {
      skills.update(DT);
      p.update(DT, { colliders: null });
      for (const m of world.monsters) m.update(DT, { colliders: null, monsters: world.monsters, player: p });
      resolveOverlaps([p, ...world.monsters], 1);
    }
  }

  // (a) Firebolt (range=12): a monster sitting well inside range takes damage.
  {
    HitStop.reset();
    const p = new Player();
    p.position.set(0, 0, 0);
    const near = new Monster({ kind: 'skeleton' });
    near.position.set(5, 0, 0); // inside firebolt's range=12
    const world = { player: p, monsters: [near], bus: { emit() {} } };
    const input = { _p: new Set(['Digit2']), pressed(c) { return this._p.has(c); } };
    const skills = createSkills({ bus: world.bus, input, world, rng: { range: (a, b) => (a + b) / 2 } });

    const healthBefore = near.health;
    skills.update(DT); // consumes the queued press, starts the cast
    input._p.clear();
    driveCastToImpact(p, skills, world, 'firebolt');
    check('a Firebolt cast at distance 5 (inside its range=12) actually reduces the target\'s health',
      near.health < healthBefore);
    HitStop.reset();
  }

  // (b) Firebolt: a monster sitting beyond range is untouched.
  {
    HitStop.reset();
    const p = new Player();
    p.position.set(0, 0, 0);
    const far = new Monster({ kind: 'skeleton' });
    far.position.set(20, 0, 0); // outside firebolt's range=12
    const world = { player: p, monsters: [far], bus: { emit() {} } };
    const input = { _p: new Set(['Digit2']), pressed(c) { return this._p.has(c); } };
    const skills = createSkills({ bus: world.bus, input, world, rng: { range: (a, b) => (a + b) / 2 } });

    const healthBefore = far.health;
    // canCast() itself must still be true (mana/cooldown/lock are all fine --
    // only the target is out of reach), so this proves the MISS is a real
    // "nothing in range" outcome and not just a gate refusing to fire at all.
    check('canCast(firebolt) is still true with no target in range (it just finds nothing to hit)',
      skills.canCast('firebolt'));
    skills.update(DT);
    input._p.clear();
    driveCastToImpact(p, skills, world, 'firebolt');
    check('a Firebolt cast at distance 20 (beyond its range=12) leaves the target\'s health untouched',
      far.health === healthBefore);
    HitStop.reset();
  }

  // (c) Arc Storm (radius=4.2, centred on the PLAYER, not the cursor -- see
  // SkillDefs.js): a monster inside the radius takes damage, one just
  // beyond it does not, in the SAME cast.
  {
    HitStop.reset();
    const p = new Player();
    p.position.set(0, 0, 0);
    const inside = new Monster({ kind: 'skeleton' });
    inside.position.set(3, 0, 0); // inside radius=4.2
    const outside = new Monster({ kind: 'skeleton' });
    outside.position.set(6, 0, 0); // outside radius=4.2
    const world = { player: p, monsters: [inside, outside], bus: { emit() {} } };
    const input = { _p: new Set(['Digit4']), pressed(c) { return this._p.has(c); } };
    const skills = createSkills({ bus: world.bus, input, world, rng: { range: (a, b) => (a + b) / 2 } });

    const insideBefore = inside.health, outsideBefore = outside.health;
    skills.update(DT);
    input._p.clear();
    driveCastToImpact(p, skills, world, 'arcstorm');
    check('Arc Storm damages a monster inside its radius', inside.health < insideBefore);
    check('Arc Storm leaves a monster just beyond its radius untouched', outside.health === outsideBefore);
    HitStop.reset();
  }
}

// ---------------------------------------------------------------------------
console.log('\n[12] F3 root cause -- melee auto-swing must not starve skill casts forever while a live target is in range');
// ---------------------------------------------------------------------------
{
  // This is the actual bug behind "the spells and attacks are not hitting
  // the mobs": main.js's auto-swing re-issues attack() every single frame a
  // live target sits in melee range (see main.js's _updateInput), which used
  // to keep the animator perpetually locked in an unbroken attackSwing
  // chain. canCast()'s `p.animator?.busy` check then NEVER saw a free
  // animator while the player was actively fighting -- which is precisely
  // when a player wants Frost Nova or Arc Storm most. A live headless-browser
  // probe against the real running game (not just this unit) confirmed the
  // pre-fix behaviour: 180 consecutive frames of melee against a live target,
  // holding a skill key the whole time, produced ZERO casts. Reproduce the
  // same shape here with the real Player/Monster/skills wiring, and prove it
  // now succeeds.
  const DT = 1 / 60;
  HitStop.reset();

  const p = new Player();
  p.position.set(0, 0, 0);
  // maxHealth pumped up so melee cannot kill it mid-test and confound "did
  // the cast fire" with "the fight simply ended".
  const foe = new Monster({ kind: 'skeleton' });
  foe.position.set(1.2, 0, 0); // inside melee attackRange
  foe.maxHealth = 1e9; foe.health = 1e9;
  const world = { player: p, monsters: [foe], bus: { emit() {} } };
  p.orderAttack(foe, { path: () => null }); // engage in melee, same as a click

  // Duck-typed Input matching src/core/Input.js's public surface -- a skill
  // hotkey is held "pressed" (edge-triggered, exactly like a real keypress
  // that Input.js would report true for one frame) on every single frame,
  // mirroring an impatient player mashing the key throughout the fight.
  const input = { _p: new Set(), pressed(c) { return this._p.has(c); } };
  const skills = createSkills({ bus: world.bus, input, world, rng: { range: (a, b) => (a + b) / 2 } });

  let castFrame = -1;
  for (let f = 0; f < 120 && castFrame < 0; f++) {
    input._p = new Set(['Digit3']); // Frost Nova -- the panic-button skill
    // Mirrors main.js's exact per-frame order: input's auto-swing check
    // FIRST (using the corrected call site, canAttack(input) -- see the
    // report for the one-line main.js snippet this depends on), then
    // entities update, then the skills subsystem polls input.
    const manaBefore = p.mana;
    if (foe.alive && p.distanceTo(foe) <= p.attackRange && p.canAttack(input)) {
      p.attack((ev) => {
        if (ev !== 'impact') return;
        if (!foe.alive || p.distanceTo(foe) > p.attackRange * 1.35) return;
        foe.damage(1, p, {});
      });
    }
    p.update(DT, { colliders: null });
    foe.update(DT, { colliders: null, monsters: [foe], player: p });
    resolveOverlaps([p, foe], 1);
    skills.update(DT);
    if (p.mana < manaBefore) castFrame = f;
  }

  check('a skill cast succeeds within a couple of frames even with a live melee target continuously in range (root-cause fix)',
    castFrame >= 0 && castFrame < 5);
  // The loop above breaks the frame mana drops -- that is the cast STARTING.
  // Frost Nova's effect lands when the cast RESOLVES, after its animation
  // lock, so asserting the stun immediately is asserting it too early. Run
  // the sim on past the lock and then check.
  for (let f = 0; f < 40 && !(foe.stunTimer > 0 || foe.slowTimer > 0); f++) {
    p.update(DT, { colliders: null });
    foe.update(DT, { colliders: null, monsters: [foe], player: p });
    skills.update(DT);
  }
  check('Frost Nova\'s own effect lands once the cast resolves (target stunned or slowed)',
    castFrame >= 0 && (foe.stunTimer > 0 || foe.slowTimer > 0));
  HitStop.reset();

  // Companion guard, rewritten.
  //
  // This originally asserted that WITHOUT passing input to canAttack() the
  // starvation still reproduced, to prove the main.js snippet was
  // load-bearing. That premise is now stale, and the honest correction
  // matters: the fix landed in two independent halves -- main.js yielding the
  // frame to a requested cast, AND Player.js making a swing's back half
  // cancellable. Either alone is enough to break the deadlock, so demanding
  // that the unpatched call site still starve is demanding a bug we already
  // fixed twice.
  //
  // What is worth guarding is the property a player actually feels: a cast
  // must land PROMPTLY while meleeing, not merely eventually. So assert the
  // patched call site casts within a couple of frames, and record the
  // unpatched one's latency for comparison rather than requiring it to fail.
  {
    const p2 = new Player();
    p2.position.set(0, 0, 0);
    const foe2 = new Monster({ kind: 'skeleton' });
    foe2.position.set(1.2, 0, 0);
    foe2.maxHealth = 1e9; foe2.health = 1e9;
    const world2 = { player: p2, monsters: [foe2], bus: { emit() {} } };
    p2.orderAttack(foe2, { path: () => null });
    const input2 = { _p: new Set(), pressed(c) { return this._p.has(c); } };
    const skills2 = createSkills({ bus: world2.bus, input: input2, world: world2, rng: { range: (a, b) => (a + b) / 2 } });
    let everCast = false;
    for (let f = 0; f < 120; f++) {
      input2._p = new Set(['Digit3']);
      const manaBefore = p2.mana;
      if (foe2.alive && p2.distanceTo(foe2) <= p2.attackRange && p2.canAttack(/* no input -- the unpatched call */)) {
        p2.attack((ev) => { if (ev === 'impact' && foe2.alive) foe2.damage(1, p2, {}); });
      }
      p2.update(DT, { colliders: null });
      foe2.update(DT, { colliders: null, monsters: [foe2], player: p2 });
      resolveOverlaps([p2, foe2], 1);
      skills2.update(DT);
      if (p2.mana < manaBefore) { everCast = true; break; }
    }
    check('the patched call site casts promptly (within 5 frames) while meleeing -- that is the property the player feels',
      castFrame >= 0 && castFrame < 5);
    check('the cancellable back half independently prevents indefinite starvation, so the deadlock cannot return if either half regresses alone',
      everCast === true);
    HitStop.reset();
  }
}

// ---------------------------------------------------------------------------
console.log('\n[13] noclip -- the debug console\'s player.noclip flag is now honoured by the collision path');
// ---------------------------------------------------------------------------
{
  // Console.js (not owned by combat) just flips `player.noclip = !player.noclip`
  // and trusts the movement code to respect it -- it didn't, until now.
  const solidEverywhere = { isBlocked: () => true };

  const clipped = new Entity({ moveSpeed: 4, acceleration: 1000, friction: 1000, maxHealth: 100 });
  clipped.setPath([{ x: 10, z: 0 }]);
  for (let i = 0; i < 30; i++) clipped.update(1 / 60, { colliders: solidEverywhere });
  check('without noclip, a wall-blocked entity does not pass through it', clipped.position.x === 0);

  const ghosting = new Entity({ moveSpeed: 4, acceleration: 1000, friction: 1000, maxHealth: 100 });
  ghosting.noclip = true;
  ghosting.setPath([{ x: 10, z: 0 }]);
  for (let i = 0; i < 30; i++) ghosting.update(1 / 60, { colliders: solidEverywhere });
  check('with noclip=true, the SAME wall-blocked entity now passes straight through', ghosting.position.x > 1);

  // Toggling back off re-engages collision immediately, no stale state.
  ghosting.noclip = false;
  const xBeforeReclip = ghosting.position.x;
  ghosting.setPath([{ x: xBeforeReclip + 10, z: 0 }]);
  for (let i = 0; i < 30; i++) ghosting.update(1 / 60, { colliders: solidEverywhere });
  check('toggling noclip back off re-engages collision on the very next update',
    Math.abs(ghosting.position.x - xBeforeReclip) < 1e-6);
}

// ---------------------------------------------------------------------------
console.log('\n[14] hold-to-move -- holding the button steers continuously without re-pathing every frame');
// ---------------------------------------------------------------------------
{
  // F1 from the playtest: "diablo players hold down the mouse button instead
  // of clicking to move". main.js's input block calls orderHold() on every
  // frame the button is down. Two properties matter and they pull against
  // each other: it must actually follow a moving cursor (feel), and it must
  // not run A* sixty times a second to do it (cost). Both are asserted here.
  const DT = 1 / 60;

  /** Nav stub that counts A* calls, so "does it re-path every frame" is a
   *  measurement rather than a claim. `blocked` flips line-of-sight off to
   *  exercise the fallback branch. */
  function makeNav(blocked = false) {
    return {
      calls: 0,
      lineOfSight() { return !blocked; },
      path(sx, sz, tx, tz) { this.calls++; return [{ x: tx, z: tz }]; },
    };
  }

  // -- clear line of sight: steering only, zero A* --
  const nav = makeNav(false);
  const ph = new Player();
  const startX = ph.position.x;
  for (let i = 0; i < 60; i++) {
    ph.orderHold(20, 0, nav, null);          // cursor held on one spot for a second
    ph.update(DT, { colliders: null });
  }
  check('holding the button walks the player toward the held point', ph.position.x > startX + 1);
  check('a held cursor in clear line of sight runs A* zero times (it steers straight at the cursor)',
    nav.calls === 0);

  // -- the cursor moves mid-hold: the player must follow the LIVE point --
  const navSteer = makeNav(false);
  const ps = new Player();
  for (let i = 0; i < 40; i++) { ps.orderHold(20, 0, navSteer, null); ps.update(DT, { colliders: null }); }
  const xAtTurn = ps.position.x, zAtTurn = ps.position.z;
  for (let i = 0; i < 40; i++) { ps.orderHold(xAtTurn, 20, navSteer, null); ps.update(DT, { colliders: null }); }
  check('moving the cursor while holding redirects the player without a click',
    ps.position.z > zAtTurn + 0.5);

  // -- blocked line: A* is allowed, but not once per frame --
  const navBlocked = makeNav(true);
  const pb = new Player();
  for (let i = 0; i < 60; i++) {
    pb.orderHold(20, 0, navBlocked, null);
    pb.update(DT, { colliders: null });
  }
  check('a blocked held point does fall back to A*', navBlocked.calls > 0);
  check('...but re-paths only as the held point drifts, not on all 60 frames',
    navBlocked.calls < 15);

  // -- holding over a hostile attacks it, and re-affirms the order only once --
  const navAtk = makeNav(false);
  const pa = new Player();
  const foe = new Monster({ kind: 'skeleton' });
  foe.position.set(1.0, 0, 0);
  for (let i = 0; i < 30; i++) pa.orderHold(pa.position.x, pa.position.z, navAtk, foe);
  check('holding the cursor over a hostile targets it', pa.target === foe);
  check('holding on an already-engaged target does not re-issue the order every frame',
    navAtk.calls <= 1);

  // -- arriving under the cursor settles instead of vibrating on the spot --
  const navArrive = makeNav(false);
  const pr = new Player();
  pr.orderHold(pr.position.x + 0.05, pr.position.z, navArrive, null);
  check('a held cursor already under the player clears the path rather than chasing a fraction of a unit',
    !pr.path || pr.path.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n[15] run animation -- cadence tracks ground covered, transitions blend (P0-3)');
// ---------------------------------------------------------------------------
{
  const DT = 1 / 60;

  // The foot-slide test. If cadence is tied to distance, then the gait phase
  // advanced over a move must be proportional to the distance travelled, at
  // ANY speed -- that proportionality IS "the feet do not slide". The old
  // frequency curve rose with sqrt(speed), so phase-per-metre changed with
  // speed and the contact point drifted at every speed but one.
  function phasePerMetre(speed) {
    // A real Player, because it builds a real rig headlessly (see [12]) and
    // the cadence maths reads rig.spec.height.
    const e = new Player();
    e.moveSpeed = speed;
    e.acceleration = 1000;
    e.friction = 1000;
    e.setPath([{ x: 400, z: 0 }]);
    const x0 = e.position.x;
    const p0 = e.animator.phase;
    for (let i = 0; i < 90; i++) e.update(DT, { colliders: null });
    const dist = Math.abs(e.position.x - x0);
    return dist > 0.01 ? (e.animator.phase - p0) / dist : 0;
  }

  const slow = phasePerMetre(2.0);
  const fast = phasePerMetre(6.0);
  check('the gait advances at all while walking', slow > 0);
  check('phase per metre is the SAME at 2 m/s and 6 m/s (no foot slide at any speed)',
    slow > 0 && Math.abs(fast - slow) / slow < 0.02,
    `${slow.toFixed(3)} vs ${fast.toFixed(3)} rad/m`);

  // Running into a wall must not animate a sprint on the spot: the animator
  // is fed measured displacement, so a blocked entity's gait must freeze.
  const solid = { isBlocked: () => true };
  const stuck = new Player();
  stuck.moveSpeed = 5; stuck.acceleration = 1000; stuck.friction = 1000;
  stuck.setPath([{ x: 40, z: 0 }]);
  for (let i = 0; i < 20; i++) stuck.update(DT, { colliders: solid });
  const phaseWall = stuck.animator.phase;
  for (let i = 0; i < 40; i++) stuck.update(DT, { colliders: solid });
  check('an entity blocked by a wall does not run on the spot',
    Math.abs(stuck.animator.phase - phaseWall) < 1e-6);

  // Idle <-> locomotion is eased, never switched.
  const mover = new Player();
  mover.moveSpeed = 5; mover.acceleration = 1000; mover.friction = 1000;
  mover.setPath([{ x: 60, z: 0 }]);
  mover.update(DT, { colliders: null });
  check('the locomotion blend does not snap to 1 on the first moving frame',
    mover.animator._locoBlend > 0 && mover.animator._locoBlend < 0.5,
    `${mover.animator._locoBlend.toFixed(3)}`);
  for (let i = 0; i < 30; i++) mover.update(DT, { colliders: null });
  check('...and reaches full locomotion within ~0.5s of running',
    mover.animator._locoBlend > 0.9, `${mover.animator._locoBlend.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}
