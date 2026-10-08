// Panels — modal overlays for combat, shop, master, chest, priest, game over.
// Each modal is shown/hidden in response to Game phase changes.

const Panels = (() => {
  let currentShopGuildType = null; // remembered so refreshShop() can re-use it

  // Group identical item IDs and return [{id, count}] in first-seen order.
  function stackItems(ids) {
    const counts = new Map();
    const order  = [];
    for (const id of ids) {
      if (!counts.has(id)) { counts.set(id, 0); order.push(id); }
      counts.set(id, counts.get(id) + 1);
    }
    return order.map(id => ({ id, count: counts.get(id) }));
  }

  function specialItemEffectDesc(effect) {
    if (typeof effect !== 'string') return '';
    switch (effect) {
      case 'kryss':               return 'Automatically strikes enemy for 1 heart before combat starts';
      case 'garrote_kill':        return 'F attacks auto-kill enemies with ≤2 hearts (no roll needed)';
      case 'skip_miniboss':       return 'Can pass through miniboss tiles without fighting';
      case 'double_magicvalue':   return 'Magic spell bonus (magicValue) is doubled';
      case 'spell_twice':         return 'Each spell in inventory can be cast twice before being consumed';
      case 'charisma_damage':     return 'Charisma successes automatically deal 1 damage; unlocks tier-3 Kill option';
      case 'immune_charisma':     return 'Enemy cannot target you with Charisma attacks';
      case 'always_escape':       return 'Can always escape from combat (reusable)';
      case 'coins_plus15':        return '+15 coins added to every enemy kill reward';
      case 'sell_75pct':          return 'Sell items for 75% of buy price instead of 50%';
      case 'double_chest':        return 'Roll chest twice — choose which result to keep';
      case 'all_drops':           return 'All loot items drop in double quantity';
      case 'c_cap_8':             return 'C stat can be raised to 8 at Master; gains +1 C per level (max Lv.8, via miniboss charisma encounters)';
      case 'deceive_double_coins':return 'Charisma "deceive" outcomes yield double coins';
      case 'coins_times2':        return 'Coins earned from kills are doubled';
      case 'pickpocket':          return 'Successful DEX attacks also steal 2×d6 coins';
      case 'pass_obstacles':      return 'Can walk secret paths without Compass';
      default: return '';
    }
  }

  function statBonusDesc(item) {
    const sb = item.statBonus;
    if (!sb) return '';
    return Object.entries(sb)
      .map(([stat, val]) => (val >= 0 ? `+${val}` : `\u2212${Math.abs(val)}`) + stat)
      .join(' ');
  }

  function spellDesc(item) {
    if (item.subtype === 'attack') {
      const mv = `+${item.magicValue}M`;
      if (!item.effect) return mv;
      const e = item.effect;
      if (e.type === 'fire')      return `${mv} · burn ${e.n} turn${e.n > 1 ? 's' : ''}`;
      if (e.type === 'ice')       return `${mv} · \u2212${e.n} SPD`;
      if (e.type === 'lightning') return `${mv} · stun 1 turn`;
      if (e.type === 'explosion') return `${mv} · \u2212${e.n} ARM`;
      if (e.type === 'blood')     return `${mv} · +1\u2764 on kill`;
      return mv;
    }
    if (item.subtype === 'defense') return `+${item.armorValue} magic defense`;
    const utilDesc = {
      sp_invisibility:  'Bail from combat (consumed)',
      sp_teleport:      'Jump to any Shop / Master / Guild',
      sp_transmutation: 'Swap two stats for the whole fight',
      sp_smoke:         'Immune to next mob attack (consumed)',
      sp_disenchant:    'Remove enchantment from an item',
      sp_curse:         'Reduce a mob stat by d6 for 4 turns — pick the stat (combat only)',
    };
    return utilDesc[item.id] ?? '';
  }

  function enchantEffectDesc(ench) {
    const e = ench.effect;
    if (!e) return '';
    switch (e.type) {
      case 'stat_bonus':                return `+${e.value} ${e.stat} (permanent)`;
      case 'armor_reduction_on_hit':    return `reduces enemy ARM by tier on each hit`;
      case 'heal_on_kill':              return `+1 ❤ on kill`;
      case 'coins_on_kill':             return `+${e.value ?? 5} 💰 on kill`;
      case 'fire_on_hit':               return `sets enemy on fire for 1 turn`;
      case 'speed_reduction_on_hit':    return `reduces enemy SPD by tier on each hit`;
      case 'magic_defense_via_armor':   return `magic defense uses ARM instead of MAG`;
      case 'reflect_30pct':             return `30% chance to reflect incoming damage`;
      case 'remove_speed_malus':        return `removes armor speed penalty`;
      default: return '';
    }
  }

  function init() {
    bindCombatButtons();
    document.querySelectorAll('.close-btn').forEach(btn =>
      btn.addEventListener('click', () => Game.submitAction({ type: 'close' }))
    );
    _el('btn-priest-roll').addEventListener('click', () => Game.submitAction({ type: 'tile_confirm' }));
    _el('btn-loot-confirm').addEventListener('click', () => Game.submitAction({ type: 'loot_confirm' }));
    _el('btn-map-skip').addEventListener('click', () => Game.submitAction({ type: 'map_skip' }));
    _el('btn-setup-roll').addEventListener('click', () => {
      _el('btn-setup-roll').disabled = true;
      Game.submitAction({ type: 'setup_roll' });
    });
    _el('btn-teleport-cancel').addEventListener('click', () => Game.submitAction({ type: 'close' }));
    _el('btn-transmutation-cancel').addEventListener('click', () => {
      refreshSpellPanel(true);
    });

    _el('btn-curse-cancel').addEventListener('click', () => {
      refreshSpellPanel(true);
    });

    Game.on('item_used', () => {
      if (Game.getState().phase === Game.Phase.COMBAT) {
        refreshCombatConsumables();
        refreshCombatPlayerStats();
        refreshSpellPanel(Game.getState().pendingCombat?.combatSubPhase === 'player_attack');
      }
    });

    Game.on('heal_target_pending', data => showHealTargetModal(data));

    // Refresh master panel after skill purchase or enchant
    Game.on('skill_upgraded', () => {
      if (Game.getState().phase === Game.Phase.MASTER) {
        showMaster({});
        HUD.update({});
      }
    });
    Game.on('enchanted', () => {
      if (Game.getState().phase === Game.Phase.MASTER) {
        showMaster({});
        HUD.update({});
      }
    });

    Game.on('combat_update', data => {
      const logEl = _el('combat-log');
      if (!logEl) return;
      if (data.pvp) { pvpCombatUpdate(data); return; }
      const emitColor = data.logType === 'curse' ? '#c470e0'
                      : data.logType === 'bard'  ? '#ffd080'
                      : null;
      const frag = document.createDocumentFragment();
      (data.newLog ?? []).forEach(entry => {
        const d = document.createElement('div');
        if (entry !== null && typeof entry === 'object') {
          d.textContent = entry.text;
          d.style.color = entry.type === 'enchant' ? '#ff9944'
                        : entry.type === 'curse'   ? '#c470e0'
                        : entry.type === 'bard'    ? '#ffd080'
                        : '';
        } else {
          d.textContent = entry;
          if (emitColor) d.style.color = emitColor;
        }
        frag.insertBefore(d, frag.firstChild);   // newest line first, also within a batch
      });
      logEl.insertBefore(frag, logEl.firstChild);

      if (data.mob) {
        const mobHeartsEl = _el('combat-enemy-info')?.querySelector('.combat-hearts');
        if (mobHeartsEl) mobHeartsEl.textContent = `❤ ${data.mob.hearts.current}/${data.mob.hearts.max}`;
        refreshCombatMobStats(data.mob);
      }

      refreshCombatPlayerStats();
      refreshCombatConsumables();

      if (data.combatSubPhase) setCombatPhase(data.combatSubPhase);

      if (data.outcome === 'charisma_pending' && data.charismaResult) {
        showCharismaPicker(data.charismaResult);
      }

      if (data.deployedFriend) {
        const f = data.deployedFriend;
        const statusEl = _el('deployed-friend-status');
        if (statusEl) {
          statusEl.innerHTML =
            `👥 <strong>${f.name}</strong> ` +
            `❤ ${f.hearts.current}/${f.hearts.max}`;
        }
      }

      const player = Game.getCurrentPlayer();
      const magicBtn = document.querySelector('[data-type="M"]');
      if (magicBtn) magicBtn.disabled = !player.canAttackMagic();
      const bailBtn = _el('btn-bail');
      if (bailBtn) bailBtn.disabled = !player.canEscape();
      const runBtn = _el('btn-run');
      if (runBtn) runBtn.disabled = player.chainedTurns > 0;
    });

    // Show rolled stats in modal after game emits setup_rolled
    Game.on('setup_rolled', data => {
      const s = data.stats;
      const resultEl = _el('setup-roll-result');
      resultEl.innerHTML =
        `<table class="stats-table" style="margin:8px 0">
          <tr><td>STR</td><td>${s.F}</td><td>DEX</td><td>${s.D}</td></tr>
          <tr><td>ARM</td><td>${s.A}</td><td>MAG</td><td>${s.M}</td></tr>
          <tr><td>CHA</td><td>${s.C}</td><td>SPD</td><td>${s.V}</td></tr>
        </table>
        <p style="color:#ffd700">Starting item: ${data.item?.name ?? '—'}</p>`;
    });
  }

  // ── Phase dispatcher ──────────────────────────────────────────────────────
  function handlePhase(data) {
    hideAll();
    HUD.update(data);

    switch (data.phase) {
      case Game.Phase.SETUP_ROLL:
        showSetupRoll(data);
        break;
      case Game.Phase.COMBAT:
      case Game.Phase.PVP_COMBAT:
        showCombat(data);
        break;
      case Game.Phase.SHOP:
        showShop(data);
        break;
      case Game.Phase.MASTER:
        showMaster(data);
        break;
      case Game.Phase.PRIEST:
        showModal('modal-priest');
        _el('priest-result').textContent = '';
        break;
      case Game.Phase.CHEST:
        showChestChoice(data);
        break;
      case Game.Phase.MAP_CHOICE:
        showMapChoice(data);
        break;
      case Game.Phase.LOOT_CONFIRM:
        showLootModal(data);
        break;
      case Game.Phase.TELEPORT_CHOICE:
        showTeleportChoice(data);
        break;
      case Game.Phase.CLOAK_CHOICE:
        showCloakChoice(data);
        break;
      case Game.Phase.KING_BATTLE:
        KingPanel.show();
        break;
    }
  }

  // ── Setup roll ────────────────────────────────────────────────────────────
  function showSetupRoll(data) {
    showModal('modal-setup-roll');
    _el('setup-roll-who').textContent = `${data.player} — roll your starting stats and item`;
    _el('setup-roll-result').textContent = '';
    _el('btn-setup-roll').disabled = false;
  }

  // ── Combat ────────────────────────────────────────────────────────────────
  // Whose side the combat panel shows. Normally the current player; in a PvP duel the human
  // participant (the one the fight waits on if both are human), so you can defend out of turn.
  function inPvp() { return Game.getState().phase === Game.Phase.PVP_COMBAT && !!Game.getPvpView?.(); }
  function combatSelf() {
    if (!inPvp()) return Game.getCurrentPlayer();
    const view = Game.getPvpView(), st = Game.getState();
    const parts = view.players.map(v => st.players.find(p => p.id === v.id));
    return parts.find(p => !p.isBot && view.waitingFor.includes(p.id))
        ?? parts.find(p => !p.isBot)
        ?? Game.getCurrentPlayer();
  }
  function combatEnemy() {
    if (!inPvp()) return null;
    const me = combatSelf(), st = Game.getState();
    const other = Game.getPvpView().players.find(v => v.id !== me.id);
    return st.players.find(p => p.id === other.id);
  }

  // A player's stat cell: coloured when potions, blood, curses or blessings change it.
  // Player roll formula: stat + d6, so range is [eff+1, eff+6].
  function playerStatCell(p, k) {
    const eff = p.getStat(k);
    let fx = (p.tempBonuses?.[k] ?? 0) + (p.priestBuff ?? 0);
    for (const e of (p.statusEffects ?? [])) if (e.stat === k) fx += e.value ?? 0;
    const numStr = fx > 0 ? `<span style="color:#9eff9e;font-weight:bold">${eff}</span>`
                 : fx < 0 ? `<span style="color:#ff9e9e;font-weight:bold">${eff}</span>` : `${eff}`;
    return inPvp() ? `${numStr} <span style="color:#888;font-size:0.78em">[${eff + 1}~${eff + 6}]</span>` : numStr;
  }
  function playerStatsTable(p) {
    const c = k => playerStatCell(p, k);
    return `<tr><td>STR</td><td>${c('F')}</td><td>DEX</td><td>${c('D')}</td></tr>
       <tr><td>ARM</td><td>${c('A')}</td><td>MAG</td><td>${c('M')}</td></tr>
       <tr><td>CHA</td><td>${c('C')}</td><td>SPD</td><td>${c('V')}</td></tr>`;
  }
  // Map the duel state to the panel's sub-phases from *your* point of view.
  function pvpSubPhase() {
    const view = Game.getPvpView(), me = combatSelf();
    if (!view.waitingFor.includes(me.id)) return 'pvp_wait';
    return view.step === 'defend' ? 'mob_attack' : 'player_attack';
  }

  function showPvpCombat() {
    showModal('modal-combat');
    const me = combatSelf(), foe = combatEnemy(), view = Game.getPvpView();
    renderPvpSides(me, foe, view);
    const logEl = _el('combat-log');
    logEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    view.log.forEach(line => { const d = document.createElement('div'); d.textContent = line; frag.insertBefore(d, frag.firstChild); });
    logEl.insertBefore(frag, logEl.firstChild);
    _el('charisma-sub-swap')?.classList.add('hidden');
    _el('charisma-sub-stat')?.classList.add('hidden');
    _el('charisma-sub-trade')?.classList.add('hidden');
    _el('friend-picker')?.classList.add('hidden');
    _el('friend-fighting-ui')?.classList.add('hidden');
    _el('friend-defeat-ui')?.classList.add('hidden');
    pvpRefreshControls();
  }

  function renderPvpSides(me, foe, view) {
    const tag = (p, v) => [v.chained ? '🔗 chained' : null, v.smoke ? '💨 smoke' : null, p.hasPrincess ? '👑 princess' : null].filter(Boolean).join(' · ');
    const vOf = p => view.players.find(v => v.id === p.id);
    _el('combat-enemy-info').innerHTML =
      `<strong>${foe.name}</strong>${foe.isBot ? ' <span style="color:#888">(bot)</span>' : ''}
       <div class="combat-hearts">❤ ${foe.hearts.current}/${foe.hearts.max}</div>
       <div style="font-size:0.78em;color:#c8b8a0">${tag(foe, vOf(foe))}</div>
       <table class="stats-table">${playerStatsTable(foe)}</table>`;
    _el('combat-player-info').innerHTML =
      `<strong>${me.name}</strong>
       <div class="combat-hearts">❤ ${me.hearts.current}/${me.hearts.max}</div>
       <div style="font-size:0.78em;color:#c8b8a0">${tag(me, vOf(me))}</div>
       <table class="stats-table">${playerStatsTable(me)}</table>`;
  }

  function pvpRefreshControls() {
    const me = combatSelf(), view = Game.getPvpView();
    setCombatPhase(pvpSubPhase());
    refreshCombatConsumables();
    const magicBtn = document.querySelector('[data-type="M"]');
    if (magicBtn) magicBtn.disabled = !me.canAttackMagic();
    const chained = !!view.players.find(v => v.id === me.id)?.chained;
    _el('btn-bail').disabled = chained || !me.canEscape();
    _el('btn-run').disabled  = chained;
  }

  function pvpCombatUpdate(data) {
    const logEl = _el('combat-log');
    const frag = document.createDocumentFragment();
    (data.newLog ?? []).forEach(line => { const d = document.createElement('div'); d.textContent = line; frag.insertBefore(d, frag.firstChild); });
    logEl.insertBefore(frag, logEl.firstChild);
    if (!inPvp()) return;                       // fight over — next state_change closes the panel
    renderPvpSides(combatSelf(), combatEnemy(), Game.getPvpView());
    pvpRefreshControls();
  }

  // Compute effective mob stat (base + active status effects).
  function getMobEffectiveStat(mob, stat) {
    let v = mob.stats[stat] ?? 0;
    for (const e of (mob.statusEffects ?? [])) {
      if (e.stat === stat) v += e.value ?? 0;
    }
    return Math.max(0, v);
  }

  // Format a mob stat cell. Colors the value if it differs from base due to status effects.
  // Mob roll formula: stat − 3 + d6, so range is [eff−2, eff+3].
  function mobStatCell(base, eff) {
    const diff = eff - base;
    const numStr = diff > 0
      ? `<span style="color:#9eff9e;font-weight:bold">${eff}</span>`
      : diff < 0
      ? `<span style="color:#ff9e9e;font-weight:bold">${eff}</span>`
      : `${eff}`;
    return `${numStr} <span style="color:#888;font-size:0.78em">[${eff - 2}~${eff + 3}]</span>`;
  }

  function refreshCombatMobStats(mob) {
    if (!mob) return;
    const tableEl = _el('combat-enemy-info')?.querySelector('.stats-table');
    if (!tableEl) return;
    const s = (k) => mobStatCell(mob.stats[k] ?? 0, getMobEffectiveStat(mob, k));
    tableEl.innerHTML =
      `<tr><td>STR</td><td>${s('F')}</td><td>DEX</td><td>${s('D')}</td></tr>
       <tr><td>ARM</td><td>${s('A')}</td><td>MAG</td><td>${s('M')}</td></tr>
       <tr><td>CHA</td><td>${s('C')}</td><td>SPD</td><td>${s('V')}</td></tr>`;
  }

  function showCombat(data) {
    if (inPvp()) return showPvpCombat();
    showModal('modal-combat');
    const player = Game.getCurrentPlayer();
    const mob    = data.mob ?? data.defender;

    const ms = mob ? (k) => mobStatCell(mob.stats[k] ?? 0, getMobEffectiveStat(mob, k)) : null;
    _el('combat-enemy-info').innerHTML = mob
      ? `<strong>${mob.name}</strong>
         <div class="combat-hearts">❤ ${mob.hearts.current}/${mob.hearts.max}</div>
         <table class="stats-table">
           <tr><td>STR</td><td>${ms('F')}</td><td>DEX</td><td>${ms('D')}</td></tr>
           <tr><td>ARM</td><td>${ms('A')}</td><td>MAG</td><td>${ms('M')}</td></tr>
           <tr><td>CHA</td><td>${ms('C')}</td><td>SPD</td><td>${ms('V')}</td></tr>
         </table>`
      : '';

    _el('combat-player-info').innerHTML =
      `<strong>${player.name}</strong>
       <div class="combat-hearts">❤ ${player.hearts.current}/${player.hearts.max}</div>
       <table class="stats-table">
         <tr><td>STR</td><td>${player.getStat('F')}</td><td>DEX</td><td>${player.getStat('D')}</td></tr>
         <tr><td>ARM</td><td>${player.getStat('A')}</td><td>MAG</td><td>${player.getStat('M')}</td></tr>
         <tr><td>CHA</td><td>${player.getStat('C')}</td><td>SPD</td><td>${player.getStat('V')}</td></tr>
       </table>`;

    // Consumable items the player can use (non-equipment)
    refreshCombatConsumables();

    // Populate initial fight log (Kryss + initiative lines, maybe mob's first attack)
    const logEl = _el('combat-log');
    logEl.innerHTML = '';
    const initFrag = document.createDocumentFragment();
    (data.fightLog ?? []).forEach(entry => {
      const d = document.createElement('div');
      if (entry !== null && typeof entry === 'object') {
        d.textContent = entry.text;
        d.style.color = entry.type === 'enchant' ? '#ff9944'
                      : entry.type === 'curse'   ? '#c470e0'
                      : entry.type === 'bard'    ? '#ffd080'
                      : '';
      } else {
        d.textContent = entry;
      }
      initFrag.insertBefore(d, initFrag.firstChild);   // newest line first
    });
    logEl.insertBefore(initFrag, logEl.firstChild);

    setCombatPhase(data.combatSubPhase ?? 'player_attack');

    // Reset picker state for new fight
    _el('charisma-sub-swap')?.classList.add('hidden');
    _el('charisma-sub-stat')?.classList.add('hidden');
    _el('charisma-sub-trade')?.classList.add('hidden');
    _el('friend-picker')?.classList.add('hidden');
    _el('friend-fighting-ui')?.classList.add('hidden');
    _el('friend-defeat-ui')?.classList.add('hidden');
    refreshSpellPanel(data.combatSubPhase !== 'mob_attack');

    const magicBtn = document.querySelector('[data-type="M"]');
    if (magicBtn) magicBtn.disabled = !player.canAttackMagic();
    _el('btn-bail').disabled = !player.canEscape();
    _el('btn-run').disabled  = player.chainedTurns > 0;
  }

  function bindCombatButtons() {
    document.querySelectorAll('.attack-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const attackType = btn.dataset.type;
        if (attackType === 'C') {
          Game.submitAction({ type: 'bard' }); // roll first; charisma picker appears after result
        } else {
          // M uses base magic (no spell); spells are clicked directly in the right panel
          Game.submitAction({ type: 'attack', attackType });
        }
      });
    });

    _el('btn-run').addEventListener('click', () => {
      Game.submitAction({ type: 'run' });
    });

    _el('btn-bail').addEventListener('click', () => {
      const player  = combatSelf();
      const hasShoes = player.hasEquipped('stealth_shoes');
      const hasRope  = player.hasItem('rope');
      const hasInvis = player.hasItem('sp_invisibility');

      if (hasShoes) {
        Game.submitAction({ type: 'bail', method: 'stealth_shoes' });
      } else if (hasRope && hasInvis) {
        showBailPicker([
          { method: 'rope',           label: '🪢 Rope (consumed)' },
          { method: 'sp_invisibility', label: '🌫 Invisibility (consumed)' },
        ]);
      } else if (hasRope) {
        Game.submitAction({ type: 'bail', method: 'rope' });
      } else if (hasInvis) {
        Game.submitAction({ type: 'bail', method: 'sp_invisibility' });
      } else {
        Game.submitAction({ type: 'bail' });
      }
    });

    _el('btn-defend').addEventListener('click', () => {
      Game.submitAction({ type: 'defend' });
    });

    _el('btn-deploy-friend').addEventListener('click', showFriendPicker);

    _el('btn-friend-picker-cancel').addEventListener('click', () => {
      _el('friend-picker').classList.add('hidden');
    });

    _el('btn-friend-next-round').addEventListener('click', () => {
      Game.submitAction({ type: 'friend_round' });
    });

    _el('btn-friend-take-over').addEventListener('click', () => {
      _el('friend-defeat-ui').classList.add('hidden');
      Game.submitAction({ type: 'friend_take_over' });
    });

    _el('btn-friend-deploy-next').addEventListener('click', () => {
      _el('friend-defeat-ui').classList.add('hidden');
      showFriendPicker();
    });
  }

  function setCombatPhase(subPhase) {
    const isWait       = subPhase === 'pvp_wait';
    const isAttack     = subPhase === 'player_attack';
    const isCha        = subPhase === 'charisma_pick';
    const isFriendFight = subPhase === 'friend_fighting';
    const isFriendDied  = subPhase === 'friend_died';
    const friendMode   = isFriendFight || isFriendDied;

    const attackBtns = _el('combat-attack-buttons');
    const defendBtns = _el('combat-defend-buttons');
    const phaseLabel = _el('combat-phase-label');

    if (attackBtns) attackBtns.classList.toggle('hidden', !isAttack);
    const defendBtn = _el('btn-defend');
    if (defendBtn) defendBtn.disabled = isAttack || isCha || friendMode || isWait;

    let label = isAttack ? 'YOUR ATTACK' : isCha ? 'CHARISMA'
      : isFriendFight ? 'FRIEND FIGHTING' : isFriendDied ? 'FRIEND FELL' : isWait ? "OPPONENT'S MOVE" : 'DEFEND';
    if (subPhase === 'mob_attack' && inPvp()) {
      const pa = Game.getPvpView().pendingAttack;
      const names = { F:'STR', D:'DEX', M:'MAG' };
      if (pa) label = `DEFEND vs ${names[pa.attackType] ?? pa.attackType}${pa.spellId ? ' + ' + (getItem(pa.spellId)?.name ?? '') : ''}`;
    }
    if (phaseLabel) phaseLabel.textContent = label;

    // Manage right column content
    if (!isCha) refreshSpellPanel(isAttack); // spell panel enabled only on player_attack
    if (!isFriendFight) _el('friend-fighting-ui')?.classList.add('hidden');
    if (!isFriendDied)  _el('friend-defeat-ui')?.classList.add('hidden');

    // Show/hide deploy-friend button (no companions in duels)
    if (isAttack && !inPvp()) {
      const player = Game.getCurrentPlayer();
      const btn = _el('btn-deploy-friend');
      if (btn) btn.classList.toggle('hidden', !(player?.friendsList?.length > 0));
    } else {
      _el('btn-deploy-friend')?.classList.add('hidden');
    }

    if (isFriendFight) _el('friend-fighting-ui')?.classList.remove('hidden');
    if (isFriendDied) {
      const defeatUi = _el('friend-defeat-ui');
      if (defeatUi) defeatUi.classList.remove('hidden');
      const deployNext = _el('btn-friend-deploy-next');
      if (deployNext) {
        const player = Game.getCurrentPlayer();
        deployNext.classList.toggle('hidden', !(player?.friendsList?.length > 0));
      }
    }
  }

  function showFriendPicker() {
    const player  = Game.getCurrentPlayer();
    const friends = player?.friendsList ?? [];
    const picker  = _el('friend-picker');
    const list    = _el('friend-list');
    list.innerHTML = '';

    if (!friends.length) {
      picker.classList.add('hidden');
      return;
    }

    friends.forEach(friend => {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:4px 6px;background:#1a3a4a;color:#eee;border:1px solid #7df;' +
        'border-radius:3px;cursor:pointer;font-size:0.82em;text-align:left';
      btn.innerHTML =
        `<strong>${friend.name}</strong> ` +
        `<span style="color:#aaa">❤ ${friend.hearts.current}/${friend.hearts.max}</span>`;
      btn.addEventListener('click', () => {
        picker.classList.add('hidden');
        Game.submitAction({ type: 'deploy_friend', uid: friend.uid });
      });
      list.appendChild(btn);
    });

    picker.classList.remove('hidden');
  }

  // ── Combat extra panel helpers ────────────────────────────────────────────
  // Switch which panel is visible inside #combat-extra.
  function showExtraPanel(panelId) {
    ['spell-panel', 'charisma-picker', 'transmutation-picker', 'curse-picker'].forEach(id => {
      _el(id)?.classList.toggle('hidden', id !== panelId);
    });
  }

  // Rebuild the permanent spell list. enabled=true during player_attack, false otherwise.
  function refreshSpellPanel(enabled) {
    const player = combatSelf();
    const list   = _el('spell-list');
    if (!player || !list) return;
    list.innerHTML = '';

    const spellIds = player.inventory.filter(id => getItem(id)?.subtype === 'attack');

    if (!spellIds.length) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#555;font-size:0.78em;font-style:italic;margin-bottom:4px';
      msg.textContent = 'No attack spells';
      list.appendChild(msg);
    } else {
      stackItems(spellIds).forEach(({ id, count }) => {
        const spell = getItem(id);
        const btn   = document.createElement('button');
        btn.textContent =
          `${spell.name} (+${spell.magicValue}M)${spell.effect ? ' ✦' : ''}` +
          (count > 1 ? ` ×${count}` : '');
        btn.disabled = !enabled;
        btn.addEventListener('click', () => {
          btn.disabled = true; // prevent double-submit
          Game.submitAction({ type: 'attack', attackType: 'M', spellId: id });
        });
        list.appendChild(btn);
      });
    }

    showExtraPanel('spell-panel');
  }

  function showCharismaPicker(charismaResult) {
    const { diff, playerRoll, mobC, pendingLoot } = charismaResult;
    const picker = _el('charisma-picker');
    const player = Game.getCurrentPlayer();

    _el('charisma-sub-swap').classList.add('hidden');
    _el('charisma-sub-stat').classList.add('hidden');
    _el('charisma-sub-trade').classList.add('hidden');
    showExtraPanel('charisma-picker');

    const sign = diff >= 0 ? '+' : '';
    _el('charisma-roll-result').textContent =
      `🎵 Roll: ${playerRoll} vs C=${mobC} → diff ${sign}${diff}`;

    const optionsEl = _el('charisma-options');
    optionsEl.innerHTML = '';

    if (diff >= 1) {
      const btn = _chaBtn('← Retreat', '#555', () => {
        Game.submitAction({ type: 'charisma_outcome', retreat: true });
      });
      btn.style.marginBottom = '5px';
      optionsEl.appendChild(btn);
    }

    if (diff < 3) {
      if (diff < 1) {
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#666;font-size:0.8em;margin-top:4px';
        msg.textContent = 'No options available';
        optionsEl.appendChild(msg);
      }
      return;
    }

    const maxTier = diff >= 7 ? 3 : diff >= 5 ? 2 : 1;
    const hasRattle = player?.hasEquipped('cursed_rattle');

    const families = [
      { key:'friendly', label:'Friendly', color:'#3a8a3a', options:[
        { tier:1, label:'Gift',     desc:'Random drop from mob, end encounter' },
        { tier:2, label:'Heal',     desc:'+1 heart, end encounter' },
        { tier:3, label:'Befriend', desc:'Mob joins your friends list' },
      ]},
      { key:'mock', label:'Mock', color:'#8a3a8a', options:[
        { tier:1, label:'Swap Stats', desc:'Swap two mob stats for d6 turns',
          click: () => _chaSwapPicker(picker) },
        { tier:2, label:'Malus', desc:'Apply d6 stat malus to mob for d6 turns',
          click: () => _chaStatPicker('malus', picker) },
        { tier:3, label:'Bonus', desc:'Gain d6 stat bonus for d6 turns',
          click: () => _chaStatPicker('bonus', picker) },
      ]},
      { key:'deceive', label:'Deceive', color:'#8a5a00', options:[
        { tier:1, label:'Steal',       desc:'d6×3 coins, end encounter' },
        { tier:2, label:'Steal More',  desc:'d6×5 coins, end encounter' },
        { tier:3, label:'Grand Heist', desc:'d6×8 coins, end encounter' },
      ]},
      { key:'respect', label:'Respect', color:'#006a8a', options:[
        { tier:1, label:'Trade', desc:'Exchange items with the mob, end encounter',
          click: () => _chaTradePicker(picker, pendingLoot) },
        { tier:2, label:'Quest', desc:'Receive a quest, end encounter' },
        { tier:3, label:'Learn', desc:'+1 random stat (max 8), end encounter' },
      ]},
      ...(hasRattle && maxTier >= 3 ? [{ key:'kill', label:'Kill (Rattle)', color:'#8a1a1a', options:[
        { tier:1, label:'Execute', desc:'Instantly kill the enemy' },
      ]}] : []),
    ];

    families.forEach(fam => {
      const section = document.createElement('div');
      section.style.cssText =
        `border:1px solid ${fam.color};border-radius:3px;padding:3px;margin-bottom:3px`;

      const hdr = document.createElement('div');
      hdr.style.cssText = `color:${fam.color};font-size:0.75em;font-weight:bold;margin-bottom:2px`;
      hdr.textContent = fam.label;
      section.appendChild(hdr);

      fam.options.filter(o => o.tier <= maxTier).forEach(opt => {
        const btn = document.createElement('button');
        btn.style.cssText =
          'width:100%;text-align:left;padding:3px 5px;background:#1a1a3a;color:#eee;' +
          'border:1px solid #444;border-radius:3px;cursor:pointer;margin-bottom:2px;font-size:0.8em';
        btn.innerHTML =
          `<strong>${opt.label}</strong> <span style="color:#888">${opt.desc}</span>`;
        btn.addEventListener('click', () => {
          if (opt.click) {
            opt.click();
          } else {
            Game.submitAction({ type:'charisma_outcome', family:fam.key, tier:opt.tier });
          }
        });
        section.appendChild(btn);
      });

      optionsEl.appendChild(section);
    });
  }

  function _chaBtn(text, bg, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText =
      `display:block;width:100%;padding:3px;background:${bg};color:#fff;` +
      'border:none;border-radius:3px;cursor:pointer;font-size:0.8em';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function _chaSwapPicker(charismaPicker) {
    const stats  = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const sub    = _el('charisma-sub-swap');
    const list   = _el('charisma-swap-list');
    sub.classList.remove('hidden');
    let firstStat = null;

    const render = (exclude) => {
      list.innerHTML = '';
      _el('charisma-swap-title').textContent =
        exclude ? `Swap ${labels[exclude]} with:` : 'Swap which mob stat first?';
      stats.filter(s => s !== exclude).forEach(s => {
        const btn = document.createElement('button');
        btn.textContent = labels[s];
        btn.style.cssText =
          'padding:3px;background:#2a3a5a;color:#fff;border:1px solid #7af;' +
          'border-radius:3px;cursor:pointer;font-size:0.8em';
        btn.addEventListener('click', () => {
          if (!firstStat) { firstStat = s; render(s); }
          else {
            sub.classList.add('hidden');
            Game.submitAction({ type:'charisma_outcome', family:'mock', tier:1,
                                stat1:firstStat, stat2:s });
          }
        });
        list.appendChild(btn);
      });
    };
    render(null);

    _el('btn-charisma-swap-cancel').onclick = () => {
      sub.classList.add('hidden'); firstStat = null;
    };
  }

  function _chaStatPicker(mode, charismaPicker) {
    const stats  = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const sub    = _el('charisma-sub-stat');
    const list   = _el('charisma-stat-list');
    sub.classList.remove('hidden');
    _el('charisma-stat-title').textContent =
      mode === 'malus' ? 'Apply malus to which mob stat?' : 'Gain bonus to which stat?';
    const tier = mode === 'malus' ? 2 : 3;
    list.innerHTML = '';
    stats.forEach(s => {
      const btn = document.createElement('button');
      btn.textContent = labels[s];
      btn.style.cssText =
        'padding:3px;background:#2a3a5a;color:#fff;border:1px solid #7af;' +
        'border-radius:3px;cursor:pointer;font-size:0.8em';
      btn.addEventListener('click', () => {
        sub.classList.add('hidden');
        Game.submitAction({ type:'charisma_outcome', family:'mock', tier, stat:s });
      });
      list.appendChild(btn);
    });
    _el('btn-charisma-stat-cancel').onclick = () => sub.classList.add('hidden');
  }

  function _chaTradePicker(charismaPicker, pendingLoot) {
    const sub        = _el('charisma-sub-trade');
    const mobListEl  = _el('charisma-trade-mob-list');
    const plrListEl  = _el('charisma-trade-player-list');
    sub.classList.remove('hidden');
    mobListEl.innerHTML = '';
    plrListEl.innerHTML = '';

    let selMob = null;
    let selPlr = null;

    const BASE  = 'display:block;width:100%;text-align:left;padding:2px 4px;background:#1a1a3a;' +
                  'color:#eee;border:1px solid #444;border-radius:2px;cursor:pointer;font-size:0.75em;margin-bottom:2px';
    const SELCT = 'display:block;width:100%;text-align:left;padding:2px 4px;background:#2a4a2a;' +
                  'color:#5f5;border:1px solid #5f5;border-radius:2px;cursor:pointer;font-size:0.75em;margin-bottom:2px';

    const makeTradeBtn = (label, listEl, onSel) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = BASE;
      btn.addEventListener('click', () => {
        onSel();
        listEl.querySelectorAll('button').forEach(b => b.style.cssText = BASE);
        btn.style.cssText = SELCT;
      });
      listEl.appendChild(btn);
    };

    if (!pendingLoot.items.length) {
      mobListEl.innerHTML = '<em style="color:#666;font-size:0.75em">nothing</em>';
    } else {
      [...new Set(pendingLoot.items)].forEach(id =>
        makeTradeBtn(getItem(id)?.name ?? id, mobListEl, () => { selMob = id; })
      );
      makeTradeBtn('(nothing)', mobListEl, () => { selMob = null; });
    }

    const player  = Game.getCurrentPlayer();
    const invIds  = [...new Set(player.inventory.filter(id => getItem(id)?.buyPrice))];
    if (!invIds.length) {
      plrListEl.innerHTML = '<em style="color:#666;font-size:0.75em">nothing to offer</em>';
    } else {
      invIds.forEach(id =>
        makeTradeBtn(getItem(id)?.name ?? id, plrListEl, () => { selPlr = id; })
      );
      makeTradeBtn('(nothing)', plrListEl, () => { selPlr = null; });
    }

    _el('btn-charisma-trade-confirm').onclick = () => {
      sub.classList.add('hidden');
      Game.submitAction({ type:'charisma_outcome', family:'respect', tier:1,
                          mobItemId:selMob, playerItemId:selPlr });
    };
    _el('btn-charisma-trade-cancel').onclick = () => sub.classList.add('hidden');
  }

  // Refresh the player stat block inside the combat panel (hearts + all stats).
  // Call this after any item use or combat step so temp bonuses are visible.
  function refreshCombatPlayerStats() {
    const player = combatSelf();
    if (!player) return;
    const infoEl = _el('combat-player-info');
    if (!infoEl) return;
    const heartsEl = infoEl.querySelector('.combat-hearts');
    const tableEl  = infoEl.querySelector('.stats-table');
    if (heartsEl) heartsEl.textContent = `❤ ${player.hearts.current}/${player.hearts.max}`;
    if (tableEl) tableEl.innerHTML = playerStatsTable(player);   // potion/curse effects coloured
  }

  // ── Bail picker ───────────────────────────────────────────────────────────
  function showBailPicker(options) {
    const picker = _el('bail-picker');
    const list   = _el('bail-picker-list');
    list.innerHTML = '';
    options.forEach(({ method, label }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'padding:6px 10px;background:#2a3a5a;color:#ffd;border:1px solid #7af;border-radius:4px;cursor:pointer;text-align:left';
      btn.addEventListener('click', () => {
        picker.classList.add('hidden');
        Game.submitAction({ type: 'bail', method });
      });
      list.appendChild(btn);
    });
    picker.classList.remove('hidden');
  }

  // ── Transmutation picker ──────────────────────────────────────────────────
  function showTransmutationPicker() {
    const title = _el('transmutation-picker-title');
    title.textContent = 'Pick first stat';
    renderTransmutationStats(null, from => {
      title.textContent = `Swap ${from} with:`;
      renderTransmutationStats(from, to => {
        refreshSpellPanel(true);
        Game.submitAction({ type: 'transmute', from, to });
      });
    });
    showExtraPanel('transmutation-picker');
  }

  function showCursePicker() {
    const stats  = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const list   = _el('curse-stat-list');
    list.innerHTML = '';
    stats.forEach(s => {
      const btn = document.createElement('button');
      btn.textContent = labels[s];
      btn.style.cssText = 'padding:4px 6px;background:#3a1a3a;color:#fff;border:1px solid #c060c0;border-radius:4px;cursor:pointer';
      btn.addEventListener('click', () => {
        showExtraPanel('spell-panel');
        Game.submitAction({ type: 'use_curse', stat: s });
      });
      list.appendChild(btn);
    });
    showExtraPanel('curse-picker');
  }

  function renderTransmutationStats(exclude, onSelect) {
    const stats  = ['F','D','A','M','C','V'];
    const labels = { F:'STR', D:'DEX', A:'ARM', M:'MAG', C:'CHA', V:'SPD' };
    const list   = _el('transmutation-stat-list');
    list.innerHTML = '';
    stats.filter(s => s !== exclude).forEach(s => {
      const btn = document.createElement('button');
      btn.textContent = labels[s];
      btn.style.cssText = 'padding:4px 6px;background:#2a3a5a;color:#fff;border:1px solid #aaa;border-radius:4px;cursor:pointer';
      btn.addEventListener('click', () => onSelect(s));
      list.appendChild(btn);
    });
  }

  // ── Combat consumables ────────────────────────────────────────────────────
  const NON_COMBAT_IDS       = new Set(['sp_invisibility','sp_teleport','sp_disenchant']);
  const NON_COMBAT_OBJ_TYPES = new Set(['escape','prevent_escape','fast_travel','choose_category','place_trap']);

  function refreshCombatConsumables() {
    const player = combatSelf();
    const pvp = inPvp() ? Game.getPvpView() : null;
    const consEl = _el('combat-consumable-list');
    if (!consEl) return;
    consEl.innerHTML = '';
    const usableIds = player.inventory.filter(id => {
      const item = getItem(id);
      if (!item) return false;
      if (item.slot)    return false; // equipment
      if (item.subtype) return false; // attack/defense spells
      if (NON_COMBAT_IDS.has(id)) return false;
      // Duels: a Chain stops the opponent escaping (on your move, if they aren't chained yet)
      if (id === 'chain' && pvp) return pvp.step === 'act' && !pvp.players.find(v => v.id !== player.id)?.chained;
      if (typeof item.effect === 'object' && NON_COMBAT_OBJ_TYPES.has(item.effect?.type)) return false;
      return item.effect || item.statBonus;
    });
    stackItems(usableIds).forEach(({ id, count }) => {
      const item  = getItem(id);
      const label = (item?.name ?? id) + (count > 1 ? ` ×${count}` : '');
      const div   = document.createElement('div');
      div.className = 'combat-consumable';
      if (id === 'sp_transmutation') {
        div.innerHTML = `<span>${label}</span>
          <button class="inv-equip-btn">Transmute</button>`;
        div.querySelector('button').addEventListener('click', showTransmutationPicker);
      } else if (id === 'sp_curse') {
        const alreadyUsed = pvp ? false : !!Game.getState().pendingCombat?.curseUsedThisTurn;
        div.innerHTML = `<span>${label}</span>
          <button class="inv-equip-btn" ${alreadyUsed ? 'disabled' : ''}>Curse</button>`;
        if (!alreadyUsed) div.querySelector('button').addEventListener('click', showCursePicker);
      } else {
        div.innerHTML = `<span>${label}</span>
          <button class="inv-equip-btn"
            onclick="Game.submitAction({type:'use_item',itemId:'${id}'})">Use</button>`;
      }
      consEl.appendChild(div);
    });
    if (!consEl.children.length) consEl.innerHTML = '<em style="color:#666">none</em>';
  }

  // ── Loot confirm ──────────────────────────────────────────────────────────
  function showLootModal(data) {
    showModal('modal-loot');
    _el('loot-description').textContent = data.description ?? '';
    HUD.update(data);
  }

  // ── Shop ──────────────────────────────────────────────────────────────────
  function refreshShop() {
    showShop({ guildType: currentShopGuildType });
    HUD.update({});
  }

  function showShop(data) {
    currentShopGuildType = data.guildType ?? null;
    showModal('modal-shop');
    const player    = Game.getCurrentPlayer();
    const guildType = data.guildType;

    const shopHeader = _el('modal-shop').querySelector('h2');
    if (shopHeader) shopHeader.innerHTML =
      `Shop <span style="float:right;color:#ffd700">💰 ${player.coins}</span>`;

    // Resolve shop stock for the current tile
    const shopPos   = Game.getState().currentShopPosition;
    const shopStock = shopPos
      ? (Game.getState().shopStocks[`${shopPos.x},${shopPos.y}`] ?? null)
      : null;

    let catalog;
    if (guildType === 'assassin') {
      catalog = SPECIAL_EQUIPMENT.filter(i => i.guild === 'assassin');
    } else if (guildType === 'thief') {
      catalog = SPECIAL_EQUIPMENT.filter(i => i.guild === 'thief');
    } else {
      catalog = [...EQUIPMENT, ...POTIONS, ...OBJECTS];
    }

    const buyList = _el('shop-buy-list');
    buyList.innerHTML = '';
    catalog.forEach(item => {
      if (shopStock && shopStock[item.id] === undefined) return; // not stocked at this shop
      const qty        = shopStock?.[item.id] ?? null;
      const inStock    = qty === null || qty > 0;
      const affordable = inStock && player.coins >= (item.buyPrice ?? 0);
      const effDesc    = specialItemEffectDesc(item.effect);
      const sbDesc     = statBonusDesc(item);
      const descParts  = [sbDesc, effDesc].filter(Boolean).join(' · ');
      const stockBadge = qty !== null && inStock
        ? ` <em style="color:#666;font-size:0.75em">(${qty})</em>` : '';
      const div = document.createElement('div');
      div.className = `shop-item ${!inStock ? 'sold-out' : affordable ? '' : 'too-expensive'}`;
      div.innerHTML =
        `<span>${item.name}${descParts ? `<br><em style="font-size:0.8em;color:#aaa">${descParts}</em>` : ''}</span>
         <span>${item.buyPrice}💰${stockBadge}</span>
         <button data-id="${item.id}" ${inStock && affordable ? '' : 'disabled'}>${inStock ? 'Buy' : 'Sold'}</button>`;
      if (inStock) {
        div.querySelector('button').addEventListener('click', () =>
          Game.submitAction({ type: 'buy', itemId: item.id })
        );
      }
      buyList.appendChild(div);
    });

    const sellList = _el('shop-sell-list');
    sellList.innerHTML = '';

    // Equipped items (shown first, with enchantment info)
    const equippedSlots = ['strength','dexterity','magic','charisma','speed','armor','shield'];
    equippedSlots.forEach(slot => {
      const equip = player.equipped[slot];
      if (!equip) return;
      const item = getItem(equip.id);
      if (!item?.buyPrice) return;
      const price    = sellPrice(item);
      const enchName = equip.enchantment?.name ?? equip.enchantment?.id ?? null;
      const enchSpan = enchName
        ? ` <em style="color:#c9a0ff;font-size:0.8em">✦ ${enchName}</em>` : '';
      const lvlData  = item.guild ? player.guildItemLevels?.[equip.id] : null;
      const lvlSpan  = lvlData ? ` <span style="color:#ffd700;font-size:0.8em">[Lv.${lvlData.itemLevel}]</span>` : '';
      const div = document.createElement('div');
      div.className = 'shop-item';
      div.innerHTML =
        `<span>${item.name}${lvlSpan}${enchSpan} <span style="color:#666;font-size:0.75em">[eq]</span></span>
         <span>${price}💰</span>
         <button>Sell</button>`;
      div.querySelector('button').addEventListener('click', () =>
        Game.submitAction({ type: 'sell', itemId: equip.id })
      );
      sellList.appendChild(div);
    });

    // Inventory items (alphabetically sorted)
    const sellableIds = player.inventory
      .filter(id => getItem(id)?.buyPrice)
      .sort((a, b) => (getItem(a)?.name ?? a).localeCompare(getItem(b)?.name ?? b));
    stackItems(sellableIds).forEach(({ id, count }) => {
      const item    = getItem(id);
      const price   = sellPrice(item);
      const lvlData = item?.guild ? player.guildItemLevels?.[id] : null;
      const lvlSpan = lvlData ? ` <span style="color:#ffd700;font-size:0.8em">[Lv.${lvlData.itemLevel}]</span>` : '';
      const div   = document.createElement('div');
      div.className = 'shop-item';
      div.innerHTML =
        `<span>${item.name}${lvlSpan}${count > 1 ? ` ×${count}` : ''}</span>
         <span>${price}💰</span>
         <button data-id="${id}">Sell</button>`;
      div.querySelector('button').addEventListener('click', () =>
        Game.submitAction({ type: 'sell', itemId: id })
      );
      sellList.appendChild(div);
    });
  }

  // ── Master ────────────────────────────────────────────────────────────────
  function showMaster(data) {
    showModal('modal-master');
    const player   = Game.getCurrentPlayer();
    const statKeys = ['F','D','A','M','C','V'];
    const statLabels = { F:'Strength', D:'Dexterity', A:'Armor', M:'Magic', C:'Charisma', V:'Speed' };

    const masterHeader = _el('modal-master').querySelector('h2');
    if (masterHeader) masterHeader.innerHTML =
      `Master <span style="float:right;color:#ffd700">💰 ${player.coins}</span>`;

    // Skill upgrades (flat 50 coins, max 5 total purchases, cap at 6)
    const masterBought = player.masterSkillsBought ?? 0;
    const masterRemain = 5 - masterBought;
    const skillEl = _el('master-skills');
    skillEl.innerHTML =
      `<h3>Buy Skill Point — 50💰 each</h3>
       <div style="color:#aaa;font-size:0.8em;margin-bottom:6px">
         Master purchases: ${masterBought}/5 used — ${masterRemain} remaining
       </div>`;
    statKeys.forEach(stat => {
      const cur      = player.baseStats[stat];
      const atStatCap = cur >= 6;
      const atBuyCap  = masterRemain <= 0;
      const btn = document.createElement('button');
      btn.disabled = atStatCap || atBuyCap || player.coins < 50;
      btn.innerHTML = atStatCap
        ? `${statLabels[stat]} (${cur}) — MAX`
        : atBuyCap
          ? `${statLabels[stat]} (${cur}) — LIMIT REACHED`
          : `${statLabels[stat]} (${cur} → ${cur + 1}) — 50💰`;
      btn.addEventListener('click', () => Game.submitAction({ type: 'buy_skill', stat }));
      skillEl.appendChild(btn);
    });

    // Enchantments
    const enchEl = _el('master-enchant');
    enchEl.innerHTML = '<h3>Enchant Equipment</h3>';
    ENCHANTMENTS.forEach(ench => {
      const slots = ['strength','dexterity','magic','charisma','speed','armor','shield']
        .filter(s => player.equipped[s] && !player.equipped[s].enchantment);
      if (!slots.length) return;
      const cost    = ench.cost ?? 50;
      const effDesc = enchantEffectDesc(ench);
      const div     = document.createElement('div');
      div.innerHTML =
        `<strong>${ench.name}</strong> — ${cost}💰` +
        (effDesc ? ` <em style="color:#aaa;font-size:0.85em">(${effDesc})</em>` : '');
      slots.forEach(slot => {
        const btn = document.createElement('button');
        btn.disabled = player.coins < cost;
        btn.textContent = `→ ${slot}`;
        btn.addEventListener('click', () =>
          Game.submitAction({ type: 'enchant', slot, enchantId: ench.id, tier: 1 })
        );
        div.appendChild(btn);
      });
      enchEl.appendChild(div);
    });

    // Master also sells spells
    const buyEl = _el('master-buy-list');
    buyEl.innerHTML = '<h3>Buy Spells / Magical Items</h3>';
    const gs = Game.getState();
    const MASTER_LIMITED_KEYS = {
      sp_smoke: { stockKey: 'masterSmokeStock', resetKey: 'masterSmokeStockResetTurn' },
      sp_curse: { stockKey: 'masterCurseStock', resetKey: 'masterCurseStockResetTurn' },
    };
    function getMasterStock(itemId) {
      const keys = MASTER_LIMITED_KEYS[itemId];
      if (!keys) return null;
      const restocked = gs.turnNumber - gs[keys.resetKey] >= 15;
      const avail     = restocked ? 10 : gs[keys.stockKey];
      const turns     = restocked ? 0  : 15 - (gs.turnNumber - gs[keys.resetKey]);
      return { avail, turns, soldOut: avail <= 0 };
    }
    [...COMBAT_SPELLS, ...UTILITY_SPELLS].forEach(item => {
      const limited    = getMasterStock(item.id);
      const soldOut    = limited?.soldOut ?? false;
      const affordable = !soldOut && player.coins >= (item.buyPrice ?? 0);
      const desc = spellDesc(item);
      const stockInfo = limited
        ? (soldOut
            ? `<em style="color:#c66;font-size:0.75em">Sold out — restocks in ${limited.turns} turn${limited.turns !== 1 ? 's' : ''}</em>`
            : `<em style="color:#888;font-size:0.75em">${limited.avail}/10 in stock</em>`)
        : `<em style="color:#555;font-size:0.75em">∞ in stock</em>`;
      const div = document.createElement('div');
      div.className = `shop-item ${soldOut ? 'sold-out' : affordable ? '' : 'too-expensive'}`;
      div.innerHTML =
        `<span>${item.name}${desc ? `<br><em style="font-size:0.75em;color:#888">${desc}</em>` : ''}<br>${stockInfo}</span>
         <span>${item.buyPrice}💰</span>
         <button ${affordable ? '' : 'disabled'}>${soldOut ? 'Sold' : 'Buy'}</button>`;
      if (!soldOut) {
        div.querySelector('button').addEventListener('click', () =>
          Game.submitAction({ type: 'buy', itemId: item.id })
        );
      }
      buyEl.appendChild(div);
    });
  }

  function refreshMaster() {
    showMaster({});
    HUD.update({});
  }

  // ── Map choice ────────────────────────────────────────────────────────────
  function showChestChoice(data) {
    showModal('modal-chest-choice');
    const LABELS = ['Empty', 'Small coins (d6×3)', 'Consumable', 'Big coins (d6×10)', 'Tier 1-2 item', 'Tier 3-6 item'];
    const container = _el('chest-choice-buttons');
    container.innerHTML = '';
    for (const roll of (data.rolls ?? [])) {
      const btn = document.createElement('button');
      btn.style.cssText = 'flex:1;padding:12px 8px;background:#2a2a4a;color:#ffd700;border:1px solid #ffd700;border-radius:4px;cursor:pointer;font-size:0.9em;text-align:center';
      btn.innerHTML = `<strong>${roll}</strong><br><span style="color:#ccc;font-size:0.85em">${LABELS[roll - 1] ?? ''}</span>`;
      btn.addEventListener('click', () => Game.submitAction({ type: 'chest_pick', value: roll }));
      container.appendChild(btn);
    }
  }

  function showMapChoice(data) {
    showModal('modal-map');
    const tt = data.tileType; // numeric TileType constant

    const LABELS = {
      [TileType.CHEST]:        ['Empty', 'Small coins', 'Consumable', 'Big coins', 'Tier 1-2 item', 'Tier 3-6 item'],
      [TileType.RANDOM_EVENT]: ['Weak mob', 'Weak mob', 'Strong mob', 'Lose coins', 'Find coins', 'Find item'],
      [TileType.PRIEST]:       ['+1 STR', '+1 DEX', '+1 ARM', '+1 MAG', '+1 CHA', '+1 SPD'],
      [TileType.WORK]:         ['×1 (min)', '×2', '×3', '×4', '×5', '×6 (max)'],
    };

    const HINTS = {
      [TileType.CHEST]:        'Choose what the chest contains:',
      [TileType.RANDOM_EVENT]: 'Choose what you encounter:',
      [TileType.PRIEST]:       'Choose which stat the priest blesses:',
      [TileType.WORK]:         'Choose your work roll multiplier:',
      [TileType.MINIBOSS]:     'Choose which enemy to face:',
    };

    if (tt === TileType.MINIBOSS) {
      const tier = data.minibossTier ?? 1;
      const pool = MOBS.getByTier(tier).filter(m => !m.isBoss);
      LABELS[TileType.MINIBOSS] = pool.slice(0, 6).map(m => m.name);
    }

    _el('map-choice-hint').textContent = HINTS[tt] ?? 'Choose your roll:';
    const labels = LABELS[tt] ?? null;

    const container = _el('map-choice-buttons');
    container.innerHTML = '';
    for (let i = 1; i <= 6; i++) {
      const btn = document.createElement('button');
      btn.style.cssText = 'padding:6px 4px;background:#2a2a4a;color:#ffd700;border:1px solid #ffd700;border-radius:4px;cursor:pointer;font-size:0.8em;text-align:center';
      btn.innerHTML = `<strong>${i}</strong>${labels ? '<br><span style="color:#ccc;font-size:0.85em">' + labels[i - 1] + '</span>' : ''}`;
      btn.addEventListener('click', () => Game.submitAction({ type: 'map_roll', value: i }));
      container.appendChild(btn);
    }
  }

  // ── Cloak choice (Invisibility Cloak on MINIBOSS tile) ───────────────────
  function showCloakChoice(data) {
    const mob = data.mob;
    showModal('modal-cloak-choice');
    _el('cloak-mob-name').textContent = mob ? mob.name : 'an enemy';
    function closeCloakModal() {
      _el('modal-cloak-choice').classList.add('hidden');
      if (!document.querySelectorAll('.modal:not(.hidden)').length)
        _el('overlay').classList.add('hidden');
    }
    _el('btn-cloak-fight').onclick = () => { closeCloakModal(); Game.submitAction({ type: 'cloak_fight' }); };
    _el('btn-cloak-sneak').onclick = () => { closeCloakModal(); Game.submitAction({ type: 'cloak_sneak' }); };
  }

  // ── Teleport choice ──────────────────────────────────────────────────────
  function showTeleportChoice(data) {
    showModal('modal-teleport');
    const destList = _el('teleport-dest-list');
    destList.innerHTML = '';
    const TILE_NAMES = {
      [TileType.SHOP]:          '🏪 Shop',
      [TileType.MASTER]:        '⚗ Master',
      [TileType.GUILD_ASSASSIN]:'🗡 Assassin Guild',
      [TileType.GUILD_THIEF]:   '🔓 Thief Guild',
    };
    (data.destinations ?? []).forEach(dest => {
      const btn = document.createElement('button');
      btn.style.cssText = 'padding:8px 12px;background:#2a2a4a;color:#ffd700;border:1px solid #ffd700;border-radius:4px;cursor:pointer;text-align:left';
      btn.textContent = `${TILE_NAMES[dest.tileType] ?? 'Destination'} (${dest.x}, ${dest.y})`;
      btn.addEventListener('click', () => Game.submitAction({ type: 'teleport_confirm', dest }));
      destList.appendChild(btn);
    });
  }

  // ── Game over ─────────────────────────────────────────────────────────────
  function showGameOver(data) {
    hideAll();
    showModal('modal-gameover');
    _el('gameover-message').textContent = data.winner
      ? `${data.winner} wins!`
      : 'Everyone has fallen.';

    const recap = _el('gameover-recap');
    recap.innerHTML = '';
    const summary = SpectateStats.isActive() ? SpectateStats.getRunSummary() : null;
    if (data.winner && SpectateStats.isActive()) {
      recap.appendChild(SpectateStats.renderRecap(data.winner));
    }

    // Guild weapon mastery section
    const guildDiv = _el('gameover-guild');
    guildDiv.innerHTML = '';
    if (summary) {
      const rows = [];
      Object.entries(summary.players).forEach(([name, pd]) => {
        pd.guildLevelSix.forEach(g => {
          rows.push({ name, ...g });
        });
      });
      if (rows.length > 0) {
        const title = document.createElement('div');
        title.className = 'recap-section-title guild-mastery-title';
        title.textContent = 'Guild Weapon Mastery';
        guildDiv.appendChild(title);
        const list = document.createElement('div');
        list.className = 'guild-mastery-list';
        rows.forEach(r => {
          const row = document.createElement('div');
          row.className = 'guild-mastery-row';
          row.innerHTML =
            `<span class="milestone-turn">Turn\u00a0${r.turn}</span>` +
            `<span class="guild-mastery-name">${r.name}</span>` +
            `<span class="guild-mastery-item">${r.itemName}</span>` +
            `<span class="guild-mastery-stat">${r.stat}\u00a0=\u00a06</span>`;
          list.appendChild(row);
        });
        guildDiv.appendChild(list);
      }
    }

    // Save section
    _buildSaveSection(_el('gameover-save'), data, summary);
  }

  function _buildSaveSection(container, data, summary) {
    container.innerHTML = '';

    const runNum = (parseInt(localStorage.getItem('dandd_run_count') ?? '0', 10) + 1);

    const nameRow = document.createElement('div');
    nameRow.className = 'save-name-row';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'save-label';
    nameLabel.textContent = `Run #${runNum} — name:`;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'run-name-input';
    nameInput.placeholder = 'optional';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    container.appendChild(nameRow);

    const commentLabel = document.createElement('div');
    commentLabel.className = 'save-label';
    commentLabel.textContent = 'Notes:';
    container.appendChild(commentLabel);

    const textarea = document.createElement('textarea');
    textarea.className = 'run-comment';
    textarea.rows = 4;
    textarea.placeholder = 'Write your thoughts about this run…';
    container.appendChild(textarea);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-save-run';
    saveBtn.textContent = `Save Run #${runNum}`;
    saveBtn.addEventListener('click', () => {
      _saveRunToFile(data, summary, runNum, nameInput.value.trim(), textarea.value.trim());
      saveBtn.textContent = 'Saved!';
      saveBtn.disabled = true;
    });
    container.appendChild(saveBtn);
  }

  function _saveRunToFile(data, summary, runNum, runName, comment) {
    const record = {
      runNumber: runNum,
      runName: runName || null,
      winner: data.winner ?? null,
      comment: comment || null,
      ...(summary ?? {}),
    };

    const safeName = runName
      ? `_${runName.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      : '';
    const fileName = `danger_and_dice_run_${runNum}${safeName}.json`;

    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `wins/${fileName}`;
    a.click();
    URL.revokeObjectURL(url);

    localStorage.setItem('dandd_run_count', String(runNum));
  }

  // ── Heal target modal ─────────────────────────────────────────────────────
  function showHealTargetModal(data) {
    showModal('modal-heal-target');
    const list = _el('heal-target-list');
    list.innerHTML = '';

    function pick(target) {
      Game.submitAction({ type: 'heal_target', target });
      _el('modal-heal-target').classList.add('hidden');
      const anyVisible = document.querySelectorAll('.modal:not(.hidden)').length > 0;
      if (!anyVisible) _el('overlay').classList.add('hidden');
    }

    // Player option
    const playerBtn = document.createElement('button');
    playerBtn.className = 'heal-target-btn';
    playerBtn.innerHTML = `<strong>${data.player}</strong> <span class="heal-target-hp">❤ ${data.playerHearts.current}/${data.playerHearts.max}</span>`;
    playerBtn.addEventListener('click', () => pick('player'));
    list.appendChild(playerBtn);

    // Friend options
    data.friends.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'heal-target-btn';
      btn.innerHTML = `<strong>${f.name}</strong> <span class="heal-target-hp">❤ ${f.current}/${f.max}</span>`;
      btn.addEventListener('click', () => pick(f.uid));
      list.appendChild(btn);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showModal(id) {
    _el('overlay').classList.remove('hidden');
    _el(id).classList.remove('hidden');
  }

  function hideAll() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    _el('overlay').classList.add('hidden');
    if (typeof KingPanel !== 'undefined') KingPanel.hide();
  }

  function _el(id) { return document.getElementById(id); }

  return { init, handlePhase, showGameOver, refreshShop, refreshMaster };
})();
