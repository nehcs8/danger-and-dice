// Enchantment screening v2 (see bot_dev/ENCHANT_PLAN.md, sections 5–5c).
//
//   node bot_dev/enchant_screen.js capture [games=160] [workers=6] [--out file]
//     4-bot tournament games (line-ups of the 13 non-Charisma strategies, dev bot). Every EVERY own
//     turns, and when a bot starts the dragon fight, saves that bot, its living rivals and the
//     Master's Curse/Smoke stock → results/enchant/snaps.jsonl. Stops once the dragon is dead.
//     All bots go for the dragon at 0.97 instead of 0.85, so trajectories run past the usual go
//     point and weaker kits still get checkpoints where they can be ready.
//
//   node bot_dev/enchant_screen.js score [workers=6] [--in file] [--out file]
//     Per checkpoint (full 5-item boss loadout only):
//       1. quick pass, every legal kit: dragon P with a reference kit (only to shortlist) and
//          farm odds at the tier the bot was farming;
//       2. shortlist: top by quick P, the cheapest near the top, the best farm kit, the bot's own;
//       3. for each shortlisted kit: budget = coins + refund of the bot's own enchants − kit
//          price; the bot's planKit spends it on dragon supplies (stock-limited Curses/Smoke as
//          left at that moment) → ready if P ≥ READY; duel P vs the living rivals.
//     → results/enchant/scores.jsonl, then the report.
//
//   node bot_dev/enchant_screen.js report [--in file]
const fs = require('fs'), path = require('path'), { fork } = require('child_process');
process.chdir(path.join(__dirname, '..'));
process.env.BOT_FILE = process.env.BOT_FILE ?? 'bot_dev/bot_v2_dev.js';
const { makeSandbox, get } = require('../lib_sb.js');

const BOT_FILE = process.env.BOT_FILE;
const STRATS = ['F','D','FB','DB','DG','DBG','M','G','GB','BP','DT','SS','BB'];   // no Charisma builds (CH, CR, BM)
const EVERY = 5, READY = 0.85;
const REF_KIT = [...Array(10).fill('sp_curse'), ...Array(4).fill('pot_heal')];   // quick pass only
const SHORT_TOP = 10, SHORT_CHEAP = 5;
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

// ── Player (de)serialisation ────────────────────────────────────────────────
const KEEP = ['baseStats','hearts','coins','equipped','inventory','guildItemLevels','friendsList','storedEnchantments',
              'xp','masterSkillsBought','dialogueSkillsGained','quests','position','hasPrincess','isAlive'];
const dump = p => JSON.parse(JSON.stringify(Object.fromEntries(KEEP.map(k => [k, p[k]]))));
function load(p, s) { for (const k of KEEP) if (s[k] !== undefined) p[k] = JSON.parse(JSON.stringify(s[k])); p.statusEffects = []; p.tempBonuses = {}; p.priestBuff = 0; }
const STOCK_KEYS = ['round','masterCurseStock','masterCurseStockResetTurn','masterSmokeStock','masterSmokeStockResetTurn'];
const baseOf = s => typeof s === 'string' ? s : s.base;

// ── Capture ─────────────────────────────────────────────────────────────────
function capture(task) {
  const { runGame } = require('../strategy_tournament.js');
  const snaps = [];
  const lineup = task.lineup.map(s => ({ base: s, tune: { dragonGo: 0.97, kitTarget: 0.97 } }));
  runGame({ seed: task.seed, lineup, onReady: (Game, BotAI) => {
    const own = {}, wentDragon = new Set();
    const snap = (p, kind) => {
      const st = Game.getState();
      snaps.push({ game: task.idx, seed: task.seed, lineup: task.lineup, strategy: baseOf(p.botStrategy), id: p.id,
                   ownTurn: own[p.id], kind, player: dump(p), farmTier: BotAI._debug.farmTier(p, false),
                   rivals: st.players.filter(q => q !== p && q.isAlive).map(q => ({ strategy: baseOf(q.botStrategy), player: dump(q) })),
                   stock: Object.fromEntries(STOCK_KEYS.map(k => [k, st[k]])) });
    };
    Game.on('state_change', d => {
      const st = Game.getState();
      if (st.dragonDefeated) return;
      const p = Game.getCurrentPlayer();
      if (!p) return;
      if (d.phase === Game.Phase.ROLL_MOVE) { own[p.id] = (own[p.id] ?? 0) + 1; if (own[p.id] % EVERY === 0) snap(p, 'turn'); }
      if (d.phase === Game.Phase.COMBAT && st.pendingCombat?.mob?.id === 'dragon' && !wentDragon.has(p.id)) { wentDragon.add(p.id); snap(p, 'dragon'); }
    });
  } });
  return snaps;
}

// ── Kits ────────────────────────────────────────────────────────────────────
// A kit = effect enchants (count once) + stat enchants (+3, stack). Placement does not matter,
// except Lightness, which only acts on the item with the V malus (Heavy/Medium Armor).
const COST = { sharpness:60, precision:60, resistance:50, flame:100, thorns:100, arcane:50, lightness:30, fury:33, hawk_eye:33, bloodlust:100, plunder:100 };
const LEVELED = id => id === 'fury' || id === 'hawk_eye';
function kitsFor(atk, hasMalus, slots) {
  const effects = [[]];
  const add = opts => { const n = effects.length; for (let i = 0; i < n; i++) for (const o of opts) effects.push([...effects[i], o]); };
  add([['flame',1]]); add([['thorns',1]]); add([['arcane',1]]);
  if (hasMalus) add([['lightness',1]]);
  if (atk.includes('F')) add([['fury',1],['fury',2],['fury',3]]);
  if (atk.includes('D')) add([['hawk_eye',1],['hawk_eye',2],['hawk_eye',3]]);
  // Sharpness / Precision count once: they are optional single picks like the effects; Resistance stacks and fills the rest
  if (atk.includes('F')) add([['sharpness',1]]);
  if (atk.includes('D')) add([['precision',1]]);
  const stats = ['resistance'];
  const kits = [];
  for (const e of effects) {
    const free = slots - e.length;
    if (free < 0) continue;
    const fills = [];
    const rec = (i, left, acc) => { if (i === stats.length - 1) { fills.push([...acc, [stats[i], left]]); return; } for (let k = 0; k <= left; k++) rec(i + 1, left - k, [...acc, [stats[i], k]]); };
    rec(0, free, []);
    for (const f of fills) { const list = [...e]; for (const [id, k] of f) for (let i = 0; i < k; i++) list.push([id, 1]); kits.push(list); }
  }
  return kits;
}
const kitName = kit => {
  const c = {}; for (const [id, t] of kit) { const k = LEVELED(id) ? `${id}${t}` : id; c[k] = (c[k] ?? 0) + 1; }
  return Object.entries(c).sort().map(([k, n]) => n > 1 ? `${n}×${k}` : k).join('+') || '(none)';
};
const kitCost = kit => kit.reduce((s, [id, t]) => s + COST[id] * (LEVELED(id) ? t : 1), 0);
const countList = ids => { const c = {}; for (const id of ids) c[id] = (c[id] ?? 0) + 1; return Object.entries(c).map(([k, n]) => `${n}×${k}`).join(' '); };

// ── Score ───────────────────────────────────────────────────────────────────
function scoreGroup(snaps) {
  const out = [];
  const sb = makeSandbox(BOT_FILE, [], 12345);
  const Game = get(sb, 'Game'), BotAI = get(sb, 'BotAI'), D = BotAI._debug, ENCH = get(sb, 'ENCHANTMENTS');
  Game.init([0, 1, 2, 3].map(i => ({ id:`p${i}`, name:`Bot${i + 1}`, isBot:true })), 'medium');
  const st = Game.getState(), [p, ...others] = st.players;
  const items = eq => Object.values(eq).filter(Boolean);
  const apply = (eq, kit) => {
    const its = items(eq).map(it => ({ ...it, enchantment: null }));
    const used = new Set();
    for (const [id, tier] of [...kit].sort((a, b) => (b[0] === 'lightness') - (a[0] === 'lightness'))) {
      const it = id === 'lightness' ? its.find(x => !used.has(x) && (x.statBonus?.V ?? 0) < 0) : its.find(x => !used.has(x));
      if (!it) return null;
      used.add(it); it.enchantment = { ...ENCH.find(e => e.id === id), tier };
    }
    const res = {}; for (const k of Object.keys(eq)) res[k] = null;
    for (const it of its) res[it.slot] = it;
    return res;
  };
  // checkpoints of one bot in one game, in order; after the first checkpoint where some kit is
  // ready, score 3 more and stop (later ones only matter for kits that are much slower)
  const byBot = {};
  for (const s of snaps) (byBot[s.id] ??= []).push(s);
  for (const list of Object.values(byBot)) {
    list.sort((a, b) => a.ownTurn - b.ownTurn || (a.kind === 'dragon') - (b.kind === 'dragon'));
    let firstReady = null;
    for (const s of list) {
      if (firstReady != null && s.ownTurn > firstReady + 3 * EVERY) break;
      for (const k of STOCK_KEYS) st[k] = s.stock[k];
      p.botStrategy = s.strategy; load(p, s.player);
      s.rivals.forEach((r, i) => { others[i].botStrategy = r.strategy; load(others[i], r.player); });
      for (const k of Object.keys(D.mem)) delete D.mem[k];
      const realEq = p.equipped;
      const bossEq = Object.assign(Object.fromEntries(Object.keys(realEq).map(k => [k, null])), D.bossLoadout(p));
      if (items(bossEq).length < 5) continue;
      D.snapshot(p);
      const main = D.mem[p.id].profile.main;
      const own = items(bossEq).filter(it => it.enchantment).map(it => [it.enchantment.id, it.enchantment.tier ?? 1]);
      const refund = kitCost(own.filter(([id]) => COST[id] != null));
      const hasMalus = items(bossEq).some(it => (it.statBonus?.V ?? 0) < 0);
      const kits = kitsFor(main === 'M' ? ['F','D'] : [main], hasMalus, 5).map(k => ({ kit: k, name: kitName(k), cost: kitCost(k), eq: null }));
      kits.push({ kit: own, name: '(bot kit)', label: kitName(own), cost: refund, own: true, eq: bossEq });
      const ft = s.farmTier ?? 0;
      // 1. quick pass
      for (const k of kits) {
        k.eq = k.eq ?? apply(bossEq, k.kit);
        if (!k.eq) continue;
        p.equipped = k.eq;
        k.quickP = D.dragonWinP(p, REF_KIT, 200);
        const f = D.tierStats(p, ft, null, false);
        k.farmHearts = f.heartsLost; k.farmWin = f.winP;
      }
      const ok = kits.filter(k => k.eq);
      // 2. shortlist
      const best = Math.max(...ok.map(k => k.quickP));
      // even free reference supplies leave every kit far from READY: no budgeted kit can be ready yet
      if (best < 0.5) { out.push({ strategy: s.strategy, game: s.game, id: s.id, ownTurn: s.ownTurn, kind: 'skipped' }); p.equipped = realEq; continue; }
      const short = new Set([...ok].sort((a, b) => b.quickP - a.quickP).slice(0, SHORT_TOP));
      [...ok].filter(k => k.quickP >= best - 0.1).sort((a, b) => a.cost - b.cost).slice(0, SHORT_CHEAP).forEach(k => short.add(k));
      short.add([...ok].sort((a, b) => a.farmHearts - b.farmHearts || b.quickP - a.quickP)[0]);
      ok.filter(k => k.own).forEach(k => short.add(k));
      // 3. budgeted supplies + duels
      for (const k of short) {
        p.equipped = k.eq;
        const budget = p.coins + refund - k.cost;
        let planP = 0, plan = '';
        if (budget >= 0) { const r = D.planKit(p, budget, READY); planP = r.winP; plan = countList(r.kit); }
        const pv = s.rivals.length ? s.rivals.reduce((a, r, i) => a + D.simPvp(D.pvpSide(p), D.pvpSide(others[i]), 150), 0) / s.rivals.length : null;
        if (planP >= READY && firstReady == null) firstReady = s.ownTurn;
        out.push({ strategy: s.strategy, game: s.game, id: s.id, ownTurn: s.ownTurn, kind: s.kind,
                   kit: k.name, label: k.label ?? k.name, cost: k.cost, budget, quickP: +k.quickP.toFixed(3),
                   planP: +planP.toFixed(3), plan, ready: planP >= READY,
                   farmTier: ft, farmHearts: +k.farmHearts.toFixed(2), farmWin: +k.farmWin.toFixed(3),
                   pvp: pv == null ? null : +pv.toFixed(3), nRivals: s.rivals.length });
      }
      p.equipped = realEq;
    }
  }
  return out;
}

// ── Report ──────────────────────────────────────────────────────────────────
const RANKING = {};   // filled by report(): strategy → kits in rank order (written to results/enchant/ranking.json)
function report(rows) {
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '–';
  const lines = [];
  const byStrat = {};
  const lastScored = {};                                   // per bot-game: last checkpoint scored (censoring point)
  for (const r of rows) { const b = `${r.game}|${r.id}`; if (r.kind !== 'skipped') lastScored[b] = Math.max(lastScored[b] ?? 0, r.ownTurn); }
  for (const r of rows) if (r.kind !== 'skipped') (byStrat[r.strategy] ??= []).push(r);
  for (const strat of STRATS) {
    const rs = byStrat[strat]; if (!rs) continue;
    const bots = new Set(rs.map(r => `${r.game}|${r.id}`));
    const kits = {};
    for (const r of rs) (kits[r.kit] ??= []).push(r);
    // reference moment per bot-game: first checkpoint where the bot's own kit was ready, else the last scored one;
    // every kit is compared there (where it was shortlisted), so the dragon P column is like-for-like
    const refT = {};
    for (const r of rs) { const b = `${r.game}|${r.id}`; refT[b] ??= lastScored[b]; if (r.kit === '(bot kit)' && r.ready && r.ownTurn < refT[b]) refT[b] = r.ownTurn; }
    const res = [];
    for (const [kit, kr] of Object.entries(kits)) {
      // ready turn per bot-game = first scored checkpoint where this kit was ready; NEVER if none
      const first = {};
      // not ready while scored → censored at the last scored checkpoint + EVERY (a lower bound, shown as "> n")
      const cens = b => (lastScored[b] ?? 0) + EVERY + 0.5;
      for (const r of kr) { const b = `${r.game}|${r.id}`; if (!(b in first)) first[b] = cens(b); if (r.ready && r.ownTurn < first[b]) first[b] = r.ownTurn; }
      for (const b of bots) if (!(b in first)) first[b] = cens(b);   // never shortlisted for that bot
      const ready = Object.values(first);
      res.push({ kit, label: kr[0].label, cost: kr[0].cost, ready: med(ready), pReady: ready.filter(x => Number.isInteger(x)).length / ready.length,
                 seen: kr.length, farmH: mean(kr.map(r => r.farmHearts)), pvp: mean(kr.filter(r => r.pvp != null).map(r => r.pvp)),
                 planP: mean(kr.filter(r => r.ownTurn === refT[`${r.game}|${r.id}`]).map(r => r.planP)),
                 nRef: kr.filter(r => r.ownTurn === refT[`${r.game}|${r.id}`]).length });
    }
    res.sort((a, b) => a.ready - b.ready || b.pReady - a.pReady || b.planP - a.planP);
    RANKING[strat] = res.map(r => ({ kit: r.kit, cost: r.cost, ready: r.ready, pReady: r.pReady, pvp: r.pvp, farmH: r.farmH, seen: r.seen }));
    const own = res.find(r => r.kit === '(bot kit)');
    const show = res.filter(r => r.kit !== '(bot kit)').slice(0, 5);
    const minSeen = Math.max(10, Math.ceil(bots.size / 2));
    const pick = (cmp, tag) => { const r = [...res].filter(x => x.seen >= minSeen && x.kit !== '(bot kit)').sort(cmp)[0]; if (r) { r.tags = [...(r.tags ?? []), tag]; if (!show.includes(r)) show.push(r); } };
    pick((a, b) => a.farmH - b.farmH, 'best farm');
    pick((a, b) => b.pvp - a.pvp, 'best PvP');
    if (own) { own.tags = ['bot']; show.push(own); }
    lines.push(`\n## ${strat}   (${bots.size} bot-games)\n`);
    lines.push('| rank | kit | price | ready turn (med) | ready at all | dragon P at the reference moment (n) | farm hearts lost | duel P vs rivals | times scored |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of show) lines.push(`| ${res.indexOf(r) + 1}${r.tags ? ' ' + r.tags.join(', ') : ''} | ${r.kit === '(bot kit)' ? '(bot kit, varies)' : r.kit} | ${r.cost} | ${Number.isInteger(r.ready) ? r.ready : '> ' + Math.floor(r.ready - 0.5 - EVERY)} | ${(100 * r.pReady).toFixed(0)}% | ${f2(r.planP)} (${r.nRef}) | ${f2(r.farmH)} | ${f2(r.pvp)} | ${r.seen} |`);
  }
  return ['# Enchant kit screening v2',
    '',
    `Checkpoints every ${EVERY} own turns inside 4-bot games (13 non-Charisma strategies, dev bot, everyone goes for the dragon at 0.97). Only checkpoints with a full 5-item boss loadout are scored.`,
    `Ready = the kit plus the dragon supplies the bot could buy with what it had (coins + refund of its own enchants − kit price; supplies chosen by the bot's planKit, Curses/Smoke limited to the Master stock left at that moment) reach ${READY}.`,
    `Ready turn = first such own turn (median over bot-games). Scoring stops 3 checkpoints after the first kit is ready, so slower kits are censored: "> n" = not ready by own turn n. Checkpoints where even free reference supplies leave every kit under 0.5 are skipped.`,
    'Ready at all = share of bot-games where the kit was ready at some scored checkpoint.',
    'Dragon P at the reference moment = with affordable supplies, at the checkpoint where the bot\'s own kit was first ready (else its last scored one); n = bot-games where the kit was shortlisted there.',
    'Best farm / best PvP: only kits scored at least max(10, half the bot-games) times.',
    'Farm hearts lost: per fight at the tier the bot was farming. Duel P: the bot\'s duel model vs each living rival at that moment (their real gear).',
    ...lines].join('\n');
}

// ── Workers / CLI ───────────────────────────────────────────────────────────
if (process.argv[2] === '--enchworker') {
  process.on('message', m => {
    try {
      if (m.cmd === 'capture') process.send({ rows: capture(m.task) });
      else if (m.cmd === 'score') process.send({ rows: scoreGroup(m.snaps) });
    } catch (e) { process.send({ rows: [], err: e.stack }); }
  });
} else {
  const mode = process.argv[2];
  const nW = +(process.argv[mode === 'capture' ? 4 : 3] ?? 6) || 6;
  const runJobs = (jobs, onRows) => new Promise(res => {
    let next = 0, active = 0, finished = 0; const t0 = Date.now();
    const spawn = () => {
      if (next >= jobs.length) { if (active === 0) res(); return; }
      const w = fork(__filename, ['--enchworker']); active++;
      let used = 0;
      const give = () => { if (next >= jobs.length || used >= 10) { w.kill(); active--; spawn(); return; } used++; w.send(jobs[next++]); };
      w.on('message', m => { if (m.err) process.stderr.write(`\nworker error: ${m.err}\n`); onRows(m.rows); finished++;
        process.stderr.write(`\r${finished}/${jobs.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `); give(); });
      give();
    };
    for (let i = 0; i < Math.min(nW, jobs.length); i++) spawn();
  });
  const append = (file, rows) => { if (rows?.length) fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };
  (async () => {
    fs.mkdirSync('results/enchant', { recursive: true });
    if (mode === 'capture') {
      const n = +(process.argv[3] ?? 160) || 160;
      const out = arg('out', 'results/enchant/snaps.jsonl');
      fs.writeFileSync(out, '');
      const { buildTasks } = require('../strategy_tournament.js');
      const all = buildTasks(STRATS, 20261013);                       // 715 line-ups, seats shuffled
      const step = all.length / n;                                    // spread evenly: every strategy ≈ 4n/13 games
      const tasks = Array.from({ length: n }, (_, i) => all[Math.floor(i * step)]);
      await runJobs(tasks.map(task => ({ cmd:'capture', task })), rows => append(out, rows));
      console.error(`\nsnapshots → ${out}`);
    } else if (mode === 'score') {
      const inp = arg('in', 'results/enchant/snaps.jsonl'), out = arg('out', 'results/enchant/scores.jsonl');
      const snaps = fs.readFileSync(inp, 'utf8').trim().split('\n').map(JSON.parse);
      fs.writeFileSync(out, '');
      const groups = {};
      for (const s of snaps) (groups[`${s.game}|${s.id}`] ??= []).push(s);
      // slow strategies first so the tail of the run isn't one long job
      const slow = s => s === 'M' || s === 'DT';
      const jobs = Object.values(groups).sort((a, b) => slow(b[0].strategy) - slow(a[0].strategy)).map(g => ({ cmd:'score', snaps:g }));
      await runJobs(jobs, rows => append(out, rows));
      console.error(`\nscores → ${out}`);
      console.log(report(fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse)));
    } else if (mode === 'report') {
      console.log(report(fs.readFileSync(arg('in', 'results/enchant/scores.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)));
      fs.writeFileSync('results/enchant/ranking.json', JSON.stringify(RANKING, null, 1));
    } else {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 21).join('\n'));
    }
  })();
}
