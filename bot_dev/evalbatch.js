// Batch solo-race evaluation: node bot_dev/evalbatch.js <botFile> <seeds> <workers> '<json array of genomes>'
// genome = { base, tune }. Same seeds for every genome (common random numbers).
const { fork } = require('child_process');
const ROOT = require('path').resolve(__dirname, '..');
if (process.argv[2] === '--worker') {
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
} else {
  const [botFile, nSeeds, nW, gjson] = process.argv.slice(2);
  const genomes = JSON.parse(gjson);
  const tasks = [];
  genomes.forEach((g, gi) => { for (let k = 0; k < +nSeeds; k++) tasks.push({ i: tasks.length, gi, genome: g, seed: 5000017 + k * 7919 }); });
  const res = new Array(tasks.length);
  let next = 0, done = 0;
  const t0 = Date.now();
  // Each game builds a fresh vm sandbox and a long-lived worker doesn't give the memory back
  // (2–3 GB per worker after ~250 games): recycle workers every RECYCLE games, cap the heap.
  const RECYCLE = 20;
  let live = 0;
  const spawn = () => {
    const w = fork(__filename, ['--worker'], { env: { ...process.env, BOT_FILE: botFile }, cwd: ROOT, execArgv: ['--max-old-space-size=1024'] });
    live++; let n = 0;
    const feed = () => { if (next < tasks.length && n++ < RECYCLE) w.send(tasks[next++]); else w.send(null); };
    w.on('message', m => { res[m.i] = m.r; done++; feed(); });
    w.on('exit', () => { live--; if (next < tasks.length) spawn(); else if (live === 0) finish(); });
    feed();
  };
  for (let k = 0; k < +nW; k++) spawn();
  function finish() {
    const lab = g => g.label ?? (g.base + (Object.keys(g.tune ?? {}).length ? ' ' + JSON.stringify(g.tune) : ''));
    genomes.forEach((g, gi) => {
      const rs = tasks.filter(t => t.gi === gi).map(t => res[t.i]);
      const sc = rs.map(r => r.score).sort((a, b) => a - b), n = sc.length;
      const won = rs.filter(r => r.outcome === 'dragon').map(r => r.turns).sort((a, b) => a - b);
      console.log(`${lab(g).padEnd(60)} mean ${(sc.reduce((a, b) => a + b, 0) / n).toFixed(1).padStart(6)}  median ${String(sc[n >> 1]).padStart(4)}  kill-median ${String(won[won.length >> 1] ?? '-').padStart(4)}  deaths ${rs.filter(r => r.outcome === 'dead').length}/${n}  timeouts ${rs.filter(r => r.outcome !== 'dragon' && r.outcome !== 'dead').length}`);
    });
    console.log(`(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
