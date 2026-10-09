#!/usr/bin/env node
'use strict';

/**
 * sim_dragon.js
 *
 * Enchantment comparison simulator — boss-killer builds vs the Dragon.
 * Tests all combinations of enchants across weapon / armor / shield for each
 * archetype (F / D / M) and ranks them by win rate.
 *
 * The simulation uses CombatNN for attack decisions, plus an emergency heal
 * override (HP ≤ 40% → use pot_heal if held) so the boss-killer consumable
 * stack is actually utilised for F/D builds where the NN threshold isn't met.
 *
 * Usage:
 *   node sim_dragon.js [N_FIGHTS_PER_BUILD]    default: 150
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

// ── Build generation — enchant matrix per archetype ───────────────────────────
//
// Each archetype has fixed stats / gear / consumables.
// We iterate all combos of: weapon_enchant × armor_enchant × shield_enchant.
// Abbreviation keys in the output table:
//   Weapon: sharp=sharpness  fury=fury  flame=flame  prec=precision  hawk=hawk_eye  blood=bloodlust  arcane=arcane
//   Armor:  light=lightness  res=resistance
//   Shield: arcane / thorns / res=resistance

const ENCHANT_SHORT = {
  sharpness: 'sharp', fury: 'fury', flame: 'flame',
  precision: 'prec',  hawk_eye: 'hawk', bloodlust: 'blood',
  arcane: 'arcane',  thorns: 'thorns', resistance: 'res', lightness: 'light',
};
function short(id) { return ENCHANT_SHORT[id] ?? id; }

// Base consumable stacks (same for all archetypes so enchants are the variable)
const HEAL_STACK  = ['pot_heal','pot_heal','pot_heal','pot_heal','pot_heal'];
const SMOKE_STACK = ['sp_smoke','sp_smoke','sp_smoke'];

function genBuilds() {
  const builds = [];

  // Enchant choices per slot
  const WEAPON_F  = ['sharpness', 'fury',      'flame'];
  const WEAPON_D  = ['precision', 'hawk_eye',  'flame'];
  const WEAPON_M  = ['flame',     'arcane',    'bloodlust'];
  const ARMOR_ALL = ['lightness', 'resistance'];
  const SHIELD_ALL= ['arcane',    'thorns',    'resistance'];

  // ── F-fighter ──────────────────────────────────────────────────────────────
  // Stats: F:6 D:3 A:6 M:2 C:4 V:5 | Gear: halberd / hv_armor / lg_shield
  // No blood/priest — effective F = 6+6(halberd)+enchant = 12-15
  // Dragon defends at 17+d6 → hit rate at F:15 ≈ 28%, at F:12 ≈ 3%
  for (const we of WEAPON_F) {
    for (const ae of ARMOR_ALL) {
      for (const se of SHIELD_ALL) {
        builds.push({
          archetype: 'F',
          name: `F  ${short(we).padEnd(6)} / ${short(ae).padEnd(5)} / ${short(se)}`,
          stats: { F:6, D:3, A:6, M:2, C:4, V:5 },
          hp: 8,
          equip: [
            { id:'halberd',  enchId:we },
            { id:'hv_armor', enchId:ae },
            { id:'lg_shield',enchId:se },
            { id:'pegasus' },
            { id:'accordion' },
          ],
          inv: [
            ...HEAL_STACK, ...SMOKE_STACK,
            'pot_F3','pot_F3','pot_F3',
            'pot_A3','pot_A3','pot_A3',
          ],
        });
      }
    }
  }

  // ── D-ranger ───────────────────────────────────────────────────────────────
  // Stats: F:3 D:6 A:6 M:2 C:4 V:6 | Gear: arquebus / hv_armor / lg_shield
  // No blood/priest — effective D = 6+6(arquebus)+enchant = 12-15
  for (const we of WEAPON_D) {
    for (const ae of ARMOR_ALL) {
      for (const se of SHIELD_ALL) {
        builds.push({
          archetype: 'D',
          name: `D  ${short(we).padEnd(6)} / ${short(ae).padEnd(5)} / ${short(se)}`,
          stats: { F:3, D:6, A:6, M:2, C:4, V:6 },
          hp: 8,
          equip: [
            { id:'arquebus', enchId:we },
            { id:'hv_armor', enchId:ae },
            { id:'lg_shield',enchId:se },
            { id:'pegasus' },
            { id:'accordion' },
          ],
          inv: [
            ...HEAL_STACK, ...SMOKE_STACK,
            'pot_D3','pot_D3','pot_D3',
            'pot_A3','pot_A3','pot_A3',
          ],
        });
      }
    }
  }

  // ── M-mage ─────────────────────────────────────────────────────────────────
  // Stats: F:2 D:2 A:6 M:6 C:4 V:5 | Gear: grimoire / hv_armor / lg_shield
  // No blood/priest — effective M = 6+6(grimoire)+enchant = 12-15
  for (const we of WEAPON_M) {
    for (const ae of ARMOR_ALL) {
      for (const se of SHIELD_ALL) {
        builds.push({
          archetype: 'M',
          name: `M  ${short(we).padEnd(6)} / ${short(ae).padEnd(5)} / ${short(se)}`,
          stats: { F:2, D:2, A:6, M:6, C:4, V:5 },
          hp: 8,
          equip: [
            { id:'grimoire', enchId:we },
            { id:'hv_armor', enchId:ae },
            { id:'lg_shield',enchId:se },
            { id:'pegasus' },
            { id:'accordion' },
          ],
          inv: [
            ...HEAL_STACK, ...SMOKE_STACK,
            'pot_M3','pot_M3','pot_M3',
            'pot_A3','pot_A3','pot_A3',
            'blaze','blaze','blaze','blaze','blaze',
            'blaze','blaze','blaze','blaze','blaze',
            'rend','rend','rend','rend','rend',
          ],
        });
      }
    }
  }

  return builds;
}

const BUILDS = genBuilds();

// ── Player factory ─────────────────────────────────────────────────────────────

function buildPlayer(b) {
  const p        = new Player({ id: 'sim', name: 'SimBot', isBot: true });
  p.baseStats    = { ...b.stats };
  p.hearts       = { current: b.hp, max: b.hp };

  for (const eSpec of (b.equip ?? [])) {
    const tmpl = ITEM_REGISTRY[eSpec.id];
    if (!tmpl) { process.stderr.write(`[warn] unknown item: ${eSpec.id}\n`); continue; }
    const item = JSON.parse(JSON.stringify(tmpl));
    p.inventory.push(item.id);
    if (!p.equip(item)) { process.stderr.write(`[warn] could not equip ${eSpec.id}\n`); continue; }
    if (eSpec.enchId) {
      const enchObj = ENCHANTMENTS.find(e => e.id === eSpec.enchId);
      if (enchObj) p.applyEnchantment(item.slot, enchObj, 1);
      else process.stderr.write(`[warn] unknown enchantment: ${eSpec.enchId}\n`);
    }
  }

  for (const id of (b.inv ?? [])) p.inventory.push(id);

  if (b.bloodBonus) {
    for (const [stat, val] of Object.entries(b.bloodBonus))
      p.baseStats[stat] = (p.baseStats[stat] ?? 0) + val;
  }
  if (b.priestBuff > 0) p.priestBuff = b.priestBuff;

  return p;
}

// ── Greedy fallback attack ─────────────────────────────────────────────────────

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

// ── Choose action (NN + emergency heal override) ───────────────────────────────
//
// The NN doesn't recommend heals for high-stat F/D builds because attack always
// has higher predicted advantage (training distribution mismatch).  An emergency
// override ensures the consumable stack is used when HP is critically low.

const HEAL_THRESHOLD = 0.40;   // heal if HP ≤ 40% of max

function choosePlayerAction(player, mob, preAtk) {
  // Emergency heal: use pot_heal before any NN decision
  const hpFrac = player.hearts.current / player.hearts.max;
  if (hpFrac <= HEAL_THRESHOLD && player.inventory.includes('pot_heal')) {
    return { type: '__heal__' };
  }
  // Emergency smoke: use smoke at 1 HP if available
  if (player.hearts.current <= 1 && player.inventory.includes('sp_smoke')) {
    return { type: '__smoke__' };
  }
  // NN (handles pots, blood, priest, attack selection, bail guard)
  const action = CombatNN.chooseAction(player, mob, preAtk);
  if (action?.type === 'bail' || action?.type === 'run') {
    return bestAttackAction(player, mob);
  }
  return action;
}

// ── Single fight ──────────────────────────────────────────────────────────────

const MAX_ROUNDS = 120;

function simulateDragonFight(build, captureLog = false) {
  const player       = buildPlayer(build);
  const mob          = MOBS.spawn('dragon');
  const log          = [];
  const roundLog     = [];
  const consumables  = {};

  const init = Combat.initFight(player, mob);
  log.push(...(init.log ?? []));
  if (init.outcome === 'victory') return { outcome:'win',  halfTurns:0, consumablesUsed:{}, roundLog };
  if (init.outcome === 'defeat')  return { outcome:'loss', halfTurns:0, consumablesUsed:{}, roundLog };

  let playerTurn = init.playerFirst;

  for (let ht = 0; ht < MAX_ROUNDS * 2; ht++) {
    const prevLen   = log.length;
    const hpBefore  = player.hearts.current;
    const mhpBefore = mob.hearts.current;
    let result;

    if (playerTurn) {
      const invSnap = [...player.inventory];
      const preAtk  = Combat.rollMobAttack(mob);
      const action  = choosePlayerAction(player, mob, preAtk);

      // Handle internal heal/smoke actions (not passed to takePlayerAttack)
      if (action.type === '__heal__') {
        player.removeItem('pot_heal');
        player.healHeart(1);
        consumables['pot_heal'] = (consumables['pot_heal'] ?? 0) + 1;
        const atkAction = bestAttackAction(player, mob);
        result = Combat.takePlayerAttack(player, mob, atkAction, log);
        if (captureLog) {
          const newLog = log.slice(prevLen).map(l => typeof l === 'string' ? l : (l.text ?? ''));
          roundLog.push({ turn:`P${Math.ceil((ht+1)/2)}a`, side:'player', action:atkAction,
            php:`${hpBefore}→${player.hearts.current}/${player.hearts.max}`,
            mhp:`${mhpBefore}→${mob.hearts.current}/${mob.hearts.max}`,
            note: 'healed first', log:newLog });
        }
      } else if (action.type === '__smoke__') {
        player.removeItem('sp_smoke');
        player.isSmokeActive = true;
        consumables['sp_smoke'] = (consumables['sp_smoke'] ?? 0) + 1;
        const atkAction = bestAttackAction(player, mob);
        result = Combat.takePlayerAttack(player, mob, atkAction, log);
        if (captureLog) {
          const newLog = log.slice(prevLen).map(l => typeof l === 'string' ? l : (l.text ?? ''));
          roundLog.push({ turn:`P${Math.ceil((ht+1)/2)}a`, side:'player', action:atkAction,
            php:`${hpBefore}→${player.hearts.current}/${player.hearts.max}`,
            mhp:`${mhpBefore}→${mob.hearts.current}/${mob.hearts.max}`,
            note: 'smoke first', log:newLog });
        }
      } else {
        result = Combat.takePlayerAttack(player, mob, action, log);
        // Track consumables that disappeared
        const gone = invSnap.filter(id => {
          const before = invSnap.filter(x => x === id).length;
          const after  = player.inventory.filter(x => x === id).length;
          return after < before;
        });
        for (const id of gone) consumables[id] = (consumables[id] ?? 0) + 1;
        if (captureLog) {
          const newLog = log.slice(prevLen).map(l => typeof l === 'string' ? l : (l.text ?? ''));
          roundLog.push({ turn:`P${Math.ceil((ht+1)/2)}a`, side:'player', action,
            php:`${hpBefore}→${player.hearts.current}/${player.hearts.max}`,
            mhp:`${mhpBefore}→${mob.hearts.current}/${mob.hearts.max}`,
            log:newLog });
        }
      }
    } else {
      const preAtk = Combat.rollMobAttack(mob);
      result = Combat.takeMobAttack(player, mob, log, preAtk);
      if (captureLog) {
        const newLog = log.slice(prevLen).map(l => typeof l === 'string' ? l : (l.text ?? ''));
        roundLog.push({ turn:`P${Math.ceil((ht+1)/2)}b`, side:'mob',
          php:`${hpBefore}→${player.hearts.current}/${player.hearts.max}`,
          mhp:`${mhpBefore}→${mob.hearts.current}/${mob.hearts.max}`,
          log:newLog });
      }
    }

    if (result.outcome === 'victory' || result.outcome === 'defeat' || result.outcome === 'escaped') {
      return {
        outcome: result.outcome === 'victory' ? 'win' : result.outcome,
        halfTurns: ht + 1,
        consumablesUsed: consumables,
        roundLog,
      };
    }

    if (result.outcome === 'charisma_pending') {
      Combat.applyCharismaOutcome(
        player, mob, { family:'mock', tier:2, stat:'F' }, result.charismaResult, log
      );
    }

    playerTurn = !playerTurn;
  }

  return { outcome:'timeout', halfTurns: MAX_ROUNDS * 2, consumablesUsed: consumables, roundLog };
}

// ── Run N fights per build ────────────────────────────────────────────────────

function runBuild(build, N) {
  const stats = { win:0, loss:0, escaped:0, timeout:0, halfTurns:[], consumables:{} };
  let sampleFight = null;
  let longestHT   = -1;

  for (let i = 0; i < N; i++) {
    const capture = (sampleFight === null);
    const result  = simulateDragonFight(build, capture);

    stats[result.outcome] = (stats[result.outcome] ?? 0) + 1;
    if (result.outcome === 'win') stats.halfTurns.push(result.halfTurns);

    for (const [id, n] of Object.entries(result.consumablesUsed))
      stats.consumables[id] = (stats.consumables[id] ?? 0) + n;

    if (capture) {
      if (result.outcome === 'win') {
        sampleFight = result;
      } else if (result.halfTurns > longestHT) {
        longestHT   = result.halfTurns;
        sampleFight = result;
      }
    }
  }

  const avgRnd = stats.halfTurns.length
    ? (stats.halfTurns.reduce((a,b) => a+b, 0) / stats.halfTurns.length / 2).toFixed(1)
    : '—';
  const consAvg = Object.fromEntries(
    Object.entries(stats.consumables)
      .sort((a,b) => b[1]-a[1])
      .map(([id, total]) => [id, +(total / N).toFixed(2)])
  );

  return { stats, avgRnd, consAvg, sampleFight };
}

// ── Output helpers ─────────────────────────────────────────────────────────────

function fmtAction(a) {
  if (!a) return '?';
  if (a.type === 'attack') return `atk(${a.attackType}${a.spellId ? '+'+a.spellId : ''})`;
  if (a.type === 'bard')   return 'bard(C)';
  return a.type;
}

function printRoundLog(roundLog, sampleOutcome) {
  if (!roundLog?.length) { console.log('  (no log captured)'); return; }
  console.log(`  Outcome: ${sampleOutcome.toUpperCase()}`);
  console.log('');
  for (const entry of roundLog) {
    const side  = entry.side === 'player' ? '  ▶ Player' : '  ◀ Dragon';
    const act   = entry.side === 'player' ? `  action=${fmtAction(entry.action)}${entry.note ? ' ['+entry.note+']' : ''}` : '';
    const hp    = `  PHP:${entry.php}  DHP:${entry.mhp}`;
    const logTx = entry.log.filter(Boolean).map(l => `      ${l}`).join('\n');
    console.log(`${side} [${entry.turn}]${act}${hp}`);
    if (logTx) console.log(logTx);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

const N = parseInt(process.argv[2] ?? '150', 10);
const SHOW_SAMPLE = process.argv.includes('--log');   // pass --log to print fight log

console.log(`\n${'═'.repeat(70)}`);
console.log(`  Dragon Enchant Comparison — ${N} fights/build — NO blood/priest`);
console.log(`  Base stats: F:6 D:6 M:6 A:6 C:6 V:6 | 5 slots equipped (weapon/armor/shield/pegasus/accordion)`);
console.log(`  Dragon: all stats 20, 12HP — defends at 17+d6`);
console.log(`${'═'.repeat(70)}\n`);

// Group results by archetype
const archetypeResults = {};

for (const build of BUILDS) {
  process.stdout.write(`  ${build.name}  ...`);
  const res = runBuild(build, N);
  const winPct = parseFloat(((res.stats.win / N) * 100).toFixed(1));
  process.stdout.write(`\r  ${build.name}  ${String(winPct+'%').padStart(6)}\n`);

  if (!archetypeResults[build.archetype]) archetypeResults[build.archetype] = [];
  archetypeResults[build.archetype].push({
    name:    build.name,
    winPct,
    avgRnd:  res.avgRnd,
    consAvg: res.consAvg,
    sample:  res.sampleFight,
    build,
  });
}

// ── Per-archetype summary tables ───────────────────────────────────────────────

for (const arch of ['F', 'D', 'M']) {
  const rows = archetypeResults[arch];
  if (!rows) continue;

  rows.sort((a, b) => b.winPct - a.winPct);
  const topResult = rows[0];

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Archetype ${arch}  — sorted by win%`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  ${'Build'.padEnd(36)} ${'Win%'.padStart(6)}  ${'AvgRnd'.padStart(6)}  Consumables/fight`);
  console.log(`  ${'-'.repeat(36)} ${'------'} ${'------'}  -----------------`);

  for (const row of rows) {
    const bar  = '█'.repeat(Math.round(row.winPct / 5));
    const cStr = Object.entries(row.consAvg)
      .filter(([,v]) => v >= 0.05)
      .map(([id,v]) => `${id}:${v}`)
      .join(' ');
    console.log(
      `  ${row.name.padEnd(36)} ${String(row.winPct+'%').padStart(6)}`
      + `  ${String(row.avgRnd).padStart(6)}  ${cStr}`
    );
  }

  if (SHOW_SAMPLE && topResult.sample) {
    console.log('');
    console.log(`  Top build sample fight: ${topResult.name}`);
    printRoundLog(topResult.sample.roundLog, topResult.sample.outcome ?? '?');
  }
}

// ── Overall top-10 ─────────────────────────────────────────────────────────────

const allResults = Object.values(archetypeResults).flat().sort((a,b) => b.winPct - a.winPct);
const top10 = allResults.slice(0, 10);

console.log(`\n${'═'.repeat(70)}`);
console.log('  TOP 10 across all archetypes');
console.log(`${'═'.repeat(70)}`);
const W = Math.max(...top10.map(r => r.name.length)) + 2;
for (const row of top10) {
  const bar = '█'.repeat(Math.round(row.winPct / 5));
  console.log(`  ${row.name.padEnd(W)} ${String(row.winPct+'%').padStart(7)}  ${bar}`);
}
console.log(`${'═'.repeat(70)}\n`);

// Show sample fight for the overall winner if --log flag set
if (SHOW_SAMPLE && allResults[0]?.sample) {
  console.log(`Best build overall: ${allResults[0].name}`);
  printRoundLog(allResults[0].sample.roundLog, allResults[0].sample.outcome ?? '?');
}
