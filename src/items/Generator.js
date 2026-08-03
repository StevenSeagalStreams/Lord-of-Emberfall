import { BASE_TYPES, QUALITY_TIERS } from './BaseTypes.js';
import { rollAffixes } from './Affixes.js';

/**
 * Item generation: base type -> rarity -> affixes -> a finished item.
 *
 * The rarity table is deliberately far more generous than D2's real one.
 * STABILIZE.md P0-4 sets the feel floor explicitly -- "trash packs drop
 * something visible constantly; a magic (blue) item every pack or two; the
 * screen after a pack fight should have glitter on the ground" -- and that is
 * a *feel* target, not a simulation of Blizzard's drop maths. Rarity here is
 * tuned to hit it and will be re-tuned against the 10k-kill harness and human
 * feel once the loop is playable, per the two-part verification rule.
 */

export const RARITY = {
  normal: { id: 'normal', label: 'Normal', color: 0xc8c8c8, prefixes: 0, suffixes: 0 },
  magic: { id: 'magic', label: 'Magic', color: 0x6f8cff, prefixes: 1, suffixes: 1 },
  rare: { id: 'rare', label: 'Rare', color: 0xf0e06a, prefixes: 2, suffixes: 2 },
};

/** Weights for an item that has already been decided to drop. */
const RARITY_WEIGHTS = [
  [RARITY.normal, 52],
  [RARITY.magic, 41],
  [RARITY.rare, 7],
];

/** Rare items get a two-word invented name rather than "Superior Long Sword". */
const RARE_PREFIX = ['Grim', 'Ash', 'Bone', 'Dread', 'Ember', 'Hollow', 'Pale', 'Rust', 'Gloom', 'Vile'];
const RARE_SUFFIX = ['bite', 'song', 'wail', 'brand', 'shard', 'coil', 'husk', 'rend', 'gaze', 'thorn'];

function pickBase(rng, itemLevel) {
  const eligible = BASE_TYPES.filter((b) => (b.reqLevel ?? 1) <= itemLevel + 2);
  const pool = eligible.length ? eligible : BASE_TYPES;
  return pool[rng.int(0, pool.length - 1)];
}

function pickQuality(rng) {
  return rng.weighted(QUALITY_TIERS.map((q) => [q, q.weight]));
}

/**
 * Build one item.
 * @param {*} rng seeded RNG fork
 * @param {{itemLevel?:number, rarity?:string, base?:object}} opts
 */
export function generateItem(rng, opts = {}) {
  const itemLevel = Math.max(1, opts.itemLevel ?? 1);
  const base = opts.base ?? pickBase(rng, itemLevel);
  const rarity = opts.rarity
    ? RARITY[opts.rarity] ?? RARITY.normal
    : rng.weighted(RARITY_WEIGHTS);

  // Quality only applies to plain items; a magic or rare item's affixes are
  // where its power lives, and stacking "Low Quality Rare" reads as noise.
  const quality = rarity === RARITY.normal ? pickQuality(rng) : QUALITY_TIERS[1];

  const usedGroups = new Set();
  const category = base.category;
  const affixes = [
    ...rollAffixes(rng, { type: 'prefix', count: rarity.prefixes, itemLevel, category, usedGroups }),
    ...rollAffixes(rng, { type: 'suffix', count: rarity.suffixes, itemLevel, category, usedGroups }),
  ];

  const item = {
    id: `${base.id}:${rng.next().toString(36).slice(2, 9)}`,
    base,
    name: nameFor(rng, base, rarity, quality, affixes),
    rarity: rarity.id,
    color: rarity.color,
    quality: quality.id,
    itemLevel,
    slot: base.slot,
    category,
    stats: statsFor(base, quality, affixes),
    affixes,
    reqLevel: base.reqLevel ?? 1,
    reqStr: base.reqStr ?? 0,
    reqDex: base.reqDex ?? 0,
  };
  return item;
}

function nameFor(rng, base, rarity, quality, affixes) {
  if (rarity === RARITY.rare) {
    return `${RARE_PREFIX[rng.int(0, RARE_PREFIX.length - 1)]}${RARE_SUFFIX[rng.int(0, RARE_SUFFIX.length - 1)]}`;
  }
  if (rarity === RARITY.magic) {
    const pre = affixes.find((a) => a.type === 'prefix');
    const suf = affixes.find((a) => a.type === 'suffix');
    return [pre?.name, base.name, suf?.name].filter(Boolean).join(' ');
  }
  return quality.label ? `${quality.label} ${base.name}` : base.name;
}

/**
 * The one place Affixes.js's stat vocabulary is translated into the flat
 * block combat reads. Keeping the translation here (rather than teaching
 * combat about `enhancedDamage`) means a new affix needs no combat change,
 * and it keeps the D2-flavoured affix names in the data where they read well.
 *
 * `values` from `rollAffixValue` is ALWAYS an array -- one entry per
 * sub-roll -- so `damageFlat` carries [minRoll, maxRoll] while a single
 * bracket like `life` carries [amount].
 */
const STAT_MAP = {
  armorFlat: 'armor',
  attackRating: 'attackRating',
  blockChance: 'block',
  critChance: 'critChance',
  dexterity: 'dexterity',
  energy: 'energy',
  fasterHitRecovery: 'hitRecovery',
  fasterRunWalk: 'moveSpeed',
  goldFind: 'goldFind',
  increasedAttackSpeed: 'attackSpeed',
  life: 'life',
  lifeSteal: 'lifeSteal',
  lightRadius: 'lightRadius',
  magicFind: 'magicFind',
  mana: 'mana',
  manaSteal: 'manaSteal',
  resistCold: 'coldRes',
  resistFire: 'fireRes',
  resistLightning: 'lightRes',
  resistPoison: 'poisonRes',
  allResist: 'allRes',
  strength: 'strength',
  thorns: 'thorns',
  vitality: 'vitality',
};

/**
 * Flatten base stats + quality multiplier + affixes into one additive block.
 * Combat only ever reads this, never the affix list.
 */
function statsFor(base, quality, affixes) {
  const s = {
    damageMin: 0, damageMax: 0, armor: 0, block: 0,
    life: 0, mana: 0, strength: 0, dexterity: 0, vitality: 0, energy: 0,
    attackSpeed: 0, moveSpeed: 0, critChance: 0, lifeSteal: 0, manaSteal: 0,
    attackRating: 0, hitRecovery: 0, goldFind: 0, magicFind: 0,
    lightRadius: 0, thorns: 0,
    fireRes: 0, coldRes: 0, lightRes: 0, poisonRes: 0, allRes: 0,
  };
  const m = quality.mult ?? 1;
  if (base.damage) {
    s.damageMin += Math.round(base.damage[0] * m);
    s.damageMax += Math.round(base.damage[1] * m);
  }
  if (base.armor) s.armor += Math.round(base.armor * m);
  if (base.block) s.block += base.block;

  // Percentage affixes multiply the BASE, and so must be collected before
  // flat adds are folded in -- otherwise "+50% enhanced damage" would also
  // scale the flat "+3-6 damage" from a different affix, which is not how
  // the genre's maths works and would compound badly on a rare.
  let enhDamage = 0;
  let enhDefense = 0;

  for (const a of affixes) {
    if (!a.stat) continue;
    const v = Array.isArray(a.values) ? a.values : [a.values];
    if (a.stat === 'damageFlat') {
      s.damageMin += v[0] ?? 0;
      s.damageMax += v[1] ?? v[0] ?? 0;
      continue;
    }
    if (a.stat === 'enhancedDamage') { enhDamage += v[0] ?? 0; continue; }
    if (a.stat === 'enhancedDefense') { enhDefense += v[0] ?? 0; continue; }
    const key = STAT_MAP[a.stat];
    if (key) s[key] = (s[key] ?? 0) + (v[0] ?? 0);
  }

  if (enhDamage) {
    const baseMin = base.damage ? Math.round(base.damage[0] * m) : 0;
    const baseMax = base.damage ? Math.round(base.damage[1] * m) : 0;
    s.damageMin += Math.round(baseMin * enhDamage / 100);
    s.damageMax += Math.round(baseMax * enhDamage / 100);
  }
  if (enhDefense && base.armor) {
    s.armor += Math.round(Math.round(base.armor * m) * enhDefense / 100);
  }
  return s;
}

/** Human-readable lines for a tooltip or the ground label. */
export function describeItem(item) {
  const out = [];
  const s = item.stats;
  if (s.damageMin || s.damageMax) out.push(`${s.damageMin}-${s.damageMax} damage`);
  if (s.armor) out.push(`${s.armor} armour`);
  for (const a of item.affixes) {
    const v = Array.isArray(a.values) ? a.values.join('-') : a.values;
    out.push(`+${v} ${a.group.replace(/_/g, ' ')}`);
  }
  return out;
}
