// Bot AI — data-driven strategic agents.
// chooseCombatAction() and takeTurn() are the external API.
//
// Decision loop each turn:
//   1. UpgradeAdvisor.nextUpgrade(player) → what to buy, where to farm, dragon readiness
//   2. Navigate toward upgrade shop | dragon tile | freeway chests
//   3. At shops: buy advisor's recommendation or emergency consumables
//   4. At Master: apply advisor's enchant or buy skills
//   5. In combat: CombatNN for normal fights; rule-based for BOSS tiles (no bail)
//
// No hardcoded gear plans or phase sequences — all driven by UpgradeAdvisor + CombatEstimator.

const BotAI = (() => {

  // ── Per-player state ─────────────────────────────────────────────────────────
  const botState = {};

  // ── Cached physical dragon win probability ───────────────────────────────────
  // Computed once per turn (not per tile) — Monte Carlo is expensive.
  // Stored in botState and refreshed when the player's effective F/D/M stats change.
  const _physWinCache = {}; // playerId → { key, winProb }
  function getPhysWinProb(player) {
    if (typeof CombatEstimator === 'undefined' || !CombatEstimator.estimateBoss) return 1;
    const key = `${player.getStat('F')},${player.getStat('D')},${player.getStat('M')},${player.hearts.current},${player.hearts.max}`;
    const cached = _physWinCache[player.id];
    if (cached && cached.key === key) return cached.winProb;
    const winProb = CombatEstimator.estimateBoss(player, 'dragon', 60)?.winProb ?? 1;
    _physWinCache[player.id] = { key, winProb };
    return winProb;
  }

  // Returns true if the bot needs Cursed Rattle to beat the dragon.
  // Uses the same 0.55 threshold as dragonReady: if physical attacks can't reliably
  // win, acquire the rattle for the instant bard kill:1 instead.
  function needsCursedRattle(player) {
    return !hasItemAnywhere(player, 'cursed_rattle')
        && !hasItemAnywhere(player, 'boss_magic_flute')
        && getPhysWinProb(player) < 0.55;
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

  // Return nearest tile of the given shopType that may stock itemId.
  // Shops with confirmed stock are preferred; unknown stock is optimistic; confirmed-absent skipped.
  function nearestShopOfType(shopType, player, itemId) {
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
      const stock   = stocks[`${t.x},${t.y}`];
      const stockOk = !itemId || !stock ? 500 : stock[itemId] ? 1000 : 0;
      const score   = stockOk - Math.abs(t.x - px) - Math.abs(t.y - py);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // ── Primary attack strategy ──────────────────────────────────────────────────
  // Chosen once after setup roll from the highest base stat.
  // Used only for combat type selection and equipment slot priority.
  function getStrategy(player) {
    if (!botState[player.id]) botState[player.id] = {};
    if (!botState[player.id].strategy) {
      const s = player.baseStats;
      botState[player.id].strategy =
        ['F','D','M','C'].reduce((best, st) => s[st] > s[best] ? st : best, 'F');
    }
    return botState[player.id].strategy;
  }

  // ── Item helpers ─────────────────────────────────────────────────────────────
  function itemPower(item) {
    if (!item?.statBonus) return 0;
    return Math.max(...Object.values(item.statBonus).filter(v => v > 0), 0);
  }
  function equippedPower(player, slot) { return itemPower(player.equipped[slot]); }

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

  // ── Equipment optimisation step ──────────────────────────────────────────────
  // Returns { action:'equip', itemId } | { action:'unequip', slot } | null.
  function equipStep(player) {
    const slots = getEquipSlots(player);
    for (const slot of slots) {
      let bestId = null, bestPower = equippedPower(player, slot);
      for (const id of player.inventory) {
        const item = getItem(id);
        if (!item || item.slot !== slot) continue;
        const p = itemPower(item);
        if (p > bestPower) { bestPower = p; bestId = id; }
      }
      if (!bestId) continue;
      if (player.equipped[slot]) return { action:'unequip', slot };
      if (!player.canEquip(getItem(bestId))) {
        // At 5-slot cap: sacrifice the lowest-power equipped slot not in our priority list
        const keepSlots = new Set(slots);
        const allSlots  = ['strength','dexterity','magic','charisma','speed','armor','shield'];
        let sacrificeSlot = null, lowestPow = Infinity;
        for (const s of allSlots) {
          if (!player.equipped[s] || keepSlots.has(s)) continue;
          const p = itemPower(player.equipped[s]);
          if (p < lowestPow) { lowestPow = p; sacrificeSlot = s; }
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
  function findItemToBuy(player, available) {
    const coins = player.coins;
    if (!available) available = makeShopAvailableCheck();

    // Emergency heal — always highest priority
    if (player.hearts.current <= 2 && !player.hasItem('pot_heal')
        && coins >= 50 && available('pot_heal'))
      return 'pot_heal';

    const plan = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;

    // Cursed Rattle override: if physical attacks give < 40% win rate vs dragon,
    // buy it for the kill:1 bard mechanism. The advisor never recommends it because
    // it's a stat downgrade from accordion, but strategically it's the only path.
    if (needsCursedRattle(player) && coins >= 90 && available('cursed_rattle'))
      return 'cursed_rattle';

    // Near-dragon consumables: stock regardless of what the upgrade target is
    if (plan?.dragonReady) {
      const heals = player.inventory.filter(id => id === 'pot_heal').length;
      if (heals < 3 && coins >= 50 && available('pot_heal')) return 'pot_heal';
      if (!player.inventory.includes('pot_A3') && coins >= 30 && available('pot_A3')) return 'pot_A3';
      if (!player.inventory.includes('pot_V3') && coins >= 30 && available('pot_V3')) return 'pot_V3';
    }

    // Follow advisor: buy the recommended item if affordable and stocked here
    if (plan?.upgrade && plan.shortfall === 0) {
      const u = plan.upgrade;
      if ((u.type === 'regular' || u.type === 'guild')
          && !hasItemAnywhere(player, u.itemId)
          && coins >= u.cost && available(u.itemId))
        return u.itemId;
    }

    return null;
  }

  // ── Master action ────────────────────────────────────────────────────────────
  function findMasterAction(player) {
    const coins = player.coins;
    const plan  = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;

    // Follow advisor enchant recommendation (type === 'enchant', shopType === 'master')
    if (plan?.upgrade?.type === 'enchant' && plan.shortfall === 0) {
      const u       = plan.upgrade;
      const enchObj = ENCHANTMENTS.find(e => e.id === u.enchantId);
      const cost    = enchObj?.cost ?? 50;
      if (coins >= cost) return { type:'enchant', slot:u.slot, enchantId:u.enchantId, tier:1 };
    }

    // Buy skills: raise primary offensive stat first, then A and V (Master caps at 6)
    const strat = getStrategy(player);
    for (const stat of [strat, 'A', 'V']) {
      if (coins >= 50 && player.baseStats[stat] < 6)
        return { type:'buy_skill', stat };
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

    // PVP endgame: rush to FINISH if carrying princess
    if (player.hasPrincess) {
      const fp = findTilePos(TileType.FINISH)[0];
      if (fp) return { x:fp.x, y:fp.y, weight:120 };
    }

    // PVP active: head toward princess tile to pick it up
    if (state.pvpActive && !player.hasPrincess && state.princess) {
      return { x:state.princess.x, y:state.princess.y, weight:90 };
    }

    // Dragon ready: commit to the dragon fight — but only with enough hearts to survive.
    // Also attempt dragon if Cursed Rattle is unavailable everywhere (no other option).
    const noRattleSource = needsCursedRattle(player) && (() => {
      const stocks = state.shopStocks ?? {};
      return findTilePos(TileType.GUILD_ASSASSIN).every(t => {
        const s = stocks[`${t.x},${t.y}`];
        return s && !s['cursed_rattle'];
      });
    })();
    // Cursed Rattle = instant kill with 0 hearts lost, so safe at any HP.
    // Otherwise require ≥3 hearts to commit to the fight.
    const hasCursedRattle = player.hasEquipped?.('cursed_rattle');
    const minHeartsForDragon = hasCursedRattle ? 1 : 3;
    if ((plan?.dragonReady || noRattleSource) && player.hearts.current >= minHeartsForDragon) {
      const p = getBossTilePos('dragon');
      if (p) return { x:p.x, y:p.y, weight:90 };
    }

    // Cursed Rattle nav: head to guild_assassin only if the shop is known (or suspected) to stock it
    if (needsCursedRattle(player) && player.coins >= 90) {
      const stocks = state.shopStocks ?? {};
      const gaShops = findTilePos(TileType.GUILD_ASSASSIN);
      // Find a guild_assassin shop that hasn't confirmed "out of stock"
      const ga = gaShops.find(t => {
        const s = stocks[`${t.x},${t.y}`];
        return !s || s['cursed_rattle']; // unknown stock → optimistic; known stock → only if stocked
      });
      if (ga) return { x:ga.x, y:ga.y, weight:75 };
      // All known shops are out of Cursed Rattle → fall through to dragon fight anyway
    }

    // Upgrade affordable: navigate to the shop that sells it
    if (plan?.upgrade && plan.shortfall === 0) {
      const u = plan.upgrade;
      if (!hasItemAnywhere(player, u.itemId)) {
        const shopPos = nearestShopOfType(u.shopType, player, u.itemId);
        if (shopPos) return { x:shopPos.x, y:shopPos.y, weight:70 };
      }
    }

    // Chest run: freeway chest is the coin source when farming isn't viable
    if (plan?.chestRun?.recommended && plan.chestRun.nextChest) {
      const c = plan.chestRun.nextChest;
      return { x:c.x, y:c.y, weight:50 };
    }

    // No urgent directional target — scoring handles opportunistic movement
    return null;
  }

  // ── Tile scoring ─────────────────────────────────────────────────────────────
  function scoreTile(x, y, steps, player, state, plan) {
    const tType = MapGrid.get(x, y);
    let score = steps; // small tiebreaker: prefer tiles farther along the map

    const navTarget    = getNavTarget(player, plan);
    const navTargetKey = navTarget ? `${navTarget.x},${navTarget.y}` : null;
    const hasUrgentNav = !!(navTarget && navTargetKey && !state.reachableTiles?.has(navTargetKey));

    // On-path bonus: any tile that is closer to the nav target than the current position
    if (hasUrgentNav) {
      const navDist = getNavDist(navTarget.x, navTarget.y);
      const dHere   = navDist[`${x},${y}`]                                 ?? Infinity;
      const dPlayer = navDist[`${player.position.x},${player.position.y}`] ?? Infinity;
      if (dHere < dPlayer) score += navTarget.weight ?? 50;
    }
    // Direct hit on the target itself
    if (navTarget && x === navTarget.x && y === navTarget.y)
      score += (navTarget.weight ?? 50) * 2;

    const isBossNav   = !!(plan?.dragonReady);
    const isChestRun  = !isBossNav && (plan?.chestRun?.recommended ?? false);
    const isGuildFarm = !isBossNav && !isChestRun
                      && (plan?.canFarm ?? false)
                      && playerHasGuildItemToLevel(player);
    // Use the estimator's farming tier; fall back to stat heuristic so early-game bots
    // aren't locked to tier 0 before the NN weights are loaded.
    const farmingTier = plan != null ? (plan.farmingTier ?? 0) : maxSafeMiniTier(player);

    switch (tType) {

      case TileType.SHOP:
      case TileType.GUILD_ASSASSIN:
      case TileType.GUILD_THIEF: {
        const avail = id => {
          const stock = state.shopStocks?.[`${x},${y}`];
          return !stock || !!(stock[id]);
        };
        const wantsToBuy  = findItemToBuy(player, avail) !== null;
        const wantsToSell = findItemToSell(player) !== null;
        let s = 0;
        if (wantsToBuy)            s = Math.max(s, 700);
        if (wantsToSell)           s = Math.max(s, 400);
        if (player.coins > 200 && wantsToBuy) s = Math.max(s, 650);
        score += s;
        break;
      }

      case TileType.MASTER: {
        const action = findMasterAction(player);
        if (action) score += plan?.upgrade?.type === 'enchant' ? 700 : 500;
        else if (player.coins >= 50) score += 150;
        break;
      }

      case TileType.FIRE:
        score += player.hearts.current < player.hearts.max ? 400 : 50;
        break;

      case TileType.PRIEST: {
        const hasBlessing = player.inventory.some(id => id.startsWith('priest_pot_'))
                         || player.priestBuff > 0;
        score += (!player.hasUsedTile(x, y) && !hasBlessing) ? 240 : 0;
        break;
      }

      case TileType.BOSS: {
        const bossId = MapGrid.getTileData(x, y)?.bossId;
        if (!bossId) break;
        const rattleOk = player.hasEquipped?.('cursed_rattle');
        const heartOk  = rattleOk ? player.hearts.current >= 1 : player.hearts.current >= 3;
        if (bossId === 'dragon') score += (plan?.dragonReady && heartOk) ? 900 : -500;
        else                     score -= 350; // all other bosses: avoid
        break;
      }

      case TileType.MINIBOSS: {
        const mTier = MapGrid.getTileData(x, y)?.minibossTier ?? 0;
        if (player.hasUsedTile?.(x, y)) { score -= 500; break; }
        if (isChestRun)                  { score -= 600; break; }
        if (player.hearts.current <= 1)  { score -= 600; break; }

        if (isBossNav) {
          // Approaching dragon: skip all minibosses — the nav-path bonus on PATH tiles
          // already rewards forward progress; stopping for minibosses wastes turns.
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
            ? 300 + mTier * 100 : -200;
        } else {
          score -= 300;
        }
        break;
      }

      case TileType.RANDOM_EVENT:
        if (player.hasUsedTile(x, y))              score -= 60;
        else if (isChestRun || !(plan?.canFarm ?? true)) score -= 200;
        else score += player.hearts.current <= 1 ? -120 : 60;
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
        if (isChestRun) score += player.coins < 60 ? 280 : 150;
        else            score += player.coins < 60 ? 350 : player.coins < 200 ? 180 : 70;
        break;

      case TileType.REROLL:
        if (player.hasUsedTile?.(x, y)) { score += 20; break; }
        if (hasUrgentNav) {
          const navDist = getNavDist(navTarget.x, navTarget.y);
          const dPlayer = navDist[`${player.position.x},${player.position.y}`] ?? Infinity;
          const dHere   = navDist[`${x},${y}`]                                 ?? Infinity;
          score += dHere <= dPlayer ? 400 : 80;
        } else {
          score += 80;
        }
        break;

      case TileType.BAR:
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
  function handleShopTurn(player) {
    // 1. Equip anything better already in inventory
    const eq = equipStep(player);
    if (eq) {
      Game.submitAction(eq.action === 'equip'
        ? { type:'equip',   itemId:eq.itemId }
        : { type:'unequip', slot:  eq.slot   });
      return;
    }

    // 2. Sell clutter to free slots and raise coins
    const sellId = findItemToSell(player);
    if (sellId) { Game.submitAction({ type:'sell', itemId:sellId }); return; }

    // 3. Buy advisor's recommendation if this shop stocks it
    const available = makeShopAvailableCheck();
    const buyId = findItemToBuy(player, available);
    if (buyId) { Game.submitAction({ type:'buy', itemId:buyId }); return; }

    Game.submitAction({ type:'close' });
  }

  // ── Master handler ───────────────────────────────────────────────────────────
  function handleMasterTurn(player) {
    // Equip step first: weapon must be equipped before enchanting
    const eq = equipStep(player);
    if (eq) {
      Game.submitAction(eq.action === 'equip'
        ? { type:'equip',   itemId:eq.itemId }
        : { type:'unequip', slot:  eq.slot   });
      return;
    }

    const action = findMasterAction(player);
    if (action) { Game.submitAction(action); return; }

    Game.submitAction({ type:'close' });
  }

  // ── Teleport handler ─────────────────────────────────────────────────────────
  function handleTeleportTurn(player, state) {
    const dests = state.teleportDestinations ?? [];
    if (!dests.length) { Game.submitAction({ type:'close' }); return; }
    const plan = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;
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
      Game.submitAction({ type:'roll' });
      return;
    }

    if (phase === Game.Phase.MOVING) {
      const plan = (typeof UpgradeAdvisor !== 'undefined')
        ? UpgradeAdvisor.nextUpgrade(player) : null;
      Game.submitAction({ type:'move', dest: chooseMove(player, state, plan) });
      return;
    }

    if (phase === Game.Phase.COMBAT) {
      const combat = state.pendingCombat;
      if (!combat) return;
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

      // player_attack: use CombatNN for normal fights; rule-based for BOSS tiles
      // (CombatNN may try to bail at 1 heart — boss mobs regenerate fully on escape)
      const onBossTile = MapGrid.get(player.position.x, player.position.y) === TileType.BOSS;
      if (onBossTile) {
        Game.submitAction(chooseCombatAction(player, combat.mob));
      } else {
        Game.submitAction(CombatNN.chooseAction(player, combat.mob, combat.mobNextAttackType));
      }
      return;
    }

    if (phase === Game.Phase.SHOP)            { handleShopTurn(player);             return; }
    if (phase === Game.Phase.MASTER)          { handleMasterTurn(player);           return; }
    if (phase === Game.Phase.TELEPORT_CHOICE) { handleTeleportTurn(player, state);  return; }
    if (phase === Game.Phase.MAP_CHOICE)      { handleMapChoice();                   return; }

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
    const plan = (typeof UpgradeAdvisor !== 'undefined')
      ? UpgradeAdvisor.nextUpgrade(player) : null;
    if (plan?.dragonReady)            return 'dragon';
    if (plan?.shortfall === 0 && plan?.upgrade) return 'upgrade:' + (plan.upgrade.label ?? plan.upgrade.itemId ?? '?');
    if (plan?.canFarm)                return 'farming:tier' + (plan.farmingTier ?? 0);
    if (plan?.chestRun?.recommended)  return 'chest_run';
    return 'waiting';
  }

  return { chooseCombatAction, takeTurn, getPhase };
})();
