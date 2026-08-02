/**
 * M1 behaviour + stat profiles, keyed by spawn `kind`.
 *
 * Deliberately just two real profiles (swarmer, skeleton) plus one defensive
 * fallback (`brute`, since `catacombs.js` boss rooms already spawn that kind
 * even though full brute tuning is M2 scope) -- systems depth (full skill
 * tree, elite affixes, 6 archetypes) is explicitly out of scope for M1.
 *
 * These values are the primary source of truth for a monster's combat feel.
 * main.js currently spawns every non-`brute` monster with the same flat
 * fallback `maxHealth` (46) regardless of kind (it does not know about the
 * swarmer/skeleton split), so Monster.js intentionally prefers the profile's
 * numbers over whatever main.js passed in for the stats that define how a
 * kind *fights* -- see the note in Monster.js and the mission report.
 */
export const MONSTER_PROFILES = {
  swarmer: {
    kind: 'swarmer',
    radius: 0.32, height: 1.55, mass: 0.55,
    moveSpeed: 5.6, acceleration: 30, friction: 16,
    maxHealth: 24, armor: 0,
    aggroRange: 16, leashRange: 30, alertRadius: 11,
    attackRange: 1.5, attackDamage: 6, attackVariance: 0.3,
    attackDuration: 0.50, windupEventAt: 0.42, whooshEventAt: 0.22,
    attackInterval: 0.85, stagger: 0.32,
    critChance: 0.04, critMultiplier: 1.6,
    experienceValue: 6,
    packMaxAttackers: 3, circleRadiusMul: 1.35, repositionTime: 0.35,
    erratic: 1.0,
    strideLength: 1.5, bounce: 1.6, weight: 0.55, idleSway: 1.3,
  },
  skeleton: {
    kind: 'skeleton',
    radius: 0.40, height: 1.78, mass: 1.15,
    moveSpeed: 3.0, acceleration: 20, friction: 20,
    // Gate 1 tuning pass: at the player's ~16.8 avg mitigated melee damage
    // (18avg base vs armor 6), 46 hp lands squarely in the mandated
    // "trash TTK 1-3 hits early game" (52/16.8=3.1 hits was a shade over).
    maxHealth: 46, armor: 6,
    aggroRange: 13, leashRange: 32, alertRadius: 9,
    attackRange: 2.0, attackDamage: 15, attackVariance: 0.18,
    attackDuration: 1.05, windupEventAt: 0.58, whooshEventAt: 0.34,
    // 1.7 -> 1.5: a lone skeleton was too gentle (7.9 dps) to read as a real
    // threat; catacombs.js spawns 1-4 per room, so most fights are packs, not
    // solos -- this raises per-attacker dps just enough that 2-3 committed
    // attackers (see packMaxAttackers below) is genuinely lethal to a
    // careless player, not just a health-bar tax.
    attackInterval: 1.5, stagger: 0.72,
    critChance: 0.07, critMultiplier: 1.8,
    experienceValue: 16,
    // 2 -> 3: catacombs.js spawns up to 4 skeletons per room; letting 3
    // commit at once (instead of 2) is what makes a full room feel like it is
    // surrounding you rather than taking polite turns -- the pull system
    // mandate ("packs you plan around") needs the pack to actually hit like
    // one. Combined with the interval change above: 3 concurrent attackers
    // vs the player's 220 hp / 5 armor is a ~8s time-to-kill if you stand and
    // facetank a full room, survivable if you pull fewer, retreat into a
    // corridor to cap how many can reach you, or use Frost Nova.
    packMaxAttackers: 3, circleRadiusMul: 1.0, repositionTime: 0.6,
    erratic: 0.12,
    strideLength: 1.0, bounce: 1.1, weight: 1.3, idleSway: 0.5,
  },
  // Not an M1 kind -- kept only so a stray spawn (e.g. a catacombs boss room,
  // which is M2 content) degrades to something coherent instead of crashing
  // or silently reusing swarmer/skeleton numbers.
  brute: {
    kind: 'brute',
    radius: 0.50, height: 2.05, mass: 2.4,
    moveSpeed: 2.6, acceleration: 16, friction: 16,
    maxHealth: 140, armor: 10,
    aggroRange: 14, leashRange: 34, alertRadius: 8,
    attackRange: 2.3, attackDamage: 24, attackVariance: 0.15,
    attackDuration: 1.3, windupEventAt: 0.62, whooshEventAt: 0.4,
    attackInterval: 2.0, stagger: 0.9,
    critChance: 0.05, critMultiplier: 1.8,
    experienceValue: 40,
    packMaxAttackers: 2, circleRadiusMul: 0.9, repositionTime: 0.7,
    erratic: 0.08,
    strideLength: 0.85, bounce: 0.9, weight: 1.7, idleSway: 0.4,
  },
};

export function getMonsterProfile(kind) {
  return MONSTER_PROFILES[kind] || MONSTER_PROFILES.skeleton;
}
