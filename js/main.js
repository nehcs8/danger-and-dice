// Bootstrap — wires together Game engine, UI, and player input.

(function () {
  const $ = id => document.getElementById(id);

  // KingPanel is available immediately (standalone mode, before game start)
  KingPanel.init();

  // ── King's Hall standalone mode ──────────────────────────────────────────
  $('btn-king-standalone').addEventListener('click', () => {
    $('screen-setup').classList.remove('active');
    KingPanel.startStandalone();
  });
  $('btn-king-play-again').addEventListener('click', () => {
    KingBattle.clearState();
    KingPanel.startStandalone();
  });
  $('btn-king-back-menu').addEventListener('click', () => {
    KingBattle.clearState();
    KingPanel.hide();
    $('screen-setup').classList.add('active');
  });

  // Returns the current bot action delay in ms, scaled by an optional factor.
  // In spectate mode the speed buttons control this; otherwise fixed at 600 ms.
  function botDelay(factor) {
    const base = SpectateStats.isActive() ? SpectateStats.getDelay() : 600;
    return factor !== undefined ? Math.round(base * factor) : base;
  }

  // ── Setup screen ──────────────────────────────────────────────────────────
  let selectedDifficulty = 'medium';

  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('diff-active'));
      btn.classList.add('diff-active');
      selectedDifficulty = btn.dataset.diff;
    });
  });

  $('btn-start').addEventListener('click', () => {
    const slots   = document.querySelectorAll('.player-slot');
    const players = [];

    slots.forEach((slot, i) => {
      const activeBox = slot.querySelector('.player-active');
      if (activeBox && !activeBox.checked) return; // optional slot not enabled
      const name  = slot.querySelector('.player-name').value.trim() || `Player ${i + 1}`;
      const isBot = slot.querySelector('.player-bot').checked;
      players.push({ id: `p${i}`, name, isBot });
    });

    if (players.length < 1) return;

    $('screen-setup').classList.remove('active');
    $('screen-game').classList.add('active');

    // Show difficulty in top bar
    const diffEl = $('top-bar-difficulty');
    if (diffEl) {
      const labels = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD' };
      const colors = { easy: '#6bff6b', medium: '#ffd700', hard: '#ff6b6b' };
      diffEl.textContent = labels[selectedDifficulty] ?? selectedDifficulty.toUpperCase();
      diffEl.style.color       = colors[selectedDifficulty] ?? '#aaa';
      diffEl.style.borderColor = colors[selectedDifficulty] ?? '#333';
    }

    Renderer.init($('map-canvas'));
    HUD.init();
    Panels.init();
    bindGameEvents();
    Game.init(players, selectedDifficulty);
    Activity.init();
    Renderer.draw();

    // Stats tracking always active; speed controls only revealed in all-bot spectate mode
    SpectateStats.init(players);
    if (players.every(p => p.isBot)) {
      document.querySelectorAll('.spectate-only').forEach(el => el.classList.remove('hidden'));
    }
  });

  // Enable/disable optional player slots
  document.querySelectorAll('.player-active').forEach(cb => {
    cb.addEventListener('change', () => {
      const slot = cb.closest('.player-slot');
      slot.querySelector('.player-name').disabled = !cb.checked;
      slot.querySelector('.player-bot').disabled  = !cb.checked;
    });
  });

  // Spectate bar controls (safe to bind before game starts — SpectateStats guards internally)
  document.querySelectorAll('.speed-btn').forEach(btn =>
    btn.addEventListener('click', () => SpectateStats.setSpeed(+btn.dataset.delay))
  );
  $('btn-spectate-stats').addEventListener('click', () => SpectateStats.openStatsModal());
  $('btn-spectate-close').addEventListener('click', () => SpectateStats.closeStatsModal());

  // ── Game event bindings ───────────────────────────────────────────────────
  function bindGameEvents() {

    Game.on('state_change', data => {
      HUD.update(data);
      Panels.handlePhase(data);
      Renderer.draw();

      // Always update the top-bar turn counter on every new player turn
      if (data.phase === Game.Phase.ROLL_MOVE) {
        const el = $('spectate-turn');
        if (el) el.textContent = `Turn ${Game.getState().round}`;
      }

      // Auto-trigger for bots
      if (data.phase === Game.Phase.SETUP_ROLL) {
        const st = Game.getState();
        const setupPlayer = st.players[st.setupRollIdx];
        if (setupPlayer?.isBot) {
          setTimeout(() => Game.submitAction({ type: 'setup_roll' }), botDelay());
        }
      } else if (data.phase === Game.Phase.LOOT_CONFIRM) {
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => Game.submitAction({ type: 'loot_confirm' }), botDelay());
        }
      } else {
        // Handles ROLL_MOVE, MOVING, COMBAT (initial trigger), CHEST, PRIEST, etc.
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => BotAI.takeTurn(player), botDelay());
        }
      }
    });

    Game.on('player_moved',    () => Renderer.draw());
    Game.on('combat_victory',  () => Renderer.draw());
    Game.on('player_defeated', () => Renderer.draw());
    Game.on('dragon_defeated', () => Renderer.draw());

    // PvP duels use the normal combat panel; the opponent may be a bot acting out of turn
    Game.on('pvp_update', data => {
      if (data.outcome === 'ongoing' && typeof BotAI.pvpTick === 'function') {
        setTimeout(() => BotAI.pvpTick(), botDelay(0.67));
      }
    });

    // Bot chaining for interactive combat (ongoing turns + charisma outcome picks)
    Game.on('combat_update', data => {
      if (data.outcome === 'ongoing' || data.outcome === 'charisma_pending') {
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
        }
      }
    });

    Game.on('shop_transaction', () => {
      const phase  = Game.getState().phase;
      const player = Game.getCurrentPlayer();
      if (phase === Game.Phase.SHOP) {
        Panels.refreshShop();
        if (player?.isBot) setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
      } else if (phase === Game.Phase.MASTER) {
        Panels.refreshMaster();
        if (player?.isBot) setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
      }
    });

    // Re-trigger bot after equip/unequip so it can continue its shopping sequence
    Game.on('item_equipped', () => {
      HUD.update({});
      const player = Game.getCurrentPlayer();
      const phase  = Game.getState().phase;
      if (player?.isBot && (phase === Game.Phase.SHOP || phase === Game.Phase.MASTER)) {
        setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
      }
    });
    Game.on('item_unequipped', () => {
      HUD.update({});
      const player = Game.getCurrentPlayer();
      const phase  = Game.getState().phase;
      if (player?.isBot && (phase === Game.Phase.SHOP || phase === Game.Phase.MASTER)) {
        setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
      }
    });

    // Re-trigger bot after skill upgrades and enchants
    Game.on('skill_upgraded', () => {
      const player = Game.getCurrentPlayer();
      if (player?.isBot) setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
    });
    Game.on('enchanted', () => {
      const player = Game.getCurrentPlayer();
      if (player?.isBot) setTimeout(() => BotAI.takeTurn(player), botDelay(0.67));
    });

    Game.on('item_used', () => HUD.update({}));

    Game.on('xp_levelup', () => HUD.update({}));

    $('btn-open-inventory').addEventListener('click', () => HUD.openInventoryPopup());
    $('btn-close-inventory').addEventListener('click', () => HUD.closeInventoryPopup());

    Game.on('game_over', data => {
      HUD.update({ phase: Game.Phase.GAME_OVER });
      Renderer.draw();
      Panels.showGameOver(data);
    });
    $('btn-view-map').addEventListener('click', () => Panels.hideGameOver());
    $('btn-show-results').addEventListener('click', () => Panels.reopenGameOver());

    // Roll button (also ends turn when stop-blocked)
    function doRoll() {
      const phase = Game.getState().phase;
      if (phase === Game.Phase.ROLL_MOVE) {
        Game.submitAction({ type: 'roll' });
      } else if (phase === Game.Phase.STOP_BLOCKED) {
        Game.submitAction({ type: 'tile_confirm' });
      }
    }
    $('btn-roll').addEventListener('click', doRoll);
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();

      // First check if loot confirmation popup is visible
      const lootModal = $('modal-loot');
      if (lootModal && !lootModal.classList.contains('hidden')) {
        const lootBtn = $('btn-loot-confirm');
        if (lootBtn) {
          lootBtn.click();
          return;
        }
      }

      // Otherwise, handle roll button
      doRoll();
    });

    // Canvas click → move
    $('map-canvas').addEventListener('click', e => {
      const dest = Renderer.tileAt(e.offsetX, e.offsetY);
      if (dest && Game.getState().phase === Game.Phase.MOVING) {
        Game.submitAction({ type: 'move', dest });
      }
    });

    // Boss tile hover tooltip
    const tooltip = $('tile-tooltip');

    function bossItemLabel(entry) {
      if (entry.rollForStat) {
        const qty = entry.count > 1 ? `${entry.count}× ` : '';
        return `• ${qty}Potion +${entry.potionValue} (random stat)`;
      }
      const item   = getItem(entry.itemId);
      let   name   = item?.name ?? entry.itemId;
      // Append stat annotation for equippable items (slot-based) that don't
      // already encode stats in their name (DROPS include them in the name).
      if (item?.slot && item.statBonus) {
        const stats = Object.entries(item.statBonus)
          .map(([s, v]) => `${v}${s}`)
          .join(' ');
        name += ` (${stats})`;
      }
      const qty = entry.count > 1 ? `${entry.count}× ` : '';
      return `• ${qty}${name}`;
    }

    $('map-canvas').addEventListener('mousemove', e => {
      // player token → detail card
      const who = Renderer.playerAt(e.offsetX, e.offsetY);
      Activity.hoverToken(who, e.clientX, e.clientY);
      if (who) { tooltip.style.display = 'none'; return; }
      const coords = Renderer.coordsAt(e.offsetX, e.offsetY);
      if (!coords || MapGrid.get(coords.x, coords.y) !== TileType.BOSS) {
        tooltip.style.display = 'none';
        return;
      }
      const td  = MapGrid.getTileData(coords.x, coords.y);
      const mob = MOBS.getMob(td.bossId);
      if (!mob) { tooltip.style.display = 'none'; return; }

      const dropLines = mob.lootTable.map(bossItemLabel);
      if (mob.id === 'dragon') {
        dropLines.push('• Princess appears');
        dropLines.push('• 100d6 coins');
      } else if (mob.coinDice > 0) {
        dropLines.push(`• ${mob.coinDice}d6 coins`);
      }

      tooltip.innerHTML =
        `<strong>${mob.name}</strong><br>` +
        `<span style="color:#aaa;font-size:0.85em">Drops:</span><br>` +
        dropLines.join('<br>');
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY + 14) + 'px';
    });
    $('map-canvas').addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      Activity.hoverToken(null);
    });
  }

  // ── Restart ───────────────────────────────────────────────────────────────
  $('btn-restart').addEventListener('click', () => {
    location.reload();
  });

})();
