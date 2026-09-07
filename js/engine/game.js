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
    GAME_OVER:       'game_over',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  let state = {
    phase:            Phase.SETUP,
    players:          [],
    currentIdx:       0,
    setupRollIdx:     0,
    turnNumber:       0,
    movementCap:      0,
    reachableTiles:   null,   // Map<"x,y", steps> from Movement
    stopBlockedTiles: null,   // Set<"x,y"> tiles reachable only through an uncleared STOP
    princess:         { x: null, y: null, carriedBy: null },
    pvpActive:        false,
    dragonDefeated:   false,
    winner:           null,
    pendingCombat:        null,   // { mob, isBoss, isPvp }
    pendingChest:         null,   // { tier }
    pendingPriest:        null,   // { buff }
    pendingLootDescription: null, // string shown in loot popup
    pendingLootCallback:    null, // fn called when loot popup is confirmed
    mapForcedRoll:          null, // 1-6 chosen by player when using Map item
    mapChoiceShown:         false,// prevents re-entry into MAP_CHOICE
    teleportReturnPhase:    null, // phase to restore if teleport is cancelled
  };

  // ── Event bus ─────────────────────────────────────────────────────────────
  const listeners = {};
  function on(event, fn)  { (listeners[event] = listeners[event] ?? []).push(fn); }
  function emit(event, data) { (listeners[event] ?? []).forEach(fn => fn(data)); }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const STAT_NAMES = { F:'STR', D:'DEX', M:'MAG', C:'CHA' };

  function current() { return state.players[state.currentIdx]; }

  function nextTurn() {
    state.currentIdx = (state.currentIdx + 1) % state.players.length;
    // Skip dead players
    let safety = state.players.length;
    while (!current().isAlive && safety-- > 0) {
      state.currentIdx = (state.currentIdx + 1) % state.players.length;
    }
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

  function randomMobByTier(tier) {
    const pool = MOBS.getByTier(tier);
    // Exclude named bosses from random spawns
    const nonBoss = pool.filter(m => !m.isBoss);
    return nonBoss.length ? nonBoss[Math.floor(Math.random() * nonBoss.length)] : null;
  }

  // ── Setup ─────────────────────────────────────────────────────────────────
  function init(playerDefs) {
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
    state.phase = Phase.SETUP_ROLL;
    emit('state_change', { phase: state.phase, setupRollIdx: 0, player: state.players[0].name });
  }

  // ── Starting stat roll ────────────────────────────────────────────────────
  const STARTING_ITEM_POOL = () =>
    [...EQUIPMENT.filter(i => i.tier === 1), ...OBJECTS];

  function handleSetupRoll() {
    const player   = state.players[state.setupRollIdx];
    const statKeys = ['F','D','A','M','C','V'];
    const rolled   = {};
    statKeys.forEach(s => { rolled[s] = Dice.d6(); });
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

    state.phase = Phase.ROLL_MOVE;
    emit('state_change', { phase: state.phase, player: player.name });
  }

  // ── Submit action (called by UI / bot) ────────────────────────────────────
  function submitAction(action) {
    // use_item is available in most phases (not setup or game-over)
    if (action?.type === 'use_item' &&
        state.phase !== Phase.SETUP_ROLL && state.phase !== Phase.GAME_OVER) {
      handleUseItem(action.itemId);
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
        if (action?.type === 'attack' || action?.type === 'bail' ||
            action?.type === 'bard'   || action?.type === 'defend') {
          handleCombatAction(action);
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
    log(`${player.name} rolls movement: ${state.movementCap}`);
    state.phase = Phase.MOVING;
    emit('state_change', {
      phase: state.phase,
      player: player.name,
      cap: state.movementCap,
      reachable: state.reachableTiles,
    });
  }

  // ── Move ──────────────────────────────────────────────────────────────────
  function handleMove(dest) {
    const player   = current();
    const destKey  = `${dest.x},${dest.y}`;
    if (!state.reachableTiles.has(destKey)) {
      emit('error', { message: 'Invalid destination' });
      return;
    }

    // Invisibility cloak: skip miniboss tiles if player chooses to
    const destType = MapGrid.get(dest.x, dest.y);
    if (destType === TileType.MINIBOSS && player.hasEquipped('invis_cloak')) {
      emit('prompt', {
        type: 'invis_cloak_choice',
        message: 'Use Invisibility Cloak to skip this miniboss?',
      });
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
        log(`${player.name} moves to (${stopTile.x}, ${stopTile.y})`);
        emit('player_moved', { player: player.name, position: stopTile });

        const roll = Dice.d6();
        log(`${player.name} hits a Stop tile — rolls ${roll}`);

        if (roll <= 3) {
          log(`${player.name} is stopped!`);
          endTileInteraction();
        } else {
          log(`${player.name} breaks free!`);
          if (stopTile.x !== dest.x || stopTile.y !== dest.y) {
            player.position = { ...dest };
            emit('player_moved', { player: player.name, position: dest });
          }
          if (state.pvpActive && !state.princess.carriedBy) pickUpPrincess(player);
          resolveTileEvent();
        }
        return;
      }
    }

    player.position = { ...dest };
    log(`${player.name} moves to (${dest.x}, ${dest.y})`);
    emit('player_moved', { player: player.name, position: dest });

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
        if (tData.skipMiniboss) { endTileInteraction(); break; }
        player.markTileUsed(x, y);
        const tier = tData.minibossTier ?? 1;
        const pool = MOBS.getByTier(tier).filter(m => !m.isBoss);
        const idx  = rollOrForced() - 1;
        const picked = pool[idx % pool.length] ?? null;
        if (picked) startCombat(MOBS.spawn(picked.id), false);
        else endTileInteraction();
        break;
      }

      case TileType.CHEST:
        if (player.hasUsedTile(x, y)) { log(`${player.name}: the chest is already empty.`); endTileInteraction(); break; }
        player.markTileUsed(x, y);
        handleChestOpen();
        break;

      case TileType.REROLL: {
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
        log(`${player.name} goes back ${n} tiles`);
        // Move player back n steps along path (simplified: snap to nearest walkable tile)
        // Full pathfinding-back is handled by UI; here we just emit the event
        emit('go_back', { player: player.name, steps: n });
        endTileInteraction();
        break;
      }

      case TileType.PRIEST:
        state.phase = Phase.PRIEST;
        emit('state_change', { phase: state.phase, player: player.name });
        break;

      case TileType.SHOP:
        player.refreshTiles();
        state.phase = Phase.SHOP;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          inventory: player.inventory,
          coins: player.coins,
        });
        break;

      case TileType.MASTER:
        player.refreshTiles();
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
          log(`${player.name} pays ${barCost} coins at the bar — restored 1 heart`);
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
        log(`${player.name} rests at the fire — full health restored`);
        emit('healed', { player: player.name });
        endTileInteraction();
        break;

      case TileType.BOSS: {
        const mob = MOBS.spawn(tData.bossId);
        if (!mob) { endTileInteraction(); break; }
        startCombat(mob, true);
        break;
      }

      case TileType.GUILD_ASSASSIN:
      case TileType.GUILD_THIEF:
        player.refreshTiles();
        state.phase = Phase.SHOP;
        emit('state_change', {
          phase: state.phase,
          player: player.name,
          guildType: tType === TileType.GUILD_ASSASSIN ? 'assassin' : 'thief',
          inventory: player.inventory,
          coins: player.coins,
        });
        break;

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

  // ── Random event (? tile) ─────────────────────────────────────────────────
  function resolveRandomEvent(player) {
    const roll = rollOrForced();
    const zone = zoneTierAt(player.position.x, player.position.y);
    const weakTier   = zone;
    const strongTier = Math.min(zone + 1, 3);
    log(`${player.name} lands on ? — rolls ${roll}`);

    if (roll <= 2) {
      const mob = MOBS.spawn(randomMobByTier(weakTier)?.id);
      log(`A tier-${weakTier} enemy appears: ${mob?.name}`);
      startCombat(mob, false);
    } else if (roll === 3) {
      const mob = MOBS.spawn(randomMobByTier(strongTier)?.id);
      log(`A tier-${strongTier} enemy appears: ${mob?.name}`);
      startCombat(mob, false);
    } else if (roll === 4) {
      // Lose money
      const lost = Dice.d6() * 3;
      player.coins = Math.max(0, player.coins - lost);
      log(`${player.name} loses ${lost} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: -lost });
      endTileInteraction();
    } else if (roll === 5) {
      // Find money
      const found = Dice.d6() * 5;
      player.coins += found;
      log(`${player.name} finds ${found} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: found });
      showLootConfirm(`Found ${found} coins on the ground!`);
    } else {
      // Find equipment (roll for tier)
      const tierRoll = Dice.d6();
      const item = randomTierItem(tierRoll, tierRoll);
      if (item) {
        player.addItem(item.id);
        log(`${player.name} finds: ${item.name}`);
        emit('item_found', { player: player.name, item });
        showLootConfirm(`Found: ${item.name}`);
      } else {
        endTileInteraction();
      }
    }
  }

  // ── Chest ─────────────────────────────────────────────────────────────────
  function handleChestOpen() {
    const player = current();
    const hadMapRoll = state.mapForcedRoll !== null;
    let roll = rollOrForced();
    if (player.hasEquipped('lucky_glove') && !hadMapRoll) {
      const roll2 = Dice.d6();
      roll = Math.max(roll, roll2);
      log(`Lucky Glove: ${player.name} rolls again, takes ${roll}`);
    }

    let desc;
    if (roll === 1) {
      log(`Chest is empty`);
      desc = 'The chest is empty.';
    } else if (roll === 2) {
      const coins = Dice.d6() * 3;
      player.coins += coins;
      log(`${player.name} finds ${coins} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: coins });
      desc = `Found ${coins} coins!`;
    } else if (roll === 3) {
      const item = randomConsumable();
      if (item) { player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    } else if (roll === 4) {
      const coins = Dice.d6() * 10;
      player.coins += coins;
      log(`${player.name} finds ${coins} coins`);
      emit('coins_changed', { player: player.name, coins: player.coins, delta: coins });
      desc = `Found ${coins} coins!`;
    } else if (roll === 5) {
      const item = randomTierItem(1, 2);
      if (item) { player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    } else {
      const item = randomTierItem(3, 6);
      if (item) { player.addItem(item.id); log(`${player.name} finds: ${item.name}`); }
      desc = item ? `Found: ${item.name}` : 'Found nothing.';
    }
    showLootConfirm(desc);
  }

  // ── Work ──────────────────────────────────────────────────────────────────
  function handleWork() {
    const player   = current();
    const { x }   = player.position;

    // Zone tier from x-coordinate (matches miniboss tier distribution on the map)
    const zoneTier = x < 21 ? 1 : x < 31 ? 2 : x < 41 ? 3 : 4;

    // Random base stat — no equipment bonus
    const statKeys = ['F','D','A','M','C','V'];
    const stat     = statKeys[Math.floor(Math.random() * 6)];
    const baseStat = Math.max(1, player.baseStats[stat] ?? 1);
    const diceRoll = rollOrForced();
    const earned   = zoneTier * diceRoll * baseStat;

    player.coins += earned;
    log(`${player.name} works (zone ${zoneTier}) — ${stat} ${baseStat} × d6=${diceRoll} = ${earned} coins`);
    emit('coins_changed', { player: player.name, coins: player.coins, delta: earned });
    showLootConfirm(`You earned ${earned} coins from work! (zone ${zoneTier} × ${stat}=${baseStat} × roll=${diceRoll})`);
  }

  // ── Priest ────────────────────────────────────────────────────────────────
  function handlePriestRoll() {
    const player = current();
    const roll   = rollOrForced();
    const statKeys = ['F','D','A','M','C','V'];
    const stat     = statKeys[roll - 1];
    const buffId = `priest_${stat}`;
    player.addItem(buffId);
    log(`${player.name} receives a priest buff: +1${stat} (one-time use)`);
    emit('priest_buff', { player: player.name, stat, buffId });
    showLootConfirm(`The priest blesses you: +1 ${stat}!`);
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
    player.coins -= item.buyPrice;
    player.addItem(itemId);
    log(`${player.name} buys ${item.name} for ${item.buyPrice} coins`);
    emit('shop_transaction', { player: player.name, type: 'buy', item, coins: player.coins });
  }

  function handleSell(itemId) {
    const player = current();
    const item   = getItem(itemId);
    if (!item) return;
    if (!player.hasItem(itemId) && !player.hasEquipped(itemId)) return;
    const price = sellPrice(item);
    if (!player.removeItem(itemId)) {
      // Item is equipped — unequip first, then remove from inventory
      const slot = Object.keys(player.equipped).find(s => player.equipped[s]?.id === itemId);
      if (!slot) return;
      player.unequip(slot);
      player.removeItem(itemId);
      emit('item_unequipped', { player: player.name, slot });
    }
    player.coins += price;
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
    const player    = current();
    const currentLv = player.baseStats[stat];
    if (currentLv >= 6) { emit('error', { message: 'Stat already at maximum (6)' }); return; }
    const cost = 50;
    if (player.coins < cost) { emit('error', { message: 'Not enough coins' }); return; }
    player.coins -= cost;
    player.baseStats[stat]++;
    log(`${player.name} upgrades ${stat} to ${player.baseStats[stat]} for ${cost} coins`);
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
      state.teleportReturnPhase = state.phase;
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
      return;
    }

    if (eff === 'transmutation') {
      log(`${player.name}: use Transmutation from the combat menu`); return;
    }

    if (eff === 'skip_fight') {
      log(`${player.name}: use Invisibility via the Bail button`); return;
    }

    // ── Standard effects ──────────────────────────────────────────────────────

    if (eff) {
      if (eff.type === 'heal') {
        const amount = eff.value ?? 1;
        player.healHeart(amount);
        log(`${player.name} uses ${item.name} — +${amount} heart(s)`);
      } else if (eff.stat) {
        // Stat potion: temporary bonus for one dice roll
        player.addTempBonus(eff.stat, eff.value ?? 1);
        log(`${player.name} uses ${item.name} — +${eff.value}${eff.stat} (next roll only)`);
      } else if (typeof eff === 'string') {
        log(`${player.name}: ${item.name} has no direct use here`); return;
      } else {
        // Object effect with no direct handler (escape, fast_travel, etc.) — don't consume
        log(`${player.name}: ${item.name} has no direct use here`); return;
      }
    }

    // Drops with statBonus (e.g. dragon_blood, werewolf_blood): last one full fight
    if (item.statBonus) {
      for (const [stat, val] of Object.entries(item.statBonus)) {
        player.statusEffects.push({ type:'drop_bonus', stat, value: val, turnsLeft: 9999 });
      }
      const bonusStr = Object.entries(item.statBonus).map(([s,v]) => `+${v}${s}`).join(', ');
      log(`${player.name} uses ${item.name} — ${bonusStr} (this fight)`);
    }

    player.removeItem(itemId);
    emit('item_used', { player: player.name, item });
  }

  // ── Combat ────────────────────────────────────────────────────────────────
  // Pre-roll and announce the mob's next attack type. Call after pendingCombat is set.
  function prepareNextMobAttack(mob, fightLog) {
    const atkType = Combat.rollMobAttack(mob);
    state.pendingCombat.mobNextAttackType = atkType;
    const msg = `${mob.name} prepares a ${STAT_NAMES[atkType] ?? atkType} attack!`;
    fightLog.push(msg);
    return { atkType, msg };
  }

  function startCombat(mob, isBoss, onCompleteCallback) {
    if (!mob) { endTileInteraction(); return; }
    const player = current();
    const initResult = Combat.initFight(player, mob);

    if (initResult.outcome === 'victory') {
      grantLoot(player, initResult.loot);
      emit('combat_victory', { player: player.name, mob: mob.name, loot: initResult.loot });
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
    if (subPhase === 'player_attack') {
      if (action.type !== 'attack' && action.type !== 'bail' && action.type !== 'bard') return;
      result = Combat.takePlayerAttack(player, mob, action, fightLog);
      if (result.outcome === 'charisma_pending') {
        state.pendingCombat.combatSubPhase = 'charisma_pick';
        state.pendingCombat.charismaResult = result.charismaResult;
        emit('combat_update', {
          player: player.name, mob,
          newLog: result.newLog ?? [],
          outcome: 'charisma_pending',
          combatSubPhase: 'charisma_pick',
          charismaResult: result.charismaResult,
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
      if (result.outcome === 'ongoing') state.pendingCombat.combatSubPhase = 'player_attack';
    }

    emit('combat_update', {
      player: player.name,
      mob,
      newLog: result.newLog ?? [],
      outcome: result.outcome,
      combatSubPhase: state.pendingCombat?.combatSubPhase,
    });

    if (result.outcome === 'ongoing') return;

    state.pendingCombat = null;

    if (result.outcome === 'victory') {
      log(`${player.name} defeats ${mob.name}`);
      grantLoot(player, result.loot);
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot });
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
      emit('combat_update', { player: player.name, mob, newLog, outcome: 'escaped', combatSubPhase: null });
      log(`${player.name} retreats from ${mob.name}`);
      endTileInteraction();
      return;
    }

    const result = Combat.applyCharismaOutcome(player, mob, action, charismaResult, newLog);
    fightLog.push(...newLog);

    if (result.coinsChanged) emit('coins_changed', { player: player.name, coins: player.coins });

    if (result.outcome === 'ongoing') {
      state.pendingCombat.combatSubPhase = 'mob_attack';
      state.pendingCombat.charismaResult = null;
      const { msg } = prepareNextMobAttack(mob, fightLog);
      newLog.push(msg);
      emit('combat_update', { player: player.name, mob, newLog, outcome: 'ongoing', combatSubPhase: 'mob_attack' });
      return;
    }

    state.pendingCombat = null;

    if (result.outcome === 'victory') {
      log(`${player.name} defeats ${mob.name}`);
      grantLoot(player, result.loot);
      emit('combat_update', { player: player.name, mob, newLog, outcome: 'victory' });
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot });
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
      log(`${player.name} befriends ${mob.name}`);
      emit('combat_update', { player: player.name, mob, newLog, outcome: 'befriended' });
      endTileInteraction();
    } else if (result.outcome === 'charisma_end') {
      emit('combat_update', { player: player.name, mob, newLog, outcome: 'charisma_end' });
      log(`${player.name} ends the encounter with ${mob.name}`);
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
      player.friendsList.push({ ...deployedFriend });
      state.pendingCombat = null;
      log(`${deployedFriend.name} defeats ${mob.name} for ${player.name}`);
      grantLoot(player, result.loot);
      emit('combat_update', { player: player.name, mob, newLog: result.newLog, outcome: 'victory' });
      emit('combat_victory', { player: player.name, mob: mob.name, loot: result.loot });
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
      emit('player_defeated', { player: player.name });
      checkGameOver();
      if (state.phase !== Phase.GAME_OVER) endTileInteraction();
    }
  }

  // ── PVP combat ────────────────────────────────────────────────────────────
  function startPvpCombat(attacker, defender) {
    if (!state.pvpActive) return;
    state.pendingCombat = { mob: defender, isPvp: true };
    state.phase = Phase.PVP_COMBAT;
    emit('state_change', { phase: state.phase, attacker: attacker.name, defender: defender.name });
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
    getState: () => state,
    getPlayers: () => state.players,
    getCurrentPlayer: current,
  };
})();
