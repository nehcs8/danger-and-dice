// Batch solo-race evaluation: node bot_dev/evalbatch.js <botFile> <seeds> <workers> '<json array of genomes>' [--out file.jsonl] [--resume] [--seed-offset k]
//                             node bot_dev/evalbatch.js --report file.jsonl        (table from a finished or partial run)
// genome = { base, tune }. Same seeds for every genome (common random numbers).
// Every finished game is appended to the --out file (default bot_dev/evalbatch.jsonl) right away, so a
// partial run can be reported at any time and --resume skips the games already in the file.
const fs = require('fs');
const { fork } = require('child_process');
const ROOT = require('path').resolve(__dirname, '..');
const lab = g => g.label ?? (g.base + (Object.keys(g.tune ?? {}).length ? ' ' + JSON.stringify(g.tune) : ''));
const gkey = g => JSON.stringify([g.base, g.tune ?? {}, g.label ?? null]);

function report(rows, genomes) {
  const order = genomes ?? [];
  for (const r of rows) if (!order.some(g => gkey(g) === gkey(r.genome))) order.push(r.genome);
  for (const g of order) {
    const rs = rows.filter(r => gkey(r.genome) === gkey(g)).map(r => r.r);
    const n = rs.length;
    if (!n) { console.log(`${lab(g).padEnd(60)} (no games yet)`); continue; }
    const sc = rs.map(r => r.score).sort((a, b) => a - b);
    const won = rs.filter(r => r.outcome === 'dragon').map(r => r.turns).sort((a, b) => a - b);
    console.log(`${lab(g).padEnd(60)} mean ${(sc.reduce((a, b) => a + b, 0) / n).toFixed(1).padStart(6)}  median ${String(sc[n >> 1]).padStart(4)}  kill-median ${String(won[won.length >> 1] ?? '-').padStart(4)}  deaths ${rs.filter(r => r.outcome === 'dead').length}/${n}  timeouts ${rs.filter(r => r.outcome !== 'dragon' && r.outcome !== 'dead').length}`);
  }
}
const readRows = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

// Not '--worker': strategy_search.js registers its own message handler when it sees that flag,
// and every game would be played twice.
if (process.argv[2] === '--evalworker') {
  process.chdir(ROOT);
  const { runSolo, DEFAULTS } = require(ROOT + '/strategy_search.js');
  // send every explicitly given tune value to the bot (toBot drops values equal to its DEFAULTS,
  // which would let profile tunes override e.g. an explicit farmWin:0.97)
  for (const k of Object.keys(DEFAULTS)) DEFAULTS[k] = undefined;
  process.on('message', t => {
    if (!t) process.exit(0);
    let r; try { r = runSolo(t.genome, t.seed); } catch (e) { r = { outcome: 'error', score: 250, err: e.message }; }
    process.send({ i: t.i, r });
  });
} else if (process.argv[2] === '--report') {
  report(readRows(process.argv[3]));
} else {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
  const out = opt('--out') ?? ROOT + '/bot_dev/evalbatch.jsonl', resume = flag('--resume');
  const seedOffset = +(opt('--seed-offset') ?? 0);   // fresh seeds, e.g. to validate a pick made on the default ones
  const [botFile, nSeeds, nW, gjson] = args;
  const genomes = JSON.parse(gjson);
  if (!resume && fs.existsSync(out)) fs.renameSync(out, out + '.prev');
  const have = new Set(readRows(out).map(r => gkey(r.genome) + '#' + r.seed));
  const tasks = [];
  genomes.forEach(g => { for (let k = seedOffset; k < seedOffset + +nSeeds; k++) { const seed = 5000017 + k * 7919;
    if (!have.has(gkey(g) + '#' + seed)) tasks.push({ i: tasks.length, genome: g, seed }); } });
  if (have.size) process.stderr.write(`resume: ${have.size} games already in ${out}, ${tasks.length} to go\n`);
  let next = 0, done = 0;
  const t0 = Date.now();
  // Each game builds a fresh vm sandbox and a long-lived worker doesn't give the memory back
  // (2–3 GB per worker after ~250 games): recycle workers every RECYCLE games, cap the heap.
  const RECYCLE = 20;
  let live = 0;
  const finish = () => { report(readRows(out), genomes); console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`); };
  const spawn = () => {
    const w = fork(__filename, ['--evalworker'], { env: { ...process.env, BOT_FILE: botFile }, cwd: ROOT, execArgv: ['--max-old-space-size=1024'] });
    live++; let n = 0;
    const feed = () => { if (next < tasks.length && n++ < RECYCLE) w.send(tasks[next++]); else w.send(null); };
    w.on('message', m => {
      const t = tasks[m.i];
      fs.appendFileSync(out, JSON.stringify({ genome: t.genome, seed: t.seed, r: m.r }) + '\n');
      done++; feed();
      if (done % 50 === 0 || done === tasks.length) {               // progress + ETA on stderr (stdout stays the report)
        const s = (Date.now() - t0) / 1000;
        process.stderr.write(`${done}/${tasks.length}  ${s.toFixed(0)}s  ETA ${((tasks.length - done) * s / done / 60).toFixed(1)} min\n`);
      }
    });
    w.on('exit', () => { live--; if (next < tasks.length) spawn(); else if (live === 0) finish(); });
    feed();
  };
  if (!tasks.length) finish();
  else for (let k = 0; k < Math.min(+nW, tasks.length); k++) spawn();
}
