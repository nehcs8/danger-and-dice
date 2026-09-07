// HUD — updates the left panel (stats, hearts, coins) and the log.

const HUD = (() => {
  const MAX_LOG = 80;
  const logEntries = [];

  function stackItems(ids) {
    const counts = new Map();
    const order  = [];
    for (const id of ids) {
      if (!counts.has(id)) { counts.set(id, 0); order.push(id); }
      counts.set(id, counts.get(id) + 1);
    }
    return order.map(id => ({ id, count: counts.get(id) }));
  }

  function init() {
    logEntries.length = 0;
    buildLegend();
    update({});
  }

  function buildLegend() {
    const entries = [
      { color: '#e8dcc8', icon: '',    label: 'Path' },
      { color: '#f5e642', icon: '?',   label: 'Random Event' },
      { color: '#4488ff', icon: '!',   label: 'Miniboss (tier 0)' },
      { color: '#44bb44', icon: '!',   label: 'Miniboss (tier 1)' },
      { color: '#ffcc00', icon: '!',   label: 'Miniboss (tier 2)' },
      { color: '#ff3333', icon: '!',   label: 'Miniboss (tier 3)' },
      { color: '#a0724a', icon: '🎁',  label: 'Chest' },
      { color: '#7ec8e3', icon: '↺',   label: 'Reroll' },
      { color: '#6abf69', icon: '⚒',  label: 'Work' },
      { color: '#e05050', icon: '✋',  label: 'Stop' },
      { color: '#c04040', icon: '←',   label: 'Go Back' },
      { color: '#c07ed0', icon: '✝',   label: 'Priest' },
      { color: '#4a90d9', icon: '🏪',  label: 'Shop' },
      { color: '#7b2fa0', icon: '⚗',  label: 'Master' },
      { color: '#ff7733', icon: '🔥',  label: 'Campfire (full heal)' },
      { color: '#800000', icon: '☠',   label: 'Boss' },
      { color: '#303030', icon: '🗡',  label: 'Assassin Guild' },
      { color: '#303030', icon: '🔓',  label: 'Thief Guild' },
      { color: '#ffd700', icon: '★',   label: 'Finish' },
      { color: '#44bb44', icon: '⚑',   label: 'Start' },
      { color: '#d4a0c0', icon: '🍺',  label: 'Bar (+1 heart, 10💰)' },
      { color: '#556677', icon: '…',   label: 'Secret Path' },
    ];
    const list = document.getElementById('legend-list');
    list.innerHTML = entries.map(e =>
      `<div class="legend-item">
        <span class="legend-swatch" style="background:${e.color}">${e.icon}</span>
        <span class="legend-label">${e.label}</span>
      </div>`
    ).join('');
  }

  function update(data) {
    const player = Game.getCurrentPlayer();
    if (!player) return;

    const phase = data.phase ?? Game.getState().phase;

    _el('player-name-display').textContent = player.name + (player.isBot ? ' 🤖' : '');
    _el('hearts-display').innerHTML  = heartsHTML(player.hearts);
    _el('coins-display').textContent = `💰 ${player.coins}`;
    _el('stats-display').innerHTML   = statsHTML(player);
    _el('equipped-display').innerHTML = equippedHTML(player, false);
    _el('turn-info').textContent     = phaseLabel(phase);
    _el('inventory-list').innerHTML  = inventoryHTML(player, phase);
    _el('other-players-display').innerHTML = otherPlayersHTML(player, Game.getPlayers());

    const rollBtn = _el('btn-roll');
    const blocked = phase === Game.Phase.STOP_BLOCKED;
    rollBtn.disabled  = phase !== Game.Phase.ROLL_MOVE && !blocked;
    rollBtn.textContent = blocked ? 'End Turn (Blocked)' : 'Roll Movement';

    refreshInventoryPopup();
  }

  function heartsHTML({ current, max }) {
    const full  = '❤️';
    const empty = '🖤';
    return Array.from({length: max}, (_, i) => i < current ? full : empty).join(' ');
  }

  function statsHTML(player) {
    const stats = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    return `<table class="stats-table">${
      stats.map(s => {
        const base = player.baseStats[s];
        const eff  = player.getStat(s);
        const diff = eff - base;
        const diffStr = diff > 0 ? `<span class="bonus">+${diff}</span>`
                      : diff < 0 ? `<span class="malus">${diff}</span>` : '';
        return `<tr><td>${labels[s]}</td><td>${base}${diffStr}</td></tr>`;
      }).join('')
    }</table>`;
  }

  function equippedHTML(player, readOnly = false) {
    const slots = ['strength','dexterity','magic','charisma','speed','armor','shield'];
    const labels = {
      strength:'⚔', dexterity:'🏹', magic:'✨',
      charisma:'🎵', speed:'👟', armor:'🛡', shield:'🔰',
    };
    return `<div class="equipped-grid">${
      slots.map(slot => {
        const item = player.equipped[slot];
        const ench = item?.enchantment ? ` <em>${item.enchantment.id}</em>` : '';
        const unequipBtn = (!readOnly && item)
          ? `<button class="inv-equip-btn" onclick="HUD.tryUnequip('${slot}')">▼</button>`
          : '';
        return `<div class="equip-slot" title="${slot}">
          <span class="slot-icon">${labels[slot]}</span>
          <span class="slot-item">${item ? item.name + ench : '—'}</span>
          ${unequipBtn}
        </div>`;
      }).join('')
    }</div>`;
  }

  const COMBAT_ONLY_SPELLS = new Set(['sp_invisibility','sp_transmutation','sp_smoke']);

  function inventoryHTML(player, phase) {
    const inCombat = phase === Game.Phase.COMBAT || phase === Game.Phase.PVP_COMBAT;
    // Only show non-equipment items; equipment is managed via the popup
    const ids = player.inventory.filter(id => !getItem(id)?.slot);
    if (!ids.length) return '<em>empty</em>';
    return stackItems(ids).map(({ id, count }) => {
      const item  = getItem(id);
      const name  = item?.name ?? id;
      const label = name + (count > 1 ? ` ×${count}` : '');
      const isCombatOnly = COMBAT_ONLY_SPELLS.has(id);
      const eff = item?.effect;
      const usable = !isCombatOnly && (
        item?.statBonus ||
        (eff && typeof eff === 'object' && (eff.type === 'heal' || eff.stat != null)) ||
        (typeof eff === 'string' && eff === 'teleport')
      );
      let useBtn = '';
      if (usable) {
        useBtn = `<button class="inv-equip-btn" onclick="HUD.tryUse('${id}')">Use</button>`;
      } else if (isCombatOnly && !inCombat) {
        useBtn = `<span style="color:#555;font-size:0.75em;padding:2px 4px">(combat)</span>`;
      }
      const dimStyle = isCombatOnly && !inCombat ? ' style="opacity:0.4"' : '';
      return `<div class="inv-item" data-id="${id}" title="${name}"${dimStyle}>${label}${useBtn}</div>`;
    }).join('');
  }

  function openInventoryPopup() {
    const player = Game.getCurrentPlayer();
    if (!player) return;
    const slots = ['strength','dexterity','magic','charisma','speed','armor','shield'];
    const labels = {
      strength:'⚔ Strength', dexterity:'🏹 Dexterity', magic:'✨ Magic',
      charisma:'🎵 Charisma', speed:'👟 Speed', armor:'🛡 Armor', shield:'🔰 Shield',
    };

    const el = _el('inventory-slots-list');
    el.innerHTML = '';

    slots.forEach(slot => {
      const equippedItem = player.equipped[slot];
      const matchingIds  = player.inventory.filter(id => getItem(id)?.slot === slot);

      const section = document.createElement('div');
      section.className = 'inv-slot-section';

      const hdr = document.createElement('div');
      hdr.className = 'inv-slot-header';
      hdr.textContent = labels[slot];
      section.appendChild(hdr);

      const equippedDiv = document.createElement('div');
      equippedDiv.className = 'inv-slot-equipped';
      if (equippedItem) {
        const enchName = equippedItem.enchantment?.name ?? equippedItem.enchantment?.id ?? null;
        const enchSpan = enchName
          ? ` <span class="enchanted-item">✦ ${enchName}</span>` : '';
        equippedDiv.innerHTML =
          `<span>${equippedItem.name}${enchSpan}</span>
           <button class="inv-equip-btn" onclick="HUD.tryUnequip('${slot}')">▼ Unequip</button>`;
      } else {
        equippedDiv.innerHTML = '<span style="color:#555;font-size:0.8rem">— empty —</span>';
      }
      section.appendChild(equippedDiv);

      stackItems(matchingIds).forEach(({ id, count }) => {
        const item = getItem(id);
        const row  = document.createElement('div');
        row.className = 'inv-slot-option';
        row.innerHTML =
          `<span>${item?.name ?? id}${count > 1 ? ` ×${count}` : ''}</span>
           <button class="inv-equip-btn" ${player.canEquip(item) ? '' : 'disabled'}
             onclick="HUD.tryEquip('${id}')">▲ Equip</button>`;
        section.appendChild(row);
      });

      el.appendChild(section);
    });

    _el('overlay').classList.remove('hidden');
    _el('modal-inventory').classList.remove('hidden');
  }

  function closeInventoryPopup() {
    _el('modal-inventory').classList.add('hidden');
    const anyVisible = document.querySelectorAll('.modal:not(.hidden)').length > 0;
    if (!anyVisible) _el('overlay').classList.add('hidden');
  }

  function refreshInventoryPopup() {
    if (!_el('modal-inventory').classList.contains('hidden')) openInventoryPopup();
  }

  function tryEquip(itemId) {
    Game.submitAction({ type: 'equip', itemId });
  }

  function tryUnequip(slot) {
    Game.submitAction({ type: 'unequip', slot });
  }

  function tryUse(itemId) {
    Game.submitAction({ type: 'use_item', itemId });
  }

  function otherPlayersHTML(currentPlayer, allPlayers) {
    const others = allPlayers.filter(p => p.id !== currentPlayer.id);
    if (!others.length) return '';
    return `<div>
      <h4 class="other-players-header">Other Players</h4>
      ${others.map(p => {
        const idx = allPlayers.indexOf(p);
        const hFull  = p.hearts.current;
        const hEmpty = p.hearts.max - hFull;
        const heartsStr = '❤'.repeat(hFull) + '🖤'.repeat(hEmpty);
        const deadStyle = p.isAlive ? '' : 'opacity:0.45;';
        return `<div class="other-player-card" style="${deadStyle}" onclick="HUD.showPlayerInfo(${idx})">
          <span class="other-player-name">${p.name}${p.isBot ? ' 🤖' : ''}${!p.isAlive ? ' ☠' : ''}</span>
          <span class="other-player-hearts">${heartsStr}</span>
          <span class="other-player-coins">💰 ${p.coins}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  function showPlayerInfo(playerIdx) {
    const p = Game.getPlayers()[playerIdx];
    if (!p) return;
    _el('modal-player-info-name').textContent =
      p.name + (p.isBot ? ' 🤖' : '') + (!p.isAlive ? ' (Defeated)' : '');

    const stats = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const invHTML = p.inventory.length
      ? stackItems(p.inventory).map(({ id, count }) => {
          const item  = getItem(id);
          const label = (item?.name ?? id) + (count > 1 ? ` ×${count}` : '');
          return `<div class="inv-item" style="pointer-events:none">${label}</div>`;
        }).join('')
      : '<em>empty</em>';

    _el('modal-player-info-content').innerHTML = `
      <div style="margin-bottom:6px">
        ${heartsHTML(p.hearts)}
        <span style="color:#ffd700;margin-left:8px">💰 ${p.coins}</span>
      </div>
      <table class="stats-table" style="margin-bottom:8px">${
        stats.map(s => {
          const base = p.baseStats[s];
          const eff  = p.getStat(s);
          const diff = eff - base;
          const diffStr = diff > 0 ? `<span class="bonus">+${diff}</span>`
                        : diff < 0 ? `<span class="malus">${diff}</span>` : '';
          return `<tr><td>${labels[s]}</td><td>${base}${diffStr}</td></tr>`;
        }).join('')
      }</table>
      <h4 style="color:#aaa;margin-bottom:4px">Equipped</h4>
      ${equippedHTML(p, true)}
      <h4 style="color:#aaa;margin-top:8px;margin-bottom:4px">Inventory</h4>
      <div>${invHTML}</div>`;

    _el('overlay').classList.remove('hidden');
    _el('modal-player-info').classList.remove('hidden');
  }

  function closePlayerInfo() {
    _el('modal-player-info').classList.add('hidden');
    const anyVisible = document.querySelectorAll('.modal:not(.hidden)').length > 0;
    if (!anyVisible) _el('overlay').classList.add('hidden');
  }

  function phaseLabel(phase) {
    const labels = {
      setup_roll:    'Character setup',
      roll_move:     'Roll movement',
      moving:        'Choose destination',
      tile_event:    'Resolving tile…',
      combat:        'In combat!',
      pvp_combat:    'PVP fight!',
      shop:          'At the shop',
      master:        'At the master',
      chest:         'Found a chest',
      priest:        'At the priest',
      work:          'Working…',
      stop_blocked:  'Stopped!',
      game_over:     'Game over',
    };
    return labels[phase] ?? '';
  }

  function appendLog(message) {
    logEntries.push(message);
    if (logEntries.length > MAX_LOG) logEntries.shift();
    const list = _el('log-list');
    const div  = document.createElement('div');
    div.className   = 'log-entry';
    div.textContent = message;
    list.appendChild(div);
    list.scrollTop  = list.scrollHeight;
  }

  function _el(id) { return document.getElementById(id); }

  return { init, update, appendLog, tryEquip, tryUnequip, tryUse, showPlayerInfo, closePlayerInfo, openInventoryPopup, closeInventoryPopup };
})();
