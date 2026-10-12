// Deeper per-strategy analysis of one or more tournament dirs (games.jsonl).
const fs = require('fs'), path = require('path');
const dirs = process.argv.slice(2);
const games = dirs.flatMap(d => fs.readFileSync(path.join(d, 'games.jsonl'), 'utf8').split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }));
const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pc = (a, b) => b ? (100 * a / b).toFixed(1) : '-';
const wilson = (w, n) => { if (!n) return '-'; const z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${(100 * (c - h)).toFixed(0)}–${(100 * (c + h)).toFixed(0)}`; };
const ownAt = (b, t) => b.series.filter(r => r[0] <= t).length;   // own turns played up to game turn t

const S = {};
const outcomes = {};
for (const g of games) {
  outcomes[g.outcome] = (outcomes[g.outcome] ?? 0) + 1;
  for (const b of g.bots) {
    const s = (S[b.strategy] ??= { n: 0, w: 0, dk: 0, dkWin: 0, winNoDk: 0, preDeath: 0, pvpDeath: 0, timeouts: 0, ownDk: [], ownWin: [], ownReady: [], dkLost: {}, preDeathBy: {}, stuck: 0, fallback: 0, finalDP: [] });
    s.n++;
    const won = g.winner === b.name, dk = b.milestones.dragonKill != null;
    if (won) { s.w++; s.ownWin.push(b.ownTurns); }
    if (dk) { s.dk++; s.ownDk.push(ownAt(b, b.milestones.dragonKill)); if (won) s.dkWin++; else { const k = g.winnerStrategy ? (g.bots.find(x => x.name === g.winner)?.strategy === b.strategy ? 'same' : 'stolen') : g.outcome; s.dkLost[k] = (s.dkLost[k] ?? 0) + 1; } }
    if (won && !dk) s.winNoDk++;
    if (b.milestones.dragonReady != null) s.ownReady.push(ownAt(b, b.milestones.dragonReady));
    if (b.death && !b.death.pvp && (g.dragonTurn == null || b.death.t <= g.dragonTurn)) { s.preDeath++; s.preDeathBy[b.death.by] = (s.preDeathBy[b.death.by] ?? 0) + 1; }
    if (b.death?.pvp) s.pvpDeath++;
    if (g.outcome === 'TIMEOUT' || g.outcome === 'STALL') s.timeouts++;
    if (g.dragonTurn == null && b.final.alive) s.stuck++;
    if (b.profileChanges.some(c => c.from != null)) s.fallback++;
    if (b.lastDragonP != null && !dk) s.finalDP.push(b.lastDragonP);
  }
}
const N = games.length;
console.log(`${N} games · ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
const dg = games.filter(g => g.dragonTurn != null);
console.log(`dragon killed in ${dg.length}; killer won ${pc(dg.filter(g => g.winner === g.dragonKiller).length, dg.length)}%; median game turns ${med(games.map(g => g.turns))}, dragon at ${med(dg.map(g => g.dragonTurn))}`);
console.log('\n| strat | n | win% | 95% CI | dragon-kill% | killer→win% | wins w/o kill | own turns to dragon (p25/med/p75) | own turns to win (med) | dP≥.85 own turn (med) | PvE deaths pre-dragon | PvP deaths | in timeouts | fallback |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [k, s] of Object.entries(S).sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)) {
  console.log(`| ${k} | ${s.n} | ${pc(s.w, s.n)} | ${wilson(s.w, s.n)} | ${pc(s.dk, s.n)} | ${pc(s.dkWin, s.dk)} | ${s.winNoDk} | ${q(s.ownDk, .25)}/${med(s.ownDk)}/${q(s.ownDk, .75)} | ${med(s.ownWin)} | ${med(s.ownReady)} | ${pc(s.preDeath, s.n)}% | ${pc(s.pvpDeath, s.n)}% | ${s.timeouts} | ${s.fallback} |`);
}
console.log('\nPre-dragon PvE killers:');
for (const [k, s] of Object.entries(S)) if (s.preDeath) console.log(`  ${k}: ${Object.entries(s.preDeathBy).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, v]) => `${m} ${v}`).join(', ')}`);
console.log('\nDragon killers who lost — who won instead:');
for (const [k, s] of Object.entries(S)) if (Object.keys(s.dkLost).length) console.log(`  ${k}: ${JSON.stringify(s.dkLost)}`);
console.log('\nFinal dragonP of bots that never killed the dragon (median):');
console.log('  ' + Object.entries(S).map(([k, s]) => `${k} ${med(s.finalDP)?.toFixed(2)}`).join(' · '));
// solo-ish strength: win% vs the field average, by seat count of opponents of same "family"
const timeouts = games.filter(g => g.outcome !== 'WIN');
const tl = {}; for (const g of timeouts) for (const s of g.lineup) tl[s] = (tl[s] ?? 0) + 1;
console.log('\nNon-win games by strategy present:', JSON.stringify(tl));
