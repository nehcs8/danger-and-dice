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
      case 'kryss':           return 'Roll >3 at fight start: enemy −1 heart before combat';
      case 'skip_miniboss':   return 'Can pass through miniboss tiles without fighting';
      case 'magic_no_spell':  return 'Can use magic attacks without owning a spell';
      case 'charisma_damage': return 'Charisma successes deal 1 damage to the enemy';
      case 'dex_first':       return 'DEX attacks always go first regardless of initiative';
      case 'always_escape':   return 'Can always escape from combat (reusable)';
      case 'coins_plus3':     return '+3 coins added to every enemy kill reward';
      case 'double_chest':    return 'Roll chest twice, keep the better result';
      case 'all_drops':       return 'All loot items drop in double quantity';
      case 'bard_lv2_free':   return 'Unlock tier-2 charisma options without the diff requirement';
      case 'coins_times3':    return 'Coins earned from kills are tripled';
      case 'pass_obstacles':  return 'Can walk secret paths without Compass';
      default: return '';
    }
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
      sp_curse:         'Unknown effect',
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
      _el('transmutation-picker').classList.add('hidden');
    });

    Game.on('item_used', () => {
      if (Game.getState().phase === Game.Phase.COMBAT) {
        refreshCombatConsumables();
        refreshCombatPlayerStats();
      }
    });

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
      (data.newLog ?? []).forEach(line => {
        const d = document.createElement('div');
        d.textContent = line;
        logEl.appendChild(d);
      });
      logEl.scrollTop = logEl.scrollHeight;

      const mobHeartsEl = _el('combat-enemy-info')?.querySelector('.combat-hearts');
      if (mobHeartsEl && data.mob) {
        mobHeartsEl.textContent = `❤ ${data.mob.hearts.current}/${data.mob.hearts.max}`;
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
      case Game.Phase.MAP_CHOICE:
        showMapChoice(data);
        break;
      case Game.Phase.LOOT_CONFIRM:
        showLootModal(data);
        break;
      case Game.Phase.TELEPORT_CHOICE:
        showTeleportChoice(data);
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
  // Format a mob stat with its roll base (stat − 3) in small text.
  function mobStatCell(val) {
    const base = val - 3;
    return `${val} <span style="color:#888;font-size:0.78em">(${base >= 0 ? '+' : ''}${base})</span>`;
  }

  function showCombat(data) {
    showModal('modal-combat');
    const player = Game.getCurrentPlayer();
    const mob    = data.mob ?? data.defender;

    _el('combat-enemy-info').innerHTML = mob
      ? `<strong>${mob.name}</strong>
         <div class="combat-hearts">❤ ${mob.hearts.current}/${mob.hearts.max}</div>
         <table class="stats-table">
           <tr><td>STR</td><td>${mobStatCell(mob.stats.F)}</td><td>DEX</td><td>${mobStatCell(mob.stats.D)}</td></tr>
           <tr><td>ARM</td><td>${mobStatCell(mob.stats.A)}</td><td>MAG</td><td>${mobStatCell(mob.stats.M)}</td></tr>
           <tr><td>CHA</td><td>${mobStatCell(mob.stats.C)}</td><td>SPD</td><td>${mobStatCell(mob.stats.V)}</td></tr>
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
    (data.fightLog ?? []).forEach(line => {
      const d = document.createElement('div');
      d.textContent = line;
      logEl.appendChild(d);
    });
    logEl.scrollTop = logEl.scrollHeight;

    setCombatPhase(data.combatSubPhase ?? 'player_attack');

    // Reset picker state for new fight
    _el('charisma-picker')?.classList.add('hidden');
    _el('charisma-sub-swap')?.classList.add('hidden');
    _el('charisma-sub-stat')?.classList.add('hidden');
    _el('charisma-sub-trade')?.classList.add('hidden');
    _el('friend-picker')?.classList.add('hidden');
    _el('friend-fighting-ui')?.classList.add('hidden');
    _el('friend-defeat-ui')?.classList.add('hidden');

    const magicBtn = document.querySelector('[data-type="M"]');
    if (magicBtn) magicBtn.disabled = !player.canAttackMagic();
    _el('btn-bail').disabled = !player.canEscape();
  }

  function bindCombatButtons() {
    document.querySelectorAll('.attack-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const attackType = btn.dataset.type;
        if (attackType === 'M') {
          showSpellPicker();
        } else if (attackType === 'C') {
          Game.submitAction({ type: 'bard' }); // roll first; picker appears after result
        } else {
          Game.submitAction({ type: 'attack', attackType });
        }
      });
    });

    _el('btn-bail').addEventListener('click', () => {
      const player  = Game.getCurrentPlayer();
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
    const isAttack     = subPhase === 'player_attack';
    const isCha        = subPhase === 'charisma_pick';
    const isFriendFight = subPhase === 'friend_fighting';
    const isFriendDied  = subPhase === 'friend_died';
    const friendMode   = isFriendFight || isFriendDied;

    const attackBtns = _el('combat-attack-buttons');
    const defendBtns = _el('combat-defend-buttons');
    const phaseLabel = _el('combat-phase-label');

    if (attackBtns) attackBtns.classList.toggle('hidden', !isAttack);
    if (defendBtns) defendBtns.classList.toggle('hidden', isAttack || isCha || friendMode);

    const label = isAttack ? 'YOUR ATTACK' : isCha ? 'CHARISMA'
      : isFriendFight ? 'FRIEND FIGHTING' : isFriendDied ? 'FRIEND FELL' : 'DEFEND';
    if (phaseLabel) phaseLabel.textContent = label;

    if (!isCha)        _el('charisma-picker')?.classList.add('hidden');
    if (!isFriendFight) _el('friend-fighting-ui')?.classList.add('hidden');
    if (!isFriendDied)  _el('friend-defeat-ui')?.classList.add('hidden');

    // Show/hide deploy-friend button
    if (isAttack) {
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

  function showSpellPicker() {
    const player = Game.getCurrentPlayer();
    const spells = player.inventory
      .map(id => getItem(id))
      .filter(i => i?.subtype === 'attack');

    const picker = _el('spell-picker');
    const list   = _el('spell-list');
    list.innerHTML = '';

    if (!spells.length && !player.hasEquipped('cursed_ring')) {
      Game.submitAction({ type: 'attack', attackType: 'M', spellId: null });
      return;
    }

    spells.forEach(spell => {
      const btn = document.createElement('button');
      btn.textContent = `${spell.name} (+${spell.magicValue}M)${spell.effect ? ' ✦' : ''}`;
      btn.addEventListener('click', () => {
        Game.submitAction({ type: 'attack', attackType: 'M', spellId: spell.id });
        picker.classList.add('hidden');
      });
      list.appendChild(btn);
    });

    const noSpell = document.createElement('button');
    noSpell.textContent = 'No spell (base M only)';
    noSpell.addEventListener('click', () => {
      Game.submitAction({ type: 'attack', attackType: 'M', spellId: null });
      picker.classList.add('hidden');
    });
    list.appendChild(noSpell);
    picker.classList.remove('hidden');
  }

  function showCharismaPicker(charismaResult) {
    const { diff, playerRoll, mobC, pendingLoot } = charismaResult;
    const picker = _el('charisma-picker');

    _el('charisma-sub-swap').classList.add('hidden');
    _el('charisma-sub-stat').classList.add('hidden');
    _el('charisma-sub-trade').classList.add('hidden');

    const sign = diff >= 0 ? '+' : '';
    _el('charisma-roll-result').textContent =
      `🎵 Roll: ${playerRoll} vs C=${mobC} → diff ${sign}${diff}`;

    const optionsEl = _el('charisma-options');
    optionsEl.innerHTML = '';

    if (diff >= 1) {
      const btn = _chaBtn('← Retreat', '#555', () => {
        picker.classList.add('hidden');
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
      picker.classList.remove('hidden');
      return;
    }

    const maxTier = diff >= 7 ? 3 : diff >= 5 ? 2 : 1;

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
            picker.classList.add('hidden');
            Game.submitAction({ type:'charisma_outcome', family:fam.key, tier:opt.tier });
          }
        });
        section.appendChild(btn);
      });

      optionsEl.appendChild(section);
    });

    picker.classList.remove('hidden');
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
            charismaPicker.classList.add('hidden');
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
        charismaPicker.classList.add('hidden');
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
      charismaPicker.classList.add('hidden');
      Game.submitAction({ type:'charisma_outcome', family:'respect', tier:1,
                          mobItemId:selMob, playerItemId:selPlr });
    };
    _el('btn-charisma-trade-cancel').onclick = () => sub.classList.add('hidden');
  }

  // Refresh the player stat block inside the combat panel (hearts + all stats).
  // Call this after any item use or combat step so temp bonuses are visible.
  function refreshCombatPlayerStats() {
    const player = Game.getCurrentPlayer();
    if (!player) return;
    const infoEl = _el('combat-player-info');
    if (!infoEl) return;
    const heartsEl = infoEl.querySelector('.combat-hearts');
    const tableEl  = infoEl.querySelector('.stats-table');
    if (heartsEl) heartsEl.textContent = `❤ ${player.hearts.current}/${player.hearts.max}`;
    if (tableEl) tableEl.innerHTML =
      `<tr><td>STR</td><td>${player.getStat('F')}</td><td>DEX</td><td>${player.getStat('D')}</td></tr>
       <tr><td>ARM</td><td>${player.getStat('A')}</td><td>MAG</td><td>${player.getStat('M')}</td></tr>
       <tr><td>CHA</td><td>${player.getStat('C')}</td><td>SPD</td><td>${player.getStat('V')}</td></tr>`;
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
    const picker = _el('transmutation-picker');
    const title  = _el('transmutation-picker-title');
    title.textContent = 'Transmutation: pick first stat';
    renderTransmutationStats(null, from => {
      title.textContent = `Swap ${from} with:`;
      renderTransmutationStats(from, to => {
        picker.classList.add('hidden');
        Game.submitAction({ type: 'transmute', from, to });
      });
    });
    picker.classList.remove('hidden');
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
  const NON_COMBAT_IDS       = new Set(['sp_invisibility','sp_teleport','sp_disenchant','sp_curse']);
  const NON_COMBAT_OBJ_TYPES = new Set(['escape','prevent_escape','fast_travel','choose_category','place_trap']);

  function refreshCombatConsumables() {
    const player = Game.getCurrentPlayer();
    const consEl = _el('combat-consumable-list');
    if (!consEl) return;
    consEl.innerHTML = '';
    const usableIds = player.inventory.filter(id => {
      const item = getItem(id);
      if (!item) return false;
      if (item.slot)    return false; // equipment
      if (item.subtype) return false; // attack/defense spells
      if (NON_COMBAT_IDS.has(id)) return false;
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
      const affordable = player.coins >= (item.buyPrice ?? 0);
      const effDesc    = specialItemEffectDesc(item.effect);
      const div = document.createElement('div');
      div.className = `shop-item ${affordable ? '' : 'too-expensive'}`;
      div.innerHTML =
        `<span>${item.name}${effDesc ? `<br><em style="font-size:0.8em;color:#aaa">${effDesc}</em>` : ''}</span>
         <span>${item.buyPrice}💰</span>
         <button data-id="${item.id}" ${affordable ? '' : 'disabled'}>Buy</button>`;
      div.querySelector('button').addEventListener('click', () =>
        Game.submitAction({ type: 'buy', itemId: item.id })
      );
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
      const div = document.createElement('div');
      div.className = 'shop-item';
      div.innerHTML =
        `<span>${item.name}${enchSpan} <span style="color:#666;font-size:0.75em">[eq]</span></span>
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
      const item  = getItem(id);
      const price = sellPrice(item);
      const div   = document.createElement('div');
      div.className = 'shop-item';
      div.innerHTML =
        `<span>${item.name}${count > 1 ? ` ×${count}` : ''}</span>
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

    // Skill upgrades (flat 50 coins, cap at 6)
    const skillEl = _el('master-skills');
    skillEl.innerHTML = '<h3>Buy Skill Point — 50💰 each (max 6)</h3>';
    statKeys.forEach(stat => {
      const cur    = player.baseStats[stat];
      const capped = cur >= 6;
      const btn    = document.createElement('button');
      btn.disabled = capped || player.coins < 50;
      btn.innerHTML = capped
        ? `${statLabels[stat]} (${cur}) — MAX`
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
    [...COMBAT_SPELLS, ...UTILITY_SPELLS].forEach(item => {
      const affordable = player.coins >= (item.buyPrice ?? 0);
      const desc = spellDesc(item);
      const div = document.createElement('div');
      div.className = `shop-item ${affordable ? '' : 'too-expensive'}`;
      div.innerHTML =
        `<span>${item.name}${desc ? `<br><em style="font-size:0.75em;color:#888">${desc}</em>` : ''}</span>
         <span>${item.buyPrice}💰</span>
         <button ${affordable ? '' : 'disabled'}>Buy</button>`;
      div.querySelector('button').addEventListener('click', () =>
        Game.submitAction({ type: 'buy', itemId: item.id })
      );
      buyEl.appendChild(div);
    });
  }

  function refreshMaster() {
    showMaster({});
    HUD.update({});
  }

  // ── Map choice ────────────────────────────────────────────────────────────
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
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showModal(id) {
    _el('overlay').classList.remove('hidden');
    _el(id).classList.remove('hidden');
  }

  function hideAll() {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    _el('overlay').classList.add('hidden');
  }

  function _el(id) { return document.getElementById(id); }

  return { init, handlePhase, showGameOver, refreshShop, refreshMaster };
})();
