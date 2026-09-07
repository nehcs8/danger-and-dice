// Bot AI — rule-based agent. Slot-in replacement for a neural network later.
// All decisions go through chooseCombatAction(player, mob) and takeTurn(player).

const BotAI = (() => {

  // ── Combat decision ────────────────────────────────────────────────────────
  // Pick the attack type where (player stat) advantage over (mob defense) is greatest.
  function chooseCombatAction(player, mob) {
    // Bail if low on hearts and can escape
    if (player.hearts.current <= 1 && player.canEscape()) {
      return { type: 'bail' };
    }

    const attackTypes = ['F','D','M','C'];
    const defenseFor  = { F:'A', D:'V', M:'M', C:'C' };

    // Skip magic if no spell and no cursed ring
    const available = attackTypes.filter(t => {
      if (t === 'M' && !player.canAttackMagic()) return false;
      return true;
    });

    // Choose type with best expected outcome: player_stat - mob_defense_stat
    let best = available[0];
    let bestScore = -Infinity;
    for (const t of available) {
      const pStat = player.getStat(t);
      const mDef  = mob.stats[defenseFor[t]] ?? 0;
      const score = pStat - mDef;
      if (score > bestScore) { bestScore = score; best = t; }
    }

    // Pick best available attack spell for magic
    let spellId = null;
    if (best === 'M') {
      const spell = player.inventory
        .map(id => getItem(id))
        .filter(i => i?.subtype === 'attack')
        .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
      spellId = spell?.id ?? null;
    }

    return { type: 'attack', attackType: best, spellId };
  }

  // ── Full turn decision ─────────────────────────────────────────────────────
  function takeTurn(player) {
    const state = Game.getState();

    if (state.phase === Game.Phase.ROLL_MOVE) {
      Game.submitAction({ type: 'roll' });
      return;
    }

    if (state.phase === Game.Phase.COMBAT) {
      const combat = state.pendingCombat;
      if (combat) {
        if (combat.combatSubPhase === 'mob_attack') {
          Game.submitAction({ type: 'defend' });
        } else {
          Game.submitAction(chooseCombatAction(player, combat.mob));
        }
      }
      return;
    }

    if (state.phase === Game.Phase.MOVING) {
      // Move towards princess (if pvp active) or towards finish, else towards boss
      const reachable = state.reachableTiles;
      if (!reachable || reachable.size === 0) {
        // No moves available — shouldn't happen; just end turn
        Game.submitAction({ type: 'move', dest: player.position });
        return;
      }

      // Prioritise: finish tile > princess > boss tile > furthest reachable tile
      let chosen = null;

      reachable.forEach((steps, key) => {
        const [x, y] = key.split(',').map(Number);
        const tType  = MapGrid.get(x, y);
        if (!chosen) chosen = { x, y };
        if (state.pvpActive && state.princess.x === x && state.princess.y === y) chosen = { x, y };
        if (tType === TileType.FINISH && player.hasPrincess) chosen = { x, y };
        if (tType === TileType.BOSS && !chosen) chosen = { x, y };
      });

      // Default: pick tile with most steps (push forward)
      if (!chosen) {
        let max = -1;
        reachable.forEach((steps, key) => {
          if (steps > max) {
            max = steps;
            const [x, y] = key.split(',').map(Number);
            chosen = { x, y };
          }
        });
      }

      Game.submitAction({ type: 'move', dest: chosen });
      return;
    }

    // All other phases: auto-confirm
    Game.submitAction({ type: 'tile_confirm' });
  }

  return { chooseCombatAction, takeTurn };
})();
