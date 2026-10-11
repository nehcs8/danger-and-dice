#!/usr/bin/env node
// What does it take to beat the dragon? Uses the bot's own fight model (BotAI._debug.simFight,
// which mirrors combat.js) on real Player objects, so gear/enchant/guild-level rules are the engine's.
//
// Usage: node dragon_analysis.js [sims=3000]
'use strict';
const { makeSandbox, get } = require('./lib_sb.js');
const sb = makeSandbox('js/engine/bot_v2.js', [], 12345);
const Player = get(sb, 'Player'), getItem = get(sb, 'getItem'), MOBS = get(sb, 'MOBS'), ENCH = get(sb, 'ENCHANTMENTS');
const dbg = get(sb, 'BotAI')._debug;
const N = +(process.argv[2] ?? 3000);
const DRAGON = MOBS.getMob('dragon');

// ── builds ──────────────────────────────────────────────────────────────────
// Base stats ≈ median end-of-game base stats of dragon killers in the tournament.
const BASE = { main: 8, A: 7, V: 7, C: 5, other: 4 };
const BUILDS = {
  F:  { main:'F', weapon:'halberd',   wench:'sharpness' },
  D:  { main:'D', weapon:'arquebus',  wench:'precision' },
  G:  { main:'F', weapon:'garrote',   wench:'sharpness', guildLv:6 },
  BP: { main:'D', weapon:'blowpipe',  wench:'precision', guildLv:6 },
  M:  { main:'M', weapon:'grimoire',  wench:null },
  DT: { main:'M', weapon:'dark_tome', wench:null, guildLv:6 },
};
const GEAR = ['wench','armor','arcane','shield','shieldRes','pegasus','accordion'];
const FULL = Object.fromEntries(GEAR.map(g => [g, true]));
const PRICE = { wench: 60, armor: 40, arcane: 50, shield: 30, shieldRes: 50, pegasus: 60, accordion: 60, skill: 50 };
const KIT = ['sp_curse','sp_smoke','pot_heal','pot_main3','pot_A3','pot_V6','pot_C3'];
const SPELLS = ['bang','fireball','freeze','bolt','blaze'];

function makePlayer(bk, { gear = FULL, kit = {}, plus = {} } = {}) {
  const b = BUILDS[bk], p = new Player({ id: 'x', name: 'X' });
  for (const s of ['F','D','A','M','C','V']) p.baseStats[s] = BASE.other;
  p.baseStats[b.main] = BASE.main; p.baseStats.A = BASE.A; p.baseStats.V = BASE.V; p.baseStats.C = BASE.C;
  for (const [s, v] of Object.entries(plus)) p.baseStats[s] += v;
  const wear = (id, ench) => { p.addItem(id); p.equip(getItem(id)); if (ench) p.applyEnchantment(getItem(id).slot, ENCH.find(e => e.id === ench), 1); };
  wear(b.weapon, gear.wench && b.wench);
  if (b.guildLv) p.guildItemLevels[b.weapon] = { itemLevel: b.guildLv, levelProgress: { mbUnits: 0, secondaryUnits: 0 } };
  if (gear.armor) wear('hv_armor', gear.arcane && 'arcane');
  if (gear.shield) wear('lg_shield', gear.shieldRes && 'resistance');
  if (gear.pegasus) wear('pegasus');
  if (gear.accordion) wear('accordion');
  for (const [id, n] of Object.entries(kit)) for (let i = 0; i < n; i++) p.addItem(id === 'pot_main3' ? `pot_${b.main}3` : id);
  return p;
}
function winP(p, n = N) { const s = dbg.snapshot(p, { usePots: true }); s.hearts = s.maxHearts; return dbg.simFight(s, DRAGON, n).winP; }
const kitCost = kit => Object.entries(kit).reduce((a, [id, n]) => a + n * getItem(id === 'pot_main3' ? 'pot_F3' : id).buyPrice, 0);
const gearCost = (gear, plus = {}) => GEAR.reduce((a, g) => a + (gear[g] ? PRICE[g] : 0), 0) + Object.values(plus).reduce((a, v) => a + v * PRICE.skill, 0);
const pc = x => (100 * x).toFixed(0).padStart(3) + '%';
const eff = p => ['F','D','A','M','C','V'].map(s => s + p.getStat(s)).join(' ');
const out = [];
const say = s => { out.push(s); console.log(s); };

// For magic builds the "kit" also needs spells to attack at all; give a fixed spell set.
const BASE_KIT = bk => BUILDS[bk].main === 'M' ? { bolt: 4, freeze: 4, blaze: 4 } : {};
const withBase = (bk, kit) => { const k = { ...BASE_KIT(bk) }; for (const [id, n] of Object.entries(kit)) k[id] = (k[id] ?? 0) + n; return k; };
const STD_KIT = { sp_curse: 10, pot_heal: 3 };

say(`# Dragon requirements (bot fight model, ${N} sims per cell)`);
say(`Dragon: all stats ${DRAGON.stats.F}, ${DRAGON.hearts.max} hearts. Reference base stats: main ${BASE.main}, A ${BASE.A}, V ${BASE.V}, C ${BASE.C}, others ${BASE.other}. Guild weapons at level 6.`);
say(`Magic builds always carry 4 Bolt + 4 Freeze + 4 Blaze (needed to attack at all); "kit" below is on top of that.\n`);

// ── A. Reference builds ─────────────────────────────────────────────────────
say(`## A. Fully geared reference (weapon+enchant, heavy armor+Arcane, large shield+Resistance, Pegasus, Accordion)\n`);
say(`| build | effective stats | no kit | 10 curses + 3 heals | 20 curses + 5 heals |`); say(`|---|---|---|---|---|`);
for (const bk of Object.keys(BUILDS)) {
  const p0 = makePlayer(bk, { kit: BASE_KIT(bk) });
  say(`| ${bk} | ${eff(p0)} | ${pc(winP(p0))} | ${pc(winP(makePlayer(bk, { kit: withBase(bk, STD_KIT) })))} | ${pc(winP(makePlayer(bk, { kit: withBase(bk, { sp_curse: 20, pot_heal: 5 }) })))} |`);
}

// ── B. Ablation: drop one piece of gear (with the standard kit) ─────────────
say(`\n## B. Value of each gear piece: win% lost when it is removed (with 10 curses + 3 heals)\n`);
say(`| build | full | ${GEAR.map(g => `−${g} (${PRICE[g]}c)`).join(' | ')} |`); say(`|---|---|${GEAR.map(() => '---').join('|')}|`);
for (const bk of Object.keys(BUILDS)) {
  const full = winP(makePlayer(bk, { kit: withBase(bk, STD_KIT) }));
  const cells = GEAR.map(g => {
    if (g === 'wench' && !BUILDS[bk].wench) return '-';
    const gear = { ...FULL, [g]: false };
    if (g === 'armor') gear.arcane = false;
    if (g === 'shield') gear.shieldRes = false;
    return (100 * (winP(makePlayer(bk, { gear, kit: withBase(bk, STD_KIT) })) - full)).toFixed(0);
  });
  say(`| ${bk} | ${pc(full)} | ${cells.join(' | ')} |`);
}
say(`(−armor also removes Arcane; −shield also removes its Resistance.)`);

// ── C. Marginal value of +1 base stat and of consumables ────────────────────
say(`\n## C. Marginal gain from the standard kit: +1 base stat (50c Master) and +2 of each consumable. Win-% points; per 100 coins in brackets\n`);
const cons = ['sp_curse','sp_smoke','pot_heal','pot_main3','pot_A3','pot_V6','pot_C3'];
say(`| build | base | +1 main | +1 A | +1 V | +1 C | +1 M | ${cons.map(c => `+2 ${c}`).join(' | ')} |`); say(`|---|---|${Array(5 + cons.length).fill('---').join('|')}|`);
for (const bk of Object.keys(BUILDS)) {
  const ref = winP(makePlayer(bk, { kit: withBase(bk, STD_KIT) }));
  const cell = (w, cost) => `${(100 * (w - ref)).toFixed(0)} (${(100 * (w - ref) / cost * 100).toFixed(0)})`;
  const main = BUILDS[bk].main;
  const stats = [main, 'A', 'V', 'C', 'M'].map(s => (s === 'M' && main === 'M') ? '-' : cell(winP(makePlayer(bk, { plus: { [s]: 1 }, kit: withBase(bk, STD_KIT) })), 50));
  const cs = cons.map(c => { const k = { ...STD_KIT }; k[c] = (k[c] ?? 0) + 2; return cell(winP(makePlayer(bk, { kit: withBase(bk, k) })), kitCost({ [c]: 2 })); });
  say(`| ${bk} | ${pc(ref)} | ${stats.join(' | ')} | ${cs.join(' | ')} |`);
}

// ── D. Main stat × curses grid (F build, full gear, 3 heals) ────────────────
say(`\n## D. F build: base F (rows) × curses (columns), full gear, 3 heals\n`);
const curseCols = [0, 5, 10, 15, 20, 30];
say(`| base F (eff F) | ${curseCols.map(c => `${c} curses`).join(' | ')} |`); say(`|---|${curseCols.map(() => '---').join('|')}|`);
for (const f of [4, 6, 8, 10, 12, 14]) {
  const row = curseCols.map(c => pc(winP(makePlayer('F', { plus: { F: f - BASE.main }, kit: { sp_curse: c, pot_heal: 3 } }), 1500)));
  say(`| ${f} (${makePlayer('F', { plus: { F: f - BASE.main } }).getStat('F')}) | ${row.join(' | ')} |`);
}

// ── E. Cheapest route to 85% ────────────────────────────────────────────────
// For every gear subset: greedy kit (best win% gain per coin, bundles of 2) until 85%; report total cost.
say(`\n## E. Cheapest way to reach 85%: every gear subset + greedy consumable kit (no extra stat points)\n`);
function greedyKit(bk, gear, target = 0.85, budget = 3000) {
  let kit = {}, w = winP(makePlayer(bk, { gear, kit: withBase(bk, kit) }), 600), spent = 0;
  while (w < target && spent < budget) {
    let best = null, bg = 0;
    for (const c of KIT) {
      if (c === 'sp_curse' && (kit[c] ?? 0) >= 30) continue;
      const k = { ...kit, [c]: (kit[c] ?? 0) + 2 };
      const g = (winP(makePlayer(bk, { gear, kit: withBase(bk, k) }), 600) - w) / kitCost({ [c]: 2 });
      if (g > bg) { bg = g; best = k; }
    }
    if (!best) break;
    kit = best; spent = kitCost(kit); w = winP(makePlayer(bk, { gear, kit: withBase(bk, kit) }), 600);
  }
  return { kit, kitCost: spent, w };
}
for (const bk of Object.keys(BUILDS)) {
  const rows = [];
  const opt = GEAR.filter(g => !(g === 'wench' && !BUILDS[bk].wench));
  for (let mask = 0; mask < 1 << opt.length; mask++) {
    const gear = Object.fromEntries(opt.map((g, i) => [g, !!(mask & (1 << i))]));
    if (gear.arcane && !gear.armor) continue;
    if (gear.shieldRes && !gear.shield) continue;
    const r = greedyKit(bk, gear);
    if (r.w < 0.85) continue;
    rows.push({ gear, total: gearCost(gear) + r.kitCost, gc: gearCost(gear), ...r });
  }
  rows.sort((a, b) => a.total - b.total);
  say(`**${bk}** — reference (all gear + greedy kit): ${(() => { const r = rows.find(x => opt.every(g => x.gear[g])); return r ? `${r.total}c` : 'unreachable'; })()}`);
  for (const r of rows.slice(0, 4)) {
    const has = opt.filter(g => r.gear[g]).join('+') || 'weapon only';
    say(`- ${r.total}c = gear ${r.gc}c [${has}] + kit ${r.kitCost}c {${Object.entries(r.kit).map(([k, v]) => `${k}×${v}`).join(', ')}} → ${pc(r.w)}`);
  }
  if (!rows.length) say(`- no gear subset reaches 85% within a 3000c kit`);
}
require('fs').writeFileSync('results/dragon_analysis.md', out.join('\n') + '\n');
console.log('\nwritten to results/dragon_analysis.md');
