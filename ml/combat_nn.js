// combat_nn.js — Neural network combat action selector.
// Drop-in replacement for BotAI.chooseCombatAction().
//
// Loads weights from ml/model_weights.json and runs a forward pass
// to decide whether to use a consumable (heal/smoke/stat-potion) before
// attacking, which is the non-trivial decision the rule-based bot ignores.
//
// Architecture: 38 → 128 → 64 → 8  (ReLU / ReLU / Tanh)
// Outputs: normalised relative advantage per action (centred around 0).
// Inference: use consumable only if its predicted advantage over the best
//            plain attack exceeds CONSUMABLE_THRESHOLD (tuned to F1=0.745).

const CombatNN = (() => {

  // ── Inference threshold ───────────────────────────────────────────────────
  // Consumable is recommended only if predicted advantage over best plain
  // attack exceeds this value.  Tuned at 0.10 (precision 70%, recall 80%).
  const CONSUMABLE_THRESHOLD = 0.10;

  // ── Action index (must match train.py ACTION_NAMES) ──────────────────────
  const ACTION_NAMES = ['atk_F','atk_D','atk_M','atk_C','bail','heal','smoke','pot'];
  const IDX = {};
  ACTION_NAMES.forEach((a, i) => { IDX[a] = i; });

  // ── Model weights (loaded once) ───────────────────────────────────────────
  let _layers = null;   // [{ W: Float32Array[][], b: Float32Array }]
  let _ready   = false;

  function loadWeights(weightsJson) {
    _layers = weightsJson.layers.map(({ W, b }) => ({
      W: W.map(row => new Float32Array(row)),
      b: new Float32Array(b),
    }));
    _ready = true;
  }

  // ── Forward pass ──────────────────────────────────────────────────────────

  function relu(x)    { return x > 0 ? x : 0; }
  function tanh(x)    { return Math.tanh(x); }

  function forward(input) {
    let x = new Float32Array(input);
    for (let li = 0; li < _layers.length; li++) {
      const { W, b } = _layers[li];
      const out = new Float32Array(b.length);
      for (let j = 0; j < b.length; j++) {
        let sum = b[j];
        for (let k = 0; k < x.length; k++) sum += W[j][k] * x[k];
        out[j] = li < _layers.length - 1 ? relu(sum) : tanh(sum);
      }
      x = out;
    }
    return x;   // Float32Array of 8 normalised advantages
  }

  // ── Feature extraction ────────────────────────────────────────────────────
  // Must exactly match extractFeatures() in generate_training_data.js.

  const DEFENSE_FOR  = { F:'A', D:'V', M:'M', C:'C' };
  const ATTACK_TYPES = ['F','D','A','M','C','V'];

  function getMobEffStat(mob, stat) {
    let v = mob.stats[stat] ?? 0;
    for (const e of (mob.statusEffects ?? []))
      if (e.type === 'malus' && e.stat === stat) v += e.value;
    return Math.max(0, v);
  }

  function extractFeatures(player, mob) {
    const f = [];

    // [0-5] player effective stats ÷ 35
    for (const s of ['F','D','A','M','C','V']) f.push(player.getStat(s) / 35);

    // [6-7] player HP
    f.push(player.hearts.current / player.hearts.max);
    f.push(player.hearts.current / 12);

    // [8-13] mob effective stats ÷ 35
    for (const s of ['F','D','A','M','C','V']) f.push(getMobEffStat(mob, s) / 35);

    // [14-15] mob HP
    f.push(mob.hearts.current / mob.hearts.max);
    f.push(mob.hearts.current / 12);

    // [16] bail available
    f.push(player.canEscape() ? 1 : 0);

    // [17] best spell magic value ÷ 3
    const bestSpell = player.inventory
      .map(id => getItem(id))
      .filter(i => i?.subtype === 'attack')
      .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
    f.push(bestSpell ? (bestSpell.magicValue ?? 0) / 3 : 0);

    // [18-20] player status: fire, lightning, ice
    const pFire = player.statusEffects.find(e => e.type === 'fire');
    f.push(pFire ? Math.min(pFire.turnsLeft, 5) / 5 : 0);
    f.push(player.statusEffects.some(e => e.type === 'lightning') ? 1 : 0);
    const pIce = player.statusEffects.filter(e => e.type === 'malus' && e.stat === 'V')
      .reduce((s, e) => s + Math.abs(e.value), 0);
    f.push(Math.min(pIce, 6) / 6);

    // [21-23] mob status: fire, lightning, ice
    const mFire = (mob.statusEffects ?? []).find(e => e.type === 'fire');
    f.push(mFire ? Math.min(mFire.turnsLeft, 5) / 5 : 0);
    f.push((mob.statusEffects ?? []).some(e => e.type === 'lightning') ? 1 : 0);
    const mIce = (mob.statusEffects ?? []).filter(e => e.type === 'malus' && e.stat === 'V')
      .reduce((s, e) => s + Math.abs(e.value), 0);
    f.push(Math.min(mIce, 6) / 6);

    // [24-27] mob next attack type one-hot
    const nextAtk = Combat.rollMobAttack(mob);
    for (const t of ['F','D','M','C']) f.push(nextAtk === t ? 1 : 0);

    // [28-29] tier context
    f.push((mob.tier ?? 0) / 3);
    const avgStat = ['F','D','A','M','C','V'].reduce((s,t) => s + player.getStat(t), 0) / 6;
    f.push(Math.min(avgStat, 35) / 35);

    // [30] heal count ÷ 5
    f.push(Math.min(player.inventory.filter(id => id === 'pot_heal').length, 5) / 5);

    // [31] has smoke
    f.push(player.hasItem('sp_smoke') ? 1 : 0);

    // [32-35] best stat potion value per attack stat ÷ 6
    for (const stat of ['F','D','M','C']) {
      const potIds = { F:['pot_F1','pot_F2','pot_F3'], D:['pot_D1','pot_D2','pot_D3'],
                       M:['pot_M1','pot_M2','pot_M3'], C:['pot_C1','pot_C2','pot_C3'] }[stat];
      let best = 0;
      for (const id of potIds) {
        if (player.hasItem(id)) {
          const item = getItem(id);
          best = Math.max(best, item?.effect?.value ?? 0);
        }
      }
      f.push(best / 6);
    }

    // [36] mob net threat
    const mobBestAtk = ['F','D','M','C'].reduce((b, t) =>
      getMobEffStat(mob, t) > getMobEffStat(mob, b) ? t : b, 'F');
    const mobAtkPow  = getMobEffStat(mob, mobBestAtk);
    const playerDef  = player.getStat(DEFENSE_FOR[mobBestAtk]);
    f.push(Math.min(Math.max(0, mobAtkPow - playerDef), 20) / 20);

    // [37] turns-to-death estimate
    const mobRollExp    = Math.max(0, mobAtkPow - 3 + 3.5);
    const playerRollExp = playerDef + 3.5;
    const hitProb       = Math.max(0, Math.min(1, (mobRollExp - playerRollExp) / 6 + 0.5));
    const turnsToDeath  = hitProb > 0 ? Math.min(10, player.hearts.current / hitProb) : 10;
    f.push(turnsToDeath / 10);

    return f;
  }

  // ── Greedy best attack type (rule-based, same as before) ─────────────────
  function bestAttackAction(player, mob) {
    const defFor = { F:'A', D:'V', M:'M', C:'C' };
    const avail  = ['F','D','M','C'].filter(t => !(t === 'M' && !player.canAttackMagic()));
    let best = 'F', bestScore = -Infinity;
    for (const t of avail) {
      const score = player.getStat(t) - (mob.stats[defFor[t]] ?? 0);
      if (score > bestScore) { bestScore = score; best = t; }
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

  // ── Best available stat potion ────────────────────────────────────────────
  function bestStatPotion(player) {
    const POT_STATS = {
      F: ['pot_F1','pot_F2','pot_F3'], D: ['pot_D1','pot_D2','pot_D3'],
      M: ['pot_M1','pot_M2','pot_M3'], C: ['pot_C1','pot_C2','pot_C3'],
    };
    let best = null, bestVal = 0;
    for (const [stat, ids] of Object.entries(POT_STATS)) {
      for (const id of ids) {
        if (!player.hasItem(id)) continue;
        const val = getItem(id)?.effect?.value ?? 0;
        if (val > bestVal) { bestVal = val; best = { id, stat, value: val }; }
      }
    }
    return best;
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  // Returns a combat action object, same shape as BotAI.chooseCombatAction().

  function chooseAction(player, mob) {
    // Hard rule: bail on last heart if possible (same as rule-based bot)
    if (player.hearts.current <= 1 && player.canEscape()) return { type: 'bail' };
    if (player.hearts.current <= 1 && player.chainedTurns === 0) return { type: 'run' };

    // If weights not loaded, fall back to greedy rule-based
    if (!_ready) return bestAttackAction(player, mob);

    // Run NN forward pass
    const features  = extractFeatures(player, mob);
    const pred      = forward(features);   // normalised advantage per action

    // Find best plain attack's predicted advantage
    const plainIdxs = [IDX.atk_F, IDX.atk_D, IDX.atk_M, IDX.atk_C];
    let bestPlainAdv = -Infinity, bestPlainIdx = IDX.atk_F;
    for (const i of plainIdxs) {
      const actionName = ACTION_NAMES[i];
      if (actionName === 'atk_M' && !player.canAttackMagic()) continue;
      if (pred[i] > bestPlainAdv) { bestPlainAdv = pred[i]; bestPlainIdx = i; }
    }

    // Check consumables: recommend only if advantage exceeds threshold
    const consumableCandidates = [];

    if (player.hasItem('pot_heal')) {
      const margin = pred[IDX.heal] - bestPlainAdv;
      if (margin > CONSUMABLE_THRESHOLD) consumableCandidates.push({ id: 'heal', margin });
    }
    if (player.hasItem('sp_smoke')) {
      const margin = pred[IDX.smoke] - bestPlainAdv;
      if (margin > CONSUMABLE_THRESHOLD) consumableCandidates.push({ id: 'smoke', margin });
    }
    const pot = bestStatPotion(player);
    if (pot) {
      const margin = pred[IDX.pot] - bestPlainAdv;
      if (margin > CONSUMABLE_THRESHOLD) consumableCandidates.push({ id: 'pot', margin, pot });
    }

    // Pick the consumable with the highest predicted advantage margin
    if (consumableCandidates.length > 0) {
      const best = consumableCandidates.reduce((a, b) => a.margin > b.margin ? a : b);
      if (best.id === 'heal') {
        // Use heal then return best plain attack
        player.removeItem('pot_heal');
        player.healHeart(1);
        return bestAttackAction(player, mob);
      }
      if (best.id === 'smoke') {
        player.removeItem('sp_smoke');
        player.isSmokeActive = true;
        return bestAttackAction(player, mob);
      }
      if (best.id === 'pot' && best.pot) {
        player.addTempBonus(best.pot.stat, best.pot.value);
        player.removeItem(best.pot.id);
        // Attack with the matching stat
        const t = best.pot.stat;
        if (t === 'C') return { type: 'bard' };
        let spellId = null;
        if (t === 'M') {
          const spell = player.inventory
            .map(id => getItem(id))
            .filter(i => i?.subtype === 'attack')
            .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
          spellId = spell?.id ?? null;
        }
        return { type: 'attack', attackType: t, spellId };
      }
    }

    // No consumable warranted — use best plain attack
    return bestAttackAction(player, mob);
  }

  return { loadWeights, chooseAction };
})();
