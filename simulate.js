'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname);

// Load order matches index.html — UI files omitted.
const LOAD_ORDER = [
  'js/engine/dice.js',
  'js/data/items.js',
  'js/data/mobs.js',
  'js/data/map.js',
  'js/engine/player.js',
  'js/engine/movement.js',
  'js/engine/combat.js',
  // king_battle.js skipped — minimal stub injected before game.js
  'js/engine/game.js',
  'js/data/weights/combat_weights.js',
  'js/data/weights/estimator_weights.js',
  'js/data/weights/nn_combat_weights.js',
  'js/data/weights/upgrade_advisor_weights.js',
  'js/engine/combat_estimator.js',
  'js/engine/combat_nn.js',
  'js/engine/rl_combat.js',
  'js/engine/upgrade_advisor.js',
  'js/engine/inventory_manager.js',
  'js/engine/bot.js',
];

// Read all files from disk once; reuse source strings per game.
const fileSrc = {};
for (const f of LOAD_ORDER) {
  fileSrc[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
}

// Minimal KingBattle stub.
// game.js calls KingBattle.init(player, onVictory, onDefeat) then enters
// KING_BATTLE phase and waits.  The simulation resolves it immediately as a
// victory so the game can continue.
const KING_BATTLE_STUB = `
const KingBattle = (() => {
  let _win = null, _lose = null;
  return {
    init:       (player, onWin, onLose) => { _win = onWin; _lose = onLose; },
    resolveWin: () => { const f = _win; _win = null; _lose = null; if (f) f(); },
    clearState: () => { _win = null; _lose = null; },
    getState:   () => ({}),
  };
})();
`;

function makeSandbox() {
  const sb = {
    Math, Array, Float32Array, Uint8Array, Int32Array, Uint16Array, ArrayBuffer,
    Object, JSON, Set, Map, Date, RegExp, String, Number, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    // Silence in-game console.log noise; keep errors visible
    console: { log: () => {}, warn: () => {}, error: console.error.bind(console) },
    setTimeout: () => {}, clearTimeout: () => {},
    window: {}, document: { getElementById: () => null },
  };
  vm.createContext(sb);
  vm.runInContext(KING_BATTLE_STUB, sb);
  for (const f of LOAD_ORDER) {
    vm.runInContext(fileSrc[f], sb);
  }
  return sb;
}

function get(sb, name) { return vm.runInContext(name, sb); }

// ── Single game runner ────────────────────────────────────────────────────────
function runGame(idx, numBots = 4) {
  const sb    = makeSandbox();
  const Game  = get(sb, 'Game');
  const BotAI = get(sb, 'BotAI');
  const KB    = get(sb, 'KingBattle');
  const Ph    = Game.Phase;

  const players = Array.from({ length: numBots }, (_, i) => ({
    id: `p${i}`, name: `Bot${i + 1}`, isBot: true,
  }));

  const queue  = [];   // pending () => void actions
  const events = [];   // notable log lines
  let result   = null;
  let turns    = 0;

  function enqueueBot(player) {
    if (player?.isBot) queue.push(() => BotAI.takeTurn(player));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  const TileTypeRef  = get(sb, 'TileType');
  const MapGridRef   = get(sb, 'MapGrid');
  const tileNamesRef = Object.fromEntries(Object.entries(TileTypeRef).map(([k,v])=>[v,k]));
  function tileName(x, y) { return tileNamesRef[MapGridRef.get(x, y)] ?? '?'; }
  function fmtEquip(p) {
    return Object.entries(p.equipped ?? {}).filter(([,v])=>v)
      .map(([k,v]) => `${k}:${v.id}${v.enchantment?`[${v.enchantment}]`:''}`).join(' ');
  }
  function fmtStats(p) {
    return `F${p.getStat?.('F')} D${p.getStat?.('D')} M${p.getStat?.('M')} C${p.getStat?.('C')} A${p.getStat?.('A')} V${p.getStat?.('V')}`;
  }

  // Track last-known bot plan phase per player to detect transitions
  const lastBotPhase = {};
  // Track shop action count per shop visit to detect loops
  const shopActionCount = {};
  let currentShopPlayer = null;

  // ── Event wiring (mirrors main.js bot-trigger logic, synchronised) ──────────

  Game.on('state_change', () => {
    if (result) return;
    const st    = Game.getState();
    const phase = st.phase;
    if (phase === Ph.GAME_OVER) return;

    if (phase === Ph.SETUP_ROLL) {
      const sp = st.players[st.setupRollIdx];
      if (sp?.isBot) queue.push(() => Game.submitAction({ type: 'setup_roll' }));
      return;
    }

    // Auto-resolve king battle as victory (no UI / KingPanel in the simulation)
    if (phase === Ph.KING_BATTLE) {
      queue.push(() => KB.resolveWin());
      return;
    }

    if (phase === Ph.ROLL_MOVE) turns++;

    // Detect shop entry / exit for loop tracking
    const cp = Game.getCurrentPlayer();
    if (phase === Ph.SHOP || phase === Ph.MASTER) {
      currentShopPlayer = cp?.id ?? null;
      if (currentShopPlayer) shopActionCount[currentShopPlayer] = 0;
    } else if (currentShopPlayer) {
      currentShopPlayer = null;
    }

    enqueueBot(cp);
  });

  Game.on('combat_update', data => {
    if (result) return;
    if (data.outcome === 'ongoing' || data.outcome === 'charisma_pending') {
      enqueueBot(Game.getCurrentPlayer());
    }
  });

  const reShop = () => {
    if (result) return;
    const p  = Game.getCurrentPlayer();
    const ph = Game.getState().phase;
    if (p?.isBot && (ph === Ph.SHOP || ph === Ph.MASTER)) {
      // Count actions this shop visit; warn at thresholds
      if (currentShopPlayer === p.id) {
        shopActionCount[p.id] = (shopActionCount[p.id] ?? 0) + 1;
        const n = shopActionCount[p.id];
        if (n === 20) {
          events.push(`  [T${turns}] SHOP-LOOP at 20: ${p.name}  coins=${p.coins}  plan=${BotAI.getPhase(p)}`);
          events.push(`    equipped: ${fmtEquip(p)}`);
          events.push(`    inv: [${p.inventory?.slice(0,14).join(', ')}]`);
        }
        if (n === 50) {
          events.push(`  [T${turns}] SHOP-LOOP at 50: ${p.name}  coins=${p.coins}  plan=${BotAI.getPhase(p)}`);
          events.push(`    equipped: ${fmtEquip(p)}`);
          events.push(`    inv: [${p.inventory?.slice(0,14).join(', ')}]`);
        }
      }
      enqueueBot(p);
    }
  };
  const reAny = () => { if (!result) enqueueBot(Game.getCurrentPlayer()); };

  Game.on('shop_transaction', reShop);
  Game.on('item_equipped',    reShop);
  Game.on('item_unequipped',  reShop);
  Game.on('skill_upgraded',   reAny);
  Game.on('enchanted',        reAny);
  // Re-enqueue after item use outside combat (pot_heal used before roll_move)
  Game.on('item_used', () => {
    if (!result) {
      const ph = Game.getState().phase;
      if (ph !== Ph.COMBAT && ph !== Ph.PVP_COMBAT) enqueueBot(Game.getCurrentPlayer());
    }
  });

  // ── Diagnostic: bot plan-phase transitions ─────────────────────────────────
  // Emit a log line the first time a bot enters heal_*, dragon, dragon_prep.
  Game.on('player_moved', data => {
    if (result) return;
    const st = Game.getState();
    const p  = st.players?.find(pl => pl.name === data.player);
    if (!p?.isBot) return;
    const pos = data.position;
    const bp  = BotAI.getPhase(p);

    // Log every move while in heal or dragon phase (capped to avoid flooding)
    const traceKey = `${p.id}_${bp}`;
    const prev = lastBotPhase[p.id];

    if (bp !== prev) {
      // Phase transition
      lastBotPhase[p.id] = bp;
      if (bp.startsWith('heal_')) {
        events.push(`  [T${turns}] ${p.name} → ${bp}  H=${p.hearts?.current}/${p.hearts?.max} coins=${p.coins} pos=(${pos?.x},${pos?.y})`);
      } else if (bp === 'dragon' || bp.startsWith('dragon_prep')) {
        events.push(`  [T${turns}] ${p.name} → ${bp}  H=${p.hearts?.current}/${p.hearts?.max} coins=${p.coins}`);
        events.push(`    stats: ${fmtStats(p)}`);
        events.push(`    equipped: ${fmtEquip(p)}`);
        events.push(`    inv: [${p.inventory?.slice(0,8).join(', ')}]`);
      }
    }

    // Trace dragon/king moves (first 30)
    if (bp === 'dragon' || bp === 'king') {
      const k = traceKey;
      const cnt = (lastBotPhase[k] ?? 0) + 1;
      lastBotPhase[k] = cnt;
      if (cnt <= 20) {
        const t = tileName(pos?.x, pos?.y);
        events.push(`  [T${turns}] ${p.name} →(${pos?.x},${pos?.y})[${t}] ${bp} H=${p.hearts?.current} coins=${p.coins}`);
      }
    }
  });

  // ── Diagnostic: bot deaths ─────────────────────────────────────────────────
  Game.on('player_defeated', data => {
    if (result) return;
    const st  = Game.getState();
    const p   = st.players?.find(pl => pl.name === data.player);
    const bot = p?.isBot ? p : null;
    if (!bot) return;
    events.push(`  [T${turns}] DEATH: ${bot.name} killed by ${data.killer ?? '?'}  plan=${BotAI.getPhase(bot)}  H=${bot.hearts?.current}/${bot.hearts?.max}`);
    events.push(`    stats: ${fmtStats(bot)}`);
    events.push(`    equipped: ${fmtEquip(bot)}`);
  });

  // ── Diagnostic: fire/bar visits while healing ───────────────────────────────
  Game.on('log', data => {
    const m = data.message ?? '';
    if (/dragon|princess|boss|defeated|killed|wins|enchant|master/i.test(m)) {
      events.push(`  [T${data.turn ?? '?'}] ${m.slice(0, 120)}`);
    }
  });

  Game.on('game_over', data => { result = data; });

  // ── Kick off ──────────────────────────────────────────────────────────────
  Game.init(players, 'medium');

  // ── Drain loop ────────────────────────────────────────────────────────────
  const MAX_TURNS = 500;
  const MAX_STEPS = 200000; // safety cap
  let steps = 0, samePhaseRuns = 0, lastPhase = '';

  while (!result && queue.length > 0 && steps < MAX_STEPS && turns < MAX_TURNS) {
    const fn = queue.shift();
    try { fn(); } catch (e) {
      events.push(`  ERR step ${steps}: ${e.message}`);
      result = { winner: null, _err: e.message };
      break;
    }
    steps++;

    // Stall guard: lower threshold so stalls are caught faster
    const ph = Game.getState().phase;
    samePhaseRuns = ph === lastPhase ? samePhaseRuns + 1 : 0;
    lastPhase = ph;
    if (samePhaseRuns > 5000) {
      events.push(`  STALL phase='${ph}' after ${turns} turns (${samePhaseRuns} same-phase steps)`);
      result = { winner: null, _stall: true };
      break;
    }
  }

  // ── Player state dump at end ──────────────────────────────────────────────
  const finalState = Game.getState();
  let UA = null; try { UA = get(sb, 'UpgradeAdvisor'); } catch(e) {}
  let CE = null; try { CE = get(sb, 'CombatEstimator'); } catch(e) {}
  const playerDump = finalState.players.map(p => {
    const plan = UA ? UA.nextUpgrade(p) : null;
    const dragonWinProb = CE ? (CE.estimateBoss?.(p, 'dragon', 80)?.winProb ?? null) : null;
    return {
      name:        p.name,
      alive:       p.isAlive,
      pos:         p.position,
      coins:       p.coins,
      hearts:      `${p.hearts?.current}/${p.hearts?.max}`,
      base:        p.baseStats,
      effF:        p.getStat?.('F'), effD: p.getStat?.('D'),
      effM:        p.getStat?.('M'), effC: p.getStat?.('C'),
      equipped:    Object.entries(p.equipped ?? {}).filter(([,v])=>v).map(([k,v])=>k+':'+v.id+(v.enchantment?`[${v.enchantment}]`:'')),
      inventory:   p.inventory?.slice(0,12),
      botPhase:    BotAI.getPhase(p),
      dragonWinProb: dragonWinProb !== null ? (dragonWinProb * 100).toFixed(1) + '%' : null,
      plan: plan ? {
        upgrade:     plan.upgrade ? `${plan.upgrade.type}/${plan.upgrade.shopType}/${plan.upgrade.itemId}` : null,
        cost:        plan.upgrade?.cost,
        shortfall:   plan.shortfall,
        canFarm:     plan.canFarm,
        farmingTier: plan.farmingTier,
        chestRec:    plan.chestRun?.recommended,
        nextChest:   plan.chestRun?.nextChest,
      } : null,
    };
  });

  return {
    idx,
    winner:     result?.winner?.name ?? null,
    turns,
    steps,
    timedOut:   !result && (turns >= MAX_TURNS || steps >= MAX_STEPS),
    stalled:    result?._stall ?? false,
    error:      result?._err  ?? null,
    finalPhase: finalState.phase,
    events,
    playerDump,
  };
}

// ── Driver ────────────────────────────────────────────────────────────────────
const N = parseInt(process.argv[2] ?? '5', 10);
console.log(`\nRunning ${N} all-bot game(s)…\n`);
const t0 = Date.now();
let wins = 0;

for (let i = 1; i <= N; i++) {
  process.stdout.write(`Game ${i}/${N}  `);
  const r = runGame(i);

  if (r.winner) {
    wins++;
    process.stdout.write(`${r.winner} wins  turns=${r.turns}  steps=${r.steps}\n`);
  } else if (r.error) {
    process.stdout.write(`ERROR: ${r.error}  phase=${r.finalPhase}\n`);
  } else if (r.timedOut) {
    process.stdout.write(`TIMED OUT (${r.turns} turns)  phase=${r.finalPhase}\n`);
    r.playerDump?.filter(p => p.alive).forEach(p => {
      console.log(`  ${p.name} pos=(${p.pos?.x},${p.pos?.y}) coins=${p.coins} hearts=${p.hearts} base=${JSON.stringify(p.base)}`);
      console.log(`         eff F=${p.effF} D=${p.effD} M=${p.effM} C=${p.effC}  equipped=[${p.equipped?.join(', ')}]`);
      console.log(`         botPhase: ${p.botPhase}  dragonWinProb: ${p.dragonWinProb ?? '?'}  plan: ${p.plan ? JSON.stringify(p.plan) : 'null'}`);
      if (p.inventory?.length) console.log(`         inv: [${p.inventory.join(', ')}]`);
    });
  } else if (r.stalled) {
    process.stdout.write(`STALLED  turns=${r.turns}  phase=${r.finalPhase}\n`);
  } else {
    const allDead = r.playerDump?.every(p => !p.alive);
    process.stdout.write(`${allDead ? 'ALL DEAD' : 'NO RESULT'}  turns=${r.turns}  phase=${r.finalPhase}\n`);
  }

  r.events.forEach(e => console.log(e));
  if (r.events.length) console.log();
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${wins}/${N} games had a winner  (${elapsed}s total)`);
