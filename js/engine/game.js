// Game state machine.
// The UI layer hooks into this via Game.on(event, handler) and drives it
// forward by calling Game.submitAction(action).

const Game = (() => {

  // ── Phase constants ───────────────────────────────────────────────────────
  const Phase = {
    SETUP:           'setup',
    SETUP_ROLL:      'setup_roll',
    ROLL_MOVE:       'roll_move',
    MOVING:          'moving',
    TILE_EVENT:      'tile_event',
    COMBAT:          'combat',
    PVP_COMBAT:      'pvp_combat',
    SHOP:            'shop',
    MASTER:          'master',
    CHEST:           'chest',
    PRIEST:          'priest',
    WORK:            'work',
    STOP_BLOCKED:    'stop_blocked',
    MAP_CHOICE:      'map_choice',
    LOOT_CONFIRM:    'loot_confirm',
    TELEPORT_CHOICE: 'teleport_choice',
    CLOAK_CHOICE:    'cloak_choice',
    KING_BATTLE:     'king_battle',
    GAME_OVER:       'game_over',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let state = {
    phase:            Phase.SETUP,
    players:          [],
    currentIdx:       0,
    setupRollIdx:     0,
    turnNumber:       0,
    round:            1,  // full table rotations (display); turnNumber counts single player turns
    difficulty:       'medium',
    movementCap:      0,
    reachableTiles:   null,   // Map<"x,y", steps> from Movement
    stopBlockedTiles: null,   // Set<"x,y"> tiles reachable only through an uncleared STOP
    princess:         { x: null, y: null, carriedBy: null },
    pvpActive:        false,
    dragonDefeated:   false,
    defeatedBosses:   new Set(),
    winner:           null,
    pendingCombat:        null,   // { mob, isBoss, isPvp }
    pendingPvp:           null,   // player-vs-player fight (see PVP section)
    pendingChest:         null,   // { tier }
    pendingPriest:        null,   // { buff }
    pendingLootDescription: null, // string shown in loot popup
    pendingLootCallback:    null, // fn called when loot popup is confirmed
    pendingHealItemId:      null, // itemId waiting for heal-target selection
    pendingCloakMob:        null, // mob stored for CLOAK_CHOICE phase
    pendingCloakTier:       null, // miniboss tier for that mob
    mapForcedRoll:          null, // 1-6 chosen by player when using Map item
    mapChoiceShown:         false,// prevents re-entry into MAP_CHOICE
    teleportReturnPhase:    null, // phase to restore if teleport is cancelled
    shopStocks:             {},   // keyed by "x,y" → { itemId: 1 } (0/missing = sold out)
    currentShopPosition:    null, // { x, y } of the shop tile the current player is visiting
    rerollUsedThisTurn:     new Set(), // "x,y" keys of reroll tiles already triggered this turn
    moveTrails:             {},   // player id → [{x,y}, …] tiles walked, oldest first (for BACK tiles)
    masterSmokeStock:       10,   // Smoke spell stock at the Master (resets every 15 turns)
    masterSmokeStockResetTurn: 0, // round when smoke stock was last reset
    masterCurseStock:       10,   // Curse spell stock at the Master (resets every 15 turns)
    masterCurseStockResetTurn: 0, // round when curse stock was last reset
  };

  // ── Event bus ─────────────────────────────────────────────────────────────
  const listeners = {};
  function on(event, fn)  { (listeners[event] = listeners[event] ?? []).push(fn); }
  function emit(event, data) { (listeners[event] ?? []).forEach(fn => fn(data)); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const STAT_NAMES = { F:'STR', D:'DEX', M:'MAG', C:'CHA' };

  function current() { return state.players[state.currentIdx]; }

  function nextTurn() {
    const prevIdx = state.currentIdx;
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    // Skip dead players
    let safety = state.players.length;
    while (!current().isAlive && safety-- > 0) {
      state.currentIdx = (state.currentIdx + 1) % state.players.length;
    }
    if (state.currentIdx <= prevIdx) state.round++;  // wrapped past the last seat
    state.turnNumber++;
    startTurn();
  }

  function log(msg) {
    emit('log', { message: msg, turn: state.turnNumber, player: current()?.name });
  }

  // Returns the Map-forced roll value (consuming it) or a fresh d6.
  function rollOrForced() {
    if (state.mapForcedRoll !== null) {
      const v = state.mapForcedRoll;
      state.mapForcedRoll = null;
      return v;
    }
    return Dice.d6();
  }

  // ── Loot delivery ─────────────────────────────────────────────────────────
  function grantLoot(player, loot) {
    player.coins += loot.coins ?? 0;
    for (const id of loot.items ?? []) {
      player.addItem(id);
    }
    for (const item of loot.equippedItems ?? []) {
      player.addItem(item.id);
    }
    emit('loot', { player: player.name, loot });
  }

  // ── Loot confirm phase ────────────────────────────────────────────────────
  function showLootConfirm(description, callback) {
    state.pendingLootDescription = description;
    state.pendingLootCallback    = callback ?? null; // null → endTileInteraction used
    state.phase = Phase.LOOT_CONFIRM;
    emit('state_change', { phase: state.phase, description });
  }

  function buildLootDescription(loot) {
    const parts = [];
    if (loot.coins) parts.push(`${loot.coins} coins`);
    const counts = {};
    for (const id of loot.items ?? []) counts[id] = (counts[id] ?? 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      const item = getItem(id);
      const name = item?.name ?? id;
      parts.push(n > 1 ? `${name} ×${n}` : name);
    }
    return parts.length ? parts.join(', ') : 'Nothing';
  }

  // ── Random helpers ────────────────────────────────────────────────────────
  function randomTierItem(minTier, maxTier) {
    const pool = EQUIPMENT.filter(i => i.tier >= minTier && i.tier <= maxTier);
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  function randomConsumable() {
    const pool = [...POTIONS, ...OBJECTS];
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  function zoneTierAt(px, py) {
    let bestDist = Infinity;
    let bestTier = 0;
    for (let y = 0; y < MapGrid.HEIGHT; y++) {
      for (let x = 0; x < MapGrid.WIDTH; x++) {
        if (MapGrid.get(x, y) === TileType.MINIBOSS) {
          const dist = Math.abs(x - px) + Math.abs(y - py);
          if (dist < bestDist) {
            bestDist = dist;
            bestTier = MapGrid.getTileData(x, y).minibossTier ?? 0;
          }
        }
      }
    }
    return bestTier;
  }

  // Build (once) and return the stock object for a shop tile.
  // Each entry is itemId → 1 (available). Buying sets it to 0 (sold out).
  function generateShopStock(x, y, guildType) {
    const key = `${x},${y}`;
    if (state.shopStocks[key]) return state.shopStocks[key];

    let items;
    let qty = 1;
    if (guildType === 'assassin') {
      items = SPECIAL_EQUIPMENT.filter(i => i.guild === 'assassin');
    } else if (guildType === 'thief') {
      items = SPECIAL_EQUIPMENT.filter(i => i.guild === 'thief');
    } else {
      const zone = zoneTierAt(x, y);
      let minTier, maxTier;
      if (zone <= 0)      { minTier = 1; maxTier = 3; qty = 3; }
      else if (zone === 1) { minTier = 2; maxTier = 4; }
      else                 { minTier = 5; maxTier = 6; }
      const equipment = EQUIPMENT.filter(i => i.tier >= minTier && i.tier <= maxTier);
      items = [...equipment, ...POTIONS, ...OBJECTS];
    }

    const potionIds = new Set([...POTIONS, ...COMBAT_SPELLS, ...UTILITY_SPELLS, ...OBJECTS].map(i => i.id));
    const stock = {};
    for (const item of items) stock[item.id] = potionIds.has(item.id) ? 10 : qty;
    state.shopStocks[key] = stock;
    return stock;
  }

  function calcInventoryWeight(player) {
    let w = 0;
    for (const slot of ALL_SLOTS) {
      const item = player.equipped[slot];
      if (!item) continue;
      const bonus = item.statBonus ?? {};
      const sw = Object.values(bonus).reduce((s, v) => s + Math.abs(v), 0);
      w += sw || 1;
    }
    for (const id of player.inventory) {
      const item = getItem(id);
      if (!item) { w += 1; continue; }
      if (item.slot) {
        const bonus = item.statBonus ?? {};
        const sw = Object.values(bonus).reduce((s, v) => s + Math.abs(v), 0);
        w += sw || 1;
      } else {
        w += 1; // consumables/potions/objects
      }
    }
    return Math.max(1, w);
  }

  function randomMobByTier(tier) {
    const pool = MOBS.getByTier(tier);
    // Exclude named bosses from random spawns
    const nonBoss = pool.filter(m => !m.isBoss);
    return nonBoss.length ? nonBoss[Math.floor(Math.random() * nonBoss.length)] : null;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function init(playerDefs, difficulty = 'medium') {
    // playerDefs: [{ id, name, isBot }]
    const starts = MapGrid.getPlayerStarts();
    state.players = playerDefs.map((def, i) => {
      const p = new Player(def);
      p.position = { ...(starts[i] ?? starts[0]) };
      p.baseStats = { F:0, D:0, A:0, M:0, C:0, V:0 };
      return p;
    });
    state.setupRollIdx = 0;
    state.currentIdx   = 0;
    state.turnNumber   = 0;
    state.round        = 1;
    state.difficulty   = difficulty;
    state.moveTrails   = {};
    state.masterSmokeStock          = 10;
    state.masterSmokeStockResetTurn = 0;
    state.masterCurseStock          = 10;
    state.masterCurseStockResetTurn = 0;
    state.phase = Phase.SETUP_ROLL;
    emit('state_change', { phase: state.phase, setupRollIdx: 0, player: state.players[0].name });
  }

  // ── Starting stat roll ────────────────────────────────────────────────────
  const STARTING_ITEM_POOL = () =>
    [...EQUIPMENT.filter(i => i.tier === 1), ...OBJECTS];

  // Roll 6 stats that sum exactly to `target` (each stat 1–6).
  // Distributes extras randomly among slots, then shuffles the assignment.
  function rollStatsForDifficulty(difficulty) {
    const TARGETS = { easy: 32, medium: 24, hard: 15 };
    const target  = TARGETS[difficulty] ?? 24;
    const vals    = [1, 1, 1, 1, 1, 1];
    let remaining = target - 6;
    while (remaining > 0) {
      // Pick uniformly from slots that still have room
      const available = vals.reduce((a, v, i) => { if (v < 6) a.push(i); return a; }, []);
      const idx = available[Math.floor(Math.random() * available.length)];
      vals[idx]++;
      remaining--;
    }
    // Fisher-Yates shuffle so stat identity (F/D/A/M/C/V) is random
    for (let i = 5; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    const keys   = ['F','D','A','M','C','V'];
    const result = {};
    keys.forEach((k, i) => { result[k] = vals[i]; });
    return result;
  }

  function handleSetupRoll() {
    const player = state.players[state.setupRollIdx];
    const rolled = rollStatsForDifficulty(state.difficulty);
    player.baseStats = rolled;

    const pool = STARTING_ITEM_POOL();
    const item = pool[Math.floor(Math.random() * pool.length)] ?? null;
    if (item) player.addItem(item.id);

    log(`${player.name} rolls: F${rolled.F} D${rolled.D} A${rolled.A} M${rolled.M} C${rolled.C} V${rolled.V}  item: ${item?.name ?? '—'}`);
    emit('setup_rolled', { player: player.name, stats: rolled, item });

    state.setupRollIdx++;
    if (state.setupRollIdx >= state.players.length) {
      // All players done — begin the game
      state.setupRollIdx = 0;
      state.currentIdx   = 0;
      state.turnNumber   = 0;
      state.round        = 1;
      startTurn();
    } else {
      const next = state.players[state.setupRollIdx];
      state.phase = Phase.SETUP_ROLL;
      emit('state_change', { phase: state.phase, setupRollIdx: state.setupRollIdx, player: next.name });
    }
  }

  // ── Turn start ────────────────────────────────────────────────────────────
  function startTurn() {
    const player = current();

    // Pick up princess if already standing on her tile when turn begins
    if (state.pvpActive && !state.princess.carriedBy) pickUpPrincess(player);

    state.rerollUsedThisTurn = new Set();
    state.phase = Phase.ROLL_MOVE;
    emit('state_change', { phase: state.phase, player: player.name });
  }

  // ── Submit action (called by UI / bot) ────────────────────────────────────
  function submitAction(action) {
    // PvP fight: both participants act (by playerId), simultaneously
    if (state.phase === Phase.PVP_COMBAT) {
      // The normal combat actions (from the combat panel) act for whichever participant the
      // fight is waiting on; bots/tools may also pass an explicit playerId.
      const who = action?.playerId ?? pvpAwaited();
      const p   = who ? playerById(who) : null;
      switch (action?.type) {
        case 'pvp_use_item': case 'use_item': handlePvpUseItem(who, action.itemId); break;
        case 'pvp_choose': handlePvpChoose(who, action.choice); break;
        case 'attack':     handlePvpChoose(who, { kind:'attack', attackType: action.attackType, spellId: action.spellId ?? null }); break;
        case 'run':        handlePvpChoose(who, { kind:'run' }); break;
        case 'bard':       handlePvpChoose(who, { kind:'charm' }); break;
        case 'bail': {
          const m = action.method
            ?? (p?.hasEquipped('stealth_shoes') ? 'stealth_shoes' : p?.hasItem('rope') ? 'rope' : 'sp_invisibility');
          handlePvpChoose(who, { kind: m === 'sp_invisibility' ? 'invisibility' : m === 'stealth_shoes' ? 'run' : 'rope' });
          break;
        }
        case 'pvp_defend': case 'defend': handlePvpDefend(who); break;
        case 'use_curse':  handlePvpCurse(who, action.stat); break;
      }
      return;
    }
    // use_item is available in most phases (not setup or game-over)
    if (action?.type === 'use_item' &&
        state.phase !== Phase.SETUP_ROLL && state.phase !== Phase.GAME_OVER) {
      handleUseItem(action.itemId);
      return;
    }
    // heal_target resolves a pending heal-target selection (no phase restriction)
    if (action?.type === 'heal_target' && state.pendingHealItemId) {
      handleHealTarget(action.target);
      return;
    }
    // Equip/unequip are available in any phase except combat and game-over
    if (action?.type === 'equip' &&
        state.phase !== Phase.COMBAT && state.phase !== Phase.PVP_COMBAT &&
        state.phase !== Phase.GAME_OVER) {
      handleEquip(action.itemId);
      return;
    }
    if (action?.type === 'unequip' &&
        state.phase !== Phase.COMBAT && state.phase !== Phase.PVP_COMBAT &&
        state.phase !== Phase.GAME_OVER) {
      handleUnequip(action.slot);
      return;
    }

    switch (state.phase) {

      case Phase.SETUP_ROLL:
        handleSetupRoll();
        break;

      case Phase.ROLL_MOVE:
        handleRollMove();
        break;

      case Phase.MOVING:
        if (action?.type === 'move') handleMove(action.dest);
        break;

      case Phase.COMBAT:
        if (action?.type === 'attack' || action?.type === 'bail' || action?.type === 'run' ||
            action?.type === 'bard'   || action?.type === 'defend') {
          handleCombatAction(action);
        } else if (action?.type === 'use_curse') {
          handleCurse(action.stat);
        } else if (action?.type === 'transmute') {
          handleTransmute(action.from, action.to);
        } else if (action?.type === 'charisma_outcome') {
          handleCharismaOutcome(action);
        } else if (action?.type === 'deploy_friend') {
          handleDeployFriend(action);
        } else if (action?.type === 'friend_round') {
          handleFriendRound();
        } else if (action?.type === 'friend_take_over') {
          handleFriendTakeOver();
        }
        break;

      case Phase.PVP_COMBAT:
        // PVP still uses legacy synchronous path for now
        break;

      case Phase.SHOP:
        if (action?.type === 'buy')       handleBuy(action.itemId);
        else if (action?.type === 'sell') handleSell(action.itemId);
        else if (action?.type === 'close') endTileInteraction();
        break;

      case Phase.MASTER:
        if (action?.type === 'buy_skill')   handleBuySkill(action.stat);
        else if (action?.type === 'enchant') handleEnchant(action.slot, action.enchantId, action.tier);
        else if (action?.type === 'buy')    handleBuy(action.itemId);
        else if (action?.type === 'close')  endTileInteraction();
        break;

      case Phase.PRIEST:
        handlePriestRoll();
        break;

      case Phase.MAP_CHOICE: {
        if (action?.type === 'map_roll') {
          const p = current();
          p.removeItem('map');
          state.mapForcedRoll = action.value;
          log(`${p.name} uses the Map — chose roll: ${action.value}`);
          emit('item_used', { player: p.name, item: getItem('map') });
        }
        resolveTileEvent();
        break;
      }

      case Phase.TELEPORT_CHOICE:
        if (action?.type === 'teleport_confirm') handleTeleport(action.dest);
        else if (action?.type === 'close') {
          state.phase = state.teleportReturnPhase ?? Phase.ROLL_MOVE;
          state.teleportReturnPhase = null;
          emit('state_change', { phase: state.phase, player: current().name });
        }
        break;

      case Phase.CLOAK_CHOICE: {
        const mob  = state.pendingCloakMob;
        const tier = state.pendingCloakTier;
        state.pendingCloakMob  = null;
        state.pendingCloakTier = null;
        if (action?.type === 'cloak_fight') {
          if (mob) startCombat(mob, false, null, tier);
          else endTileInteraction();
        } else if (action?.type === 'cloak_sneak') {
          const p = current();
          const how = p.hasEquipped('invis_cloak') ? 'Invisibility Cloak' : 'Invisibility Potion';
          if (!p.hasEquipped('invis_cloak')) p.invisPotion = Math.max(0, (p.invisPotion ?? 0) - 1);
          log(`${p.name} slips past ${mob?.name ?? 'the enemy'} unseen (${how}).`);
          endTileInteraction();
        }
        break;
      }

      case Phase.CHEST:
        if (action?.type === 'chest_pick') {
          state.pendingChestRolls = null;
          resolveChestRoll(current(), action.value);
        }
        break;

      case Phase.STOP_BLOCKED:
        nextTurn();
        break;

      case Phase.LOOT_CONFIRM: {
        const cb = state.pendingLootCallback ?? endTileInteraction;
        state.pendingLootCallback    = null;
        state.pendingLootDescription = null;
        cb();
        break;
      }
    }
  }

  // ── Roll movement ─────────────────────────────────────────────────────────
  function handleRollMove() {
    const player = current();
    state.movementCap    = Movement.rollCap(player);
    player.consumeTempBonus('V');
    state.reachableTiles  = Movement.getReachable(player.position, state.movementCap, player);
    state.stopBlockedTiles = Movement.getStopBlockedTiles(player.position, state.movementCap, player);
    state.phase = Phase.MOVING;
    emit('state_change', {
      phase: state.phase,
      player: player.name,
      cap: state.movementCap,
      reachable: state.reachableTiles,
    });
  }

  // ── Move ──────────────────────────────────────────────────────────────────
  // Append a walked segment to the player's trail. A jump (teleport, start)
  // breaks continuity, so the trail restarts from the segment's origin.
  const TRAIL_MAX = 40;
  function recordTrail(player, from, path) {
    let trail = state.moveTrails[player.id];
    const last = trail?.at(-1);
    if (!last || last.x !== from.x || last.y !== from.y) trail = [{ ...from }];
    for (const t of path) trail.push({ x: t.x, y: t.y });
    if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
    state.moveTrails[player.id] = trail;
  }

  // Tiles a BACK tile sends the player through, newest first, up to n steps.
  // During PvP, stops on the first tile held by another living player (forced fight).
  function goBackPath(player, n) {
    const trail = state.moveTrails[player.id] ?? [];
    const last  = trail.at(-1);
    if (!last || last.x !== player.position.x || last.y !== player.position.y) return [];
    const back = [];
    for (let i = trail.length - 2; i >= 0 && back.length < n; i--) {
      const t = trail[i];
      back.push({ ...t });
      if (state.pvpActive && state.players.some(q => q !== player && q.isAlive &&
          q.position.x === t.x && q.position.y === t.y)) break;
    }
    return back;
  }

  function handleMove(dest) {
    const player   = current();
    const destKey  = `${dest.x},${dest.y}`;
    if (!state.reachableTiles.has(destKey)) {
      emit('error', { message: 'Invalid destination' });
      return;
    }
    // The path actually walked (UI trail); computed before potions are spent
    const moveFrom = { ...player.position };
    const movePath = Movement.pathTo(player.position, dest, state.movementCap, player) ?? [{ ...dest }];
    // Destination only reachable by slipping past minibosses: one Invisibility Potion each
    const potionsUsed = player.invisPotion ? (state.reachableTiles.potionUse?.get(destKey) ?? 0) : 0;
    if (potionsUsed > 0) {
      player.invisPotion -= potionsUsed;
      log(`${player.name} slips past ${potionsUsed} miniboss${potionsUsed > 1 ? 'es' : ''} unseen (Invisibility Potion).`);
    }

    // If the destination (or path to it) passes through an uncleared STOP tile,
    // intercept: move player to the stop, roll, mark it used regardless of result.
    if (state.stopBlockedTiles?.has(destKey)) {
      const path     = Movement.pathTo(player.position, dest, state.movementCap, player);
      const stopTile = path?.find(t =>
        MapGrid.get(t.x, t.y) === TileType.STOP && !player.hasUsedTile(t.x, t.y)
      ) ?? null;

      if (stopTile) {
        player.position = { ...stopTile };
        player.markTileUsed(stopTile.x, stopTile.y);
        const upToStop = movePath.slice(0, movePath.findIndex(t => t.x === stopTile.x && t.y === stopTile.y) + 1);
        recordTrail(player, moveFrom, upToStop.length ? upToStop : [stopTile]);
        emit('player_moved', { player: player.name, position: stopTile, from: moveFrom, path: upToStop.length ? upToStop : [stopTile] });

        const roll = Dice.d6();
        log(`${player.name} hits Stop at (${stopTile.x},${stopTile.y}) — rolls ${roll}`);

        if (roll <= 3) {
          log(`${player.name} is stopped!`);
          endTileInteraction();
        } else {
          log(`${player.name} breaks free!`);
          if (stopTile.x !== dest.x || stopTile.y !== dest.y) {
            player.position = { ...dest };
            const afterStop = movePath.slice(movePath.findIndex(t => t.x === stopTile.x && t.y === stopTile.y) + 1);
            recordTrail(player, stopTile, afterStop.length ? afterStop : [dest]);
            emit('player_moved', { player: player.name, position: dest, from: { ...stopTile }, path: afterStop.length ? afterStop : [dest] });
          }
          if (maybeStartPvp(player)) return;
          if (state.pvpActive && !state.princess.carriedBy) pickUpPrincess(player);
          resolveTileEvent();
        }
        return;
      }
    }

    const tilesWalked = state.reachableTiles.get(destKey) ?? 0;
    player.position = { ...dest };
    log(`${player.name} → (${dest.x},${dest.y}) [roll ${state.movementCap}]`);
    recordTrail(player, moveFrom, movePath);
    emit('player_moved', { player: player.name, position: dest, from: moveFrom, path: movePath });
    player.gainXP('V', tilesWalked / 10);
    player.gainXP('A', Math.min(2, tilesWalked / calcInventoryWeight(player)));

    if (maybeStartPvp(player)) return;
    if (state.pvpActive && !state.princess.carriedBy) pickUpPrincess(player);

    resolveTileEvent();
  }

  // ── Tile event resolution ─────────────────────────────────────────────────
  function resolveTileEvent() {
    const player   = current();
    const { x, y } = player.position;
    const tType    = MapGrid.get(x, y);
    const tData    = MapGrid.getTileData(x, y);

    // Map item: pause before any roll-based tile event so player can choose the result
    const mapEligible = tType === TileType.CHEST || tType === TileType.RANDOM_EVENT ||
                        tType === TileType.PRIEST || tType === TileType.WORK ||
                        tType === TileType.MINIBOSS;
    if (mapEligible && !state.mapChoiceShown && player.hasItem('map')) {
      const alreadyCleared =
        (tType === TileType.CHEST || tType === TileType.RANDOM_EVENT || tType === TileType.MINIBOSS) &&
        player.hasUsedTile(x, y);
      if (!alreadyCleared) {
        state.mapChoiceShown = true;
        state.phase = Phase.MAP_CHOICE;
        emit('state_change', {
          phase: state.phase, player: player.name, tileType: tType,
          minibossTier: tData?.minibossTier ?? null,
        });
        return;
      }
    }
    state.mapChoiceShown = false;

    switch (tType) {

      case TileType.PATH:
        endTileInteraction();
        break;

      case TileType.RANDOM_EVENT:
        if (player.hasUsedTile(x, y)) { log(`${player.name}: this area has already been explored.`); endTileInteraction(); break; }
        player.markTileUsed(x, y);
        resolveRandomEvent(player);
        break;

      case TileType.MINIBOSS: {
        if (player.hasUsedTile(x, y)) { log(`${player.name}: the enemy here was already defeated.`); endTileInteraction(); break; }
        player.markTileUsed(x, y);
        const tier   = tData.minibossTier ?? 1;
        const pool   = MOBS.getByTier(tier).filter(m => !m.isBoss);
        const idx    = rollOrForced() - 1;
        const picked = pool[idx % pool.length] ?? null;
        const spawnedMob = picked ? MOBS.spawn(picked.id) : null;
        if ((player.hasEquipped('invis_cloak') || player.invisPotion) && spawnedMob) {
          state.pendingCloakMob  = spawnedMob;
          state.pendingCloakTier = tier;
          state.phase = Phase.CLOAK_CHOICE;
          emit('state_change', { phase: state.phase, player: player.name, mob: spawnedMob });
          break;
        }
        if (spawnedMob) startCombat(spawnedMob, false, null, tier);
        else endTileInteraction();
        break;
      }

      case TileType.CHEST:
        if (player.hasUsedTile(x, y)) { log(`${player.name}: the chest is already empty.`); endTileInteraction(); break; }
        player.markTileUsed(x, y);
        handleChestOpen();
        break;

      case TileType.REROLL: {
        const rerollKey = `${x},${y}`;
        if (state.rerollUsedThisTurn.has(rerollKey)) {
          log(`${player.name} lands on a reroll tile already used this turn — turn ends`);
          endTileInteraction();
          break;
        }
        state.rerollUsedThisTurn.add(rerollKey);
        const extra = Movement.rollCap(player);
        log(`${player.name} rerolls — gains ${extra} extra movement`);
        state.movementCap     = extra;
        state.reachableTiles  = Movement.getReachable(player.position, extra, player);
        state.stopBlockedTiles = Movement.getStopBlockedTiles(player.position, extra, player);
        state.phase = Phase.MOVING;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          cap: extra,
          reachable: state.reachableTiles,
        });
        break;
      }

      case TileType.WORK:
        handleWork();
        break;

      case TileType.STOP:
        // Already handled at turn start; arriving here just ends the turn
        endTileInteraction();
        break;

      case TileType.BACK: {
        const n = tData.backAmount ?? 1;
        // Retrace the tiles just walked; the landing tile's event fires
        const back = goBackPath(player, n);
        if (back.length) {
          const from = { ...player.position };
          const to   = back.at(-1);
          player.position = { ...to };
          const trail = state.moveTrails[player.id];
          trail.length -= back.length;
          log(`${player.name} goes back ${back.length} tile${back.length === 1 ? '' : 's'} → (${to.x},${to.y})`);
          emit('player_moved', { player: player.name, position: to, from, path: back });
          if (maybeStartPvp(player)) break;
          if (state.pvpActive && !state.princess.carriedBy) pickUpPrincess(player);
          resolveTileEvent();
          break;
        }
        log(`${player.name} would go back ${n} tiles, but has nowhere to go`);
        endTileInteraction();
        break;
      }

      case TileType.PRIEST:
        if (player.hasUsedTile(x, y)) { log(`${player.name}: the priest has already blessed you here.`); endTileInteraction(); break; }
        player.markTileUsed(x, y);
        state.phase = Phase.PRIEST;
        emit('state_change', { phase: state.phase, player: player.name });
        break;

      case TileType.SHOP: {
        player.refreshTiles();
        generateShopStock(x, y, null);
        state.currentShopPosition = { x, y };
        state.phase = Phase.SHOP;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          inventory: player.inventory,
          coins: player.coins,
        });
        break;
      }

      case TileType.MASTER:
        player.refreshTiles();
        state.currentShopPosition = null;
        state.phase = Phase.MASTER;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          inventory: player.inventory,
          coins: player.coins,
        });
        break;

      case TileType.BAR: {
        const barCost = 10;
        if (player.coins >= barCost && player.hearts.current < player.hearts.max) {
          player.coins -= barCost;
          player.healHeart(1);
          log(`${player.name}: bar −${barCost}g +1❤`);
          emit('coins_changed', { player: player.name, coins: player.coins, delta: -barCost });
        } else if (player.hearts.current >= player.hearts.max) {
          log(`${player.name} is already at full health`);
        } else {
          log(`${player.name} can't afford the bar (${barCost} coins)`);
        }
        endTileInteraction();
        break;
      }

      case TileType.FIRE:
        player.hearts.current = player.hearts.max;
        log(`${player.name}: fire — full health`);
        emit('healed', { player: player.name });
        endTileInteraction();
        break;

      case TileType.BOSS: {
        if (state.defeatedBosses.has(tData.bossId)) { log(`${player.name}: this boss has already been defeated.`); endTileInteraction(); break; }
        if (tData.bossId === 'king') {
          startKingBattle(player);
          break;
        }
        const mob = MOBS.spawn(tData.bossId);
        if (!mob) { endTileInteraction(); break; }
        startCombat(mob, true);
        break;
      }

      case TileType.GUILD_ASSASSIN:
      case TileType.GUILD_THIEF: {
        player.refreshTiles();
        const guildType = tType === TileType.GUILD_ASSASSIN ? 'assassin' : 'thief';
        generateShopStock(x, y, guildType);
        state.currentShopPosition = { x, y };
        state.phase = Phase.SHOP;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          guildType,
          inventory: player.inventory,
          coins: player.coins,
        });
        break;
      }

      case TileType.FINISH:
        if (state.pvpActive && player.hasPrincess) {
          state.winner = player;
          state.phase  = Phase.GAME_OVER;
          emit('game_over', { winner: player.name });
        } else {
          endTileInteraction();
        }
        break;

      default:
        endTileInteraction();
    }
  }

  // ── Generated mob (random encounter) ─────────────────────────────────────
  // Stat budget = difficulty base + zone×12, distributed weighted toward dominant stats.
  // Category determines animal name; max stat value sets the adjective.
  function generateRandomMob(zone, difficulty) {
    const STAT_BUDGET = { easy: 32, medium: 24, hard: 15 };
    const totalBudget = (STAT_BUDGET[difficulty] ?? 24) + zone * 12;

    const CATEGORIES = [
      { key: 'F',    animal: 'Bear'    },
      { key: 'D',    animal: 'Fox'     },
      { key: 'M',    animal: 'Owl'     },
      { key: 'C',    animal: 'Parrot'  },
      { key: 'FD',   animal: 'Wolf'    },
      { key: 'FM',   animal: 'Serpent' },
      { key: 'FC',   animal: 'Gorilla' },
      { key: 'DM',   animal: 'Hawk'    },
      { key: 'DC',   animal: 'Raven'   },
      { key: 'MC',   animal: 'Peacock' },
      { key: 'FDM',  animal: 'Wyvern'  },
      { key: 'FDC',  animal: 'Panther' },
      { key: 'FMC',  animal: 'Sphinx'  },
      { key: 'DMC',  animal: 'Harpy'   },
      { key: 'FDMC', animal: 'Chimera' },
    ];

    const cat      = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    const dominant = cat.key.split('');
    const ALL_STATS = ['F', 'D', 'A', 'M', 'C', 'V'];

    // Each stat starts at 1; distribute remaining budget weighted 3:1 (dominant:other)
    const statValues = { F: 1, D: 1, A: 1, M: 1, C: 1, V: 1 };
    let remaining = totalBudget - 6;
    while (remaining > 0) {
      const pool = [];
      for (const s of ALL_STATS) {
        const w = dominant.includes(s) ? 3 : 1;
        for (let i = 0; i < w; i++) pool.push(s);
      }
      statValues[pool[Math.floor(Math.random() * pool.length)]]++;
      remaining--;
    }

    const maxStat = Math.max(...Object.values(statValues));
    const adjective =
      maxStat >= 21 ? 'Savage'  :
      maxStat >= 17 ? 'Fierce'  :
      maxStat >= 13 ? 'Rabid'   :
      maxStat >= 9  ? 'Wild'    :
      maxStat >= 5  ? 'Weak'    : 'Feeble';

    // Loot: 1 equipment (tier 1–3), 1 random-stat potion (value 1–3), 2d6 coins
    const lootTable = [];
    const lootItem = randomTierItem(1, 3);
    if (lootItem) lootTable.push({ itemId: lootItem.id });
    lootTable.push({ rollForStat: true, potionValue: Math.ceil(Math.random() * 3) });

    const speciesId = cat.animal.toLowerCase();
    const gradeId   = adjective.toLowerCase();
    const hp = ['feeble','weak','wild'].includes(gradeId) ? 1 : 2;
    return {
      id: `${speciesId}_${gradeId}`,
      name: `${adjective} ${cat.animal}`,
      tier: zone,
      stats: statValues,
      hearts: { current: hp, max: hp },
      lootTable,
      coins: 0,
      coinDice: 2,
      statusEffects: [],
      isAnimal: true,
    };
  }

  // ── Random event (? tile) ─────────────────────────────────────────────────
  function resolveRandomEvent(player) {
    const roll = rollOrForced();
    const zone = zoneTierAt(player.position.x, player.position.y);
    if (roll <= 2) {
      // Generated mob scaled to zone + difficulty
      const mob = generateRandomMob(zone, state.difficulty);
      log(`${player.name} ? (${roll}) — ${mob.name} appears!`);
      player.gainXP('F', 1); player.gainXP('D', 1); player.gainXP('M', 1); player.gainXP('C', 1);
      startCombat(mob, false);
    } else if (roll === 3) {
      // Zone miniboss from catalog
      const template = randomMobByTier(zone);
      const mob = template ? MOBS.spawn(template.id) : generateRandomMob(zone, state.difficulty);
      log(`${player.name} ? (${roll}) — miniboss ${mob.name}!`);
      player.gainXP('F', 1); player.gainXP('D', 1); player.gainXP('M', 1); player.gainXP('C', 1);
      startCombat(mob, false);
    } else if (roll === 4) {
      // Find 3d6 coins
      let found = 0; for (let i = 0; i < 3; i++) found += Dice.d6();
      player.coins += found;
      log(`${player.name} ? (${roll}) — finds ${found}g`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: found });
      showLootConfirm(`Found ${found} coins!`);
    } else if (roll === 5) {
      // Find 5d6 coins
      let found = 0; for (let i = 0; i < 5; i++) found += Dice.d6();
      player.coins += found;
      log(`${player.name} ? (${roll}) — finds ${found}g`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: found });
      showLootConfirm(`Found ${found} coins!`);
    } else {
      // Find equipment; tier range [zone+1, zone+4] capped at 6
      const minTier = zone + 1;
      const maxTier = Math.min(zone + 4, 6);
      const item = randomTierItem(minTier, maxTier);
      if (item) {
        player.addItem(item.id);
        log(`${player.name} ? (${roll}) — finds: ${item.name}`);
        emit('item_found', { player: player.name, item });
        showLootConfirm(`Found: ${item.name}`);
      } else {
        endTileInteraction();
      }
    }
  }

  // ── Chest ─────────────────────────────────────────────────────────────────
  function resolveChestRoll(player, roll) {
    let desc;
    let chestCoins = 0, chestItemId = null;
    if (roll === 1) {
      log(`Chest is empty`);
      desc = 'The chest is empty.';
    } else if (roll === 2) {
      chestCoins = Dice.d6() * 3;
      player.coins += chestCoins;
      log(`${player.name} finds ${chestCoins} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: chestCoins });
      desc = `Found ${chestCoins} coins!`;
    } else if (roll === 3) {
      const item = randomConsumable();
      if (item) { chestItemId = item.id; player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    } else if (roll === 4) {
      chestCoins = Dice.d6() * 10;
      player.coins += chestCoins;
      log(`${player.name} finds ${chestCoins} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: chestCoins });
      desc = `Found ${chestCoins} coins!`;
    } else if (roll === 5) {
      const item = randomTierItem(1, 2);
      if (item) { chestItemId = item.id; player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    } else {
      const item = randomTierItem(3, 6);
      if (item) { chestItemId = item.id; player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    }
    emit('chest_opened', { player: player.name, isEmpty: roll === 1, coins: chestCoins, itemId: chestItemId });
    showLootConfirm(desc);
  }

  function handleChestOpen() {
    const player = current();
    player.gainXP('C', 1);
    const hadMapRoll = state.mapForcedRoll !== null;
    const roll1 = rollOrForced();

    if (player.hasEquipped('lucky_glove') && !hadMapRoll) {
      const roll2 = Dice.d6();
      log(`Lucky Glove: ${player.name} rolls ${roll1} and ${roll2}`);
      state.pendingChestRolls = [roll1, roll2];
      state.phase = Phase.CHEST;
      emit('state_change', { phase: Phase.CHEST, player: player.name, rolls: [roll1, roll2] });
    } else {
      resolveChestRoll(player, roll1);
    }
  }

  // ── Work ──────────────────────────────────────────────────────────────────
  function handleWork() {
    const player   = current();
    const { x, y } = player.position;

    // Check if already used
    if (player.hasUsedTile(x, y)) {
      log(`${player.name} has already worked at this tile`);
      showLootConfirm('You have already worked here this cycle.');
      return;
    }

    // Zone tier from x-coordinate (matches miniboss tier distribution on the map)
    const zoneTier = x < 21 ? 1 : x < 31 ? 2 : x < 41 ? 3 : 4;

    // Random base stat — no equipment bonus
    const statKeys = ['F','D','A','M','C','V'];
    const stat     = statKeys[Math.floor(Math.random() * 6)];
    const baseStat = Math.max(1, player.baseStats[stat] ?? 1);
    const diceRoll = rollOrForced();
    const earned   = zoneTier * diceRoll * baseStat;

    player.coins += earned;
    player.markTileUsed(x, y);
    log(`${player.name} works: +${earned}g (${stat}${baseStat}×${diceRoll}, zone ${zoneTier})`);
    emit('coins_changed', { player: player.name, coins: player.coins, delta: earned });
    showLootConfirm(`You earned ${earned} coins from work! (zone ${zoneTier} × ${stat}=${baseStat} × roll=${diceRoll})`);
  }

  // ── Priest ────────────────────────────────────────────────────────────────
  function handlePriestRoll() {
    const player = current();
    // Only one blessing at a time — no stacking
    const alreadyHas = player.inventory.some(id => id.startsWith('priest_pot_'))
                    || player.priestBuff > 0;
    if (alreadyHas) {
      log(`${player.name} is already carrying a blessing — can only hold one at a time.`);
      showLootConfirm(`You already carry a Holy Blessing. Use it before seeking another.`);
      return;
    }
    const roll   = rollOrForced();
    const itemId = `priest_pot_${roll}`;
    player.addItem(itemId);
    log(`${player.name}: Holy Blessing +${roll} (all stats, one roll)`);
    emit('priest_buff', { player: player.name, roll });
    showLootConfirm(`The priest blesses you: Holy Blessing +${roll}!\nUse it from inventory to apply +${roll} to ALL stats for your next roll.`);
  }

  // ── Shop ──────────────────────────────────────────────────────────────────
  function handleBuy(itemId) {
    const player = current();
    const item   = getItem(itemId);
    if (!item || !item.buyPrice) return;
    if (player.coins < item.buyPrice) {
      emit('error', { message: 'Not enough coins' });
      return;
    }
    // Smoke and Curse have limited stock at the Master (10 per 15 turns)
    const MASTER_LIMITED = {
      sp_smoke: { stockKey: 'masterSmokeStock', resetKey: 'masterSmokeStockResetTurn', name: 'Smoke' },
      sp_curse: { stockKey: 'masterCurseStock', resetKey: 'masterCurseStockResetTurn', name: 'Curse' },
    };
    if (MASTER_LIMITED[itemId] && !state.currentShopPosition) {
      const { stockKey, resetKey, name } = MASTER_LIMITED[itemId];
      if (state.round - state[resetKey] >= 15) {
        state[stockKey] = 10;
        state[resetKey] = state.round;
      }
      if (state[stockKey] <= 0) {
        emit('error', { message: `${name} is sold out — restocks every 15 turns` });
        return;
      }
      state[stockKey]--;
    }
    // Check shop stock — item must be available (stock >= 1)
    if (state.currentShopPosition) {
      const key   = `${state.currentShopPosition.x},${state.currentShopPosition.y}`;
      const stock = state.shopStocks[key];
      if (stock && !stock[itemId]) {
        emit('error', { message: 'Item sold out' });
        return;
      }
      if (stock) stock[itemId]--; // decrement stock
    }
    player.coins -= item.buyPrice;
    player.addItem(itemId);
    if (item.guild) player.initGuildItemLevel(itemId);
    log(`${player.name} buys ${item.name} for ${item.buyPrice} coins`);
    emit('shop_transaction', { player: player.name, type: 'buy', item, coins: player.coins });
  }

  function handleSell(itemId) {
    const player = current();
    const item   = getItem(itemId);
    if (!item) return;
    if (!player.hasItem(itemId) && !player.hasEquipped(itemId)) return;
    const price = player.hasEquipped('crowbar')
      ? Math.floor((item.buyPrice ?? 0) * 0.75)
      : sellPrice(item);
    if (!player.removeItem(itemId)) {
      // Item is equipped — unequip first, then remove from inventory
      const slot = Object.keys(player.equipped).find(s => player.equipped[s]?.id === itemId);
      if (!slot) return;
      player.unequip(slot);
      player.removeItem(itemId);
      emit('item_unequipped', { player: player.name, slot });
    }
    player.coins += price;
    player.gainXP('C', price / 50);
    if (item.guild) player.removeGuildItemLevel(item.id);
    log(`${player.name} sells ${item.name} for ${price} coins`);
    emit('shop_transaction', { player: player.name, type: 'sell', item, coins: player.coins });
  }

  // ── Equip / Unequip ───────────────────────────────────────────────────────
  function handleEquip(itemId) {
    const player = current();
    const item   = getItem(itemId);
    if (!item || !item.slot) { emit('error', { message: 'Item cannot be equipped' }); return; }
    if (!player.hasItem(itemId)) { emit('error', { message: 'Item not in inventory' }); return; }
    if (!player.equip(item)) {
      emit('error', { message: 'Slot taken or max equipment reached (5)' }); return;
    }
    log(`${player.name} equips ${item.name}`);
    emit('item_equipped', { player: player.name, item });
  }

  function handleUnequip(slot) {
    const player = current();
    const item   = player.equipped[slot];
    if (!item) { emit('error', { message: 'Nothing equipped in that slot' }); return; }
    player.unequip(slot);
    log(`${player.name} unequips ${item.name}`);
    emit('item_unequipped', { player: player.name, item, slot });
  }

  // ── Master — skill points ─────────────────────────────────────────────────
  function handleBuySkill(stat) {
    const player = current();
    if (player.masterSkillsBought >= 5) {
      emit('error', { message: 'Master skill purchase limit reached (5 total)' }); return;
    }
    const currentLv = player.baseStats[stat];
    const statMax = (stat === 'C' && player.hasEquipped('magic_flute_thief')) ? 8 : 6;
    if (currentLv >= statMax) { emit('error', { message: `Stat already at maximum (${statMax})` }); return; }
    const cost = 50;
    if (player.coins < cost) { emit('error', { message: 'Not enough coins' }); return; }
    player.coins -= cost;
    player.baseStats[stat]++;
    player.masterSkillsBought++;
    log(`${player.name} upgrades ${stat}→${player.baseStats[stat]} (${cost}g, ${player.masterSkillsBought}/5)`);
    emit('skill_upgraded', { player: player.name, stat, newValue: player.baseStats[stat] });
  }

  function handleEnchant(slot, enchantId, tier) {
    const player = current();
    const ench   = ENCHANTMENTS.find(e => e.id === enchantId);
    if (!ench) return;
    const cost = ench.cost ?? tier * 50;
    if (player.coins < cost) { emit('error', { message: 'Not enough coins' }); return; }
    if (!player.applyEnchantment(slot, ench, tier)) {
      emit('error', { message: 'Cannot enchant that slot' }); return;
    }
    player.coins -= cost;
    log(`${player.name} enchants ${slot} with ${ench.name} (tier ${tier})`);
    emit('enchanted', { player: player.name, slot, enchantment: ench, tier });
  }

  // ── Curse ─────────────────────────────────────────────────────────────────
  function handleCurse(stat) {
    if (!state.pendingCombat) return;
    if (state.pendingCombat.combatSubPhase !== 'player_attack') return;
    const player = current();
    if (!player.hasItem('sp_curse')) return;
    if (state.pendingCombat.curseUsedThisTurn) {
      log(`${player.name}: only one Curse per turn`); return;
    }
    const STAT_KEYS = ['F','D','A','M','C','V'];
    if (!STAT_KEYS.includes(stat)) return;

    const roll = Dice.d6();
    const mob  = state.pendingCombat.mob;
    mob.statusEffects = mob.statusEffects ?? [];
    mob.statusEffects.push({ type: 'malus', stat, value: -roll, turnsLeft: 4 });
    state.pendingCombat.curseUsedThisTurn = true;

    player.removeItem('sp_curse');
    const STAT_NAMES_LOCAL = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const msg = `${player.name} curses ${mob.name} — ${STAT_NAMES_LOCAL[stat]} −${roll} for 4 turns`;
    log(msg);
    emit('item_used', { player: player.name, item: getItem('sp_curse') });
    emit('combat_update', {
      player: player.name,
      mob,
      newLog: [msg],
      logType: 'curse',
      outcome: 'ongoing',
      combatSubPhase: 'player_attack',
    });
  }

  // ── Transmutation ─────────────────────────────────────────────────────────
  function handleTransmute(from, to) {
    const player = current();
    if (!player.hasItem('sp_transmutation')) return;
    player.removeItem('sp_transmutation');
    player.transmutation = { from, to };
    log(`${player.name} uses Transmutation: ${from} ↔ ${to} swapped for this fight`);
    emit('item_used', { player: player.name, item: getItem('sp_transmutation') });
    emit('combat_update', {
      player: player.name,
      mob: state.pendingCombat?.mob,
      newLog: [`Transmutation active: ${from} ↔ ${to}`],
      outcome: 'ongoing',
      combatSubPhase: state.pendingCombat?.combatSubPhase,
    });
  }

  // ── Teleport ───────────────────────────────────────────────────────────────
  function getTeleportDestinations() {
    const dests = [];
    for (let y = 0; y < MapGrid.HEIGHT; y++) {
      for (let x = 0; x < MapGrid.WIDTH; x++) {
        const t = MapGrid.get(x, y);
        if (t === TileType.SHOP || t === TileType.MASTER ||
            t === TileType.GUILD_ASSASSIN || t === TileType.GUILD_THIEF) {
          dests.push({ x, y, tileType: t });
        }
      }
    }
    return dests;
  }

  function handleTeleport(dest) {
    const player = current();
    player.removeItem('sp_teleport');
    player.position = { ...dest };
    state.teleportReturnPhase = null;
    log(`${player.name} teleports to (${dest.x}, ${dest.y})`);
    emit('item_used', { player: player.name, item: getItem('sp_teleport') });
    emit('player_moved', { player: player.name, position: dest });
    if (maybeStartPvp(player)) return;
    resolveTileEvent();
  }

  // ── Use item ──────────────────────────────────────────────────────────────
  function handleUseItem(itemId) {
    const player = current();
    const item   = getItem(itemId);
    if (!item || !player.hasItem(itemId)) return;

    const eff = item.effect;

    // ── Special string-effect utility spells ─────────────────────────────────

    if (eff === 'teleport') {
      if (state.phase === Phase.COMBAT || state.phase === Phase.PVP_COMBAT) {
        log(`${player.name}: cannot teleport during combat`); return;
      }
      if (player.hasPrincess) {
        log(`${player.name}: cannot teleport while carrying the princess`); return;
      }
      const dests = getTeleportDestinations();
      if (!dests.length) { log(`No teleport destinations available`); return; }
      state.teleportReturnPhase    = state.phase;
      state.teleportDestinations   = dests;
      state.phase = Phase.TELEPORT_CHOICE;
      emit('state_change', { phase: state.phase, player: player.name, destinations: dests });
      return; // item is removed when destination is confirmed
    }

    if (eff === 'immune_one_turn') {
      if (state.phase !== Phase.COMBAT && state.phase !== Phase.PVP_COMBAT) {
        log(`${player.name}: smoke can only be used during combat`); return;
      }
      player.isSmokeActive = true;
      log(`${player.name} uses Smoke — immune to the next mob attack!`);
      player.removeItem(itemId);
      emit('item_used', { player: player.name, item });
      // Emit combat_update so bots can continue
      emit('combat_update', {
        player: player.name,
        mob: state.pendingCombat?.mob,
        newLog: [`Smoke active — ${player.name} is immune to the next attack`],
        outcome: 'ongoing',
        combatSubPhase: state.pendingCombat?.combatSubPhase,
      });
      return;
    }

    if (eff === 'transmutation') {
      log(`${player.name}: use Transmutation from the combat menu`); return;
    }

    if (eff === 'curse') {
      log(`${player.name}: use Curse from the combat consumables menu`); return;
    }

    if (eff === 'skip_fight' || eff?.type === 'skip_fight') {
      // Invisibility Potion: like the cloak, for ONE uncleared miniboss (passed or landed on)
      if (state.phase !== Phase.ROLL_MOVE && state.phase !== Phase.MOVING) {
        log(`${player.name}: drink the Invisibility Potion before moving`); return;
      }
      if (player.hasEquipped('invis_cloak')) {
        log(`${player.name}: already invisible (Invisibility Cloak)`); return;
      }
      player.invisPotion = (player.invisPotion ?? 0) + 1;      // stacks: one miniboss per potion
      player.removeItem(itemId);
      log(`${player.name} drinks ${item.name} — ${player.invisPotion} miniboss${player.invisPotion > 1 ? 'es' : ''} won't see them`);
      emit('item_used', { player: player.name, item });
      if (state.phase === Phase.MOVING) {            // already rolled: widen the reachable tiles
        state.reachableTiles   = Movement.getReachable(player.position, state.movementCap, player);
        state.stopBlockedTiles = Movement.getStopBlockedTiles(player.position, state.movementCap, player);
        emit('state_change', { phase: state.phase, player: player.name, cap: state.movementCap, reachable: state.reachableTiles });
      }
      return;
    }

    // ── Standard effects ──────────────────────────────────────────────────────

    if (eff) {
      if (eff.type === 'heal') {
        const amount = eff.value ?? 1;
        // Ask who to heal if any companion is damaged
        const deployed = state.pendingCombat?.deployedFriend;
        const damagedFriends = [
          ...(deployed && deployed.hearts.current < deployed.hearts.max ? [deployed] : []),
          ...player.friendsList.filter(f => f.hearts.current < f.hearts.max),
        ];
        if (damagedFriends.length > 0) {
          state.pendingHealItemId = itemId;
          emit('heal_target_pending', {
            player: player.name,
            itemName: item.name,
            amount,
            playerHearts: { current: player.hearts.current, max: player.hearts.max },
            friends: damagedFriends.map(f => ({ uid: f.uid, name: f.name, current: f.hearts.current, max: f.hearts.max })),
          });
          return; // item not consumed yet — wait for heal_target action
        }
        player.healHeart(amount);
        log(`${player.name} uses ${item.name} — +${amount} ❤`);
      } else if (eff.type === 'all_stats') {
        // Priest blessing: +N to every stat for exactly one roll
        if (player.priestBuff > 0) {
          log(`${player.name}: a blessing is already active — wait for it to be consumed`); return;
        }
        player.priestBuff = eff.value ?? 1;
        log(`${player.name} uses ${item.name} — +${eff.value} to ALL stats for the next roll`);
      } else if (eff.stat) {
        // Stat potion: temporary bonus for one dice roll — one per stat
        if (player.hasTempBonus(eff.stat)) {
          log(`${player.name}: a ${eff.stat} bonus is already active — wait for it to be used`); return;
        }
        player.addTempBonus(eff.stat, eff.value ?? 1);
        log(`${player.name} uses ${item.name} — +${eff.value}${eff.stat} (next roll only)`);
      } else if (eff.type === 'alcohol') {
        // Alcohol: +C for next charisma roll, -malus to V for next speed roll — one per stat
        if (player.hasTempBonus('C') || player.hasTempBonus('V')) {
          log(`${player.name}: an alcohol effect is already active — wait for it to be used`); return;
        }
        const cBonus = eff.C ?? 1;
        const vMalus = eff.malus ?? 1;
        player.addTempBonus('C', cBonus);
        player.addTempBonus('V', -vMalus);
        log(`${player.name} drinks ${item.name} — +${cBonus}C but -${vMalus}V (next rolls)`);
      } else if (typeof eff === 'string') {
        log(`${player.name}: ${item.name} has no direct use here`); return;
      } else {
        // Object effect with no direct handler (escape, fast_travel, etc.) — don't consume
        log(`${player.name}: ${item.name} has no direct use here`); return;
      }
    }

    // Drops with statBonus (e.g. dragon_blood, werewolf_blood): last one full fight — one per stat
    if (item.statBonus) {
      const hasBlood = stat => player.statusEffects.some(e => e.type === 'drop_bonus' && e.stat === stat);
      const applied = [];
      for (const [stat, val] of Object.entries(item.statBonus)) {
        if (!hasBlood(stat)) {
          player.statusEffects.push({ type:'drop_bonus', stat, value: val, turnsLeft: 9999 });
          applied.push(`+${val}${stat}`);
        }
      }
      if (applied.length === 0) {
        log(`${player.name}: all stat bonuses from ${item.name} are already active`); return;
      }
      log(`${player.name} uses ${item.name} — ${applied.join(', ')} (this fight)`);
    }

    player.removeItem(itemId);
    emit('item_used', { player: player.name, item });
    // Re-drive combat UI / bot loop after a consumable is used mid-fight
    if (state.phase === Phase.COMBAT || state.phase === Phase.PVP_COMBAT) {
      const combat = state.pendingCombat;
      emit('combat_update', {
        player: player.name,
        mob:    combat?.mob,
        outcome: 'ongoing',
        subPhase: combat?.combatSubPhase,
      });
    }
  }

  // ── Heal target (companion picker) ───────────────────────────────────────
  function handleHealTarget(target) {
    const player = current();
    const itemId = state.pendingHealItemId;
    state.pendingHealItemId = null;
    if (!itemId) return;
    const item = getItem(itemId);
    if (!item || !player.hasItem(itemId)) return;
    const amount = item.effect?.value ?? 1;

    if (target === 'player') {
      player.healHeart(amount);
      log(`${player.name} uses ${item.name} — +${amount} ❤ (${player.hearts.current}/${player.hearts.max})`);
    } else {
      const deployed = state.pendingCombat?.deployedFriend;
      const friend   = (deployed?.uid === target)
        ? deployed
        : player.friendsList.find(f => f.uid === target);
      if (!friend) return;
      friend.hearts.current = Math.min(friend.hearts.current + amount, friend.hearts.max);
      log(`${player.name} uses ${item.name} on ${friend.name} — +${amount} ❤ (${friend.hearts.current}/${friend.hearts.max})`);
    }

    player.removeItem(itemId);
    emit('item_used', { player: player.name, item });
  }

  // ── Combat ────────────────────────────────────────────────────────────────
  // Pre-roll and announce the mob's next attack type. Call after pendingCombat is set.
  function prepareNextMobAttack(mob, fightLog) {
    const player = current();
    let atkType = Combat.rollMobAttack(mob);
    if (atkType === 'C' && player.hasEquipped('blowpipe')) {
      // Blowpipe: immune to charisma — mob picks a different attack type from F/D/M
      const candidates = ['F','D','M'].filter(s => mob.stats[s] > 0);
      if (candidates.length > 0) {
        const maxVal = Math.max(...candidates.map(s => mob.stats[s]));
        const tied = candidates.filter(s => mob.stats[s] === maxVal);
        atkType = tied[Math.floor(Math.random() * tied.length)];
      } else {
        atkType = 'F'; // fallback if all F/D/M are 0
      }
      fightLog.push(`${mob.name} cannot use Charisma — Blowpipe deflects it!`);
    }
    state.pendingCombat.mobNextAttackType = atkType;
    const msg = `${mob.name} prepares a ${STAT_NAMES[atkType] ?? atkType} attack!`;
    fightLog.push(msg);
    return { atkType, msg };
  }

  // ── Guild item leveling ───────────────────────────────────────────────────
  // mb-units needed to reach each level (index = currentLevel - 1) — non-charisma items
  const GUILD_MB_THRESHOLDS = [3, 6, 12, 24, 24];
  // Zone weights: tier 0→1, 1→2, 2→4, 3→8
  const ZONE_WEIGHT = [1, 2, 4, 8];
  // Charisma guild items (Magic Flute etc., Lv.1→8): mb-units per level, zone-weighted like the others.
  // Secondary = ability points (T1=2, T2=4, T3=6) × zone weight, need mbNeed × 6.
  const CHA_GUILD_MB_THRESHOLDS = [3, 6, 12, 24, 24, 36, 48];

  // Secondary (HP / parry / ability) threshold multiplier per slot category
  function guildSecMult(slot) {
    if (slot === 'charisma') return 6;
    if (slot === 'armor' || slot === 'shield') return 1;
    return 2; // strength, dexterity, magic, speed
  }

  // Called after winning a non-charisma miniboss fight.
  // Updates progress for all equipped non-charisma guild items.
  function applyMinibossProgress(player, combatData) {
    const { minibossTier, combatHpDealt, combatParries } = combatData;
    if (minibossTier == null) return;
    const zw = ZONE_WEIGHT[minibossTier] ?? 1;

    for (const slot of ALL_SLOTS) {
      if (slot === 'charisma') continue;
      const item = player.equipped[slot];
      if (!item?.guild) continue;

      const lvlData = player.guildItemLevels[item.id];
      if (!lvlData || lvlData.itemLevel >= 6) continue;

      const idx      = lvlData.itemLevel - 1;
      const mbNeed   = GUILD_MB_THRESHOLDS[idx];
      const secNeed  = mbNeed * guildSecMult(slot);

      lvlData.levelProgress.mbUnits += zw;
      if (slot === 'armor' || slot === 'shield') {
        lvlData.levelProgress.secondaryUnits += combatParries * zw;
      } else {
        lvlData.levelProgress.secondaryUnits += combatHpDealt * zw;
      }

      if (lvlData.levelProgress.mbUnits >= mbNeed &&
          lvlData.levelProgress.secondaryUnits >= secNeed) {
        lvlData.itemLevel++;
        lvlData.levelProgress = { mbUnits: 0, secondaryUnits: 0 };
        const stat = Object.keys(item.statBonus ?? {})[0] ?? '?';
        log(`${player.name}'s ${item.name} reaches Lv.${lvlData.itemLevel}! (+1 ${stat})`);
      }
    }
  }

  // Called after ending a miniboss encounter via a charisma ability.
  // Levels the equipped charisma guild item (max Lv.8). Zone-weighted like applyMinibossProgress:
  // mbUnits += zone weight, secondaryUnits += ability points × zone weight.
  function applyCharismaProgress(player, combatData) {
    const { minibossTier, combatAbilityUnits } = combatData;
    if (minibossTier == null) return;
    const zw = ZONE_WEIGHT[minibossTier] ?? 1;

    const item = player.equipped['charisma'];
    if (!item?.guild) return;

    const lvlData = player.guildItemLevels[item.id];
    if (!lvlData || lvlData.itemLevel >= 8) return;

    const idx     = lvlData.itemLevel - 1; // 0..6
    const mbNeed  = CHA_GUILD_MB_THRESHOLDS[idx];
    const secNeed = mbNeed * guildSecMult('charisma');

    lvlData.levelProgress.mbUnits        += zw;
    lvlData.levelProgress.secondaryUnits += combatAbilityUnits * zw;

    if (lvlData.levelProgress.mbUnits >= mbNeed &&
        lvlData.levelProgress.secondaryUnits >= secNeed) {
      lvlData.itemLevel++;
      lvlData.levelProgress = { mbUnits: 0, secondaryUnits: 0 };
      log(`${player.name}'s ${item.name} reaches Lv.${lvlData.itemLevel}! (+1 C)`);
    }
  }

  // ── Animal companion evolution ────────────────────────────────────────────
  const ANIMAL_GRADES    = ['feeble','weak','wild','rabid','fierce','savage'];
  const ANIMAL_KILL_REQS = [1, 1, 1, 2, 2]; // kills needed to advance from grade index 0..4

  // Called when a deployed animal friend wins a fight (kills the mob).
  // Heals it to full (unless Savage) and advances its grade when kill threshold is met.
  function tryEvolveAnimal(friend) {
    if (!friend.isAnimal) return;
    const parts    = friend.id.split('_');
    const grade    = parts[parts.length - 1];
    const species  = parts.slice(0, -1).join('_');
    const gradeIdx = ANIMAL_GRADES.indexOf(grade);

    if (gradeIdx < 0 || gradeIdx >= ANIMAL_GRADES.length - 1) return; // savage or unknown

    // Non-savage: always heal to full on a win
    friend.hearts.current = friend.hearts.max;

    friend.evolutionKills = (friend.evolutionKills ?? 0) + 1;
    const needed = ANIMAL_KILL_REQS[gradeIdx] ?? 1;

    if (friend.evolutionKills >= needed) {
      const nextGrade    = ANIMAL_GRADES[gradeIdx + 1];
      const nextId       = `${species}_${nextGrade}`;
      const nextTemplate = MOBS.getMob(nextId);
      if (!nextTemplate) return;
      const oldName          = friend.name;
      friend.id              = nextId;
      friend.name            = nextTemplate.name;
      friend.stats           = { ...nextTemplate.stats };
      friend.hearts          = { current: nextTemplate.hearts.max, max: nextTemplate.hearts.max };
      friend.evolutionKills  = 0;
      log(`${oldName} evolves into ${friend.name}! (fully healed)`);
    } else {
      log(`${friend.name} fully healed. (${friend.evolutionKills}/${needed} kills toward evolution)`);
    }
  }

  // ── King's Hall Battle ────────────────────────────────────────────────────

  function startKingBattle(player) {
    function onVictory() {
      const kingMob = MOBS.spawn('king');
      const loot    = Combat.resolveLoot(player, kingMob);
      grantLoot(player, loot);
      state.defeatedBosses.add('king');
      log(`${player.name} defeats the King! The hall is conquered.`);
      emit('combat_victory', { player: player.name, mob: 'King', loot });
      const lootDesc = buildLootDescription(loot);
      showLootConfirm(`King defeated! Loot: ${lootDesc}`, null);
    }

    function onDefeat() {
      log(`${player.name} is slain in the King's Hall.`);
      player.isAlive = false;
      if (player.hasPrincess) dropPrincess(player);   // she stays on the tile for the others
      emit('player_defeated', { player: player.name });
      checkGameOver();
      if (state.phase !== Phase.GAME_OVER) endTileInteraction();
    }

    KingBattle.init(player, onVictory, onDefeat);
    state.phase = Phase.KING_BATTLE;
    emit('state_change', { phase: state.phase, player: player.name });
  }

  function startCombat(mob, isBoss, onCompleteCallback, minibossTier = null) {
    if (!mob) { endTileInteraction(); return; }
    const player = current();
    const initResult = Combat.initFight(player, mob);

    if (initResult.outcome === 'victory') {
      // Kryss pre-fight kill still counts as a miniboss defeat
      if (minibossTier != null && !isBoss) {
        applyMinibossProgress(player, { minibossTier, combatHpDealt: 1, combatParries: 0 });
      }
      grantLoot(player, initResult.loot);
      emit('combat_victory', { player: player.name, mob: mob.name, loot: initResult.loot,
        mobTier: mob.tier ?? 0, isAnimal: mob.isAnimal ?? false, mapZone: zoneTierAt(player.position.x, player.position.y) });
      const lootDesc = buildLootDescription(initResult.loot);
      showLootConfirm(`${mob.name} defeated! Loot: ${lootDesc}`, onCompleteCallback ?? null);
      return;
    }

    const combatSubPhase = initResult.playerFirst ? 'player_attack' : 'mob_attack';
    state.pendingCombat = {
      mob,
      isBoss,
      onComplete:          onCompleteCallback ?? null,
      fightLog:            initResult.log,
      combatSubPhase,
      mobNextAttackType:   null,
      deployedFriend:      null,
      charismaResult:      null,
      minibossTier,
      combatHpDealt:       0,
      combatParries:       0,
      combatAbilityUnits:  0,
      fightAttackTypes:    new Set(),
      curseUsedThisTurn:   false,
    };
    if (!initResult.playerFirst) {
      prepareNextMobAttack(mob, initResult.log);
    }
    state.phase = Phase.COMBAT;
    emit('state_change', { phase: state.phase, player: player.name, mob, fightLog: initResult.log, combatSubPhase });
  }

  function handleCombatAction(action) {
    if (!state.pendingCombat) return;
    const player = current();
    const { mob, onComplete, fightLog } = state.pendingCombat;
    const subPhase = state.pendingCombat.combatSubPhase;

    let result;
    let skillUsed = null;
    if (subPhase === 'player_attack') {
      if (action.type !== 'attack' && action.type !== 'bail' && action.type !== 'run' && action.type !== 'bard') return;
      if (action.type === 'attack' && action.attackType) {
        state.pendingCombat.fightAttackTypes.add(action.attackType);
        skillUsed = action.attackType;
      } else if (action.type === 'bard') {
        state.pendingCombat.fightAttackTypes.add('C');
        skillUsed = 'C';
      }
      const prevMobHearts = mob.hearts.current;
      result = Combat.takePlayerAttack(player, mob, action, fightLog);
      if (state.pendingCombat?.minibossTier != null) {
        const hpDiff = prevMobHearts - mob.hearts.current;
        if (hpDiff > 0) state.pendingCombat.combatHpDealt += hpDiff;
      }
      if (result.outcome === 'charisma_pending') {
        state.pendingCombat.combatSubPhase = 'charisma_pick';
        state.pendingCombat.charismaResult = result.charismaResult;
        emit('combat_update', {
          player: player.name, mob,
          newLog: result.newLog ?? [],
          logType: 'bard',
          outcome: 'charisma_pending',
          combatSubPhase: 'charisma_pick',
          charismaResult: result.charismaResult,
          skillUsed,
        });
        return;
      }
      if (result.outcome === 'ongoing') {
        state.pendingCombat.combatSubPhase = 'mob_attack';
        const { msg } = prepareNextMobAttack(mob, fightLog);
        result.newLog.push(msg);
      }
    } else if (subPhase === 'charisma_pick' ||
               subPhase === 'friend_fighting' ||
               subPhase === 'friend_died') {
      return; // these subphases have their own dedicated handlers
    } else {
      if (action.type !== 'defend') return;
      const preRolledAtk = state.pendingCombat.mobNextAttackType;
      state.pendingCombat.mobNextAttackType = null;
      result = Combat.takeMobAttack(player, mob, fightLog, preRolledAtk);
      if (state.pendingCombat?.minibossTier != null && result.parried) {
        state.pendingCombat.combatParries++;
      }
      if (result.outcome === 'ongoing') {
        state.pendingCombat.combatSubPhase  = 'player_attack';
        state.pendingCombat.curseUsedThisTurn = false;
      }
      // Defense stat used: F→A, D→V, M→M (or A with Arcane), C→C
      const _defMap = { F: 'A', D: 'V', M: 'M', C: 'C' };
      skillUsed = (preRolledAtk === 'M' && player.hasEnchantment('arcane'))
        ? 'A'
        : (_defMap[preRolledAtk] ?? null);
    }

    if (result.coinsChanged) emit('coins_changed', { player: player.name, coins: player.coins });
    emit('combat_update', {
      player: player.name,
      mob,
      newLog: result.newLog ?? [],
      outcome: result.outcome,
      combatSubPhase: state.pendingCombat?.combatSubPhase,
      skillUsed,
    });

    if (result.outcome === 'ongoing') return;

    const savedCombat = state.pendingCombat;
    state.pendingCombat = null;

    if (result.outcome === 'victory') {
      if (savedCombat.minibossTier != null && !savedCombat.isBoss) {
        applyMinibossProgress(player, savedCombat);
        if (savedCombat.combatAbilityUnits > 0) applyCharismaProgress(player, savedCombat);
      }
      // Solo-type XP bonus: +3 if all player actions used exactly one stat (F, D, M or C)
      if (savedCombat.fightAttackTypes.size === 1) {
        const [soloType] = savedCombat.fightAttackTypes;
        if (['F','D','M','C'].includes(soloType)) {
          player.gainXP(soloType, 3);
          log(`${player.name} wins with pure ${soloType} — +3 ${soloType} XP!`);
        }
      }
      log(`${player.name} defeats ${mob.name}`);
      grantLoot(player, result.loot);
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot,
        mobTier: mob.tier ?? 0, isAnimal: mob.isAnimal ?? false, mapZone: zoneTierAt(player.position.x, player.position.y) });
      if (savedCombat.isBoss) state.defeatedBosses.add(mob.id);
      if (mob.id === 'dragon') {
        state.dragonDefeated = true;
        state.pvpActive      = true;
        state.princess       = { x: player.position.x, y: player.position.y, carriedBy: null };
        log(`The Dragon is slain! The Princess is free — PVP activated!`);
        emit('dragon_defeated', { position: state.princess });
      }
      const lootDesc = buildLootDescription(result.loot);
      showLootConfirm(`${mob.name} defeated! Loot: ${lootDesc}`, onComplete ?? null);
    } else if (result.outcome === 'escaped') {
      log(`${player.name} escapes from ${mob.name}`);
      endTileInteraction();
    } else {
      log(`${player.name} is defeated by ${mob.name}`);
      player.isAlive = false;
      if (player.hasPrincess) dropPrincess(player);   // she stays on the tile for the others
      emit('player_defeated', { player: player.name });
      checkGameOver();
      if (state.phase !== Phase.GAME_OVER) endTileInteraction();
    }
  }

  function handleCharismaOutcome(action) {
    if (!state.pendingCombat || state.pendingCombat.combatSubPhase !== 'charisma_pick') return;
    const player = current();
    const { mob, onComplete, fightLog } = state.pendingCombat;
    const charismaResult = state.pendingCombat.charismaResult;
    const newLog = [];

    if (action.retreat) {
      newLog.push(`${player.name} retreats!`);
      player.clearFightEffects(); mob.statusEffects = [];
      state.pendingCombat = null;
      emit('combat_update', { player: player.name, mob, newLog, logType: 'bard', outcome: 'escaped', combatSubPhase: null });
      log(`${player.name} retreats from ${mob.name}`);
      endTileInteraction();
      return;
    }

    // Reject options the roll did not unlock (UI and bots should never send these)
    const maxTier = Combat.charismaMaxTier(charismaResult?.diff ?? 0);
    const allowed = action.family === 'kill'
      ? (maxTier >= 3 && player.hasEquipped('cursed_rattle'))
      : (action.tier >= 1 && action.tier <= maxTier);
    if (!allowed) return;
    // Trade: the mob can only hand over something from its own loot, the player only something they own
    if (action.family === 'respect' && action.tier === 1) {
      if (action.mobItemId && !(charismaResult?.pendingLoot?.items ?? []).includes(action.mobItemId)) return;
      if (action.playerItemId && !player.hasItem(action.playerItemId)) return;
    }

    // Ability points for charisma guild items: T1=2, T2=4, T3=6 (zone weight applied on level-up check)
    if (state.pendingCombat?.minibossTier != null && action.tier) {
      const ABILITY_PTS = { 1: 2, 2: 4, 3: 6 };
      state.pendingCombat.combatAbilityUnits += ABILITY_PTS[action.family === 'kill' ? 3 : action.tier] ?? 0;
    }

    // C XP for the chosen option: +tier (on top of the per-roll XP, not limited by the per-fight cap)
    if (action.family && action.tier) {
      player.gainXP('C', action.family === 'kill' ? 3 : action.tier);
    }

    const result = Combat.applyCharismaOutcome(player, mob, action, charismaResult, newLog);
    fightLog.push(...newLog);

    if (result.coinsChanged) emit('coins_changed', { player: player.name, coins: player.coins });

    if (result.outcome === 'ongoing') {
      state.pendingCombat.combatSubPhase = 'mob_attack';
      state.pendingCombat.charismaResult = null;
      const { msg } = prepareNextMobAttack(mob, fightLog);
      newLog.push(msg);
      emit('combat_update', { player: player.name, mob, newLog, logType: 'bard', outcome: 'ongoing', combatSubPhase: 'mob_attack' });
      return;
    }

    const savedCombat = state.pendingCombat;
    state.pendingCombat = null;

    // Pure-charisma bonus: +3 C XP if the encounter was settled using only charisma
    const types = savedCombat.fightAttackTypes;
    if (types.size === 1 && types.has('C')) {
      player.gainXP('C', 3);
      log(`${player.name} settles the encounter with pure charisma — +3 C XP!`);
    }

    if (result.outcome === 'victory') {
      if (savedCombat.minibossTier != null && !savedCombat.isBoss) {
        applyMinibossProgress(player, savedCombat);
        applyCharismaProgress(player, savedCombat);
      }
      log(`${player.name} defeats ${mob.name}`);
      grantLoot(player, result.loot);
      emit('combat_update', { player: player.name, mob, newLog, logType: 'bard', outcome: 'victory' });
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot,
        mobTier: mob.tier ?? 0, isAnimal: mob.isAnimal ?? false, mapZone: zoneTierAt(player.position.x, player.position.y) });
      if (savedCombat.isBoss) state.defeatedBosses.add(mob.id);
      if (mob.id === 'dragon') {
        state.dragonDefeated = true;
        state.pvpActive      = true;
        state.princess       = { x: player.position.x, y: player.position.y, carriedBy: null };
        log(`The Dragon is slain! The Princess is free — PVP activated!`);
        emit('dragon_defeated', { position: state.princess });
      }
      const lootDesc = buildLootDescription(result.loot);
      showLootConfirm(`${mob.name} defeated! Loot: ${lootDesc}`, onComplete ?? null);
    } else if (result.outcome === 'befriended') {
      if (savedCombat.minibossTier != null && !savedCombat.isBoss) {
        applyCharismaProgress(player, savedCombat);
      }
      log(`${player.name} befriends ${mob.name}`);
      emit('combat_update', { player: player.name, mob, newLog, logType: 'bard', outcome: 'befriended' });
      endTileInteraction();
    } else if (result.outcome === 'charisma_end') {
      if (savedCombat.minibossTier != null && !savedCombat.isBoss) {
        applyCharismaProgress(player, savedCombat);
      }
      emit('combat_update', { player: player.name, mob, newLog, logType: 'bard', outcome: 'charisma_end' });
      const cDesc = newLog.length ? (typeof newLog[newLog.length - 1] === 'object' ? newLog[newLog.length - 1].text : newLog[newLog.length - 1]) : '';
      log(`${player.name} ends encounter with ${mob.name}${cDesc ? ' — ' + cDesc : ''}`);
      endTileInteraction();
    }
  }

  // ── Friend deployment ─────────────────────────────────────────────────────

  function handleDeployFriend(action) {
    if (!state.pendingCombat) return;
    const sub = state.pendingCombat.combatSubPhase;
    if (sub !== 'player_attack' && sub !== 'friend_died') return;
    const player = current();
    const idx = player.friendsList.findIndex(f => f.uid === action.uid);
    if (idx === -1) return;

    const [friend] = player.friendsList.splice(idx, 1);
    state.pendingCombat.deployedFriend = friend;
    state.pendingCombat.combatSubPhase = 'friend_fighting';

    const msg = `${player.name} deploys ${friend.name}! (❤ ${friend.hearts.current}/${friend.hearts.max})`;
    state.pendingCombat.fightLog.push(msg);
    emit('combat_update', {
      player: player.name, mob: state.pendingCombat.mob,
      newLog: [msg], outcome: 'ongoing',
      combatSubPhase: 'friend_fighting',
      deployedFriend: friend,
    });
  }

  function handleFriendRound() {
    if (!state.pendingCombat || state.pendingCombat.combatSubPhase !== 'friend_fighting') return;
    const player = current();
    const { mob, fightLog, deployedFriend, onComplete } = state.pendingCombat;

    const result = Combat.resolveFriendRound(deployedFriend, mob, player, fightLog);

    if (result.outcome === 'victory') {
      tryEvolveAnimal(deployedFriend);
      player.friendsList.push({ ...deployedFriend });
      const savedCombat = state.pendingCombat;
      state.pendingCombat = null;
      if (savedCombat.minibossTier != null && !savedCombat.isBoss) {
        applyMinibossProgress(player, savedCombat);
      }
      log(`${deployedFriend.name} defeats ${mob.name} for ${player.name}`);
      grantLoot(player, result.loot);
      emit('combat_update', { player: player.name, mob, newLog: result.newLog, outcome: 'victory' });
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot,
        mobTier: mob.tier ?? 0, isAnimal: mob.isAnimal ?? false, mapZone: zoneTierAt(player.position.x, player.position.y) });
      if (savedCombat.isBoss) state.defeatedBosses.add(mob.id);
      if (mob.id === 'dragon') {
        state.dragonDefeated = true;
        state.pvpActive = true;
        state.princess = { x: player.position.x, y: player.position.y, carriedBy: null };
        log(`The Dragon is slain! The Princess is free — PVP activated!`);
        emit('dragon_defeated', { position: state.princess });
      }
      showLootConfirm(`${mob.name} defeated! Loot: ${buildLootDescription(result.loot)}`, onComplete ?? null);
      return;
    }

    if (result.outcome === 'friend_died') {
      state.pendingCombat.deployedFriend = null;
      state.pendingCombat.combatSubPhase = 'friend_died';
      emit('combat_update', {
        player: player.name, mob,
        newLog: result.newLog, outcome: 'ongoing',
        combatSubPhase: 'friend_died',
      });
      return;
    }

    emit('combat_update', {
      player: player.name, mob,
      newLog: result.newLog, outcome: 'ongoing',
      combatSubPhase: 'friend_fighting',
      deployedFriend,
    });
  }

  function handleFriendTakeOver() {
    if (!state.pendingCombat || state.pendingCombat.combatSubPhase !== 'friend_died') return;
    const player = current();
    const { mob, fightLog } = state.pendingCombat;
    const msg = `${player.name} steps back into the fight!`;
    fightLog.push(msg);
    state.pendingCombat.combatSubPhase = 'player_attack';
    emit('combat_update', {
      player: player.name, mob,
      newLog: [msg], outcome: 'ongoing',
      combatSubPhase: 'player_attack',
    });
  }

  // Legacy — kept for PVP path (panels.js runPvpCombat still uses it)
  function resolveCombatResult(result) {
    const player = current();
    const { mob, onComplete } = state.pendingCombat ?? {};
    state.pendingCombat = null;
    if (result.outcome === 'victory') {
      grantLoot(player, result.loot);
      emit('combat_victory', { player: player.name, mob: mob?.name, loot: result.loot });
      const lootDesc = buildLootDescription(result.loot ?? {});
      showLootConfirm(`${mob?.name ?? 'Enemy'} defeated! Loot: ${lootDesc}`, onComplete ?? null);
    } else if (result.outcome === 'escaped') {
      endTileInteraction();
    } else {
      player.isAlive = false;
      if (player.hasPrincess) dropPrincess(player);   // she stays on the tile for the others
      emit('player_defeated', { player: player.name });
      checkGameOver();
      if (state.phase !== Phase.GAME_OVER) endTileInteraction();
    }
  }

  // ── PVP combat ────────────────────────────────────────────────────────────
  const PVP_DEF = { F:'A', D:'V', M:'M' };

  function playerById(id) { return state.players.find(p => p.id === id); }

  function maybeStartPvp(mover) {
    if (!state.pvpActive || !mover.isAlive) return false;
    const other = state.players.find(q => q !== mover && q.isAlive &&
      q.position.x === mover.position.x && q.position.y === mover.position.y);
    if (!other) return false;
    startPvpCombat(mover, other);
    return true;
  }

  function startPvpCombat(attacker, defender) {
    if (!state.pvpActive) return;
    state.pendingPvp = {
      ids: [attacker.id, defender.id], attackerId: attacker.id,
      round: 1, active: null, step: 'act', pendingAttack: null,
      chained: {}, smoke: {}, fire: {}, log: [], logSent: 0, curseUsed: false,
    };
    for (const p of [attacker, defender]) { p.clearFightEffects(); p.chainedTurns = 0; }
    log(`⚔ ${attacker.name} attacks ${defender.name}!`);
    // Kryss strikes before the fight starts
    for (const [a, d] of [[attacker, defender], [defender, attacker]]) {
      if (a.hasEquipped('kryss')) { d.hearts.current = Math.max(0, d.hearts.current - 1); pvpLog(`Kryss: ${a.name} strikes first — ${d.name} ❤ ${d.hearts.current}`); }
    }
    // initiative
    let ra, rd;
    do { ra = attacker.getStat('V') + Dice.d6(); rd = defender.getStat('V') + Dice.d6(); } while (ra === rd);
    state.pendingPvp.active = ra > rd ? attacker.id : defender.id;
    pvpLog(`Initiative: ${attacker.name} ${ra} vs ${defender.name} ${rd} → ${playerById(state.pendingPvp.active).name} goes first`);
    state.phase = Phase.PVP_COMBAT;
    state.pendingPvp.logSent = state.pendingPvp.log.length;   // the panel shows these lines when it opens
    emit('state_change', { phase: state.phase, player: attacker.name, attacker: attacker.name, defender: defender.name, pvp: pvpView() });
    if (pvpCheckDeaths()) return;
    beginPvpAct();
  }

  function pvpLog(msg) { state.pendingPvp?.log.push(msg); log(msg); }

  function pvpAwaited() {
    const pv = state.pendingPvp; if (!pv) return null;
    return pv.step === 'act' ? pv.active : pvpOpponent(pv.active).id;
  }

  function pvpView() {
    const pv = state.pendingPvp; if (!pv) return null;
    const awaited = pvpAwaited();
    return {
      round: pv.round, attackerId: pv.attackerId, activeId: pv.active, step: pv.step,
      pendingAttack: pv.pendingAttack ? { attackType: pv.pendingAttack.attackType, spellId: pv.pendingAttack.spellId ?? null } : null,
      players: pv.ids.map(id => { const p = playerById(id); return {
        id, name: p.name, isBot: p.isBot, hearts: { ...p.hearts }, chained: !!pv.chained[id],
        smoke: !!pv.smoke[id], active: pv.active === id }; }),
      waitingFor: awaited ? [awaited] : [],
      log: pv.log.slice(-14),
    };
  }
  function emitPvp(outcome, extra = {}) {
    const pv = state.pendingPvp;
    const view = pvpView();
    emit('pvp_update', { outcome, ...view, ...extra });
    // the regular combat panel listens to combat_update: send only the new log lines
    const newLog = pv ? pv.log.slice(pv.logSent) : [];
    if (pv) pv.logSent = pv.log.length;
    emit('combat_update', { pvp: true, outcome, newLog, pvpView: view, ...extra,
                            player: current()?.name, combatSubPhase: 'pvp' });
  }

  function pvpOpponent(id) { const pv = state.pendingPvp; return playerById(pv.ids.find(x => x !== id)); }

  // Start of the active player's action: Flame burns first
  function beginPvpAct() {
    const pv = state.pendingPvp;
    pv.step = 'act'; pv.pendingAttack = null; pv.curseUsed = false;
    const p = playerById(pv.active);
    if (pv.fire[p.id]) {
      p.hearts.current = Math.max(0, p.hearts.current - pv.fire[p.id]);
      pvpLog(`${p.name} burns (−${pv.fire[p.id]}) ❤ ${p.hearts.current}`);
      pv.fire[p.id] = 0;
      if (pvpCheckDeaths()) return;
    }
    emitPvp('ongoing');
  }

  function handlePvpUseItem(playerId, itemId) {
    const pv = state.pendingPvp; if (!pv || pvpAwaited() !== playerId) return;
    const p = playerById(playerId), opp = pvpOpponent(playerId);
    const item = getItem(itemId);
    if (!item || !p.hasItem(itemId)) return;
    const eff = item.effect;
    const defending = pv.step === 'defend';
    if (itemId === 'chain') {
      if (defending || pv.chained[opp.id]) return;
      pv.chained[opp.id] = true; opp.chainedTurns = 99;
      p.removeItem(itemId); pvpLog(`${p.name} chains ${opp.name} — no escape!`);
    } else if (eff === 'immune_one_turn') {
      if (!defending || pv.smoke[playerId]) return;          // smoke answers an incoming attack
      pv.smoke[playerId] = true; p.removeItem(itemId); pvpLog(`${p.name} vanishes in smoke!`);
    } else if (eff?.type === 'heal') {
      if (p.hearts.current >= p.hearts.max) return;
      p.healHeart(eff.value ?? 1); p.removeItem(itemId); pvpLog(`${p.name} drinks ${item.name} — ❤ ${p.hearts.current}`);
    } else if (eff?.stat && /^pot_/.test(itemId)) {
      if (p.hasTempBonus(eff.stat)) return;
      p.addTempBonus(eff.stat, eff.value); p.removeItem(itemId); pvpLog(`${p.name} drinks ${item.name}`);
    } else if (item.statBonus && !item.slot) {                      // blood drops: bonus for this fight
      for (const [st, v] of Object.entries(item.statBonus)) p.statusEffects.push({ type:'drop_bonus', stat: st, value: v, turnsLeft: 9999 });
      p.removeItem(itemId); pvpLog(`${p.name} drinks ${item.name}`);
    } else {
      return;                                                      // not usable in PvP
    }
    emit('item_used', { player: p.name, item });
    emitPvp('ongoing');
  }

  function handlePvpCurse(playerId, stat) {
    const pv = state.pendingPvp; if (!pv || pv.step !== 'act' || pv.active !== playerId) return;
    const p = playerById(playerId), opp = pvpOpponent(playerId);
    if (!p.hasItem('sp_curse') || pv.curseUsed || !['F','D','A','M','C','V'].includes(stat)) return;
    const roll = Dice.d6();
    opp.statusEffects.push({ type: 'malus', stat, value: -roll, turnsLeft: 4 });
    p.removeItem('sp_curse'); pv.curseUsed = true;
    pvpLog(`${p.name} curses ${opp.name} — ${stat} −${roll} for 4 turns`);
    emit('item_used', { player: p.name, item: getItem('sp_curse') });
    emitPvp('ongoing');
  }

  function pvpCanChoose(p, choice) {
    const pv = state.pendingPvp;
    const escape = ['run','rope','invisibility','charm'].includes(choice?.kind);
    if (escape && pv.chained[p.id]) return false;
    switch (choice?.kind) {
      case 'attack':
        if (!['F','D','M'].includes(choice.attackType)) return false;
        if (choice.attackType === 'M' && !p.canAttackMagic()) return false;
        if (choice.spellId && (!p.hasItem(choice.spellId) || getItem(choice.spellId)?.subtype !== 'attack')) return false;
        return true;
      case 'run': case 'charm': return true;
      case 'rope':         return p.hasItem('rope');
      case 'invisibility': return p.hasItem('sp_invisibility');
    }
    return false;
  }

  function handlePvpChoose(playerId, choice) {
    const pv = state.pendingPvp; if (!pv || pv.step !== 'act' || pv.active !== playerId) return;
    const p = playerById(playerId), o = pvpOpponent(playerId);
    if (!pvpCanChoose(p, choice)) { log(`${p.name}: invalid PvP choice`); return; }
    if (choice.kind !== 'attack') {
      let ok = false;
      if (choice.kind === 'rope')              { p.removeItem('rope'); ok = true; }
      else if (choice.kind === 'invisibility') { p.removeItem('sp_invisibility'); ok = true; }
      else if (choice.kind === 'run') {
        if (p.hasEquipped('stealth_shoes')) ok = true;
        else { const r1 = p.getStat('V') + Dice.d6(), r2 = o.getStat('V') + Dice.d6(); p.consumeTempBonus('V'); o.consumeTempBonus('V'); ok = r1 > r2;
               pvpLog(`${p.name} runs: V ${r1} vs ${r2}`); }
      } else if (choice.kind === 'charm') {
        const r1 = p.getStat('C') + Dice.d6(), r2 = o.getStat('C') + Dice.d6(); p.consumeTempBonus('C'); o.consumeTempBonus('C'); ok = r1 > r2;
        pvpLog(`${p.name} tries to talk their way out: C ${r1} vs ${r2}`);
      }
      if (ok) { pvpLog(`${p.name} escapes from ${o.name}!`); return endPvp('escaped', { escaped: p.name }); }
      pvpLog(`${p.name} fails to escape`);
      return passPvpTurn();
    }
    // attack: announce it, the defender answers
    pv.pendingAttack = { attackType: choice.attackType, spellId: choice.spellId ?? null };
    pv.step = 'defend';
    pvpLog(`${p.name} attacks with ${STAT_NAMES[choice.attackType] ?? choice.attackType}${choice.spellId ? ' + ' + getItem(choice.spellId).name : ''}!`);
    emitPvp('ongoing');
  }

  function handlePvpDefend(playerId) {
    const pv = state.pendingPvp; if (!pv || pv.step !== 'defend' || pvpAwaited() !== playerId) return;
    const a = playerById(pv.active), d = playerById(playerId);
    const { attackType: t, spellId } = pv.pendingAttack;
    let atk = a.getStat(t) + Dice.d6();
    a.consumeTempBonus(t);
    if (spellId && a.hasItem(spellId)) {
      const sp = getItem(spellId);
      atk += (sp.magicValue ?? 0) * (a.hasEquipped('dark_tome') ? 2 : 1);
      a.removeItem(spellId);
    }
    const ds = t === 'M' && d.hasEnchantment('arcane') ? 'A' : PVP_DEF[t];
    const def = d.getDefenseStat(t) + Dice.d6();
    d.consumeTempBonus(ds);
    if (atk <= def) pvpLog(`${a.name} ${t} ${atk} vs ${def} — blocked`);
    else if (pv.smoke[d.id]) pvpLog(`${a.name} ${t} ${atk} vs ${def} — lost in the smoke`);
    else if (a.hasEquipped('garrote') && t === 'F' && d.hearts.current <= 2) { d.hearts.current = 0; pvpLog(`${a.name} garrotes ${d.name}!`); }
    else if (d.hasEnchantment('thorns') && Math.random() < 0.3) {
      a.hearts.current = Math.max(0, a.hearts.current - 1); pvpLog(`${a.name} hits — thorns reflect it! ${a.name} ❤ ${a.hearts.current}`);
    } else {
      d.hearts.current = Math.max(0, d.hearts.current - 1);
      pvpLog(`${a.name} ${t} ${atk} vs ${def} — hit! ${d.name} ❤ ${d.hearts.current}`);
      if (a.hasEnchantment('flame')) pv.fire[d.id] = (pv.fire[d.id] ?? 0) + 1;
    }
    pv.smoke[d.id] = false;
    if (pvpCheckDeaths()) return;
    passPvpTurn();
  }

  function passPvpTurn() {
    const pv = state.pendingPvp;
    const done = playerById(pv.active);
    done.statusEffects = done.statusEffects
      .map(e => e.type === 'malus' ? { ...e, turnsLeft: e.turnsLeft - 1 } : e)
      .filter(e => e.type !== 'malus' || e.turnsLeft > 0);
    pv.active = pvpOpponent(pv.active).id;
    if (pv.active === pv.ids[0]) pv.round++;
    // stalemate: after PVP_MAX_ROUNDS full rounds the duel ends, nobody dies, both stay put
    if (pv.round > PVP_MAX_ROUNDS) {
      pvpLog(`The duel drags on for ${PVP_MAX_ROUNDS} rounds — both fighters back off.`);
      return endPvp('draw');
    }
    beginPvpAct();
  }

  // Returns true if the fight ended.
  function pvpCheckDeaths() {
    const pv = state.pendingPvp; if (!pv) return true;
    const [A, B] = pv.ids.map(playerById);
    const dead = [A, B].find(p => p.hearts.current <= 0);
    if (!dead) return false;
    const winner = dead === A ? B : A;
    dead.isAlive = false;
    // winner takes everything
    const loot = { coins: dead.coins, items: [] };
    for (const slot of Object.keys(dead.equipped)) { const it = dead.equipped[slot]; if (it) { loot.items.push(it.id); dead.equipped[slot] = null;
      if (it.enchantment) (winner.storedEnchantments[it.id] ??= []).push(it.enchantment); } }
    loot.items.push(...dead.inventory);
    for (const [id, list] of Object.entries(dead.storedEnchantments)) (winner.storedEnchantments[id] ??= []).push(...list);
    dead.inventory = []; dead.storedEnchantments = {}; dead.coins = 0;
    winner.coins += loot.coins;
    for (const id of loot.items) winner.addItem(id);
    pvpLog(`☠ ${dead.name} is slain by ${winner.name}! ${winner.name} takes ${loot.coins} coins and ${loot.items.length} items`);
    if (dead.hasPrincess) { dropPrincess(dead); pickUpPrincess(winner); }
    emit('player_defeated', { player: dead.name, by: winner.name });
    emit('combat_victory', { player: winner.name, mob: dead.name, loot, mobTier: 3, isAnimal: false, isPvp: true });
    endPvp('victory', { winner: winner.name, loser: dead.name, loot });
    return true;
  }

  const PVP_MAX_ROUNDS = 40;
  function endPvp(outcome, extra = {}) {
    const pv = state.pendingPvp;
    for (const id of pv.ids) { const p = playerById(id); p.chainedTurns = 0; p.clearFightEffects(); }
    emitPvp(outcome, extra);
    state.pendingPvp = null;
    checkGameOver();
    if (state.phase === Phase.GAME_OVER) return;
    // the fight ends the mover's turn (no tile event); a surviving mover picks up the princess here
    const mover = current();
    if (mover.isAlive && state.pvpActive && !state.princess.carriedBy) pickUpPrincess(mover);
    endTileInteraction();
  }

  // ── Princess ──────────────────────────────────────────────────────────────
  function pickUpPrincess(player) {
    if (!state.pvpActive) return;
    if (state.princess.carriedBy) return;
    if (player.position.x !== state.princess.x || player.position.y !== state.princess.y) return;
    state.princess.carriedBy = player.id;
    player.hasPrincess = true;
    log(`${player.name} picks up the Princess!`);
    emit('princess_picked_up', { player: player.name });
  }

  function dropPrincess(player) {
    player.hasPrincess       = false;
    state.princess.carriedBy = null;
    state.princess.x         = player.position.x;
    state.princess.y         = player.position.y;
    emit('princess_dropped', { position: state.princess });
  }

  // ── Win / loss checks ─────────────────────────────────────────────────────
  function checkGameOver() {
    const alive = state.players.filter(p => p.isAlive);
    if (alive.length === 0) {
      state.phase  = Phase.GAME_OVER;
      state.winner = null;
      emit('game_over', { winner: null, reason: 'all_dead' });
    } else if (alive.length === 1 && state.pvpActive) {
      state.phase  = Phase.GAME_OVER;
      state.winner = alive[0];
      emit('game_over', { winner: alive[0].name, reason: 'last_standing' });
    }
  }

  // ── End of tile interaction → next turn ───────────────────────────────────
  function endTileInteraction() {
    nextTurn();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    Phase,
    init,
    on,
    emit,
    submitAction,
    resolveCombatResult,
    startPvpCombat,
    dropPrincess,
    getPvpView: pvpView,
    getPvpAwaited: () => pvpAwaited(),
    getState: () => state,
    getPlayers: () => state.players,
    getCurrentPlayer: current,
  };
})();
