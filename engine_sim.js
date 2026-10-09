// Runs encounters through the REAL engine code (player.js + combat.js + game.js) in a vm sandbox.
// Lives in the project root, next to sim_builds.js / benchmark_progression.js.
// Usage: node engine_sim.js [fightsPerMob]      (default 3000)
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = path.join(__dirname, 'js', 'engine');

const BUY = { bow:20, jacket:10, sword:20, lt_armor:20, horse:40, boots:20, staff:30, necklace:45,
  bang:10, longbow:30, knife:10, crossbow:40, axe:40, md_armor:30, mace:30, bomb:40, pistol:50,
  sp_teleport:20, orb:75, laceration:60, ring:60, blizzard:20, hv_armor:40, greatsword:50,
  grimoire:90, lightning:40, arquebus:60, carriage:50, halberd:60, pegasus:60 };
const getItem = id => {
  if (BUY[id] !== undefined) return { id, name: id, buyPrice: BUY[id] };
  const m = /^pot_([FDAMCV])(\d)$/.exec(id);
  if (m) return { id, name: id, buyPrice: (m[1] === 'V' ? 5 : 10) * +m[2] };
  return { id, name: id }; // blood drops: not sellable
};
const sellValue = id => Math.floor((getItem(id).buyPrice ?? 0) / 2);

const sandbox = { Math, Object, JSON, Set, Map, Array, Date, console,
  Dice: { d6: () => 1 + Math.floor(Math.random() * 6), d: n => 1 + Math.floor(Math.random() * n) },
  getItem, MOBS: { getMob: () => null, spawn: () => null, getByTier: () => [] },
  MapGrid: { HEIGHT: 0, WIDTH: 0, get: () => 0, getTileData: () => ({}) }, TileType: {},
  Movement: {}, KingBattle: {} };
vm.createContext(sandbox);
for (const f of ['player.js', 'combat.js', 'game.js'])
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
const Game = vm.runInContext('Game', sandbox), Player = vm.runInContext('Player', sandbox);

// Minibosses (same data as mobs.js)
const L = (...e) => e.map(x => typeof x === 'string' ? { itemId: x }
  : Array.isArray(x) ? { itemId: x[0], count: x[1] } : { rollForStat: true, potionValue: x.p, count: x.n ?? 1 });
const mob = (id, tier, F, A, M, C, D, V, h, loot, coins = 0, coinDice = 0) =>
  ({ id, name: id, tier, stats: { F, A, M, C, D, V }, hearts: h, loot, coins, coinDice });
const MOBS = [
  mob('Thief',0,7,7,4,7,7,8,2,L('bow','jacket'),0,3), mob('Guard',0,9,9,5,5,5,6,2,L('sword','lt_armor'),20),
  mob('Knight',0,8,9,8,6,6,8,2,L('horse','sword'),25), mob('Ranger',0,5,6,8,6,8,8,2,L('boots','staff',{p:1}),15),
  mob('Mage',0,6,8,9,9,4,6,2,L('necklace',['bang',3]),20), mob('Goblin',0,4,6,5,4,9,9,2,L('longbow','knife'),5),
  mob('Warrior',1,11,7,8,8,11,11,3,L('crossbow'),20,5), mob('Dwarf',1,8,12,9,9,11,8,3,L('axe','lt_armor'),30),
  mob('Monk',1,10,9,10,10,10,9,3,L('md_armor',['bang',3]),25), mob('Orc',1,12,12,8,8,7,10,3,L('mace','lt_armor',{p:1,n:3}),25),
  mob('Centaur',1,11,11,11,7,7,11,3,L('necklace',{p:1,n:3}),35), mob('Elf',1,7,8,11,10,11,12,3,L('necklace','longbow',['bomb',2]),30),
  mob('Assassin',2,9,12,12,9,15,15,4,L('pistol','sp_teleport'),40), mob('Vampire',2,10,10,14,12,14,15,4,L('vampire_blood','orb',{p:2,n:3}),50),
  mob('Werewolf',2,15,15,11,10,10,14,5,L('werewolf_blood',['laceration',2]),40), mob('GrCentaur',2,14,11,14,11,14,12,4,L('ring',['blizzard',2]),55),
  mob('Paladin',2,15,14,10,11,15,12,5,L('hv_armor','horse','axe'),55), mob('Draconian',2,16,13,16,10,10,10,5,L('dragon_blood','greatsword',{p:2,n:3}),50),
  mob('General',3,12,15,15,14,18,16,5,L('hv_armor','pistol','horse'),75), mob('Troll',3,17,15,12,15,17,14,6,L({p:3,n:3},'mace','ring'),60),
  mob('Wyvern',3,17,17,17,12,12,17,5,L('dragon_blood',['lightning',2]),70), mob('Demon',3,15,15,18,15,18,14,5,L('grimoire',['laceration',2]),60),
  mob('Hero',3,16,15,16,15,16,15,6,L('arquebus','greatsword','carriage'),75), mob('Giant',3,18,18,15,15,14,15,6,L('halberd','pegasus'),60,10),
];
const spawn = m => ({ id: m.id, name: m.name, tier: m.tier, stats: { ...m.stats },
  hearts: { current: m.hearts, max: m.hearts }, lootTable: m.loot, coins: m.coins, coinDice: m.coinDice, statusEffects: [] });

const STAGES = {
  early: { prim: 4, A: 3, V: 3, item: 2, armA: 1, armV: 0 },
  mid:   { prim: 5, A: 4, V: 4, item: 4, armA: 6, armV: -1 },
  late:  { prim: 6, A: 5, V: 5, item: 6, armA: 9, armV: -2 },
};
function makePlayer(prim, stage, primOverride) {
  const st = STAGES[stage];
  const p = new Player({ id: 'p', name: 'P' });
  p.baseStats = { F:2, D:2, A:st.A, M:2, C:2, V:st.V };
  p.baseStats[prim] = st.prim;
  const bonus = { [prim]: primOverride ?? st.item };
  p.equipped.strength = null;
  p.equipped[{F:'strength',D:'dexterity',M:'magic',C:'charisma'}[prim]] = { id: 'w', slot: 'x', statBonus: bonus };
  p.equipped.armor = { id: 'arm', slot: 'armor', statBonus: { A: st.armA, V: st.armV } };
  if (prim === 'M') for (let i = 0; i < 40; i++) p.inventory.push('flare'); // +2 spells
  return p;
}
sandbox.getItem = id => id === 'flare' ? { id, name: 'Flare', subtype: 'attack', magicValue: 2, buyPrice: 40 } : getItem(id);
vm.runInContext('getItem = this.getItem', sandbox);

function runEncounter(player, m, policy) {
  const st = Game.getState();
  st.players = [player]; st.currentIdx = 0;
  const xp0 = { ...player.xp }, base0 = { ...player.baseStats }, coins0 = player.coins, inv0 = player.inventory.length;
  const mobObj = spawn(m);
  const playerFirst = player.getStat('V') + sandbox.Dice.d6() > mobObj.stats.V;
  st.phase = 'combat';
  st.pendingCombat = { mob: mobObj, isBoss: false, onComplete: null, fightLog: [],
    combatSubPhase: playerFirst ? 'player_attack' : 'mob_attack', mobNextAttackType: null,
    deployedFriend: null, charismaResult: null, minibossTier: m.tier, combatHpDealt: 0,
    combatParries: 0, combatAbilityUnits: 0, fightAttackTypes: new Set(), curseUsedThisTurn: false };
  let outcome = null, guard = 0;
  while (st.pendingCombat && guard++ < 400) {
    const pc = st.pendingCombat, sub = pc.combatSubPhase;
    if (sub === 'player_attack') {
      if (player.baseStats.C >= 0 && policy !== 'attack') Game.submitAction({ type: 'bard' });
      else Game.submitAction({ type: 'attack', attackType: player._prim,
                               spellId: player._prim === 'M' ? 'flare' : undefined });
    } else if (sub === 'charisma_pick') {
      const d = pc.charismaResult.diff; const tier = d >= 7 ? 3 : d >= 5 ? 2 : 1;
      if (d < 3) { Game.submitAction({ type: 'charisma_outcome', retreat: true }); continue; }
      if (policy === 'gift') Game.submitAction({ type: 'charisma_outcome', family: 'friendly', tier: 1 });
      else if (policy === 'setup' && tier < 3) {
        if (tier === 1) {
          const ms = s => mobObj.stats[s] + mobObj.statusEffects.filter(e => e.stat === s).reduce((a, e) => a + e.value, 0);
          const low = ['F','D','A','M','V'].reduce((b, s) => ms(s) < ms(b) ? s : b, 'F');
          Game.submitAction({ type: 'charisma_outcome', family: 'mock', tier: 1, stat1: 'C', stat2: low });
        } else Game.submitAction({ type: 'charisma_outcome', family: 'mock', tier: 2, stat: 'C' });
      } else Game.submitAction({ type: 'charisma_outcome', family: 'deceive', tier });
    } else if (sub === 'mob_attack') {
      Game.submitAction({ type: 'defend' });
    } else break;
    if (!player.isAlive) { outcome = 'death'; break; }
  }
  if (!outcome) outcome = player.isAlive ? (mobObj.hearts.current <= 0 ? 'kill' : 'cha') : 'death';
  // primary-stat XP gained (including level-ups)
  const prim = player._prim;
  let xp = player.xp[prim] - xp0[prim];
  for (let lv = base0[prim]; lv < player.baseStats[prim]; lv++) xp += lv * 10;
  const items = player.inventory.slice(inv0).filter(id => id !== 'flare');
  return { outcome, xp, coins: player.coins - coins0, itemValue: items.reduce((s, id) => s + sellValue(id), 0),
           hpLost: 5 - player.hearts.current };
}

module.exports = { runEncounter, makePlayer, MOBS, Game };
if (require.main === module) {
const N = +process.argv[2] || 3000;
const out = {};
for (const stage of ['early', 'mid', 'late']) {
  const builds = [['F', 'attack'], ['D', 'attack'], ['M', 'attack'], ['C', 'cashout'], ['C', 'setup'], ['C', 'gift']];
  for (const [prim, policy] of builds) for (const tier of [0, 1, 2, 3]) {
    const agg = { n: 0, win: 0, death: 0, xp: 0, coins: 0, items: 0, hp: 0 };
    for (const m of MOBS.filter(x => x.tier === tier)) for (let i = 0; i < N; i++) {
      const p = makePlayer(prim, stage); p._prim = prim;
      const r = runEncounter(p, m, policy);
      agg.n++; if (r.outcome === 'death') agg.death++; else if (r.outcome !== 'escaped') agg.win++;
      agg.xp += r.xp; agg.coins += r.coins; agg.items += r.itemValue; agg.hp += r.hpLost;
    }
    const k = `${prim}-${policy}|${stage}|T${tier}`;
    out[k] = Object.fromEntries(Object.entries(agg).map(([a, v]) => [a, a === 'n' ? v : v / agg.n]));
  }
}
fs.writeFileSync(path.join(__dirname, 'engine_sim_results.json'), JSON.stringify(out, null, 1));
console.log('build        stage T  win%  death%  ❤lost  primXP  coins  items  total');
for (const [k, r] of Object.entries(out)) {
  const [b, st, t] = k.split('|');
  console.log(`${b.padEnd(12)} ${st.padEnd(5)} ${t}  ${(r.win*100).toFixed(0).padStart(3)}%  ${(r.death*100).toFixed(0).padStart(4)}%  ${r.hp.toFixed(2).padStart(5)}  ${r.xp.toFixed(1).padStart(5)}  ${r.coins.toFixed(0).padStart(5)}  ${r.items.toFixed(0).padStart(5)}  ${(r.coins+r.items).toFixed(0).padStart(5)}`);
}
}
