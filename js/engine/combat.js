const Combat = (() => {
  const ATTACK_TYPES = ['F','D','M','C'];
  const DEFENSE_FOR  = { F:'A', D:'V', M:'M', C:'C' };

  // ── Charisma tuning ───────────────────────────────────────────────────────
  // Roll C + d6 vs mob C (flat): diff ≥ 7 → T3, ≥ 5 → T2, ≥ 3 → T1.
  // diff 1–2 ("near miss") → +1 C for the rest of the fight (stacks), fight goes on.
  const CHA_NEAR_MISS_BONUS = 1;
  // Deceive coins and Gift size scale with the mob's zone tier (0–3).
  const CHA_ZONE_COIN_MULT  = [1, 2, 3, 4];
  const CHA_ZONE_GIFT_ITEMS = [1, 1, 2, 2];
  // C XP: distinct abilities per fight (not per roll)
  // Calibration target: C build C XP/turn within ±15% of median of F/D/M builds
  // Measured rates (before rebalance): F=0.8, D=0.8, M=1.0, C=3.2 XP/turn → C 4× too fast
  // After rebalance with [0,1,2,3] & cap=3: C=0.9 XP/turn → within target range
  const CHA_XP_PER_TIER = [0, 1, 2, 3];  // tier 0 unused, tier 1-3
  const CHA_XP_ACTIONS_PER_FIGHT = 3;    // hard cap: max 3 XP-giving actions per fight

  function charismaMaxTier(diff) {
    return diff >= 7 ? 3 : diff >= 5 ? 2 : diff >= 3 ? 1 : 0;
  }
  function chaZone(mob) { return Math.min(3, Math.max(0, mob.tier ?? 0)); }

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Mob attack/defense roll: base (stat − 3) + d6. Base can be negative.
  function mobRoll(mob, stat) {
    return getMobStat(mob, stat) - 3 + Dice.d6();
  }

  // Which player stat key is actually used to defend against attackType.
  function playerDefStatKey(player, attackType) {
    if (attackType === 'M' && player.hasEnchantment('arcane')) return 'A';
    return DEFENSE_FOR[attackType];
  }

  function mobHighestAttack(mob) {
    const maxVal = Math.max(...ATTACK_TYPES.map(s => getMobStat(mob, s)));
    const tied   = ATTACK_TYPES.filter(s => getMobStat(mob, s) === maxVal);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  function applyEffect(effect, target, log) {
    if (!effect) return;
    switch (effect.type) {
      case 'fire':
        target.statusEffects.push({ type:'fire', turnsLeft: effect.n });
        log.push(`${targetName(target)} is burning (${effect.n} turns)`);
        break;
      case 'ice':
        target.statusEffects.push({ type:'malus', stat:'V', value:-effect.n, turnsLeft:999 });
        log.push(`${targetName(target)} is slowed (−${effect.n}V)`);
        break;
      case 'lightning':
        target.statusEffects.push({ type:'lightning', turnsLeft:1 });
        log.push(`${targetName(target)} is stunned (must roll >3 next attack)`);
        break;
      case 'explosion':
        target.statusEffects.push({ type:'malus', stat:'A', value:-effect.n, turnsLeft:999 });
        log.push(`${targetName(target)} armor reduced (−${effect.n}A)`);
        break;
    }
  }

  function checkLightningBlock(entity, log) {
    const idx = entity.statusEffects.findIndex(e => e.type === 'lightning');
    if (idx === -1) return false;
    entity.statusEffects.splice(idx, 1);
    const roll = Dice.d6();
    if (roll <= 3) {
      log.push(`${targetName(entity)} is paralysed (rolled ${roll}) — cannot act`);
      return true;
    }
    log.push(`${targetName(entity)} breaks through paralysis (rolled ${roll})`);
    return false;
  }

  function processFire(entity, log) {
    let dmg = 0;
    entity.statusEffects = entity.statusEffects.map(e => {
      if (e.type !== 'fire') return e;
      const updated = { ...e, turnsLeft: e.turnsLeft - 1 };
      if (updated.turnsLeft <= 0) dmg++;
      return updated;
    }).filter(e => !(e.type === 'fire' && e.turnsLeft <= 0));
    if (dmg > 0) log.push(`${targetName(entity)} takes ${dmg} fire damage`);
    return dmg;
  }

  function mobTickEffects(mob) {
    mob.statusEffects = (mob.statusEffects ?? [])
      .map(e => e.skipFirstTick ? { ...e, skipFirstTick: false } : { ...e, turnsLeft: e.turnsLeft - 1 })
      .filter(e => e.turnsLeft > 0);
  }

  function getMobStat(mob, stat) {
    let v = mob.stats[stat] ?? 0;
    for (const e of (mob.statusEffects ?? [])) {
      if (e.stat === stat) v += e.value;
    }
    return Math.max(0, v);
  }

  function targetName(e) { return e.name ?? e.id ?? '?'; }

  // ── Loot ──────────────────────────────────────────────────────────────────

  function resolveLoot(player, mob) {
    let coins = mob.coins ?? 0;
    if (mob.coinDice) for (let i = 0; i < mob.coinDice; i++) coins += Dice.d6();
    if (player.hasEquipped('big_knife'))    coins += 15;
    if (player.hasEquipped('small_pistol')) coins *= 2;
    if (player.hasEnchantment('plunder'))   coins += 5;

    const STAT_KEYS = ['F','D','A','M','C','V'];
    const qtyMult = player.hasEquipped('bottomless_bag') ? 2 : 1;
    const items = [];
    for (const entry of (mob.lootTable ?? [])) {
      if (entry.rollForStat) {
        const stat  = STAT_KEYS[Dice.d6() - 1];
        const potId = `pot_${stat}${entry.potionValue ?? 3}`;
        const qty   = (entry.count ?? 1) * qtyMult;
        for (let i = 0; i < qty; i++) items.push(potId);
      } else {
        const qty = (entry.count ?? 1) * qtyMult;
        for (let i = 0; i < qty; i++) items.push(entry.itemId);
      }
    }
    return { items, coins };
  }

  // ── Enchantment effects on hit ────────────────────────────────────────────

  function applyEnchantmentsOnHit(player, mob, log) {
    if (player.hasEnchantment('fury')) {
      const tier = player.getEnchantmentTier('fury');
      mob.stats.A = Math.max(0, mob.stats.A - tier);
      log.push({ text: `Fury: ${targetName(mob)} loses ${tier}A`, type: 'enchant' });
    }
    if (player.hasEnchantment('hawk_eye')) {
      const tier = player.getEnchantmentTier('hawk_eye');
      mob.stats.V = Math.max(0, mob.stats.V - tier);
      log.push({ text: `Hawk Eye: ${targetName(mob)} loses ${tier}V`, type: 'enchant' });
    }
    if (player.hasEnchantment('flame')) {
      mob.statusEffects = mob.statusEffects ?? [];
      mob.statusEffects.push({ type:'fire', turnsLeft:1 });
      log.push({ text: `Flame: ${targetName(mob)} will burn next turn`, type: 'enchant' });
    }
  }

  // ── Charisma action ───────────────────────────────────────────────────────

  function sampleMobLoot(mob) {
    const STAT_KEYS = ['F','D','A','M','C','V'];
    const items = [];
    for (const entry of (mob.lootTable ?? [])) {
      if (entry.rollForStat) {
        const stat = STAT_KEYS[Dice.d6() - 1];
        items.push(`pot_${stat}${entry.potionValue ?? 3}`);
      } else {
        items.push(entry.itemId);
      }
    }
    return { items, coins: mob.coins ?? 0 };
  }

  function resolveCharismaRoll(player, mob, log) {
    const playerRoll = player.getStat('C') + Dice.d6();
    const mobC       = getMobStat(mob, 'C');
    const diff       = playerRoll - mobC;
    const sign       = diff >= 0 ? '+' : '';
    log.push(`Charisma: ${player.name} rolls C+d6=${playerRoll} vs ${targetName(mob)} C=${mobC} → ${sign}${diff}`);
    return { diff, playerRoll, mobC, pendingLoot: sampleMobLoot(mob) };
  }

  function generateQuest() {
    const types       = ['kill','mock','deceive','befriend','respect'];
    const targetTypes = ['mob','mob','mob','boss'];
    const type        = types[Math.floor(Math.random() * types.length)];
    const targetType  = targetTypes[Math.floor(Math.random() * targetTypes.length)];
    const count       = targetType === 'boss' ? 1 : (Dice.d6() <= 3 ? 1 : Dice.d6() <= 4 ? 2 : 3);
    return { type, targetType, count, progress: 0, id: Date.now() };
  }

  function questDescription(quest) {
    const t = quest.targetType === 'boss' ? 'a boss' : `${quest.count} mob${quest.count > 1 ? 's' : ''}`;
    return `${quest.type} ${t}`;
  }

  function grantCharismaXP(player, family, tier) {
    const abilityKey = `${family}:${tier}`;
    if (player.charismaAbilitiesUsed.has(abilityKey)) return; // already used this fight
    if (player.charismaXpActionsThisFight >= CHA_XP_ACTIONS_PER_FIGHT) return; // hit cap
    player.charismaAbilitiesUsed.add(abilityKey);
    player.charismaXpActionsThisFight++;
    player.gainXP('C', CHA_XP_PER_TIER[tier]);
  }

  function applyCharismaOutcome(player, mob, action, charismaResult, log) {
    const { family, tier } = action;
    switch (`${family}:${tier}`) {

      case 'friendly:1': {
        // Gift: 1 random drop in zones 0–1, 2 different drops in zones 2–3
        grantCharismaXP(player, family, tier);
        const pool  = [...charismaResult.pendingLoot.items];
        const count = Math.min(pool.length, CHA_ZONE_GIFT_ITEMS[chaZone(mob)]);
        if (count > 0) {
          const given = [];
          for (let i = 0; i < count; i++) {
            const itemId = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
            player.addItem(itemId);
            given.push(getItem(itemId)?.name ?? itemId);
          }
          log.push(`${targetName(mob)} gifts ${given.join(' and ')}!`);
        } else {
          log.push(`${targetName(mob)} has nothing to give.`);
        }
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end' };
      }

      case 'friendly:2': {
        grantCharismaXP(player, family, tier);
        player.healHeart(1);
        log.push(`${player.name} +1 ❤ (${player.hearts.current}/${player.hearts.max})`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end' };
      }

      case 'friendly:3': {
        if (player.friendsList.length >= 4) {
          log.push(`${targetName(mob)} is impressed, but your party is full (max 4 friends).`);
          player.clearFightEffects(); mob.statusEffects = [];
          return { outcome: 'charisma_end' };
        }
        grantCharismaXP(player, family, tier);
        player.friendsList.push({
          uid: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
          id: mob.id, name: mob.name,
          hearts: { current: mob.hearts.current, max: mob.hearts.max },
          stats: { ...mob.stats }, lootTable: mob.lootTable ?? [],
          statusEffects: [],
          isAnimal: mob.isAnimal ?? false,
          evolutionKills: 0,
        });
        log.push(`${targetName(mob)} joins your friends list!`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'befriended' };
      }

      case 'mock:1': {
        grantCharismaXP(player, family, tier);
        const { stat1, stat2 } = action;
        const v1 = getMobStat(mob, stat1);
        const v2 = getMobStat(mob, stat2);
        const turns = Dice.d6();
        mob.statusEffects = mob.statusEffects ?? [];
        mob.statusEffects.push({ type: 'malus', stat: stat1, value: v2 - v1, turnsLeft: turns, skipFirstTick: true });
        mob.statusEffects.push({ type: 'malus', stat: stat2, value: v1 - v2, turnsLeft: turns, skipFirstTick: true });
        log.push(`${targetName(mob)}: ${stat1}↔${stat2} swapped for ${turns} turns`);
        return { outcome: 'ongoing' };
      }

      case 'mock:2': {
        grantCharismaXP(player, family, tier);
        const amount = Dice.d6();
        const turns = Dice.d6();
        mob.statusEffects = mob.statusEffects ?? [];
        mob.statusEffects.push({ type: 'malus', stat: action.stat, value: -amount, turnsLeft: turns, skipFirstTick: true });
        log.push(`${targetName(mob)} −${amount}${action.stat} for ${turns} turns`);
        return { outcome: 'ongoing' };
      }

      case 'mock:3': {
        grantCharismaXP(player, family, tier);
        const amount = Dice.d6();
        const turns = Dice.d6();
        player.statusEffects.push({ type: 'bonus', stat: action.stat, value: amount, turnsLeft: turns, skipFirstTick: true });
        log.push(`${player.name} +${amount}${action.stat} for ${turns} turns`);
        return { outcome: 'ongoing' };
      }

      case 'deceive:1':
      case 'deceive:2':
      case 'deceive:3': {
        grantCharismaXP(player, family, tier);
        // d6 × 3/5/8, multiplied by the zone factor (×1 / ×2 / ×3 / ×4 for tiers 0–3)
        const zoneMult = CHA_ZONE_COIN_MULT[chaZone(mob)];
        let coins = Dice.d6() * [0, 3, 5, 8][tier] * zoneMult;
        if (player.hasEquipped('con_artist_hat')) coins *= 2;
        player.coins += coins;
        log.push(tier === 3
          ? `${player.name} pulls off a grand heist — steals ${coins} coins and flees!`
          : `${player.name} steals ${coins} coins and flees!`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end', coinsChanged: true };
      }

      case 'respect:1': {
        grantCharismaXP(player, family, tier);
        const { mobItemId, playerItemId } = action;
        if (mobItemId) {
          player.addItem(mobItemId);
          log.push(`${player.name} receives ${getItem(mobItemId)?.name ?? mobItemId} from ${targetName(mob)}`);
        }
        if (playerItemId) {
          player.removeItem(playerItemId);
          log.push(`${player.name} gives ${getItem(playerItemId)?.name ?? playerItemId} to ${targetName(mob)}`);
        }
        if (!mobItemId && !playerItemId) log.push('No items exchanged.');
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end' };
      }

      case 'respect:2': {
        grantCharismaXP(player, family, tier);
        const quest = generateQuest();
        player.quests.push(quest);
        log.push(`Quest received: ${questDescription(quest)}`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end' };
      }

      case 'respect:3': {
        if (player.dialogueSkillsGained >= 4) {
          log.push(`${player.name} has reached the dialogue skill limit (4 gains) — no further stat bonus.`);
          player.clearFightEffects(); mob.statusEffects = [];
          return { outcome: 'charisma_end' };
        }
        grantCharismaXP(player, family, tier);
        // Learn: always +1 C (no ceiling)
        player.baseStats.C++;
        player.dialogueSkillsGained++;
        log.push(`${player.name} permanently gains +1 C (now ${player.baseStats.C}) [${player.dialogueSkillsGained}/4 dialogue gains]`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'charisma_end' };
      }

      case 'kill:1': {
        grantCharismaXP(player, family, tier);
        mob.hearts.current = 0;
        const loot = resolveLoot(player, mob);
        log.push(`${player.name} commands the enemy to die — instant kill!`);
        player.clearFightEffects(); mob.statusEffects = [];
        return { outcome: 'victory', loot };
      }

      default:
        return { outcome: 'ongoing' };
    }
  }

  // ── Kryss + initiative (no auto-attack) ───────────────────────────────────

  function initFight(player, mob) {
    const log = [];
    mob.statusEffects = mob.statusEffects ?? [];

    if (player.hasEquipped('kryss')) {
      mob.hearts.current--;
      log.push(`Kryss: ${player.name} strikes before the fight! ${targetName(mob)} ❤ ${mob.hearts.current}/${mob.hearts.max}`);
      if (mob.hearts.current <= 0) {
        const loot = resolveLoot(player, mob);
        player.clearFightEffects();
        log.push(`${player.name} wins!`);
        return { outcome: 'victory', loot, log };
      }
    }

    const playerInit = player.getStat('V') + Dice.d6();
    const mobInit    = getMobStat(mob, 'V'); // initiative uses flat mob V
    const playerFirst = playerInit > mobInit;
    log.push(`Initiative: ${player.name} ${playerInit} vs ${targetName(mob)} ${mobInit} → ${playerFirst ? player.name : targetName(mob)} goes first`);

    return { outcome: 'ongoing', playerFirst, log };
  }

  // ── Player's attack half-turn ─────────────────────────────────────────────
  // Player acts (attack / bail / bard), mob rolls to defend.

  function takePlayerAttack(player, mob, action, fightLog) {
    const newLog = [];

    // Fire tick for player at start of their turn
    const fpDmg = processFire(player, newLog);
    if (fpDmg) {
      player.takeDamage(fpDmg);
      if (!player.isAlive) {
        const droppedLoot = player.dropLoot();
        player.clearFightEffects(); mob.statusEffects = [];
        fightLog.push(...newLog);
        return { outcome: 'defeat', droppedLoot, newLog };
      }
    }

    if (action.type === 'bail') {
      if (player.canEscape()) {
        player.consumeEscape(action.method ?? null);
        newLog.push(`${player.name} escapes!`);
        player.clearFightEffects(); mob.statusEffects = [];
        fightLog.push(...newLog);
        return { outcome: 'escaped', newLog };
      }
      newLog.push(`Cannot escape!`);

    } else if (action.type === 'run') {
      if (player.chainedTurns > 0) {
        newLog.push(`${player.name} is chained — cannot run!`);
        fightLog.push(...newLog);
        return { outcome: 'ongoing', newLog };
      }
      const playerRoll = player.getStat('V') + Dice.d6();
      const mobV       = mob.stats.V;
      newLog.push(`${player.name} tries to run: V+d6=${playerRoll} vs ${targetName(mob)} V=${mobV}`);
      if (playerRoll > mobV) {
        newLog.push(`Escaped!`);
        player.clearFightEffects(); mob.statusEffects = [];
        fightLog.push(...newLog);
        return { outcome: 'escaped', newLog };
      }
      newLog.push(`Failed to run — ${targetName(mob)} attacks!`);
      fightLog.push(...newLog);
      return { outcome: 'ongoing', newLog };

    } else if (!checkLightningBlock(player, newLog)) {

      if (action.type === 'attack') {
        const { attackType, spellId } = action;
        const spell = spellId ? getItem(spellId) : null;

        // Magic attack requires a spell or Cursed Ring
        if (attackType === 'M' && !player.canAttackMagic()) {
          newLog.push(`${player.name} needs a spell to attack with Magic!`);
          fightLog.push(...newLog);
          return { outcome: 'ongoing', newLog };
        }

        // Garrote: auto-kill on F when mob has ≤2 hearts (no roll)
        if (attackType === 'F' && player.hasEquipped('garrote') && mob.hearts.current <= 2) {
          player.consumeTempBonus('F');
          mob.hearts.current = 0;
          newLog.push(`Garrote! ${targetName(mob)} is executed!`);
          if (player.hasEnchantment('bloodlust')) { player.healHeart(1); newLog.push(`Bloodlust: ${player.name} +1 ❤`); }
          const loot = resolveLoot(player, mob);
          newLog.push(`${player.name} wins!`);
          player.clearFightEffects(); mob.statusEffects = [];
          fightLog.push(...newLog);
          return { outcome: 'victory', loot, newLog };
        }

        let attackRoll = player.getStat(attackType) + Dice.d6();
        if (attackType === 'M' && spell?.magicValue) {
          attackRoll += spell.magicValue * (player.hasEquipped('dark_tome') ? 2 : 1);
        }
        player.consumeTempBonus(attackType);
        if (spellId) {
          if (player.hasEquipped('cursed_ring')) {
            if (player.halfUsedSpells.has(spellId)) {
              player.halfUsedSpells.delete(spellId);
              player.removeItem(spellId);
              newLog.push(`Cursed Ring: spell consumed (2nd use)`);
            } else {
              player.halfUsedSpells.add(spellId);
              newLog.push(`Cursed Ring: spell has 1 use remaining`);
            }
          } else {
            player.removeItem(spellId);
          }
        }
        if (spellId && spell?.magicValue) player.gainXP('M', spell.magicValue);

        const mobDefRoll = mobRoll(mob, DEFENSE_FOR[attackType]);
        newLog.push(`${player.name} [${attackType}]: ${attackRoll} vs ${targetName(mob)} defends ${mobDefRoll}`);

        let coinsChanged = false;
        if (attackRoll > mobDefRoll) {
          mob.hearts.current--;
          newLog.push(`Hit! ${targetName(mob)} ❤ ${mob.hearts.current}/${mob.hearts.max}`);
          if ((player.combatXpHits ?? 0) < 10) { player.combatXpHits = (player.combatXpHits ?? 0) + 1; player.gainXP(attackType, 1); }
          // Pickpocket Glove: steal 2×d6 coins on successful D hit
          if (attackType === 'D' && player.hasEquipped('pickpocket_glove')) {
            const stolen = Dice.d6() + Dice.d6();
            player.coins += stolen;
            newLog.push(`Pickpocket: stole ${stolen} coins!`);
            coinsChanged = true;
          }
          if (spell?.effect) applyEffect(spell.effect, mob, newLog);
          applyEnchantmentsOnHit(player, mob, newLog);
          if (mob.hearts.current <= 0) {
            if (spell?.effect?.type === 'blood')    { player.healHeart(1); newLog.push(`Blood: ${player.name} +1 ❤`); }
            if (player.hasEnchantment('bloodlust')) { player.healHeart(1); newLog.push(`Bloodlust: ${player.name} +1 ❤`); }
            const loot = resolveLoot(player, mob);
            newLog.push(`${player.name} wins!`);
            player.clearFightEffects(); mob.statusEffects = [];
            fightLog.push(...newLog);
            return { outcome: 'victory', loot, newLog };
          }
        } else {
          newLog.push(`Miss`);
          if ((player.combatXpHits ?? 0) < 10) { player.combatXpHits = (player.combatXpHits ?? 0) + 1; player.gainXP(attackType, 2); }
        }
        if (coinsChanged) { fightLog.push(...newLog); return { outcome: 'ongoing', newLog, coinsChanged }; }

      } else if (action.type === 'bard') {
        const charismaResult = resolveCharismaRoll(player, mob, newLog);
        const diff = charismaResult.diff;
        player.consumeTempBonus('C'); // potions / alcohol / blessing last one roll, like attacks
        // C XP is granted per distinct ability used (in applyCharismaOutcome), not per roll
        if (diff >= 1) {
          if (player.hasEquipped('cursed_rattle')) {
            mob.hearts.current--;
            newLog.push(`Cursed Rattle: ${targetName(mob)} takes 1 damage! ❤ ${mob.hearts.current}/${mob.hearts.max}`);
            if (mob.hearts.current <= 0) {
              if (player.hasEnchantment('bloodlust')) { player.healHeart(1); newLog.push(`Bloodlust: ${player.name} +1 ❤`); }
              const loot = resolveLoot(player, mob);
              newLog.push(`${player.name} wins!`);
              player.clearFightEffects(); mob.statusEffects = [];
              fightLog.push(...newLog);
              return { outcome: 'victory', loot, newLog };
            }
          }
          if (diff >= 3) {
            fightLog.push(...newLog);
            return { outcome: 'charisma_pending', charismaResult, newLog };
          }
          // Near miss (diff 1–2): the crowd warms up — +1 C until the fight ends (stacks)
          player.statusEffects.push({ type: 'bonus', stat: 'C', value: CHA_NEAR_MISS_BONUS,
                                      turnsLeft: 9999, source: 'near_miss' });
          const total = player.statusEffects
            .filter(e => e.source === 'near_miss').reduce((s, e) => s + e.value, 0);
          newLog.push({ text: `So close! ${targetName(mob)} is warming up to you — +${CHA_NEAR_MISS_BONUS} C for this fight (total +${total})`, type: 'bard' });
        } else {
          newLog.push(`Charisma failed — mob ignores you`);
        }
      }
    }

    fightLog.push(...newLog);
    return { outcome: 'ongoing', newLog };
  }

  // ── Mob's attack half-turn ────────────────────────────────────────────────
  // Mob rolls to attack, player rolls to defend.
  // Status effects tick at end of this half (= end of full round).

  function takeMobAttack(player, mob, fightLog, preRolledAtkType = null) {
    const newLog = [];
    let parried = false;

    // Fire tick for mob at start of their turn
    const fmDmg = processFire(mob, newLog);
    if (fmDmg) {
      mob.hearts.current -= fmDmg;
      if (mob.hearts.current <= 0) {
        const loot = resolveLoot(player, mob);
        newLog.push(`${targetName(mob)} burns to death!`);
        player.clearFightEffects(); mob.statusEffects = [];
        fightLog.push(...newLog);
        return { outcome: 'victory', loot, newLog };
      }
    }

    if (!checkLightningBlock(mob, newLog)) {
      if (player.isSmokeActive) {
        newLog.push(`${targetName(mob)} cannot attack — smoke screen`);
      } else {
        const atkType    = preRolledAtkType ?? mobHighestAttack(mob);
        const mobAtkRoll = mobRoll(mob, atkType);
        const defStatKey = playerDefStatKey(player, atkType);
        const defRoll    = player.getDefenseStat(atkType) + Dice.d6();
        player.consumeTempBonus(defStatKey);

        newLog.push(`${targetName(mob)} [${atkType}]: ${mobAtkRoll} vs ${player.name} defends ${defRoll}`);

        if (mobAtkRoll > defRoll) {
          if ((player.combatXpHits ?? 0) < 10) { player.combatXpHits = (player.combatXpHits ?? 0) + 1; player.gainXP('A', 2); if (atkType === 'D') player.gainXP('V', 2); }
          if (player.hasEnchantment('thorns') && Math.random() < 0.3) {
            mob.hearts.current--;
            newLog.push(`Thorns! ${targetName(mob)} ❤ ${mob.hearts.current}/${mob.hearts.max}`);
            if (mob.hearts.current <= 0) {
              const loot = resolveLoot(player, mob);
              player.clearFightEffects(); mob.statusEffects = [];
              fightLog.push(...newLog);
              return { outcome: 'victory', loot, newLog };
            }
          } else {
            player.takeDamage(1);
            newLog.push(`Hit! ${player.name} ❤ ${player.hearts.current}/${player.hearts.max}`);
            if (!player.isAlive) {
              const droppedLoot = player.dropLoot();
              player.clearFightEffects(); mob.statusEffects = [];
              fightLog.push(...newLog);
              return { outcome: 'defeat', droppedLoot, newLog };
            }
          }
        } else {
          newLog.push(`Miss`);
          if ((player.combatXpHits ?? 0) < 10) { player.combatXpHits = (player.combatXpHits ?? 0) + 1; player.gainXP('A', 1); if (atkType === 'D') player.gainXP('V', 1); }
          parried = true;
        }
      }
    }

    // Tick all status effects at end of full round
    player.tickStatusEffects();
    mobTickEffects(mob);

    fightLog.push(...newLog);
    return { outcome: 'ongoing', newLog, parried };
  }

  // ── Deployed-friend combat round ─────────────────────────────────────────
  // Both friend and mob use the mob formula: stat − 3 + d6.
  // Player enchantments do not apply mid-round (friend has no equipment),
  // but Bloodlust and resolveLoot bonuses still go to the player on kill.

  function resolveFriendRound(friend, mob, player, fightLog) {
    const newLog = [];

    // Friend attacks (picks its highest stat)
    const fAtkType  = mobHighestAttack(friend);
    const fAtkRoll  = getMobStat(friend, fAtkType) - 3 + Dice.d6();
    const mDefRoll  = mobRoll(mob, DEFENSE_FOR[fAtkType]);
    newLog.push(`${friend.name} [${fAtkType}]: ${fAtkRoll} vs ${targetName(mob)} defends ${mDefRoll}`);

    if (fAtkRoll > mDefRoll) {
      mob.hearts.current--;
      newLog.push(`Hit! ${targetName(mob)} ❤ ${mob.hearts.current}/${mob.hearts.max}`);
      if (mob.hearts.current <= 0) {
        if (player.hasEnchantment('bloodlust')) {
          player.healHeart(1);
          newLog.push(`Bloodlust: ${player.name} +1 ❤`);
        }
        const loot = resolveLoot(player, mob);
        newLog.push(`${friend.name} defeats ${targetName(mob)}!`);
        player.clearFightEffects(); mob.statusEffects = [];
        fightLog.push(...newLog);
        return { outcome: 'victory', loot, newLog };
      }
    } else {
      newLog.push('Miss');
    }

    // Mob attacks friend
    const mAtkType  = mobHighestAttack(mob);
    const mAtkRoll  = mobRoll(mob, mAtkType);
    const fDefStat  = DEFENSE_FOR[mAtkType];
    const fDefRoll  = (friend.stats[fDefStat] ?? 0) - 3 + Dice.d6();
    newLog.push(`${targetName(mob)} [${mAtkType}]: ${mAtkRoll} vs ${friend.name} defends ${fDefRoll}`);

    if (mAtkRoll > fDefRoll) {
      friend.hearts.current--;
      newLog.push(`Hit! ${friend.name} ❤ ${friend.hearts.current}/${friend.hearts.max}`);
      if (friend.hearts.current <= 0) {
        newLog.push(`${friend.name} has fallen!`);
        fightLog.push(...newLog);
        return { outcome: 'friend_died', newLog };
      }
    } else {
      newLog.push('Miss');
    }

    mobTickEffects(mob);
    fightLog.push(...newLog);
    return { outcome: 'ongoing', newLog };
  }

  return { initFight, takePlayerAttack, takeMobAttack, rollMobAttack: mobHighestAttack,
           resolveCharismaRoll, applyCharismaOutcome, questDescription, resolveFriendRound, resolveLoot,
           charismaMaxTier,
           CHA_ZONE_COIN_MULT, CHA_ZONE_GIFT_ITEMS };
})();
