// Activity — follows what every player does, turn by turn, so a game with bots can be read
// without the raw log:
//   • records a structured summary of each player turn from engine events (path walked,
//     fights, loot, purchases, items used, coins/hearts change) plus the raw log lines;
//   • renders the turn-grouped log (filterable per player, expandable raw lines),
//     the players strip above the map with hover/pinned detail cards,
//     and the bot banner that replaces popups during bot turns;
//   • exposes each player's last-turn path for the map trail (Renderer).

const Activity = (() => {
  const MAX_TURNS = 400;
  const TILE_NAMES = {
    [1]: 'path', [2]: '? event', [3]: 'miniboss', [4]: 'chest', [5]: 'reroll', [6]: 'work', [7]: 'stop',
    [8]: 'back', [9]: 'priest', [10]: 'shop', [11]: 'Master', [12]: 'campfire', [13]: 'boss',
    [14]: 'Assassin Guild', [15]: 'Thief Guild', [16]: 'FINISH', [17]: 'start', [18]: 'bar', [19]: 'secret path',
  };
  const SLOT_ICONS = { strength:'⚔', dexterity:'🏹', magic:'✨', charisma:'🎵', speed:'👟', armor:'🛡', shield:'🔰' };
  const STAT_LABELS = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };

  const turns = [];            // turn records, oldest first
  let cur = null;              // record of the turn in progress
  let fight = null;            // fight in progress { mob, hearts0, result }
  const hidden = new Set();    // player ids filtered out of the log
  let pinned = null;           // player id whose card is pinned
  let dirty = false;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  const players = () => Game.getPlayers();
  const byName = name => players().find(p => p.name === name);
  const colorOf = p => Renderer.playerColor(players().indexOf(p));
  const itemName = id => getItem(id)?.name ?? id;

  // ── Recording ──────────────────────────────────────────────────────────────
  function beginTurn(p) {
    const st = Game.getState();
    cur = { key: `${st.turnNumber}|${p.id}`, turn: st.turnNumber, pid: p.id, name: p.name, isBot: p.isBot,
            goal: p.isBot && typeof BotAI !== 'undefined' ? BotAI.getPhase(p).replace(/^\[\w+\] /, '') : null,
            strategy: p.isBot && typeof BotAI !== 'undefined' ? BotAI.getStrategy?.(p) : null,
            start: { ...p.position }, segments: [], events: [], lines: [],
            coins0: p.coins, hearts0: p.hearts.current, coins1: p.coins, hearts1: p.hearts.current };
    turns.push(cur);
    if (turns.length > MAX_TURNS) turns.shift();
  }
  function ensureTurn() {
    const p = Game.getCurrentPlayer(); if (!p) return null;
    const key = `${Game.getState().turnNumber}|${p.id}`;
    if (!cur || cur.key !== key) beginTurn(p);
    return cur;
  }
  // Add an event to the turn; identical consecutive texts are merged into "×N".
  function add(icon, text, cls = '') {
    const r = ensureTurn(); if (!r) return;
    const last = r.events[r.events.length - 1];
    if (last && last.icon === icon && last.text === text) last.n++;
    else r.events.push({ icon, text, cls, n: 1 });
    touch();
  }
  function touch() {
    if (cur) { const p = players().find(q => q.id === cur.pid); if (p) { cur.coins1 = p.coins; cur.hearts1 = p.hearts.current; } }
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; render(); });
  }
  function closeFight(result) {
    if (!fight) return;
    const p = players().find(q => q.id === fight.pid);
    const lost = p ? fight.hearts0 - p.hearts.current : 0;
    const res = fight.result ?? result;
    const txt = { win: `beat ${fight.mob}`, loss: `killed by ${fight.mob}`, escaped: `escaped from ${fight.mob}`,
                  befriended: `befriended ${fight.mob}`, talked: `talked ${fight.mob} down` }[res] ?? `fought ${fight.mob}`;
    add(res === 'loss' ? '☠' : res === 'befriended' ? '🤝' : res === 'escaped' ? '🏃' : '⚔',
        txt + (lost > 0 ? ` (−${lost}❤)` : lost < 0 ? ` (+${-lost}❤)` : ''), res === 'loss' ? 'bad' : res === 'win' && fight.boss ? 'good' : '');
    fight = null;
  }

  // Call after Game.init (needs the players for the log filters).
  function init() {
    turns.length = 0; cur = null; fight = null; hidden.clear(); pinned = null;
    buildFilters();

    Game.on('state_change', d => {
      const st = Game.getState();
      if (d.phase === Game.Phase.SETUP_ROLL || d.phase === Game.Phase.GAME_OVER) { touch(); return; }
      ensureTurn();
      if (fight && d.phase !== Game.Phase.COMBAT) closeFight();
      if (d.phase === Game.Phase.COMBAT && !fight && st.pendingCombat?.mob) {
        const p = Game.getCurrentPlayer();
        fight = { pid: p.id, mob: st.pendingCombat.mob.name, boss: !!st.pendingCombat.isBoss, hearts0: p.hearts.current, result: null };
      }
      touch();
    });
    Game.on('player_moved', d => {
      const p = byName(d.player), r = ensureTurn(); if (!p || !r) return;
      const from = d.from ?? r.segments.at(-1)?.at(-1) ?? r.start;
      const seg = [from, ...(d.path ?? [d.position])];
      r.segments.push(seg);
      Renderer.draw();                         // the trail includes this move now
      const steps = d.path ? d.path.length : null;
      const tile = TILE_NAMES[MapGrid.get(d.position.x, d.position.y)] ?? 'tile';
      add('🚶', steps != null ? `${steps} tile${steps === 1 ? '' : 's'} → ${tile}` : `jumped → ${tile}`);
    });
    Game.on('combat_victory', d => { if (fight && byName(d.player)?.id === fight.pid) fight.result = 'win';
      if (d.isPvp) add('⚔', `defeated ${d.mob} in PvP`, 'good'); });
    Game.on('player_defeated', d => {
      if (fight && byName(d.player)?.id === fight.pid) { fight.result = 'loss'; closeFight(); }
      else add('☠', `${d.player} died${d.by ? ` (killed by ${d.by})` : ''}`, 'bad');
    });
    Game.on('combat_update', d => {
      if (!fight) return;
      if (d.outcome === 'befriended') fight.result = 'befriended';
      else if (d.outcome === 'charisma_end') fight.result = 'talked';
      else if (d.outcome === 'escaped') fight.result = 'escaped';
    });
    Game.on('pvp_update', d => {
      if (d.outcome === 'ongoing') return;
      const who = (d.players ?? []).map(x => x.name).join(' vs ');
      add('⚔', `PvP ${who}: ${d.winner ? d.winner + ' wins' : d.escaped ? d.escaped + ' escapes' : d.outcome}`, d.winner ? 'good' : '');
    });
    Game.on('loot', d => {
      const counts = {};
      for (const id of d.loot?.items ?? []) counts[id] = (counts[id] ?? 0) + 1;
      const parts = Object.entries(counts).map(([id, n]) => itemName(id) + (n > 1 ? ` ×${n}` : ''));
      if (d.loot?.coins) parts.push(`${d.loot.coins}💰`);
      if (parts.length) add('🎁', parts.join(', '));
    });
    Game.on('shop_transaction', d => add(d.type === 'buy' ? '🛒' : '💱',
      `${d.type === 'buy' ? 'bought' : 'sold'} ${d.item?.name ?? d.item}`));
    Game.on('enchanted', d => add('✨', `${SLOT_ICONS[d.slot] ?? d.slot} ${d.enchantment?.name ?? d.enchantment} enchant`));
    Game.on('skill_upgraded', d => add('⬆', `${STAT_LABELS[d.stat]} → ${d.newValue} (Master)`));
    Game.on('xp_levelup', d => add('📈', `${STAT_LABELS[d.stat] ?? d.stat} → ${d.newValue} (XP)`));
    Game.on('item_used', d => add('🧪', `used ${d.item?.name ?? '?'}`));
    Game.on('item_equipped', d => add('🛡', `equipped ${d.item?.name ?? '?'}`));
    Game.on('princess_picked_up', d => add('👑', `${d.player} picked up the Princess`, 'good'));
    Game.on('dragon_defeated', () => add('🐉', 'killed the DRAGON', 'good'));
    Game.on('healed', () => add('🔥', 'healed at the campfire'));
    Game.on('chest_opened', d => { if (d.isEmpty) add('🎁', 'empty chest'); });
    Game.on('priest_buff', d => add('✝', `Priest blessing (+${d.roll})`));
    Game.on('coins_changed', () => touch());
    Game.on('log', d => { const r = ensureTurn(); if (r) { r.lines.push(d.message); touch(); } });
  }

  // ── Queries ────────────────────────────────────────────────────────────────
  function lastTurnOf(pid) { for (let i = turns.length - 1; i >= 0; i--) if (turns[i].pid === pid) return turns[i]; return null; }
  function recentTurnsOf(pid, n) { const out = []; for (let i = turns.length - 1; i >= 0 && out.length < n; i--) if (turns[i].pid === pid) out.push(turns[i]); return out; }
  // Map trail: segments walked in each player's most recent turn
  function lastPaths() {
    const out = {};
    for (const p of players()) { const r = lastTurnOf(p.id); if (r?.segments.length) out[p.id] = r.segments; }
    return out;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function render() { renderLog(); renderStrip(); renderBanner(); if (pinned) showCard(pinned, null); }

  function deltaHTML(r) {
    const dc = r.coins1 - r.coins0, dh = r.hearts1 - r.hearts0;
    return (dc ? `<span class="${dc > 0 ? 'good' : 'bad'}">${dc > 0 ? '+' : ''}${dc}💰</span> ` : '') +
           (dh ? `<span class="${dh > 0 ? 'good' : 'bad'}">${dh > 0 ? '+' : ''}${dh}❤</span>` : '');
  }
  function eventsHTML(r, max = 99) {
    const ev = r.events.slice(0, max);
    const more = r.events.length - ev.length;
    return ev.map(e => `<div class="act-ev ${e.cls}">${e.icon} ${esc(e.text)}${e.n > 1 ? ` <b>×${e.n}</b>` : ''}</div>`).join('') +
           (more > 0 ? `<div class="act-ev dim">… ${more} more</div>` : '');
  }

  function buildFilters() {
    const box = $('log-filters'); if (!box) return;
    box.innerHTML = '';
    players().forEach(p => {
      const b = document.createElement('button');
      b.className = 'log-filter';
      b.innerHTML = `<span class="dot" style="background:${colorOf(p)}"></span>${esc(p.name)}`;
      b.onclick = () => { hidden.has(p.id) ? hidden.delete(p.id) : hidden.add(p.id); b.classList.toggle('off', hidden.has(p.id)); renderLog(); };
      box.appendChild(b);
    });
  }

  const openTurns = new Set();
  function renderLog() {
    const list = $('log-list'); if (!list) return;
    const shown = turns.filter(r => !hidden.has(r.pid)).slice(-120).reverse();
    list.innerHTML = shown.map(r => {
      const p = players().find(q => q.id === r.pid);
      const open = openTurns.has(r.key);
      return `<div class="act-turn${r === cur ? ' current' : ''}" style="border-left-color:${p ? colorOf(p) : '#888'}">
        <div class="act-head" data-key="${esc(r.key)}">
          <span class="act-t">T${r.turn}</span> <b style="color:${p ? colorOf(p) : '#ccc'}">${esc(r.name)}</b>
          ${r.goal ? `<span class="act-goal">${esc(r.goal)}</span>` : ''} <span class="act-delta">${deltaHTML(r)}</span>
          <span class="act-toggle">${open ? '▾' : '▸'}</span>
        </div>
        ${eventsHTML(r)}
        ${open ? `<div class="act-raw">${r.lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    list.querySelectorAll('.act-head').forEach(h => h.onclick = () => {
      const k = h.dataset.key; openTurns.has(k) ? openTurns.delete(k) : openTurns.add(k); renderLog();
    });
  }

  function renderStrip() {
    const strip = $('players-strip'); if (!strip) return;
    const curP = Game.getCurrentPlayer();
    strip.innerHTML = players().map(p => {
      const goal = p.isBot && p.isAlive && typeof BotAI !== 'undefined' ? BotAI.getPhase(p).replace(/^\[(\w+)\] /, '$1 · ') : '';
      return `<div class="pchip${p === curP ? ' active' : ''}${p.isAlive ? '' : ' dead'}${pinned === p.id ? ' pinned' : ''}" data-pid="${p.id}">
        <span class="dot" style="background:${colorOf(p)}"></span>
        <b>${esc(p.name)}</b>${p.isBot ? ' 🤖' : ''}${p.hasPrincess ? ' 👑' : ''}${p.isAlive ? '' : ' ☠'}
        <span class="pchip-stat">❤${p.hearts.current}/${p.hearts.max} 💰${p.coins}</span>
        ${goal ? `<span class="pchip-goal">${esc(goal)}</span>` : ''}
      </div>`;
    }).join('');
    strip.querySelectorAll('.pchip').forEach(el => {
      const pid = el.dataset.pid;
      el.onmouseenter = () => { if (!pinned) showCard(pid, el); };
      el.onmouseleave = () => { if (!pinned) hideCard(); };
      el.onclick = () => { pinned = pinned === pid ? null : pid; if (pinned) showCard(pid, el); else hideCard(); renderStrip(); };
    });
  }

  // Detail card for one player: state now + their last turns
  let cardAnchor = null;
  function showCard(pid, anchor, at = null) {
    const p = players().find(q => q.id === pid); const card = $('player-card');
    if (!p || !card) return;
    if (anchor) cardAnchor = anchor;
    const stats = ['F','D','A','M','C','V'].map(s => `<span><i>${STAT_LABELS[s]}</i> ${p.getStat(s)}</span>`).join('');
    const eq = Object.entries(p.equipped).filter(([, it]) => it).map(([slot, it]) => {
      const lv = p.guildItemLevels?.[it.id]?.itemLevel;
      return `<div>${SLOT_ICONS[slot]} ${esc(it.name)}${lv > 1 ? ` <i>Lv${lv}</i>` : ''}${it.enchantment ? ` <span class="ench">✦ ${esc(it.enchantment.name ?? it.enchantment.id)}</span>` : ''}</div>`;
    }).join('') || '<i>nothing equipped</i>';
    const inv = {}; for (const id of p.inventory) inv[id] = (inv[id] ?? 0) + 1;
    const invHTML = Object.entries(inv).sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `<span class="inv-chip">${esc(itemName(id))}${n > 1 ? ` ×${n}` : ''}</span>`).join('') || '<i>empty</i>';
    const friends = (p.friendsList ?? []).map(f => `${esc(f.name)} ❤${f.hearts.current}/${f.hearts.max}`).join(', ');
    const goal = p.isBot && typeof BotAI !== 'undefined' ? BotAI.getPhase(p) : '';
    const recent = recentTurnsOf(p.id, 3).map(r =>
      `<div class="card-turn"><div class="act-head"><span class="act-t">T${r.turn}</span> ${r.goal ? `<span class="act-goal">${esc(r.goal)}</span>` : ''} <span class="act-delta">${deltaHTML(r)}</span></div>${eventsHTML(r, 8)}</div>`).join('');
    card.innerHTML = `
      <div class="card-title" style="border-color:${colorOf(p)}"><span class="dot" style="background:${colorOf(p)}"></span>
        <b>${esc(p.name)}</b>${p.isBot ? ' 🤖' : ''}${p.hasPrincess ? ' 👑 Princess' : ''}${p.isAlive ? '' : ' ☠ dead'}
        ${pinned === pid ? '<span class="pin">📌</span>' : ''}</div>
      ${goal ? `<div class="card-goal">${esc(goal)}</div>` : ''}
      <div class="card-row">❤ ${p.hearts.current}/${p.hearts.max} &nbsp; 💰 ${p.coins}${p.invisPotion ? ` &nbsp; 👻 ×${p.invisPotion}` : ''}</div>
      <div class="card-stats">${stats}</div>
      <div class="card-sec">Equipped</div><div class="card-eq">${eq}</div>
      <div class="card-sec">Inventory</div><div class="card-inv">${invHTML}</div>
      ${friends ? `<div class="card-sec">Friends</div><div class="card-inv">${friends}</div>` : ''}
      <div class="card-sec">Last turns</div>${recent || '<i>no turns yet</i>'}`;
    card.style.display = 'block';
    // position: next to the hovered token (at), else under the chip
    const r = (at ? null : cardAnchor?.getBoundingClientRect());
    let x = at ? at.x + 16 : (r ? r.left : 20), y = at ? at.y + 16 : (r ? r.bottom + 6 : 80);
    const w = card.offsetWidth, h = card.offsetHeight;
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
    if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
    card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  function hideCard() { const c = $('player-card'); if (c) c.style.display = 'none'; }
  // Map hover over a token (pinned cards stay put)
  function hoverToken(p, clientX, clientY) {
    if (pinned) return;
    if (p) showCard(p.id, null, { x: clientX, y: clientY }); else hideCard();
  }

  // Bot banner: what the bot on turn is doing, instead of popups
  function renderBanner() {
    const el = $('bot-banner'); if (!el) return;
    const p = Game.getCurrentPlayer();
    const phase = Game.getState().phase;
    if (!p?.isBot || phase === Game.Phase.GAME_OVER || !cur || cur.pid !== p.id) { el.style.display = 'none'; return; }
    const fightLine = fight ? `<div class="act-ev">⚔ fighting ${esc(fight.mob)}…</div>` : '';
    el.style.display = 'block';
    el.style.borderColor = colorOf(p);
    el.innerHTML = `<div class="act-head"><span class="dot" style="background:${colorOf(p)}"></span> <b>${esc(p.name)}</b>
      ${cur.goal ? `<span class="act-goal">${esc(cur.goal)}</span>` : ''} <span class="act-delta">${deltaHTML(cur)}</span></div>
      ${eventsHTML({ events: cur.events.slice(-5) })}${fightLine}`;
  }

  return { init, lastPaths, hoverToken, hideCard, render };
})();
