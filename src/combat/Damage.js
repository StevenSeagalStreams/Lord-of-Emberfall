/**
 * Central, pure damage math.
 *
 * No THREE, no DOM, no world reference -- runnable under plain node for the
 * self-test. `Entity#damage()` is the only caller in the running game, and
 * every hit that lands anywhere (player-on-monster, monster-on-player,
 * monster-on-monster if that is ever added) funnels through it, which makes
 * this file the one auditable place damage numbers come from.
 */

const ARMOR_K = 45;                 // armour at which reduction reaches 50%
const MAX_ARMOR_REDUCTION = 0.82;   // armour can never fully negate a hit
const MIN_LANDED_DAMAGE = 1;        // a hit that connects always does *something*

function num(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Monotonic, bounded armour mitigation curve: 0 armour -> 0 reduction, rises
 * toward MAX_ARMOR_REDUCTION as armour grows but never reaches it (asymptotic
 * diminishing returns, the standard ARPG shape).
 */
export function armorReduction(armor) {
  const a = Math.max(0, num(armor, 0));
  const frac = a / (a + ARMOR_K);
  return Math.min(MAX_ARMOR_REDUCTION, frac);
}

/** @param {number} chance [0,1]  @param {() => number} rng */
export function rollCrit(chance, rng = Math.random) {
  const c = Math.min(1, Math.max(0, num(chance, 0)));
  if (c <= 0) return false;
  const fn = typeof rng === 'function' ? rng : Math.random;
  const roll = num(fn(), 1);
  return roll < c;
}

/**
 * @param {object} input
 * @param {number} input.baseAmount        raw physical damage before mitigation
 * @param {number} [input.armor]           victim armour
 * @param {number} [input.critChance]      attacker crit chance [0,1]
 * @param {number} [input.critMultiplier]  damage multiplier on crit
 * @param {boolean} [input.forceCrit]      override the roll (scripted hits, tests)
 * @param {() => number} [input.rng]
 * @returns {{amount:number, crit:boolean, reduction:number, raw:number}}
 */
export function computeDamage(input = {}) {
  const base = Math.max(0, num(input.baseAmount, 0));
  const reduction = armorReduction(input.armor);
  const mitigated = base * (1 - reduction);

  const crit = typeof input.forceCrit === 'boolean'
    ? input.forceCrit
    : rollCrit(input.critChance, input.rng);
  const critMult = crit ? Math.max(1, num(input.critMultiplier, 1.75)) : 1;

  let amount = mitigated * critMult;
  if (!Number.isFinite(amount) || amount < 0) amount = 0;
  if (base > 0) amount = Math.max(MIN_LANDED_DAMAGE, amount);

  return { amount, crit: !!crit, reduction, raw: base };
}

export const DAMAGE_TUNING = { ARMOR_K, MAX_ARMOR_REDUCTION, MIN_LANDED_DAMAGE };
