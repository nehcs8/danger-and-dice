// Upgrade advisor — browser inference.
// Depends on: UPGRADE_ADVISOR_WEIGHTS (js/data/weights/upgrade_advisor_weights.js)
//             CombatEstimator is NOT required here; this module is self-contained.
//
// Given a player state, enumerates all upgrade candidates (regular items, guild items,
// enchantments) and scores each by predicted improvement in zone viability.
//
// API:
//   UpgradeAdvisor.recommend(player)
//   → [{ type, itemId, slot, enchantId, guildLevel, guildMaxLvl,
//         cost, shopType, gain, label }, ...]
//   Sorted by gain descending (best upgrade first).
//
//   UpgradeAdvisor.affordableUpgrades(player)
//   → same list filtered to items the player can afford with coins + sellable inventory value.
//
//   UpgradeAdvisor.nextUpgrade(player)
//   → single best affordable upgrade, or null if none available.

const UpgradeAdvisor = (() => {

  const STATS     = ['F','D','A','M','C','V'];
  const ALL_SLOTS = ['strength','dexterity','magic','charisma','speed','armor','shield'];
  const SLOT_IDX  = Object.fromEntries(ALL_SLOTS.map((s,i) => [s, i]));
  const TIERS     = [0, 1, 2, 3];

  const SLOT_STAT = { strength:'F', dexterity:'D', magic:'M', charisma:'C', speed:'V', armor:'A', shield:'A' };

  const ENCHANT_FOR_SLOT = {
    strength:  ['sharpness','fury','bloodlust','plunder','flame'],
    dexterity: ['precision','hawk_eye','bloodlust','plunder','flame'],
    armor:     ['arcane','thorns','lightness','resistance'],
    shield:    ['arcane','thorns','resistance'],
  };

  const MODIFIER_ENCHANTS = new Set(['fury','bloodlust','hawk_eye','thorns','arcane','flame','plunder']);
  const GUILD_MAX_LEVEL   = id => id === 'magic_flute_thief' ? 8 : 6;

  // Shop type per item source
  const shopTypeFor = item => {
    if (!item.guild) return 'shop';
    return item.guild === 'assassin' ? 'guild_assassin' : 'guild_thief';
  };

  // ── Forward pass ─────────────────────────────────────────────────────────────

  function forward(layers, x) {
    let cur = x.slice();
    for (let l = 0; l < layers.length; l++) {
      const { w, b, inD, outD } = layers[l];
      const next = new Array(outD);
      for (let o = 0; o < outD; o++) {
        let s = b[o];
        for (let i = 0; i < inD; i++) s += w[o * inD + i] * cur[i];
        next[o] = s;
      }
      cur = l < layers.length - 1 ? next.map(v => Math.max(0, v)) : next;
    }
    return cur;
  }

  // ── Player feature vector (must match train_upgrade_advisor.js) ───────────────

  function playerFeatureVec(player, tier) {
    const v = new Array(24).fill(0);
    let i   = 0;

    v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
    v[i++] = Math.min(player.hearts.max, 10) / 10;
    for (const s of STATS) v[i++] = Math.min(player.getStat(s), 25) / 25;
    v[i++] = player.hasEquipped('kryss')        ? 1 : 0;
    v[i++] = player.hasEquipped('garrote')      ? 1 : 0;
    v[i++] = player.hasEnchantment('fury')      ? 1 : 0;
    v[i++] = player.hasEnchantment('bloodlust') ? 1 : 0;
    v[i++] = player.hasEnchantment('hawk_eye')  ? 1 : 0;
    v[i++] = player.hasEnchantment('thorns')    ? 1 : 0;
    v[i++] = player.hasEnchantment('arcane')    ? 1 : 0;
    // Escape quality: 1.0 = rope/stealth_shoes (sure); partial = V run + C bard; 0 = chained
    {
      const hasGuaranteedEscape = player.hasItem('rope') || player.hasEquipped('stealth_shoes');
      let escapeVal;
      if (hasGuaranteedEscape) {
        escapeVal = 1.0;
      } else if (player.chainedTurns === 0) {
        const avgMobV = [8, 10, 13, 15][tier] ?? 10;
        const avgMobC = [6,  9, 11, 14][tier] ?? 9;
        const vRun    = Math.max(0, Math.min(1, (player.getStat('V') + 3.5 - avgMobV) / 6));
        const cBard   = Math.max(0, Math.min(0.25, (player.getStat('C') - avgMobC) / 12));
        escapeVal = Math.min(1, vRun + cBard);
      } else {
        escapeVal = 0;
      }
      v[i++] = escapeVal;
    }
    v[i++] = player.inventory.includes('sp_smoke') ? 1 : 0;
    v[i++] = player.friendsList.length > 0         ? 1 : 0;

    const bestPot = player.inventory.reduce((best, id) => {
      if (!/^pot_[FDAMCV]\d$/.test(id)) return best;
      return Math.max(best, parseInt(id[5]) || 0);
    }, 0);
    v[i++] = bestPot / 6;
    v[i++] = player.canAttackMagic() ? 1 : 0;
    for (const t of TIERS) v[i++] = t === tier ? 1 : 0;

    return v;
  }

  // ── Upgrade feature vector (must match train_upgrade_advisor.js) ──────────────

  function upgradeFeatureVec(player, candidate) {
    const v = new Array(18).fill(0);

    v[0] = candidate.type === 'regular' ? 1 : 0;
    v[1] = candidate.type === 'enchant' ? 1 : 0;
    v[2] = candidate.type === 'guild'   ? 1 : 0;

    const si = SLOT_IDX[candidate.slot];
    if (si !== undefined) v[3 + si] = 1;

    // Net primary stat gain
    const primaryStat  = SLOT_STAT[candidate.slot] ?? 'F';
    const before       = player.getStat(primaryStat);
    const cloned       = _cloneForStat(player);
    _applyToClone(cloned, candidate);
    const after        = cloned.getStat(primaryStat);
    v[10] = Math.min(Math.max(after - before, 0), 10) / 10;

    v[11] = player.equipped[candidate.slot] ? 0 : 1;
    v[12] = candidate.guildLevel  ? candidate.guildLevel / 8 : 0;
    v[13] = candidate.guildMaxLvl ? candidate.guildMaxLvl / 8 : 0;
    v[14] = candidate.hasSpecialEffect ? 1 : 0;

    if (candidate.type === 'enchant') {
      const enchObj = ENCHANTMENTS.find(e => e.id === candidate.enchantId);
      if (enchObj) {
        v[15] = (enchObj.effect?.type === 'stat_bonus' || enchObj.effect?.type === 'remove_speed_malus') ? 1 : 0;
        v[16] = MODIFIER_ENCHANTS.has(candidate.enchantId) ? 1 : 0;
      }
    }

    v[17] = Math.min(candidate.cost ?? 0, 200) / 200;

    return v;
  }

  // Minimal stat-only clone (no combat fields)
  function _cloneForStat(player) {
    // We need a minimal object with getStat, equipped, guildItemLevels, transmutation
    const clone = Object.create(player);
    clone.equipped = Object.fromEntries(
      ALL_SLOTS.map(s => [s, player.equipped[s] ? { ...player.equipped[s] } : null])
    );
    clone.guildItemLevels = { ...player.guildItemLevels };
    clone.transmutation   = null;
    clone.baseStats       = { ...player.baseStats };
    return clone;
  }

  function _applyToClone(clone, candidate) {
    if (candidate.type === 'regular') {
      const item = getItem(candidate.itemId);
      if (item) clone.equipped[candidate.slot] = { ...item };
    } else if (candidate.type === 'guild') {
      const item = getItem(candidate.itemId);
      if (item) {
        clone.equipped[candidate.slot] = { ...item };
        clone.guildItemLevels = { ...clone.guildItemLevels };
        clone.guildItemLevels[candidate.itemId] = {
          itemLevel: candidate.guildLevel,
          levelProgress: { mbUnits: 0, secondaryUnits: 0 },
        };
      }
    } else if (candidate.type === 'enchant') {
      const eq = clone.equipped[candidate.slot];
      if (eq) {
        clone.equipped[candidate.slot] = { ...eq };
        const enchObj = ENCHANTMENTS.find(e => e.id === candidate.enchantId);
        if (enchObj) clone.equipped[candidate.slot].enchantment = { ...enchObj };
      }
    }
  }

  // ── Candidate enumeration ─────────────────────────────────────────────────────

  function enumerateCandidates(player) {
    const candidates = [];

    // Regular equipment
    for (const item of EQUIPMENT) {
      const eq      = player.equipped[item.slot];
      const curTier = eq ? (eq.tier ?? 0) : 0;
      if (item.tier <= curTier) continue;
      candidates.push({
        type: 'regular', itemId: item.id, slot: item.slot,
        cost: item.buyPrice ?? 0, shopType: 'shop',
        hasSpecialEffect: false,
        label: item.name,
      });
    }

    // Guild / special equipment (at current level if already owned, else level 1)
    for (const item of SPECIAL_EQUIPMENT) {
      const eq = player.equipped[item.slot];
      if (eq?.guild) continue; // already has a guild item in this slot

      const existing = player.guildItemLevels[item.id];
      const level    = existing ? existing.itemLevel : 1;
      // Only treat as free-to-equip if the item is physically present
      const possessed = player.inventory.includes(item.id)
                     || Object.values(player.equipped).some(e => e?.id === item.id);
      const cost = (existing && possessed) ? 0 : (item.buyPrice ?? 0);
      candidates.push({
        type: 'guild', itemId: item.id, slot: item.slot,
        guildLevel:       level,
        guildMaxLvl:      GUILD_MAX_LEVEL(item.id),
        cost,
        shopType:         shopTypeFor(item),
        hasSpecialEffect: true,
        label: `${item.name} [Lv.${level}]`,
      });
    }

    // Enchantments
    for (const [slot, enchIds] of Object.entries(ENCHANT_FOR_SLOT)) {
      const eq = player.equipped[slot];
      if (!eq || eq.enchantment) continue;
      for (const enchId of enchIds) {
        const enchObj = ENCHANTMENTS.find(e => e.id === enchId);
        if (!enchObj) continue;
        const tier = eq.tier ?? 1;
        const cost = enchObj.cost ?? (tier * 50);
        candidates.push({
          type: 'enchant', slot, enchantId: enchId,
          cost, shopType: 'master',
          hasSpecialEffect: MODIFIER_ENCHANTS.has(enchId),
          label: `${enchObj.name} on ${slot}`,
        });
      }
    }

    return candidates;
  }

  // ── Chest freeway ─────────────────────────────────────────────────────────────
  // The miniboss-free corridor from START to MASTER.
  // Computed once (BFS avoiding MINIBOSS tiles); hardcoded here since the map is static.
  //
  // Route: START(6,2) → east along y=2 → SHOP(19,2) → down through left corridor
  //        → SHOP(2,12) → PRIEST(11,20) → southeast chests → MASTER(30,25)
  // Branches: GUILD_ASSASSIN(0,20) off the left corridor; GUILD_THIEF(16,27) before MASTER.

  // Chests on or 1 step from the freeway backbone, in rough travel order.
  const FREEWAY_CHESTS = [
    {x:8,  y:2},   // near START, east along top
    {x:13, y:2},
    {x:20, y:7},   // after the first bend down
    {x:10, y:10},  // upper-left corridor
    {x:13, y:11},
    {x:5,  y:13},  // left corridor descent
    {x:4,  y:18},
    {x:20, y:22},  // lower corridor eastward
    {x:11, y:23},
    {x:16, y:25},  // near GUILD_THIEF branch
    {x:26, y:27},  // final approach to MASTER
    {x:28, y:27},
  ];

  // Service tiles on or 1 step from the freeway, in travel order.
  // shopType values match UpgradeAdvisor candidate output.
  const FREEWAY_SERVICE = [
    {x:19, y:2,  shopType:'shop',           label:'Shop (top)'},
    {x:2,  y:12, shopType:'shop',           label:'Shop (left)'},
    {x:0,  y:20, shopType:'guild_assassin', label:'Guild Assassin'},
    {x:11, y:20, shopType:'priest',         label:'Priest'},
    {x:30, y:23, shopType:'shop',           label:'Shop (near Master)'},
    {x:16, y:27, shopType:'guild_thief',    label:'Guild Thief'},
    {x:30, y:25, shopType:'master',         label:'Master'},
  ];

  // Manhattan distance helper
  function mdist(ax, ay, bx, by) { return Math.abs(ax-bx) + Math.abs(ay-by); }

  // ── Chest run planner ─────────────────────────────────────────────────────────
  // Recommends whether the bot should take the chest freeway (no safe farming zone)
  // and returns the best next waypoints along it.
  //
  // Returns:
  //   recommended   — true when canFarm is false and a shortfall exists
  //   nextChest     — nearest freeway chest not yet collected (null if all done)
  //   destination   — the service tile matching the target upgrade's shopType
  //   allChests     — full freeway chest list (for scoring in movement)
  //   allService    — full freeway service list

  function chestRunPlan(player, upgradeResult) {
    const shortfall = upgradeResult?.shortfall ?? 0;
    const canFarm   = upgradeResult?.canFarm ?? false;
    const recommended = !canFarm;

    // Nearest uncollected freeway chest
    const px = player.position?.x ?? 6;
    const py = player.position?.y ?? 2;

    const uncollected = FREEWAY_CHESTS.filter(c => {
      // player.hasUsedTile may not exist on all builds; treat as uncollected if missing
      return !(player.hasUsedTile && player.hasUsedTile(c.x, c.y));
    });

    let nextChest = null;
    if (uncollected.length) {
      nextChest = uncollected.reduce((best, c) =>
        mdist(px,py,c.x,c.y) < mdist(px,py,best.x,best.y) ? c : best
      );
    }

    // Service destination matching the target upgrade's shopType
    const targetShopType = upgradeResult?.upgrade?.shopType ?? 'master';
    const destination = FREEWAY_SERVICE.find(s => s.shopType === targetShopType)
                     ?? FREEWAY_SERVICE[FREEWAY_SERVICE.length - 1]; // fallback: MASTER

    return {
      recommended,
      nextChest,
      destination,
      allChests:  FREEWAY_CHESTS,
      allService: FREEWAY_SERVICE,
    };
  }

  // ── Sellable inventory value ──────────────────────────────────────────────────
  // Returns total coins the player could raise by selling non-essential items.
  // Uses the same sell-price logic as the game (50% of buy price by default).

  function sellableValue(player) {
    let total = 0;
    for (const id of player.inventory) {
      const item = getItem(id);
      if (!item?.buyPrice) continue;
      // Keep consumables the player would actually use
      if (['pot_heal','rope','sp_invisibility','sp_smoke','sp_transmutation',
           'compass','map','chain','trap'].includes(id)) continue;
      total += Math.floor(item.buyPrice / 2);
    }
    return total;
  }

  // ── Main API ──────────────────────────────────────────────────────────────────

  function recommend(player) {
    const layers = (typeof UPGRADE_ADVISOR_WEIGHTS !== 'undefined') ? UPGRADE_ADVISOR_WEIGHTS : null;
    const pFeats = playerFeatureVec(player, 0); // tier=0 anchor (same as training)

    const candidates = enumerateCandidates(player);
    const results    = [];

    for (const candidate of candidates) {
      const uFeats   = upgradeFeatureVec(player, candidate);
      const features = [...pFeats, ...uFeats];

      let gain;
      if (layers) {
        gain = forward(layers, features)[0];
      } else {
        // Fallback without weights: estimate gain purely from stat delta
        const primaryStat = SLOT_STAT[candidate.slot] ?? 'F';
        const clone = _cloneForStat(player);
        _applyToClone(clone, candidate);
        gain = (clone.getStat(primaryStat) - player.getStat(primaryStat)) * 0.05;
      }

      results.push({ ...candidate, gain });
    }

    results.sort((a, b) => b.gain - a.gain);
    return results;
  }

  function affordableUpgrades(player) {
    const budget = player.coins + sellableValue(player);
    return recommend(player).filter(u => u.cost <= budget);
  }

  // ── Farming viability ─────────────────────────────────────────────────────────
  // Returns the safest tier the player can farm in, or null if nowhere is safe.
  // Requires CombatEstimator to be loaded; falls back to null if unavailable.

  function bestFarmingTier(player) {
    if (typeof CombatEstimator === 'undefined') return null;
    const report = CombatEstimator.strategyReport(player);
    // Highest tier that is comfortably safe (winProb >= 0.75) and affordable.
    // Note: the escape-quality penalty applied in estimate() means bots with no
    // guaranteed escape (rope / stealth_shoes) and low V can never reach 0.75,
    // so they fall back to chest-running until they acquire an escape item.
    for (let tier = 3; tier >= 0; tier--) {
      const e = report[tier];
      if (e.winProb >= 0.75 && e.affordable) return tier;
    }
    return null;
  }

  // ── Main decision ─────────────────────────────────────────────────────────────
  // Returns { upgrade, farmingTier, canFarm, shortfall } where:
  //   upgrade     — best single upgrade (ignores current coins)
  //   farmingTier — safest tier to farm in (null = nowhere safe)
  //   canFarm     — true if a farming zone exists
  //   shortfall   — coins still needed after liquidating sellable inventory
  //
  // Strategy:
  //   1. Always target the best upgrade regardless of cost.
  //   2. If a safe farming zone exists, farm there until the shortfall is covered.
  //   3. If nowhere is safe to farm, fall back to the best upgrade the player can
  //      already afford — accept the constraint rather than pushing into danger.

  function nextUpgrade(player) {
    const ranked     = recommend(player);
    if (!ranked.length) return null;

    const farmingTier = bestFarmingTier(player);
    const canFarm     = farmingTier !== null;

    const budget    = player.coins + sellableValue(player);
    const best      = ranked[0];
    const shortfall = Math.max(0, best.cost - budget);

    let result;

    // If affordable already, or if we can farm to cover the gap — target best.
    if (shortfall === 0 || canFarm) {
      result = { upgrade: best, farmingTier, canFarm, shortfall };
    } else {
      // Nowhere safe to farm and can't afford the best upgrade.
      // Return the best option within current budget instead.
      const affordable = ranked.find(u => u.cost <= budget);
      result = affordable
        ? { upgrade: affordable, farmingTier: null, canFarm: false, shortfall: 0 }
        : { upgrade: best,       farmingTier: null, canFarm: false, shortfall };
    }

    // Always attach chest run plan — it will self-report recommended:false
    // when farming is available or nothing is needed.
    result.chestRun = chestRunPlan(player, result);

    // Dragon readiness from the Monte Carlo boss estimator.
    // winProb >= 0.55 = "risky but go for it"; >= 0.75 = "ready".
    if (typeof CombatEstimator !== 'undefined' && CombatEstimator.estimateBoss) {
      const dr = CombatEstimator.estimateBoss(player, 'dragon', 200);
      result.dragonWinProb  = dr ? dr.winProb  : null;
      result.dragonReady    = dr ? dr.winProb >= 0.55 : false;
    } else {
      result.dragonWinProb = null;
      result.dragonReady   = false;
    }

    return result;
  }

  return { recommend, affordableUpgrades, nextUpgrade, bestFarmingTier, chestRunPlan, sellableValue };
})();
