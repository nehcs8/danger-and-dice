#!/usr/bin/env node
// Strategy search: evolve bot genomes { base, tune } (see DEFAULT_TUNE in bot_v2.js) on a solo
// race — own turns until the dragon dies. The dragon killer wins ~96% of 4-player games, so this
// is a cheap proxy for strength. Death or timeout scores CAP.
//
// Candidates are compared on the same seeds (common random numbers) and filtered by successive
// halving each generation; results are cached per (genome, seed), so elites keep their samples.
//
// Usage:
//   node strategy_search.js [--gens 8] [--pop 40] [--workers 8] [--out results/search]
//   node strategy_search.js --eval '<genome json>' [--seeds 100]      → score one genome on fresh seeds
'use strict';
const fs = require('fs'), path = require('path'), { fork } = require('child_process');
const { makeSandbox, get } = require('./lib_sb.js');

const CAP = 250;
const BASES = ['F','D','FB','DB','DG','DBG','M','G','GB','BP','DT','SS','BB','BM','CH','CR'];
const SPACE = {
  shield: [true, false], shieldRes: [true, false], armorEnch: [true, false],
  pegasus: [true, false], accordion: [true, false], cloak: [true, false], rope: [true, false],
  speedEarly: [null, true, false],
  skills: [0, 1, 2, 3, 4, 5],
  skillOrder: ['main,A,V', 'main,V,A', 'A,main,V', 'main,A', 'main', 'V,main,A'],
  skillsEarly: [false, true],
  farmWin: [0.85, 0.9, 0.93, 0.95, 0.97, 0.99],
  farmHearts: [0.8, 1.0, 1.3, 1.6, 2.0, 2.5],
  healMissing: [1, 2, 3],
  dragonGo: [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9],
  kitMargin: [0, 0.05, 0.1],
  stockpileCoins: [100, 150, 250, 400, 600],
  curseCap: [10, 16, 24, 30],
};
// Today's hand-written behaviour (DEFAULT_TUNE) expressed in the search space
const DEFAULTS = { shield:true, shieldRes:true, armorEnch:true, pegasus:true, accordion:true, cloak:true, rope:true,
  speedEarly:null, skills:5, skillOrder:'main,A,V', skillsEarly:false, farmWin:0.97, farmHearts:1.3, healMissing:2,
  dragonGo:0.85, kitMargin:0.05, stockpileCoins:250, curseCap:24 };

// genome → the object the bot reads
// Only parameters that differ from the defaults are sent, so profile-specific defaults
// (e.g. CH raising C first) are kept unless the genome changes them.
function toBot(g) {
  const full = { ...DEFAULTS, ...(g.tune ?? {}) };
  const tune = { pvpKit: false };
  for (const [k, v] of Object.entries(full)) if (k !== 'kitMargin' && v !== DEFAULTS[k]) tune[k] = v;
  if (full.dragonGo !== DEFAULTS.dragonGo || full.kitMargin !== DEFAULTS.kitMargin) tune.kitTarget = Math.min(0.97, full.dragonGo + full.kitMargin);
  return { base: g.base, tune };
}
const keyOf = g => g.base + '|' + Object.keys(SPACE).map(k => String(g.tune[k])).join(',');
function describe(g) {
  const diff = Object.keys(SPACE).filter(k => g.tune[k] !== DEFAULTS[k]).map(k => `${k}=${g.tune[k]}`);
  return `${g.base}${diff.length ? ' {' + diff.join(', ') + '}' : ' (default tune)'}`;
}

// ── one solo game, stopped at the dragon kill ──────────────────────────────
// inspect(Game, BotAI, player): optional hook run at the end, for debugging probes
function runSolo(genome, seed, inspect = null, onLog = null) {
  const sb = makeSandbox('js/engine/bot_v2.js', [], seed);
  const Game = get(sb, 'Game'), BotAI = get(sb, 'BotAI'), KB = get(sb, 'KingBattle'), Ph = Game.Phase;
  const queue = [];
  let turns = 0, done = null;
  const cur = () => Game.getCurrentPlayer();
  const kick = () => { const p = cur(); if (p?.isBot) queue.push(() => BotAI.takeTurn(p)); };
  const inShop = () => { const ph = Game.getState().phase; return ph === Ph.SHOP || ph === Ph.MASTER; };
  Game.on('state_change', d => {
    if (done) return;
    const st = Game.getState();
    if (d.phase === Ph.SETUP_ROLL) { queue.push(() => Game.submitAction({ type:'setup_roll' })); return; }
    if (d.phase === Ph.GAME_OVER) { done = done ?? 'over'; return; }
    if (d.phase === Ph.KING_BATTLE) { queue.push(() => KB.resolveWin()); return; }
    if (d.phase === Ph.LOOT_CONFIRM) { queue.push(() => Game.submitAction({ type:'loot_confirm' })); return; }
    if (d.phase === Ph.ROLL_MOVE) turns++;
    kick();
  });
  Game.on('combat_update', d => { if (!done && (d.outcome === 'ongoing' || d.outcome === 'charisma_pending')) kick(); });
  Game.on('shop_transaction', () => { if (!done && inShop()) kick(); });
  Game.on('item_equipped',    () => { if (!done && inShop()) kick(); });
  Game.on('item_unequipped',  () => { if (!done && inShop()) kick(); });
  Game.on('skill_upgraded',   () => { if (!done) kick(); });
  Game.on('enchanted',        () => { if (!done) kick(); });
  if (onLog) {
    Game.on('log', d => onLog(`[T${turns}] ${BotAI.getPhase(Game.getCurrentPlayer())} ${d.message}`));
    Game.on('combat_update', d => { for (const l of d.newLog ?? []) onLog(`[T${turns}] combat ${typeof l === 'object' ? l.text : l}`); });
  }
  Game.on('dragon_defeated',  () => { done = 'dragon'; });
  let killer = null;
  Game.on('player_defeated',  () => { done = 'dead'; killer = Game.getState().pendingCombat?.mob?.id ?? null; });
  Game.init([{ id:'p0', name:'Bot1', isBot:true }], 'medium');
  const p = Game.getState().players[0];
  p.botStrategy = toBot(genome);
  let steps = 0, err = null;
  while (!done && queue.length && turns < CAP && steps < 200000) {
    steps++;
    try { queue.shift()(); } catch (e) { err = e.message; break; }
  }
  inspect?.(Game, BotAI, p);
  const outcome = done === 'dragon' ? 'dragon' : done === 'dead' ? 'dead' : err ? 'error' : turns >= CAP ? 'timeout' : 'stall';
  return { outcome, turns, score: outcome === 'dragon' ? turns : CAP, base: { ...p.baseStats }, killer, goal: BotAI.getPhase(p) };
}

// ── worker pool ─────────────────────────────────────────────────────────────
function makePool(n) {
  const workers = Array.from({ length: n }, () => fork(__filename, ['--worker']));
  const idle = workers.slice(), waiting = [];
  let pendingJobs = [];
  function pump() {
    while (idle.length && pendingJobs.length) {
      const w = idle.pop(), job = pendingJobs.shift();
      w.once('message', r => { idle.push(w); job.resolve(r); pump(); });
      w.send(job.task);
    }
  }
  return {
    run(tasks) { return Promise.all(tasks.map(task => new Promise(resolve => { pendingJobs.push({ task, resolve }); pump(); }))); },
    close() { workers.forEach(w => w.send(null)); },
  };
}

// ── search ──────────────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = rng(424242);
const pick = a => a[Math.floor(R() * a.length)];
const randomGenome = () => ({ base: pick(BASES), tune: Object.fromEntries(Object.entries(SPACE).map(([k, v]) => [k, pick(v)])) });
function mutate(g, n = 1 + Math.floor(R() * 3)) {
  const t = { ...g.tune }; let base = g.base;
  for (let i = 0; i < n; i++) { if (R() < 0.12) base = pick(BASES); else { const k = pick(Object.keys(SPACE)); t[k] = pick(SPACE[k]); } }
  return { base, tune: t };
}
function crossover(a, b) {
  return { base: R() < 0.5 ? a.base : b.base, tune: Object.fromEntries(Object.keys(SPACE).map(k => [k, R() < 0.5 ? a.tune[k] : b.tune[k]])) };
}

const SEEDS = Array.from({ length: 96 }, (_, i) => 900001 + i * 104729);
const cache = new Map();     // key → { genome, results: Map(seed → result) }
function stats(entry, nSeeds) {
  const rs = SEEDS.slice(0, nSeeds).map(s => entry.results.get(s)).filter(Boolean);
  const sc = rs.map(r => r.score).sort((a, b) => a - b);
  return { n: rs.length, mean: sc.reduce((a, b) => a + b, 0) / (sc.length || 1), median: sc[sc.length >> 1],
           deaths: rs.filter(r => r.outcome === 'dead').length, timeouts: rs.filter(r => r.outcome !== 'dragon' && r.outcome !== 'dead').length };
}
async function evaluate(pool, genomes, nSeeds) {
  const tasks = [];
  for (const g of genomes) {
    const k = keyOf(g);
    const e = cache.get(k) ?? cache.set(k, { genome: g, results: new Map() }).get(k);
    for (const s of SEEDS.slice(0, nSeeds)) if (!e.results.has(s)) tasks.push({ key: k, genome: g, seed: s });
  }
  const res = await pool.run(tasks);
  res.forEach((r, i) => cache.get(tasks[i].key).results.set(tasks[i].seed, r));
  return tasks.length;
}
// successive halving over `genomes`; returns them ranked by mean score on the deepest round they reached
async function halving(pool, genomes, rounds = [6, 12, 24, 48]) {
  let alive = genomes.slice(), games = 0;
  for (let i = 0; i < rounds.length; i++) {
    games += await evaluate(pool, alive, rounds[i]);
    alive.sort((a, b) => stats(cache.get(keyOf(a)), rounds[i]).mean - stats(cache.get(keyOf(b)), rounds[i]).mean);
    if (i < rounds.length - 1) alive = alive.slice(0, Math.max(4, Math.ceil(alive.length / 2)));
  }
  return { ranked: alive, games };
}

async function main() {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
  const workers = +arg('workers', require('os').cpus().length);
  const pool = makePool(workers);

  if (process.argv.includes('--eval')) {
    const g = JSON.parse(arg('eval'));
    g.tune = { ...DEFAULTS, ...(g.tune ?? {}) };
    const n = +arg('seeds', 100);
    const res = await pool.run(Array.from({ length: n }, (_, i) => ({ genome: g, seed: 5000017 + i * 7919 })));
    const sc = res.map(r => r.score).sort((a, b) => a - b);
    console.log(describe(g), `mean ${(sc.reduce((a, b) => a + b, 0) / n).toFixed(1)} median ${sc[n >> 1]} deaths ${res.filter(r => r.outcome === 'dead').length}/${n} timeouts ${res.filter(r => r.outcome === 'timeout' || r.outcome === 'stall').length}`);
    pool.close(); return;
  }

  const gens = +arg('gens', 8), popN = +arg('pop', 40);
  const out = arg('out', 'results/search'); fs.mkdirSync(out, { recursive: true });
  const t0 = Date.now(), log = [];
  const say = s => { console.log(s); log.push(s); fs.writeFileSync(path.join(out, 'search_log.md'), log.join('\n') + '\n'); };
  say(`# Strategy search — solo race to the dragon (score = own turns, death/timeout = ${CAP})\n`);

  // generation 0: the 11 hand-written profiles + random genomes
  let pop = BASES.map(b => ({ base: b, tune: { ...DEFAULTS } }));
  while (pop.length < popN) pop.push(randomGenome());
  let elites = [];
  for (let gen = 0; gen < gens; gen++) {
    const { ranked, games } = await halving(pool, pop);
    elites = [...new Map([...elites, ...ranked].map(g => [keyOf(g), g])).values()]
      .filter(g => stats(cache.get(keyOf(g)), 48).n >= 48)
      .sort((a, b) => stats(cache.get(keyOf(a)), 48).mean - stats(cache.get(keyOf(b)), 48).mean).slice(0, 12);
    say(`## Generation ${gen} — ${games} games, ${((Date.now() - t0) / 60000).toFixed(1)} min total`);
    for (const g of elites.slice(0, 6)) { const s = stats(cache.get(keyOf(g)), 48);
      say(`- ${s.mean.toFixed(1)} mean / ${s.median} median, deaths ${s.deaths}, timeouts ${s.timeouts} — ${describe(g)}`); }
    // next population: elites + mutants + crossovers + a few randoms
    pop = elites.slice();
    while (pop.length < popN * 0.8) pop.push(R() < 0.6 ? mutate(pick(elites.slice(0, 6))) : mutate(crossover(pick(elites), pick(elites)), 1));
    while (pop.length < popN) pop.push(randomGenome());
  }

  // final report: baselines vs best overall vs best per base
  const all = [...cache.values()].filter(e => stats(e, 48).n >= 48).sort((a, b) => stats(a, 48).mean - stats(b, 48).mean);
  say(`\n## Baselines (hand-written profiles, 48 seeds)`);
  for (const b of BASES) { const e = cache.get(keyOf({ base: b, tune: { ...DEFAULTS } })); const s = stats(e, 48);
    say(`- ${b.padEnd(3)} ${s.n >= 48 ? s.mean.toFixed(1) : `(dropped after ${s.n} seeds, ${s.mean.toFixed(1)})`} mean / ${s.median} median, deaths ${s.deaths}/${s.n}`); }
  say(`\n## Best genome per base (48 seeds)`);
  for (const b of BASES) { const e = all.find(x => x.genome.base === b); if (!e) continue; const s = stats(e, 48);
    say(`- ${s.mean.toFixed(1)} mean / ${s.median} median, deaths ${s.deaths} — ${describe(e.genome)}`); }
  fs.writeFileSync(path.join(out, 'genomes.json'), JSON.stringify(all.slice(0, 40).map(e => ({ genome: e.genome, ...stats(e, 48) })), null, 1));
  say(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min. Top genomes: ${path.join(out, 'genomes.json')}`);
  pool.close();
}

if (process.argv[2] === '--worker') {
  process.on('message', t => { if (!t) process.exit(0); let r; try { r = runSolo(t.genome, t.seed); } catch (e) { r = { outcome: 'error', turns: 0, score: CAP, err: e.message }; } process.send(r); });
} else if (require.main === module) main();
module.exports = { runSolo, toBot, DEFAULTS, SPACE };
