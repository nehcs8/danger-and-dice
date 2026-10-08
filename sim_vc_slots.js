#!/usr/bin/env node
'use strict';

/**
 * sim_vc_slots.js
 *
 * Sweeps enchantment choices on the 4th (Speed/pegasus) and 5th (Charisma/accordion)
 * equipment slots for each archetype's best 3-slot build from sim_dragon.js.
 *
 * Key rule from player.js getStat():
 *   stat_bonus enchants (sharpness +3F, precision +3D, resistance +3A) STACK per item.
 *   Boolean enchants (thorns, arcane, fury, hawk_eye, flame, bloodlust) do NOT stack —
 *   having one instance is enough; a second is wasted.
 *
 * So useful NEW enchants on V/C items are:
 *   - resistance (+3A) — always stacks with existing resistance on armor
 *   - sharpness (+3F)  — stacks with weapon's sharpness (F builds)
 *   - precision (+3D)  — stacks with weapon's precision (D builds)
 *   - arcane    — only if NOT already equipped elsewhere
 *   - fury      — only if NOT already equipped elsewhere
 *   - hawk_eye  — only if NOT already equipped elsewhere
 *   - flame     — only if NOT already equipped elsewhere
 *   - thorns    — already on shield in best builds → WASTED (shown as sanity check)
 *   - null      — equip item, no enchant (pure +6V or +6C stat bonus only)
 *
 * Usage:
 *   node sim_vc_slots.js [N_FIGHTS]    default: 150
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname);
const JS   = path.join(ROOT, 'js');

// ── Sandbox ───────────────────────────────────────────────────────────────────

const sandbox = {
  Math, Array, Float32Array, Uint8Array, Int32Array, Uint16Array, ArrayBuffer,
  Object, JSON, Set, Map, Date, RegExp, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
  console: { log: () => {}, warn: () => {}, error: console.error.bind(console) },
  setTimeout: () => {}, clearTimeout: () => {},
  window: {},
  Game: { emit: () => {}, getState: () => ({}) },
};
vm.createContext(sandbox);

function load(relPath) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, relPath), 'utf8'), sandbox);
}
function get(name) { return vm.runInContext(name, sandbox); }

load('js/engine/dice.js');
load('js/data/items.js');
load('js/data/mobs.js');
load('js/engine/player.js');
load('js/engine/combat.js');

const weightsPath = path.join(JS, 'data/weights/nn_combat_weights.js');
if (fs.existsSync(weightsPath)) load('js/data/weights/nn_combat_weights.js');
load('js/engine/combat_nn.js');

const MOBS          = get('MOBS');
const Player        = get('Player');
const Combat        = get('Combat');
const ENCHANTMENTS  = get('ENCHANTMENTS');
const ITEM_REGISTRY = get('ITEM_REGISTRY');
const getItem       = get('getItem');
const CombatNN      = get('CombatNN');

// ── Base builds (best 3-slot combo per archetype from sim_dragon.js) ──────────
// F: sharpness / resistance / thorns  (91.3%)
// D: precision / lightness  / thorns  (90.0%)
// M: flame     / lightness  / thorns  (97.3%)

const HEAL_STACK  = ['pot_heal','pot_heal','pot_heal','pot_heal','pot_heal'];
const SMOKE_STACK = ['sp_smoke','sp_smoke','sp_smoke'];

const BASE_BUILDS = {
  F: {
    stats: { F:6, D:3, A:6, M:2, C:4, V:5 },
    hp: 10,
    coreEquip: [
      { id:'halberd',  enchId:'sharpness' },
      { id:'hv_armor', enchId:'resistance' },
      { id:'lg_shield',enchId:'thorns' },
    ],
    inv: [
      ...HEAL_STACK, ...SMOKE_STACK,
      'pot_F3','pot_F3','pot_F3',
      'pot_A3','pot_A3','pot_A3',
    ],
    bloodBonus: { F:2, M:2, V:2 },
    priestBuff: 4,
    // enchants already in use (adding these to V/C would waste the slot):
    usedEnchants: new Set(['sharpness','resistance','thorns']),
  },
  D: {
    stats: { F:3, D:6, A:6, M:2, C:4, V:6 },
    hp: 10,
    coreEquip: [
      { id:'arquebus', enchId:'precision' },
      { id:'hv_armor', enchId:'lightness' },
      { id:'lg_shield',enchId:'thorns' },
    ],
    inv: [
      ...HEAL_STACK, ...SMOKE_STACK,
      'pot_D3','pot_D3','pot_D3',
      'pot_A3','pot_A3','pot_A3',
    ],
    bloodBonus: { D:2, V:2 },
    priestBuff: 4,
    usedEnchants: new Set(['precision','lightness','thorns']),
  },
  M: {
    stats: { F:2, D:2, A:6, M:6, C:4, V:5 },
    hp: 10,
    coreEquip: [
      { id:'grimoire', enchId:'flame' },
      { id:'hv_armor', enchId:'lightness' },
      { id:'lg_shield',enchId:'thorns' },
    ],
    inv: [
      ...HEAL_STACK, ...SMOKE_STACK,
      'pot_M3','pot_M3','pot_M3',
      'pot_A3','pot_A3','pot_A3',
      'blaze','blaze','blaze','blaze','blaze',
      'blaze','blaze','blaze','blaze','blaze',
      'rend','rend','rend','rend','rend',
    ],
    bloodBonus: { F:2, M:2, V:2 },
    priestBuff: 4,
    usedEnchants: new Set(['flame','lightness','thorns']),
  },
};

// ── Enchant options for V / C slots ───────────────────────────────────────────
//
// null   = equip item but no enchant  (pure stat boost: +6V or +6C)
// Listed roughly from "likely useful" to "likely wasted"

const V_ENCHANTS = [
  null,          // no enchant — just +6V (better initiative, D defense)
  'resistance',  // +3A per item — STACKS with armor's resistance
  'sharpness',   // +3F — STACKS with weapon's sharpness (F builds)
  'precision',   // +3D — STACKS with weapon's precision (D builds)
  'arcane',      // magic def via A — NEW effect if not already used
  'fury',        // −1A/hit on mob — NEW if not already used
  'hawk_eye',    // −1V/hit on mob — NEW if not already used
  'flame',       // fire DoT on hit — NEW if not already used
  'thorns',      // 30% reflect — ALREADY on shield → wasted (sanity check)
];

const C_ENCHANTS = [
  null,
  'resistance',
  'sharpness',
  'precision',
  'arcane',
  'fury',
  'hawk_eye',
  'flame',
  'thorns',
];

function enchLabel(e) {
  if (e === null) return 'plain';
  return e;
}

// ── Generate full V × C enchant matrix per archetype ─────────────────────────

function genBuilds() {
  const builds = [];
  for (const [arch, base] of Object.entries(BASE_BUILDS)) {
    for (const ve of V_ENCHANTS) {
      for (const ce of C_ENCHANTS) {
        const equip = [
          ...base.coreEquip,
          { id:'pegasus',   enchId: ve },
          { id:'accordion', enchId: ce },
        ];
        // Annotate whether each enchant is new vs already used
        const veNew = ve === null || !base.usedEnchants.has(ve);
        const ceNew = ce === null || !base.usedEnchants.has(ce);
        const wasted = [];
        if (ve && !veNew) wasted.push(`V:${ve}↻`);
        if (ce && !ceNew) wasted.push(`C:${ce}↻`);

        builds.push({
          arch,
          vEnch: ve,
          cEnch: ce,
          name: `${arch}  V:${enchLabel(ve).padEnd(9)} C:${enchLabel(ce)}`,
          wasted,
          ...base,
          equip,
        });
      }
    }
  }
  return builds;
}

// ── Player factory ─────────────────────────────────────────────────────────────

function buildPlayer(b) {
  const p     = new Player({ id: 'sim', name: 'SimBot', isBot: true });
  p.baseStats = { ...b.stats };
  p.hearts    = { current: b.hp, max: b.hp };

  for (const eSpec of (b.equip ?? [])) {
    const tmpl = ITEM_REGISTRY[eSpec.id];
    if (!tmpl) { process.stderr.write(`[warn] unknown item: ${eSpec.id}\n`); continue; }
    const item = JSON.parse(JSON.stringify(tmpl));
    p.inventory.push(item.id);
    if (!p.equip(item)) { process.stderr.write(`[warn] could not equip ${eSpec.id}\n`); continue; }
    if (eSpec.enchId) {
      const enchObj = ENCHANTMENTS.find(e => e.id === eSpec.enchId);
      if (enchObj) p.applyEnchantment(item.slot, enchObj, 1);
    }
  }

  for (const id of (b.inv ?? [])) p.inventory.push(id);

  if (b.bloodBonus) {
    for (const [s, v] of Object.entries(b.bloodBonus))
      p.baseStats[s] = (p.baseStats[s] ?? 0) + v;
  }
  if (b.priestBuff > 0) p.priestBuff = b.priestBuff;

  return p;
}

// ── Greedy attack + emergency heal ────────────────────────────────────────────

function bestAttackAction(player, mob) {
  const defs = { F:'A', D:'V', M:'M', C:'C' };
  const canM = player.canAttackMagic();
  const avail = ['F','D','C'].concat(canM ? ['M'] : []);
  let best = avail[0], bestScore = -Infinity;
  for (const t of avail) {
    const s = player.getStat(t) - (mob.stats[defs[t]] ?? 0);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  let spellId = null;
  if (best === 'M') {
    const spell = player.inventory
      .map(id => getItem(id))
      .filter(i => i?.subtype === 'attack')
      .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
    spellId = spell?.id ?? null;
  }
  if (best === 'C') return { type: 'attack', attackType: 'F', spellId: null };
  return { type: 'attack', attackType: best, spellId };
}

const HEAL_THRESHOLD = 0.40;

function choosePlayerAction(player, mob, preAtk) {
  const hpFrac = player.hearts.current / player.hearts.max;
  if (hpFrac <= HEAL_THRESHOLD && player.inventory.includes('pot_heal')) {
    return { type: '__heal__' };
  }
  if (player.hearts.current <= 1 && player.inventory.includes('sp_smoke')) {
    return { type: '__smoke__' };
  }
  const action = CombatNN.chooseAction(player, mob, preAtk);
  if (action?.type === 'bail' || action?.type === 'run') {
    return bestAttackAction(player, mob);
  }
  return action;
}

// ── Single fight ──────────────────────────────────────────────────────────────

const MAX_ROUNDS = 120;

function simulateFight(build) {
  const player = buildPlayer(build);
  const mob    = MOBS.spawn('dragon');
  const log    = [];
  const consumables = {};

  const init = Combat.initFight(player, mob);
  log.push(...(init.log ?? []));
  if (init.outcome === 'victory') return { outcome:'win',  halfTurns:0, consumablesUsed:{} };
  if (init.outcome === 'defeat')  return { outcome:'loss', halfTurns:0, consumablesUsed:{} };

  let playerTurn = init.playerFirst;

  for (let ht = 0; ht < MAX_ROUNDS * 2; ht++) {
    let result;

    if (playerTurn) {
      const invSnap = [...player.inventory];
      const preAtk  = Combat.rollMobAttack(mob);
      const action  = choosePlayerAction(player, mob, preAtk);

      if (action.type === '__heal__') {
        player.removeItem('pot_heal');
        player.healHeart(1);
        consumables['pot_heal'] = (consumables['pot_heal'] ?? 0) + 1;
        result = Combat.takePlayerAttack(player, mob, bestAttackAction(player, mob), log);
      } else if (action.type === '__smoke__') {
        player.removeItem('sp_smoke');
        player.isSmokeActive = true;
        consumables['sp_smoke'] = (consumables['sp_smoke'] ?? 0) + 1;
        result = Combat.takePlayerAttack(player, mob, bestAttackAction(player, mob), log);
      } else {
        result = Combat.takePlayerAttack(player, mob, action, log);
        const gone = invSnap.filter(id => {
          return player.inventory.filter(x => x === id).length <
                 invSnap.filter(x => x === id).length;
        });
        for (const id of gone) consumables[id] = (consumables[id] ?? 0) + 1;
      }
    } else {
      const preAtk = Combat.rollMobAttack(mob);
      result = Combat.takeMobAttack(player, mob, log, preAtk);
    }

    if (result.outcome === 'victory' || result.outcome === 'defeat' || result.outcome === 'escaped') {
      return { outcome: result.outcome === 'victory' ? 'win' : result.outcome,
               halfTurns: ht + 1, consumablesUsed: consumables };
    }
    if (result.outcome === 'charisma_pending') {
      Combat.applyCharismaOutcome(player, mob, { family:'mock', tier:2, stat:'F' }, result.charismaResult, log);
    }

    playerTurn = !playerTurn;
  }
  return { outcome:'timeout', halfTurns: MAX_ROUNDS * 2, consumablesUsed: consumables };
}

function runBuild(build, N) {
  const stats = { win:0, loss:0, escaped:0, timeout:0, halfTurns:[] };
  for (let i = 0; i < N; i++) {
    const r = simulateFight(build);
    stats[r.outcome] = (stats[r.outcome] ?? 0) + 1;
    if (r.outcome === 'win') stats.halfTurns.push(r.halfTurns);
  }
  const avgRnd = stats.halfTurns.length
    ? (stats.halfTurns.reduce((a,b) => a+b, 0) / stats.halfTurns.length / 2).toFixed(1)
    : '—';
  return { win: stats.win, total: N, winPct: parseFloat(((stats.win/N)*100).toFixed(1)), avgRnd };
}

// ── Main ───────────────────────────────────────────────────────────────────────

const N      = parseInt(process.argv[2] ?? '150', 10);
const BUILDS = genBuilds();

console.log(`\n${'═'.repeat(70)}`);
console.log(`  V/C Slot Enchant Sweep — ${N} fights × ${BUILDS.length} builds`);
console.log(`  Base: best 3-slot combo per archetype + pegasus + accordion`);
console.log(`${'═'.repeat(70)}\n`);

// Collect results per archetype
const byArch = { F: [], D: [], M: [] };

for (const build of BUILDS) {
  process.stdout.write(`  ${build.name}  ...`);
  const res = runBuild(build, N);
  process.stdout.write(`\r  ${build.name}  ${String(res.winPct+'%').padStart(6)}\n`);
  byArch[build.arch].push({ ...res, vEnch: build.vEnch, cEnch: build.cEnch, wasted: build.wasted });
}

// ── Per-archetype matrix tables ────────────────────────────────────────────────

for (const arch of ['F', 'D', 'M']) {
  const results = byArch[arch];
  const vOpts = V_ENCHANTS;
  const cOpts = C_ENCHANTS;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Archetype ${arch}  — Win% matrix  (rows = V/pegasus, cols = C/accordion)`);
  console.log(`  Base 3-slot: ${arch === 'F' ? 'halberd+sharp / hv_armor+res / lg_shield+thorns' :
                                arch === 'D' ? 'arquebus+prec / hv_armor+light / lg_shield+thorns' :
                                               'grimoire+flame / hv_armor+light / lg_shield+thorns'}`);
  console.log(`${'─'.repeat(70)}`);

  // Column header
  const colW = 7;
  const rowLabel = 'V \\ C'.padEnd(11);
  const header = cOpts.map(c => enchLabel(c ?? '').slice(0,colW-1).padStart(colW)).join('');
  console.log(`  ${rowLabel}${header}`);
  console.log(`  ${'-'.repeat(11 + colW * cOpts.length)}`);

  for (const ve of vOpts) {
    const cells = cOpts.map(ce => {
      const r = results.find(x => x.vEnch === ve && x.cEnch === ce);
      if (!r) return '     ?'.padStart(colW);
      const pct = r.winPct.toFixed(0) + '%';
      // Mark wasted enchants with *
      const isWasted = (ve !== null && BASE_BUILDS[arch].usedEnchants.has(ve)) ||
                       (ce !== null && BASE_BUILDS[arch].usedEnchants.has(ce));
      return (isWasted ? pct+'*' : pct).padStart(colW);
    }).join('');
    console.log(`  ${enchLabel(ve ?? '').padEnd(11)}${cells}`);
  }

  // Sorted top rows for this archetype
  const sorted = [...results].sort((a, b) => b.winPct - a.winPct);
  console.log('');
  console.log(`  Top 5 for ${arch}:`);
  for (const r of sorted.slice(0, 5)) {
    const wNote = r.wasted.length ? `  [wasted: ${r.wasted.join(', ')}]` : '';
    const bar = '█'.repeat(Math.round(r.winPct / 5));
    console.log(`    V:${enchLabel(r.vEnch ?? '').padEnd(9)} C:${enchLabel(r.cEnch ?? '').padEnd(9)}  ${String(r.winPct+'%').padStart(6)}  rnd:${r.avgRnd}  ${bar}${wNote}`);
  }

  // Baseline (no enchants)
  const baseline = results.find(r => r.vEnch === null && r.cEnch === null);
  if (baseline) {
    console.log(`  Baseline (plain pegasus + accordion, no enchants): ${baseline.winPct}%  avg ${baseline.avgRnd} rnd`);
  }
}

// ── Overall top-10 ─────────────────────────────────────────────────────────────

const allResults = Object.entries(byArch).flatMap(([arch, rows]) =>
  rows.map(r => ({ ...r, arch }))
).sort((a, b) => b.winPct - a.winPct);

console.log(`\n${'═'.repeat(70)}`);
console.log('  TOP 10 overall (full 5-slot build)');
console.log(`${'═'.repeat(70)}`);
for (const r of allResults.slice(0, 10)) {
  const wNote = r.wasted.length ? ` [wasted: ${r.wasted.join(', ')}]` : '';
  const bar = '█'.repeat(Math.round(r.winPct / 5));
  console.log(`  ${r.arch}  V:${enchLabel(r.vEnch ?? '').padEnd(9)} C:${enchLabel(r.cEnch ?? '').padEnd(9)} ${String(r.winPct+'%').padStart(7)}  ${bar}${wNote}`);
}
console.log(`${'═'.repeat(70)}\n`);

console.log('  * = enchant already used on another item — boolean, does not stack');
console.log('  (resistance, sharpness, precision are stat_bonus enchants and DO stack)\n');
