// PvpPanel — UI for player-vs-player duels (Phase.PVP_COMBAT).
// Turn-based with V initiative; the opponent takes part out of turn. The active player gets
// attack / escape / consumable controls; when attacked, the defender sees the announced attack
// and may use a heal, a stat potion or Smoke before defending.
// Bot participants act through BotAI.pvpTick() (triggered from main.js).
// The panel builds its own modal inside #overlay, reusing the .modal / .action-btn styles.

const PvpPanel = (() => {
  const STAT_KEYS = ['F','D','A','M','C','V'];
  let root = null;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') e.style.cssText = v;
      else if (k === 'onclick') e.addEventListener('click', v);
      else if (k === 'disabled') e.disabled = !!v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return root;
    root = el('div', { id: 'modal-pvp', class: 'modal hidden', style: 'width:760px;max-width:95vw;' });
    (document.getElementById('overlay') ?? document.body).append(root);
    return root;
  }

  function show() {
    ensureRoot();
    document.getElementById('overlay')?.classList.remove('hidden');
    root.classList.remove('hidden');
    render();
  }

  function hide() { root?.classList.add('hidden'); }

  // Consumables that can be used in a duel (mirrors game.js handlePvpUseItem)
  function usableItems(p, opp, view) {
    const counts = {};
    for (const id of p.inventory) counts[id] = (counts[id] ?? 0) + 1;
    const out = [];
    for (const [id, n] of Object.entries(counts)) {
      const it = getItem(id); if (!it) continue;
      const me = view.players.find(x => x.id === p.id), them = view.players.find(x => x.id === opp.id);
      let ok = false;
      const defending = view.step === 'defend';
      if (id === 'chain') ok = !defending && !them.chained;
      else if (it.effect === 'immune_one_turn') ok = defending && !me.smoke;
      else if (it.effect?.type === 'heal') ok = p.hearts.current < p.hearts.max;
      else if (it.effect?.stat && /^pot_/.test(id)) ok = !p.hasTempBonus(it.effect.stat);
      else if (it.statBonus && !it.slot) ok = !defending;      // blood drops
      if (ok) out.push({ id, name: it.name, n });
    }
    return out;
  }

  function playerCard(p, info) {
    const hearts = '❤'.repeat(Math.max(0, p.hearts.current)) + '🖤'.repeat(Math.max(0, p.hearts.max - p.hearts.current));
    const stats = STAT_KEYS.map(s => `${s}${p.getStat(s)}`).join(' ');
    const tags = [info.chained ? '🔗 chained' : null, info.smoke ? '💨 smoke' : null, p.hasPrincess ? '👑 princess' : null,
                  info.role].filter(Boolean).join(' · ');
    return el('div', { style: 'flex:1;border:1px solid #444;border-radius:6px;padding:8px;' },
      el('div', { style: 'font-weight:bold;color:#ffd700;' }, `${p.name}${p.isBot ? ' (bot)' : ''}`),
      el('div', { style: 'font-size:1.1rem;' }, hearts),
      el('div', { style: 'font-size:0.8rem;color:#aaa;' }, stats),
      el('div', { style: 'font-size:0.8rem;color:#c8b8a0;margin-top:4px;' }, tags));
  }

  function controls(p, opp, view) {
    const act = choice => Game.submitAction({ type: 'pvp_choose', playerId: p.id, choice });
    const use = itemId => Game.submitAction({ type: 'pvp_use_item', playerId: p.id, itemId });
    const me = view.players.find(x => x.id === p.id);
    const box = el('div', { style: 'border-top:1px solid #444;padding-top:8px;display:flex;flex-direction:column;gap:6px;' },
      el('div', { style: 'color:#ffd700;font-weight:bold;' }, `${p.name} — your move`));

    // attacks
    const atkRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
    const spells = [...new Set(p.inventory.filter(id => getItem(id)?.subtype === 'attack'))];
    let spellSel = null;
    if (p.canAttackMagic() && spells.length) {
      spellSel = el('select', {}, el('option', { value: '' }, 'no spell'),
        ...spells.map(id => el('option', { value: id }, `${getItem(id).name} (+${getItem(id).magicValue})`)));
    }
    atkRow.append(
      el('button', { class: 'action-btn', onclick: () => act({ kind: 'attack', attackType: 'F' }) }, `⚔ STR (${p.getStat('F')})`),
      el('button', { class: 'action-btn', onclick: () => act({ kind: 'attack', attackType: 'D' }) }, `🏹 DEX (${p.getStat('D')})`),
      el('button', { class: 'action-btn', disabled: !p.canAttackMagic(),
        onclick: () => act({ kind: 'attack', attackType: 'M', ...(spellSel?.value ? { spellId: spellSel.value } : {}) }) }, `✨ MAG (${p.getStat('M')})`));
    if (spellSel) atkRow.append(spellSel);
    box.append(atkRow);

    // escapes (blocked when chained)
    const chained = me.chained;
    box.append(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' },
      el('button', { class: 'action-btn', disabled: chained, onclick: () => act({ kind: 'run' }) },
        p.hasEquipped('stealth_shoes') ? '🏃 Run (Stealth Shoes)' : `🏃 Run (V${p.getStat('V')} vs ${opp.getStat('V')})`),
      el('button', { class: 'action-btn', disabled: chained || !p.hasItem('rope'), onclick: () => act({ kind: 'rope' }) }, '🪢 Rope'),
      el('button', { class: 'action-btn', disabled: chained || !p.hasItem('sp_invisibility'), onclick: () => act({ kind: 'invisibility' }) }, '👻 Invisibility'),
      el('button', { class: 'action-btn', disabled: chained, onclick: () => act({ kind: 'charm' }) }, `🎵 Talk your way out (C${p.getStat('C')} vs ${opp.getStat('C')})`)));
    if (chained) box.append(el('div', { style: 'font-size:0.8rem;color:#ff6b6b;' }, '🔗 You are chained — no escape this fight.'));

    // consumables
    const items = usableItems(p, opp, view);
    if (items.length) {
      const row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
      for (const it of items) row.append(el('button', { class: 'action-btn', style: 'font-size:0.8rem;', onclick: () => use(it.id) }, `${it.name} ×${it.n}`));
      box.append(el('div', { style: 'font-size:0.8rem;color:#aaa;' }, 'Consumables (free, before you act):'), row);
    }
    return box;
  }

  function defendControls(p, opp, view) {
    const use = itemId => Game.submitAction({ type: 'pvp_use_item', playerId: p.id, itemId });
    const t = view.pendingAttack.attackType;
    const names = { F: 'STR', D: 'DEX', M: 'MAG' };
    const defStat = t === 'M' && p.hasEnchantment('arcane') ? 'A' : ({ F: 'A', D: 'V', M: 'M' })[t];
    const box = el('div', { style: 'border-top:1px solid #444;padding-top:8px;display:flex;flex-direction:column;gap:6px;' },
      el('div', { style: 'color:#ff6b6b;font-weight:bold;' },
        `${opp.name} attacks you with ${names[t]}${view.pendingAttack.spellId ? ' + ' + getItem(view.pendingAttack.spellId).name : ''}! You defend with ${defStat} (${p.getDefenseStat(t)}).`));
    const items = usableItems(p, opp, view);
    if (items.length) {
      const row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
      for (const it of items) row.append(el('button', { class: 'action-btn', style: 'font-size:0.8rem;', onclick: () => use(it.id) }, `${it.name} ×${it.n}`));
      box.append(el('div', { style: 'font-size:0.8rem;color:#aaa;' }, 'Before you defend:'), row);
    }
    box.append(el('button', { class: 'action-btn', onclick: () => Game.submitAction({ type: 'pvp_defend', playerId: p.id }) }, '🛡 Defend'));
    return box;
  }

  function render(extra = null) {
    if (!root) return;
    const view = Game.getPvpView?.();
    root.innerHTML = '';
    if (!view) {
      if (extra) root.append(el('h2', {}, '⚔ Duel over'), el('div', {}, extra));
      return;
    }
    const st = Game.getState();
    const [a, b] = view.players.map(v => st.players.find(p => p.id === v.id));
    root.append(el('h2', {}, `⚔ Duel — round ${view.round}`));
    const role = v => v.active ? (view.step === 'act' ? '▶ acting' : '⚔ attacking') : (view.step === 'defend' ? '🛡 defending' : 'waiting');
    root.append(el('div', { style: 'display:flex;gap:10px;' },
      playerCard(a, { ...view.players[0], role: role(view.players[0]) }), playerCard(b, { ...view.players[1], role: role(view.players[1]) })));
    for (const [p, opp] of [[a, b], [b, a]]) {
      if (p.isBot || !view.waitingFor.includes(p.id)) continue;
      root.append(view.step === 'defend' ? defendControls(p, opp, view) : controls(p, opp, view));
    }
    root.append(el('div', { style: 'max-height:160px;overflow-y:auto;font-size:0.8rem;color:#ccc;border-top:1px solid #444;padding-top:6px;' },
      ...view.log.map(l => el('div', {}, l))));
  }

  function init() {
    Game.on('pvp_update', d => {
      if (d.outcome === 'ongoing') { show(); return; }
      // fight over: show the result briefly; the next state_change hides all modals
      const msg = d.winner ? `${d.winner} wins the duel — ${d.loser} is slain.` : d.escaped ? `${d.escaped} escapes!` : 'The duel ends.';
      render(msg);
    });
  }

  return { init, show, hide, render };
})();
