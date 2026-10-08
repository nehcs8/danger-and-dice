// Bot AI — plan-driven strategic agents.
// chooseCombatAction() and takeTurn() are the external API.
//
// Each turn the bot reads a persistent BotPlan that is the single source of truth:
//   getPlan(player, state) → { phase, shopPos, farmTier, coinTarget, ... }
//
// Plan phases (priority order):
//   pvp_finish   — carrying princess, rushing FINISH
//   pvp_chase    — PVP active, grabbing princess
//   fight_dragon — committed to dragon fight (latched once triggered)
//   dragon_prep  — dragonWinProb ≥ 30%, stocking potions before committing
//   upgrade      — affordable upgrade available, heading to shop
//   farm         — farming a zone to accumulate coins
//   chest_run    — freeway chest run for coins
//
// The plan drives navigation, tile scoring, shop buy/sell decisions, and combat.
// computePlan() is re-evaluated whenever player stats or inventory change.

const BotAI = (() => {

  // ── Per-player state ─────────────────────────────────────────────────────────
  const botState = {};

  // ── Plan phases ───────────────────────────────────────────────────────────────
  const PLAN_PHASE = {
    HEAL_FIRE:    'heal_fire',
    HEAL_BAR:     'heal_bar',
    HEAL_SHOP:    'heal_shop',
    PVP_FINISH:   'pvp_finish',
    PVP_CHASE:    'pvp_chase',
    FIGHT_DRAGON: 'fight_dragon',
    DRAGON_PREP:  'dragon_prep',
    UPGRADE:      'upgrade',
    FARM:         'farm',
    CHEST_RUN:    'chest_run',
  };

  // Cache expensive dragon win estimate (80 sims); invalidated when combat stats or
  // relevant inventory (pots, blood drops) change — pot stocking during DRAGON_PREP
  // improves the estimate, so the cache must re-evaluate when inventory changes.
  const _dragonWinCache = {};
  function cachedDragonWinProb(player) {
    if (typeof CombatEstimator === 'undefined' || !CombatEstimator.estimateBoss) return 0;
    const heals  = player.inventory.filter(id => id === 'pot_heal').length;
    const pots3  = player.inventory.filter(id => /^pot_[FDAMC]3$/.test(id)).length;
    const bloods = player.inventory.filter(id => id.endsWith('_blood')).length;
    const key = `${player.getStat('F')},${player.getStat('D')},${player.getStat('M')},${player.getStat('C')},${player.getStat('A')},${player.getStat('V')},${player.hearts.current},${player.hearts.max},${heals},${pots3},${bloods}`;
    const c = _dragonWinCache[player.id];
    if (c?.key === key) return c.winProb;
    const winProb = CombatEstimator.estimateBoss(player, 'dragon', 80)?.winProb ?? 0;
    _dragonWinCache[player.id] = { key, winProb };
    return winProb;
  }

  function computePlan(player, state) {
    if (player.hasPrincess) return { phase: PLAN_PHASE.PVP_FINISH };
    if (state.pvpActive && !player.hasPrincess) return { phase: PLAN_PHASE.PVP_CHASE };

    // Heal interrupt: triggered at < 3 hearts (< 2 with cursed rattle for instant kill).
    const hpFloor = player.hasEquipped?.('cursed_rattle') ? 2 : 3;
    if (player.hearts.current < hpFloor) {
      const fire = nearestAccessibleFire(player);
      if (fire) return { phase: PLAN_PHASE.HEAL_FIRE, firePos: fire };
      const bar = barHealViable(player);
      if (bar.viable) return { phase: PLAN_PHASE.HEAL_BAR, barPos: bar.barPos };
      const healShopPos = nearestShopForHeal(player);
      if (healShopPos) return { phase: PLAN_PHASE.HEAL_SHOP, shopPos: healShopPos };
      // No heal option available — fall through and accept the HP risk.
    }

    const hasInstantKill = hasItemAnywhere(player, 'boss_magic_flute');
    let dragonWinProb    = hasInstantKill ? 1 : cachedDragonWinProb(player);

    // Latch fight_dragon once committed to prevent oscillation if winProb dips slightly
    const prev = botState[player.id]?.plan;
    if (prev?.phase === PLAN_PHASE.FIGHT_DRAGON && dragonWinProb >= 0.05)
      return { ...prev, dragonWinProb };

    if (hasInstantKill || dragonWinProb >= 0.30)
      return { phase: PLAN_PHASE.FIGHT_DRAGON, dragonWinProb };

    // Compute advisor plan for remaining phases
    const advisor = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;

    // The NN advisor often ranks guild items (kryss etc.) first because they carry
    // special effects that were rewarded in training.  However:
    //  • Guild items require travelling to a dedicated guild shop.
    //  • Their primary stat bonus (+1) is much weaker than regular tier-6 items (+6).
    //  • Bots that exclusively target guild items never get the raw stat gains needed
    //    to have any chance against the dragon.
    //
    // Strategy: use the advisor's best NON-GUILD upgrade that fits this build's
    // priority slots.  Fall back to null only if nothing non-guild is affordable.
    const prioritySlotsSet = new Set(getEquipSlots(player));
    let effectiveUpgrade = advisor?.upgrade ?? null;
    if (effectiveUpgrade &&
        (effectiveUpgrade.type === 'guild' || !prioritySlotsSet.has(effectiveUpgrade.slot))) {
      // Best candidate was guild or off-strategy — find best non-guild priority-slot upgrade.
      if (typeof UpgradeAdvisor !== 'undefined') {
        const affordable = UpgradeAdvisor.affordableUpgrades(player);
        effectiveUpgrade = affordable.find(
          u => u.type !== 'guild' && prioritySlotsSet.has(u.slot)
        ) ?? null;
      } else {
        effectiveUpgrade = null;
      }
    }

    // Use InventoryManager's totalValue (coins + ALL sellable items) for shortfall —
    // more accurate than UpgradeAdvisor.sellableValue which misses equipment.
    const invTotal = (typeof InventoryManager !== 'undefined')
      ? InventoryManager.analyze(player).totalValue
      : player.coins;
    const trueShortfall = effectiveUpgrade
      ? Math.max(0, effectiveUpgrade.cost - invTotal)
      : 0;

    const base = {
      dragonWinProb,
      upgrade:     effectiveUpgrade,
      shortfall:   trueShortfall,
      canFarm:     advisor?.canFarm    ?? false,
      farmingTier: advisor?.farmingTier ?? 0,
      chestRun:    advisor?.chestRun   ?? null,
    };

    // Gear-readiness fallback: if estimateBoss already shows any positive chance
    // (blood drops / high stats helping) AND bot has a tier-4+ enchanted primary
    // weapon, trigger DRAGON_PREP so it stocks pots.  The estimate will jump
    // significantly once 10× offensive pots + 10× heals are stocked.
    // Also trigger unconditionally on a tier-5+ enchanted weapon.
    if (dragonWinProb < 0.15) {
      const strat2  = getStrategy(player);
      const offSlot = STRATEGY_SLOT[strat2];
      const wpn     = player.equipped[offSlot];
      if (wpn && wpn.enchantment) {
        const tier    = wpn.tier ?? 0;
        const atkStat = player.getStat(strat2);
        // Require effective attack stat >= 12 so bots with realistic paths to ~15 with pots qualify.
        // Prevents C/M bots with tier-4 instruments but low stats from entering DRAGON_PREP.
        if (tier >= 4 && atkStat >= 12)
          dragonWinProb = 0.15;
      }
    }

    if (dragonWinProb >= 0.15) {
      // Escalate from DRAGON_PREP to FIGHT_DRAGON once the bot has stocked enough
      // consumables, even if estimateBoss still shows < 30% (the estimate improves
      // dramatically in the fight itself with stacked pots).
      const strat2    = getStrategy(player);
      const healPots  = player.inventory.filter(id => id === 'pot_heal').length;
      const atkPots   = player.inventory.filter(id => new RegExp(`^pot_${strat2}[23]$`).test(id)).length;
      const readyToFight = healPots >= 7 && atkPots >= 7;
      if (dragonWinProb >= 0.30 || readyToFight)
        return { ...base, phase: PLAN_PHASE.FIGHT_DRAGON, dragonWinProb };
      return { ...base, phase: PLAN_PHASE.DRAGON_PREP };
    }

    // Advisor-driven phases
    // For enchant upgrades there is no itemId (only enchantId); treat them as always needing purchase.
    const upgradeAlreadyOwned = base.upgrade?.type === 'enchant'
      ? false
      : hasItemAnywhere(player, base.upgrade?.itemId);
    if (base.upgrade && base.shortfall === 0 && !upgradeAlreadyOwned)
      return { ...base, phase: PLAN_PHASE.UPGRADE };
    if (base.canFarm)
      return { ...base, phase: PLAN_PHASE.FARM };
    return { ...base, phase: PLAN_PHASE.CHEST_RUN };
  }

  // Returns the plan for this turn. Recomputed each turn; fight_dragon latch handled inside.
  // Call once per turn and pass down to all helpers — do not call UpgradeAdvisor elsewhere.
  function getPlan(player, state) {
    if (!botState[player.id]) botState[player.id] = {};
    const plan = computePlan(player, state);
    botState[player.id].plan = plan; // store for fight_dragon latch in next turn
    return plan;
  }

  // ── BFS distance cache (target → distances to all reachable tiles) ───────────
  // Used to navigate toward targets beyond this turn's movement range.
  const _navDistCache = {};
  function getNavDist(tx, ty) {
    const k = `${tx},${ty}`;
    if (_navDistCache[k]) return _navDistCache[k];
    const dist = {}, vis = new Set([k]), q = [{x:tx, y:ty, d:0}];
    dist[k] = 0;
    while (q.length) {
      const {x, y, d} = q.shift();
      for (const n of MapGrid.getAdjacent(x, y, false)) {
        const nk = `${n.x},${n.y}`;
        if (!vis.has(nk)) { vis.add(nk); dist[nk] = d+1; q.push({x:n.x, y:n.y, d:d+1}); }
      }
    }
    return (_navDistCache[k] = dist);
  }

  // ── Map tile lookups ─────────────────────────────────────────────────────────
  const _bossTilePos = {};
  function getBossTilePos(bossId) {
    if (_bossTilePos[bossId] !== undefined) return _bossTilePos[bossId];
    for (let y = 0; y < 38; y++)
      for (let x = 0; x < 51; x++)
        if (MapGrid.get(x, y) === TileType.BOSS && MapGrid.getTileData(x, y)?.bossId === bossId)
          return (_bossTilePos[bossId] = {x, y});
    return (_bossTilePos[bossId] = null);
  }

  const _tilePosCache = {};
  function findTilePos(tileType) {
    if (_tilePosCache[tileType]) return _tilePosCache[tileType];
    const results = [];
    for (let y = 0; y < 38; y++)
      for (let x = 0; x < 51; x++)
        if (MapGrid.get(x, y) === tileType) results.push({x, y});
    return (_tilePosCache[tileType] = results);
  }

  // ── Player-aware Dijkstra (blocking BFS) ─────────────────────────────────────
  // Treats unbeatable MINIBOSS tiles as walls (hard block).
  // STOP tiles cost 2 (expected ~2 turns, 50% stuck). REROLL tiles cost 0 (free extra move).
  const _navDistBlockingCache = {};

  function getMaxBeatable(player) {
    if (!botState[player.id]) botState[player.id] = {};
    const key = `${player.getStat('F')},${player.getStat('D')},${player.getStat('M')},${player.getStat('C')}`;
    const c = botState[player.id]._tierCache;
    if (c?.key === key) return c.tier;
    const tier = (typeof CombatEstimator !== 'undefined')
      ? CombatEstimator.bestTier(player).tier : 0;
    botState[player.id]._tierCache = { key, tier };
    return tier;
  }

  function getNavDistBlocking(tx, ty, player) {
    const maxTier = getMaxBeatable(player);
    const k = `${tx},${ty},${maxTier}`;
    if (_navDistBlockingCache[k]) return _navDistBlockingCache[k];

    const dist = {}, vis = new Set();
    dist[`${tx},${ty}`] = 0;
    const pq = [{ x: tx, y: ty, cost: 0 }];

    while (pq.length) {
      let mi = 0;
      for (let i = 1; i < pq.length; i++) if (pq[i].cost < pq[mi].cost) mi = i;
      const { x, y, cost } = pq.splice(mi, 1)[0];
      const key = `${x},${y}`;
      if (vis.has(key)) continue;
      vis.add(key);

      for (const n of MapGrid.getAdjacent(x, y, false)) {
        const nk = `${n.x},${n.y}`;
        if (vis.has(nk)) continue;
        const nType = MapGrid.get(n.x, n.y);
        if (nType === TileType.MINIBOSS) {
          const mTier = MapGrid.getTileData(n.x, n.y)?.minibossTier ?? 0;
          if (mTier > maxTier) continue; // hard block
        }
        const edgeCost = nType === TileType.STOP ? 2 : nType === TileType.REROLL ? 0 : 1;
        const nc = cost + edgeCost;
        if (dist[nk] === undefined || nc < dist[nk]) {
          dist[nk] = nc;
          pq.push({ x: n.x, y: n.y, cost: nc });
        }
      }
    }
    return (_navDistBlockingCache[k] = dist);
  }

  // ── Shop zone data ────────────────────────────────────────────────────────────
  // z0 = early zone; z1 = mid (best armor here); z2/z3 = late (highest tier gear).
  const SHOP_ZONE_DATA = [
    { x:19, y:3,  zone:0 }, { x:25, y:13, zone:0 },
    { x:3,  y:12, zone:1 }, { x:16, y:21, zone:1 },
    { x:16, y:31, zone:2 }, { x:27, y:35, zone:2 }, { x:30, y:23, zone:2 },
    { x:42, y:11, zone:3 },
  ];
  // Proximity match (≤2 tiles) to handle minor map-vs-data coordinate drift.
  function shopZone(x, y) {
    let best = null, bestD = Infinity;
    for (const s of SHOP_ZONE_DATA) {
      const d = Math.abs(s.x - x) + Math.abs(s.y - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return (best && bestD <= 2) ? best.zone : 0;
  }
  // Minimum shop zone needed to stock this upgrade.
  function minZoneForUpgrade(upgrade) {
    if (!upgrade || upgrade.type !== 'regular') return 0;
    const item = getItem(upgrade.itemId);
    if (!item) return 0;
    const tier = item.tier ?? 1;
    if (item.slot === 'armor') return tier >= 3 ? 1 : 0;
    if (tier >= 5) return 2;
    if (tier >= 3) return 1;
    return 0;
  }

  // ── Heal navigation helpers ───────────────────────────────────────────────────
  let _fireTiles = null;
  function getFireTiles() {
    if (_fireTiles) return _fireTiles;
    _fireTiles = [];
    for (let y = 0; y < 38; y++)
      for (let x = 0; x < 51; x++)
        if (MapGrid.get(x, y) === TileType.FIRE) _fireTiles.push({ x, y });
    return _fireTiles;
  }

  let _barTiles = null;
  function getBarTiles() {
    if (_barTiles) return _barTiles;
    _barTiles = [];
    for (let y = 0; y < 38; y++)
      for (let x = 0; x < 51; x++)
        if (MapGrid.get(x, y) === TileType.BAR) _barTiles.push({ x, y });
    return _barTiles;
  }

  // Nearest accessible FIRE tile (respects miniboss blocking).
  // Returns null if no fire tile is reachable (all paths blocked by unbeatable
  // minibosses), so the heal planner can fall back to bar / shop / accept-risk.
  function nearestAccessibleFire(player) {
    const px = player.position?.x ?? 6;
    const py = player.position?.y ?? 2;
    let best = null, bestDist = Infinity;
    for (const fire of getFireTiles()) {
      const d = getNavDistBlocking(fire.x, fire.y, player)[`${px},${py}`] ?? Infinity;
      if (d < bestDist) { bestDist = d; best = fire; }
    }
    return bestDist < Infinity ? best : null; // null when genuinely unreachable
  }

  // Find nearest accessible BAR tile the player can afford (at least 1 heart = 10 coins).
  function barHealViable(player) {
    if (player.hearts.current >= player.hearts.max) return { viable: false };
    if (player.coins < 10) return { viable: false };
    const px = player.position?.x ?? 6;
    const py = player.position?.y ?? 2;
    const maxDist = 4 * (player.getStat('V') + 3.5);
    let best = null, bestDist = Infinity;
    for (const bar of getBarTiles()) {
      const d = getNavDistBlocking(bar.x, bar.y, player)[`${px},${py}`] ?? Infinity;
      if (d < bestDist) { bestDist = d; best = bar; }
    }
    return (best && bestDist <= maxDist) ? { viable: true, barPos: best } : { viable: false };
  }

  // Find nearest SHOP likely to stock pot_heal (50 coins required).
  function nearestShopForHeal(player) {
    if (player.coins < 50) return null;
    const px = player.position?.x ?? 6;
    const py = player.position?.y ?? 2;
    const maxDist = 5 * (player.getStat('V') + 3.5);
    const tiles  = findTilePos(TileType.SHOP);
    const stocks = Game.getState().shopStocks ?? {};
    let best = null, bestDist = Infinity;
    for (const t of tiles) {
      const stock = stocks[`${t.x},${t.y}`];
      if (stock && !stock['pot_heal']) continue; // confirmed out-of-stock: skip
      const d = getNavDistBlocking(t.x, t.y, player)[`${px},${py}`] ?? Infinity;
      if (d < bestDist) { bestDist = d; best = t; }
    }
    return (best && bestDist <= maxDist) ? best : null;
  }

  // Return nearest tile of the given shopType that may stock itemId.
  // Shops with confirmed stock are preferred; unknown stock is optimistic; confirmed-absent skipped.
  function nearestShopOfType(shopType, player, itemId, minZone = 0) {
    const tileType = shopType === 'master'         ? TileType.MASTER
                   : shopType === 'guild_assassin' ? TileType.GUILD_ASSASSIN
                   : shopType === 'guild_thief'    ? TileType.GUILD_THIEF
                   :                                 TileType.SHOP;
    const tiles  = findTilePos(tileType);
    if (!tiles.length) return null;
    const px     = player.position?.x ?? 6;
    const py     = player.position?.y ?? 2;
    const stocks = Game.getState().shopStocks ?? {};
    let best = null, bestScore = -Infinity;
    for (const t of tiles) {
      if (tileType === TileType.SHOP && minZone > 0 && shopZone(t.x, t.y) < minZone) continue;
      const stock   = stocks[`${t.x},${t.y}`];
      const stockOk = !itemId || !stock ? 500 : stock[itemId] ? 1000 : 0;
      const score   = stockOk - Math.abs(t.x - px) - Math.abs(t.y - py);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // ── Primary attack strategy ──────────────────────────────────────────────────
  // Always recomputed from current baseStats so it stays in sync with
  // InventoryManager.detectStrategy() even after master-skill purchases shift
  // the highest base stat.  Caching the value would cause strategy drift and
  // equip/unequip cycles between bot.js and InventoryManager.
  function getStrategy(player) {
    const s = player.baseStats;
    return ['F','D','M','C'].reduce((best, st) => s[st] > s[best] ? st : best, 'F');
  }

  // ── Item helpers ─────────────────────────────────────────────────────────────
  function itemPower(item) {
    if (!item?.statBonus) return 0;
    return Math.max(...Object.values(item.statBonus).filter(v => v > 0), 0);
  }
  function equippedPower(player, slot) { return itemPower(player.equipped[slot]); }

  // Effective item score for equip decisions: raw stat + enchant/guild bonus.
  // Matches InventoryManager.itemScore so both modules agree on "which item is better"
  // and don't cycle (e.g. enchanted lower-power item vs higher-power unenchanted item).
  function itemEffScore(item) {
    if (!item) return 0;
    const statMax = Math.max(0, ...Object.values(item.statBonus ?? {}).filter(v => v > 0), 0);
    return statMax + (item.enchantment ? 3 : 0) + (item.guild ? 2 : 0);
  }
  function equippedEffScore(player, slot) { return itemEffScore(player.equipped[slot]); }

  function hasItemAnywhere(player, id) {
    return player.inventory.includes(id)
        || Object.values(player.equipped).some(e => e?.id === id);
  }

  function hasSlotPowerAnywhere(player, slot, minPower) {
    const inInv = player.inventory.some(id => {
      const item = getItem(id);
      return item?.slot === slot && itemPower(item) >= minPower;
    });
    if (inInv) return true;
    const eq = player.equipped[slot];
    return !!(eq && itemPower(eq) >= minPower);
  }

  // ── Equipment slots to manage (in priority order) ────────────────────────────
  const STRATEGY_SLOT = { F:'strength', D:'dexterity', M:'magic', C:'charisma' };

  function getEquipSlots(player) {
    const strat   = getStrategy(player);
    const offSlot = STRATEGY_SLOT[strat];
    // Primary offensive slot + defensive slots + charisma (enables bard retreat for non-C bots)
    const slots = [offSlot, 'armor', 'shield', 'speed'];
    if (strat !== 'C') slots.push('charisma');
    return slots;
  }

  // ── Permanent cleared-tile cache ─────────────────────────────────────────────
  // game.js calls player.refreshTiles() on every SHOP/MASTER visit, wiping
  // player.usedTiles.  MINIBOSS tiles this bot has already fought are stored here
  // instead so FARM navigation never re-targets tiles cleared by this player.
  function addPermCleared(player, x, y) {
    if (!botState[player.id]) botState[player.id] = {};
    if (!botState[player.id].permCleared) botState[player.id].permCleared = new Set();
    botState[player.id].permCleared.add(`${x},${y}`);
  }
  function isPermCleared(player, x, y) {
    return !!(botState[player.id]?.permCleared?.has(`${x},${y}`));
  }

  // ── Equipment optimisation step ──────────────────────────────────────────────
  // Returns { action:'equip', itemId } | { action:'unequip', slot } | null.
  // Uses itemEffScore (stat + enchant + guild bonus) so an enchanted item already
  // equipped is not swapped out for a slightly higher raw-stat unenchanted item.
  function equipStep(player) {
    const slots = getEquipSlots(player);
    for (const slot of slots) {
      let bestId = null, bestScore = equippedEffScore(player, slot);
      for (const id of player.inventory) {
        const item = getItem(id);
        if (!item || item.slot !== slot) continue;
        const s = itemEffScore(item);
        if (s > bestScore) { bestScore = s; bestId = id; }
      }
      if (!bestId) continue;
      if (player.equipped[slot]) return { action:'unequip', slot };
      if (!player.canEquip(getItem(bestId))) {
        // At 5-slot cap: sacrifice the lowest-score equipped slot not in our priority list
        const keepSlots = new Set(slots);
        const allSlots  = ['strength','dexterity','magic','charisma','speed','armor','shield'];
        let sacrificeSlot = null, lowestScore = Infinity;
        for (const s of allSlots) {
          if (!player.equipped[s] || keepSlots.has(s)) continue;
          const sc = itemEffScore(player.equipped[s]);
          if (sc < lowestScore) { lowestScore = sc; sacrificeSlot = s; }
        }
        if (sacrificeSlot) return { action:'unequip', slot: sacrificeSlot };
        continue;
      }
      return { action:'equip', itemId: bestId };
    }
    return null;
  }

  // ── Sell decision ────────────────────────────────────────────────────────────
  const KEEP_ALWAYS = new Set([
    'pot_heal','rope','compass','map','sp_invisibility','sp_teleport',
    'sp_smoke','sp_transmutation','chain','trap',
  ]);

  function findItemToSell(player) {
    const slots = new Set(getEquipSlots(player));

    // 1. Sell slotted items outclassed by what's currently equipped
    for (const id of player.inventory) {
      const item = getItem(id);
      if (!item?.slot || !item.buyPrice) continue;
      if (item.guild) continue; // never sell guild items — unique effects, hard to re-acquire
      const slot = item.slot;
      if (equippedPower(player, slot) > 0 && itemPower(item) <= equippedPower(player, slot))
        return id;
      // Sell offensive items for slots we don't manage (off-strategy weapons)
      if (['strength','dexterity','magic','charisma'].includes(slot) && !slots.has(slot))
        return id;
    }

    // 2. Sell excess consumables when inventory is cluttered
    if (player.inventory.length > 8) {
      for (const id of player.inventory) {
        if (KEEP_ALWAYS.has(id)) continue;
        if (id.startsWith('priest_pot_')) continue;
        const item = getItem(id);
        if (!item?.buyPrice || item.slot || item.subtype) continue;
        return id;
      }
    }
    return null;
  }

  // ── Shop available check ─────────────────────────────────────────────────────
  function makeShopAvailableCheck() {
    const state = Game.getState();
    const pos   = state.currentShopPosition;
    if (!pos) return () => true;
    const stock = state.shopStocks?.[`${pos.x},${pos.y}`];
    if (!stock) return () => true;
    return id => !!(stock[id]);
  }

  // ── Buy decision ─────────────────────────────────────────────────────────────
  // plan is the BotPlan object from getPlan(); pass null to fall back to advisor-only logic.
  function findItemToBuy(player, available, plan) {
    const coins = player.coins;
    if (!available) available = makeShopAvailableCheck();

    // Emergency heal — always highest priority
    if (player.hearts.current <= 2 && !player.hasItem('pot_heal')
        && coins >= 50 && available('pot_heal'))
      return 'pot_heal';

    // Near-dragon consumables: stock potions when committed or prepping
    const dragonCommit = plan?.phase === PLAN_PHASE.FIGHT_DRAGON
                      || plan?.phase === PLAN_PHASE.DRAGON_PREP;
    if (dragonCommit) {
      const heals   = player.inventory.filter(id => id === 'pot_heal').length;
      if (heals < 10 && coins >= 50 && available('pot_heal')) return 'pot_heal';
      const strat2  = getStrategy(player);
      // Stock up to 10 primary offensive pots (human wins used 10x D3 / 10x F3)
      const atkPots = player.inventory.filter(id => /^pot_[FDAMC]\d$/.test(id) && id[4] === strat2).length;
      if (atkPots < 10 && coins >= 30 && available(`pot_${strat2}3`)) return `pot_${strat2}3`;
      if (atkPots < 10 && coins >= 20 && available(`pot_${strat2}2`)) return `pot_${strat2}2`;
      // Stock defensive pots for the primary defense stat of this strategy
      const defStat = strat2 === 'D' ? 'V' : 'A';
      const defPots = player.inventory.filter(id => id.startsWith(`pot_${defStat}`)).length;
      if (defPots < 8 && coins >= 30 && available(`pot_${defStat}3`)) return `pot_${defStat}3`;
      if (!player.inventory.includes('pot_A3') && coins >= 30 && available('pot_A3')) return 'pot_A3';
      if (!player.inventory.includes('pot_V3') && coins >= 30 && available('pot_V3')) return 'pot_V3';
    }

    // Follow upgrade plan: buy the recommended item if affordable and stocked here.
    // Handles both regular and guild items.
    if (plan?.upgrade && (plan.shortfall ?? 0) === 0) {
      const u = plan.upgrade;
      if ((u.type === 'regular' || u.type === 'guild')
          && !hasItemAnywhere(player, u.itemId)
          && coins >= u.cost && available(u.itemId)) {
        // Guard: don't buy if InventoryManager would immediately sell the item.
        // This happens when the bot has a better (e.g., enchanted) item already equipped.
        // itemScore = statMax + enchantBonus(3) + guildBonus(2), matching InventoryManager.
        const itemToScore = it => {
          if (!it) return 0;
          const statMax = Math.max(0, ...Object.values(it.statBonus ?? {}).filter(v => v > 0), 0);
          return statMax + (it.enchantment ? 3 : 0) + (it.guild ? 2 : 0);
        };
        const newItem = getItem(u.itemId);
        if (!newItem?.slot) {
          return u.itemId; // non-slotted (consumable) — always safe to buy
        }
        // Guard 1: skip if the item's slot is not a priority slot for this build.
        // InventoryManager would sell it immediately (non-priority → off-strategy).
        const prioritySlots = new Set(getEquipSlots(player));
        if (prioritySlots.has(newItem.slot)) {
          // Guard 2: skip if currently equipped item has a higher effective score
          // (base stat + enchant bonus + guild bonus), matching InventoryManager.
          const equippedInSlot = player.equipped[newItem.slot];
          const wouldSell = equippedInSlot && itemToScore(newItem) <= itemToScore(equippedInSlot);
          if (!wouldSell) return u.itemId;
        }
        // else: slot is non-priority or item would be sold — fall through
      }
    }

    // Interim weapon: if strategy slot is empty and the plan's upgrade won't be available
    // at this shop (e.g. guild item, wrong zone), buy the best affordable regular weapon here.
    {
      const strat    = getStrategy(player);
      const offSlot  = STRATEGY_SLOT[strat];
      const needsWpn = !player.equipped[offSlot] && !player.inventory.some(id => {
        const it = getItem(id);
        return it?.slot === offSlot && itemPower(it) > 0;
      });
      if (needsWpn) {
        const candidates = EQUIPMENT
          .filter(i => i.slot === offSlot && i.buyPrice && coins >= i.buyPrice && available(i.id))
          .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));
        if (candidates.length) return candidates[0].id;
      }
    }

    return null;
  }

  // ── Master action ────────────────────────────────────────────────────────────
  function findMasterAction(player, plan) {
    const coins = player.coins;
    const strat = getStrategy(player);

    // Follow advisor enchant recommendation when that is explicitly the plan target.
    if (plan?.upgrade?.type === 'enchant' && plan.shortfall === 0) {
      const u       = plan.upgrade;
      const enchObj = ENCHANTMENTS.find(e => e.id === u.enchantId);
      const cost    = enchObj?.cost ?? 50;
      if (coins >= cost) return { type:'enchant', slot:u.slot, enchantId:u.enchantId, tier:1 };
    }

    // Buy skills: raise primary offensive stat first, then A and V (Master caps at 6, 5 buys total)
    if ((player.masterSkillsBought ?? 0) < 5) {
      for (const stat of [strat, 'A', 'V']) {
        if (coins >= 50 && player.baseStats[stat] < 6)
          return { type:'buy_skill', stat };
      }
    }

    // Opportunistic enchanting: if the strategy-slot weapon has no enchantment, enchant it.
    // Preferred enchants per strategy (offensive first, then utility).
    const PREF_ENCHANTS = {
      F: ['fury', 'sharpness', 'bloodlust', 'plunder'],
      D: ['hawk_eye', 'precision', 'bloodlust', 'plunder'],
      M: ['fury', 'bloodlust'],
      C: ['plunder', 'bloodlust'],
    };
    const offSlot  = STRATEGY_SLOT[strat];
    const equipped = player.equipped[offSlot];
    if (equipped && !equipped.enchantment) {
      const preferred = PREF_ENCHANTS[strat] ?? ['fury'];
      for (const enchId of preferred) {
        const enchObj = ENCHANTMENTS.find(e => e.id === enchId);
        if (!enchObj) continue;
        const cost = enchObj.cost ?? 50;
        if (coins >= cost) return { type:'enchant', slot:offSlot, enchantId:enchId, tier:1 };
      }
    }
    // Also enchant armor if it has no enchantment.
    const armorEq = player.equipped['armor'];
    if (armorEq && !armorEq.enchantment && coins >= 50) {
      return { type:'enchant', slot:'armor', enchantId:'thorns', tier:1 };
    }

    return null;
  }

  // ── Max safe miniboss tier (stat heuristic) ──────────────────────────────────
  function maxSafeMiniTier(player) {
    const off = Math.max(
      player.getStat('F'), player.getStat('D'),
      player.getStat('M'), player.getStat('C')
    );
    if (off >= 14) return 3;
    if (off >= 10) return 2;
    if (off >= 6)  return 1;
    return 0;
  }

  // ── Whether player has a guild item still gaining levels ─────────────────────
  function playerHasGuildItemToLevel(player) {
    for (const [id, lvl] of Object.entries(player.guildItemLevels ?? {})) {
      const maxLv = id === 'magic_flute_thief' ? 8 : 6;
      if ((lvl.itemLevel ?? 1) < maxLv) return true;
    }
    return false;
  }

  // ── Navigation target ────────────────────────────────────────────────────────
  // Returns {x, y, weight} of the tile the bot is navigating toward this turn,
  // or null if no directional target (bot stays opportunistic).
  function getNavTarget(player, plan) {
    const state = Game.getState();
    switch (plan?.phase) {

      case PLAN_PHASE.HEAL_FIRE: {
        const fp = plan.firePos;
        if (fp) return { x:fp.x, y:fp.y, weight:800 };
        break;
      }

      case PLAN_PHASE.HEAL_BAR: {
        const bp = plan.barPos;
        if (!bp) break;
        // If standing on BAR already and there's an adjacent REROLL, loop back next move.
        if (player.position.x === bp.x && player.position.y === bp.y) {
          const adj    = MapGrid.getAdjacent(bp.x, bp.y, false);
          const reroll = adj.find(n => MapGrid.get(n.x, n.y) === TileType.REROLL);
          if (reroll) return { x:reroll.x, y:reroll.y, weight:900 };
        }
        return { x:bp.x, y:bp.y, weight:900 };
      }

      case PLAN_PHASE.HEAL_SHOP: {
        const sp = plan.shopPos;
        if (sp) return { x:sp.x, y:sp.y, weight:850 };
        break;
      }

      case PLAN_PHASE.PVP_FINISH: {
        const fp = findTilePos(TileType.FINISH)[0];
        if (fp) return { x:fp.x, y:fp.y, weight:120 };
        break;
      }

      case PLAN_PHASE.PVP_CHASE: {
        if (state.princess) return { x:state.princess.x, y:state.princess.y, weight:90 };
        break;
      }

      case PLAN_PHASE.FIGHT_DRAGON: {
        const p = getBossTilePos('dragon');
        if (p) return { x:p.x, y:p.y, weight:500 };
        break;
      }

      case PLAN_PHASE.DRAGON_PREP: {
        if (plan.upgrade && plan.shortfall === 0) {
          const owned = plan.upgrade.type === 'enchant' ? false : hasItemAnywhere(player, plan.upgrade.itemId);
          if (!owned) {
            const mz      = minZoneForUpgrade(plan.upgrade);
            const shopPos = nearestShopOfType(plan.upgrade.shopType, player, plan.upgrade.itemId, mz);
            if (shopPos) return { x:shopPos.x, y:shopPos.y, weight:70 };
          }
        }
        // Route to shop to stock potions if not yet ready for the fight.
        // Use higher weight than dragon (160 > 150) so shop wins when both reachable.
        const strat2   = getStrategy(player);
        const healPots = player.inventory.filter(id => id === 'pot_heal').length;
        const atkPots  = player.inventory.filter(id => new RegExp(`^pot_${strat2}[23]$`).test(id)).length;
        const readyPots = healPots >= 7 && atkPots >= 7;
        if (!readyPots) {
          const shopPos = nearestShopOfType('shop', player, 'pot_heal', 0);
          if (shopPos) return { x:shopPos.x, y:shopPos.y, weight:160 };
        }
        const p = getBossTilePos('dragon');
        if (p) return { x:p.x, y:p.y, weight:150 };
        break;
      }

      case PLAN_PHASE.UPGRADE: {
        if (plan.upgrade && plan.shortfall === 0) {
          const owned = plan.upgrade.type === 'enchant' ? false : hasItemAnywhere(player, plan.upgrade.itemId);
          if (!owned) {
            const mz      = minZoneForUpgrade(plan.upgrade);
            const shopPos = nearestShopOfType(plan.upgrade.shopType, player, plan.upgrade.itemId, mz);
            if (shopPos) return { x:shopPos.x, y:shopPos.y, weight:70 };
          }
        }
        break;
      }

      case PLAN_PHASE.FARM: {
        // Navigate to nearest miniboss of the highest safe tier (fall back to lower if none left).
        const targetTier = plan.farmingTier ?? 0;
        const px = player.position?.x ?? 6;
        const py = player.position?.y ?? 2;
        let bestMb = null, bestDist = Infinity;
        for (let t = targetTier; t >= 0; t--) {
          for (let gy = 0; gy < 38; gy++) {
            for (let gx = 0; gx < 51; gx++) {
              if (MapGrid.get(gx, gy) !== TileType.MINIBOSS) continue;
              if ((MapGrid.getTileData(gx, gy)?.minibossTier ?? 0) !== t) continue;
              if (player.hasUsedTile?.(gx, gy) || isPermCleared(player, gx, gy)) continue;
              const d = Math.abs(gx - px) + Math.abs(gy - py);
              if (d < bestDist) { bestDist = d; bestMb = { x:gx, y:gy }; }
            }
          }
          if (bestMb) break;
        }
        if (bestMb) return { x:bestMb.x, y:bestMb.y, weight:250 };
        // Pre-position toward shop when shortfall is close to clearing.
        if (plan.upgrade && plan.shortfall <= 200 && !hasItemAnywhere(player, plan.upgrade.itemId)) {
          const mz = minZoneForUpgrade(plan.upgrade);
          const sp = nearestShopOfType(plan.upgrade.shopType, player, plan.upgrade.itemId, mz);
          if (sp) return { x:sp.x, y:sp.y, weight:40 };
        }
        break;
      }

      case PLAN_PHASE.CHEST_RUN: {
        if (plan.chestRun?.recommended && plan.chestRun.nextChest) {
          const c = plan.chestRun.nextChest;
          return { x:c.x, y:c.y, weight:200 };
        }
        if (plan.upgrade && plan.shortfall <= 200 && !hasItemAnywhere(player, plan.upgrade.itemId)) {
          const mz = minZoneForUpgrade(plan.upgrade);
          const sp = nearestShopOfType(plan.upgrade.shopType, player, plan.upgrade.itemId, mz);
          if (sp) return { x:sp.x, y:sp.y, weight:40 };
        }
        break;
      }

      default:
        break;
    }
    return null; // opportunistic movement — scoring handles the rest
  }

  // ── Tile scoring ─────────────────────────────────────────────────────────────
  function scoreTile(x, y, steps, player, state, plan) {
    const tType = MapGrid.get(x, y);
    let score = steps; // small tiebreaker: prefer tiles farther along the map

    const navTarget    = getNavTarget(player, plan);
    const navTargetKey = navTarget ? `${navTarget.x},${navTarget.y}` : null;
    const hasUrgentNav = !!(navTarget && navTargetKey && !state.reachableTiles?.has(navTargetKey));

    // On-path bonus: any tile that is closer to the nav target than the current position.
    // In heal/farm phases use the blocking BFS (respects unbeatable minibosses).
    if (hasUrgentNav) {
      const isBlockingPhase = plan?.phase === PLAN_PHASE.HEAL_FIRE
                           || plan?.phase === PLAN_PHASE.HEAL_BAR
                           || plan?.phase === PLAN_PHASE.FARM;
      const navDist = isBlockingPhase
        ? getNavDistBlocking(navTarget.x, navTarget.y, player)
        : getNavDist(navTarget.x, navTarget.y);
      const dHere   = navDist[`${x},${y}`]                                 ?? Infinity;
      const dPlayer = navDist[`${player.position.x},${player.position.y}`] ?? Infinity;
      if (dHere < dPlayer) score += navTarget.weight ?? 50;
    }
    // Direct hit on the target itself
    if (navTarget && x === navTarget.x && y === navTarget.y)
      score += (navTarget.weight ?? 50) * 2;

    const isHealMode   = plan?.phase === PLAN_PHASE.HEAL_FIRE || plan?.phase === PLAN_PHASE.HEAL_BAR;
    const isHealShop   = plan?.phase === PLAN_PHASE.HEAL_SHOP;
    const isBossNav    = plan?.phase === PLAN_PHASE.FIGHT_DRAGON;
    const isDragonPrep = plan?.phase === PLAN_PHASE.DRAGON_PREP;
    const isChestRun   = plan?.phase === PLAN_PHASE.CHEST_RUN;
    const isGuildFarm  = plan?.phase === PLAN_PHASE.FARM && playerHasGuildItemToLevel(player);
    // Use the estimator's farming tier; fall back to stat heuristic early on.
    const farmingTier  = plan != null ? (plan.farmingTier ?? 0) : maxSafeMiniTier(player);

    switch (tType) {

      case TileType.SHOP:
      case TileType.GUILD_ASSASSIN:
      case TileType.GUILD_THIEF: {
        if (isHealMode) { score += 0; break; } // ignore shops until healed via fire/bar
        if (isHealShop) { score += 2000; break; } // this shop IS the heal destination
        if (isBossNav) {
          // Rushing dragon: only stop for an emergency heal potion
          const avail = id => { const s2 = state.shopStocks?.[`${x},${y}`]; return !s2 || !!(s2[id]); };
          const needsHeal = player.hearts.current <= 2 && !player.hasItem('pot_heal')
                         && player.coins >= 50 && avail('pot_heal');
          score += needsHeal ? 250 : 0;
          break;
        }
        const avail = id => {
          const stock = state.shopStocks?.[`${x},${y}`];
          return !stock || !!(stock[id]);
        };
        const wantsToBuy  = findItemToBuy(player, avail, plan) !== null;
        const wantsToSell = findItemToSell(player) !== null;
        let s = 0;
        if (wantsToBuy)            s = Math.max(s, 700);
        if (wantsToSell)           s = Math.max(s, 400);
        if (player.coins > 200 && wantsToBuy) s = Math.max(s, 650);
        score += s;
        break;
      }

      case TileType.MASTER: {
        if (isHealMode || isHealShop) { score += 0; break; }
        if (isBossNav) { score += 0; break; }
        const action = findMasterAction(player, plan);
        if (action) score += plan?.upgrade?.type === 'enchant' ? 700 : 500;
        else if (player.coins >= 50) score += 150;
        break;
      }

      case TileType.FIRE:
        if (isHealMode) { score += 2000; break; } // primary heal target
        score += player.hearts.current < player.hearts.max ? 400 : 50;
        break;

      case TileType.PRIEST: {
        if (isHealMode || isHealShop || isBossNav || isDragonPrep) { score += 0; break; }
        const hasBlessing = player.inventory.some(id => id.startsWith('priest_pot_'))
                         || player.priestBuff > 0;
        score += (!player.hasUsedTile(x, y) && !hasBlessing) ? 240 : 0;
        break;
      }

      case TileType.BOSS: {
        if (isHealMode || isHealShop) { score -= 1000; break; } // never fight a boss while healing
        const bossId = MapGrid.getTileData(x, y)?.bossId;
        if (!bossId) break;
        const rattleOk = player.hasEquipped?.('cursed_rattle');
        const heartOk  = rattleOk ? player.hearts.current >= 1 : player.hearts.current >= 3;
        if (bossId === 'dragon') {
          const dragonWinProb = plan?.dragonWinProb ?? 0;
          score += (isBossNav && heartOk)                                 ? 2000
                 : (isDragonPrep && heartOk && dragonWinProb >= 0.45)    ? 600
                 : -500;
        } else {
          score -= 350; // all other bosses: avoid
        }
        break;
      }

      case TileType.MINIBOSS: {
        const mTier   = MapGrid.getTileData(x, y)?.minibossTier ?? 0;
        const maxSafe = maxSafeMiniTier(player);
        const beatable = mTier <= maxSafe;

        if (isHealMode || isHealShop) {
          // Never step on miniboss tiles while healing — penalty exceeds path bonus (800).
          score -= 2000;
          break;
        }
        if (player.hasUsedTile?.(x, y) || isPermCleared(player, x, y)) { score -= 500; break; }
        if (isChestRun) { score -= 600; break; } // avoid all combat while chest-running
        if (player.hearts.current <= 1)  { score -= 600; break; }

        if (isBossNav || isDragonPrep) {
          // Approaching dragon: skip all minibosses to preserve hearts.
          score -= 300;
          break;
        }

        if (isGuildFarm) {
          // Actively seek minibosses for guild item kill XP; higher tier = faster leveling
          score += mTier <= farmingTier ? 550 + mTier * 50 : -300;
          break;
        }

        // Normal farming: fight within safe tier range, prefer higher tiers for better loot
        if (plan?.canFarm ?? true) {
          score += (mTier <= farmingTier && player.hearts.current >= 2)
            ? 300 + mTier * 100
            : (beatable ? -50 : -200); // beatable but above farmingTier: mild penalty
        } else {
          score -= beatable ? 100 : 300;
        }
        break;
      }

      case TileType.RANDOM_EVENT:
        if (isHealMode || isHealShop)                                    score -= 1200; // avoid fights (> path bonus 800)
        else if (player.hasUsedTile(x, y))                              score -= 60;
        else if (isBossNav || isDragonPrep || !(plan?.canFarm ?? true)) score -= 200;
        else score += player.hearts.current <= 2 ? -60 : 60; // fight when healthy (HP>2), mild avoid otherwise
        break;

      case TileType.CHEST:
        if (player.hasUsedTile(x, y)) { score -= 80; break; }
        if (isChestRun) {
          const isFreeway = plan.chestRun.allChests?.some(c => c.x === x && c.y === y);
          score += isFreeway ? 600 : 300;
          break;
        }
        score += (plan?.shortfall ?? 0) > 0 ? 300 : 150;
        break;

      case TileType.WORK:
        if (isBossNav)  { score += 0; break; }
        if (isChestRun) score += player.coins < 60 ? 280 : 150;
        else            score += player.coins < 60 ? 350 : player.coins < 200 ? 180 : 70;
        break;

      case TileType.REROLL:
        if (player.hasUsedTile?.(x, y)) { score += 20; break; }
        if (hasUrgentNav) {
          const isBlockingPhase = plan?.phase === PLAN_PHASE.HEAL_FIRE
                               || plan?.phase === PLAN_PHASE.HEAL_BAR
                               || plan?.phase === PLAN_PHASE.FARM;
          const navDist = isBlockingPhase
            ? getNavDistBlocking(navTarget.x, navTarget.y, player)
            : getNavDist(navTarget.x, navTarget.y);
          const dPlayer = navDist[`${player.position.x},${player.position.y}`] ?? Infinity;
          const dHere   = navDist[`${x},${y}`]                                 ?? Infinity;
          score += dHere <= dPlayer ? 400 : 80;
        } else {
          score += 80;
        }
        break;

      case TileType.BAR:
        if (isHealMode && plan?.phase === PLAN_PHASE.HEAL_BAR) {
          // BAR is the heal target; score it high so the bot lands here after REROLL too.
          score += (player.coins >= 10 && player.hearts.current < player.hearts.max) ? 2000 : 0;
          break;
        }
        if (isHealMode || isHealShop || isBossNav || isDragonPrep) { score += 0; break; }
        score += (player.hearts.current < player.hearts.max && player.coins >= 10) ? 150 : 0;
        break;

      default:
        break;
    }

    return score;
  }

  // ── Choose move ──────────────────────────────────────────────────────────────
  function chooseMove(player, state, plan) {
    const reachable = state.reachableTiles;
    if (!reachable || reachable.size === 0) return player.position;

    // PVP: rush to FINISH if carrying princess
    if (player.hasPrincess) {
      let finish = null;
      reachable.forEach((_, key) => {
        const [x, y] = key.split(',').map(Number);
        if (MapGrid.get(x, y) === TileType.FINISH) finish = {x, y};
      });
      if (finish) return finish;
    }

    // PVP: step onto princess tile to pick it up
    if (state.pvpActive && !player.hasPrincess && state.princess) {
      const pk = `${state.princess.x},${state.princess.y}`;
      if (reachable.has(pk)) return { x:state.princess.x, y:state.princess.y };
    }

    let best = null, bestScore = -Infinity;
    reachable.forEach((steps, key) => {
      const [x, y] = key.split(',').map(Number);
      const s = scoreTile(x, y, steps, player, state, plan);
      if (s > bestScore) { bestScore = s; best = {x, y}; }
    });
    return best ?? player.position;
  }

  // ── Combat decisions ─────────────────────────────────────────────────────────
  function chooseCombatAction(player, mob) {
    // Never bail/run from a BOSS tile — boss mobs fully regenerate on escape.
    const onBossTile = MapGrid.get(player.position.x, player.position.y) === TileType.BOSS;
    if (!onBossTile && player.hearts.current <= 1 && player.canEscape())
      return { type:'bail' };
    if (!onBossTile && player.hearts.current <= 1 && player.chainedTurns === 0)
      return { type:'run' };

    const strat      = getStrategy(player);
    const defenseFor = { F:'A', D:'V', M:'M', C:'C' };
    const available  = ['F','D','M','C'].filter(t => !(t === 'M' && !player.canAttackMagic()));

    // Use bard defensively when at low health (flee to avoid death) or when C is the strategy
    if (!onBossTile) {
      const cPow  = player.getStat('C');
      const mobC  = mob.stats?.C ?? 0;
      const lowHP = player.hearts.current <= 2;
      // C-strategy bots: bard on low-tier mobs for stat gains (respect:3 = permanent +1)
      if (strat === 'C' && (mob.tier ?? 0) <= 2 && cPow >= mobC + 1) return { type:'bard' };
      // All bots: bard at low health on weak mobs to get heal/flee option
      if (lowHP && (mob.tier ?? 0) <= 1 && cPow >= mobC) return { type:'bard' };
    }

    let best = null, bestScore = -Infinity;
    for (const t of available) {
      const s = player.getStat(t) - (mob.stats[defenseFor[t]] ?? 0)
              + (t === strat ? 0.5 : 0);
      if (s > bestScore) { bestScore = s; best = t; }
    }

    // On BOSS tiles: bard only if Cursed Rattle equipped (enables kill:1 = instant kill).
    // Without it, bard produces charisma outcomes (coins/heal) that never damage the boss.
    if (best === 'C') {
      if (!onBossTile || player.hasEquipped('cursed_rattle')) return { type:'bard' };
      // Forced onto a physical attack despite C being theoretically best
      const nonC = available.filter(t => t !== 'C');
      if (!nonC.length) return { type:'attack', attackType:'F', spellId:null };
      best = nonC.reduce((b, t) => {
        const sB = player.getStat(b) - (mob.stats[defenseFor[b]] ?? 0);
        const sT = player.getStat(t) - (mob.stats[defenseFor[t]] ?? 0);
        return sT > sB ? t : b;
      }, nonC[0]);
    }

    let spellId = null;
    if (best === 'M') {
      const spell = player.inventory
        .map(id => getItem(id))
        .filter(i => i?.subtype === 'attack')
        .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
      spellId = spell?.id ?? null;
    }

    return { type:'attack', attackType:best, spellId };
  }

  // ── Charisma outcome decision ────────────────────────────────────────────────
  function charismaOutcomeDecision(player, combat) {
    const diff    = combat.charismaResult?.diff ?? 0;
    const maxTier = diff >= 7 ? 3 : diff >= 5 ? 2 : 1;

    if (diff < 1) return { type:'charisma_outcome', retreat:true };

    // Cursed Rattle equipped → instant kill on any successful charisma exchange
    if (player.hasEquipped('cursed_rattle'))
      return { type:'charisma_outcome', family:'kill', tier:1 };

    if (maxTier >= 3) return { type:'charisma_outcome', family:'respect', tier:3 };

    if (maxTier >= 2) {
      if (player.hearts.current < player.hearts.max)
        return { type:'charisma_outcome', family:'friendly', tier:2 };
      const mob     = combat.mob;
      const topStat = ['F','D','M','C'].reduce((b, s) => mob.stats[s] > mob.stats[b] ? s : b, 'F');
      return { type:'charisma_outcome', family:'mock', tier:2, stat:topStat };
    }

    if (player.hearts.current <= Math.ceil(player.hearts.max / 2))
      return { type:'charisma_outcome', retreat:true };
    return { type:'charisma_outcome', family:'deceive', tier:1 };
  }

  // ── Shop handler ─────────────────────────────────────────────────────────────
  function handleShopTurn(player, plan) {
    if (!botState[player.id]) botState[player.id] = {};
    // Safety guard: track actions per shop visit; force-close after 25 to break any loop.
    const state  = Game.getState();
    const spKey  = state.currentShopPosition
      ? `${state.currentShopPosition.x},${state.currentShopPosition.y},${state.phase}`
      : state.phase;
    if (botState[player.id]._shopKey !== spKey) {
      botState[player.id]._shopKey = spKey;
      botState[player.id]._shopAct = 0;
    }
    botState[player.id]._shopAct++;
    if (botState[player.id]._shopAct > 25) {
      botState[player.id]._shopAct = 0;
      Game.submitAction({ type:'close' });
      return;
    }

    // 0. Unequip off-strategy items so they land in inventory and can be sold.
    //    (InventoryManager tracks non-priority equipped slots.)
    if (typeof InventoryManager !== 'undefined') {
      const unequipSlot = InventoryManager.nextUnequipSlot(player);
      if (unequipSlot) {
        Game.submitAction({ type:'unequip', slot: unequipSlot });
        return;
      }
    }

    // 1. Equip anything better already in inventory
    const eq = equipStep(player);
    if (eq) {
      Game.submitAction(eq.action === 'equip'
        ? { type:'equip',   itemId:eq.itemId }
        : { type:'unequip', slot:  eq.slot   });
      return;
    }

    // 2. Sell all superfluous items (InventoryManager gives the full list;
    //    fall back to the old per-item heuristic if module not loaded).
    const sellId = (typeof InventoryManager !== 'undefined')
      ? InventoryManager.nextSellId(player)
      : findItemToSell(player);
    if (sellId) { Game.submitAction({ type:'sell', itemId:sellId }); return; }

    // 3. Buy advisor's recommendation if this shop stocks it
    const available = makeShopAvailableCheck();
    const buyId = findItemToBuy(player, available, plan);
    if (buyId) { Game.submitAction({ type:'buy', itemId:buyId }); return; }

    Game.submitAction({ type:'close' });
  }

  // ── Master handler ───────────────────────────────────────────────────────────
  function handleMasterTurn(player, plan) {
    // Equip step first: weapon must be equipped before enchanting
    const eq = equipStep(player);
    if (eq) {
      Game.submitAction(eq.action === 'equip'
        ? { type:'equip',   itemId:eq.itemId }
        : { type:'unequip', slot:  eq.slot   });
      return;
    }

    const action = findMasterAction(player, plan);
    if (action) { Game.submitAction(action); return; }

    Game.submitAction({ type:'close' });
  }

  // ── Teleport handler ─────────────────────────────────────────────────────────
  function handleTeleportTurn(player, state, plan) {
    const dests = state.teleportDestinations ?? [];
    if (!dests.length) { Game.submitAction({ type:'close' }); return; }
    // Prefer Master when enchant is the next target or coins available for skills; else Shop
    const wantsMaster = plan?.upgrade?.type === 'enchant' || player.coins >= 50;
    const prefer = wantsMaster ? TileType.MASTER : TileType.SHOP;
    const dest   = dests.find(d => d.tileType === prefer) ?? dests[0];
    Game.submitAction({ type:'teleport_confirm', dest });
  }

  // ── Map-choice handler ───────────────────────────────────────────────────────
  function handleMapChoice() {
    Game.submitAction({ type:'map_roll', value:6 }); // always pick best outcome
  }

  // ── Main turn dispatcher ─────────────────────────────────────────────────────
  function takeTurn(player) {
    const state = Game.getState();
    const phase = state.phase;

    if (phase === Game.Phase.ROLL_MOVE) {
      // Use healing potions before rolling if below max HP,
      // but reserve pots for the dragon fight when committed.
      const prevPlan   = botState[player.id]?.plan;
      const dragonPrep = prevPlan?.phase === PLAN_PHASE.DRAGON_PREP;
      const dragonFight = prevPlan?.phase === PLAN_PHASE.FIGHT_DRAGON;
      const healCount  = player.inventory.filter(id => id === 'pot_heal').length;
      // In dragon fight: save ALL pots for combat (only use in absolute emergency).
      // In dragon prep: save 7; use extras above that for walking around.
      const reserve = dragonFight ? healCount : dragonPrep ? 7 : 0;
      const critical = player.hearts.current <= 2; // always heal at ≤2 — matches plan's HEAL threshold
      if (player.hearts.current < player.hearts.max && (healCount > reserve || critical)) {
        Game.submitAction({ type:'use_item', itemId:'pot_heal' });
        return;
      }
      Game.submitAction({ type:'roll' });
      return;
    }

    // Compute plan once per turn — passed to all helpers to avoid redundant advisor calls
    const plan = getPlan(player, state);

    if (phase === Game.Phase.MOVING) {
      Game.submitAction({ type:'move', dest: chooseMove(player, state, plan) });
      return;
    }

    if (phase === Game.Phase.COMBAT) {
      const combat = state.pendingCombat;
      if (!combat) return;

      // Permanently record MINIBOSS tile as cleared so FARM nav skips it even
      // after shop visits that call player.refreshTiles() and wipe usedTiles.
      {
        const pos = player.position;
        if (pos && MapGrid.get(pos.x, pos.y) === TileType.MINIBOSS)
          addPermCleared(player, pos.x, pos.y);
      }

      const sub = combat.combatSubPhase;

      if (sub === 'mob_attack') {
        Game.submitAction({ type:'defend' });
        return;
      }
      if (sub === 'charisma_pick') {
        Game.submitAction(charismaOutcomeDecision(player, combat));
        return;
      }
      if (sub === 'friend_fighting') {
        Game.submitAction({ type:'friend_round' });
        return;
      }
      if (sub === 'friend_died') {
        Game.submitAction({ type:'friend_take_over' });
        return;
      }

      // player_attack: CombatNN handles consumable decisions for all fights.
      // On BOSS tiles, override bail/run — boss mobs regenerate fully on escape.
      const onBossTile = MapGrid.get(player.position.x, player.position.y) === TileType.BOSS;

      // In heal mode: escape immediately at H≤2 (one hit away from death) if possible.
      const inHealMode = plan.phase === PLAN_PHASE.HEAL_FIRE
                      || plan.phase === PLAN_PHASE.HEAL_BAR
                      || plan.phase === PLAN_PHASE.HEAL_SHOP;
      if (inHealMode && !onBossTile && player.hearts.current <= 2) {
        if (player.canEscape()) { Game.submitAction({ type:'bail' }); return; }
        if (player.chainedTurns === 0) { Game.submitAction({ type:'run' }); return; }
      }

      const action = CombatNN.chooseAction(player, combat.mob, combat.mobNextAttackType);
      if (onBossTile && (action?.type === 'bail' || action?.type === 'run')) {
        Game.submitAction(chooseCombatAction(player, combat.mob));
      } else {
        Game.submitAction(action);
      }
      return;
    }

    if (phase === Game.Phase.SHOP)            { handleShopTurn(player, plan);             return; }
    if (phase === Game.Phase.MASTER)          { handleMasterTurn(player, plan);           return; }
    if (phase === Game.Phase.TELEPORT_CHOICE) { handleTeleportTurn(player, state, plan);  return; }
    if (phase === Game.Phase.MAP_CHOICE)      { handleMapChoice();                         return; }

    if (phase === Game.Phase.CHEST) {
      const rolls = state.pendingChestRolls ?? [];
      Game.submitAction({ type:'chest_pick', value: rolls.length ? Math.max(...rolls) : 6 });
      return;
    }

    // PRIEST, WORK, STOP_BLOCKED, LOOT_CONFIRM, BACK → auto-confirm
    Game.submitAction({ type:'tile_confirm' });
  }

  // ── Phase label (for diagnostics / simulate.js) ──────────────────────────────
  function getPhase(player) {
    const plan = getPlan(player, Game.getState());
    switch (plan.phase) {
      case PLAN_PHASE.HEAL_FIRE:    return 'heal_fire';
      case PLAN_PHASE.HEAL_BAR:     return 'heal_bar';
      case PLAN_PHASE.HEAL_SHOP:    return 'heal_shop';
      case PLAN_PHASE.FIGHT_DRAGON: return 'dragon';
      case PLAN_PHASE.DRAGON_PREP:  return 'dragon_prep:' + ((plan.dragonWinProb ?? 0) * 100 | 0) + '%';
      case PLAN_PHASE.UPGRADE:      return 'upgrade:' + (plan.upgrade?.label ?? plan.upgrade?.itemId ?? '?');
      case PLAN_PHASE.FARM:         return 'farming:tier' + (plan.farmingTier ?? 0);
      case PLAN_PHASE.CHEST_RUN:    return 'chest_run';
      case PLAN_PHASE.PVP_FINISH:   return 'pvp_finish';
      case PLAN_PHASE.PVP_CHASE:    return 'pvp_chase';
      default:                      return 'waiting';
    }
  }

  return { chooseCombatAction, takeTurn, getPhase };
})();
