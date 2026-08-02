/**
 * Gate 1 skill data -- exactly three, per the scope firewall in VISION.md.
 * Pure data (no THREE, no world reference) so it can be asserted on directly
 * from a plain-node test. `index.js` is the only thing that interprets it.
 *
 * Each skill has a distinct reason to exist:
 *   firebolt   -- builder: cheap, fast, ranged poke that applies a stacking
 *                 burn debuff. Opens a fight at range and chips through
 *                 armour over time instead of doing all its work on-hit.
 *   arcstorm   -- spender/AoE: expensive, on a real cooldown, hits every
 *                 hostile in a radius around the player. This is the skill
 *                 that makes a pack fight interesting instead of a single-
 *                 target grind.
 *   frostnova  -- defensive/escape: near-instant panic button. Stuns the
 *                 room briefly, then slows everything it hit for several
 *                 seconds -- the VISION mandate's "the player needs a stun
 *                 and a slow so a bad pull is barely recoverable by skill",
 *                 both delivered by one cast.
 *
 * Hotbar keys match the HUD's existing (unowned, not to be edited) icon
 * order -- 1=sword/basic attack, 2=fire, 3=frost, 4=lightning, Q=potion --
 * so the already-built hotbar art lines up with real behaviour for free.
 */
export const SKILLS = {
  firebolt: {
    id: 'firebolt', key: 'Digit2', name: 'Firebolt', role: 'builder',
    manaCost: 6, cooldown: 0.6,
    lockDuration: 0.30, impactAt: 0.55, whooshAt: 0.15,
    range: 12,
    damage: [8, 13],
    burn: { amount: 3, ticks: 3, interval: 0.5, maxStacks: 3 },
    // Firebolt is a real projectile (G3): it leaves the caster's hand on the
    // cast's 'impact' animation event, flies for `travel*` below, and only
    // THEN applies damage/burn/impactFx on arrival -- see src/skills/index.js.
    castFx: 'fireball_cast', travelFx: 'fireball_travel', impactFx: 'fireball_impact',
    travelSpeed: 30,          // world units / second
    travelMin: 0.15, travelMax: 0.3, // clamp so travel always reads, never drags
  },
  arcstorm: {
    id: 'arcstorm', key: 'Digit4', name: 'Arc Storm', role: 'spender',
    manaCost: 26, cooldown: 5.0,
    lockDuration: 0.55, impactAt: 0.6, whooshAt: 0.2,
    radius: 4.2,
    damage: [22, 30],
    knockback: 3.5,
    castFx: 'lightning_cast', arcFx: 'lightning_arc', impactFx: 'lightning_impact',
  },
  frostnova: {
    id: 'frostnova', key: 'Digit3', name: 'Frost Nova', role: 'defensive',
    manaCost: 18, cooldown: 9.0,
    lockDuration: 0.18, impactAt: 0.5, whooshAt: 0.05,
    radius: 4.5,
    damage: [6, 10],
    stun: 0.6,
    slow: { duration: 3.0, factor: 0.6 },
    // Frost Nova has no travel stage (it is a self-centred AoE, not a
    // projectile) but still needs to be LEGIBLE -- an expanding ring drawn
    // at `radius` so the player can see who it caught. See G4's sibling
    // requirement in ARCHITECTURE.md ("apply the same treatment to frost").
    castFx: 'frost_cast', ringFx: 'frost_ring', impactFx: 'frost_impact',
  },
};

export const SKILL_LIST = Object.values(SKILLS);
