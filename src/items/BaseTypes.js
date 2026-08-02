/**
 * Base item type table.
 *
 * Every generated item starts life as one row from this table: a slot, a
 * grid footprint (D2-style width x height in inventory cells), requirements,
 * and a base stat block. Rarity and affixes are layered on top in
 * Generator.js -- nothing here is randomised.
 *
 * `category` drives affix eligibility (see Affixes.js `appliesTo`):
 *   'weapon'  -- one- or two-handed melee weapon, mainhand slot
 *   'shield'  -- off-hand, contributes armor + block
 *   'armor'   -- helm / body / gloves / boots / belt
 *   'jewelry' -- amulet / ring, no base stats, pure affix carriers
 */

/** @typedef {'weapon'|'shield'|'armor'|'jewelry'} ItemCategory */

let _uid = 0;
function row(def) {
  return { uid: _uid++, ...def };
}

export const BASE_TYPES = [
  // --------------------------------------------------------------- weapons (1H)
  row({ id: 'dagger', name: 'Dagger', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 2, reqLevel: 1, reqStr: 15, reqDex: 20, damage: [2, 5] }),
  row({ id: 'short_sword', name: 'Short Sword', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 1, reqStr: 18, reqDex: 0, damage: [3, 7] }),
  row({ id: 'hand_axe', name: 'Hand Axe', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 2, reqStr: 20, reqDex: 0, damage: [4, 8] }),
  row({ id: 'mace', name: 'Mace', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 3, reqStr: 25, reqDex: 0, damage: [5, 10] }),
  row({ id: 'long_sword', name: 'Long Sword', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 6, reqStr: 32, reqDex: 0, damage: [7, 14] }),
  row({ id: 'battle_axe', name: 'Battle Axe', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 9, reqStr: 38, reqDex: 0, damage: [9, 18] }),
  row({ id: 'war_sword', name: 'War Sword', slot: 'weapon', category: 'weapon', hands: 1,
    w: 1, h: 3, reqLevel: 16, reqStr: 48, reqDex: 15, damage: [13, 24] }),

  // --------------------------------------------------------------- weapons (2H)
  row({ id: 'great_sword', name: 'Great Sword', slot: 'weapon', category: 'weapon', hands: 2,
    w: 2, h: 4, reqLevel: 12, reqStr: 50, reqDex: 20, damage: [18, 32] }),
  row({ id: 'war_axe', name: 'War Axe', slot: 'weapon', category: 'weapon', hands: 2,
    w: 2, h: 4, reqLevel: 15, reqStr: 55, reqDex: 0, damage: [20, 38] }),
  row({ id: 'battle_hammer', name: 'Battle Hammer', slot: 'weapon', category: 'weapon', hands: 2,
    w: 2, h: 4, reqLevel: 18, reqStr: 60, reqDex: 0, damage: [24, 44] }),
  row({ id: 'polearm', name: 'Polearm', slot: 'weapon', category: 'weapon', hands: 2,
    w: 2, h: 4, reqLevel: 24, reqStr: 65, reqDex: 25, damage: [28, 52] }),
  row({ id: 'long_bow', name: 'Long Bow', slot: 'weapon', category: 'weapon', hands: 2,
    w: 2, h: 4, reqLevel: 10, reqStr: 25, reqDex: 45, damage: [10, 20] }),

  // --------------------------------------------------------------- shields
  row({ id: 'buckler', name: 'Buckler', slot: 'offhand', category: 'shield', hands: 1,
    w: 2, h: 2, reqLevel: 1, reqStr: 20, reqDex: 0, armor: 8, block: 0.12 }),
  row({ id: 'kite_shield', name: 'Kite Shield', slot: 'offhand', category: 'shield', hands: 1,
    w: 2, h: 3, reqLevel: 8, reqStr: 32, reqDex: 0, armor: 20, block: 0.20 }),
  row({ id: 'tower_shield', name: 'Tower Shield', slot: 'offhand', category: 'shield', hands: 1,
    w: 2, h: 4, reqLevel: 18, reqStr: 48, reqDex: 0, armor: 38, block: 0.30 }),

  // --------------------------------------------------------------- helms
  row({ id: 'leather_cap', name: 'Leather Cap', slot: 'helm', category: 'armor',
    w: 2, h: 2, reqLevel: 1, reqStr: 12, reqDex: 0, armor: 6 }),
  row({ id: 'chain_coif', name: 'Chain Coif', slot: 'helm', category: 'armor',
    w: 2, h: 2, reqLevel: 8, reqStr: 25, reqDex: 0, armor: 16 }),
  row({ id: 'great_helm', name: 'Great Helm', slot: 'helm', category: 'armor',
    w: 2, h: 2, reqLevel: 16, reqStr: 40, reqDex: 0, armor: 30 }),

  // --------------------------------------------------------------- body armor
  row({ id: 'quilted_armor', name: 'Quilted Armor', slot: 'body', category: 'armor',
    w: 2, h: 3, reqLevel: 1, reqStr: 15, reqDex: 0, armor: 10 }),
  row({ id: 'chain_mail', name: 'Chain Mail', slot: 'body', category: 'armor',
    w: 2, h: 3, reqLevel: 8, reqStr: 30, reqDex: 0, armor: 24 }),
  row({ id: 'plate_mail', name: 'Plate Mail', slot: 'body', category: 'armor',
    w: 2, h: 3, reqLevel: 18, reqStr: 48, reqDex: 0, armor: 45 }),

  // --------------------------------------------------------------- gloves
  row({ id: 'leather_gloves', name: 'Leather Gloves', slot: 'gloves', category: 'armor',
    w: 2, h: 2, reqLevel: 1, reqStr: 10, reqDex: 0, armor: 4 }),
  row({ id: 'gauntlets', name: 'Gauntlets', slot: 'gloves', category: 'armor',
    w: 2, h: 2, reqLevel: 10, reqStr: 28, reqDex: 0, armor: 10 }),

  // --------------------------------------------------------------- boots
  row({ id: 'leather_boots', name: 'Leather Boots', slot: 'boots', category: 'armor',
    w: 2, h: 2, reqLevel: 1, reqStr: 10, reqDex: 0, armor: 4 }),
  row({ id: 'chain_boots', name: 'Chain Boots', slot: 'boots', category: 'armor',
    w: 2, h: 2, reqLevel: 10, reqStr: 28, reqDex: 0, armor: 10 }),

  // --------------------------------------------------------------- belts
  row({ id: 'sash', name: 'Sash', slot: 'belt', category: 'armor',
    w: 2, h: 2, reqLevel: 1, reqStr: 8, reqDex: 0, armor: 3 }),
  row({ id: 'war_belt', name: 'War Belt', slot: 'belt', category: 'armor',
    w: 2, h: 2, reqLevel: 12, reqStr: 30, reqDex: 0, armor: 8 }),

  // --------------------------------------------------------------- jewelry
  row({ id: 'amulet', name: 'Amulet', slot: 'amulet', category: 'jewelry',
    w: 1, h: 1, reqLevel: 1, reqStr: 0, reqDex: 0 }),
  row({ id: 'ring', name: 'Ring', slot: 'ring', category: 'jewelry',
    w: 1, h: 1, reqLevel: 1, reqStr: 0, reqDex: 0 }),
];

export function baseTypesForSlot(slot) {
  return BASE_TYPES.filter((b) => b.slot === slot);
}

export function baseTypeById(id) {
  return BASE_TYPES.find((b) => b.id === id);
}

/** Base-item quality tiers (D2's "low quality / normal / superior"). */
export const QUALITY_TIERS = [
  { id: 'low', label: 'Low Quality', weight: 10, mult: 0.85 },
  { id: 'normal', label: '', weight: 80, mult: 1.0 },
  { id: 'superior', label: 'Superior', weight: 10, mult: 1.15 },
];
