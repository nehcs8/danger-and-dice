// Inventory Manager — classifies all items as "keep" or "superfluous" and computes
// the bot's true total buying power (coins + sell value of everything superfluous).
//
// Answers two questions used by the bot:
//   1. Is it worth visiting a shop right now?  (totalValue >= upgrade cost)
//   2. What exactly should be sold / unequipped when at a shop?
//
// Depends on: items.js (getItem, sellPrice, EQUIPMENT, SPECIAL_EQUIPMENT, ENCHANTMENTS)
//             upgrade_advisor.js (UpgradeAdvisor.nextUpgrade — optional, used for shopDecision)
//
// API:
//   InventoryManager.analyze(player)
//   → { strategy, prioritySlots[], unequipSlots[], keep[], sell[{id,reason,value}],
//       sellValue, totalValue }
//
//   InventoryManager.shopDecision(player)
//   → { shouldShop, hasSuperfluous, totalValue, upgrade, shortfall, canFarm, farmingTier }
//
//   InventoryManager.nextUnequipSlot(player)   → slot name | null
//   InventoryManager.nextSellId(player)        → item id  | null

const InventoryManager = (() => {

  const STRATEGY_SLOT = { F:'strength', D:'dexterity', M:'magic', C:'charisma' };
  const ALL_SLOTS     = ['strength','dexterity','magic','charisma','speed','armor','shield'];

  // ── Strategy detection ────────────────────────────────────────────────────────
  // Determined once from base stats (highest offensive stat wins).
  function detectStrategy(player) {
    return ['F','D','M','C'].reduce(
      (best, s) => (player.baseStats[s] ?? 0) > (player.baseStats[best] ?? 0) ? s : best, 'F'
    );
  }

  // The 5 equipment slots this strategy should occupy (in priority order).
  // Always: primary weapon slot + armor + shield + speed + charisma.
  function getPrioritySlots(strategy) {
    const off = STRATEGY_SLOT[strategy] ?? 'strength';
    return [...new Set([off, 'armor', 'shield', 'speed', 'charisma'])];
  }

  // ── Item scoring ──────────────────────────────────────────────────────────────
  // Higher = more valuable to keep. Used to pick the best item per slot.
  function itemScore(item) {
    if (!item) return 0;
    const statMax = Math.max(0, ...Object.values(item.statBonus ?? {}).filter(v => v > 0));
    const enchBonus  = item.enchantment ? 3 : 0;
    const guildBonus = item.guild ? 2 : 0;
    return statMax + enchBonus + guildBonus;
  }

  // ── Consumable keep limits ────────────────────────────────────────────────────
  // Returns the maximum number of copies to keep for a given item id.
  // 0 = always sell. Infinity = always keep.
  function keepLimit(id, strategy) {
    if (id === 'pot_heal')         return Infinity;
    if (id === 'sp_smoke')         return Infinity;
    if (id === 'rope')             return 1;
    if (id === 'compass')          return 1;
    if (id === 'map')              return 1;
    if (id === 'chain')            return 1;
    if (id === 'trap')             return 1;
    if (id === 'sp_invisibility')  return 1;
    if (id === 'sp_teleport')      return 1;
    if (id === 'sp_transmutation') return 1;
    if (id.startsWith('priest_pot_')) return Infinity; // blessings always useful
    if (id.startsWith('alcohol_'))   return 2;         // keep a couple for bard

    // Stat potions: keep up to 3 of the primary stat and universal defensive stats.
    // Sell everything else (off-strategy pots clutter the inventory for nothing).
    const potMatch = id.match(/^pot_([FDAMCV])(\d)$/);
    if (potMatch) {
      const stat = potMatch[1];
      return (stat === strategy || stat === 'A' || stat === 'V') ? 3 : 0;
    }

    // Attack spells: mage keeps a deep stack, everyone else has no use for them.
    const item = getItem(id);
    if (item?.subtype === 'attack') return strategy === 'M' ? 15 : 0;

    return Infinity; // unknown item — keep by default
  }

  // ── Sell-price helper ─────────────────────────────────────────────────────────
  function sellVal(item, hasCrowbar) {
    const base = item?.buyPrice ?? 0;
    return base ? (hasCrowbar ? Math.floor(base * 0.75) : Math.floor(base / 2)) : 0;
  }

  // ── Main analysis ─────────────────────────────────────────────────────────────

  function analyze(player) {
    const strategy   = detectStrategy(player);
    const pSlots     = new Set(getPrioritySlots(strategy));
    const hasCrowbar = !!(player.hasEquipped?.('crowbar'));
    const sv         = item => sellVal(item, hasCrowbar);

    // ── 1. Equipped items in non-priority slots → unequip + sell at shop ─────────
    const unequipSlots = [];
    for (const slot of ALL_SLOTS) {
      if (!pSlots.has(slot) && player.equipped[slot]) unequipSlots.push(slot);
    }

    // ── 2. For each priority slot: find the single best inventory item ────────────
    // An item is worth keeping in inventory only if it is strictly better than what
    // is currently equipped (i.e., a pending upgrade), or the slot is empty.
    // Duplicates and downgrades go into the sell list.
    const upgradeCandidate = {}; // slot → best-in-inventory item id (if upgrade)
    for (const slot of pSlots) {
      let bestId = null, bestScore = -1;
      for (const id of player.inventory) {
        const item = getItem(id);
        if (item?.slot !== slot) continue;
        const s = itemScore(item);
        if (s > bestScore) { bestScore = s; bestId = id; }
      }
      if (bestId) {
        const equippedScore = itemScore(player.equipped[slot]);
        // Keep only if it is an upgrade (or the slot is empty)
        if (bestScore > equippedScore || !player.equipped[slot]) {
          upgradeCandidate[slot] = bestId;
        }
      }
    }

    // ── 3. Classify inventory items ───────────────────────────────────────────────
    const keep = [];
    const sell = [];
    const counts = {}; // per-id count in keep list so far (for threshold logic)

    for (const id of player.inventory) {
      const item = getItem(id);

      // ── Equipment ──────────────────────────────────────────────────────────────
      if (item?.slot) {
        const slot = item.slot;

        if (!pSlots.has(slot)) {
          sell.push({ id, reason: `${slot} slot not in strategy (${strategy})`, value: sv(item) });
          continue;
        }

        // Guild items: keep always (unique effects, hard to re-acquire)
        if (item.guild) { keep.push(id); continue; }

        if (upgradeCandidate[slot] === id) {
          keep.push(id); // this is the best pending upgrade for this slot
        } else {
          const reason = player.equipped[slot]
            ? `outclassed in ${slot} slot (equipped is better or same)`
            : `duplicate ${slot} item`;
          sell.push({ id, reason, value: sv(item) });
        }
        continue;
      }

      // ── Consumables ────────────────────────────────────────────────────────────
      const limit = keepLimit(id, strategy);
      counts[id]  = (counts[id] ?? 0) + 1;

      if (counts[id] <= limit) {
        keep.push(id);
      } else {
        let reason;
        if (limit === 0) {
          const potMatch = id.match(/^pot_([FDAMCV])/);
          reason = potMatch       ? `off-strategy potion (${potMatch[1]} ≠ ${strategy})`
                 : item?.subtype === 'attack' ? 'attack spell (not a mage)'
                 : 'not useful for this build';
        } else {
          reason = `excess — keeping ≤${limit}`;
        }
        sell.push({ id, reason, value: sv(item) });
      }
    }

    // Sell value also includes the value of items in unequipSlots (they'll go to inventory
    // then immediately be sold at the shop).
    let equipSellValue = 0;
    for (const slot of unequipSlots) {
      const eq = player.equipped[slot];
      if (eq) equipSellValue += sv(eq);
    }

    const sellValue  = sell.reduce((s, x) => s + x.value, 0) + equipSellValue;
    const totalValue = player.coins + sellValue;

    return {
      strategy,
      prioritySlots:  [...pSlots],
      unequipSlots,
      keep,
      sell,
      sellValue,
      totalValue,
    };
  }

  // ── Shop decision ─────────────────────────────────────────────────────────────
  // Should the bot visit a shop?  Combines inventory analysis with the upgrade plan.

  function shopDecision(player) {
    const { sell, unequipSlots, totalValue } = analyze(player);
    const hasSuperfluous = sell.length > 0 || unequipSlots.length > 0;

    const advisor = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;

    if (!advisor) {
      return {
        shouldShop: hasSuperfluous,
        hasSuperfluous,
        totalValue,
        upgrade:    null,
        shortfall:  0,
        canFarm:    false,
        farmingTier: null,
      };
    }

    const upgrade   = advisor.upgrade;
    const cost      = upgrade?.cost ?? 0;
    const shortfall = Math.max(0, cost - totalValue);

    return {
      shouldShop:   shortfall === 0 && (upgrade !== null || hasSuperfluous),
      hasSuperfluous,
      totalValue,
      upgrade,
      shortfall,
      canFarm:      advisor.canFarm,
      farmingTier:  advisor.farmingTier,
    };
  }

  // ── Convenience helpers for the bot shop handler ──────────────────────────────

  // Returns the first non-priority slot that needs to be unequipped, or null.
  function nextUnequipSlot(player) {
    const { unequipSlots } = analyze(player);
    return unequipSlots[0] ?? null;
  }

  // Returns the id of the first superfluous inventory item to sell, or null.
  function nextSellId(player) {
    const { sell } = analyze(player);
    return sell.length > 0 ? sell[0].id : null;
  }

  return {
    analyze,
    shopDecision,
    detectStrategy,
    getPrioritySlots,
    nextUnequipSlot,
    nextSellId,
  };
})();
