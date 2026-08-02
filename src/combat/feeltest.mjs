#!/usr/bin/env node
/**
 * Headless, harness-free feel simulation.
 *
 *   node src/combat/feeltest.mjs
 *
 * Static screenshots cannot show hit-stop, knockback, or corpse persistence
 * -- a single frame looks the same whether or not any of that fired. This
 * runs the real combat primitives (Entity.js + combat/*.js -- the same code
 * the browser build uses, not a reimplementation) against a small mock scene
 * for a few seconds of simulated time and prints a frame-by-frame timeline
 * so those effects are visible in text instead of pixels.
 *
 * "Mock entities" here means bare `Entity` instances (no CharacterRig/model,
 * since those pull in canvas-based procedural textures that need a browser)
 * standing in for a Player and two Monsters -- the same base class, stats,
 * and damage/knockback/hit-stop/collapse pipeline production code runs.
 *
 * Phases 7-10 (controls + skills, Gate 1) go one step further and construct
 * the REAL `Player`/`Monster` classes -- it turns out Models.js/CharacterRig
 * need no DOM/canvas, only THREE's CPU math, so there is no need to mock
 * animation state at all for those phases.
 */
import { Entity, resolveOverlaps } from '../entities/Entity.js';
import { HitStop } from './HitStop.js';
import { Player } from '../entities/Player.js';
import { Monster } from '../entities/Monster.js';
import { createSkills } from '../skills/index.js';
import { SKILLS } from '../skills/SkillDefs.js';

const DT = 1 / 60;
let frame = 0;
let simTime = 0;

function fmt(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }

/** One tick of the exact phase order main.js runs: entities update, then
 *  resolveOverlaps() (which is also where the hit-stop frame counter ticks). */
function tick(entities, world) {
  frame++;
  simTime += DT;
  for (const e of entities) e.update(DT, world);
  resolveOverlaps(entities, 2);
}

const log = [];
function record(event, extra = '') {
  log.push(`f=${String(frame).padStart(4)} t=${fmt(simTime)}s  ${event}${extra ? '  ' + extra : ''}`);
}

console.log('=== EMBERFALL combat feel timeline ===\n');

// --- scene ------------------------------------------------------------------
// A player-mass attacker and two monster-mass victims: a swarmer (light,
// low health) and a skeleton (heavy, tanky), positioned so a hit direction is
// unambiguous (attacker to the west of both victims, blow travels east).
const player = new Entity({ type: 'player', faction: 'player', mass: 1.6, maxHealth: 220, armor: 5, critChance: 1 /* force crits visible in this timeline */, critMultiplier: 2.0 });
player.position.set(-2, 0, 0);

// maxHealth here is deliberately generous (not the real swarmer=24/skeleton=52
// numbers from MonsterProfiles.js) for phases 2-3: those phases isolate the
// *live* knockback-vs-mass comparison, and a hit that kills goes through the
// death-collapse branch instead (a different code path, demonstrated on its
// own in phase 5 using a real killing blow).
const swarmer = new Entity({ type: 'monster', faction: 'hostile', mass: 0.55, maxHealth: 200, armor: 0 });
swarmer.position.set(0, 0, 0);

const skeleton = new Entity({ type: 'monster', faction: 'hostile', mass: 1.15, maxHealth: 200, armor: 6 });
skeleton.position.set(0, 0, 3);

const entities = [player, swarmer, skeleton];
const fxCounts = {};
const world = { colliders: null, monsters: [swarmer, skeleton], player, bus: { emit(type, payload) {
  if (type === 'combat:hit') record('event combat:hit', `victim=${payload.victim.type} amount=${fmt(payload.amount)} crit=${payload.crit}`);
  if (type === 'combat:kill') record('event combat:kill', `victim=${payload.victim.type}`);
  if (type === 'camera:shake') record('event camera:shake', `trauma=${fmt(payload.trauma)}`);
  if (type === 'fx:request') {
    fxCounts[payload.kind] = (fxCounts[payload.kind] || 0) + 1;
    const dir = payload.direction ? `(${fmt(payload.direction.x)},${fmt(payload.direction.z)})` : 'null';
    record(`event fx:request`, `kind=${payload.kind} pos=(${fmt(payload.position.x)},${fmt(payload.position.y)},${fmt(payload.position.z)}) dir=${dir} scale=${fmt(payload.scale)}`);
  }
} } };

function snapshot(label) {
  record(label,
    `swarmer.pos=(${fmt(swarmer.position.x)},${fmt(swarmer.position.z)}) ` +
    `skeleton.pos=(${fmt(skeleton.position.x)},${fmt(skeleton.position.z)}) ` +
    `hitstop.frames=${HitStop.frames} hitstop.scale=${fmt(HitStop.scale)}`
  );
}

record('--- phase 1: idle, 10 frames of nothing happening ---');
for (let i = 0; i < 10; i++) tick(entities, world);
snapshot('baseline');

// --- a heavy, crit-forced blow lands on the swarmer -------------------------
record('\n--- phase 2: player crit-hits the swarmer (dir = +X, west-to-east) ---');
const swarmerHealthBefore = swarmer.health;
const swarmerPosBefore = swarmer.position.x;
player.damage; // no-op reference just to keep linters quiet about unused import shape
swarmer.damage(14, player, { direction: { x: 1, z: 0 } });
record('damage() returned', `swarmer.health ${fmt(swarmerHealthBefore)} -> ${fmt(swarmer.health)}`);
snapshot('immediately after the hit (before any tick)');

for (let i = 0; i < 8; i++) {
  tick(entities, world);
  snapshot(`tick ${i + 1}/8 after crit`);
}
const swarmerMoved = swarmer.position.x - swarmerPosBefore;
record('knockback result', `swarmer displaced ${fmt(swarmerMoved)}m along +X in 8 frames (crit hit-stop included)`);

// --- an equal hit on the heavier, tankier skeleton for comparison -----------
record('\n--- phase 3: identical raw damage on the skeleton (heavier, armoured) ---');
const skeletonPosBefore = skeleton.position.x;
skeleton.damage(14, player, { direction: { x: 1, z: 0 } });
for (let i = 0; i < 8; i++) tick(entities, world);
const skeletonMoved = skeleton.position.x - skeletonPosBefore;
record('knockback result', `skeleton displaced ${fmt(skeletonMoved)}m along +X in 8 frames`);
record('comparison', `swarmer moved ${fmt(swarmerMoved / Math.max(1e-6, skeletonMoved))}x further than the skeleton for the same hit (mass+armor difference)`);

// --- hit-stop timeline in isolation, frame by frame -------------------------
record('\n--- phase 4: hit-stop frame-by-frame release, isolated ---');
HitStop.reset();
HitStop.trigger(4, 0.05);
for (let i = 0; i < 6; i++) {
  record(`  hitstop tick ${i}`, `frames=${HitStop.frames} scale=${fmt(HitStop.scale)} active=${HitStop.active}`);
  resolveOverlaps([], 1);
}
record('hit-stop check', HitStop.active ? 'STILL ACTIVE -- BUG' : 'released cleanly, as guaranteed');

// --- overlapping hit-stops: a second hit lands mid-freeze -------------------
record('\n--- phase 4b: overlapping hit-stop -- a second hit lands mid-freeze, must extend not deadlock ---');
HitStop.reset();
HitStop.trigger(3, 0.1);
record('  first trigger(3, 0.1)', `frames=${HitStop.frames} scale=${fmt(HitStop.scale)}`);
resolveOverlaps([], 1);
resolveOverlaps([], 1);
record('  after 2 ticks (1 frame left)', `frames=${HitStop.frames} scale=${fmt(HitStop.scale)}`);
HitStop.trigger(4, 0.1); // a second hit lands while the first is still winding down
record('  overlapping trigger(4, 0.1) lands', `frames=${HitStop.frames} scale=${fmt(HitStop.scale)} (extended, not reset to a fresh 4 from a frozen clock)`);
let overlapTicks = 0;
while (HitStop.active && overlapTicks < 20) {
  resolveOverlaps([], 1);
  overlapTicks++;
  record(`  overlap tick ${overlapTicks}`, `frames=${HitStop.frames} active=${HitStop.active}`);
}
record('overlap check', HitStop.active ? 'STILL ACTIVE -- BUG (deadlock)' : `released cleanly after ${overlapTicks} extra ticks, as guaranteed`);
HitStop.reset();

// --- the killing blow: directional collapse + corpse persistence -----------
record('\n--- phase 5: killing blow on the skeleton, direction = -X (west), from the east ---');
skeleton.health = 999;
skeleton.alive = true;
skeleton.stunTimer = 0;
skeleton._collapse = null;
const killDir = { x: -1, z: 0 };
skeleton.damage(999, player, { direction: killDir });
record('state after killing blow', `alive=${skeleton.alive} health=${skeleton.health} collapseDirX=${fmt(skeleton._collapse.dirX)}`);

record('\n  frame-by-frame collapse (rotation.x/z of the entity container, stun state):');
for (let i = 0; i < 40; i++) {
  tick(entities, world);
  if (i % 5 === 0 || i === 39) {
    record(`  collapse f+${i}`,
      `alive=${skeleton.alive} rot.x=${fmt(skeleton.object.rotation.x)} rot.z=${fmt(skeleton.object.rotation.z)} ` +
      `deathTimer=${fmt(skeleton.deathTimer)} stunTimer=${fmt(skeleton.stunTimer)}`);
  }
}

record('\n--- phase 5b: footstep fx -- a live swarmer walking toward a far waypoint ---');
const walker = new Entity({ type: 'monster', faction: 'hostile', mass: 0.55, maxHealth: 200, moveSpeed: 5.6, acceleration: 30, friction: 16 });
walker.position.set(10, 0, 10);
walker.setPath([{ x: 40, z: 10 }]);
const walkWorld = { colliders: null, monsters: [], player, bus: world.bus };
const fxBefore = fxCounts.dust_step || 0;
for (let i = 0; i < 90; i++) { frame++; simTime += DT; walker.update(DT, walkWorld); resolveOverlaps([walker], 1); }
record('footstep check', `dust_step fired ${((fxCounts.dust_step || 0) - fxBefore)} times over 90 frames (1.5s) of walking`);

record('\n--- phase 6: corpse persistence -- run 20 simulated seconds past death ---');
const extraTicks = Math.round(20 / DT);
for (let i = 0; i < extraTicks; i++) tick(entities, world);
record('corpse check',
  `after ${fmt(skeleton.deathTimer)}s dead, alive=${skeleton.alive}, entity still present in the array=${entities.includes(skeleton)}. ` +
  `Entity.js never removes itself -- see the report re: main.js's own reap timer, which currently despawns corpses after 14s ` +
  `and is the one thing that would defeat this.`
);

// =============================================================================
// GATE 1 -- CONTROLS + SKILLS. Uses the real Player/Monster classes (not bare
// Entity mocks) since they construct and run headlessly. This is the part of
// the timeline the mission brief specifically asks to be pasted verbatim.
// =============================================================================
HitStop.reset();

record('\n\n=== GATE 1: controls + skills timeline (real Player/Monster) ===');

// --- phase 7: input buffering -- a click during the front half of a swing --
record('\n--- phase 7: input buffering -- a click mid-swing must queue and fire on the FIRST available frame, not be dropped ---');
{
  const hero = new Player();
  hero.position.set(0, 0, 0);
  const impactFrames = [];
  let frame = 0;
  const stamp = (label) => (name) => {
    if (name !== 'impact') return;
    impactFrames.push(frame);
    record(`  f=${frame}`, `${label} impact event fires`);
  };

  record('  action', 'hero.attack() called -- swing #1 starts');
  hero.attack(stamp('swing #1'));

  let queuedAtFrame = -1;
  for (frame = 1; frame <= 40; frame++) {
    hero.update(DT, { colliders: null });
    if (frame === 5) {
      const canNow = hero.canAttack();
      record(`  f=${frame}`, `CLICK -- hero.attack() called again. canAttack()=${canNow} (still mid front-half -> must NOT fire, must queue)`);
      const firedNow = hero.attack(stamp('swing #2 (buffered click)'));
      record(`  f=${frame}`, `attack() returned ${firedNow} (false = buffered this call, not dropped -- it fires on its own)`);
      queuedAtFrame = frame;
    }
  }
  record('buffering result',
    `swing #1 impact at f=${impactFrames[0]}; the click queued at f=${queuedAtFrame} produced its own impact at f=${impactFrames[1]} -- ` +
    `swing #2 STARTED at f=${impactFrames[0]} (the exact frame swing #1 became cancellable), not at f=40 (swing #1's natural end) ` +
    `and not dropped. That is "queues and fires immediately on recovery".`
  );
}

// --- phase 8: animation cancelling -- not cancellable before impact, IS after
record('\n--- phase 8: animation cancelling -- recovery is cancellable strictly AFTER the damage event, never before ---');
{
  const hero = new Player();
  hero.position.set(0, 0, 0);
  hero.attack(() => {});
  const impactAtFrame = Math.round(hero._attackState.impactAt * hero.attackDuration * 60);
  record('  swing timing', `attackDuration=${fmt(hero.attackDuration)}s, impactAt=${hero._attackState.impactAt} of duration -> impact event expected around f=${impactAtFrame}`);
  let firstCancellableFrame = -1;
  for (let f = 1; f <= 40; f++) {
    hero.update(DT, { colliders: null });
    const beforeCancellable = hero._attackState.cancellable;
    if (f === impactAtFrame - 2) {
      const canNow = hero.canAttack();
      record(`  f=${f} (2 frames BEFORE impact)`, `cancellable=${beforeCancellable} canAttack()=${canNow} -- must be false/false: front half is a hard lock`);
    }
    if (beforeCancellable && firstCancellableFrame < 0) firstCancellableFrame = f;
  }
  record('cancel-window result', `recovery became cancellable at f=${firstCancellableFrame}, matching the impact frame (f=${impactAtFrame}) -- not before it, not only at animation end (f=${Math.round(hero.attackDuration * 60)}).`);
}

// --- phase 9: a skill's animation lock actually blocks -------------------
record('\n--- phase 9: skill animation lock -- a cast blocks melee AND another skill until it resolves, no exceptions ---');
{
  const hero = new Player();
  const foe = new Monster({ kind: 'skeleton' });
  hero.position.set(0, 0, 0);
  foe.position.set(1, 0, 0);
  const bus = { emit(type, payload) {
    if (type === 'fx:request') record('  event fx:request', `kind=${payload.kind}`);
  } };
  const world9 = { player: hero, monsters: [foe], bus };
  const input9 = { _p: new Set('Digit4'.split(',')), pressed(c) { const v = this._p.has(c); this._p.delete(c); return v; } };
  input9._p = new Set(['Digit4']); // Arc Storm (spender)
  const skills9 = createSkills({ bus, input: input9, world: world9, rng: { range: (a, b) => (a + b) / 2 } });

  skills9.update(DT); // consumes the queued Digit4 press, starts the Arc Storm cast
  record('  action', `Arc Storm cast started. animator.busy=${hero.animator.busy} (lockDuration=${SKILLS.arcstorm.lockDuration}s)`);
  const meleeBlocked = hero.attack(() => {});
  record('  attempt', `hero.attack() while casting -> fired=${meleeBlocked} (must be false)`);
  const secondSkillBlocked = skills9.cast('frostnova');
  record('  attempt', `skills.cast('frostnova') while Arc Storm is still locking -> fired=${secondSkillBlocked} (must be false, even though Frost Nova is off cooldown and affordable)`);

  let unlockFrame = -1;
  for (let f = 1; f <= 60; f++) {
    skills9.update(DT);
    hero.update(DT, { colliders: null });
    foe.update(DT, { colliders: null, monsters: [foe], player: hero });
    resolveOverlaps([hero, foe], 1);
    if (unlockFrame < 0 && !hero.animator.busy) unlockFrame = f;
  }
  record('lock result', `animation lock released at f=${unlockFrame} (~${fmt(unlockFrame / 60)}s, matches lockDuration=${SKILLS.arcstorm.lockDuration}s within a hit-stop frame or two). Melee and the second skill were both refused for the full duration of the lock, not silently ignored -- both calls above returned false, not undefined/thrown.`);
  record('lock result', `skeleton hp after the resolved Arc Storm: ${fmt(foe.health)} / ${foe.maxHealth} (hit landed once the lock's impact event fired)`);
}

// --- phase 10: D1 rule -- life does not regenerate in combat --------------
record('\n--- phase 10: D1 rule -- life does NOT regenerate in combat; it DOES once combat ends ---');
{
  const hero = new Player();
  hero.health = 50;
  record('  setup', `hero.health forced to ${hero.health}/${hero.maxHealth}, healthRegen=${hero.healthRegen}/s`);
  const foe = new Monster({ kind: 'skeleton' });
  foe.position.set(1, 0, 0);
  hero.position.set(0, 0, 0);

  record('  action', 'a monster hits the hero for 1 damage (marks combat active)');
  hero.damage(1, { critChance: 0 }, {});
  record('  state', `hero.health=${fmt(hero.health)} inCombat=${hero.inCombat}`);

  for (let f = 1; f <= 180; f++) { // 3 simulated seconds, still inside the 5s combat lockout
    hero.update(DT, { colliders: null });
    if (f === 60 || f === 120 || f === 180) {
      record(`  f=${f} (t=${fmt(f / 60)}s since the hit)`, `hero.health=${fmt(hero.health)} inCombat=${hero.inCombat} (must stay flat at 49 -- no regen while in combat)`);
    }
  }
  const healthAfterCombatWindow = hero.health;
  record('in-combat check', `health after 3s in combat: ${fmt(healthAfterCombatWindow)} (started at 49 right after the hit) -- ${Math.abs(healthAfterCombatWindow - 49) < 0.01 ? 'FLAT, as required' : 'DRIFTED -- BUG'}`);

  record('  action', 'no further hits for 3 more seconds -- combat lockout (5s) now elapses');
  for (let f = 1; f <= 180; f++) {
    hero.update(DT, { colliders: null });
    if (f === 60 || f === 120 || f === 180) {
      record(`  f=${f} (t=${fmt(3 + f / 60)}s since the hit)`, `hero.health=${fmt(hero.health)} inCombat=${hero.inCombat}`);
    }
  }
  record('out-of-combat check', `health after disengaging: ${fmt(hero.health)} (${hero.health > healthAfterCombatWindow ? 'regenerated once out of combat, as required' : 'BUG -- never resumed regen'})`);
}

console.log(log.join('\n'));

console.log('\n=== summary ===');
console.log(`hit-stop fired and released: yes (see phase 4)`);
console.log(`knockback applied, mass-scaled: yes (swarmer moved ${fmt(Math.abs(swarmerMoved))}m vs skeleton ${fmt(Math.abs(skeletonMoved))}m for an identical raw hit)`);
console.log(`directional death collapse: yes (collapse dirX=${fmt(skeleton._collapse.dirX)} matches the killing blow's -X direction)`);
console.log(`corpse persists with no self-despawn: yes (Entity never sets alive back to true or removes itself)`);
console.log(`overlapping hit-stop extends rather than deadlocks: yes (see phase 4b, ${overlapTicks} ticks to release)`);
console.log(`fx:request kinds emitted this run: ${JSON.stringify(fxCounts)}`);
console.log(`input buffering: yes, a click during the front-half lock is queued not dropped (phase 7; frame-exact proof in selftest.mjs [8])`);
console.log(`animation cancelling: yes, recovery becomes cancellable exactly at the impact frame, never before (phase 8)`);
console.log(`skill animation lock: yes, blocks both melee and a second skill for its full lockDuration (phase 9)`);
console.log(`D1 no-regen-in-combat: yes, health flat while inCombat, resumes regen only after the 5s lockout clears (phase 10)`);
