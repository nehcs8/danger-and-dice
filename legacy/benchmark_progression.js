#!/usr/bin/env node
'use strict';

/**
 * benchmark_progression.js
 *
 * Runs the NN combat model across 20 player progression states against all
 * regular mobs in each tier (6 per tier × 4 tiers × 50 fights each = 12 000
 * fights per state, 240 000 total).
 *
 * Build profile: balanced F-fighter (Strength primary, Armor secondary).
 * Base stats fixed at sum = 16 {F:3, D:3, A:3, M:3, C:2, V:2}; skills and
 * gear added cumulatively across states.
 *
 * Output:
 *   benchmark_results.json   — full per-mob breakdown for bot decision-making
 *   (console summary table also printed at end)
 *
 * Usage:  node benchmark_progression.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── vm sandbox ───────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname);
const JS   = path.join(ROOT, 'js');

const sandbox = {
  Math, Array, Float32Array, Uint8Array, Int32Array,
  Object, JSON, Set, Map, Date,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
  console, undefined,
  setTimeout: () => {}, clearTimeout: () => {},
  window: {},
  Game: { emit: () => {}, getState: () => ({}) },
};
vm.createContext(sandbox);

function load(filePath) {
  vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox);
}
function get(name) { return vm.runInContext(name, sandbox); }

load(path.join(JS, 'engine/dice.js'));
load(path.join(JS, 'data/items.js'));
load(path.join(JS, 'data/mobs.js'));
load(path.join(JS, 'engine/player.js'));
load(path.join(JS, 'engine/combat.js'));

// Load NN weights then model (weights must be defined first so autoLoad() works)
const weightsPath = path.join(JS, 'data/weights/nn_combat_weights.js');
if (fs.existsSync(weightsPath)) {
  load(weightsPath);
} else {
  console.warn('[warn] nn_combat_weights.js not found — NN will use rule-based fallback');
}
load(path.join(JS, 'engine/combat_nn.js'));

const Dice         = get('Dice');
const MOBS         = get('MOBS');
const Player       = get('Player');
const Combat       = get('Combat');
const getItem      = get('getItem');        // eslint-disable-line no-unused-vars
const ENCHANTMENTS = get('ENCHANTMENTS');
const ITEM_REGISTRY = get('ITEM_REGISTRY');
const CombatNN     = get('CombatNN');

// ── Tier pools — 6 named mobs per tier (no bosses, no animals) ──────────────

const TIER_MOBS = {
  0: MOBS.list.filter(m => m.tier === 0 && !m.isBoss && !m.isAnimal),
  1: MOBS.list.filter(m => m.tier === 1 && !m.isBoss && !m.isAnimal),
  2: MOBS.list.filter(m => m.tier === 2 && !m.isBoss && !m.isAnimal),
  3: MOBS.list.filter(m => m.tier === 3 && !m.isBoss && !m.isAnimal),
};

// Sanity-check that each tier really has 6 mobs
for (const [t, pool] of Object.entries(TIER_MOBS)) {
  if (pool.length !== 6)
    console.warn(`[warn] tier ${t} has ${pool.length} mobs (expected 6): ${pool.map(m => m.id).join(', ')}`);
}

// ── Progression states ────────────────────────────────────────────────────────
//
// Structure: a grid of (base stat sum) × (equipment loadout).
// This lets the output answer "at stat level X, what should I buy?"
//
// Block A — [s16]  sum=16  pure equipment grid, 23 states
// Block B — [s18]  sum=18  +2 skills, key combos,  5 states
// Block C — [s20]  sum=20  +4 skills,              4 states
// Block D — [s22]  sum=22  +6 skills,              3 states
// Block E — [s24]  sum=24  +8 skills,              2 states
// Block F — [s28]  sum=28  +12 skills,             2 states
// Block G — [s32]  sum=32  +16 skills,             2 states
// Block H — [s36–s50] endgame,                     4 states
//
// equip: items moved into equipped slots  { id, ench?: { id, tier } }
// inv:   item IDs pushed to inventory     (potions, spells, escape items)
// Slot limit: MAX_EQUIPPED = 5.  hv_armor: A+6 V−2; lightness removes V−2.

// ─── Base stat sets (sum labelled) ─────────────────────────────────────────
const s16 = { F:3, D:3, A:3, M:3, C:2, V:2 };   // sum 16 — starting roll
const s18 = { F:4, D:3, A:4, M:3, C:2, V:2 };   // sum 18 — +2 skills
const s20 = { F:4, D:3, A:5, M:3, C:2, V:3 };   // sum 20 — +4 skills
const s22 = { F:5, D:3, A:5, M:3, C:2, V:4 };   // sum 22 — +6 skills
const s24 = { F:6, D:3, A:5, M:3, C:2, V:5 };   // sum 24 — +8 skills
const s28 = { F:7, D:4, A:6, M:3, C:2, V:6 };   // sum 28 — +12 skills
const s32 = { F:8, D:5, A:7, M:3, C:2, V:7 };   // sum 32 — +16 skills
const s36 = { F:9, D:6, A:7, M:4, C:2, V:8 };   // sum 36 — +20 skills
const s44 = { F:11, D:7, A:9, M:6, C:2, V:9 };  // sum 44 — +28 skills
const s50 = { F:12, D:9, A:10, M:7, C:3, V:9 }; // sum 50 — near-max

// ─── Shared full-potion inventory ──────────────────────────────────────────
const FULL_POTS = [
  'pot_F3','pot_F3','pot_F3',
  'pot_D3','pot_D3','pot_D3',
  'pot_M3','pot_M3','pot_M3',
  'pot_C3','pot_C3','pot_C3',
  'pot_heal','pot_heal','pot_heal',
];

const STATES = [

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK A — [s16]  sum=16, base stats only, varying equipment
  // Goal: isolate the value of each item type and tier at the starting stat floor
  // ════════════════════════════════════════════════════════════════════════════

  // — Baseline ────────────────────────────────────────────────────────────────
  { level: 0,  label:'[s16] Naked',                             base:s16, equip:[], inv:[] },
  { level: 1,  label:'[s16] +Rope (escape tool)',               base:s16, equip:[], inv:['rope'] },

  // — Offense only (weapon tiers, no armor) ───────────────────────────────────
  { level: 2,  label:'[s16] Knife only (10g, F+1)',             base:s16, equip:[{id:'knife'}],      inv:[] },
  { level: 3,  label:'[s16] Sword only (20g, F+2)',             base:s16, equip:[{id:'sword'}],      inv:[] },
  { level: 4,  label:'[s16] Mace only (30g, F+3)',              base:s16, equip:[{id:'mace'}],       inv:[] },
  { level: 5,  label:'[s16] Axe only (40g, F+4)',               base:s16, equip:[{id:'axe'}],        inv:[] },

  // — Defense only (armor tiers, no weapon) ───────────────────────────────────
  { level: 6,  label:'[s16] Jacket only (10g, A+1)',            base:s16, equip:[{id:'jacket'}],     inv:[] },
  { level: 7,  label:'[s16] Light Armor only (20g, A+2)',       base:s16, equip:[{id:'lt_armor'}],   inv:[] },
  { level: 8,  label:'[s16] Med Armor only (30g, A+4 V-1)',     base:s16, equip:[{id:'md_armor'}],   inv:[] },
  { level: 9,  label:'[s16] Hv Armor only (40g, A+6 V-2)',      base:s16, equip:[{id:'hv_armor'}],   inv:[] },

  // — Speed / Ranged only ──────────────────────────────────────────────────────
  { level:10,  label:'[s16] Shoes only (10g, V+1)',             base:s16, equip:[{id:'shoes'}],      inv:[] },
  { level:11,  label:'[s16] Bow only (20g, D+2)',               base:s16, equip:[{id:'bow'}],        inv:[] },

  // — Weapon + Armor combos (escalating budget) ────────────────────────────────
  //   Same-cost pairs let you compare offense vs defence priority directly
  { level:12,  label:'[s16] Sword+Jacket (30g)',                base:s16, equip:[{id:'sword'},{id:'jacket'}],   inv:[] },
  { level:13,  label:'[s16] Sword+Lt Armor (40g)',              base:s16, equip:[{id:'sword'},{id:'lt_armor'}], inv:[] },
  { level:14,  label:'[s16] Mace+Jacket (40g)',                 base:s16, equip:[{id:'mace'},{id:'jacket'}],    inv:[] },
  { level:15,  label:'[s16] Mace+Lt Armor (50g)',               base:s16, equip:[{id:'mace'},{id:'lt_armor'}],  inv:[] },
  { level:16,  label:'[s16] Mace+Med Armor (60g)',              base:s16, equip:[{id:'mace'},{id:'md_armor'}],  inv:[] },
  { level:17,  label:'[s16] Axe+Lt Armor (60g)',                base:s16, equip:[{id:'axe'},{id:'lt_armor'}],   inv:[] },
  { level:18,  label:'[s16] Axe+Med Armor (70g)',               base:s16, equip:[{id:'axe'},{id:'md_armor'}],   inv:[] },

  // — 3-slot and 4-slot builds ─────────────────────────────────────────────────
  { level:19,  label:'[s16] Axe+Med Armor+Boots (90g)',
    base:s16, equip:[{id:'axe'},{id:'md_armor'},{id:'boots'}], inv:[] },
  { level:20,  label:'[s16] Axe+Med Armor+Boots+Longbow (120g)',
    base:s16, equip:[{id:'axe'},{id:'md_armor'},{id:'boots'},{id:'longbow'}], inv:[] },
  { level:21,  label:'[s16] Greatsword+Med Armor+Boots+Longbow (140g)',
    base:s16, equip:[{id:'greatsword'},{id:'md_armor'},{id:'boots'},{id:'longbow'}], inv:[] },

  // — Consumable value at s16 ──────────────────────────────────────────────────
  { level:22,  label:'[s16] Sword+Lt Armor+1×Heal (40g+50g)',
    base:s16, equip:[{id:'sword'},{id:'lt_armor'}], inv:['pot_heal'] },
  { level:23,  label:'[s16] Axe+Med Armor+2×Heal (70g+100g)',
    base:s16, equip:[{id:'axe'},{id:'md_armor'}],   inv:['pot_heal','pot_heal'] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK B — [s18]  sum=18, +2 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:24,  label:'[s18] Naked',
    base:s18, equip:[], inv:[] },
  { level:25,  label:'[s18] Sword+Lt Armor',
    base:s18, equip:[{id:'sword'},{id:'lt_armor'}], inv:[] },
  { level:26,  label:'[s18] Axe+Med Armor',
    base:s18, equip:[{id:'axe'},{id:'md_armor'}], inv:[] },
  { level:27,  label:'[s18] Axe+Med Armor+Boots',
    base:s18, equip:[{id:'axe'},{id:'md_armor'},{id:'boots'}], inv:[] },
  { level:28,  label:'[s18] Axe+Med Armor+Boots+Longbow',
    base:s18, equip:[{id:'axe'},{id:'md_armor'},{id:'boots'},{id:'longbow'}], inv:[] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK C — [s20]  sum=20, +4 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:29,  label:'[s20] Naked',
    base:s20, equip:[], inv:[] },
  { level:30,  label:'[s20] Axe+Med Armor',
    base:s20, equip:[{id:'axe'},{id:'md_armor'}], inv:[] },
  { level:31,  label:'[s20] Axe+Med Armor+Boots',
    base:s20, equip:[{id:'axe'},{id:'md_armor'},{id:'boots'}], inv:[] },
  { level:32,  label:'[s20] Greatsword+Hv Armor+Horse+Crossbow',
    base:s20, equip:[{id:'greatsword'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'}], inv:[] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK D — [s22]  sum=22, +6 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:33,  label:'[s22] Axe+Hv Armor+Horse+Crossbow',
    base:s22, equip:[{id:'axe'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'}], inv:[] },
  { level:34,  label:'[s22] Greatsword+Hv Armor+Horse+Crossbow',
    base:s22, equip:[{id:'greatsword'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'}], inv:[] },
  { level:35,  label:'[s22] Greatsword+Hv Armor+Horse+Crossbow+Necklace (5 slots)',
    base:s22, equip:[{id:'greatsword'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'},{id:'necklace'}], inv:[] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK E — [s24]  sum=24, +8 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:36,  label:'[s24] Greatsword+Hv Armor+Horse+Crossbow+Necklace',
    base:s24, equip:[{id:'greatsword'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'},{id:'necklace'}], inv:[] },
  { level:37,  label:'[s24] same + 3×F2 3×D2 3×heal',
    base:s24,
    equip:[{id:'greatsword'},{id:'hv_armor'},{id:'horse'},{id:'crossbow'},{id:'necklace'}],
    inv:['pot_F2','pot_F2','pot_F2','pot_D2','pot_D2','pot_D2','pot_heal','pot_heal','pot_heal'] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK F — [s28]  sum=28, +12 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:38,  label:'[s28] Halberd+Hv Armor+Carriage+Arquebus+Orb',
    base:s28, equip:[{id:'halberd'},{id:'hv_armor'},{id:'carriage'},{id:'arquebus'},{id:'orb'}], inv:[] },
  { level:39,  label:'[s28] same + 3×F3 3×D3 3×M2 3×heal',
    base:s28,
    equip:[{id:'halberd'},{id:'hv_armor'},{id:'carriage'},{id:'arquebus'},{id:'orb'}],
    inv:['pot_F3','pot_F3','pot_F3','pot_D3','pot_D3','pot_D3','pot_M2','pot_M2','pot_M2','pot_heal','pot_heal','pot_heal'] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK G — [s32]  sum=32, +16 skills
  // ════════════════════════════════════════════════════════════════════════════

  { level:40,  label:'[s32] Halberd+Hv Armor+Carriage+Arquebus+Grimoire + full pots',
    base:s32,
    equip:[{id:'halberd'},{id:'hv_armor'},{id:'carriage'},{id:'arquebus'},{id:'grimoire'}],
    inv:[...FULL_POTS] },
  { level:41,  label:'[s32] same + Sharpness+Precision+Resistance enchants + Blaze×2',
    base:s32,
    equip:[
      {id:'halberd',  ench:{id:'sharpness',  tier:1}},
      {id:'hv_armor', ench:{id:'resistance', tier:1}},
      {id:'carriage'},
      {id:'arquebus', ench:{id:'precision',  tier:1}},
      {id:'grimoire'},
    ],
    inv:[...FULL_POTS,'blaze','blaze'] },

  // ════════════════════════════════════════════════════════════════════════════
  // BLOCK H — [s36–s50]  endgame
  // ════════════════════════════════════════════════════════════════════════════

  { level:42,  label:'[s36] Fury(t2)+HawkEye(t2)+Lightness + full pots + Blaze×3',
    base:s36,
    equip:[
      {id:'halberd',  ench:{id:'sharpness', tier:1}},
      {id:'hv_armor', ench:{id:'fury',      tier:2}},
      {id:'carriage', ench:{id:'lightness', tier:1}},
      {id:'arquebus', ench:{id:'hawk_eye',  tier:2}},
      {id:'grimoire'},
    ],
    inv:[...FULL_POTS,'blaze','blaze','blaze'] },

  { level:43,  label:'[s44] Bloodlust+Fury(t3)+HawkEye(t3)+Arcane + full pots + Blaze×3 + Smoke×2',
    base:s44,
    equip:[
      {id:'halberd',  ench:{id:'bloodlust', tier:1}},
      {id:'hv_armor', ench:{id:'fury',      tier:3}},
      {id:'carriage', ench:{id:'lightness', tier:1}},
      {id:'arquebus', ench:{id:'hawk_eye',  tier:3}},
      {id:'grimoire', ench:{id:'arcane',    tier:1}},
    ],
    inv:[...FULL_POTS,'blaze','blaze','blaze','sp_smoke','sp_smoke'] },

  { level:44,  label:'[s50] 5 maxed+enchanted items | 3×each potion | Blaze×3 | Smoke×3',
    base:s50,
    equip:[
      {id:'halberd',  ench:{id:'sharpness', tier:1}},
      {id:'hv_armor', ench:{id:'thorns',    tier:1}},
      {id:'carriage', ench:{id:'lightness', tier:1}},
      {id:'arquebus', ench:{id:'hawk_eye',  tier:3}},
      {id:'grimoire', ench:{id:'arcane',    tier:1}},
    ],
    inv:[...FULL_POTS,'blaze','blaze','blaze','sp_smoke','sp_smoke','sp_smoke'] },
];

// ── Player factory ────────────────────────────────────────────────────────────

function buildPlayer(state) {
  const player = new Player({ id: 'bench', name: 'Bot', isBot: true });
  player.baseStats = { ...state.base };
  player.hearts    = { current: 5, max: 5 };

  for (const eSpec of state.equip) {
    const template = ITEM_REGISTRY[eSpec.id];
    if (!template) { console.warn(`[warn] unknown equip item: ${eSpec.id}`); continue; }
    // Clone to avoid mutating the catalog
    const item = { ...template, statBonus: { ...(template.statBonus ?? {}) } };
    // equip() filters item.id out of inventory, so add it first
    player.inventory.push(item.id);
    if (!player.equip(item)) {
      console.warn(`[warn] could not equip ${eSpec.id} (slot occupied or limit reached)`);
      continue;
    }
    if (eSpec.ench) {
      const enchObj = ENCHANTMENTS.find(e => e.id === eSpec.ench.id);
      if (!enchObj) { console.warn(`[warn] unknown enchantment: ${eSpec.ench.id}`); continue; }
      player.applyEnchantment(item.slot, enchObj, eSpec.ench.tier);
    }
  }

  for (const id of state.inv) player.inventory.push(id);

  return player;
}

// ── Single fight simulation ───────────────────────────────────────────────────
// Returns: 'win' | 'loss' | 'escaped' | 'timeout'

const MAX_ROUNDS = 80; // generous cap to prevent infinite loops

function simulateFight(state, mobId) {
  const player  = buildPlayer(state);
  const mob     = MOBS.spawn(mobId);
  const fightLog = [];

  const init = Combat.initFight(player, mob);
  if (init.outcome === 'victory') return 'win';
  if (init.outcome === 'defeat')  return 'loss';

  let playerTurn = init.playerFirst;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let result;

    if (playerTurn) {
      // NN chooses action (null = no pre-announced mob attack; NN samples internally)
      const action = CombatNN.chooseAction(player, mob, null);
      result = Combat.takePlayerAttack(player, mob, action, fightLog);

      if (result.outcome === 'victory') return 'win';
      if (result.outcome === 'defeat')  return 'loss';
      if (result.outcome === 'escaped') return 'escaped';

      if (result.outcome === 'charisma_pending') {
        // Auto-resolve: debuff mob's F to keep fighting (mock:2)
        const charAction = { family:'mock', tier:2, stat:'F' };
        const charOut = Combat.applyCharismaOutcome(
          player, mob, charAction, result.charismaResult, fightLog
        );
        if (charOut.outcome === 'victory')      return 'win';
        if (charOut.outcome === 'charisma_end') return 'escaped';
        if (charOut.outcome === 'befriended')   return 'escaped';
        // 'ongoing' → fall through to mob's turn
      }

    } else {
      const preAtk = Combat.rollMobAttack(mob);
      result = Combat.takeMobAttack(player, mob, fightLog, preAtk);

      if (result.outcome === 'victory') return 'win';
      if (result.outcome === 'defeat')  return 'loss';
    }

    playerTurn = !playerTurn;
  }

  return 'timeout';
}

// ── Benchmark loop ────────────────────────────────────────────────────────────

const FIGHTS_PER_MOB = 50;
const TIERS = [0, 1, 2, 3];
const TOTAL_FIGHTS = STATES.length * TIERS.length * 6 * FIGHTS_PER_MOB;

const output = {
  generated:    new Date().toISOString(),
  fightsPerMob: FIGHTS_PER_MOB,
  model:        fs.existsSync(weightsPath) ? 'CombatNN' : 'rule-based fallback',
  states:       [],
};

let done = 0;

for (const state of STATES) {
  const stateResult = {
    level:         state.level,
    label:         state.label,
    baseStats:     state.base,
    statSum:       Object.values(state.base).reduce((s, v) => s + v, 0),
    skillsAdded:   Object.values(state.base).reduce((s, v) => s + v, 0) - 16,
    equippedItems: state.equip.map(e => e.id + (e.ench ? `+${e.ench.id}` : '')),
    inventoryItems: state.inv,
    results:       {},
  };

  for (const tier of TIERS) {
    const mobs      = TIER_MOBS[tier];
    const tierAgg   = { kills:0, deaths:0, escapes:0, timeouts:0, total:0, perMob:{} };

    for (const mob of mobs) {
      const r = { kills:0, deaths:0, escapes:0, timeouts:0 };

      for (let f = 0; f < FIGHTS_PER_MOB; f++) {
        const outcome = simulateFight(state, mob.id);
        r[outcome === 'win' ? 'kills' : outcome === 'loss' ? 'deaths' :
          outcome === 'escaped' ? 'escapes' : 'timeouts']++;
        done++;
      }

      tierAgg.kills    += r.kills;
      tierAgg.deaths   += r.deaths;
      tierAgg.escapes  += r.escapes;
      tierAgg.timeouts += r.timeouts;
      tierAgg.total    += FIGHTS_PER_MOB;

      tierAgg.perMob[mob.id] = {
        name:         mob.name,
        kills:        r.kills,
        deaths:       r.deaths,
        escapes:      r.escapes,
        timeouts:     r.timeouts,
        total:        FIGHTS_PER_MOB,
        killRate:     +(r.kills / FIGHTS_PER_MOB).toFixed(3),
        deathRate:    +(r.deaths / FIGHTS_PER_MOB).toFixed(3),
      };

      const pct = (done / TOTAL_FIGHTS * 100).toFixed(1);
      process.stdout.write(`\r  Lv${state.level.toString().padStart(2)} T${tier} ${mob.name.padEnd(16)} ${pct.padStart(5)}%`);
    }

    tierAgg.killRate     = +(tierAgg.kills  / tierAgg.total).toFixed(3);
    tierAgg.deathRate    = +(tierAgg.deaths / tierAgg.total).toFixed(3);
    tierAgg.survivalRate = +((tierAgg.kills + tierAgg.escapes) / tierAgg.total).toFixed(3);
    stateResult.results[`tier${tier}`] = tierAgg;
  }

  output.states.push(stateResult);
}

process.stdout.write('\n');

// ── Write JSON output ─────────────────────────────────────────────────────────

const outPath = path.join(ROOT, 'benchmark_results.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nResults written to ${outPath}`);

// ── Console summary ───────────────────────────────────────────────────────────

const W = 46;
console.log('\n' + '='.repeat(W + 36));
console.log(
  'Lv  Label'.padEnd(W) +
  '  T0 kill%  T1 kill%  T2 kill%  T3 kill%'
);
console.log('-'.repeat(W + 36));

for (const s of output.states) {
  const fmt = t => ((s.results[`tier${t}`].killRate * 100).toFixed(1) + '%').padStart(7);
  const tag = `[s${s.statSum.toString().padStart(2)}]`;
  console.log(
    `${s.level.toString().padStart(2)}  ${s.label.padEnd(W - 4).slice(0, W - 4)}` +
    `  ${fmt(0)}   ${fmt(1)}   ${fmt(2)}   ${fmt(3)}`
  );
}

console.log('='.repeat(W + 36));
console.log(`\nModel: ${output.model}  |  ${FIGHTS_PER_MOB} fights/mob  |  ${TOTAL_FIGHTS.toLocaleString()} total fights`);
console.log('\nBlock key:  [s16]=base stats  [s18..s24]=+skills  [s28..s50]=mid-late game');
