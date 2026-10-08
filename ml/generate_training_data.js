#!/usr/bin/env node
'use strict';

/**
 * Monte Carlo training data generator for Danger & Dice combat consumable AI.
 *
 * Trains the NN to answer the non-trivial question:
 *   "Should I use a consumable before attacking?"
 *
 * The trivial part (which stat to attack with) is handled by the greedy rule-based
 * bot and used as the continuation policy, so the NN focuses on consumable timing.
 *
 * Action space (flat, available actions depend on inventory):
 *   atk_F / atk_D / atk_M / atk_C  — plain attack, no consumable used
 *   bail                             — escape (rope / stealth shoes)
 *   heal                             — use pot_heal, then greedy attack
 *   smoke                            — use sp_smoke (immune this turn), then greedy attack
 *   pot                              — use best offensive stat pot (F/D/M/C) → boosted attack
 *   pot_A                            — use best armor pot → greedy attack (defensive)
 *   pot_V                            — use best speed pot → greedy attack (initiative)
 *   blood                            — apply best blood drop (fight-duration stat bonus) → attack
 *   priest_pot                       — use priest blessing (+N all stats, one roll) → best attack
 *
 * Usage:
 *   node generate_training_data.js [N_STATES] [K_ROLLOUTS] [OUTPUT_FILE]
 *
 * Defaults: 20000 states, 100 rollouts, training_data.jsonl
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── Load game files ──────────────────────────────────────────────────────────

const GAME_ROOT  = path.join(__dirname, '../js');
const LOAD_ORDER = [
  'engine/dice.js',
  'data/items.js',
  'data/mobs.js',
  'engine/player.js',
  'engine/combat.js',
];

const gameCtx = vm.createContext(
  Object.assign(Object.create(null), globalThis, {
    Game: { emit: () => {}, getState: () => ({}) },
    module: undefined, exports: undefined, require: undefined,
  })
);

const gameSource = LOAD_ORDER
  .map(f => `/* ${f} */\n` + fs.readFileSync(path.join(GAME_ROOT, f), 'utf8'))
  .join('\n\n');

vm.runInContext(gameSource + `
var _g = { Dice, MOBS, Combat, Player, getItem, ITEM_REGISTRY, ENCHANTMENTS, EQUIPMENT };
Object.assign(this, _g);
`, gameCtx);

const { Dice, MOBS, Combat, Player, getItem, ITEM_REGISTRY, ENCHANTMENTS } = gameCtx;

// ── Constants ────────────────────────────────────────────────────────────────

const ATTACK_TYPES = ['F', 'D', 'M', 'C'];
const DEFENSE_FOR  = { F: 'A', D: 'V', M: 'M', C: 'C' };
const ALL_SLOTS    = ['strength','dexterity','magic','charisma','speed','armor','shield'];
const MAX_ROUNDS   = 30;

// All stat potions that exist in the game, by stat
const STAT_POTIONS = {
  F: ['pot_F1','pot_F2','pot_F3'],
  D: ['pot_D1','pot_D2','pot_D3'],
  A: ['pot_A1','pot_A2','pot_A3'],
  M: ['pot_M1','pot_M2','pot_M3'],
  C: ['pot_C1','pot_C2','pot_C3'],
  V: ['pot_V1','pot_V2','pot_V3','pot_V4','pot_V5','pot_V6'],
};
const ALL_POT_IDS = Object.values(STAT_POTIONS).flat();

// Fight-duration stat drops (blood, scales, teeth, etc.)
// Applied to baseStats for the whole fight when "used" pre-combat.
const BLOOD_DROP_IDS = [
  'werewolf_blood','dragon_blood','vampire_blood','dragon_scales',
  'troll_tooth','harpy_feathers','witch_powder','ivory','meat','fur','fairy_dust',
];

// Priest blessings: +N all stats for exactly one roll
const PRIEST_POT_IDS = [
  'priest_pot_1','priest_pot_2','priest_pot_3',
  'priest_pot_4','priest_pot_5','priest_pot_6',
];

// ── Deep clone ───────────────────────────────────────────────────────────────

function clonePlayer(p) {
  const c             = new Player({ id: p.id, name: p.name });
  c.baseStats         = { ...p.baseStats };
  c.hearts            = { ...p.hearts };
  c.coins             = p.coins;
  for (const slot of ALL_SLOTS)
    c.equipped[slot]  = p.equipped[slot] ? JSON.parse(JSON.stringify(p.equipped[slot])) : null;
  c.inventory         = [...p.inventory];
  c.statusEffects     = JSON.parse(JSON.stringify(p.statusEffects));
  c.tempBonuses       = { ...p.tempBonuses };
  c.priestBuff        = p.priestBuff;
  c.transmutation     = p.transmutation ? { ...p.transmutation } : null;
  c.halfUsedSpells    = new Set(p.halfUsedSpells);
  c.chainedTurns      = p.chainedTurns;
  c.isSmokeActive     = p.isSmokeActive;
  c.isAlive           = p.isAlive;
  c.hasPrincess       = p.hasPrincess;
  c.guildItemLevels   = JSON.parse(JSON.stringify(p.guildItemLevels));
  c.xp                = { ...p.xp };
  c.combatXpHits      = p.combatXpHits ?? 0;
  return c;
}

function cloneMob(m) {
  return {
    ...m,
    stats:         { ...m.stats },
    hearts:        { ...m.hearts },
    statusEffects: JSON.parse(JSON.stringify(m.statusEffects ?? [])),
  };
}

// ── Greedy continuation (attack only, no consumable use) ─────────────────────
// Picks best attack type by (player stat - mob defense stat). Used as the
// continuation policy after the first evaluated action.

function bestAttackType(player, mob) {
  const available = ATTACK_TYPES.filter(t => !(t === 'M' && !player.canAttackMagic()));
  let best = 'F', bestScore = -Infinity;
  for (const t of available) {
    const score = player.getStat(t) - (mob.stats[DEFENSE_FOR[t]] ?? 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

function greedyAction(player, mob) {
  if (player.hearts.current <= 1 && player.canEscape()) return { type: 'bail' };
  const t = bestAttackType(player, mob);
  if (t === 'C') return { type: 'bard' };
  let spellId = null;
  if (t === 'M') {
    const spell = player.inventory
      .map(id => getItem(id))
      .filter(i => i?.subtype === 'attack')
      .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
    spellId = spell?.id ?? null;
  }
  return { type: 'attack', attackType: t, spellId };
}

// ── Best stat potion for a given attack type ─────────────────────────────────
// Returns { potId, stat, value } or null.

function bestPotionFor(player, attackType) {
  // Potions boost the roll stat. For M attacks the potion stat is M.
  // We consider potions matching the attack stat, or A/V for defense boost.
  // Here: only offensive potions that match the attack stat.
  const potStat = attackType; // F potion for F attack, etc.
  if (!STAT_POTIONS[potStat]) return null;
  let best = null, bestVal = 0;
  for (const potId of STAT_POTIONS[potStat]) {
    if (!player.hasItem(potId)) continue;
    const item = getItem(potId);
    const val  = item?.effect?.value ?? 0;
    if (val > bestVal) { bestVal = val; best = { potId, stat: potStat, value: val }; }
  }
  return best;
}

// Best potion across ALL offensive stats (for the 'pot' action).
function bestAnyPotion(player) {
  let best = null, bestVal = 0;
  for (const stat of ['F','D','M','C']) {
    const p = bestPotionFor(player, stat);
    if (p && p.value > bestVal) { bestVal = p.value; best = p; }
  }
  return best;
}

// Apply a stat potion: adds tempBonus and removes the item.
function applyPotion(player, potId, stat, value) {
  player.addTempBonus(stat, value);
  player.removeItem(potId);
}

// Best blood drop in inventory (highest sum of statBonus values).
function bestBloodDrop(player) {
  let best = null, bestSum = 0;
  for (const id of BLOOD_DROP_IDS) {
    if (!player.hasItem(id)) continue;
    const item = getItem(id);
    if (!item?.statBonus) continue;
    const sum = Object.values(item.statBonus).reduce((s, v) => s + v, 0);
    if (sum > bestSum) { bestSum = sum; best = { id, statBonus: item.statBonus }; }
  }
  return best;
}

// Best priest blessing in inventory (highest effect.value).
function bestPriestPot(player) {
  let best = null, bestVal = 0;
  for (const id of PRIEST_POT_IDS) {
    if (!player.hasItem(id)) continue;
    const item = getItem(id);
    const val  = item?.effect?.value ?? 0;
    if (val > bestVal) { bestVal = val; best = { id, value: val }; }
  }
  // Also check player.priestBuff directly (pot already consumed but buff active)
  if (!best && (player.priestBuff ?? 0) > 0)
    best = { id: null, value: player.priestBuff };
  return best;
}

// ── Fight simulator ──────────────────────────────────────────────────────────
// firstSetup: optional function(player, mob) called once before turn 0 to
//             apply a consumable effect (heal, smoke, potion).
// Returns 'win' | 'loss' | 'escaped'.

function simulateFight(playerState, mobState, firstSetup, firstAttackType) {
  const p   = clonePlayer(playerState);
  const m   = cloneMob(mobState);
  const log = [];
  let playerTurn = true;

  // Apply pre-action consumable
  if (firstSetup) firstSetup(p, m);

  for (let turn = 0; turn < MAX_ROUNDS; turn++) {
    if (!p.isAlive || m.hearts.current <= 0) break;

    let result;
    if (playerTurn) {
      let action;
      if (turn === 0 && firstAttackType !== undefined) {
        // Use the specified attack type on turn 0 (after consumable was applied)
        if (firstAttackType === 'bail') {
          action = { type: 'bail' };
        } else if (firstAttackType === 'C') {
          action = { type: 'bard' };
        } else {
          let spellId = null;
          if (firstAttackType === 'M') {
            const spell = p.inventory
              .map(id => getItem(id))
              .filter(i => i?.subtype === 'attack')
              .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
            spellId = spell?.id ?? null;
          }
          action = { type: 'attack', attackType: firstAttackType, spellId };
        }
      } else {
        action = greedyAction(p, m);
      }
      result = Combat.takePlayerAttack(p, m, action, log);
    } else {
      result = Combat.takeMobAttack(p, m, log, Combat.rollMobAttack(m));
    }

    switch (result.outcome) {
      case 'victory':          return 'win';
      case 'defeat':           return 'loss';
      case 'escaped':          return 'escaped';
      case 'charisma_pending':
        Combat.applyCharismaOutcome(p, m, { family: 'deceive', tier: 1 }, result.charismaResult, log);
        return 'escaped';
    }
    playerTurn = !playerTurn;
  }

  if (!p.isAlive)            return 'loss';
  if (m.hearts.current <= 0) return 'win';
  return (p.hearts.current / p.hearts.max) >= (m.hearts.current / m.hearts.max) ? 'win' : 'loss';
}

// ── Available action builder ─────────────────────────────────────────────────
// Returns list of { id, setup, attackType } where:
//   setup      = function(player, mob) applied before rolling, or null
//   attackType = the attack type used on turn 0, or null for bail

function getAvailableActions(player, mob) {
  const actions = [];

  // Plain attacks (no consumable)
  const plainAttack = (t) => ({ id: `atk_${t}`, setup: null, attackType: t });
  actions.push(plainAttack('F'));
  actions.push(plainAttack('D'));
  if (player.canAttackMagic()) actions.push(plainAttack('M'));
  actions.push(plainAttack('C'));

  // Bail
  if (player.canEscape()) actions.push({ id: 'bail', setup: null, attackType: 'bail' });

  // heal: use pot_heal → then greedy attack
  if (player.hasItem('pot_heal')) {
    const bestAtk = bestAttackType(player, mob);
    actions.push({
      id: 'heal',
      setup: (p) => {
        p.removeItem('pot_heal');
        p.healHeart(1);
      },
      attackType: bestAtk,
    });
  }

  // smoke: use sp_smoke (immune next mob attack) → then greedy attack
  if (player.hasItem('sp_smoke')) {
    const bestAtk = bestAttackType(player, mob);
    actions.push({
      id: 'smoke',
      setup: (p) => {
        p.removeItem('sp_smoke');
        p.isSmokeActive = true;
      },
      attackType: bestAtk,
    });
  }

  // pot: use best available offensive stat potion → boosted matching attack
  const bestPot = bestAnyPotion(player);
  if (bestPot) {
    actions.push({
      id: 'pot',
      setup: (p) => applyPotion(p, bestPot.potId, bestPot.stat, bestPot.value),
      attackType: bestPot.stat,
    });
  }

  // pot_A: use best armor potion → greedy attack (reduces incoming damage this turn)
  const aPot = bestPotionFor(player, 'A');
  if (aPot) {
    actions.push({
      id: 'pot_A',
      setup: (p) => applyPotion(p, aPot.potId, 'A', aPot.value),
      attackType: bestAttackType(player, mob),
    });
  }

  // pot_V: use best speed potion → greedy attack (initiative boost)
  const vPot = bestPotionFor(player, 'V');
  if (vPot) {
    actions.push({
      id: 'pot_V',
      setup: (p) => applyPotion(p, vPot.potId, 'V', vPot.value),
      attackType: bestAttackType(player, mob),
    });
  }

  // blood: apply best blood drop stat bonuses to baseStats for the whole fight
  const blood = bestBloodDrop(player);
  if (blood) {
    actions.push({
      id: 'blood',
      setup: (p) => {
        for (const [stat, val] of Object.entries(blood.statBonus))
          p.baseStats[stat] = (p.baseStats[stat] ?? 0) + val;
        p.removeItem(blood.id);
      },
      attackType: bestAttackType(player, mob),
    });
  }

  // priest_pot: use priest blessing (+N all stats, one roll) via priestBuff
  const priest = bestPriestPot(player);
  if (priest && priest.id) {
    const blessedAtk = bestAttackType(player, mob); // pick before applying buff
    actions.push({
      id: 'priest_pot',
      setup: (p) => {
        p.priestBuff = (p.priestBuff ?? 0) + priest.value;
        p.removeItem(priest.id);
      },
      attackType: blessedAtk,
    });
  }

  return actions;
}

// ── Monte Carlo evaluator ────────────────────────────────────────────────────

function mcEval(player, mob, K) {
  const actions  = getAvailableActions(player, mob);
  const winRates = {};

  for (const { id, setup, attackType } of actions) {
    let wins = 0;
    for (let k = 0; k < K; k++) {
      const outcome = simulateFight(player, mob, setup, attackType);
      if (outcome === 'win' || outcome === 'escaped') wins++;
    }
    winRates[id] = wins / K;
  }

  return winRates;
}

// ── State sampler ────────────────────────────────────────────────────────────

const NON_BOSS_MOBS = MOBS.list.filter(m => !m.isBoss);

const EQUIP_BY_TIER = {
  low:  ['knife','sword','sling','bow','wand','staff','flute','lyre',
          'shoes','boots','jacket','lt_armor','shield'],
  mid:  ['mace','axe','longbow','crossbow','necklace','ring','lute','trumpet',
          'mule','horse','md_armor','hv_armor','lg_shield'],
  high: ['greatsword','halberd','pistol','arquebus','orb','grimoire',
          'guitar','accordion','carriage','pegasus'],
};
const ALL_EQUIP = [...EQUIP_BY_TIER.low, ...EQUIP_BY_TIER.mid, ...EQUIP_BY_TIER.high];

const SPELL_IDS = ['bang','fireball','flare','blaze','blizzard','freeze',
                   'discharge','lightning','bolt','explosion','bomb',
                   'destruction','slash','laceration','rend'];

function rng(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)      { return arr[Math.floor(Math.random() * arr.length)]; }

function samplePlayer(tier) {
  const p = new Player({ id: 'sim', name: 'Sim' });
  const [sMin, sMax] = [[1,4],[2,7],[4,11],[6,16]][tier];
  for (const s of ['F','D','A','M','C','V']) p.baseStats[s] = rng(sMin, sMax);

  p.hearts.max     = rng(2 + tier, 5 + tier * 2);
  p.hearts.current = rng(1, p.hearts.max);

  // Equipment
  const numEquip = rng(0, Math.min(4, tier + 1));
  const pool = tier <= 1 ? [...EQUIP_BY_TIER.low,  ...EQUIP_BY_TIER.mid]
             : tier <= 2 ? [...EQUIP_BY_TIER.mid,  ...EQUIP_BY_TIER.high]
             : ALL_EQUIP;
  pool.slice().sort(() => Math.random() - 0.5).some(id => {
    const item = getItem(id);
    if (item && p.canEquip(item)) p.equip(item);
    return p.equippedCount() >= numEquip;
  });

  // Combat spells (35% chance)
  if (Math.random() < 0.35) {
    const spellId = pick(SPELL_IDS);
    for (let i = 0; i < rng(1, 3); i++) p.addItem(spellId);
  }

  // ── Consumable inventory — the interesting part ───────────────────────────

  // Healing potions: common across all tiers
  const healCount = rng(0, 3);
  for (let i = 0; i < healCount; i++) p.addItem('pot_heal');

  // Smoke spell: moderately rare
  if (Math.random() < 0.25) p.addItem('sp_smoke');

  // Stat potions: pick a random stat and tier
  const potChance = [0.2, 0.35, 0.50, 0.65][tier];
  if (Math.random() < potChance) {
    const stat  = pick(['F','D','M','C']);
    const potId = pick(STAT_POTIONS[stat]);
    const count = rng(1, 3);
    for (let i = 0; i < count; i++) p.addItem(potId);
  }

  // A / V potions: moderately common (defensive potions)
  if (Math.random() < 0.25) {
    const potId = pick(STAT_POTIONS['A']);
    const count = rng(1, 3);
    for (let i = 0; i < count; i++) p.addItem(potId);
  }
  if (Math.random() < 0.20) {
    const potId = pick(STAT_POTIONS['V']);
    const count = rng(1, 2);
    for (let i = 0; i < count; i++) p.addItem(potId);
  }

  // Blood drops: fight-duration stat bonuses, more common at higher tiers
  const bloodChance = [0.05, 0.10, 0.20, 0.30][tier];
  if (Math.random() < bloodChance) {
    const id = pick(BLOOD_DROP_IDS);
    const count = rng(1, 2);
    for (let i = 0; i < count; i++) p.addItem(id);
  }

  // Priest blessings: rare across all tiers
  if (Math.random() < 0.12) {
    const id = pick(PRIEST_POT_IDS);
    p.addItem(id);
  }

  // Rope (bail option): rare
  if (Math.random() < 0.15) p.addItem('rope');

  return p;
}

function sampleMob(tier) {
  const pool = NON_BOSS_MOBS.filter(m => m.tier === tier);
  return MOBS.spawn(pick(pool.length ? pool : NON_BOSS_MOBS).id);
}

// Advance a fight 0-3 full rounds using greedy play on both sides.
// Returns { player, mob } at a mid-fight state, or original if fight ended early.
function advanceFight(player, mob, rounds) {
  if (rounds === 0) return { player, mob };
  const p = clonePlayer(player);
  const m = cloneMob(mob);
  const log = [];
  let playerTurn = true;

  for (let h = 0; h < rounds * 2; h++) {
    if (!p.isAlive || m.hearts.current <= 0) return { player, mob };
    let result;
    if (playerTurn) {
      result = Combat.takePlayerAttack(p, m, greedyAction(p, m), log);
    } else {
      result = Combat.takeMobAttack(p, m, log, Combat.rollMobAttack(m));
    }
    if (['victory','defeat','escaped','charisma_pending'].includes(result.outcome))
      return { player, mob };
    playerTurn = !playerTurn;
  }

  if (!p.isAlive || m.hearts.current <= 0) return { player, mob };
  return { player: p, mob: m };
}

function sampleFightState() {
  const playerTier = rng(0, 3);
  const mobTier    = Math.max(0, Math.min(3, playerTier + rng(-1, 1)));
  const player     = samplePlayer(playerTier);
  const mob        = sampleMob(mobTier);
  return advanceFight(player, mob, rng(0, 3));
}

// ── Boss fight sampler ────────────────────────────────────────────────────────
// Mirrors the sim_dragon.js setups exactly: base stat 6 for the primary stat,
// tier-6 gear with random enchant combos, full consumable stacks, dragon/boss enemy.
//
// This is the critical scenario the NN was missing: at effective attack stat 15
// (base 6 + item 6 + enchant 3), using a pot_F3/D3/M3 jumps hit rate from ~28%
// to ~58% against the dragon's defense of 17+d6. The NN needs many examples of
// this to learn the consumable timing decision correctly.

const BOSS_FIGHT_EQUIP = {
  F: { weapon:'halberd',  weaponEnchants:['sharpness','fury','flame'] },
  D: { weapon:'arquebus', weaponEnchants:['precision','hawk_eye','flame'] },
  M: { weapon:'grimoire', weaponEnchants:['flame','arcane','bloodlust'] },
};
const BOSS_ARMOR_ENCHANTS  = ['lightness','resistance'];
const BOSS_SHIELD_ENCHANTS = ['thorns','arcane','resistance'];
const ALL_BOSS_MOBS = MOBS.list.filter(m => m.isBoss);
const BOSS_SPELL_IDS = ['blaze','blaze','blaze','rend','lightning','fireball'];

function equipItemWithEnchant(player, itemId, enchantId) {
  const tmpl = ITEM_REGISTRY[itemId];
  if (!tmpl) return;
  const item = JSON.parse(JSON.stringify(tmpl));
  player.inventory.push(item.id);
  if (!player.equip(item)) return;
  if (enchantId) {
    const enchObj = ENCHANTMENTS.find(e => e.id === enchantId);
    if (enchObj) player.applyEnchantment(item.slot, enchObj, 1);
  }
}

function sampleBossFightState() {
  const p    = new Player({ id: 'sim', name: 'Sim' });
  const arch = pick(['F','D','M']);
  const cfg  = BOSS_FIGHT_EQUIP[arch];

  // Base stats: primary stat at 6, A at 6, others moderate
  const stats = { F:rng(2,4), D:rng(2,4), A:6, M:rng(2,4), C:rng(2,4), V:rng(3,5) };
  stats[arch] = 6;
  if (arch === 'D') stats.V = rng(4,6);
  p.baseStats = stats;

  // HP: partially depleted to simulate a fight in progress
  const maxHp = rng(6, 10);
  p.hearts.max     = maxHp;
  p.hearts.current = Math.max(1, Math.floor(maxHp * (0.35 + Math.random() * 0.65)));

  // Gear: weapon + hv_armor + lg_shield with random enchant combos
  equipItemWithEnchant(p, cfg.weapon,   pick(cfg.weaponEnchants));
  equipItemWithEnchant(p, 'hv_armor',   pick(BOSS_ARMOR_ENCHANTS));
  equipItemWithEnchant(p, 'lg_shield',  pick(BOSS_SHIELD_ENCHANTS));

  // Consumables: mirror sim_dragon.js stacks so the NN sees these states
  for (let i = 0; i < rng(0, 5); i++) p.addItem('pot_heal');
  for (let i = 0; i < rng(0, 3); i++) p.addItem('sp_smoke');

  // Offensive stat pot — the key consumable the NN needs to learn to use
  if (Math.random() < 0.80) {
    const potStat  = arch;                              // F/D/M matching the archetype
    const potTier  = pick(['pot_'+potStat+'1','pot_'+potStat+'2','pot_'+potStat+'3']);
    const potCount = rng(1, 3);
    for (let i = 0; i < potCount; i++) p.addItem(potTier);
  }

  // Defensive A pot (also commonly held)
  if (Math.random() < 0.65) {
    const aPot  = pick(['pot_A1','pot_A2','pot_A3']);
    const count = rng(1, 3);
    for (let i = 0; i < count; i++) p.addItem(aPot);
  }

  // M-mage: blaze/rend spells (key for M archetype win condition)
  if (arch === 'M') {
    const blazeCount = rng(3, 15);
    for (let i = 0; i < blazeCount; i++) p.addItem('blaze');
    if (Math.random() < 0.70) {
      const rendCount = rng(1, 5);
      for (let i = 0; i < rendCount; i++) p.addItem('rend');
    }
  } else if (Math.random() < 0.25) {
    // Non-mage: occasionally has a spell
    p.addItem(pick(BOSS_SPELL_IDS));
  }

  // Enemy: dragon 60% of the time, other tier-3 bosses 40%
  const bossId = Math.random() < 0.60
    ? 'dragon'
    : (ALL_BOSS_MOBS.length ? pick(ALL_BOSS_MOBS).id : 'dragon');
  const mob = MOBS.spawn(bossId);

  return advanceFight(p, mob, rng(0, 3));
}

// ── Unfavoured state sampler ──────────────────────────────────────────────────
// Generates fight states where the player is at a statistical disadvantage.
// severity: 'slight' = borderline beatable, 'hard' = clearly outmatched.
//
// These are oversampled (see SCENARIO_MIX below) because:
//   - Easy fights produce near-zero signal: greedy attack always wins, no consumable
//     decision matters.
//   - Hard fights are where the consumable timing decisions are non-trivial, so the
//     NN gets the most useful gradient here.
//   - Generalisation: a policy that wins slightly-unfavoured fights also handles
//     even and favoured fights correctly — consumable use is simply less urgent.

function sampleUnfavouredPlayer(tier, severity) {
  const p = new Player({ id: 'sim', name: 'Sim' });
  const [sMin, sMax] = [[1,4],[2,7],[4,11],[6,16]][tier];

  // Stats from the lower portion of the tier range
  const weakCeil = sMin + Math.floor((sMax - sMin) * (severity === 'hard' ? 0.30 : 0.45));
  for (const s of ['F','D','A','M','C','V'])
    p.baseStats[s] = rng(sMin, Math.max(sMin, weakCeil));

  // HP: already somewhat depleted to simulate a fight in progress
  p.hearts.max     = rng(2 + tier, 4 + tier);
  const hpFrac     = severity === 'hard' ? 0.55 : 0.75;
  p.hearts.current = Math.max(1, Math.min(
    p.hearts.max,
    Math.floor(p.hearts.max * hpFrac * (0.8 + Math.random() * 0.4))
  ));

  // Equipment: fewer pieces than a well-geared player at this tier
  const numEquip = rng(0, Math.max(0, tier));
  const pool = tier <= 1 ? [...EQUIP_BY_TIER.low]
             : tier <= 2 ? [...EQUIP_BY_TIER.low, ...EQUIP_BY_TIER.mid]
             :              [...EQUIP_BY_TIER.mid];
  pool.slice().sort(() => Math.random() - 0.5).some(id => {
    const item = getItem(id);
    if (item && p.canEquip(item)) p.equip(item);
    return p.equippedCount() >= numEquip;
  });

  // Combat spells: slightly less common (underprepared player)
  if (Math.random() < 0.25) {
    const spellId = pick(SPELL_IDS);
    for (let i = 0; i < rng(1, 2); i++) p.addItem(spellId);
  }

  // Consumables: deliberately generous — the NN needs states where using
  // a consumable is correct AND states where it isn't (to learn the boundary).

  // Healing potions: more common, since the player often needs them
  const healCount = rng(0, 2 + (severity === 'hard' ? 1 : 0));
  for (let i = 0; i < healCount; i++) p.addItem('pot_heal');

  // Smoke
  if (Math.random() < 0.35) p.addItem('sp_smoke');

  // Offensive stat potions: boosted chance — "do I pop this pot now or save it?"
  if (Math.random() < (severity === 'hard' ? 0.65 : 0.55)) {
    const stat  = pick(['F','D','M','C']);
    const potId = pick(STAT_POTIONS[stat]);
    const count = rng(1, 2);
    for (let i = 0; i < count; i++) p.addItem(potId);
  }

  // Defensive potions (A / V)
  if (Math.random() < 0.30) p.addItem(pick(STAT_POTIONS['A']));
  if (Math.random() < 0.25) p.addItem(pick(STAT_POTIONS['V']));

  // Blood drops: fight-duration stat bonuses
  const bloodChance = [0.10, 0.15, 0.25, 0.35][tier];
  if (Math.random() < bloodChance) p.addItem(pick(BLOOD_DROP_IDS));

  // Priest blessings: slightly more common than baseline
  if (Math.random() < 0.18) p.addItem(pick(PRIEST_POT_IDS));

  // Rope (bail option)
  if (Math.random() < 0.15) p.addItem('rope');

  return p;
}

function sampleUnfavouredFightState(severity = 'slight') {
  const playerTier = rng(0, 3);
  // Mob is always same tier or harder — never easier
  const mobTier    = severity === 'hard'
    ? Math.min(3, playerTier + rng(0, 1))
    : playerTier;
  const player     = sampleUnfavouredPlayer(playerTier, severity);
  const mob        = sampleMob(mobTier);
  // Advance only 0-2 rounds: player is already in a tough spot,
  // no need to simulate a comfortable early fight first.
  return advanceFight(player, mob, rng(0, 2));
}

// ── Scenario mix ──────────────────────────────────────────────────────────────
// Controls what fraction of training states come from each sampler.
//
//   normal  20% — balanced fight across all tiers, consumables optional
//   slight  30% — mild disadvantage, consumables often worthwhile
//   hard    15% — clearly outmatched, consumables frequently decisive
//   boss    35% — maxed-out player (base stat 6, tier-6 gear) vs dragon/bosses
//                 THE KEY ADDITION: teaches the NN to use offensive pots in
//                 boss fights where hit rate jumps from ~28% to ~58% per roll.

const NORMAL_RATIO = 0.20;
const SLIGHT_RATIO = 0.30;
const HARD_RATIO   = 0.15;
// boss ratio = 1 - NORMAL_RATIO - SLIGHT_RATIO - HARD_RATIO = 0.35

function sampleState() {
  const r = Math.random();
  if (r < NORMAL_RATIO)                              return sampleFightState();
  if (r < NORMAL_RATIO + SLIGHT_RATIO)               return sampleUnfavouredFightState('slight');
  if (r < NORMAL_RATIO + SLIGHT_RATIO + HARD_RATIO)  return sampleUnfavouredFightState('hard');
  return sampleBossFightState();
}

// ── Feature extractor ────────────────────────────────────────────────────────
// 38 features, all in [0, 1].

function getMobEffStat(mob, stat) {
  let v = mob.stats[stat] ?? 0;
  for (const e of (mob.statusEffects ?? []))
    if (e.type === 'malus' && e.stat === stat) v += e.value;
  return Math.max(0, v);
}

function extractFeatures(player, mob) {
  const f = [];

  // [0-5] player effective stats (÷35)
  for (const s of ['F','D','A','M','C','V']) f.push(player.getStat(s) / 35);

  // [6-7] player HP
  f.push(player.hearts.current / player.hearts.max);
  f.push(player.hearts.current / 12);

  // [8-13] mob effective stats (÷35)
  for (const s of ['F','D','A','M','C','V']) f.push(getMobEffStat(mob, s) / 35);

  // [14-15] mob HP
  f.push(mob.hearts.current / mob.hearts.max);
  f.push(mob.hearts.current / 12);

  // [16] bail available
  f.push(player.canEscape() ? 1 : 0);

  // [17] best spell magic value (÷3)
  const bestSpell = player.inventory
    .map(id => getItem(id))
    .filter(i => i?.subtype === 'attack')
    .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
  f.push(bestSpell ? (bestSpell.magicValue ?? 0) / 3 : 0);

  // [18-20] player status: fire turns, lightning, ice speed malus
  const pFire = player.statusEffects.find(e => e.type === 'fire');
  f.push(pFire ? Math.min(pFire.turnsLeft, 5) / 5 : 0);
  f.push(player.statusEffects.some(e => e.type === 'lightning') ? 1 : 0);
  const pIce = player.statusEffects.filter(e => e.type === 'malus' && e.stat === 'V')
    .reduce((s, e) => s + Math.abs(e.value), 0);
  f.push(Math.min(pIce, 6) / 6);

  // [21-23] mob status: fire turns, lightning, ice speed malus
  const mFire = (mob.statusEffects ?? []).find(e => e.type === 'fire');
  f.push(mFire ? Math.min(mFire.turnsLeft, 5) / 5 : 0);
  f.push((mob.statusEffects ?? []).some(e => e.type === 'lightning') ? 1 : 0);
  const mIce = (mob.statusEffects ?? []).filter(e => e.type === 'malus' && e.stat === 'V')
    .reduce((s, e) => s + Math.abs(e.value), 0);
  f.push(Math.min(mIce, 6) / 6);

  // [24-27] mob next attack type one-hot (F,D,M,C)
  const nextAtk = Combat.rollMobAttack(mob);
  for (const t of ['F','D','M','C']) f.push(nextAtk === t ? 1 : 0);

  // [28-29] tier context
  f.push((mob.tier ?? 0) / 3);
  const avgStat = ['F','D','A','M','C','V'].reduce((s,t) => s + player.getStat(t), 0) / 6;
  f.push(Math.min(avgStat, 35) / 35);

  // ── Consumable inventory features ─────────────────────────────────────────

  // [30] healing potions count (capped at 5)
  const healCount = player.inventory.filter(id => id === 'pot_heal').length;
  f.push(Math.min(healCount, 5) / 5);

  // [31] has smoke
  f.push(player.hasItem('sp_smoke') ? 1 : 0);

  // [32-35] best stat potion value for each attack stat (÷6, 0 if none)
  for (const stat of ['F','D','M','C']) {
    const p2 = bestPotionFor(player, stat);
    f.push(p2 ? p2.value / 6 : 0);
  }

  // [36] mob estimated damage per hit (mob attack stat - player defense stat, normalised)
  // How much the mob's best attack threatens the player.
  const mobBestAtk = ATTACK_TYPES.reduce((b, t) =>
    getMobEffStat(mob, t) > getMobEffStat(mob, b) ? t : b, 'F');
  const mobAtkPow  = getMobEffStat(mob, mobBestAtk);
  const playerDef  = player.getStat(DEFENSE_FOR[mobBestAtk]);
  const netThreat  = Math.max(0, mobAtkPow - playerDef);
  f.push(Math.min(netThreat, 20) / 20);

  // [37] turns-to-death estimate: player HP / P(mob hits per round), capped at 10
  // P(mob hits) ≈ clamp((mobAtkPow - 3) - playerDef, 0, 6) / 6 (approximate d6 probability)
  const mobRollExpected = Math.max(0, mobAtkPow - 3 + 3.5); // expected mob roll
  const playerRollExpected = playerDef + 3.5;
  const hitProb = Math.max(0, Math.min(1, (mobRollExpected - playerRollExpected) / 6 + 0.5));
  const turnsToDeath = hitProb > 0 ? Math.min(10, player.hearts.current / hitProb) : 10;
  f.push(turnsToDeath / 10);

  // ── New consumable features ─────────────────────────────────────────────────

  // [38] best A pot value ÷ 6 (0 if none)
  const aPot2 = bestPotionFor(player, 'A');
  f.push(aPot2 ? aPot2.value / 6 : 0);

  // [39] best V pot value ÷ 6 (0 if none)
  const vPot2 = bestPotionFor(player, 'V');
  f.push(vPot2 ? vPot2.value / 6 : 0);

  // [40] has blood drop (binary)
  f.push(BLOOD_DROP_IDS.some(id => player.hasItem(id)) ? 1 : 0);

  // [41] best priest pot value ÷ 6 (0 if none, also covers active priestBuff)
  const priestVal = Math.max(
    PRIEST_POT_IDS.reduce((best, id) => {
      if (!player.hasItem(id)) return best;
      return Math.max(best, getItem(id)?.effect?.value ?? 0);
    }, 0),
    player.priestBuff ?? 0
  );
  f.push(Math.min(priestVal, 6) / 6);

  return f; // 42 features
}

// ── Main loop ────────────────────────────────────────────────────────────────

const N_STATES   = parseInt(process.argv[2] ?? '20000', 10);
const K_ROLLOUTS = parseInt(process.argv[3] ?? '100',   10);
const OUT_FILE   = process.argv[4] ?? path.join(__dirname, 'training_data.jsonl');

console.log(`Monte Carlo training data generator (consumable-focused)`);
console.log(`  States   : ${N_STATES}`);
console.log(`  Rollouts : ${K_ROLLOUTS} per action`);
console.log(`  Output   : ${OUT_FILE}\n`);

const outStream = fs.createWriteStream(OUT_FILE);
const t0        = Date.now();
let written = 0, skipped = 0;

for (let i = 0; i < N_STATES; i++) {
  const { player, mob } = sampleState();
  if (!player.isAlive || mob.hearts.current <= 0) { skipped++; continue; }

  const features   = extractFeatures(player, mob);
  const winRates   = mcEval(player, mob, K_ROLLOUTS);
  const actionKeys = Object.keys(winRates);
  const bestAction = actionKeys.reduce((best, k) => winRates[k] > winRates[best] ? k : best, actionKeys[0]);

  outStream.write(JSON.stringify({
    features,
    win_rates: winRates,
    best_action: bestAction,
    meta: {
      mob_id:          mob.id,
      mob_tier:        mob.tier,
      player_hp_ratio: +(player.hearts.current / player.hearts.max).toFixed(3),
      heal_count:      player.inventory.filter(id => id === 'pot_heal').length,
      has_smoke:       player.hasItem('sp_smoke'),
      has_pot:         bestAnyPotion(player) !== null,
    },
  }) + '\n');
  written++;

  if ((i + 1) % 200 === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    const rate    = (i + 1) / elapsed;
    const eta     = Math.round((N_STATES - i - 1) / rate);
    const pct     = ((i + 1) / N_STATES * 100).toFixed(1);
    process.stdout.write(`\r  ${pct}%  [${i+1}/${N_STATES}]  ${rate.toFixed(0)} states/s  ETA ${eta}s   `);
  }
}

outStream.end(() => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nDone: ${written} records, ${elapsed}s`);
});
