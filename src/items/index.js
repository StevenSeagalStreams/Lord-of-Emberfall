/**
 * Items subsystem entry point.
 *
 * Owns item generation (base types + affixes + rarity), ground drops and
 * their world representation, the inventory/equipment model, and the stat
 * aggregation that feeds combat.
 *
 * STUB -- replaced by the items pass.
 */
export function createItems(ctx) {
  const { bus } = ctx;
  const off = [
    bus.on('entity:died', () => {}),
  ];
  return {
    /** Aggregated equipment bonuses the combat layer reads. */
    stats: { damageMin: 0, damageMax: 0, armor: 0, resistances: {} },
    update(_dt) {},
    dispose() { off.forEach((f) => f()); },
  };
}
