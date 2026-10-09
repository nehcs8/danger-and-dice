// Upgrade advisor — supervised training.
// Run from project root: node train/train_upgrade_advisor.js
//
// For every (player-state × candidate-upgrade) pair predicts:
//   gain — improvement in weighted zone viability score after applying the upgrade
//
// Candidate types:
//   regular  — EQUIPMENT item better than currently equipped in that slot
//   guild    — SPECIAL_EQUIPMENT at various levels (1, 2, 4, 6 and 8 for magic_flute)
//   enchant  — Add enchantment to an already-equipped item that lacks one
//
// Zone viability score (weighted win-rate sum):
//   sum over tiers 0-3: TIER_WEIGHTS[t] * winProb[t]
//   TIER_WEIGHTS = [0.5, 1.0, 1.5, 2.0]
//
// Feature vector: 24 player features (same as estimator) + 18 upgrade features = 42 total
// Network: 42 → 64 → 32 → 1  (ReLU hidden, linear output)
// Output: js/data/weights/upgrade_advisor_weights.js

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

const MOBS              = get('MOBS');
const Player            = get('Player');
const Combat            = get('Combat');
const getItem           = get('getItem');
const EQUIPMENT         = get('EQUIPMENT');
const SPECIAL_EQUIPMENT = get('SPECIAL_EQUIPMENT');
const ENCHANTMENTS      = get('ENCHANTMENTS');

// ── Constants ─────────────────────────────────────────────────────────────────

const STATS       = ['F','D','A','M','C','V'];
const ALL_SLOTS   = ['strength','dexterity','magic','charisma','speed','armor','shield'];
const SLOT_IDX    = Object.fromEntries(ALL_SLOTS.map((s,i) => [s, i]));
const TIERS       = [0, 1, 2, 3];
const TIER_WEIGHTS = [0.5, 1.0, 1.5, 2.0];

// Primary stat boosted by each slot
const SLOT_STAT = { strength:'F', dexterity:'D', magic:'M', charisma:'C', speed:'V', armor:'A', shield:'A' };

// Which enchantments are applicable to each slot (by category match)
const ENCHANT_FOR_SLOT = {
  strength:  ['sharpness','fury','bloodlust','plunder','flame'],
  dexterity: ['precision','hawk_eye','bloodlust','plunder','flame'],
  armor:     ['arcane','thorns','lightness','resistance'],
  shield:    ['arcane','thorns','resistance'],
};

// Max guild item level (most cap at 6; magic_flute_thief caps at 8)
const GUILD_MAX_LEVEL = id => id === 'magic_flute_thief' ? 8 : 6;

// Guild levels to sample during training: covers early/mid/max power
const GUILD_TRAIN_LEVELS = id => id === 'magic_flute_thief' ? [1, 2, 4, 8] : [1, 2, 4, 6];

const N_CONFIGS        = 250;   // player configs per progression level
const PROGRESSIONS     = [0, 1, 2, 3, 4, 5];
const N_SIMS_BASELINE  = 20;    // fight sims per tier for baseline
const N_SIMS_UPGRADE   = 15;    // fight sims per tier per upgrade candidate
const MAX_CANDIDATES   = 28;    // max upgrade candidates per player (random sample if more)
const EPOCHS           = 150;
const LR               = 0.002;
const HIDDEN           = [64, 32];

// ── Player feature vector (must match combat_estimator.js) ────────────────────

const MODIFIER_ENCHANTS = new Set(['fury','bloodlust','hawk_eye','thorns','arcane','flame','plunder']);

function playerFeatureVec(player, tier) {
  const v = new Array(24).fill(0);
  let i   = 0;

  v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
  v[i++] = Math.min(player.hearts.max, 10) / 10;
  for (const s of STATS) v[i++] = Math.min(player.getStat(s), 25) / 25;
  v[i++] = player.hasEquipped('kryss')        ? 1 : 0;
  v[i++] = player.hasEquipped('garrote')      ? 1 : 0;
  v[i++] = player.hasEnchantment('fury')      ? 1 : 0;
  v[i++] = player.hasEnchantment('bloodlust') ? 1 : 0;
  v[i++] = player.hasEnchantment('hawk_eye')  ? 1 : 0;
  v[i++] = player.hasEnchantment('thorns')    ? 1 : 0;
  v[i++] = player.hasEnchantment('arcane')    ? 1 : 0;
  v[i++] = player.canEscape()                 ? 1 : 0;
  v[i++] = player.inventory.includes('sp_smoke') ? 1 : 0;
  v[i++] = player.friendsList.length > 0         ? 1 : 0;

  const bestPot = player.inventory.reduce((best, id) => {
    if (!/^pot_[FDAMCV]\d$/.test(id)) return best;
    return Math.max(best, parseInt(id[5]) || 0);
  }, 0);
  v[i++] = bestPot / 6;
  v[i++] = player.canAttackMagic() ? 1 : 0;
  for (const t of TIERS) v[i++] = t === tier ? 1 : 0;

  return v; // 24 features
}

// ── Upgrade feature vector (18 features) ─────────────────────────────────────
//
//  0      is_regular       (one-hot, 3 features)
//  1      is_enchant
//  2      is_guild
//  3-9    slot one-hot     (strength=3, dexterity=4, ..., shield=9)
// 10      net_primary_stat_gain / 10  (getStat delta for slot's primary stat)
// 11      fills_empty_slot            (1 = slot was empty before)
// 12      guild_level / 8             (current/assumed level; 0 if not guild)
// 13      guild_max_level / 8         (6/8 or 8/8 for magic_flute)
// 14      has_special_effect          (kryss/garrote/dark_tome/etc. boolean)
// 15      enchant_is_stat_bonus       (sharpness/precision/resistance/lightness)
// 16      enchant_is_modifier         (fury/bloodlust/arcane/etc.)
// 17      cost / 200

function upgradeFeatureVec(player, candidate) {
  const v = new Array(18).fill(0);

  // type one-hot
  v[0] = candidate.type === 'regular' ? 1 : 0;
  v[1] = candidate.type === 'enchant' ? 1 : 0;
  v[2] = candidate.type === 'guild'   ? 1 : 0;

  // slot one-hot
  const si = SLOT_IDX[candidate.slot];
  if (si !== undefined) v[3 + si] = 1;

  // net stat gain for slot's primary stat
  const primaryStat = SLOT_STAT[candidate.slot] ?? 'F';
  const before = player.getStat(primaryStat);
  const clone  = shallowCloneForStat(player);
  applyUpgrade(clone, candidate);
  const after  = clone.getStat(primaryStat);
  v[10] = Math.min(Math.max(after - before, 0), 10) / 10;

  // fills empty slot
  v[11] = player.equipped[candidate.slot] ? 0 : 1;

  // guild features
  v[12] = candidate.guildLevel  ? candidate.guildLevel / 8 : 0;
  v[13] = candidate.guildMaxLvl ? candidate.guildMaxLvl / 8 : 0;

  // special effect flag
  v[14] = candidate.hasSpecialEffect ? 1 : 0;

  // enchantment type flags
  if (candidate.type === 'enchant') {
    const enchObj = ENCHANTMENTS.find(e => e.id === candidate.enchantId);
    if (enchObj) {
      const isStatBonus = enchObj.effect?.type === 'stat_bonus' || enchObj.effect?.type === 'remove_speed_malus';
      v[15] = isStatBonus ? 1 : 0;
      v[16] = MODIFIER_ENCHANTS.has(candidate.enchantId) ? 1 : 0;
    }
  }

  // cost
  v[17] = Math.min(candidate.cost ?? 0, 200) / 200;

  return v; // 18 features
}

// Minimal clone just for stat computation (no combat fields needed)
function shallowCloneForStat(player) {
  const c = new Player({ id: 'tmp', name: 'tmp', isBot: true });
  c.baseStats       = { ...player.baseStats };
  c.equipped        = Object.fromEntries(
    ALL_SLOTS.map(s => [s, player.equipped[s] ? { ...player.equipped[s] } : null])
  );
  c.guildItemLevels = JSON.parse(JSON.stringify(player.guildItemLevels));
  c.transmutation   = null;
  return c;
}

// Full player snapshot for fight simulation
function snapshotPlayer(p) {
  return {
    baseStats:       { ...p.baseStats },
    hearts:          { ...p.hearts },
    equipped:        Object.fromEntries(ALL_SLOTS.map(s => [s, p.equipped[s] ? { ...p.equipped[s] } : null])),
    inventory:       [...p.inventory],
    guildItemLevels: JSON.parse(JSON.stringify(p.guildItemLevels)),
    friendsList:     [],
    chainedTurns:    0,
  };
}

function restorePlayer(p, snap) {
  Object.assign(p.baseStats, snap.baseStats);
  p.hearts          = { ...snap.hearts };
  p.equipped        = Object.fromEntries(ALL_SLOTS.map(s => [s, snap.equipped[s] ? { ...snap.equipped[s] } : null]));
  p.inventory       = [...snap.inventory];
  p.guildItemLevels = JSON.parse(JSON.stringify(snap.guildItemLevels));
  p.friendsList     = [];
  p.chainedTurns    = 0;
  p.statusEffects   = [];
  p.tempBonuses     = {};
  p.priestBuff      = 0;
  p.transmutation   = null;
  p.isSmokeActive   = false;
  p.isAlive         = true;
}

// Apply an upgrade candidate directly onto a player object (destructive)
function applyUpgrade(player, candidate) {
  if (candidate.type === 'regular') {
    const item = getItem(candidate.itemId);
    if (item) player.equipped[candidate.slot] = { ...item };
  } else if (candidate.type === 'guild') {
    const item = getItem(candidate.itemId);
    if (item) {
      player.equipped[candidate.slot] = { ...item };
      player.guildItemLevels[candidate.itemId] = {
        itemLevel: candidate.guildLevel,
        levelProgress: { mbUnits: 0, secondaryUnits: 0 },
      };
    }
  } else if (candidate.type === 'enchant') {
    const eq = player.equipped[candidate.slot];
    if (eq) {
      const enchObj = ENCHANTMENTS.find(e => e.id === candidate.enchantId);
      if (enchObj) eq.enchantment = { ...enchObj };
    }
  }
}

// ── Upgrade candidate enumeration ─────────────────────────────────────────────

function enumerateCandidates(player) {
  const candidates = [];

  // ── Regular equipment ────────────────────────────────────────────────────────
  for (const item of EQUIPMENT) {
    const slot    = item.slot;
    const eq      = player.equipped[slot];
    // Only consider items strictly better than what's equipped (by tier)
    const curTier = eq ? (eq.tier ?? 0) : 0;
    if (item.tier <= curTier) continue;
    // Skip guild items from this list (they're in SPECIAL_EQUIPMENT)
    candidates.push({
      type: 'regular', itemId: item.id, slot,
      cost: item.buyPrice ?? 0,
      hasSpecialEffect: false,
    });
  }

  // ── Guild / special equipment ─────────────────────────────────────────────────
  for (const item of SPECIAL_EQUIPMENT) {
    const slot = item.slot;
    // Don't offer if a guild item is already equipped in this slot
    const eq = player.equipped[slot];
    if (eq?.guild) continue;

    for (const level of GUILD_TRAIN_LEVELS(item.id)) {
      candidates.push({
        type: 'guild', itemId: item.id, slot,
        guildLevel:  level,
        guildMaxLvl: GUILD_MAX_LEVEL(item.id),
        cost: item.buyPrice ?? 0,
        hasSpecialEffect: true, // all guild items have a special effect beyond stats
      });
    }
  }

  // ── Enchantments ──────────────────────────────────────────────────────────────
  for (const [slot, enchIds] of Object.entries(ENCHANT_FOR_SLOT)) {
    const eq = player.equipped[slot];
    if (!eq || eq.enchantment) continue; // no item equipped, or already enchanted
    for (const enchId of enchIds) {
      const enchObj = ENCHANTMENTS.find(e => e.id === enchId);
      if (!enchObj) continue;
      // Fury and Hawk Eye have cost = tier * 50; approximate as tier * 50 where tier comes from item
      const tier = eq.tier ?? 1;
      const cost = enchObj.cost ?? (tier * 50);
      candidates.push({
        type: 'enchant', slot, enchantId: enchId,
        cost,
        hasSpecialEffect: MODIFIER_ENCHANTS.has(enchId),
      });
    }
  }

  return candidates;
}

// ── Fight simulation ──────────────────────────────────────────────────────────

const DEF_FOR = { F:'A', D:'V', M:'M', C:'C' };

function greedyAction(player, mob) {
  if (player.hearts.current <= 1 && player.canEscape()) return { type: 'bail' };
  if (player.hearts.current <= 1 && player.chainedTurns === 0) return { type: 'run' };

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

function simulateFight(player, snap, mob) {
  restorePlayer(player, snap);
  const freshMob = MOBS.spawn(mob.id);
  const log      = [];
  const initHp   = player.hearts.current;

  const init = Combat.initFight(player, freshMob);
  if (init.outcome === 'victory') return { won: true, heartsLost: 0 };

  if (!init.playerFirst) {
    const r = Combat.takeMobAttack(player, freshMob, log, Combat.rollMobAttack(freshMob));
    if (r.outcome === 'defeat')  return { won: false, heartsLost: initHp };
    if (r.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
  }

  for (let step = 0; step < 80; step++) {
    const pr = Combat.takePlayerAttack(player, freshMob, greedyAction(player, freshMob), log);
    if (pr.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
    if (pr.outcome === 'defeat')  return { won: false, heartsLost: initHp };
    if (pr.outcome === 'escaped') return { won: false, heartsLost: initHp - player.hearts.current };

    const mr = Combat.takeMobAttack(player, freshMob, log, Combat.rollMobAttack(freshMob));
    if (mr.outcome === 'victory') return { won: true,  heartsLost: initHp - player.hearts.current };
    if (mr.outcome === 'defeat')  return { won: false, heartsLost: initHp };
  }
  return { won: false, heartsLost: initHp };
}

// Compute zone viability score: weighted win-rate sum across all tiers
function zoneScore(player, snap, nSims) {
  const tierMobs = TIERS.map(t => MOBS.getByTier(t));
  let score = 0;
  for (let ti = 0; ti < TIERS.length; ti++) {
    const pool = tierMobs[ti];
    let wins = 0;
    for (let s = 0; s < nSims; s++) {
      const mob = pool[Math.floor(Math.random() * pool.length)];
      if (simulateFight(player, snap, mob).won) wins++;
    }
    score += TIER_WEIGHTS[ti] * (wins / nSims);
  }
  return score;
}

// ── Training player factory ───────────────────────────────────────────────────

const SLOT_ITEMS_BY_SLOT = {};
for (const item of EQUIPMENT) {
  if (!SLOT_ITEMS_BY_SLOT[item.slot]) SLOT_ITEMS_BY_SLOT[item.slot] = [];
  SLOT_ITEMS_BY_SLOT[item.slot].push(item);
}

const MODIFIER_ENCHANTS_LIST = ENCHANTMENTS.filter(e => MODIFIER_ENCHANTS.has(e.id));
const STAT_ENCHANTS_LIST     = ENCHANTMENTS.filter(e => !MODIFIER_ENCHANTS.has(e.id));
const ATTACK_SPELLS = ['bang','fireball','flare','blaze','blizzard','freeze',
                       'discharge','lightning','bolt','explosion','bomb'];

function makeTrainingPlayer(progression) {
  const p = new Player({ id: 'adv', name: 'Adv', isBot: true });

  // Base stats: same range as estimator
  const lo = 1 + Math.floor(progression / 2);
  const hi = 3 + progression * 2;
  for (const s of STATS) p.baseStats[s] = lo + Math.floor(Math.random() * (hi - lo + 1));

  // Hearts
  const maxHp = 3 + progression + Math.floor(Math.random() * 2);
  p.hearts = { current: 1 + Math.floor(Math.random() * maxHp), max: maxHp };

  // Equipment: up to 5 slots, tier-appropriate
  const shuffledSlots = [...ALL_SLOTS].sort(() => Math.random() - 0.5);
  const nSlots        = Math.floor(Math.random() * 6);
  const itemTierCap   = Math.min(Math.ceil(progression * 6 / 5), 6);

  for (let k = 0; k < Math.min(nSlots, 5); k++) {
    const slot = shuffledSlots[k];
    const pool = (SLOT_ITEMS_BY_SLOT[slot] ?? []).filter(i => i.tier <= itemTierCap);
    if (!pool.length) continue;

    // pick a random tier up to cap, bias toward higher tiers with progression
    const item     = pool[Math.floor(Math.random() * pool.length)];
    const itemCopy = { ...item };

    // Enchantment chance scales with progression
    if (Math.random() < progression * 0.1) {
      const ePool = ENCHANT_FOR_SLOT[slot];
      if (ePool?.length) {
        const enchId  = ePool[Math.floor(Math.random() * ePool.length)];
        const enchObj = ENCHANTMENTS.find(e => e.id === enchId);
        if (enchObj) itemCopy.enchantment = { ...enchObj };
      }
    }

    p.equipped[slot] = itemCopy;
  }

  // Guild items at higher progressions
  if (progression >= 2 && Math.random() < 0.2) {
    const gItem = SPECIAL_EQUIPMENT[Math.floor(Math.random() * SPECIAL_EQUIPMENT.length)];
    const level = 1 + Math.floor(Math.random() * (GUILD_MAX_LEVEL(gItem.id)));
    p.equipped[gItem.slot] = { ...gItem };
    p.guildItemLevels[gItem.id] = { itemLevel: level, levelProgress: { mbUnits: 0, secondaryUnits: 0 } };
  }

  // Inventory
  const nPots = Math.floor(Math.random() * (progression * 2 + 2));
  for (let j = 0; j < nPots; j++) {
    const s   = STATS[Math.floor(Math.random() * STATS.length)];
    const val = 1 + Math.floor(Math.random() * Math.min(progression + 1, 3));
    p.inventory.push(`pot_${s}${val}`);
  }
  if (progression >= 1 && Math.random() < 0.3) p.inventory.push('rope');
  if (progression >= 2 && Math.random() < 0.2) p.inventory.push('sp_invisibility');
  if (progression >= 2 && Math.random() < 0.25) p.inventory.push('sp_smoke');
  if (progression >= 1 && Math.random() < 0.2) {
    p.inventory.push(ATTACK_SPELLS[Math.floor(Math.random() * ATTACK_SPELLS.length)]);
  }

  return p;
}

// ── Dataset generation ────────────────────────────────────────────────────────

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateDataset() {
  const dataset = [];
  const totalConfigs = N_CONFIGS * PROGRESSIONS.length;
  let done = 0;
  const t0 = Date.now();

  for (const prog of PROGRESSIONS) {
    for (let c = 0; c < N_CONFIGS; c++) {
      const player   = makeTrainingPlayer(prog);
      const baseSnap = snapshotPlayer(player);

      // Baseline zone score (shared across all upgrade candidates for this player)
      const baseScore = zoneScore(player, baseSnap, N_SIMS_BASELINE);

      // Enumerate and optionally subsample candidates
      let candidates = enumerateCandidates(player);
      shuffle(candidates);
      if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES);

      // Score each candidate across all 4 tiers (player feature vec reused for all tiers)
      // We generate one record per (candidate, tier) so the model sees tier as part of input.
      // But gain is computed across all tiers at once — so one record per candidate (tier embedded
      // inside the player features as a 4-element loop, with gain averaged across the combination).
      // Simpler: emit one record per candidate with tier=0 player features and gain = overall delta.
      for (const candidate of candidates) {
        // Clone player, apply upgrade
        const upgPlayer = makeTrainingPlayer(prog); // fresh player, same progression
        Object.assign(upgPlayer.baseStats, player.baseStats);
        upgPlayer.hearts          = { ...player.hearts };
        upgPlayer.equipped        = Object.fromEntries(ALL_SLOTS.map(s => [s, player.equipped[s] ? { ...player.equipped[s] } : null]));
        upgPlayer.inventory       = [...player.inventory];
        upgPlayer.guildItemLevels = JSON.parse(JSON.stringify(player.guildItemLevels));
        applyUpgrade(upgPlayer, candidate);

        const upgSnap = snapshotPlayer(upgPlayer);
        const upgScore = zoneScore(upgPlayer, upgSnap, N_SIMS_UPGRADE);
        const gain     = upgScore - baseScore;

        // Player features at tier 0 + upgrade features — tier context is captured
        // in the per-tier win rates that make up baseScore and upgScore.
        // Use a fixed tier=0 anchor for the player feature vec; the gain already encodes
        // the full multi-tier effect.
        const pFeats  = playerFeatureVec(player, 0);
        const uFeats  = upgradeFeatureVec(player, candidate);
        const features = [...pFeats, ...uFeats];  // 42 features

        dataset.push({
          features,
          gain,
          meta: {
            prog,
            type:       candidate.type,
            itemId:     candidate.itemId ?? null,
            slot:       candidate.slot,
            enchantId:  candidate.enchantId ?? null,
            guildLevel: candidate.guildLevel ?? null,
            cost:       candidate.cost,
          },
        });
      }

      done++;
      if (done % 50 === 0) {
        const elapsed = (Date.now() - t0) / 1000;
        const eta     = Math.round((totalConfigs - done) / done * elapsed);
        process.stdout.write(`\r  ${done}/${totalConfigs} configs  ${elapsed.toFixed(0)}s elapsed  ETA ${eta}s   `);
      }
    }
  }

  console.log(`\nGenerated ${dataset.length} records.`);
  return dataset;
}

// ── Training ──────────────────────────────────────────────────────────────────

const PLAYER_DIM  = 24;
const UPGRADE_DIM = 18;
const INPUT_DIM   = PLAYER_DIM + UPGRADE_DIM;

function train(dataset) {
  const sizes = [INPUT_DIM, ...HIDDEN, 1];
  const nn    = new TinyNN(sizes);

  console.log(`Training NN ${sizes.join('→')} for ${EPOCHS} epochs on ${dataset.length} records…`);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    shuffle(dataset);
    let loss = 0;
    for (const { features, gain } of dataset) {
      const out  = nn.forward(features);
      loss += (out[0] - gain) ** 2;
      nn.supervisedUpdate([gain], LR);
    }
    if ((epoch + 1) % 20 === 0) {
      console.log(`  epoch ${String(epoch + 1).padStart(3)}  loss ${(loss / dataset.length).toFixed(5)}`);
    }
  }
  return nn;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

function evaluate(nn, dataset) {
  console.log('\nEvaluation by upgrade type (MAE on full dataset):');
  const byType = {};
  for (const rec of dataset) {
    const t = rec.meta.type;
    if (!byType[t]) byType[t] = [];
    byType[t].push(rec);
  }
  for (const [type, recs] of Object.entries(byType)) {
    let mae = 0;
    let gainMean = 0;
    for (const { features, gain } of recs) {
      const pred = nn.forward(features)[0];
      mae += Math.abs(pred - gain);
      gainMean += gain;
    }
    mae      /= recs.length;
    gainMean /= recs.length;
    console.log(`  ${type.padEnd(8)}: n=${String(recs.length).padStart(5)}  mean_gain=${gainMean.toFixed(4)}  MAE=${mae.toFixed(4)}`);
  }

  // Direction accuracy: does model correctly rank a good upgrade above a bad one?
  let correct = 0, total = 0;
  // Group by player (same features prefix = same player), check ranking
  const sample = dataset.slice(0, Math.min(1000, dataset.length));
  for (let i = 0; i < sample.length - 1; i += 2) {
    const a = sample[i], b = sample[i + 1];
    const pA = nn.forward(a.features)[0];
    const pB = nn.forward(b.features)[0];
    if ((a.gain > b.gain) === (pA > pB)) correct++;
    total++;
  }
  console.log(`\n  Pairwise ranking accuracy: ${(correct / total * 100).toFixed(1)}%  (n=${total} pairs)`);
}

// ── Export ────────────────────────────────────────────────────────────────────

const WEIGHTS_PATH = path.join(ROOT, 'js', 'data', 'weights', 'upgrade_advisor_weights.js');

function saveWeights(nn) {
  const js = `// Auto-generated by train/train_upgrade_advisor.js — do not edit by hand\n`
           + `const UPGRADE_ADVISOR_WEIGHTS = ${JSON.stringify(nn.serialize())};\n`;
  fs.writeFileSync(WEIGHTS_PATH, js);
  const kb = (fs.statSync(WEIGHTS_PATH).size / 1024).toFixed(1);
  console.log(`\nWeights → ${WEIGHTS_PATH}  (${kb} KB)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const dataset = generateDataset();
const nn      = train(dataset);
evaluate(nn, dataset);
saveWeights(nn);
console.log('Done.');
