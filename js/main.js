// Bootstrap — wires together Game engine, UI, and player input.

(function () {
  const $ = id => document.getElementById(id);

  // ── Setup screen ──────────────────────────────────────────────────────────
  $('btn-start').addEventListener('click', () => {
    const slots    = document.querySelectorAll('.player-slot');
    const players  = [];

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

    Renderer.init($('map-canvas'));
    HUD.init();
    Panels.init();
    bindGameEvents();
    Game.init(players);   // emits state_change after listeners are set up
    Renderer.draw();
  });

  // Enable/disable optional player slots
  document.querySelectorAll('.player-active').forEach(cb => {
    cb.addEventListener('change', () => {
      const slot = cb.closest('.player-slot');
      slot.querySelector('.player-name').disabled = !cb.checked;
      slot.querySelector('.player-bot').disabled  = !cb.checked;
    });
  });

  // ── Game event bindings ───────────────────────────────────────────────────
  function bindGameEvents() {

    Game.on('state_change', data => {
      HUD.update(data);
      Panels.handlePhase(data);
      Renderer.draw();

      // Auto-trigger for bots
      if (data.phase === Game.Phase.SETUP_ROLL) {
        const st = Game.getState();
        const setupPlayer = st.players[st.setupRollIdx];
        if (setupPlayer?.isBot) {
          setTimeout(() => Game.submitAction({ type: 'setup_roll' }), 600);
        }
      } else if (data.phase === Game.Phase.LOOT_CONFIRM) {
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => Game.submitAction({ type: 'loot_confirm' }), 600);
        }
      } else {
        // Handles ROLL_MOVE, MOVING, COMBAT (initial trigger), CHEST, etc.
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => BotAI.takeTurn(player), 600);
        }
      }
    });

    Game.on('log', data => {
      HUD.appendLog(data.message);
    });

    Game.on('player_moved', () => Renderer.draw());
    Game.on('combat_victory', () => Renderer.draw());
    Game.on('player_defeated', () => Renderer.draw());
    Game.on('dragon_defeated', () => Renderer.draw());

    // Bot chaining for interactive combat
    Game.on('combat_update', data => {
      if (data.outcome === 'ongoing') {
        const player = Game.getCurrentPlayer();
        if (player?.isBot) {
          setTimeout(() => BotAI.takeTurn(player), 400);
        }
      }
    });

    Game.on('shop_transaction', () => {
      const phase = Game.getState().phase;
      if (phase === Game.Phase.SHOP) {
        Panels.refreshShop();
      } else if (phase === Game.Phase.MASTER) {
        Panels.refreshMaster();
      }
    });

    Game.on('item_equipped',   () => HUD.update({}));
    Game.on('item_unequipped', () => HUD.update({}));
    Game.on('item_used',       () => HUD.update({}));

    $('btn-open-inventory').addEventListener('click', () => HUD.openInventoryPopup());
    $('btn-close-inventory').addEventListener('click', () => HUD.closeInventoryPopup());

    Game.on('game_over', data => {
      Panels.showGameOver(data);
    });

    // Roll button (also ends turn when stop-blocked)
    $('btn-roll').addEventListener('click', () => {
      const phase = Game.getState().phase;
      if (phase === Game.Phase.ROLL_MOVE) {
        Game.submitAction({ type: 'roll' });
      } else if (phase === Game.Phase.STOP_BLOCKED) {
        Game.submitAction({ type: 'tile_confirm' });
      }
    });

    // Canvas click → move
    $('map-canvas').addEventListener('click', e => {
      const dest = Renderer.tileAt(e.offsetX, e.offsetY);
      if (dest && Game.getState().phase === Game.Phase.MOVING) {
        Game.submitAction({ type: 'move', dest });
      }
    });
  }

  // ── Restart ───────────────────────────────────────────────────────────────
  $('btn-restart').addEventListener('click', () => {
    location.reload();
  });

})();
