// Combat viability estimator — browser inference only.
// Depends on: ESTIMATOR_WEIGHTS (js/data/weights/estimator_weights.js)
//
// Covers the full player progression range:
//   - Base stats 1-12+ (XP system has no hard upper bound)
//   - Equipped items at all tiers (stat bonuses absorbed by getStat)
//   - Enchantments: stat-bonus kinds (sharpness/precision/resistance) absorbed by getStat;
//     modifier kinds (fury/bloodlust/thorns/arcane/hawk_eye) as explicit features
//   - Special equipment: kryss, garrote, stealth_shoes
//   - Consumables: potions, escape items, attack spells
//
// API:
//   CombatEstimator.estimate(player, tier)
//   → { winProb, heartsLost, affordable, sustainable }
//
//   CombatEstimator.estimateZone(player, tier, nFights)
//   → { winProb, heartsLost, totalHeartsLost, survivalProb, recommendation }
//
//   CombatEstimator.bestTier(player)
//   → { tier, winProb, heartsLost }
//
//   CombatEstimator.strategyReport(player)
//   → [{ tier, winProb, heartsLost, verdict }, ...]  one entry per tier

const CombatEstimator = (() => {

  const STATS   = ['F','D','A','M','C','V'];
  const TIERS   = [0, 1, 2, 3];
  const STATE_DIM  = 24;
  const HEARTS_SCALE = 10; // matches training normalisation

  // ── Forward pass (no training state needed) ─────────────────────────────────

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
      cur = l < layers.length - 1 ? next.map(v => Math.max(0, v)) : next;
    }
    return cur;
  }

  // ── Feature vector — must match train/train_estimator.js exactly ─────────────
  //
  //  0      hp_ratio
  //  1      hearts_max / 10
  //  2-7    getStat(F,D,A,M,C,V) / 25
  //  8      has_kryss
  //  9      has_garrote
  // 10      has_fury (enchantment)
  // 11      has_bloodlust
  // 12      has_hawk_eye
  // 13      has_thorns
  // 14      has_arcane
  // 15      can_bail
  // 16      has_smoke
  // 17      has_friend
  // 18      best_pot_bonus / 6
  // 19      has_attack_spell
  // 20-23   tier one-hot

  function featureVec(player, tier) {
    const v = new Array(STATE_DIM).fill(0);
    let i   = 0;

    v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
    v[i++] = Math.min(player.hearts.max, 10) / 10;

    for (const s of STATS) v[i++] = Math.min(player.getStat(s), 25) / 25;

    v[i++] = player.hasEquipped('kryss')         ? 1 : 0;
    v[i++] = player.hasEquipped('garrote')       ? 1 : 0;
    v[i++] = player.hasEnchantment('fury')       ? 1 : 0;
    v[i++] = player.hasEnchantment('bloodlust')  ? 1 : 0;
    v[i++] = player.hasEnchantment('hawk_eye')   ? 1 : 0;
    v[i++] = player.hasEnchantment('thorns')     ? 1 : 0;
    v[i++] = player.hasEnchantment('arcane')     ? 1 : 0;
    // Escape quality: 1.0 = guaranteed (rope / stealth_shoes);
    // partial = V+d6 vs avg mob.V (flat) run probability + small C bard bonus;
    // 0 = chained or no realistic escape.
    // Avg mob V per tier (non-animal, non-boss): t0≈8, t1≈10, t2≈13, t3≈15
    // Avg mob C per tier:                        t0≈6, t1≈9,  t2≈11, t3≈14
    {
      const hasGuaranteedEscape = player.hasItem('rope') || player.hasEquipped('stealth_shoes');
      let escapeVal;
      if (hasGuaranteedEscape) {
        escapeVal = 1.0;
      } else if (player.chainedTurns === 0) {
        const avgMobV = [8, 10, 13, 15][tier] ?? 10;
        const avgMobC = [6,  9, 11, 14][tier] ?? 9;
        const vRun    = Math.max(0, Math.min(1, (player.getStat('V') + 3.5 - avgMobV) / 6));
        const cBard   = Math.max(0, Math.min(0.25, (player.getStat('C') - avgMobC) / 12));
        escapeVal = Math.min(1, vRun + cBard);
      } else {
        escapeVal = 0;
      }
      v[i++] = escapeVal;
    }
    v[i++] = player.inventory.includes('sp_smoke')    ? 1 : 0;
    v[i++] = player.friendsList.length > 0            ? 1 : 0;

    const bestPot = player.inventory.reduce((best, id) => {
      if (!/^pot_[FDAMCV]\d$/.test(id)) return best;
      return Math.max(best, parseInt(id[5]) || 0);
    }, 0);
    v[i++] = bestPot / 6;

    v[i++] = player.canAttackMagic() ? 1 : 0;

    for (const t of TIERS) v[i++] = t === tier ? 1 : 0;

    return v;
  }

  // ── Core inference ───────────────────────────────────────────────────────────

  function predict(player, tier) {
    const layers = (typeof ESTIMATOR_WEIGHTS !== 'undefined') ? ESTIMATOR_WEIGHTS : null;
    if (!layers) return { winProb: 0.5, heartsLost: 2.5 }; // neutral fallback
    const out = forward(layers, featureVec(player, tier));
    return {
      winProb:    Math.max(0, Math.min(1, out[0])),
      heartsLost: Math.max(0, out[1] * HEARTS_SCALE),
    };
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  // Single-fight estimate for zone tier.
  function estimate(player, tier) {
    const { winProb, heartsLost } = predict(player, tier);

    // Escape-quality penalty — applied post-inference so no retraining is needed.
    // The NN was trained with a binary canEscape feature.  When no guaranteed escape
    // exists (rope / stealth_shoes) and the V+d6 run roll is near-impossible against
    // this tier's average mob V, the NN's survival estimate is optimistic.
    // Penalty: up to -0.15 × (1 − escapeQuality), where escapeQuality tracks how
    // reliable the escape path is (0 = no realistic escape, 1 = guaranteed).
    const hasGuaranteedEscape = player.hasItem('rope') || player.hasEquipped('stealth_shoes');
    let adjWinProb = winProb;
    if (!hasGuaranteedEscape) {
      const avgMobV   = [8, 10, 13, 15][tier] ?? 10;
      const avgMobC   = [6,  9, 11, 14][tier] ?? 9;
      const vRun      = player.chainedTurns === 0
        ? Math.max(0, Math.min(1, (player.getStat('V') + 3.5 - avgMobV) / 6))
        : 0;
      const cBard     = Math.max(0, Math.min(0.25, (player.getStat('C') - avgMobC) / 12));
      const escapeQ   = Math.min(1, vRun + cBard);
      // Full penalty when escapeQ=0; zero penalty when escapeQ≥0.5 (run is reliable enough)
      const penalty   = Math.max(0, (0.5 - escapeQ) / 0.5) * 0.25;
      adjWinProb      = Math.max(0, winProb - penalty);
    }

    return {
      winProb:      adjWinProb,
      heartsLost,
      // Can the player absorb the expected damage and keep ≥1 heart?
      affordable:   player.hearts.current > heartsLost,
      // Is farming here sustainably safe? (reasonable win rate, damage manageable)
      sustainable:  adjWinProb >= 0.55 && heartsLost < player.hearts.max * 0.6,
    };
  }

  // Cost model for venturing into a zone for nFights fights.
  function estimateZone(player, tier, nFights = 3) {
    const { winProb, heartsLost } = predict(player, tier);
    const totalHeartsLost = heartsLost * nFights;
    // Approximate probability of surviving all N fights without a single death
    const survivalProb    = Math.pow(winProb, nFights);

    let recommendation;
    if      (winProb < 0.40)                                   recommendation = 'avoid';
    else if (winProb < 0.60 || totalHeartsLost >= player.hearts.current) recommendation = 'caution';
    else if (winProb >= 0.75)                                  recommendation = 'farm';
    else                                                       recommendation = 'proceed';

    return { winProb, heartsLost, totalHeartsLost, survivalProb, nFights, recommendation };
  }

  // Highest tier the player can comfortably farm (win% ≥ 55% and affordable).
  function bestTier(player) {
    let best = null;
    for (const tier of TIERS) {
      const e = estimate(player, tier);
      if (e.winProb >= 0.55 && e.affordable) best = { tier, ...e };
    }
    return best ?? { tier: 0, ...estimate(player, 0) };
  }

  // Full per-tier breakdown — primary input for the movement strategy bot.
  function strategyReport(player) {
    return TIERS.map(tier => {
      const e = estimate(player, tier);
      let verdict;
      if      (!e.affordable)     verdict = 'too_dangerous';
      else if (e.winProb < 0.40)  verdict = 'avoid';
      else if (e.winProb < 0.60)  verdict = 'risky';
      else if (e.winProb < 0.75)  verdict = 'viable';
      else                        verdict = 'safe';
      return { tier, ...e, verdict };
    });
  }

  // ── Boss fight estimation (Monte Carlo) ─────────────────────────────────────
  //
  // Uses exact boss stats (hardcoded from mobs.js) and simulates combat using
  // the same dice rules as the game engine.  No NN needed — fully analytical.
  //
  // Player strategy simulated:
  //   - Best attack type chosen by max(player_stat - boss_defense_stat)
  //   - Cursed Rattle equipped → instant kill via bard (winProb = 1)
  //   - pot_heal used at 1 heart (up to inventory count)
  //   - Matching offensive stat potion applied to first attack
  //   - Defensive stat potion (pot_A3 / pot_V3) applied to first incoming hit
  //
  // Boss strategy: attacks with the highest of its F/D/M/C stats,
  // breaking ties randomly each round.

  const BOSS_STATS = {
    dragon:           { stats:{F:20,D:20,A:20,M:20,C:20,V:20}, hearts:12 },
    king:             { stats:{F:20,D:20,A:20,M:20,C:20,V:18}, hearts:10 },
    phoenix:          { stats:{F:18,D:18,A:16,M:16,C:18,V:20}, hearts: 9 },
    sea_serpent:      { stats:{F:20,D:20,A:16,M:16,C:18,V:18}, hearts: 8 },
    prince:           { stats:{F:16,D:18,A:18,M:18,C:20,V:18}, hearts: 8 },
    grand_sorcerer:   { stats:{F:18,D:18,A:20,M:20,C:18,V:20}, hearts: 9 },
    witch:            { stats:{F:16,D:16,A:20,M:18,C:18,V:20}, hearts: 8 },
    supreme_werewolf: { stats:{F:22,D:20,A:14,M:12,C:18,V:22}, hearts:10 },
    supreme_knight:   { stats:{F:22,D:18,A:22,M:14,C:18,V:18}, hearts:10 },
  };

  const DEFENSE_FOR_B = { F:'A', D:'V', M:'M', C:'C' };

  function estimateBoss(player, bossId, nSim) {
    nSim = nSim !== undefined ? nSim : 300;
    const boss = BOSS_STATS[bossId];
    if (!boss) return null;

    // Instant kill with Cursed Rattle (bard kill:1)
    const hasCursedRattle = !!(player.hasEquipped && player.hasEquipped('cursed_rattle'));
    if (hasCursedRattle) return { winProb: 1, heartsLost: 0 };

    // Player stat snapshot
    const pSt = {};
    for (const s of STATS) pSt[s] = player.getStat(s);
    const pH0   = player.hearts.current;
    const pHMax = player.hearts.max;
    const heals = Math.min(
      player.inventory.filter(id => id === 'pot_heal').length, 10
    );

    // Best player attack type (highest net advantage).
    // Exclude C: bard produces charisma outcomes (not HP damage) against bosses.
    // Exception: Cursed Rattle = kill:1, handled above as instant kill.
    let bestAtk = 'F', bestAdv = -Infinity;
    for (const t of ['F','D','M']) {
      const adv = pSt[t] - (boss.stats[DEFENSE_FOR_B[t]] || 0);
      if (adv > bestAdv) { bestAdv = adv; bestAtk = t; }
    }
    const pAtkStat = pSt[bestAtk];
    const mDefStat = boss.stats[DEFENSE_FOR_B[bestAtk]] || 0;

    // Count ALL offensive potions — one used per attack round, not just the first.
    const offPots3 = player.inventory.filter(id => id === 'pot_' + bestAtk + '3').length;
    const offPots2 = player.inventory.filter(id => id === 'pot_' + bestAtk + '2').length;

    // Count ALL defensive potions by stat type.
    // A-pots defend vs F/M/C attacks; V-pots defend vs D attacks.
    const defPotsA6 = player.inventory.filter(id => id === 'pot_A6').length;
    const defPotsA3 = player.inventory.filter(id => id === 'pot_A3').length;
    const defPotsA2 = player.inventory.filter(id => id === 'pot_A2').length;
    const defPotsV6 = player.inventory.filter(id => id === 'pot_V6').length;
    const defPotsV3 = player.inventory.filter(id => id === 'pot_V3').length;
    const defPotsV2 = player.inventory.filter(id => id === 'pot_V2').length;

    // Blood drops (vampire_blood, dragon_blood, etc.) boost attack stat for whole fight.
    let bloodAtkBonus = 0;
    for (const id of player.inventory) {
      const item = (typeof getItem !== 'undefined') ? getItem(id) : null;
      if (item?.statBonus && !item.slot) bloodAtkBonus += item.statBonus[bestAtk] ?? 0;
    }
    const effectivePAtkStat = pAtkStat + bloodAtkBonus;

    // Boss attack types from tied maximum F/D/M/C
    const maxBA = Math.max(boss.stats.F, boss.stats.D, boss.stats.M, boss.stats.C);
    const bAtkTypes = ['F','D','M','C'].filter(t => boss.stats[t] === maxBA);

    function d6() { return Math.floor(Math.random() * 6) + 1; }

    let wins = 0, totalHL = 0;
    for (let s = 0; s < nSim; s++) {
      let pH = pH0, bH = boss.hearts, h = heals;
      // Reset per-simulation pot counts
      let off3 = offPots3, off2 = offPots2;
      let dA6 = defPotsA6, dA3 = defPotsA3, dA2 = defPotsA2;
      let dV6 = defPotsV6, dV3 = defPotsV3, dV2 = defPotsV2;

      for (let r = 0; r < 400 && bH > 0 && pH > 0; r++) {
        // Player attack — use one offensive pot per round while supply lasts
        let atkBonus = 0;
        if      (off3 > 0) { atkBonus = 3; off3--; }
        else if (off2 > 0) { atkBonus = 2; off2--; }
        const pRoll  = effectivePAtkStat + atkBonus + d6();
        const mRoll  = mDefStat - 3 + d6();
        if (pRoll > mRoll) bH--;
        if (bH <= 0) break;

        // Boss attack — use best available defensive pot for this attack type
        const atkT = bAtkTypes[Math.floor(Math.random() * bAtkTypes.length)];
        const mAS  = boss.stats[atkT];
        const pDS  = pSt[DEFENSE_FOR_B[atkT]];
        let defBonus = 0;
        if (atkT === 'F' || atkT === 'M' || atkT === 'C') {
          if      (dA6 > 0) { defBonus = 6; dA6--; }
          else if (dA3 > 0) { defBonus = 3; dA3--; }
          else if (dA2 > 0) { defBonus = 2; dA2--; }
        } else if (atkT === 'D') {
          if      (dV6 > 0) { defBonus = 6; dV6--; }
          else if (dV3 > 0) { defBonus = 3; dV3--; }
          else if (dV2 > 0) { defBonus = 2; dV2--; }
        }
        const mAR  = mAS - 3 + d6();
        const pDR  = pDS + defBonus + d6();
        if (mAR > pDR) {
          pH--;
          if (pH <= 1 && h > 0) { pH = Math.min(pH + 1, pHMax); h--; }
        }
      }

      if (bH <= 0) wins++;
      totalHL += Math.max(0, pH0 - pH);
    }

    return { winProb: wins / nSim, heartsLost: totalHL / nSim };
  }

  // Readiness summary for every named boss.
  function bossReport(player) {
    return Object.keys(BOSS_STATS).map(id => {
      const e = estimateBoss(player, id);
      const verdict = e.winProb >= 0.75 ? 'ready'
                    : e.winProb >= 0.50 ? 'risky'
                    : e.winProb >= 0.25 ? 'unprepared'
                    :                     'avoid';
      return { bossId: id, ...e, verdict };
    });
  }

  return { estimate, estimateZone, bestTier, strategyReport, featureVec, estimateBoss, bossReport, BOSS_STATS };
})();
