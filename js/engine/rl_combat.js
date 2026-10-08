// RL combat policy — browser-side inference only.
// Depends on: COMBAT_WEIGHTS (js/data/weights/combat_weights.js)
// Exposes: RLCombat.chooseCombatAction(player, mob, pendingMobAtk)
//          → same shape as BotAI.chooseCombatAction (drop-in replacement)
//
// If weights are not loaded or the network returns an invalid action,
// falls back to the rule-based heuristic automatically.

const RLCombat = (() => {

  const STATS        = ['F','D','A','M','C','V'];
  const ATK_TYPES    = ['F','D','M','C'];
  const ACTION_NAMES = ['F','D','M','bail','run'];
  const DEFENSE_FOR  = { F:'A', D:'V', M:'M', C:'C' };

  // ── Tiny feedforward NN (forward-pass only) ─────────────────────────────────

  function forward(layers, x) {
    let cur = x.slice();
    for (let l = 0; l < layers.length; l++) {
      const { w, b, inD, outD } = layers[l];
      const next = new Array(outD);
      for (let o = 0; o < outD; o++) {
        let s = b[o];
        for (let i = 0; i < inD; i++) s += w[o * inD + i] * cur[i];
        next[o] = s;
      }
      // ReLU on hidden layers; linear output
      cur = (l < layers.length - 1) ? next.map(v => Math.max(0, v)) : next;
    }
    return cur;
  }

  // ── State vector (must match train/combat_env.js : getStateVec) ─────────────

  function getStateVec(player, mob, pendingMobAtk) {
    const v = new Array(32).fill(0);
    let i   = 0;

    v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
    v[i++] = Math.min(player.hearts.current, 10) / 10;

    for (const s of STATS) v[i++] = Math.min(player.getStat(s), 12) / 12;

    for (const s of STATS) {
      v[i++] = player.inventory.some(id => id.startsWith(`pot_${s}`)) ? 1 : 0;
    }

    v[i++] = player.canEscape() ? 1 : 0;
    v[i++] = player.statusEffects.some(e => e.type === 'fire')      ? 1 : 0;
    v[i++] = player.statusEffects.some(e => e.type === 'lightning') ? 1 : 0;

    v[i++] = mob.hearts.current / Math.max(mob.hearts.max, 1);
    for (const s of STATS) {
      const base = mob.stats[s] ?? 0;
      const eff  = (mob.statusEffects ?? []).reduce((a, e) => e.stat === s ? a + e.value : a, 0);
      v[i++] = Math.min(Math.max(base + eff, 0), 12) / 12;
    }

    v[i++] = (mob.tier ?? 0) / 3;
    for (const s of ATK_TYPES) v[i++] = pendingMobAtk === s ? 1 : 0;
    v[i++] = (mob.statusEffects ?? []).some(e => e.type === 'fire')              ? 1 : 0;
    v[i++] = (mob.statusEffects ?? []).some(e => e.stat === 'V' && e.value < 0) ? 1 : 0;

    return v;
  }

  // ── Action mask ──────────────────────────────────────────────────────────────

  function getActionMask(player) {
    return [
      true,
      true,
      player.canAttackMagic(),
      player.canEscape(),
      player.chainedTurns === 0,
    ];
  }

  // ── Rule-based fallback (simple stat comparison) ─────────────────────────────

  function ruleFallback(player, mob) {
    if (player.hearts.current <= 1 && player.canEscape()) return { type: 'bail' };
    if (player.hearts.current <= 1 && player.chainedTurns === 0) return { type: 'run' };

    const available = ['F','D','M','C'].filter(t =>
      !(t === 'M' && !player.canAttackMagic())
    );
    let best = null, bestScore = -Infinity;
    for (const t of available) {
      const s = player.getStat(t) - (mob.stats[DEFENSE_FOR[t]] ?? 0);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (best === 'C') return { type: 'bard' };
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

  // ── Main API ─────────────────────────────────────────────────────────────────

  function chooseCombatAction(player, mob, pendingMobAtk) {
    // Check that weights are available and valid
    const layers = (typeof COMBAT_WEIGHTS !== 'undefined') ? COMBAT_WEIGHTS : null;
    if (!layers || !Array.isArray(layers) || layers.length === 0) {
      return ruleFallback(player, mob);
    }

    const obs  = getStateVec(player, mob, pendingMobAtk);
    const q    = forward(layers, obs);
    const mask = getActionMask(player);

    // Argmax over valid actions
    let best = -1, bestQ = -Infinity;
    for (let a = 0; a < ACTION_NAMES.length; a++) {
      if (mask[a] && q[a] > bestQ) { bestQ = q[a]; best = a; }
    }

    if (best < 0) return ruleFallback(player, mob);

    if (best === 3) return { type: 'bail' };
    if (best === 4) return { type: 'run' };

    const atkType = ['F','D','M'][best];
    let spellId = null;
    if (atkType === 'M') {
      const spell = player.inventory
        .map(id => getItem(id))
        .filter(i => i?.subtype === 'attack')
        .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
      spellId = spell?.id ?? null;
    }
    return { type: 'attack', attackType: atkType, spellId };
  }

  return { chooseCombatAction, getStateVec };
})();
