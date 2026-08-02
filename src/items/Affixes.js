/**
 * Prefix / suffix affix pool -- the D2 mould.
 *
 * Each entry belongs to a `group` (the *stat family*, e.g. "lifeFlat"):
 * an item may never carry two affixes from the same group, regardless of
 * whether they are both prefixes, both suffixes, or one of each. Several
 * entries share a group at rising `levelReq` -- that is what makes "+10 to
 * Life" give way to "+70 to Life" as item level climbs, exactly like D2's
 * affix tiers.
 *
 * `appliesTo` gates by base-item category ('weapon' | 'shield' | 'armor' |
 * 'jewelry'); 'any' means every category. `weight` is the relative spawn
 * chance among affixes currently eligible (level gate + category + group not
 * already used on this item).
 *
 * `stat` + `range` describe what gets rolled: a value in [min,max] is drawn
 * independently per affix and written to `item's stat bag under `stat` (or
 * summed if the same key is hit by more than one source, which the mutual
 * exclusion group makes impossible within one item -- but happens routinely
 * once uniques/sets are added on top).
 */

const P = 'prefix';
const S = 'suffix';

export const AFFIXES = [
  // ----------------------------------------------------------- prefixes: damage
  { id: 'sharp', group: 'flatDamage', type: P, name: 'Sharp', levelReq: 1, weight: 100,
    appliesTo: ['weapon'], stat: 'damageFlat', range: [[1, 3], [2, 4]] },
  { id: 'vicious', group: 'flatDamage', type: P, name: 'Vicious', levelReq: 8, weight: 60,
    appliesTo: ['weapon'], stat: 'damageFlat', range: [[4, 6], [6, 9]] },
  { id: 'merciless', group: 'flatDamage', type: P, name: 'Merciless', levelReq: 20, weight: 30,
    appliesTo: ['weapon'], stat: 'damageFlat', range: [[9, 13], [14, 20]] },

  { id: 'warriors', group: 'enhancedDamage', type: P, name: "Warrior's", levelReq: 6, weight: 80,
    appliesTo: ['weapon'], stat: 'enhancedDamage', range: [[20, 40]] },
  { id: 'tyrants', group: 'enhancedDamage', type: P, name: "Tyrant's", levelReq: 18, weight: 45,
    appliesTo: ['weapon'], stat: 'enhancedDamage', range: [[41, 70]] },
  { id: 'godly', group: 'enhancedDamage', type: P, name: 'Godly', levelReq: 35, weight: 15,
    appliesTo: ['weapon'], stat: 'enhancedDamage', range: [[71, 120]] },

  // ----------------------------------------------------------- prefixes: armor
  { id: 'sturdy', group: 'armorFlat', type: P, name: 'Sturdy', levelReq: 3, weight: 100,
    appliesTo: ['armor', 'shield'], stat: 'armorFlat', range: [[8, 15]] },
  { id: 'glorious', group: 'armorFlat', type: P, name: 'Glorious', levelReq: 15, weight: 55,
    appliesTo: ['armor', 'shield'], stat: 'armorFlat', range: [[16, 30]] },
  { id: 'impregnable', group: 'armorFlat', type: P, name: 'Impregnable', levelReq: 30, weight: 20,
    appliesTo: ['armor', 'shield'], stat: 'armorFlat', range: [[31, 55]] },

  { id: 'reinforced', group: 'enhancedDefense', type: P, name: 'Reinforced', levelReq: 10, weight: 60,
    appliesTo: ['armor', 'shield'], stat: 'enhancedDefense', range: [[20, 40]] },
  { id: 'ironclad', group: 'enhancedDefense', type: P, name: 'Ironclad', levelReq: 25, weight: 25,
    appliesTo: ['armor', 'shield'], stat: 'enhancedDefense', range: [[41, 70]] },

  // ----------------------------------------------------------- prefixes: attributes
  { id: 'strong', group: 'attrStr', type: P, name: 'Strong', levelReq: 1, weight: 90,
    appliesTo: ['any'], stat: 'strength', range: [[3, 5]] },
  { id: 'brawny', group: 'attrStr', type: P, name: 'Brawny', levelReq: 12, weight: 45,
    appliesTo: ['any'], stat: 'strength', range: [[6, 10]] },
  { id: 'herculean', group: 'attrStr', type: P, name: 'Herculean', levelReq: 27, weight: 18,
    appliesTo: ['any'], stat: 'strength', range: [[11, 16]] },

  { id: 'quick', group: 'attrDex', type: P, name: 'Quick', levelReq: 1, weight: 90,
    appliesTo: ['any'], stat: 'dexterity', range: [[3, 5]] },
  { id: 'agile', group: 'attrDex', type: P, name: 'Agile', levelReq: 12, weight: 45,
    appliesTo: ['any'], stat: 'dexterity', range: [[6, 10]] },
  { id: 'feline', group: 'attrDex', type: P, name: 'Feline', levelReq: 27, weight: 18,
    appliesTo: ['any'], stat: 'dexterity', range: [[11, 16]] },

  { id: 'hardy', group: 'attrVit', type: P, name: 'Hardy', levelReq: 1, weight: 90,
    appliesTo: ['any'], stat: 'vitality', range: [[3, 5]] },
  { id: 'stalwart', group: 'attrVit', type: P, name: 'Stalwart', levelReq: 12, weight: 45,
    appliesTo: ['any'], stat: 'vitality', range: [[6, 10]] },
  { id: 'undying', group: 'attrVit', type: P, name: 'Undying', levelReq: 27, weight: 18,
    appliesTo: ['any'], stat: 'vitality', range: [[11, 16]] },

  { id: 'studious', group: 'attrEne', type: P, name: 'Studious', levelReq: 1, weight: 80,
    appliesTo: ['any'], stat: 'energy', range: [[3, 5]] },
  { id: 'focused', group: 'attrEne', type: P, name: 'Focused', levelReq: 12, weight: 40,
    appliesTo: ['any'], stat: 'energy', range: [[6, 10]] },
  { id: 'arcane', group: 'attrEne', type: P, name: 'Arcane', levelReq: 27, weight: 16,
    appliesTo: ['any'], stat: 'energy', range: [[11, 16]] },

  // ----------------------------------------------------------- prefixes: life / mana
  { id: 'robust', group: 'lifeFlat', type: P, name: 'Robust', levelReq: 4, weight: 80,
    appliesTo: ['any'], stat: 'life', range: [[10, 20]] },
  { id: 'vital', group: 'lifeFlat', type: P, name: 'Vital', levelReq: 16, weight: 40,
    appliesTo: ['any'], stat: 'life', range: [[21, 40]] },
  { id: 'vampiric', group: 'lifeFlat', type: P, name: 'Vampiric', levelReq: 30, weight: 15,
    appliesTo: ['any'], stat: 'life', range: [[41, 70]] },

  { id: 'sorcerous', group: 'manaFlat', type: P, name: 'Sorcerous', levelReq: 4, weight: 70,
    appliesTo: ['any'], stat: 'mana', range: [[10, 20]] },
  { id: 'arcanic', group: 'manaFlat', type: P, name: 'Arcanic', levelReq: 16, weight: 35,
    appliesTo: ['any'], stat: 'mana', range: [[21, 40]] },
  { id: 'runic', group: 'manaFlat', type: P, name: 'Runic', levelReq: 30, weight: 12,
    appliesTo: ['any'], stat: 'mana', range: [[41, 70]] },

  // ----------------------------------------------------------- prefixes: misc
  { id: 'accurate', group: 'attackRating', type: P, name: 'Accurate', levelReq: 2, weight: 80,
    appliesTo: ['weapon'], stat: 'attackRating', range: [[15, 30]] },
  { id: 'deadly', group: 'attackRating', type: P, name: 'Deadly', levelReq: 14, weight: 40,
    appliesTo: ['weapon'], stat: 'attackRating', range: [[31, 60]] },
  { id: 'unerring', group: 'attackRating', type: P, name: 'Unerring', levelReq: 28, weight: 15,
    appliesTo: ['weapon'], stat: 'attackRating', range: [[61, 110]] },

  { id: 'balanced', group: 'blockChance', type: P, name: 'Balanced', levelReq: 5, weight: 50,
    appliesTo: ['shield'], stat: 'blockChance', range: [[4, 8]] },
  { id: 'guarded', group: 'blockChance', type: P, name: 'Guarded', levelReq: 20, weight: 20,
    appliesTo: ['shield'], stat: 'blockChance', range: [[9, 15]] },

  { id: 'fortunate', group: 'goldFind', type: P, name: 'Fortunate', levelReq: 1, weight: 40,
    appliesTo: ['any'], stat: 'goldFind', range: [[15, 30]] },
  { id: 'glowing', group: 'lightRadius', type: P, name: 'Glowing', levelReq: 1, weight: 25,
    appliesTo: ['any'], stat: 'lightRadius', range: [[1, 2]] },

  // ----------------------------------------------------------- suffixes: resistances
  { id: 'of_ember_ward', group: 'resistFire', type: S, name: 'of Ember Ward', levelReq: 6, weight: 60,
    appliesTo: ['any'], stat: 'resistFire', range: [[8, 15]] },
  { id: 'of_the_phoenix', group: 'resistFire', type: S, name: 'of the Phoenix', levelReq: 20, weight: 22,
    appliesTo: ['any'], stat: 'resistFire', range: [[16, 30]] },

  { id: 'of_rime_ward', group: 'resistCold', type: S, name: 'of Rime Ward', levelReq: 6, weight: 60,
    appliesTo: ['any'], stat: 'resistCold', range: [[8, 15]] },
  { id: 'of_the_glacier', group: 'resistCold', type: S, name: 'of the Glacier', levelReq: 20, weight: 22,
    appliesTo: ['any'], stat: 'resistCold', range: [[16, 30]] },

  { id: 'of_storm_ward', group: 'resistLightning', type: S, name: 'of Storm Ward', levelReq: 6, weight: 60,
    appliesTo: ['any'], stat: 'resistLightning', range: [[8, 15]] },
  { id: 'of_the_tempest', group: 'resistLightning', type: S, name: 'of the Tempest', levelReq: 20, weight: 22,
    appliesTo: ['any'], stat: 'resistLightning', range: [[16, 30]] },

  { id: 'of_venom_ward', group: 'resistPoison', type: S, name: 'of Venom Ward', levelReq: 6, weight: 60,
    appliesTo: ['any'], stat: 'resistPoison', range: [[8, 15]] },
  { id: 'of_the_serpent', group: 'resistPoison', type: S, name: 'of the Serpent', levelReq: 20, weight: 22,
    appliesTo: ['any'], stat: 'resistPoison', range: [[16, 30]] },

  { id: 'of_the_ancients', group: 'resistAll', type: S, name: 'of the Ancients', levelReq: 32, weight: 10,
    appliesTo: ['any'], stat: 'allResist', range: [[8, 14]] },

  // ----------------------------------------------------------- suffixes: leech / speed
  { id: 'of_the_leech', group: 'lifeSteal', type: S, name: 'of the Leech', levelReq: 10, weight: 40,
    appliesTo: ['weapon'], stat: 'lifeSteal', range: [[3, 5]] },
  { id: 'of_the_vampire', group: 'lifeSteal', type: S, name: 'of the Vampire', levelReq: 26, weight: 14,
    appliesTo: ['weapon'], stat: 'lifeSteal', range: [[6, 8]] },

  { id: 'of_the_wraith', group: 'manaSteal', type: S, name: 'of the Wraith', levelReq: 12, weight: 30,
    appliesTo: ['weapon'], stat: 'manaSteal', range: [[2, 4]] },
  { id: 'of_the_specter', group: 'manaSteal', type: S, name: 'of the Specter', levelReq: 28, weight: 10,
    appliesTo: ['weapon'], stat: 'manaSteal', range: [[5, 7]] },

  { id: 'of_alacrity', group: 'ias', type: S, name: 'of Alacrity', levelReq: 9, weight: 45,
    appliesTo: ['weapon'], stat: 'increasedAttackSpeed', range: [[8, 12]] },
  { id: 'of_swiftness', group: 'ias', type: S, name: 'of Swiftness', levelReq: 24, weight: 16,
    appliesTo: ['weapon'], stat: 'increasedAttackSpeed', range: [[13, 20]] },

  { id: 'of_balance', group: 'fhr', type: S, name: 'of Balance', levelReq: 7, weight: 40,
    appliesTo: ['any'], stat: 'fasterHitRecovery', range: [[8, 15]] },
  { id: 'of_the_fleet', group: 'frw', type: S, name: 'of the Fleet', levelReq: 5, weight: 40,
    appliesTo: ['any'], stat: 'fasterRunWalk', range: [[8, 15]] },

  { id: 'of_fortune', group: 'magicFind', type: S, name: 'of Fortune', levelReq: 15, weight: 25,
    appliesTo: ['any'], stat: 'magicFind', range: [[10, 20]] },
  { id: 'of_precision', group: 'critChance', type: S, name: 'of Precision', levelReq: 18, weight: 22,
    appliesTo: ['weapon'], stat: 'critChance', range: [[4, 8]] },
  { id: 'of_thorns', group: 'thorns', type: S, name: 'of Thorns', levelReq: 13, weight: 25,
    appliesTo: ['armor', 'shield'], stat: 'thorns', range: [[5, 12]] },
];

export const PREFIXES = AFFIXES.filter((a) => a.type === P);
export const SUFFIXES = AFFIXES.filter((a) => a.type === S);

/**
 * Roll a single stat value for an affix instance. `range` may hold one
 * bracket ([min,max]) or several ([[min,max],[min,max],...] -- one per
 * "sub-roll", D2-style, e.g. flat damage rolling a min-damage bracket and a
 * separate, independent max-damage bracket).
 */
export function rollAffixValue(rng, affix) {
  return affix.range.map(([lo, hi]) => rng.int(lo, hi));
}

/**
 * Pick eligible affixes of a given type for this item, honouring level gate,
 * category and groups already used.
 */
function eligiblePool(pool, { itemLevel, category, usedGroups }) {
  return pool.filter((a) =>
    a.levelReq <= itemLevel &&
    !usedGroups.has(a.group) &&
    (a.appliesTo.includes('any') || a.appliesTo.includes(category))
  );
}

/**
 * Roll `count` affixes of `type` ('prefix'|'suffix') onto an item, mutating
 * `usedGroups` as groups are consumed so a second call (e.g. suffixes after
 * prefixes) never collides with the first.
 */
export function rollAffixes(rng, { type, count, itemLevel, category, usedGroups }) {
  const pool = type === 'prefix' ? PREFIXES : SUFFIXES;
  const out = [];
  for (let i = 0; i < count; i++) {
    const eligible = eligiblePool(pool, { itemLevel, category, usedGroups });
    if (eligible.length === 0) break;
    const affix = rng.weighted(eligible.map((a) => [a, a.weight]));
    usedGroups.add(affix.group);
    const rolled = rollAffixValue(rng, affix);
    out.push({
      id: affix.id, group: affix.group, type: affix.type, name: affix.name,
      stat: affix.stat, values: rolled, levelReq: affix.levelReq,
    });
  }
  return out;
}
