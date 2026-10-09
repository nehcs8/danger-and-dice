// Combat viability estimator — supervised training.
// Run from project root: node train/train_estimator.js
//
// For every (player-state, zone-tier) pair it predicts:
//   winProb    — probability of winning a single fight
//   heartsLost — expected hearts spent per fight (defeat = full HP lost)
//
// Coverage:
//   - Full stat range including XP levels and equipped gear (getStat caps at ~22)
//   - All stat-bonus enchantments absorbed into getStat() automatically
//   - Modifier enchantments (fury, bloodlust, thorns, arcane, hawk_eye, flame) as boolean features
//   - Special equipment (kryss, garrote, stealth_shoes) as boolean features
//   - Potions, escape items, attack spells, friends
//
// Outputs: js/data/weights/estimator_weights.js

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { TinyNN } = require('./nn.js');

const ROOT = path.join(__dirname, '..');

// ── vm sandbox ────────────────────────────────────────────────────────────────

const sandbox = {
  Math, Array, Float32Array, Uint8Array, Object, JSON, Set, Map, Date,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
  console, setTimeout: () => {}, clearTimeout: () => {},
  window: {},
};
vm.createContext(sandbox);

function loadFile(rel) { vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox); }
function get(name)     { return vm.runInContext(name, sandbox); }

loadFile('js/engine/dice.js');
loadFile('js/data/items.js');
loadFile('js/data/mobs.js');
loadFile('js/engine/player.js');
loadFile('js/engine/combat.js');

const MOBS   = get('MOBS');
const Player = get('Player');
const Combat = get('Combat');
const getItem = get('getItem');

// ── Item / enchantment catalogs for training player generation ────────────────

// Tier-ordered item IDs per slot (index+1 = tier)
const SLOT_ITEMS = {
  strength:  ['knife','sword','mace','axe','greatsword','halberd'],
  dexterity: ['sling','bow','longbow','crossbow','pistol','arquebus'],
  magic:     ['wand','staff','necklace','ring','orb','grimoire'],
  charisma:  ['flute','lyre','lute','trumpet','guitar','accordion'],
  armor:     ['jacket','lt_armor','md_armor','hv_armor'],
  shield:    ['shield','lg_shield'],
  speed:     ['shoes','boots','mule','horse','carriage','pegasus'],
};

// Enchantments that getStat() does NOT absorb — must be explicit features.
// Stat-bonus enchantments (sharpness, precision, resistance) ARE absorbed by getStat,
// so we do not need to track them separately.
const MODIFIER_ENCHANTS = [
  { id:'fury',      effect:{ type:'armor_reduction_on_hit' },   tier:2 },
  { id:'bloodlust', effect:{ type:'heal_on_kill' },              tier:1 },
  { id:'flame',     effect:{ type:'fire_on_hit' },               tier:1 },
  { id:'hawk_eye',  effect:{ type:'speed_reduction_on_hit' },    tier:2 },
  { id:'arcane',    effect:{ type:'magic_defense_via_armor' },   tier:1 },
  { id:'thorns',    effect:{ type:'reflect_30pct' },             tier:1 },
];

// Stat-bonus enchantments that getStat() already absorbs.
const STAT_ENCHANTS = [
  { id:'sharpness',  effect:{ type:'stat_bonus', stat:'F', value:3 }, tier:1 },
  { id:'precision',  effect:{ type:'stat_bonus', stat:'D', value:3 }, tier:1 },
  { id:'resistance', effect:{ type:'stat_bonus', stat:'A', value:3 }, tier:1 },
  { id:'lightness',  effect:{ type:'remove_speed_malus' },            tier:1 },
];

const ALL_ENCHANTS = [...MODIFIER_ENCHANTS, ...STAT_ENCHANTS];

// ── Constants ─────────────────────────────────────────────────────────────────

const STATS     = ['F','D','A','M','C','V'];
const DEF_FOR   = { F:'A', D:'V', M:'M', C:'C' };
const TIERS     = [0, 1, 2, 3];
const STATE_DIM = 24;   // see playerFeatureVec below

const N_CONFIGS = 1500;
const N_SIMS    = 30;
const EPOCHS    = 120;
const LR        = 0.002;
const HIDDEN    = [32, 16];

// ── Feature extraction (MUST match combat_estimator.js exactly) ───────────────
//
// Index   Feature
//  0      hp_ratio = current/max
//  1      hearts_max / 10
//  2-7    getStat(F,D,A,M,C,V) / 25   — absorbs base + items + stat enchants + guild
//  8      has_kryss            (pre-fight damage — massive early advantage)
//  9      has_garrote          (execute mob at ≤2 HP)
// 10      has_fury             (−tier×A on hit)
// 11      has_bloodlust        (+1❤ on kill)
// 12      has_hawk_eye         (−tier×V on hit)
// 13      has_thorns           (30% reflect incoming)
// 14      has_arcane           (magic defense uses A)
// 15      escape_quality       (1.0=rope/stealth_shoes; partial=V+d6 run + C bard; 0=chained)
// 16      has_smoke            (sp_smoke in inventory)
// 17      has_friend           (deployed ally available)
// 18      best_pot_bonus / 6   (highest available single-stat potion value)
// 19      has_attack_spell     (can use M combat spells)
// 20-23   tier one-hot         (mob zone: 0-3)

function playerFeatureVec(player, tier) {
  const v = new Array(STATE_DIM).fill(0);
  let i   = 0;

  v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
  v[i++] = Math.min(player.hearts.max, 10) / 10;

  for (const s of STATS) v[i++] = Math.min(player.getStat(s), 25) / 25;

  v[i++] = player.hasEquipped('kryss')         ? 1 : 0;
  v[i++] = player.hasEquipped('garrote')       ? 1 : 0;
  v[i++] = player.hasEnchantment('fury')       ? 1 : 0;
  v[i++] = player.hasEnchantment('bloodlust')  ? 1 : 0;
  v[i++] = player.hasEnchantment('hawk_eye')   ? 1 : 0;
  v[i++] = player.hasEnchantment('thorns')     ? 1 : 0;
  v[i++] = player.hasEnchantment('arcane')     ? 1 : 0;
  // Escape quality: 1.0=rope/stealth_shoes (guaranteed); partial=V+d6 run + C bard; 0=chained
  // Avg mob V per tier: t0≈8, t1≈10, t2≈13, t3≈15  |  avg mob C: t0≈6, t1≈9, t2≈11, t3≈14
  {
    const hasGuaranteedEscape = player.hasItem('rope') || player.hasEquipped('stealth_shoes');
    let escapeVal;
    if (hasGuaranteedEscape) {
      escapeVal = 1.0;
    } else if (player.chainedTurns === 0) {
      const avgMobV = [8, 10, 13, 15][tier] ?? 10;
      const avgMobC = [6,  9, 11, 14][tier] ?? 9;
      const vRun    = Math.max(0, Math.min(1, (player.getStat('V') + 3.5 - avgMobV) / 6));
      const cBard   = Math.max(0, Math.min(0.25, (player.getStat('C') - avgMobC) / 12));
      escapeVal = Math.min(1, vRun + cBard);
    } else {
      escapeVal = 0;
    }
    v[i++] = escapeVal;
  }
  v[i++] = player.inventory.includes('sp_smoke')           ? 1 : 0;
  v[i++] = player.friendsList.length > 0                   ? 1 : 0;

  // Best available potion value (e.g. pot_F3 → 3)
  const bestPot = player.inventory.reduce((best, id) => {
    if (!/^pot_[FDAMCV]\d$/.test(id)) return best;
    return Math.max(best, parseInt(id[5]) || 0);
  }, 0);
  v[i++] = bestPot / 6;

  v[i++] = player.canAttackMagic() ? 1 : 0;

  for (const t of TIERS) v[i++] = t === tier ? 1 : 0;

  // i === 24
  return v;
}

// ── Training player factory ───────────────────────────────────────────────────
// progression 0–5 maps from bare new player to fully kitted late-game character.

function makeTrainingPlayer(progression) {
  const p = new Player({ id: 'est', name: 'Est', isBot: true });

  // Base stats: XP can push stats well above Master's cap of 6.
  // respect:3 charisma can reach 8; XP adds beyond that.
  // Range: prog 0 → 1-3, prog 5 → 4-12.
  const lo = 1 + Math.floor(progression / 2);
  const hi = 3 + progression * 2;
  for (const s of STATS) {
    p.baseStats[s] = lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // Hearts: prog 0 → 3-4, prog 5 → 6-10
  const maxHp = 3 + progression + Math.floor(Math.random() * 2);
  p.hearts = {
    current: 1 + Math.floor(Math.random() * maxHp), // vary current HP too
    max: maxHp,
  };

  // Equipment: up to 5 slots filled with tier-appropriate items
  const slotNames   = Object.keys(SLOT_ITEMS);
  const shuffled    = [...slotNames].sort(() => Math.random() - 0.5);
  const nSlots      = Math.floor(Math.random() * 6); // 0-5
  const itemTierCap = Math.min(Math.ceil(progression * 6 / 5), 6); // 1-6

  for (let k = 0; k < Math.min(nSlots, 5); k++) {
    const slot  = shuffled[k];
    const pool  = SLOT_ITEMS[slot];
    const maxT  = Math.min(itemTierCap, pool.length);
    const itemId = pool[Math.floor(Math.random() * maxT)];
    const item   = getItem(itemId);
    if (!item) continue;

    const itemCopy = { ...item };

    // Add enchantment with probability scaling with progression
    if (Math.random() < progression * 0.12) { // 0% at prog 0, ~60% at prog 5
      const enchPool = Math.random() < 0.5 ? MODIFIER_ENCHANTS : STAT_ENCHANTS;
      itemCopy.enchantment = { ...enchPool[Math.floor(Math.random() * enchPool.length)] };
    }

    p.equipped[slot] = itemCopy;
  }

  // Special equipment (guild assassin items) — higher progression
  if (progression >= 3 && Math.random() < 0.25) {
    const special = getItem('kryss') ?? { id:'kryss', name:'Kryss', slot:'strength', statBonus:{F:1} };
    p.equipped.strength = { ...special }; // override strength slot
  }
  if (progression >= 4 && Math.random() < 0.2) {
    const g = getItem('garrote') ?? { id:'garrote', name:'Garrote', slot:'strength', statBonus:{F:1} };
    p.equipped.strength = { ...g };
  }
  if (progression >= 2 && Math.random() < 0.2) {
    const ss = getItem('stealth_shoes') ?? { id:'stealth_shoes', name:'Stealth Shoes', slot:'speed', statBonus:{V:1} };
    p.equipped.speed = { ...ss };
  }

  // Inventory: potions, escape items, spells
  const nPots = Math.floor(Math.random() * (progression * 2 + 2));
  for (let j = 0; j < nPots; j++) {
    const s   = STATS[Math.floor(Math.random() * STATS.length)];
    const val = 1 + Math.floor(Math.random() * Math.min(progression + 1, 3));
    p.inventory.push(`pot_${s}${val}`);
  }
  if (progression >= 1 && Math.random() < 0.3) p.inventory.push('rope');
  if (progression >= 2 && Math.random() < 0.2) p.inventory.push('sp_invisibility');
  if (progression >= 2 && Math.random() < 0.25) p.inventory.push('sp_smoke');

  // Attack spells — needed for M combat
  const ATTACK_SPELLS = ['sp_fireball','sp_lightning','sp_ice','sp_explosion'];
  if (progression >= 1 && Math.random() < 0.2) {
    p.inventory.push(ATTACK_SPELLS[Math.floor(Math.random() * ATTACK_SPELLS.length)]);
  }

  return p;
}

// ── Greedy fighter (deterministic policy for data collection) ─────────────────

function greedyAction(player, mob) {

  const types = ['F','D','M'].filter(t => !(t === 'M' && !player.canAttackMagic()));
  let best = 'F', bestScore = -Infinity;
  for (const t of types) {
    const score = player.getStat(t) - (mob.stats[DEF_FOR[t]] ?? 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }

  let spellId = null;
  if (best === 'M') {
    const spell = player.inventory
      .map(id => getItem(id)).filter(i => i?.subtype === 'attack')
      .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
    spellId = spell?.id ?? null;
  }
  return { type: 'attack', attackType: best, spellId };
}

// ── Fight simulation ──────────────────────────────────────────────────────────

function snapshotPlayer(p) {
  // Deep-enough clone to restore mutable combat state between simulations
  return {
    baseStats:   { ...p.baseStats },
    hearts:      { ...p.hearts },
    equipped:    Object.fromEntries(
                   Object.entries(p.equipped).map(([k,v]) => [k, v ? { ...v } : null])
                 ),
    inventory:   [...p.inventory],
    friendsList: [],
    chainedTurns: 0,
  };
}

function restorePlayer(p, snap) {
  Object.assign(p.baseStats, snap.baseStats);
  p.hearts      = { ...snap.hearts };
  p.equipped    = Object.fromEntries(
                    Object.entries(snap.equipped).map(([k,v]) => [k, v ? { ...v } : null])
                  );
  p.inventory   = [...snap.inventory];
  p.friendsList = [];
  p.chainedTurns = 0;
  p.statusEffects = [];
  p.tempBonuses = {};
  p.priestBuff  = 0;
  p.transmutation = null;
  p.isSmokeActive = false;
  p.isAlive     = true;
}

function simulateFight(player, snap, mob) {
  restorePlayer(player, snap);
  const freshMob = MOBS.spawn(mob.id);
  const log      = [];
  const initHp   = player.hearts.current;

  const init = Combat.initFight(player, freshMob);
  if (init.outcome === 'victory') return { won: true, heartsLost: 0 };

  if (!init.playerFirst) {
    const preAtk = Combat.rollMobAttack(freshMob);
    const r = Combat.takeMobAttack(player, freshMob, log, preAtk);
    if (r.outcome === 'defeat')  return { won: false, heartsLost: initHp };
    if (r.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
  }

  for (let step = 0; step < 80; step++) {
    const action = greedyAction(player, freshMob);
    const pr     = Combat.takePlayerAttack(player, freshMob, action, log);
    if (pr.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
    if (pr.outcome === 'defeat')  return { won: false, heartsLost: initHp };
    if (pr.outcome === 'escaped') return { won: false, heartsLost: initHp - player.hearts.current };

    const preAtk = Combat.rollMobAttack(freshMob);
    const mr     = Combat.takeMobAttack(player, freshMob, log, preAtk);
    if (mr.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
    if (mr.outcome === 'defeat')  return { won: false, heartsLost: initHp };
  }

  return { won: false, heartsLost: initHp };
}

// ── Dataset generation ────────────────────────────────────────────────────────

function generateDataset() {
  const tierMobs = {};
  for (const t of TIERS) {
    tierMobs[t] = MOBS.getByTier(t);
    if (!tierMobs[t]?.length) throw new Error(`No mobs for tier ${t}`);
  }

  // Progression levels 0–5 — cycle evenly across configs
  const PROGRESSIONS = [0, 1, 2, 3, 4, 5];
  const dataset = [];

  console.log(`Generating ${N_CONFIGS} players × ${TIERS.length} tiers × ${N_SIMS} sims…`);

  for (let c = 0; c < N_CONFIGS; c++) {
    if (c % 300 === 0) process.stdout.write(`  config ${c}/${N_CONFIGS}\r`);

    const prog   = PROGRESSIONS[c % PROGRESSIONS.length];
    const player = makeTrainingPlayer(prog);
    const snap   = snapshotPlayer(player);

    for (const tier of TIERS) {
      const feats = playerFeatureVec(player, tier);
      const pool  = tierMobs[tier];
      let wins = 0, totalHearts = 0;

      for (let s = 0; s < N_SIMS; s++) {
        const mob = pool[Math.floor(Math.random() * pool.length)];
        const { won, heartsLost } = simulateFight(player, snap, mob);
        if (won) wins++;
        totalHearts += heartsLost;
      }

      dataset.push({
        features:   feats,
        winRate:    wins / N_SIMS,
        heartsLost: totalHearts / N_SIMS,
      });
    }
  }

  console.log(`\nGenerated ${dataset.length} samples.`);
  return dataset;
}

// ── Training ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function train(dataset) {
  const sizes = [STATE_DIM, ...HIDDEN, 2];
  const nn    = new TinyNN(sizes);
  const HEARTS_SCALE = 10; // training normalisation factor

  console.log(`Training NN ${sizes.join('→')} for ${EPOCHS} epochs…`);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    shuffle(dataset);
    let loss = 0;
    for (const { features, winRate, heartsLost } of dataset) {
      const out     = nn.forward(features);
      const targets = [winRate, heartsLost / HEARTS_SCALE];
      loss += (out[0] - targets[0]) ** 2 + (out[1] - targets[1]) ** 2;
      nn.supervisedUpdate(targets, LR);
    }
    if ((epoch + 1) % 20 === 0) {
      console.log(`  epoch ${String(epoch + 1).padStart(3)} — loss ${(loss / dataset.length).toFixed(4)}`);
    }
  }
  return nn;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

function evaluate(nn, dataset) {
  const byTier = { 0:[], 1:[], 2:[], 3:[] };
  for (const s of dataset) {
    const tier = s.features.slice(20, 24).findIndex(v => v > 0.5);
    if (tier >= 0) byTier[tier].push(s);
  }

  console.log('\nEvaluation (MAE on held-out 10%):');
  for (const tier of TIERS) {
    const held = byTier[tier].slice(0, Math.floor(byTier[tier].length * 0.1));
    if (!held.length) continue;
    let eW = 0, eH = 0;
    for (const { features, winRate, heartsLost } of held) {
      const out  = nn.forward(features);
      eW += Math.abs(Math.max(0, Math.min(1, out[0])) - winRate);
      eH += Math.abs(Math.max(0, out[1] * 10)         - heartsLost);
    }
    const n    = held.length;
    const avgW = (byTier[tier].reduce((a,s) => a + s.winRate, 0)    / byTier[tier].length).toFixed(2);
    const avgH = (byTier[tier].reduce((a,s) => a + s.heartsLost, 0) / byTier[tier].length).toFixed(2);
    console.log(`  tier ${tier}: actual win=${avgW} hearts=${avgH}  |  MAE win=${(eW/n).toFixed(3)} hearts=${(eH/n).toFixed(3)}`);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

const WEIGHTS_PATH = path.join(ROOT, 'js', 'data', 'weights', 'estimator_weights.js');

function saveWeights(nn) {
  fs.mkdirSync(path.dirname(WEIGHTS_PATH), { recursive: true });
  const js = `// Auto-generated by train/train_estimator.js — do not edit by hand\n`
           + `const ESTIMATOR_WEIGHTS = ${JSON.stringify(nn.serialize())};\n`;
  fs.writeFileSync(WEIGHTS_PATH, js);
  console.log(`\nWeights → ${WEIGHTS_PATH}`);
}

const dataset = generateDataset();
const nn      = train(dataset);
evaluate(nn, dataset);
saveWeights(nn);
console.log('Done.');
