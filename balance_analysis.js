#!/usr/bin/env node
// Balance what-ifs for the dragon: dragon stat level × build × gear (incl. boss drops), the normal
// bosses as a stepping stone, Beastmaster (savage friend + heals) for several savage ceilings,
// and the Charisma instant-kill threshold. Fight math is the engine's / the bot's fight model.
//
// Usage: node balance_analysis.js [sims=2000]
'use strict';
const { makeSandbox, get } = require('./lib_sb.js');
const sb = makeSandbox('js/engine/bot_v2.js', [], 777);
const Player = get(sb, 'Player'), getItem = get(sb, 'getItem'), MOBS = get(sb, 'MOBS'), ENCH = get(sb, 'ENCHANTMENTS');
const Combat = get(sb, 'Combat'), dbg = get(sb, 'BotAI')._debug;
const N = +(process.argv[2] ?? 2000);
const out = []; const say = s => { out.push(s); console.log(s); };
const pc = x => (100 * x).toFixed(0).padStart(3) + '%';

const dragonAt = v => { const d = MOBS.getMob('dragon'); return { ...d, stats: Object.fromEntries(Object.keys(d.stats).map(k => [k, v])), hearts: { ...d.hearts } }; };
const DRAGON_LEVELS = [20, 22, 25];

// ── players ─────────────────────────────────────────────────────────────────
// Base stats ≈ dragon killers' end-of-game medians (main 8, A 7, V 7, C 5, others 4).
const GEARSETS = {
  shop:     { label: 'shop only: T6 weapon+enchant, Heavy Armor+Arcane, Large Shield+Res, Pegasus, Accordion',
              F: 'halberd', D: 'arquebus', armor: 'hv_armor', shield: 'lg_shield' },
  serpent:  { label: 'Sea Serpent: Draconic Sword F8 / Divine Lance D8 + 5 Dragon Blood (2F2M2V)',
              F: 'draconic_sword', D: 'divine_lance', armor: 'hv_armor', shield: 'lg_shield', kit: { dragon_blood: 5 } },
  sorc:     { label: 'Grand Sorcerer: Arcane Armor A8 (replaces Heavy Armor, no V malus) + shop weapon',
              F: 'halberd', D: 'arquebus', armor: 'arcane_armor', shield: 'lg_shield' },
  serp_sorc:{ label: 'Sea Serpent + Grand Sorcerer', F: 'draconic_sword', D: 'divine_lance', armor: 'arcane_armor', shield: 'lg_shield', kit: { dragon_blood: 5 } },
  king:     { label: 'King (King battle): Legendary Sword F10 + Royal Crown A10; D uses Prince\'s Legendary Bow D10',
              F: 'legendary_sword', D: 'legendary_bow', armor: 'royal_crown', shield: 'lg_shield' },
};
function makePlayer(main, gs, kit = {}) {
  const p = new Player({ id: 'x', name: 'X' });
  Object.assign(p.baseStats, { F: 4, D: 4, A: 7, M: 4, C: 5, V: 7 }); p.baseStats[main] = 8;
  const wear = (id, ench) => { p.addItem(id); p.equip(getItem(id)); if (ench) p.applyEnchantment(getItem(id).slot, ENCH.find(e => e.id === ench), 1); };
  const g = GEARSETS[gs];
  wear(g[main], main === 'F' ? 'sharpness' : 'precision');
  wear(g.armor, 'arcane'); wear(g.shield, 'resistance'); wear('pegasus'); wear('accordion');
  for (const [id, n] of Object.entries({ ...(g.kit ?? {}), ...kit })) for (let i = 0; i < n; i++) p.addItem(id);
  return p;
}
function winP(p, mob, n = N) { const s = dbg.snapshot(p, { usePots: true }); s.hearts = s.maxHearts; return dbg.simFight(s, mob, n).winP; }
const KITS = { none: {}, std: { sp_curse: 10, pot_heal: 3 }, big: { sp_curse: 20, pot_heal: 5 } };

say(`# Dragon balance what-ifs (${N} sims per cell)\n`);
say(`Player base stats: main 8, A 7, V 7, C 5, others 4 (median of dragon killers). Kits: std = 10 curses + 3 heals, big = 20 curses + 5 heals.\n`);

// ── 1. normal builds vs dragon level ────────────────────────────────────────
say(`## 1. F / D builds vs dragon (all stats = level, 12 hearts)\n`);
say(`| build | gear | eff. stats | ${DRAGON_LEVELS.map(l => `D${l} std | D${l} big`).join(' | ')} |`);
say(`|---|---|---|${DRAGON_LEVELS.map(() => '---|---').join('|')}|`);
for (const main of ['F', 'D']) for (const gs of Object.keys(GEARSETS)) {
  const p0 = makePlayer(main, gs);
  const cells = DRAGON_LEVELS.flatMap(l => ['std', 'big'].map(k => pc(winP(makePlayer(main, gs, KITS[k]), dragonAt(l)))));
  say(`| ${main} | ${gs} | ${['F','D','A','M','C','V'].map(s => s + p0.getStat(s)).join(' ')} | ${cells.join(' | ')} |`);
}
say(`\nGear sets: ${Object.entries(GEARSETS).map(([k, g]) => `**${k}** = ${g.label}`).join('; ')}.`);

// ── 2. normal bosses with shop gear ─────────────────────────────────────────
say(`\n## 2. Normal bosses as a stepping stone (shop gear)\n`);
const BOSSES = ['witch', 'sea_serpent', 'prince', 'phoenix', 'grand_sorcerer'];   // map bosses (King is the tactical King battle)
say(`| boss | stats | hearts | drops | F std | F big | D std | D big |`); say(`|---|---|---|---|---|---|---|---|`);
for (const id of BOSSES) {
  const b = MOBS.getMob(id);
  const cells = ['F', 'D'].flatMap(main => ['std', 'big'].map(k => pc(winP(makePlayer(main, 'shop', KITS[k]), b))));
  say(`| ${id} | ${Object.entries(b.stats).map(([k, v]) => k + v).join(' ')} | ${b.hearts.max} | ${(b.lootTable ?? []).map(e => e.itemId).filter(Boolean).join(', ')} | ${cells.join(' | ')} |`);
}

// ── 3. Beastmaster ──────────────────────────────────────────────────────────
// Real Combat.resolveFriendRound; heal the friend whenever it is at 1 heart.
say(`\n## 3. Beastmaster: one savage friend + N heal potions (heal at 1 heart)\n`);
function friendFight(dom, species, dragonLv, heals, trials = 6000) {
  const t = MOBS.getMob(`${species}_savage`);
  const domSet = new Set(Object.entries(t.stats).filter(([, v]) => v === Math.max(...Object.values(t.stats))).map(([k]) => k));
  let w = 0;
  for (let i = 0; i < trials; i++) {
    const d = { ...dragonAt(dragonLv), hearts: { current: 12, max: 12 }, statusEffects: [] };
    const f = { id: t.id, name: t.name, stats: Object.fromEntries(Object.entries(t.stats).map(([k, v]) => [k, domSet.has(k) ? dom : v])), hearts: { current: 2, max: 2 }, statusEffects: [] };
    const p = new Player({ id: 'x', name: 'X' });
    let used = 0;
    for (let r = 0; r < 300; r++) {
      const res = Combat.resolveFriendRound(f, d, p, []);
      if (res.outcome === 'victory') { w++; break; }
      if (res.outcome === 'friend_died') break;
      if (f.hearts.current === 1 && used < heals) { f.hearts.current = 2; used++; }
    }
  }
  return w / trials;
}
const DOMS = [32, 28, 26, 24], HEALS = [6, 10, 14, 20];
for (const species of ['gorilla', 'chimera']) {
  say(`**${species}** (${species === 'gorilla' ? 'F+C dominant' : 'F+D+M+C dominant'}), win% by savage dominant stat (rows) and heals (columns):\n`);
  say(`| savage dom | ${DRAGON_LEVELS.flatMap(l => HEALS.map(h => `D${l} ${h}h`)).join(' | ')} |`); say(`|---|${DRAGON_LEVELS.flatMap(() => HEALS.map(() => '---')).join('|')}|`);
  for (const dom of DOMS) say(`| ${dom} | ${DRAGON_LEVELS.flatMap(l => HEALS.map(h => pc(friendFight(dom, species, l, h)))).join(' | ')} |`);
  say('');
}

// ── 4. Charisma instant kill ────────────────────────────────────────────────
say(`## 4. Charisma instant kill (Cursed Rattle, margin ≥ 7): C + d6 ≥ dragon C + 7\n`);
say(`| dragon C | C needed for 50% per roll | C needed for 100% |`); say(`|---|---|---|`);
for (const l of DRAGON_LEVELS) say(`| ${l} | ${l + 7 - 4} (d6 ≥ 4) | ${l + 7 - 1} (any d6) |`);
say(`\n"C" here is everything added to the roll: effective C + one temporary C bonus (potion/alcohol, max +6) + priest blessing (max +6) + Troll Tooth (+3).`);

require('fs').mkdirSync('results', { recursive: true });
require('fs').writeFileSync('results/balance_analysis.md', out.join('\n') + '\n');
console.log('\nwritten to results/balance_analysis.md');
