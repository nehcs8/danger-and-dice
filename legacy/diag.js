'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = __dirname;

const LOAD_ORDER = [
  'js/engine/dice.js','js/data/items.js','js/data/mobs.js','js/data/map.js',
  'js/engine/player.js','js/engine/movement.js','js/engine/combat.js',
  'js/engine/game.js',
  'js/data/weights/combat_weights.js','js/data/weights/estimator_weights.js',
  'js/data/weights/nn_combat_weights.js','js/data/weights/upgrade_advisor_weights.js',
  'js/engine/combat_estimator.js','js/engine/combat_nn.js','js/engine/rl_combat.js',
  'js/engine/upgrade_advisor.js','js/engine/inventory_manager.js','js/engine/bot.js',
];
const fileSrc = {};
for (const f of LOAD_ORDER) fileSrc[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

const KING_STUB = `const KingBattle = (() => {
  let _w = null, _l = null;
  return {
    init: (p, w, l) => { _w = w; _l = l; },
    resolveWin: () => { const f = _w; _w = null; _l = null; if (f) f(); },
    clearState: () => { _w = null; _l = null; },
    getState: () => ({}),
  };
})();`;

function makeSandbox() {
  const sb = {
    Math, Array, Float32Array, Uint8Array, Int32Array, Uint16Array, ArrayBuffer,
    Object, JSON, Set, Map, Date, RegExp, String, Number, Boolean, Error,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    console: { log: () => {}, warn: () => {}, error: console.error.bind(console) },
    setTimeout: () => {}, clearTimeout: () => {},
    window: {}, document: { getElementById: () => null },
  };
  vm.createContext(sb);
  vm.runInContext(KING_STUB, sb);
  for (const f of LOAD_ORDER) vm.runInContext(fileSrc[f], sb);
  return sb;
}

const MAX_TURNS = 1500;

const sb    = makeSandbox();
const Game  = vm.runInContext('Game', sb);
const BotAI = vm.runInContext('BotAI', sb);
const KB    = vm.runInContext('KingBattle', sb);
const CE    = vm.runInContext('CombatEstimator', sb);
const Ph    = Game.Phase;

const players = [
  { id: 'p0', name: 'Bot1', isBot: true },
  { id: 'p1', name: 'Bot2', isBot: true },
];

const queue  = [];
const events = [];
let result   = null;
let turns    = 0;

// Phase snapshot every 100 bot-turns
const snapshots = {};

function enqBot(p) { if (p && p.isBot) queue.push(() => BotAI.takeTurn(p)); }

Game.on('state_change', () => {
  if (result) return;
  const st = Game.getState(), ph = st.phase;
  if (ph === Ph.GAME_OVER) return;
  if (ph === Ph.SETUP_ROLL) {
    const sp = st.players[st.setupRollIdx];
    if (sp && sp.isBot) queue.push(() => Game.submitAction({ type: 'setup_roll' }));
    return;
  }
  if (ph === Ph.KING_BATTLE) { queue.push(() => KB.resolveWin()); return; }
  if (ph === Ph.ROLL_MOVE) turns++;
  enqBot(Game.getCurrentPlayer());
});

Game.on('combat_update', data => {
  if (result) return;
  if (data.outcome === 'ongoing' || data.outcome === 'charisma_pending')
    enqBot(Game.getCurrentPlayer());
});

const reAny = () => { if (!result) enqBot(Game.getCurrentPlayer()); };
Game.on('shop_transaction', reAny);
Game.on('item_equipped', reAny);
Game.on('item_unequipped', reAny);
Game.on('skill_upgraded', reAny);
Game.on('enchanted', reAny);

Game.on('log', data => {
  const m = data.message || '';
  if (/dragon|princess|wins|boss|kills|master|enchant|guild|Lv\.|tier/i.test(m))
    events.push('[T' + turns + '] ' + m.slice(0, 100));
});

Game.on('game_over', data => { result = data; });

// Periodic snapshot of bot phases
function snapshot() {
  const st = Game.getState();
  const snap = st.players.map(p => ({
    name: p.name,
    phase: BotAI.getPhase(p),
    pos: p.position,
    H: p.hearts && (p.hearts.current + '/' + p.hearts.max),
    coins: p.coins,
    effF: p.getStat && p.getStat('F'),
    effD: p.getStat && p.getStat('D'),
    effM: p.getStat && p.getStat('M'),
    effC: p.getStat && p.getStat('C'),
  }));
  snapshots[turns] = snap;
}

Game.init(players, 'medium');

let steps = 0;
while (!result && queue.length > 0 && steps < 1000000 && turns < MAX_TURNS) {
  const fn = queue.shift();
  try { fn(); } catch (e) {
    events.push('ERR at T' + turns + ': ' + e.message + '\n' + e.stack);
    result = { winner: null, _err: e.message };
    break;
  }
  steps++;
  if (turns % 100 === 0 && !snapshots[turns]) snapshot();
}

// Final player dump
const finalState = Game.getState();
console.log('\n=== FINAL STATE (turns=' + turns + ') ===');
finalState.players.forEach(p => {
  let drWin = 'n/a';
  try { const dr = CE.estimateBoss(p, 'dragon', 300); drWin = Math.round(dr.winProb * 100) + '%'; } catch(e) {}
  console.log(p.name + '  phase=' + BotAI.getPhase(p) + '  H=' + p.hearts.current + '/' + p.hearts.max + '  coins=' + p.coins);
  console.log('  base=' + JSON.stringify(p.baseStats));
  console.log('  eff  F=' + p.getStat('F') + ' D=' + p.getStat('D') + ' M=' + p.getStat('M') + ' C=' + p.getStat('C') + ' A=' + p.getStat('A') + ' V=' + p.getStat('V'));
  console.log('  equipped=[' + Object.entries(p.equipped || {}).filter(([,v]) => v).map(([k, v]) => k + ':' + v.id + (v.enchantment ? '[' + v.enchantment.id + ']' : '')).join(', ') + ']');
  console.log('  inv=[' + (p.inventory || []).join(', ') + ']');
  console.log('  dragonWinProb=' + drWin);
});

console.log('\nresult=' + (result ? (result.winner ? result.winner.name + ' wins' : 'no winner') : 'timeout'));
console.log('steps=' + steps);

console.log('\n=== PHASE SNAPSHOTS ===');
for (const t of Object.keys(snapshots).sort((a,b) => +a - +b)) {
  process.stdout.write('T' + t + ': ');
  snapshots[t].forEach(p => process.stdout.write(p.name + '=' + p.phase + ' H=' + p.H + ' pos=(' + (p.pos?.x ?? '?') + ',' + (p.pos?.y ?? '?') + ') '));
  process.stdout.write('\n');
}

console.log('\n=== KEY EVENTS ===');
events.slice(-60).forEach(e => console.log(e));
