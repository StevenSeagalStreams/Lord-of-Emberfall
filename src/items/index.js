import { rollDrops } from './Drops.js';
import { GroundItems } from './GroundItems.js';
import { generateItem } from './Generator.js';

/**
 * Items subsystem.
 *
 * This was a 21-line stub whose `entity:died` handler was literally `() => {}`
 * -- which is the entire answer to STABILIZE.md P0-4, "zero drops seen". Step
 * (1) of its diagnosis list: the death event fires correctly and nothing was
 * listening. `BaseTypes.js` and `Affixes.js` had been written months of work
 * ago and were never connected to anything.
 *
 * Responsibilities:
 *   - roll drops on kill and put them in the world
 *   - carry gold and the potion belt
 *   - auto-equip a strict upgrade, so "kill -> loot -> stronger" closes
 *     without an inventory screen existing yet
 *   - publish `stats`, the aggregated equipment block combat reads
 *
 * Deliberately NOT here: the inventory grid, equipping by hand, stat
 * requirements gating equips. Those are gate-3 work and the freeze forbids
 * them. What exists is the minimum that makes the core loop close.
 */
export function createItems(ctx) {
  const { bus, rng, world, scene, camera, input } = ctx;

  const ground = new GroundItems({ scene, bus, world, camera, input });
  const dropRng = rng.fork('drops');

  function emptyStats() {
    return {
      damageMin: 0, damageMax: 0, armor: 0, block: 0,
      life: 0, mana: 0, strength: 0, dexterity: 0, vitality: 0, energy: 0,
      attackSpeed: 0, moveSpeed: 0, critChance: 0, lifeSteal: 0, manaSteal: 0,
      attackRating: 0, hitRecovery: 0, goldFind: 0, magicFind: 0,
      lightRadius: 0, thorns: 0,
      fireRes: 0, coldRes: 0, lightRes: 0, poisonRes: 0, allRes: 0,
    };
  }

  const state = {
    gold: 0,
    potions: [],
    /** Currently equipped items by slot. */
    equipped: {},
    /** Debug multiplier, driven by the console's `droprate` command. */
    dropMultiplier: 1,
  };

  /** The object combat holds a reference to. Its identity must never change
   *  -- see update() -- or every holder keeps reading a stale block. */
  const stats = emptyStats();

  /** Re-derive from scratch. Never incremental: an incremental aggregate
   *  drifts the moment one unequip path forgets to subtract. */
  function recomputeStats() {
    const fresh = emptyStats();
    for (const slot in state.equipped) {
      const it = state.equipped[slot];
      if (!it) continue;
      for (const k in it.stats) fresh[k] = (fresh[k] ?? 0) + it.stats[k];
    }
    Object.assign(stats, fresh);
  }

  /** Crude but honest "is this better": offence for weapons, defence for the
   *  rest. Enough to close the loop, and explicitly a placeholder for a real
   *  comparison UI. */
  function scoreOf(item) {
    const s = item.stats;
    if (item.category === 'weapon') return s.damageMin + s.damageMax * 1.5;
    return s.armor + s.block * 50 + s.life * 0.5;
  }

  function tryEquip(item) {
    const cur = state.equipped[item.slot];
    if (cur && scoreOf(cur) >= scoreOf(item)) return false;
    state.equipped[item.slot] = item;
    recomputeStats();
    bus.emit('item:equipped', { item, replaced: cur ?? null });
    return true;
  }

  function collect(drop) {
    if (drop.type === 'gold') {
      state.gold += drop.amount;
      bus.emit('gold:gained', { amount: drop.amount, total: state.gold });
      return;
    }
    if (drop.type === 'potion') {
      state.potions.push(drop.potion);
      return;
    }
    const upgraded = tryEquip(drop.item);
    bus.emit('item:collected', { item: drop.item, equipped: upgraded });
  }

  const off = [
    bus.on('entity:died', ({ entity }) => {
      if (!entity || entity === world.player) return;
      const itemLevel = Math.max(1, world.player?.level ?? 1);
      const drops = rollDrops(dropRng, entity, {
        itemLevel,
        dropMultiplier: state.dropMultiplier,
      });
      if (!drops.length) return;
      ground.spawnAll(drops, entity.position, dropRng);
    }),
  ];

  return {
    stats,
    state,
    ground,

    /** Console/debug: force a drop of a given rarity at the player. */
    debugDrop(rarity = 'magic') {
      const p = world.player;
      if (!p) return null;
      const item = generateItem(dropRng, { itemLevel: Math.max(1, p.level ?? 1), rarity });
      ground.spawn({ type: 'equipment', item }, p.position);
      return item;
    },

    /**
     * Called from main.js's input phase before it issues a move order.
     * Returns true when the click was consumed, or `{walkTo}` when the drop
     * is out of reach and the player should walk to it first.
     */
    handleClick(x, z, player) {
      const r = ground.handleClick(x, z, player);
      if (!r) return false;
      if (r.collect) {
        ground.collectAt(r.index);
        collect(r.collect);
        return true;
      }
      return r.walkTo ? r : true;
    },

    usePotion(kind = 'heal') {
      const i = state.potions.findIndex((p) => p.kind === kind);
      if (i < 0) return false;
      const p = state.potions.splice(i, 1)[0];
      const pl = world.player;
      if (!pl) return false;
      if (p.kind === 'heal') pl.health = Math.min(pl.maxHealth, pl.health + p.amount);
      else pl.mana = Math.min(pl.maxMana, pl.mana + p.amount);
      bus.emit('potion:used', { potion: p });
      return true;
    },

    update(dt) {
      const collected = ground.update(dt, world.player);
      for (const d of collected) collect(d);
    },

    dispose() {
      off.forEach((f) => f());
      ground.clear();
    },
  };
}
