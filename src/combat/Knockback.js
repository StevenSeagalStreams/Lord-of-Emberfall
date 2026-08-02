/**
 * Pure knockback math -- how hard a hit shoves, before mass is applied.
 *
 * `Entity#applyKnockback` (Entity.js) owns the actual inverse-mass division so
 * that every caller of applyKnockback (this file's output, or a flat scripted
 * force like the player's own attack lunge) gets consistent mass behaviour
 * from one place. This module only answers "how much force did this hit
 * generate", which is what makes it testable in isolation.
 */

const MIN_DAMAGE_FOR_SHOVE = 0; // even a 0-damage graze can carry `flat`
const MAX_FORCE = 26;           // absolute ceiling regardless of inputs

/**
 * @param {number} damage         mitigated damage already dealt (post-armour)
 * @param {object} [opts]
 * @param {boolean} [opts.crit]   crits throw bodies harder
 * @param {number} [opts.flat]   a force floor independent of damage (e.g. a shove)
 * @returns {number} force, to be divided by mass by the caller
 */
export function knockbackForce(damage, opts = {}) {
  const dmg = Number.isFinite(damage) ? Math.max(MIN_DAMAGE_FOR_SHOVE, damage) : 0;
  const critBoost = opts.crit ? 1.55 : 1;
  const flat = Number.isFinite(opts.flat) ? opts.flat : 0;
  let force = (dmg * 0.11 + flat) * critBoost;
  if (!Number.isFinite(force) || force < 0) force = 0;
  return Math.min(MAX_FORCE, force);
}
