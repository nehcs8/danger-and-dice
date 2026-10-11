#!/usr/bin/env node
// Strategy tournament: every distinct 4-strategy line-up, one seeded game each, run in parallel.
// Records a per-game / per-bot trace detailed enough to diagnose strategy weaknesses, then writes
// a summary report.
//
// Usage:
//   node strategy_tournament.js [--workers 8] [--max-turns 1600] [--strategies F,D,...] [--require BM] [--limit N] [--out dir]
//   node strategy_tournament.js --replay <seed> <S1,S2,S3,S4> [--max-turns 1600]   → full log of one game to stdout
//   node strategy_tournament.js --report <dir>                                    → rebuild summary from games.jsonl
'use strict';
const fs = require('fs'), path = require('path'), { fork } = require('child_process');
const { makeSandbox, get } = require('./lib_sb.js');

const ALL_STRATS = ['F','D','FB','DB','M','G','GB','BP','DT','SS','BB','BM','CH','CR'];
const STAT_KEYS = ['F','D','A','M','C','V'];

// ════════════════════════════════════════════════════════════════════════════
// One instrumented game
// ════════════════════════════════════════════════════════════════════════════
// onReady(Game, BotAI): optional hook for ad-hoc probes; it runs before Game.init.
function runGame({ seed, lineup, maxTurns = 1600, fullLog = false, onReady = null }) {
  const sb = makeSandbox('js/engine/bot_v2.js', [], seed);
  const Game = get(sb, 'Game'), BotAI = get(sb, 'BotAI'), KB = get(sb, 'KingBattle'), Ph = Game.Phase;
  const getItem = get(sb, 'getItem'), dbg = BotAI._debug;
  const players = lineup.map((s, i) => ({ id:`p${i}`, name:`Bot${i+1}`, isBot:true }));
  const queue = [], recentLog = [], fullLines = [];
  let result = null, turns = 0, err = null;
  const st = () => Game.getState();
  const cur = () => Game.getCurrentPlayer();
  const kick = () => { const p = cur(); if (p?.isBot) queue.push(() => BotAI.takeTurn(p)); };
  const byName = {};
  const T = {};             // per-bot trace, keyed by name
  const game = { events: [], pvp: [], dragonTurn: null, dragonKiller: null, princess: [] };

  const eqList = p => Object.entries(p.equipped).filter(([, it]) => it).map(([slot, it]) => {
    const lv = p.guildItemLevels?.[it.id]?.itemLevel;
    return `${it.id}${it.enchantment ? `[${it.enchantment.id}${it.enchantment.tier ?? ''}]` : ''}${lv > 1 ? `@L${lv}` : ''}`;
  });
  const invSummary = p => { const c = {}; for (const id of p.inventory) c[id] = (c[id] ?? 0) + 1; return c; };
  const stats = p => STAT_KEYS.map(s => p.getStat(s));

  // ── fight tracking ───────────────────────────────────────────────────────
  let fight = null;
  function openFight(p, pc) {
    const mob = pc.mob;
    let pred = null;
    try {   // the bot's own estimate for this exact mob, at current hearts, with its potion policy
      const snap = dbg.snapshot(p, { usePots:true }); pred = +dbg.simFight(snap, mob, 150).winP.toFixed(2);
    } catch (e) { /* estimate is optional */ }
    fight = { p: p.name, t: turns, mob: mob.id ?? mob.name, tier: pc.minibossTier ?? mob.tier ?? null,
              kind: pc.isBoss ? 'boss' : pc.minibossTier != null ? 'miniboss' : 'random',
              h0: p.hearts.current, pred, res: null, friend: false };
    if (pc.isBoss) fight.eq = eqList(p);   // boss fights: what was actually worn (enchantments included)
  }
  function closeFight(res) {
    if (!fight) return;
    const p = byName[fight.p];
    fight.res = fight.res ?? res; fight.h1 = p.hearts.current;
    T[fight.p].fights.push(fight); fight = null;
  }

  Game.on('state_change', d => {
    if (result) return;
    const s = st();
    if (fight && d.phase !== Ph.COMBAT) closeFight('other');
    if (d.phase === Ph.COMBAT && !fight && s.pendingCombat && !s.pendingCombat.isPvp) openFight(cur(), s.pendingCombat);
    if (d.phase === Ph.SETUP_ROLL) { if (s.players[s.setupRollIdx]?.isBot) queue.push(() => Game.submitAction({ type:'setup_roll' })); return; }
    if (d.phase === Ph.GAME_OVER) return;
    if (d.phase === Ph.KING_BATTLE) { queue.push(() => KB.resolveWin()); return; }
    if (d.phase === Ph.LOOT_CONFIRM) { if (cur()?.isBot) queue.push(() => Game.submitAction({ type:'loot_confirm' })); return; }
    if (d.phase === Ph.ROLL_MOVE) {
      turns++;
      const p = cur(), tr = T[p.name];
      if (tr) {
        const goal = BotAI.getPhase(p);
        const m = dbg.mem[p.id] ?? {};
        const kind = goal.replace(/^\[\w+\] /, '');
        const last = tr.goals[tr.goals.length - 1];
        if (last && last.g === kind) last.n++; else tr.goals.push({ g: kind, t0: turns, n: 1 });
        const pos = `${p.position.x},${p.position.y}`;
        if (pos === tr._lastPos) tr.idleTurns++;
        tr._lastPos = pos; tr.ownTurns++;
        const dP = m.lastDragonP != null ? +m.lastDragonP.toFixed(2) : null;
        // compact per-turn row: turn, hearts, maxHearts, coins, F,D,A,M,C,V, x, y, dragonP
        tr.series.push([turns, p.hearts.current, p.hearts.max, p.coins, ...stats(p), p.position.x, p.position.y, dP]);
        if (tr._lastCoins != null) { const dc = p.coins - tr._lastCoins; if (dc > 0) tr.coinsIn += dc; else tr.coinsOut -= dc; }
        tr._lastCoins = p.coins;
        if (dP != null && dP >= 0.85 && tr.milestones.dragonReady == null) tr.milestones.dragonReady = turns;
        const prof = BotAI.getStrategy(p);
        if (prof !== tr.profileNow) { tr.profileChanges.push({ t: turns, from: tr.profileNow, to: prof }); tr.profileNow = prof; }
        const eq = eqList(p);
        if (eq.some(x => /invis_cloak/.test(x)) && tr.milestones.cloak == null) tr.milestones.cloak = turns;
        if (eq.length >= 5 && tr.milestones.fiveEquipped == null) tr.milestones.fiveEquipped = turns;
      }
    }
    kick();
  });
  Game.on('combat_update', d => {
    if (result) return;
    if (fight && d.outcome === 'befriended') fight.res = 'befriended';
    if (fight && d.outcome === 'charisma_end') fight.res = 'charisma_flee';
    if (d.outcome === 'ongoing' || d.outcome === 'charisma_pending') kick();
  });
  Game.on('combat_victory', d => {
    if (fight) fight.res = 'win';
    else if (T[d.player]) T[d.player].fights.push({ p: d.player, t: turns, mob: d.mob, tier: d.mobTier, kind: 'instant', h0: byName[d.player].hearts.current, h1: byName[d.player].hearts.current, pred: 1, res: 'win' });
  });
  Game.on('player_defeated', d => {
    const tr = T[d.player]; if (!tr) return;
    if (fight && fight.p === d.player) fight.res = 'loss';
    tr.death = { t: turns, by: d.by ?? fight?.mob ?? 'unknown', pvp: !!d.by, goal: BotAI.getPhase(byName[d.player]).replace(/^\[\w+\] /, ''), hearts0: fight?.h0, pred: fight?.pred };
  });
  Game.on('pvp_update', d => {
    if (result) return;
    if (d.outcome === 'ongoing') { queue.push(() => BotAI.pvpTick()); return; }
    game.pvp.push({ t: turns, outcome: d.outcome, players: d.players?.map(x => x.name), winner: d.winner ?? null, escaped: d.escaped ?? null, rounds: d.round });
  });
  Game.on('dragon_defeated', () => { game.dragonTurn = turns; game.dragonKiller = cur()?.name; T[cur().name].milestones.dragonKill = turns; });
  Game.on('princess_picked_up', d => game.princess.push({ t: turns, p: d.player }));
  Game.on('princess_dropped', () => game.princess.push({ t: turns, p: null }));
  Game.on('shop_transaction', d => {
    const tr = T[d.player]; if (tr) tr.shop.push([turns, d.type, d.item?.id ?? d.item]);
    if (!result && inShop()) kick();
  });
  Game.on('skill_upgraded', d => { const tr = T[d.player]; if (tr) tr.shop.push([turns, 'skill', `${d.stat}->${d.newValue}`]); if (!result) kick(); });
  Game.on('enchanted', d => { const tr = T[d.player]; if (tr) tr.shop.push([turns, 'enchant', `${d.slot}:${d.enchantment?.id ?? d.enchantment}`]); if (!result) kick(); });
  Game.on('item_equipped', d => {
    const tr = T[d.player];
    if (tr) {
      const it = d.item, tier = it?.tier ?? 0;
      if (tier >= 5 && tr.milestones.tier5 == null) tr.milestones.tier5 = turns;
      if (it?.guild && tr.milestones.guildItem == null) tr.milestones.guildItem = turns;
    }
    if (!result && inShop()) kick();
  });
  Game.on('item_unequipped', () => { if (!result && inShop()) kick(); });
  Game.on('item_used', d => { const tr = T[d.player]; if (tr && d.item?.id) tr.used[d.item.id] = (tr.used[d.item.id] ?? 0) + 1; });
  Game.on('log', d => {
    const msg = d.message ?? '';
    if (fight && /escapes from/.test(msg)) fight.res = 'escaped';
    recentLog.push(`[T${turns}] ${msg}`); if (recentLog.length > 80) recentLog.shift();
    if (fullLog) fullLines.push(`[T${turns}] ${msg}`);
  });
  Game.on('game_over', d => { result = d; });
  const inShop = () => { const ph = st().phase; return ph === Ph.SHOP || ph === Ph.MASTER; };

  onReady?.(Game, BotAI);
  Game.init(players, 'medium');
  st().players.forEach((p, i) => {
    p.botStrategy = lineup[i];
    byName[p.name] = p;
    T[p.name] = { name: p.name, seat: i, strategy: lineup[i], profileNow: null, profileChanges: [],
                  goals: [], fights: [], shop: [], used: {}, series: [], milestones: {},
                  ownTurns: 0, idleTurns: 0, coinsIn: 0, coinsOut: 0, death: null };
  });
  const t0 = Date.now();
  let steps = 0;
  while (!result && queue.length && turns < maxTurns && steps < 600000) {
    steps++;
    const fn = queue.shift();
    try { fn(); } catch (e) { err = e.stack; break; }
  }
  const s = st();
  for (const p of s.players) {
    const tr = T[p.name];
    tr.baseStatsStart = tr.series.length ? null : null;
    tr.final = { alive: p.isAlive, hearts: p.hearts.current, maxHearts: p.hearts.max, coins: p.coins,
                 stats: Object.fromEntries(STAT_KEYS.map(k => [k, p.getStat(k)])),
                 base: { ...p.baseStats }, xp: { ...p.xp }, equipped: eqList(p), inv: invSummary(p),
                 hasPrincess: !!p.hasPrincess, lastGoal: BotAI.getPhase(p), friends: p.friendsList?.length ?? 0 };
    tr.profileFinal = BotAI.getStrategy(p);
    const m = dbg.mem[p.id] ?? {};
    tr.lastDragonP = m.lastDragonP ?? null; tr.lastPlanP = m.lastPlanP ?? null;
    delete tr._lastPos; delete tr._lastCoins; delete tr.baseStatsStart;
  }
  const outcome = err ? 'ERROR' : result?.winner ? 'WIN' : result ? 'ALL_DEAD' : turns >= maxTurns ? 'TIMEOUT' : 'STALL';
  const winnerName = result?.winner ?? null;
  return {
    seed, lineup, outcome, reason: result?.reason ?? null, turns, ms: Date.now() - t0,
    winner: winnerName, winnerStrategy: winnerName ? T[winnerName].strategy : null, winnerSeat: winnerName ? T[winnerName].seat : null,
    phaseAtEnd: s.phase, ...game,
    err, lastLog: outcome === 'WIN' ? recentLog.slice(-25) : recentLog,
    bots: Object.values(T),
    fullLog: fullLog ? fullLines : undefined,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Line-ups
// ════════════════════════════════════════════════════════════════════════════
function combos(arr, k) {
  const out = [];
  const rec = (start, acc) => { if (acc.length === k) { out.push(acc.slice()); return; } for (let i = start; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); } };
  rec(0, []); return out;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function buildTasks(strats, baseSeed = 20261011) {
  const r = rng(baseSeed);
  return combos(strats, 4).map((c, i) => {
    const l = c.slice();   // shuffle seats so no strategy always sits first
    for (let j = l.length - 1; j > 0; j--) { const k = Math.floor(r() * (j + 1)); [l[j], l[k]] = [l[k], l[j]]; }
    return { idx: i, seed: baseSeed + i * 7919, lineup: l };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════════
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, b) => b ? (100 * a / b).toFixed(0) + '%' : '-';
const f1 = x => x == null ? '-' : (+x).toFixed(1);

function report(games) {
  const strats = [...new Set(games.flatMap(g => g.lineup))];
  const L = [];
  const S = {};
  for (const s of strats) S[s] = { games: 0, wins: 0, deaths: 0, pvpDeaths: 0, dragonKills: 0, fallbacks: 0, ownTurns: [], idle: [],
    fights: { win: 0, loss: 0, escaped: 0, other: 0, befriended: 0, charisma_flee: 0 }, byTier: {}, goalTurns: {}, deathsBy: {}, deathGoal: {},
    ms: { cloak: [], tier5: [], guildItem: [], dragonReady: [], dragonKill: [], fiveEquipped: [] }, finalStats: [], lastDragonP: [],
    coinsIn: [], winTurns: [], longLoops: [], badPred: 0, predFights: 0, calib: { exp: 0, act: 0 }, seatWins: [0,0,0,0], seatGames: [0,0,0,0], used: {} };
  const h2h = {}; for (const a of strats) { h2h[a] = {}; for (const b of strats) h2h[a][b] = { g: 0, w: 0 }; }
  const outcomes = {};
  for (const g of games) {
    outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
    for (const b of g.bots) {
      const s = S[b.strategy]; s.games++;
      s.seatGames[b.seat]++;
      const won = g.winner === b.name;
      if (won) { s.wins++; s.seatWins[b.seat]++; s.winTurns.push(g.turns); }
      for (const o of g.bots) if (o !== b) { h2h[b.strategy][o.strategy].g++; if (won) h2h[b.strategy][o.strategy].w++; }
      if (b.death) { s.deaths++; if (b.death.pvp) s.pvpDeaths++; const k = b.death.pvp ? 'PvP' : b.death.by; s.deathsBy[k] = (s.deathsBy[k] ?? 0) + 1; s.deathGoal[b.death.goal.split(':')[0]] = (s.deathGoal[b.death.goal.split(':')[0]] ?? 0) + 1; }
      if (b.milestones.dragonKill != null) s.dragonKills++;
      if (b.profileChanges.some(c => c.from != null)) s.fallbacks++;
      s.ownTurns.push(b.ownTurns); s.idle.push(b.ownTurns ? b.idleTurns / b.ownTurns : 0);
      s.coinsIn.push(b.coinsIn);
      for (const k in s.ms) if (b.milestones[k] != null) s.ms[k].push(b.milestones[k]);
      s.finalStats.push(b.final.stats); if (b.lastDragonP != null) s.lastDragonP.push(b.lastDragonP);
      for (const [id, n] of Object.entries(b.used)) s.used[id] = (s.used[id] ?? 0) + n;
      for (const gs of b.goals) { const k = gs.g.split(':')[0]; s.goalTurns[k] = (s.goalTurns[k] ?? 0) + gs.n; if (gs.n >= 40) s.longLoops.push(`${g.seed}:${b.name} ${gs.g} x${gs.n} @T${gs.t0}`); }
      for (const f of b.fights) {
        s.fights[f.res] = (s.fights[f.res] ?? 0) + 1;
        const tk = f.kind === 'boss' ? `boss:${f.mob}` : `${f.kind}:t${f.tier}`;
        const bt = (s.byTier[tk] ??= { n: 0, win: 0, loss: 0, esc: 0, hl: 0, pred: 0 });
        bt.n++; if (f.res === 'win') bt.win++; if (f.res === 'loss') bt.loss++; if (f.res === 'escaped') bt.esc++;
        bt.hl += Math.max(0, (f.h0 ?? 0) - (f.h1 ?? 0)); bt.pred += f.pred ?? 0;
        if (f.pred != null && f.kind !== 'instant') { s.predFights++; s.calib.exp += f.pred; s.calib.act += f.res === 'win' ? 1 : 0; if (f.pred >= 0.9 && f.res === 'loss') s.badPred++; }
      }
    }
  }
  const N = games.length;
  L.push(`# Strategy tournament report`, ``, `${N} games · outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push(`Median game length: ${median(games.map(g => g.turns))} turns (all players) · median wall time ${median(games.map(g => g.ms))} ms`, ``);

  L.push(`## Win rate (expected 25% with 4 players)`, ``, `| strat | games | wins | win% | dragon kills | deaths (pvp) | fallback | median turns-to-win | median own turns | idle% |`, `|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of strats.slice().sort((a, b) => S[b].wins / S[b].games - S[a].wins / S[a].games)) {
    const x = S[s];
    L.push(`| ${s} | ${x.games} | ${x.wins} | ${pct(x.wins, x.games)} | ${x.dragonKills} | ${x.deaths} (${x.pvpDeaths}) | ${x.fallbacks} | ${f1(median(x.winTurns))} | ${f1(median(x.ownTurns))} | ${(100 * median(x.idle)).toFixed(0)}% |`);
  }
  L.push(``, `## Milestones (median turn reached, game-turn counter; n = how many bots reached it)`, ``, `| strat | 5 equipped | tier5 item | guild item | cloak | dragonP≥0.85 | dragon kill | final dragonP (median) |`, `|---|---|---|---|---|---|---|---|`);
  for (const s of strats) { const x = S[s], c = k => `${f1(median(x.ms[k]))} (${x.ms[k].length})`;
    L.push(`| ${s} | ${c('fiveEquipped')} | ${c('tier5')} | ${c('guildItem')} | ${c('cloak')} | ${c('dragonReady')} | ${c('dragonKill')} | ${f1(median(x.lastDragonP))} |`); }

  L.push(``, `## Final stats (median of effective stats at game end)`, ``, `| strat | F | D | A | M | C | V |`, `|---|---|---|---|---|---|---|`);
  for (const s of strats) L.push(`| ${s} | ${STAT_KEYS.map(k => f1(median(S[s].finalStats.map(x => x[k])))).join(' | ')} |`);

  L.push(``, `## Time allocation (% of own turns per goal kind)`, ``);
  const kinds = [...new Set(strats.flatMap(s => Object.keys(S[s].goalTurns)))].sort();
  L.push(`| strat | ${kinds.join(' | ')} |`, `|---|${kinds.map(() => '---').join('|')}|`);
  for (const s of strats) { const tot = Object.values(S[s].goalTurns).reduce((a, b) => a + b, 0); L.push(`| ${s} | ${kinds.map(k => pct(S[s].goalTurns[k] ?? 0, tot)).join(' | ')} |`); }

  L.push(``, `## Fights`, ``, `| strat | fights | win | loss | escaped | other | bot-model calibration (pred→actual win%) | losses at pred≥0.9 |`, `|---|---|---|---|---|---|---|---|`);
  for (const s of strats) { const x = S[s], tot = Object.values(x.fights).reduce((a, b) => a + b, 0);
    L.push(`| ${s} | ${tot} | ${x.fights.win} | ${x.fights.loss} | ${x.fights.escaped} | ${(x.fights.other ?? 0) + (x.fights.befriended ?? 0) + (x.fights.charisma_flee ?? 0)} | ${pct(x.calib.exp, x.predFights)} → ${pct(x.calib.act, x.predFights)} | ${x.badPred} |`); }
  L.push(``, `### Fights by type (per strategy: n · win% · avg hearts lost · avg predicted)`, ``);
  for (const s of strats) {
    const rows = Object.entries(S[s].byTier).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v.n}·${pct(v.win, v.n)}·${(v.hl / v.n).toFixed(1)}h·p${(v.pred / v.n).toFixed(2)}`);
    L.push(`- **${s}**: ${rows.join(' | ')}`);
  }
  L.push(``, `## Deaths`, ``);
  for (const s of strats) { const x = S[s]; if (!x.deaths) continue;
    L.push(`- **${s}** (${x.deaths}): by ${Object.entries(x.deathsBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')} · while goal ${Object.entries(x.deathGoal).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`); }

  L.push(``, `## Head-to-head (row's win% in games where column strategy was also present)`, ``, `| | ${strats.join(' | ')} |`, `|---|${strats.map(() => '---').join('|')}|`);
  for (const a of strats) L.push(`| **${a}** | ${strats.map(b => a === b ? '·' : pct(h2h[a][b].w, h2h[a][b].g)).join(' | ')} |`);

  const seatW = [0,0,0,0], seatG = [0,0,0,0]; for (const s of strats) for (let i = 0; i < 4; i++) { seatW[i] += S[s].seatWins[i]; seatG[i] += S[s].seatGames[i]; }
  L.push(``, `## Seat bias`, ``, seatW.map((w, i) => `seat ${i + 1}: ${pct(w, seatG[i] / 4)} of games`).join(' · '));

  L.push(``, `## Consumables used (total per strategy, top 8)`, ``);
  for (const s of strats) L.push(`- **${s}**: ${Object.entries(S[s].used).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);

  L.push(``, `## Long goal loops (same goal ≥ 40 consecutive own turns — seed:bot goal xN @start)`, ``);
  for (const s of strats) if (S[s].longLoops.length) L.push(`- **${s}** (${S[s].longLoops.length}): ${S[s].longLoops.slice(0, 8).join('; ')}${S[s].longLoops.length > 8 ? ' …' : ''}`);

  const bad = games.filter(g => g.outcome !== 'WIN');
  L.push(``, `## Non-wins (${bad.length})`, ``);
  for (const g of bad.slice(0, 30)) {
    L.push(`- seed ${g.seed} [${g.lineup.join(',')}] ${g.outcome}${g.reason ? ` (${g.reason})` : ''} at T${g.turns}, phase ${g.phaseAtEnd}; dragon ${g.dragonTurn ?? '-'}; ` +
      g.bots.map(b => `${b.strategy}:${b.final.alive ? 'alive' : 'dead'} ${b.final.lastGoal.replace(/^\[\w+\] /, '')} dP=${f1(b.lastDragonP)}`).join(' · '));
    if (g.err) L.push('  ```\n  ' + g.err.split('\n').slice(0, 6).join('\n  ') + '\n  ```');
  }
  L.push(``, `## Post-dragon phase`, ``);
  const post = games.filter(g => g.dragonTurn != null);
  L.push(`${post.length} games reached the dragon kill. Median turns dragon→end: ${median(post.map(g => g.turns - g.dragonTurn))}. ` +
    `Dragon killer won: ${pct(post.filter(g => g.winner === g.dragonKiller).length, post.length)}. PvP fights: ${games.reduce((a, g) => a + g.pvp.length, 0)}, princess changed hands: ${games.reduce((a, g) => a + Math.max(0, g.princess.filter(x => x.p).length - 1), 0)}.`);
  return { md: L.join('\n'), S, h2h };
}

// ════════════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════════════
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

if (process.argv[2] === '--worker') {
  process.on('message', task => {
    if (!task) process.exit(0);
    let r;
    try { r = runGame(task); } catch (e) { r = { seed: task.seed, lineup: task.lineup, outcome: 'ERROR', err: e.stack, turns: 0, bots: [], pvp: [], princess: [] }; }
    r.idx = task.idx;
    process.send(r);
  });
} else if (process.argv[2] === '--replay') {
  const seed = +process.argv[3], lineup = process.argv[4].split(',');
  const r = runGame({ seed, lineup, maxTurns: +arg('max-turns', 1600), fullLog: true });
  console.log(r.fullLog.join('\n'));
  delete r.fullLog; delete r.lastLog;
  console.log('\n' + JSON.stringify({ ...r, bots: r.bots.map(b => ({ ...b, series: `${b.series.length} rows` })) }, null, 1));
} else if (process.argv[2] === '--report') {
  const dir = process.argv[3];
  const games = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const { md } = report(games); fs.writeFileSync(path.join(dir, 'summary.md'), md); console.log(md);
} else if (require.main === module) {
  const strats = (arg('strategies', ALL_STRATS.join(','))).split(',');
  const workers = +arg('workers', require('os').cpus().length);
  const maxTurns = +arg('max-turns', 1600);
  let tasks = buildTasks(strats);
  if (arg('require')) tasks = tasks.filter(t => t.lineup.includes(arg('require')));   // only line-ups with this strategy
  if (arg('limit')) tasks = tasks.slice(0, +arg('limit'));
  const out = arg('out', path.join('results', `tournament_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
  fs.mkdirSync(out, { recursive: true });
  const jsonl = fs.createWriteStream(path.join(out, 'games.jsonl'));
  console.log(`${tasks.length} games, ${workers} workers → ${out}`);
  const t0 = Date.now(), results = [];
  let next = 0, done = 0;
  const pool = Array.from({ length: Math.min(workers, tasks.length) }, () => fork(__filename, ['--worker']));
  const feed = w => { if (next < tasks.length) w.send({ ...tasks[next++], maxTurns }); else w.send(null); };
  pool.forEach(w => {
    w.on('message', r => {
      results.push(r); jsonl.write(JSON.stringify(r) + '\n'); done++;
      process.stdout.write(`\r${done}/${tasks.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s  last: [${r.lineup.join(',')}] ${r.outcome} ${r.winnerStrategy ?? ''} T${r.turns}      `);
      feed(w);
    });
    feed(w);
  });
  let exited = 0;
  pool.forEach(w => w.on('exit', () => {
    if (++exited < pool.length) return;
    jsonl.end();
    results.sort((a, b) => a.idx - b.idx);
    const { md } = report(results);
    fs.writeFileSync(path.join(out, 'summary.md'), md);
    console.log(`\n\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s. Summary: ${path.join(out, 'summary.md')}`);
  }));
}
module.exports = { runGame, report, buildTasks };
