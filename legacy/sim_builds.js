#!/usr/bin/env node
'use strict';

/**
 * sim_builds.js
 *
 * Monte Carlo combat scenario simulation across a full build progression matrix.
 * Tests three strategies (F-fighter, D-ranger, M-mage) across 8 build tiers:
 *   bare_weak, gear_weak, gear_enchanted_weak,
 *   bare_strong, gear_strong, gear_enchanted_strong,
 *   full_potions, boss_drops
 *
 * Fights each build against: all tier 0-3 minibosses (50 fights each) and all
 * named bosses (200 fights each).
 *
 * Blood drops: applied as pre-fight stat bonuses (fight-duration effect).
 * Priest blessings: added as priestBuff (single-roll all-stats potion).
 * CombatNN is used for all action decisions.
 *
 * Output: js/data/weights/build_viability.json — consumed by UpgradeAdvisor.
 *
 * Usage: node sim_builds.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname);
const JS   = path.join(ROOT, 'js');

// ── Sandbox setup ─────────────────────────────────────────────────────────────

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

function load(filePath) {
  vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox);
}
function get(name) { return vm.runInContext(name, sandbox); }

load(path.join(JS, 'engine/dice.js'));
load(path.join(JS, 'data/items.js'));
load(path.join(JS, 'data/mobs.js'));
load(path.join(JS, 'engine/player.js'));
load(path.join(JS, 'engine/combat.js'));

const weightsPath = path.join(JS, 'data/weights/nn_combat_weights.js');
if (fs.existsSync(weightsPath)) load(weightsPath);
load(path.join(JS, 'engine/combat_nn.js'));

const MOBS          = get('MOBS');
const Player        = get('Player');
const Combat        = get('Combat');
const ENCHANTMENTS  = get('ENCHANTMENTS');
const ITEM_REGISTRY = get('ITEM_REGISTRY');
const getItem       = get('getItem');
const CombatNN      = get('CombatNN');

// ── Tier mob pools ────────────────────────────────────────────────────────────

const TIER_MOBS = {
  0: MOBS.list.filter(m => m.tier === 0 && !m.isBoss && !m.isAnimal),
  1: MOBS.list.filter(m => m.tier === 1 && !m.isBoss && !m.isAnimal),
  2: MOBS.list.filter(m => m.tier === 2 && !m.isBoss && !m.isAnimal),
  3: MOBS.list.filter(m => m.tier === 3 && !m.isBoss && !m.isAnimal),
};

const BOSS_IDS = [
  'witch', 'sea_serpent', 'prince', 'phoenix',
  'grand_sorcerer', 'king', 'dragon', 'supreme_werewolf', 'supreme_knight',
];

// ── Base stat sets ────────────────────────────────────────────────────────────
// weak = starting-level roll (sum ≈ 16); strong = well-leveled (sum ≈ 27)

const BASE_WEAK = {
  F: { F:3, D:2, A:3, M:2, C:2, V:3 },   // sum 15
  D: { F:2, D:3, A:2, M:2, C:2, V:4 },   // sum 15
  M: { F:2, D:2, A:2, M:3, C:2, V:3 },   // sum 14
};

// strong: 6 in primary + 6A, 4C, 5V (M gets 6M + arcane so no extra M needed)
const BASE_STRONG = {
  F: { F:6, D:3, A:6, M:2, C:4, V:5 },   // sum 26
  D: { F:2, D:6, A:6, M:2, C:4, V:6 },   // sum 26
  M: { F:2, D:2, A:6, M:6, C:4, V:5 },   // sum 25
};

// ── Equipment specs ───────────────────────────────────────────────────────────
// Tier-6 weapon per strategy; hv_armor + lg_shield for protection

const T6_WEAPON = { F: 'halberd', D: 'arquebus', M: 'grimoire' };

// Enchantments applied in gear_enchanted tier:
//   hv_armor  + lightness (removes V-2 speed malus)
//   lg_shield + arcane    (magic defense uses A instead of M)
const ENCH_ARMOR  = { id:'lightness', tier:1 };
const ENCH_SHIELD = { id:'arcane',    tier:1 };

// Potions for full_potions tier
const FULL_POTIONS = {
  F: ['pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal',
      'pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3',
      'pot_F3','pot_F3','pot_F3','pot_F3','pot_F3','pot_F3','pot_F3','pot_F3','pot_F3','pot_F3',
      'pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6',
      'sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke'],
  D: ['pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal',
      'pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3',
      'pot_D3','pot_D3','pot_D3','pot_D3','pot_D3','pot_D3','pot_D3','pot_D3','pot_D3','pot_D3',
      'pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6',
      'sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke'],
  // M-mage: attack spells are core — without them canAttackMagic() fails.
  // blaze (magicValue:3) for regular fights; rend (magicValue:3, blood) for boss attrition.
  M: ['pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal','pot_heal',
      'pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3','pot_A3',
      'pot_M3','pot_M3','pot_M3','pot_M3','pot_M3','pot_M3','pot_M3','pot_M3','pot_M3','pot_M3',
      'pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6','pot_V6',
      'sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke','sp_smoke',
      'blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze',
      'blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze',
      'rend','rend','rend','rend','rend','rend','rend','rend','rend','rend'],
};

// Boss drop replacements for boss_drops tier (best available per slot)
const BOSS_DROP_WEAPONS = { F: 'legendary_sword', D: 'legendary_bow', M: 'supreme_grimoire' };
const BOSS_DROP_ARMOR   = 'royal_crown';   // A+10 replaces hv_armor
const BOSS_DROP_SHIELD  = 'iron_fortress'; // A+9 replaces lg_shield
const BOSS_DROP_SPEED   = 'winged_boots';  // V+10 replaces pegasus/accordion

// Blood drops: pre-fight fight-duration stat bonuses. Apply to player baseStats.
// dragon_blood: F+2, M+2, V+2  (best all-around)
const BLOOD_DROP_BONUSES = { F:2, M:2, V:2 };

// ── Build specs per strategy and tier ─────────────────────────────────────────

// For M-mage: base attack spell inventory at each tier
// (mage can't use magic without a spell in inventory)
const M_SPELLS_FEW  = ['blaze','blaze','blaze','blaze','blaze'];
const M_SPELLS_MID  = ['blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze','blaze'];

function makeScenarios(strat) {
  const base_w   = BASE_WEAK[strat];
  const base_s   = BASE_STRONG[strat];
  const weapon   = T6_WEAPON[strat];
  const bdWeapon = BOSS_DROP_WEAPONS[strat];
  const pots     = FULL_POTIONS[strat];
  // M-mage needs attack spells at every tier; F/D use empty arrays
  const spells_w = strat === 'M' ? M_SPELLS_FEW : [];
  const spells_s = strat === 'M' ? M_SPELLS_MID : [];

  return [
    {
      tier: 'bare_weak',
      label: `[${strat}] Bare weak (no gear)`,
      base: base_w,
      equip: [],
      inv: [...spells_w],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'gear_weak',
      label: `[${strat}] Weak stats + tier-6 gear`,
      base: base_w,
      equip: [{ id: weapon }, { id: 'hv_armor' }, { id: 'lg_shield' }, { id: 'pegasus' }, { id: 'accordion' }],
      inv: [...spells_w],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'gear_enchanted_weak',
      label: `[${strat}] Weak stats + enchanted tier-6 gear`,
      base: base_w,
      equip: [
        { id: weapon },
        { id: 'hv_armor', ench: ENCH_ARMOR  },
        { id: 'lg_shield', ench: ENCH_SHIELD },
        { id: 'pegasus' },
        { id: 'accordion' },
      ],
      inv: [...spells_w],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'bare_strong',
      label: `[${strat}] Strong stats, no gear`,
      base: base_s,
      equip: [],
      inv: [...spells_s],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'gear_strong',
      label: `[${strat}] Strong stats + tier-6 gear`,
      base: base_s,
      equip: [{ id: weapon }, { id: 'hv_armor' }, { id: 'lg_shield' }, { id: 'pegasus' }, { id: 'accordion' }],
      inv: [...spells_s],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'gear_enchanted_strong',
      label: `[${strat}] Strong stats + enchanted tier-6 gear`,
      base: base_s,
      equip: [
        { id: weapon },
        { id: 'hv_armor', ench: ENCH_ARMOR  },
        { id: 'lg_shield', ench: ENCH_SHIELD },
        { id: 'pegasus' },
        { id: 'accordion' },
      ],
      inv: [...spells_s],
      bloodBonus: null,
      priestBuff: 0,
    },
    {
      tier: 'full_potions',
      label: `[${strat}] Strong enchanted + full consumables`,
      base: base_s,
      equip: [
        { id: weapon },
        { id: 'hv_armor', ench: ENCH_ARMOR  },
        { id: 'lg_shield', ench: ENCH_SHIELD },
        { id: 'pegasus' },
        { id: 'accordion' },
      ],
      inv: pots,
      bloodBonus: BLOOD_DROP_BONUSES,
      priestBuff: 4,   // +4 all stats for first roll
    },
    {
      tier: 'boss_drops',
      label: `[${strat}] Boss drops + enchants + full consumables`,
      base: base_s,
      equip: [
        { id: bdWeapon },
        { id: BOSS_DROP_ARMOR  },
        { id: BOSS_DROP_SHIELD },
        { id: BOSS_DROP_SPEED  },
        { id: 'enchanted_flute' },   // C+8 charisma boss drop
      ],
      inv: pots,
      bloodBonus: BLOOD_DROP_BONUSES,
      priestBuff: 4,
    },
  ];
}

// All scenarios across all three strategies
const ALL_SCENARIOS = ['F', 'D', 'M'].flatMap(s => makeScenarios(s));

// ── Player factory ────────────────────────────────────────────────────────────

function buildPlayer(scenario) {
  const player = new Player({ id: 'sim', name: 'SimBot', isBot: true });
  player.baseStats = { ...scenario.base };
  player.hearts    = { current: 5, max: 5 };

  for (const eSpec of scenario.equip) {
    const template = ITEM_REGISTRY[eSpec.id];
    if (!template) { process.stderr.write(`[warn] unknown equip: ${eSpec.id}\n`); continue; }
    const item = { ...template, statBonus: { ...(template.statBonus ?? {}) } };
    player.inventory.push(item.id);
    if (!player.equip(item)) {
      process.stderr.write(`[warn] could not equip ${eSpec.id}\n`); continue;
    }
    if (eSpec.ench) {
      const enchObj = ENCHANTMENTS.find(e => e.id === eSpec.ench.id);
      if (enchObj) player.applyEnchantment(item.slot, enchObj, eSpec.ench.tier);
    }
  }

  for (const id of scenario.inv) player.inventory.push(id);

  // Blood drops: apply pre-fight as persistent stat bonuses for this fight's duration.
  // Directly increment baseStats — this accurately models fight-duration blood effects.
  if (scenario.bloodBonus) {
    for (const [stat, val] of Object.entries(scenario.bloodBonus)) {
      player.baseStats[stat] = (player.baseStats[stat] ?? 0) + val;
    }
  }

  // Priest buff: single-roll all-stats bonus (consumed on first dice roll).
  if (scenario.priestBuff > 0) {
    player.priestBuff = scenario.priestBuff;
  }

  return player;
}

// ── Single fight simulation ───────────────────────────────────────────────────

const MAX_ROUNDS = 100;

function simulateFight(scenario, mobId) {
  const player = buildPlayer(scenario);
  const mob    = MOBS.spawn(mobId);
  const log    = [];

  const init = Combat.initFight(player, mob);
  if (init.outcome === 'victory') return 'win';
  if (init.outcome === 'defeat')  return 'loss';

  let playerTurn = init.playerFirst;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let result;

    if (playerTurn) {
      const action = CombatNN.chooseAction(player, mob, null);
      // On boss fights: never bail — bosses regenerate fully on escape
      const isBoss = MOBS.list.find(m => m.id === mobId)?.isBoss;
      let finalAction = action;
      if (isBoss && (action?.type === 'bail' || action?.type === 'run')) {
        const { attackType, spellId } = bestAttack(player, mob);
        finalAction = { type:'attack', attackType, spellId };
      }

      result = Combat.takePlayerAttack(player, mob, finalAction, log);

      if (result.outcome === 'victory') return 'win';
      if (result.outcome === 'defeat')  return 'loss';
      if (result.outcome === 'escaped') return 'escaped';

      if (result.outcome === 'charisma_pending') {
        // Auto-resolve: mock mob's top stat
        const topStat = ['F','D','M','C'].reduce((b, s) =>
          (mob.stats[s] ?? 0) > (mob.stats[b] ?? 0) ? s : b, 'F');
        const charOut = Combat.applyCharismaOutcome(
          player, mob, { family:'mock', tier:2, stat:topStat }, result.charismaResult, log
        );
        if (charOut.outcome === 'victory')      return 'win';
        if (charOut.outcome === 'charisma_end') return 'escaped';
        if (charOut.outcome === 'befriended')   return 'escaped';
      }
    } else {
      const preAtk = Combat.rollMobAttack(mob);
      result = Combat.takeMobAttack(player, mob, log, preAtk);
      if (result.outcome === 'victory') return 'win';
      if (result.outcome === 'defeat')  return 'loss';
    }

    playerTurn = !playerTurn;
  }
  return 'timeout';
}

function bestAttack(player, mob) {
  const defs = { F:'A', D:'V', M:'M', C:'C' };
  const canM = player.inventory.some(id => getItem(id)?.subtype === 'attack');
  const types = ['F','D','C'].concat(canM ? ['M'] : []);
  const attackType = types.reduce((best, t) => {
    const s = player.getStat(t) - (mob.stats[defs[t]] ?? 0);
    const b = player.getStat(best) - (mob.stats[defs[best]] ?? 0);
    return s > b ? t : best;
  }, types[0] ?? 'F');
  const spellId = attackType === 'M'
    ? player.inventory.map(id => getItem(id))
        .filter(i => i?.subtype === 'attack')
        .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0]?.id ?? null
    : null;
  return { attackType, spellId };
}

// ── Benchmark driver ──────────────────────────────────────────────────────────

const MINI_FIGHTS_PER_MOB  = 50;
const BOSS_FIGHTS_PER_MOB  = 200;

// Count total fights for progress bar
const totalMiniMobs = Object.values(TIER_MOBS).reduce((s, arr) => s + arr.length, 0);
const TOTAL_FIGHTS  = ALL_SCENARIOS.length * (totalMiniMobs * MINI_FIGHTS_PER_MOB
                                            + BOSS_IDS.length * BOSS_FIGHTS_PER_MOB);
let done = 0;

function runFights(scenario, mobId, count) {
  const r = { wins:0, losses:0, escapes:0, timeouts:0 };
  for (let i = 0; i < count; i++) {
    const outcome = simulateFight(scenario, mobId);
    if      (outcome === 'win')     r.wins++;
    else if (outcome === 'loss')    r.losses++;
    else if (outcome === 'escaped') r.escapes++;
    else                            r.timeouts++;
    done++;
  }
  r.total   = count;
  r.winRate = +(r.wins / count).toFixed(3);
  r.lossRate= +(r.losses / count).toFixed(3);
  return r;
}

const output = {
  generated:   new Date().toISOString(),
  miniPerMob:  MINI_FIGHTS_PER_MOB,
  bossPerMob:  BOSS_FIGHTS_PER_MOB,
  totalFights: TOTAL_FIGHTS,
  scenarios:   [],
};

for (const scenario of ALL_SCENARIOS) {
  const result = {
    strategy:    scenario.label.match(/^\[(\w)\]/)?.[1] ?? '?',
    tier:        scenario.tier,
    label:       scenario.label,
    baseStats:   scenario.base,
    equip:       scenario.equip.map(e => e.id + (e.ench ? `+${e.ench.id}` : '')),
    bloodBonus:  scenario.bloodBonus,
    priestBuff:  scenario.priestBuff,
    minibosses:  {},
    bosses:      {},
  };

  // ── Miniboss fights per tier ─────────────────────────────────────────────────
  for (const [tier, mobs] of Object.entries(TIER_MOBS)) {
    const tierAgg = { wins:0, losses:0, escapes:0, timeouts:0, total:0, perMob:{} };
    for (const mob of mobs) {
      const r = runFights(scenario, mob.id, MINI_FIGHTS_PER_MOB);
      tierAgg.wins     += r.wins;
      tierAgg.losses   += r.losses;
      tierAgg.escapes  += r.escapes;
      tierAgg.timeouts += r.timeouts;
      tierAgg.total    += r.total;
      tierAgg.perMob[mob.id] = { name: mob.name, ...r };
      process.stdout.write(
        `\r  ${scenario.tier.padEnd(22)} T${tier} ${mob.name.padEnd(18)} ${(done/TOTAL_FIGHTS*100).toFixed(1).padStart(5)}%`
      );
    }
    tierAgg.winRate = +(tierAgg.wins / tierAgg.total).toFixed(3);
    result.minibosses[`tier${tier}`] = tierAgg;
  }

  // ── Named boss fights ─────────────────────────────────────────────────────────
  for (const bossId of BOSS_IDS) {
    const r = runFights(scenario, bossId, BOSS_FIGHTS_PER_MOB);
    const mob = MOBS.list.find(m => m.id === bossId);
    result.bosses[bossId] = { name: mob?.name ?? bossId, ...r };
    process.stdout.write(
      `\r  ${scenario.tier.padEnd(22)} boss ${bossId.padEnd(20)} ${(done/TOTAL_FIGHTS*100).toFixed(1).padStart(5)}%`
    );
  }

  output.scenarios.push(result);
}

process.stdout.write('\n');

// ── Write output ──────────────────────────────────────────────────────────────

const outDir  = path.join(JS, 'data/weights');
const outPath = path.join(outDir, 'build_viability.json');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nResults → ${outPath}`);

// ── Console summary ───────────────────────────────────────────────────────────

const W = 42;
console.log('\n' + '='.repeat(W + 56));
console.log(
  'Scenario'.padEnd(W) + '  T0 win%  T1 win%  T2 win%  T3 win% | ' +
  'dragon  king  witch  grand_sorc  werewolf'
);
console.log('-'.repeat(W + 56));

for (const s of output.scenarios) {
  const tm  = tier => ((s.minibosses[`tier${tier}`]?.winRate ?? 0) * 100).toFixed(0).padStart(5) + '%';
  const bos = id   => ((s.bosses[id]?.winRate ?? 0) * 100).toFixed(0).padStart(5) + '%';
  console.log(
    s.label.padEnd(W).slice(0, W) +
    `  ${tm(0)}   ${tm(1)}   ${tm(2)}   ${tm(3)} | ` +
    `${bos('dragon')} ${bos('king')} ${bos('witch')} ${bos('grand_sorcerer')}  ${bos('supreme_werewolf')}`
  );
}

console.log('='.repeat(W + 56));
console.log(`\n${TOTAL_FIGHTS.toLocaleString()} total fights  |  ` +
  `${MINI_FIGHTS_PER_MOB}/miniboss  ${BOSS_FIGHTS_PER_MOB}/boss`);
