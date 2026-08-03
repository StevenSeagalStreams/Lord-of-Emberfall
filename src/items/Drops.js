import { generateItem, RARITY } from './Generator.js';

/**
 * What a corpse leaves behind.
 *
 * STABILIZE.md P0-4 sets the feel floor in plain words: *"trash packs drop
 * something visible constantly; a magic (blue) item every pack or two; the
 * screen after a pack fight should have glitter on the ground."* These tables
 * are tuned to hit that, and the numbers below are stated as probabilities so
 * they can be checked against a kill harness rather than argued about.
 *
 * With a 4-monster pack of trash at `dropChance` 0.72, the chance the whole
 * pack drops nothing at all is 0.28^4 ~= 0.6%, so "constantly" holds.
 *
 * The magic-item rate is the product of THREE terms, not two, and getting
 * that wrong is how the first tuning pass here came out at barely half the
 * mandated rate: a kill must drop at all (0.72), the slot must roll
 * equipment rather than gold or a potion (0.44), and the item must roll
 * magic (0.41). That is ~0.13 per kill, so ~1.04 magic items per two
 * four-monster packs -- which is the "every pack or two" the mandate asks
 * for. `src/items/droptest.mjs` measures it rather than trusting this
 * comment.
 *
 * These are FEEL numbers, deliberately far above a D2-accurate simulation.
 * They get re-tuned against a 10k-kill harness AND human feel, in that order,
 * once the loop is actually playable -- never by one alone.
 */

/** Per-kill chance that a monster drops anything at all, by monster rank. */
const DROP_CHANCE = { trash: 0.72, champion: 1.0, rare: 1.0, boss: 1.0 };

/** How many separate things a kill can drop, by rank. */
const DROP_COUNT = {
  trash: [1, 1],
  champion: [2, 3],
  rare: [3, 4],
  boss: [4, 6],
};

/**
 * What kind of thing a single drop slot becomes. Gold and potions carry most
 * of the "constantly" load -- they are cheap to produce, instantly readable
 * on the floor, and they are what makes a cleared room glitter. Equipment is
 * the rarer, more meaningful hit.
 */
const KIND_WEIGHTS = [
  ['gold', 38],
  ['potion', 18],
  ['equipment', 44],
];

/** Ranks above trash bias hard toward equipment -- that is what makes a
 *  champion worth pulling rather than avoiding. */
const KIND_WEIGHTS_ELITE = [
  ['gold', 22],
  ['potion', 10],
  ['equipment', 68],
];

export const POTIONS = [
  { id: 'minor_healing', name: 'Minor Healing Potion', kind: 'heal', amount: 45, color: 0xd8402c },
  { id: 'light_healing', name: 'Light Healing Potion', kind: 'heal', amount: 90, color: 0xe8503a },
  { id: 'minor_mana', name: 'Minor Mana Potion', kind: 'mana', amount: 40, color: 0x3a6ce8 },
];

function rankOf(entity) {
  if (entity?.isBoss || entity?.rank === 'boss') return 'boss';
  if (entity?.rank === 'rare' || entity?.isRare) return 'rare';
  if (entity?.rank === 'champion' || entity?.isChampion) return 'champion';
  return 'trash';
}

/**
 * Roll everything a single kill drops.
 * @returns {Array<{type:'gold'|'potion'|'equipment', ...}>} possibly empty
 */
export function rollDrops(rng, entity, { itemLevel = 1, dropMultiplier = 1 } = {}) {
  const rank = rankOf(entity);
  const chance = Math.min(1, (DROP_CHANCE[rank] ?? 0.72) * dropMultiplier);
  if (rng.next() > chance) return [];

  const [lo, hi] = DROP_COUNT[rank] ?? [1, 1];
  const count = rng.int(lo, hi);
  const weights = rank === 'trash' ? KIND_WEIGHTS : KIND_WEIGHTS_ELITE;

  const out = [];
  for (let i = 0; i < count; i++) {
    const kind = rng.weighted(weights);
    if (kind === 'gold') {
      const base = 4 + itemLevel * 3;
      out.push({ type: 'gold', amount: rng.int(Math.ceil(base * 0.5), Math.ceil(base * 1.8)) });
    } else if (kind === 'potion') {
      const pool = POTIONS.filter((p) => itemLevel >= 4 || p.id !== 'light_healing');
      out.push({ type: 'potion', potion: pool[rng.int(0, pool.length - 1)] });
    } else {
      // A boss is guaranteed at least one non-normal item, so killing one
      // never feels like killing trash that took longer.
      const forced = rank === 'boss' && i === 0 ? 'rare' : undefined;
      out.push({ type: 'equipment', item: generateItem(rng, { itemLevel, rarity: forced }) });
    }
  }
  return out;
}

/** Colour a drop reads as on the floor and in its beam. */
export function dropColor(drop) {
  if (drop.type === 'gold') return 0xf0c46a;
  if (drop.type === 'potion') return drop.potion.color;
  return RARITY[drop.item.rarity]?.color ?? 0xc8c8c8;
}

/** Ground label text. */
export function dropLabel(drop) {
  if (drop.type === 'gold') return `${drop.amount} Gold`;
  if (drop.type === 'potion') return drop.potion.name;
  return drop.item.name;
}

/** Rarity key used by the fx layer's beam colours and by telemetry. */
export function dropRarity(drop) {
  if (drop.type === 'gold') return 'gold';
  if (drop.type === 'potion') return 'potion';
  return drop.item.rarity;
}
