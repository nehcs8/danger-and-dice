#!/usr/bin/env node
// Runs games with the v2 bot, triggering bots exactly like main.js does.
// Usage: node sim_v2.js [games=5] [bots=1] [verbose=0] [strategy=auto|F|D|M]
'use strict';
const { makeSandbox, get } = require('./lib_sb.js');

function runGame(numBots = 1, verbose = false, maxTurns = 400, strategy = 'auto') {
  const sb = makeSandbox('js/engine/bot_v2.js');
  const Game = get(sb, 'Game'), BotAI = get(sb, 'BotAI'), KB = get(sb, 'KingBattle'), Ph = Game.Phase;
  // strategy: 'auto' | 'G' | ... or a comma list, one per bot (e.g. 'G,M,D,F')
  const strats = String(strategy).split(',');
  if (strats.length === 1) BotAI.configure({ strategy });
  const players = Array.from({ length: numBots }, (_, i) => ({ id:`p${i}`, name:`Bot${i+1}`, isBot:true }));
  const queue = [], log = [], timeline = [];
  let result = null, turns = 0, lastGoal = {};
  const cur = () => Game.getCurrentPlayer();
  const kick = () => { const p = cur(); if (p?.isBot) queue.push(() => BotAI.takeTurn(p)); };

  Game.on('state_change', d => {
    if (result) return;
    const st = Game.getState();
    if (d.phase === Ph.SETUP_ROLL) { if (st.players[st.setupRollIdx]?.isBot) queue.push(() => Game.submitAction({ type:'setup_roll' })); return; }
    if (d.phase === Ph.GAME_OVER) return;
    if (d.phase === Ph.KING_BATTLE) { queue.push(() => KB.resolveWin()); return; }
    if (d.phase === Ph.LOOT_CONFIRM) { if (cur()?.isBot) queue.push(() => Game.submitAction({ type:'loot_confirm' })); return; }
    if (d.phase === Ph.ROLL_MOVE) {
      turns++;
      const p = cur();
      const g = BotAI.getPhase(p);
      if (verbose && g !== lastGoal[p.id]) {
        const eq = Object.values(p.equipped).filter(Boolean).map(i => i.id + (i.enchantment ? `[${i.enchantment.id}]` : '')).join(',');
        timeline.push(`T${String(turns).padStart(3)} ${p.name} H${p.hearts.current}/${p.hearts.max} $${String(p.coins).padStart(4)} F${p.getStat('F')} D${p.getStat('D')} A${p.getStat('A')} V${p.getStat('V')} C${p.getStat('C')} goal=${g} [${eq}]`);
        lastGoal[p.id] = g;
      }
    }
    kick();
  });
  Game.on('combat_update', d => { if (!result && (d.outcome === 'ongoing' || d.outcome === 'charisma_pending')) kick(); });
  // PvP: both participants act — the bot handles every waiting bot participant in pvpTick()
  Game.on('pvp_update', d => { if (!result && d.outcome === 'ongoing') queue.push(() => BotAI.pvpTick()); });
  const pvpEvents = [];
  Game.on('pvp_update', d => { if (d.outcome !== 'ongoing') pvpEvents.push(`T${turns} PvP ${d.outcome}: ${d.players.map(x => x.name + ' ' + x.hearts.current + 'hp').join(' vs ')} ${d.winner ? '-> winner ' + d.winner : ''}${d.escaped ? '-> escaped ' + d.escaped : ''} (round ${d.round})`); });
  Game.on('dragon_defeated', () => pvpEvents.push(`T${turns} dragon slain by ${Game.getCurrentPlayer().name}`));
  Game.on('princess_picked_up', d => pvpEvents.push(`T${turns} princess picked up by ${d.player}`));
  Game.on('log', d => { const msg = d.message ?? ''; if (/teleports|turns invisible|escapes from|chains /.test(msg)) pvpEvents.push(`T${turns} ${msg}`); });
  Game.on('state_change', d => { if (d.phase === Ph.ROLL_MOVE && Game.getState().pvpActive) { const p = Game.getCurrentPlayer(); pvpEvents.push(`T${turns}   ${p.name} [${BotAI.getPhase(p)}] H${p.hearts.current} at (${p.position.x},${p.position.y}) tele=${p.inventory.filter(x=>x==='sp_teleport').length} inv=${p.inventory.filter(x=>x==='sp_invisibility').length} chain=${p.inventory.filter(x=>x==='chain').length}`); } });
  const inShop = () => { const ph = Game.getState().phase; return ph === Ph.SHOP || ph === Ph.MASTER; };
  Game.on('shop_transaction', () => { if (!result && inShop()) kick(); });
  Game.on('item_equipped',    () => { if (!result && inShop()) kick(); });
  Game.on('item_unequipped',  () => { if (!result && inShop()) kick(); });
  Game.on('skill_upgraded',   () => { if (!result) kick(); });
  Game.on('enchanted',        () => { if (!result) kick(); });
  Game.on('log', d => { const msg = d.message ?? ''; log.push(`[T${turns}] ${msg}`); if (log.length > 60) log.shift();
    if (verbose && /defeated by|Dragon|Princess|picks up|buys|enchants|upgrades|escapes|wins!|equips/i.test(msg) && !/wins with pure/.test(msg)) timeline.push(`        ${msg}`); });
  Game.on('game_over', d => { result = d; });

  Game.init(players, 'medium');
  if (strats.length > 1) Game.getState().players.forEach((p, i) => { p.botStrategy = strats[i % strats.length]; });
  let steps = 0;
  while (!result && queue.length && turns < maxTurns && steps < 400000) {
    steps++;
    const fn = queue.shift();
    try { fn(); } catch (e) { result = { winner:null, err:e.stack }; }
  }
  const st = Game.getState();
  const p0 = st.players[0];
  return {
    winner: result?.winner ?? null, err: result?.err, turns,
    stalled: !result && queue.length === 0, phase: st.phase,
    alive: st.players.filter(p => p.isAlive).length,
    goal: BotAI.getPhase(p0), coins: p0.coins, hearts: p0.hearts.current,
    timeline, lastLog: log.slice(-15), pvpEvents,
    winnerStrategy: result?.winner ? BotAI.getPhase(st.players.find(p => p.name === result.winner)).match(/\[(\w+)\]/)?.[1] : null,
    dragonP: BotAI._debug.mem[p0.id]?.lastDragonP,
  };
}

if (require.main === module) {
  const N = +(process.argv[2] ?? 5), B = +(process.argv[3] ?? 1), V = +(process.argv[4] ?? 0), S = process.argv[5] ?? 'auto';
  let wins = 0; const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = runGame(B, !!V, 400 * B, S);
    if (r.winner) wins++;
    console.log(`Game ${i+1}: ${r.winner ? 'WIN ' + r.winner + (r.winnerStrategy ? ' [' + r.winnerStrategy + ']' : '') :  r.err ? 'ERROR' : r.stalled ? 'STALL' : r.alive ? 'TIMEOUT' : 'ALL DEAD'}  turns=${r.turns}  goal=${r.goal} $${r.coins} H${r.hearts} dragonP=${r.dragonP?.toFixed?.(2)}`);
    if (r.err) console.log(r.err);
    if (B > 1 && r.pvpEvents.length) console.log('   ' + r.pvpEvents.join('\n   '));
    if (V) console.log(r.timeline.join('\n'));
    if (V > 1 || (!r.winner && (r.stalled || r.err))) console.log('  last log:\n   ' + r.lastLog.join('\n   '));
  }
  console.log(`\n${wins}/${N} wins  (${((Date.now()-t0)/1000).toFixed(1)}s)`);
}
module.exports = { runGame };
