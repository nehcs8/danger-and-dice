'use strict';

const fs  = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname);

const LOAD_ORDER = [
  'js/engine/dice.js',
  'js/data/items.js',
  'js/data/mobs.js',
  'js/data/map.js',
  'js/engine/player.js',
  'js/engine/movement.js',
  'js/engine/combat.js',
  'js/engine/game.js',
  'js/data/weights/combat_weights.js',
  'js/data/weights/estimator_weights.js',
  'js/data/weights/nn_combat_weights.js',
  'js/data/weights/upgrade_advisor_weights.js',
  'js/engine/combat_estimator.js',
  'js/engine/combat_nn.js',
  'js/engine/rl_combat.js',
  'js/engine/upgrade_advisor.js',
  'js/engine/bot.js',
];

const fileSrc = {};
for (const f of LOAD_ORDER) fileSrc[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

const KING_BATTLE_STUB = `
const KingBattle = (() => {
  let _win=null, _lose=null;
  return {
    init:       (p,w,l) => { _win=w; _lose=l; },
    resolveWin: () => { const f=_win; _win=null; _lose=null; if(f) f(); },
    clearState: () => { _win=null; _lose=null; },
    getState:   () => ({}),
  };
})();
`;

function makeSandbox() {
  const sb = {
    Math, Array, Float32Array, Uint8Array, Int32Array, Uint16Array, ArrayBuffer,
    Object, JSON, Set, Map, Date, RegExp, String, Number, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    console: { log:()=>{}, warn:()=>{}, error: console.error.bind(console) },
    setTimeout: ()=>{}, clearTimeout: ()=>{},
    window: {}, document: { getElementById: ()=>null },
  };
  vm.createContext(sb);
  vm.runInContext(KING_BATTLE_STUB, sb);
  for (const f of LOAD_ORDER) vm.runInContext(fileSrc[f], sb);
  return sb;
}

function get(sb, name) { return vm.runInContext(name, sb); }

function runGame(idx, numBots = 4) {
  const sb    = makeSandbox();
  const Game  = get(sb, 'Game');
  const BotAI = get(sb, 'BotAI');
  const KB    = get(sb, 'KingBattle');
  const Ph    = Game.Phase;
  const TT    = get(sb, 'TileType');
  const tileNames = Object.fromEntries(Object.entries(TT).map(([k,v])=>[v,k]));

  const players = Array.from({ length: numBots }, (_, i) => ({
    id: `p${i}`, name: `Bot${i+1}`, isBot: true,
  }));

  const queue   = [];
  let result    = null;
  let turns     = 0;
  const deaths  = [];   // ← what we care about

  function enqueueBot(player) {
    if (player?.isBot) queue.push(() => BotAI.takeTurn(player));
  }

  Game.on('state_change', () => {
    if (result) return;
    const st = Game.getState();
    if (st.phase === Ph.GAME_OVER) return;
    if (st.phase === Ph.SETUP_ROLL) {
      const sp = st.players[st.setupRollIdx];
      if (sp?.isBot) queue.push(() => Game.submitAction({ type: 'setup_roll' }));
      return;
    }
    if (st.phase === Ph.KING_BATTLE) { queue.push(() => KB.resolveWin()); return; }
    if (st.phase === Ph.ROLL_MOVE) turns++;
    enqueueBot(Game.getCurrentPlayer());
  });

  Game.on('combat_update', data => {
    if (result) return;
    if (data.outcome === 'ongoing' || data.outcome === 'charisma_pending')
      enqueueBot(Game.getCurrentPlayer());
  });

  const reShop = () => {
    if (result) return;
    const p  = Game.getCurrentPlayer();
    const ph = Game.getState().phase;
    if (p?.isBot && (ph === Ph.SHOP || ph === Ph.MASTER)) enqueueBot(p);
  };
  const reAny = () => { if (!result) enqueueBot(Game.getCurrentPlayer()); };

  Game.on('shop_transaction', reShop);
  Game.on('item_equipped',    reShop);
  Game.on('item_unequipped',  reShop);
  Game.on('skill_upgraded',   reAny);
  Game.on('enchanted',        reAny);

  // ── Death tracking ──────────────────────────────────────────────────────────
  Game.on('player_defeated', data => {
    const st = Game.getState();
    // Find the player in state
    const p = st.players?.find(pl => pl.name === data.player || pl.id === data.player);
    if (!p) return;

    const pos = p.position;
    const MapGrid = get(sb, 'MapGrid');
    const tileVal = MapGrid.get(pos?.x, pos?.y);
    const tileName = tileNames[tileVal] ?? `?${tileVal}`;

    deaths.push({
      name:     p.name,
      turn:     turns,
      pos:      pos,
      tile:     tileName,
      hearts:   `${p.hearts?.current ?? 0}/${p.hearts?.max ?? 0}`,
      coins:    p.coins,
      base:     { ...p.baseStats },
      effF:     p.getStat?.('F'), effD: p.getStat?.('D'),
      effA:     p.getStat?.('A'), effM: p.getStat?.('M'),
      effC:     p.getStat?.('C'), effV: p.getStat?.('V'),
      equipped: Object.entries(p.equipped ?? {})
                      .filter(([,v]) => v)
                      .map(([slot, v]) => `${slot}:${v.id}${v.enchantment ? `[${v.enchantment}]` : ''}`),
      inventory: (p.inventory ?? []).map(i => i?.id ?? i).slice(0, 12),
      killer:   data.killer ?? data.cause ?? '?',
    });
  });

  Game.on('game_over', data => { result = data; });

  Game.init(players, 'medium');

  const MAX_TURNS = 1500, MAX_STEPS = 200000;
  let steps = 0, samePhaseRuns = 0, lastPhase = '';

  while (!result && queue.length > 0 && steps < MAX_STEPS && turns < MAX_TURNS) {
    const fn = queue.shift();
    try { fn(); } catch (e) {
      result = { winner: null, _err: e.message };
      break;
    }
    steps++;
    const ph = Game.getState().phase;
    samePhaseRuns = ph === lastPhase ? samePhaseRuns + 1 : 0;
    lastPhase = ph;
    if (samePhaseRuns > 20000) { result = { winner: null, _stall: true }; break; }
  }

  const finalPlayers = Game.getState().players?.map(p => ({
    name:      p.name,
    alive:     p.isAlive,
    hearts:    `${p.hearts?.current ?? 0}/${p.hearts?.max ?? 0}`,
    coins:     p.coins,
    base:      { ...p.baseStats },
    effF: p.getStat?.('F'), effD: p.getStat?.('D'),
    effA: p.getStat?.('A'), effM: p.getStat?.('M'),
    effC: p.getStat?.('C'), effV: p.getStat?.('V'),
    equipped:  Object.entries(p.equipped ?? {}).filter(([,v])=>v)
                     .map(([slot,v])=>`${slot}:${v.id}${v.enchantment?`[${v.enchantment}]`:''}`),
    inventory: (p.inventory ?? []).map(i=>i?.id??i).slice(0,12),
    pos:       p.position,
  })) ?? [];

  return {
    idx,
    winner:     result?.winner?.name ?? null,
    turns,
    timedOut:   !result && (turns >= MAX_TURNS || steps >= MAX_STEPS),
    stalled:    result?._stall ?? false,
    error:      result?._err   ?? null,
    finalPhase: Game.getState().phase,
    deaths,
    finalPlayers,
  };
}

// ── Driver ────────────────────────────────────────────────────────────────────
const N = parseInt(process.argv[2] ?? '3', 10);
console.log(`\nRunning ${N} game(s) — tracking deaths\n${'─'.repeat(60)}`);

for (let i = 1; i <= N; i++) {
  const r = runGame(i);
  const status = r.winner  ? `Winner: ${r.winner}` :
                 r.error   ? `ERROR: ${r.error}` :
                 r.timedOut? `TIMED OUT` :
                 r.stalled ? `STALLED`  : `NO RESULT`;
  console.log(`\nGame ${i}  turns=${r.turns}  ${status}  phase=${r.finalPhase}`);

  if (r.deaths.length === 0) {
    console.log('  (no deaths recorded)');
  } else {
    for (const d of r.deaths) {
      console.log(`\n  ☠  ${d.name}  turn=${d.turn}  tile=${d.tile} (${d.pos?.x},${d.pos?.y})`);
      console.log(`     hearts=${d.hearts}  coins=${d.coins}  killer=${d.killer}`);
      console.log(`     base  F=${d.base?.F} D=${d.base?.D} A=${d.base?.A} M=${d.base?.M} C=${d.base?.C} V=${d.base?.V}`);
      console.log(`     eff   F=${d.effF} D=${d.effD} A=${d.effA} M=${d.effM} C=${d.effC} V=${d.effV}`);
      if (d.equipped.length)  console.log(`     equipped: [${d.equipped.join(', ')}]`);
      if (d.inventory.length) console.log(`     inventory: [${d.inventory.join(', ')}]`);
    }
  }

  console.log('\n  Final player states:');
  for (const p of r.finalPlayers) {
    const alive = p.alive ? '  ' : '☠ ';
    console.log(`\n  ${alive}${p.name}  hearts=${p.hearts}  coins=${p.coins}  pos=(${p.pos?.x},${p.pos?.y})`);
    console.log(`     base  F=${p.base?.F} D=${p.base?.D} A=${p.base?.A} M=${p.base?.M} C=${p.base?.C} V=${p.base?.V}`);
    console.log(`     eff   F=${p.effF} D=${p.effD} A=${p.effA} M=${p.effM} C=${p.effC} V=${p.effV}`);
    if (p.equipped.length)  console.log(`     equipped: [${p.equipped.join(', ')}]`);
    if (p.inventory.length) console.log(`     inventory: [${p.inventory.join(', ')}]`);
  }
}
console.log('\n' + '─'.repeat(60));
