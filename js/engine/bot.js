// Bot AI — rule-based strategic agents with distinct per-strategy plans.
// chooseCombatAction() and takeTurn() are the external API (drop-in NN target).

const BotAI = (() => {

  // ── Per-player state (strategy cached after setup roll) ─────────────────────
  const botState = {};

  // ── Equipment tier lists (lowest → highest) ────────────────────────────────
  const SLOT_TIERS = {
    strength:  ['knife','sword','mace','axe','greatsword','halberd'],
    dexterity: ['sling','bow','longbow','crossbow','pistol','arquebus'],
    magic:     ['wand','staff','necklace','ring','orb','grimoire'],
    charisma:  ['flute','lyre','lute','trumpet','guitar','accordion'],
    speed:     ['shoes','boots','mule','horse','carriage','pegasus'],
    armor:     ['jacket','lt_armor','md_armor','hv_armor'],
    shield:    ['shield','lg_shield'],
  };

  const STRATEGY_SLOT    = { F:'strength', D:'dexterity', M:'magic', C:'charisma' };
  const STRATEGY_ENCHANT = { F:'sharpness', D:'precision', M:'arcane', C:'thorns' };

  // End-game gear targets per strategy (F/D/M).
  // Tier-6 offensive weapon + armor/shield/speed.
  const GENERIC_GEAR_PLAN = {
    F: [
      { id:'halberd',   slot:'strength',  cost:60 },
      { id:'hv_armor',  slot:'armor',     cost:40 },
      { id:'lg_shield', slot:'shield',    cost:30 },
      { id:'pegasus',   slot:'speed',     cost:60 },
    ],
    D: [
      { id:'arquebus',  slot:'dexterity', cost:60 },
      { id:'hv_armor',  slot:'armor',     cost:40 },
      { id:'lg_shield', slot:'shield',    cost:30 },
      { id:'pegasus',   slot:'speed',     cost:60 },
    ],
    M: [
      { id:'grimoire',  slot:'magic',     cost:90 },
      { id:'hv_armor',  slot:'armor',     cost:40 },
      { id:'lg_shield', slot:'shield',    cost:30 },
      { id:'pegasus',   slot:'speed',     cost:60 },
    ],
  };

  // Pre-dragon boss sequences per strategy.
  // BOSS_KEY_DROPS: item id that confirms a kill (in inventory or equipped).
  const STRATEGY_BOSS_SEQUENCE = {
    F: ['supreme_werewolf', 'king'],   // alpha_fang(9F) → legendary_sword(10F)
    D: ['prince', 'sea_serpent'],      // legendary_bow(10D) → divine_lance(8D)
    M: ['witch', 'grand_sorcerer'],    // magic_broom(8M) → supreme_grimoire(10M)
    C: ['king'],                       // legendary_sword(10F)/royal_crown(10A)/boss_magic_flute(10C)
  };
  const BOSS_KEY_DROPS = {
    F: { supreme_werewolf:'alpha_fang',       king:          'legendary_sword'  },
    D: { prince:          'legendary_bow',    sea_serpent:   'divine_lance'     },
    M: { witch:           'magic_broom',      grand_sorcerer:'supreme_grimoire' },
    C: { king:            'legendary_sword'   },
  };

  // C-strategy enchantment plan (applied in order at Master once gear is equipped).
  // strength→sharpness(60) / speed→arcane(50) / shield→resistance(50) /
  // armor→lightness(30) / charisma→thorns(100)
  const C_ENCHANT_PLAN = [
    { slot:'strength',  enchantId:'sharpness'  },
    { slot:'speed',     enchantId:'arcane'     },
    { slot:'shield',    enchantId:'resistance' },
    { slot:'armor',     enchantId:'lightness'  },
    { slot:'charisma',  enchantId:'thorns'     },
  ];

  // ── Strategy selection ──────────────────────────────────────────────────────
  // Chosen once after setup roll from the highest base stat.
  // C gets a tie-break bonus because high-C bots unlock permanent stat gains
  // via miniboss charisma farming (respect:3 outcome).
  function getStrategy(player) {
    if (!botState[player.id]) botState[player.id] = {};
    if (!botState[player.id].strategy) {
      const s = player.baseStats;
      const score = st => s[st] + (st === 'C' ? 0.5 : 0);
      botState[player.id].strategy =
        ['F','D','M','C'].reduce((best, st) => score(st) > score(best) ? st : best, 'F');
    }
    return botState[player.id].strategy;
  }

  // ── Equipment helpers ───────────────────────────────────────────────────────

  // Primary power of an item: max positive statBonus value.
  // Works for regular equipment (F:6) and boss drops (F:10) alike.
  function itemPower(item) {
    if (!item?.statBonus) return 0;
    return Math.max(...Object.values(item.statBonus).filter(v => v > 0), 0);
  }

  function equippedPower(player, slot) {
    return itemPower(player.equipped[slot]);
  }

  function hasItemAnywhere(player, id) {
    return player.hasItem(id) ||
           Object.values(player.equipped).some(e => e?.id === id);
  }

  // True if player has an item for this slot (equipped or in bag) with power ≥ minPower.
  function hasSlotPowerAnywhere(player, slot, minPower) {
    if (equippedPower(player, slot) >= minPower) return true;
    return player.inventory.some(id => {
      const item = getItem(id);
      return item?.slot === slot && itemPower(item) >= minPower;
    });
  }

  // ── Phase detection ─────────────────────────────────────────────────────────

  // C strategy phases (in order):
  //   accordion → stat_farm → gear_buy → enchant → prep → king → dragon
  function getCPhase(player) {
    // Any King drop confirms the King was killed → go for Dragon
    if (['legendary_sword','royal_crown','boss_magic_flute'].some(id => hasItemAnywhere(player, id))) {
      return 'dragon';
    }

    // Endgame gear: armor≥6 (hv_armor), shield≥3 (lg_shield),
    //               strength≥6 (halberd), speed≥6 (pegasus).
    // Checks inventory OR equipped so gear_buy ends as soon as items are purchased.
    const hasAllGear =
      hasSlotPowerAnywhere(player, 'armor',    6) &&
      hasSlotPowerAnywhere(player, 'shield',   3) &&
      hasSlotPowerAnywhere(player, 'strength', 6) &&
      hasSlotPowerAnywhere(player, 'speed',    6);

    if (hasAllGear) {
      // Gear must be equipped before enchanting (equip at next Shop visit)
      const allEquipped = C_ENCHANT_PLAN.every(({ slot }) => !!player.equipped[slot]);
      if (!allEquipped) return 'gear_buy';

      // Enchant each slot in plan order
      const needsEnchant = C_ENCHANT_PLAN.some(({ slot }) => !player.equipped[slot].enchantment);
      if (needsEnchant) return 'enchant';

      // Stock heal potions before fighting King
      const healCount = player.inventory.filter(id => id === 'pot_heal').length;
      if (healCount < 3) return 'prep';

      return 'king';
    }

    // Accordion acquired → farm minibosses for stat boosts, then buy endgame gear
    if (hasItemAnywhere(player, 'accordion')) {
      const statSum = ['F','D','A','M','C','V'].reduce((s, st) => s + player.getStat(st), 0);
      return statSum >= 42 ? 'gear_buy' : 'stat_farm';
    }

    return 'accordion'; // first goal: save 60 coins and buy accordion at Shop
  }

  // F/D/M: milestone phases in order —
  //   accordion → stat_farm → gear_buy → enchant → boss_prep → boss_<id>... → dragon
  function getGenericPhase(player, strat) {
    const offSlot  = STRATEGY_SLOT[strat];
    const sequence = STRATEGY_BOSS_SEQUENCE[strat];
    const keyDrops = BOSS_KEY_DROPS[strat];

    // Dragon: all pre-dragon bosses confirmed via key drops
    if (sequence.every(id => hasItemAnywhere(player, keyDrops[id]))) return 'dragon';

    // Determine next boss target
    const nextBoss = sequence.find(id => !hasItemAnywhere(player, keyDrops[id]));

    // Boss-ready: weapon enchanted + effective stat ≥ 8 + heal potions stocked
    const weaponEq       = player.equipped[offSlot];
    const weaponEnchanted = !!(weaponEq?.enchantment);
    const statReady      = player.getStat(strat) >= 8;
    const healStock      = player.inventory.filter(id => id === 'pot_heal').length;

    if (weaponEnchanted && statReady && healStock >= 2) return `boss_${nextBoss}`;

    // boss_prep: ready in every way except consumables
    if (weaponEnchanted && statReady && healStock < 2) return 'boss_prep';

    // enchant: have a tier-5+ weapon in hand or bag, needs enchantment
    const hasGoodWeapon = hasSlotPowerAnywhere(player, offSlot, 5);
    if (hasGoodWeapon && !weaponEnchanted) return 'enchant';

    // gear_buy: base offensive stat raised to 6, now buy end-game equipment
    if (player.baseStats[strat] >= 6) return 'gear_buy';

    // stat_farm: have accordion, raising stats at Master + farming miniboss bard
    if (hasItemAnywhere(player, 'accordion')) return 'stat_farm';

    // accordion: first goal — save 60 coins
    return 'accordion';
  }

  function getPhase(player) {
    const strat = getStrategy(player);
    return strat === 'C' ? getCPhase(player) : getGenericPhase(player, strat);
  }

  // ── Readiness checks ────────────────────────────────────────────────────────
  // getGenericPhase only returns 'boss_<id>' / 'dragon' when already ready,
  // so a phase match is sufficient.
  function isReadyForBossId(player, bossId, strat, phase) {
    if (bossId === 'dragon') return phase === 'dragon';
    if (strat === 'C' && bossId === 'king') return phase === 'king';
    return phase === `boss_${bossId}`;
  }

  function isReadyForBoss(player) {
    const strat = getStrategy(player);
    return getPhase(player) === 'dragon';
  }

  function isOverfarming(player) {
    return player.coins > 400 || player.inventory.length > 12;
  }

  function maxSafeMiniTier(player) {
    const off = player.getStat(getStrategy(player));
    if (off >= 10) return 3;
    if (off >=  7) return 2;
    if (off >=  4) return 1;
    return 0;
  }

  // ── Equipment slot priority per strategy/phase ─────────────────────────────
  // Returns the slots the bot cares about in priority order.
  function getEquipSlots(player) {
    const strat = getStrategy(player);
    if (strat === 'C') {
      const phase = getCPhase(player);
      // Late C phases also equip strength (halberd for King/Dragon fights)
      if (['gear_buy','enchant','prep','king','dragon'].includes(phase)) {
        return ['charisma','strength','armor','shield','speed'];
      }
      return ['charisma','armor','shield','speed'];
    }
    const phase = getGenericPhase(player, strat);
    // During stat_farm: equip accordion (charisma slot) to maximise bard rolls
    if (phase === 'accordion' || phase === 'stat_farm') {
      return ['charisma', STRATEGY_SLOT[strat], 'armor', 'shield', 'speed'];
    }
    return [STRATEGY_SLOT[strat], 'armor', 'shield', 'speed'];
  }

  // ── Sell / Buy helpers ──────────────────────────────────────────────────────
  function findItemToSell(player) {
    const strat     = getStrategy(player);
    const equipSlots = getEquipSlots(player);

    const UNIVERSAL_KEEP = new Set([
      'pot_heal','rope','compass','map','sp_invisibility','sp_teleport',
      'sp_smoke','sp_transmutation','chain','trap','dragon_blood',
    ]);
    // C-bot protects its gear plan items and offensive potions
    const C_KEEP = new Set([
      'accordion','halberd','pegasus','lg_shield','hv_armor','pot_F3','pot_F2',
    ]);

    // F/D/M: accordion is essential during stat_farm; protect end-game gear plan items
    const genericPhase = strat !== 'C' ? getGenericPhase(player, strat) : null;
    const GENERIC_KEEP = new Set();
    if (strat !== 'C') {
      if (genericPhase === 'accordion' || genericPhase === 'stat_farm') {
        GENERIC_KEEP.add('accordion');
      }
      for (const { id } of (GENERIC_GEAR_PLAN[strat] ?? [])) GENERIC_KEEP.add(id);
      const offPotId = { F:'pot_F3', D:'pot_D3', M:'pot_M3' }[strat];
      if (offPotId) GENERIC_KEEP.add(offPotId);
    }

    function shouldKeep(id) {
      if (UNIVERSAL_KEEP.has(id)) return true;
      if (strat === 'C' && C_KEEP.has(id)) return true;
      if (strat !== 'C' && GENERIC_KEEP.has(id)) return true;
      if (id.startsWith('priest_pot_')) return true;
      return false;
    }

    // 1. Sell slotted equipment outclassed by what's currently equipped
    for (const id of player.inventory) {
      const item = getItem(id);
      if (!item?.slot || !item.buyPrice || shouldKeep(id)) continue;
      const slot = item.slot;
      if (equippedPower(player, slot) > 0 && itemPower(item) <= equippedPower(player, slot)) return id;
      // Sell off-strategy offensive items (slots not in our equip priority)
      const isOffensive = ['strength','dexterity','magic','charisma'].includes(slot);
      if (isOffensive && !equipSlots.includes(slot)) return id;
    }

    // 2. Sell excess consumables when inventory is cluttered
    if (player.inventory.length > 8) {
      for (const id of player.inventory) {
        const item = getItem(id);
        if (!item?.buyPrice || item.slot || item.subtype) continue;
        if (shouldKeep(id)) continue;
        return id;
      }
    }

    return null;
  }

  function findItemToBuy(player) {
    const strat = getStrategy(player);
    const coins = player.coins;

    // Emergency heal always takes priority
    if (player.hearts.current <= 2 && coins >= 50 && !player.hasItem('pot_heal')) {
      return 'pot_heal';
    }

    if (strat === 'C') {
      const phase = getCPhase(player);

      if (phase === 'accordion') {
        // Save everything for the accordion — don't buy anything cheaper first
        return coins >= 60 ? 'accordion' : null;
      }

      if (phase === 'stat_farm') {
        return null; // no spending; save for gear phase
      }

      if (phase === 'gear_buy') {
        // Buy in priority order; skip if already own something at least as powerful
        const gearPlan = [
          { id:'hv_armor',  slot:'armor',    cost:40 },
          { id:'lg_shield', slot:'shield',   cost:30 },
          { id:'halberd',   slot:'strength', cost:60 },
          { id:'pegasus',   slot:'speed',    cost:60 },
        ];
        for (const { id, slot, cost } of gearPlan) {
          if (hasItemAnywhere(player, id)) continue;
          const item = getItem(id);
          if (!item) continue;
          if (equippedPower(player, slot) >= itemPower(item)) continue; // already better
          if (coins >= cost) return id;
        }
        return null;
      }

      if (phase === 'prep') {
        // Stock 5 heal potions then 3 Potion 3F for King fight
        const healCount = player.inventory.filter(id => id === 'pot_heal').length;
        if (healCount < 5 && coins >= 50) return 'pot_heal';
        const fPotCount = player.inventory.filter(id => id === 'pot_F3').length;
        if (fPotCount < 3 && coins >= 30) return 'pot_F3';
        return null;
      }

      if (phase === 'king' || phase === 'dragon') {
        // Keep at least 2 heal potions heading into boss fights
        const healCount = player.inventory.filter(id => id === 'pot_heal').length;
        if (healCount < 2 && coins >= 50) return 'pot_heal';
      }

      return null;
    }

    // F / D / M: phase-driven purchasing
    const gPhase = getGenericPhase(player, strat);

    if (gPhase === 'accordion') {
      // First goal: accordion (60 coins) for the C-exploit stat farm
      return coins >= 60 ? 'accordion' : null;
    }

    if (gPhase === 'stat_farm') {
      // Save for gear phase (190-220 coins needed); spending is done at Master
      return null;
    }

    if (gPhase === 'gear_buy') {
      // Buy end-game gear in priority order; skip if already owned or outclassed
      for (const { id, slot, cost } of GENERIC_GEAR_PLAN[strat] ?? []) {
        if (hasItemAnywhere(player, id)) continue;
        const item = getItem(id);
        if (!item) continue;
        if (equippedPower(player, slot) >= itemPower(item)) continue; // already better
        if (coins >= cost) return id;
      }
      // M-strategy: also need at least one attack spell
      if (strat === 'M' && coins >= 10) {
        const hasSpell = player.inventory.some(id => getItem(id)?.subtype === 'attack');
        if (!hasSpell) return 'bang';
      }
      return null;
    }

    if (gPhase === 'boss_prep') {
      // Stock 3 heal potions + 2 offensive stat potions before boss fights
      const healCount = player.inventory.filter(id => id === 'pot_heal').length;
      if (healCount < 3 && coins >= 50) return 'pot_heal';
      const offPotId = { F:'pot_F3', D:'pot_D3', M:'pot_M3' }[strat];
      const potCount = player.inventory.filter(id => id === offPotId).length;
      if (offPotId && potCount < 2 && coins >= 30) return offPotId;
      return null;
    }

    if (gPhase.startsWith('boss_') || gPhase === 'dragon') {
      // Maintain a floor of 2 heal potions heading into and between boss fights
      const healCount = player.inventory.filter(id => id === 'pot_heal').length;
      if (healCount < 2 && coins >= 50) return 'pot_heal';
      return null;
    }

    return null;
  }

  // ── Equipment optimisation step ─────────────────────────────────────────────
  // Returns { action:'equip', itemId } | { action:'unequip', slot } | null.
  function equipStep(player) {
    const slots = getEquipSlots(player);

    for (const slot of slots) {
      // Find best inventory item for this slot by itemPower (handles boss drops correctly)
      let bestId = null, bestPower = equippedPower(player, slot);
      for (const id of player.inventory) {
        const item = getItem(id);
        if (!item || item.slot !== slot) continue;
        const p = itemPower(item);
        if (p > bestPower) { bestPower = p; bestId = id; }
      }
      if (!bestId) continue;

      // Slot occupied — unequip current first
      if (player.equipped[slot]) return { action: 'unequip', slot };

      // At 5-slot cap — sacrifice a non-priority equipped slot
      if (!player.canEquip(getItem(bestId))) {
        const keepSlots = new Set(slots);
        const allSlots  = ['strength','dexterity','magic','charisma','speed','armor','shield'];
        const sacrifice = allSlots.find(s => player.equipped[s] && !keepSlots.has(s));
        if (sacrifice) return { action: 'unequip', slot: sacrifice };
        continue;
      }

      return { action: 'equip', itemId: bestId };
    }
    return null;
  }

  // ── Shop handler ─────────────────────────────────────────────────────────────
  function handleShopTurn(player) {
    const eq = equipStep(player);
    if (eq) {
      Game.submitAction(eq.action === 'equip'
        ? { type: 'equip',   itemId: eq.itemId }
        : { type: 'unequip', slot:   eq.slot   });
      return;
    }
    const sellId = findItemToSell(player);
    if (sellId) { Game.submitAction({ type: 'sell', itemId: sellId }); return; }
    const buyId  = findItemToBuy(player);
    if (buyId)  { Game.submitAction({ type: 'buy',  itemId: buyId  }); return; }
    Game.submitAction({ type: 'close' });
  }

  // ── Master handler ──────────────────────────────────────────────────────────
  function handleMasterTurn(player) {
    const strat = getStrategy(player);
    const coins = player.coins;

    if (strat === 'C') {
      const phase = getCPhase(player);

      if (phase === 'stat_farm') {
        // Raise C skill to improve charisma roll against minibosses
        if (coins >= 50 && player.baseStats['C'] < 6) {
          Game.submitAction({ type: 'buy_skill', stat: 'C' });
          return;
        }
        Game.submitAction({ type: 'close' });
        return;
      }

      if (phase === 'enchant') {
        // Apply C_ENCHANT_PLAN in order; skip slots that are missing or already enchanted
        for (const { slot, enchantId } of C_ENCHANT_PLAN) {
          const eq = player.equipped[slot];
          if (!eq || eq.enchantment) continue;
          const enchObj = ENCHANTMENTS.find(e => e.id === enchantId);
          const cost    = enchObj?.cost ?? 50;
          if (coins >= cost) {
            Game.submitAction({ type: 'enchant', slot, enchantId, tier: 1 });
            return;
          }
        }
        Game.submitAction({ type: 'close' });
        return;
      }

      if (phase === 'dragon') {
        // Enchant King drops (legendary_sword, royal_crown, boss_magic_flute) if unenchanted
        const kingEnchants = [
          { slot:'strength', enchantId:'sharpness',  cost:60  },
          { slot:'armor',    enchantId:'resistance', cost:50  },
          { slot:'charisma', enchantId:'thorns',     cost:100 },
        ];
        for (const { slot, enchantId, cost } of kingEnchants) {
          const eq = player.equipped[slot];
          if (!eq || eq.enchantment) continue;
          if (coins >= cost) {
            Game.submitAction({ type: 'enchant', slot, enchantId, tier: 1 });
            return;
          }
        }
        Game.submitAction({ type: 'close' });
        return;
      }

      Game.submitAction({ type: 'close' });
      return;
    }

    // F / D / M: phase-driven Master actions
    const gPhase  = getGenericPhase(player, strat);
    const offSlot = STRATEGY_SLOT[strat];

    if (gPhase === 'stat_farm' || gPhase === 'accordion') {
      // Raise primary offensive stat first, then A and V up to 6
      for (const stat of [strat, 'A', 'V']) {
        if (coins >= 50 && player.baseStats[stat] < 6) {
          Game.submitAction({ type: 'buy_skill', stat });
          return;
        }
      }
      Game.submitAction({ type: 'close' });
      return;
    }

    if (gPhase === 'enchant' || gPhase === 'boss_prep' ||
        gPhase.startsWith('boss_') || gPhase === 'dragon') {
      // Enchant the equipped offensive weapon if unenchanted
      const eq = player.equipped[offSlot];
      if (eq && !eq.enchantment) {
        const enchId  = STRATEGY_ENCHANT[strat];
        const enchObj = ENCHANTMENTS.find(e => e.id === enchId);
        if (enchObj && coins >= (enchObj.cost ?? 50)) {
          Game.submitAction({ type: 'enchant', slot: offSlot, enchantId: enchId, tier: 1 });
          return;
        }
      }
      // M-strategy: ensure at least one attack spell
      if (strat === 'M' && coins >= 10) {
        const hasSpell = player.inventory.some(id => getItem(id)?.subtype === 'attack');
        if (!hasSpell) { Game.submitAction({ type: 'buy', itemId: 'bang' }); return; }
      }
      Game.submitAction({ type: 'close' });
      return;
    }

    // gear_buy phase: nothing to do at Master; close
    Game.submitAction({ type: 'close' });
  }

  // ── Teleport handler ─────────────────────────────────────────────────────────
  function handleTeleportTurn(player, state) {
    const dests = state.teleportDestinations ?? [];
    if (!dests.length) { Game.submitAction({ type: 'close' }); return; }
    const strat = getStrategy(player);
    const phase = getPhase(player);
    // Prefer Master when enchanting or rich enough to buy skills; else Shop
    const wantsMaster = (strat === 'C' && (phase === 'enchant' || phase === 'dragon'))
                      || (strat !== 'C' && player.coins >= 50);
    const prefer = wantsMaster ? TileType.MASTER : TileType.SHOP;
    const dest   = dests.find(d => d.tileType === prefer) ?? dests[0];
    Game.submitAction({ type: 'teleport_confirm', dest });
  }

  // ── Map-choice handler ───────────────────────────────────────────────────────
  function handleMapChoice() {
    Game.submitAction({ type: 'map_roll', value: 6 }); // always pick the best outcome
  }

  // ── Movement scoring ─────────────────────────────────────────────────────────
  function scoreTile(x, y, steps, player, state) {
    const tType = MapGrid.get(x, y);
    const strat = getStrategy(player);
    const phase = getPhase(player);
    let score   = steps; // base: prefer tiles further along the map

    switch (tType) {

      case TileType.FIRE:
        score += player.hearts.current <= Math.ceil(player.hearts.max / 2) ? 1200 : 120;
        break;

      case TileType.BAR:
        if (player.hearts.current < player.hearts.max && player.coins >= 10) {
          const ratio = player.hearts.current / player.hearts.max;
          score += ratio <= 0.25 ? 900 : ratio <= 0.5 ? 550 : 280;
        }
        break;

      case TileType.SHOP: {
        const needsHeal  = player.hearts.current <= 2 && player.coins >= 50 && !player.hasItem('pot_heal');
        const wantsToBuy = findItemToBuy(player);
        const wantsToSell = findItemToSell(player);
        const cluttered  = player.inventory.length > 8;
        // 0 when nothing actionable — prevents bot looping back to shop between turns
        let s = needsHeal ? 800 : (wantsToBuy || wantsToSell || cluttered) ? 420 : 0;

        if (strat === 'C') {
          if (phase === 'gear_buy' && wantsToBuy) s = Math.max(s, 650);
          else if (phase === 'prep')              s = Math.max(s, 400);
          else if (phase === 'accordion' && player.coins >= 60) s = Math.max(s, 700);
        } else {
          const gPhase = getGenericPhase(player, strat);
          if (gPhase === 'accordion' && !hasItemAnywhere(player, 'accordion') && player.coins >= 60)
            s = Math.max(s, 750);
          else if (gPhase === 'gear_buy' && wantsToBuy) s = Math.max(s, 650);
          else if (gPhase === 'boss_prep' && wantsToBuy) s = Math.max(s, 600);
        }
        // Coin-overflow trigger: >200 coins and there's something to buy → don't sit on gold
        if (player.coins > 200 && wantsToBuy) s = Math.max(s, 650);

        score += s;
        break;
      }

      case TileType.MASTER: {
        // 0 by default — only score positively when there is a concrete action pending
        let s = 0;
        if (strat === 'C') {
          if (phase === 'enchant' || phase === 'dragon') s = 600;
          else if (phase === 'stat_farm' && player.coins >= 50) s = 300;
        } else {
          const gPhase = getGenericPhase(player, strat);
          if (gPhase === 'stat_farm' && player.coins >= 50) s = 550;
          else if (gPhase === 'enchant') {
            const eq = player.equipped[STRATEGY_SLOT[strat]];
            if (eq && !eq.enchantment && player.coins >= 50) s = 650;
          }
        }
        // Coin-overflow trigger: >200 coins and Master has skills/enchants pending
        if (player.coins > 200 && strat !== 'C') {
          const gPhase = getGenericPhase(player, strat);
          if (gPhase === 'stat_farm') s = Math.max(s, 600);
          if (gPhase === 'enchant')   s = Math.max(s, 650);
        }
        score += s;
        break;
      }

      case TileType.WORK: {
        // All bots need income during accordion/stat_farm/gear_buy phases
        const wPhase = strat === 'C' ? phase : getGenericPhase(player, strat);
        if (['accordion','stat_farm','gear_buy'].includes(wPhase)) {
          score += player.coins < 60 ? 350 : player.coins < 200 ? 180 : 70;
        } else {
          score += player.coins < 100 ? 200 : 70;
        }
        break;
      }

      case TileType.REROLL:
        // Only valuable on turns where the bot wants to push further — don't loop on it
        score += player.hasUsedTile ? (player.hasUsedTile(x, y) ? 20 : 100) : 100;
        break;

      case TileType.PRIEST: {
        const hasBlessing = player.inventory.some(id => id.startsWith('priest_pot_')) || player.priestBuff > 0;
        score += (!player.hasUsedTile(x, y) && !hasBlessing) ? 240 : 0;
        break;
      }

      case TileType.BOSS: {
        const bossId = MapGrid.getTileData(x, y)?.bossId;
        if (!bossId) break;
        if (bossId === 'dragon') {
          if (isReadyForBoss(player))  score += 900;
          else if (isOverfarming(player)) score += 150;
          else                         score -= 500;
        } else {
          score += isReadyForBossId(player, bossId, strat, phase) ? 700 : -350;
        }
        break;
      }

      case TileType.MINIBOSS: {
        const mTier  = MapGrid.getTileData(x, y)?.minibossTier ?? 0;
        const mPhase = strat === 'C' ? phase : getGenericPhase(player, strat);
        if (player.hearts.current <= 1) {
          score -= 400; // never fight on last heart
        } else if (mPhase === 'stat_farm') {
          // All strategies: farm low-tier minibosses with bard for free stat gains (respect:3)
          const cPow = player.getStat('C');
          if      (mTier === 0 && cPow >= 7) score += 600; // accordion equipped — high bard odds
          else if (mTier <= 1 && cPow >= 5)  score += 450;
          else if (mTier <= 2 && cPow >= 9)  score += 350;
          else if (mTier <= maxSafeMiniTier(player)) score += 120;
          else score -= 200;
        } else if (mTier <= maxSafeMiniTier(player)) {
          score += 80;
        } else {
          score -= 250;
        }
        break;
      }

      case TileType.RANDOM_EVENT:
        if (strat === 'C' && phase === 'accordion') {
          score += player.hasUsedTile(x, y) ? -30 : 80; // events can yield coins/items early on
        } else if (player.hasUsedTile(x, y)) {
          score -= 60;
        } else {
          score += player.hearts.current <= 1 ? -120 : 60;
        }
        break;

      case TileType.CHEST: {
        const chPhase = strat === 'C' ? phase : getGenericPhase(player, strat);
        if (player.hasUsedTile(x, y)) {
          score -= 80;
        } else if (['accordion','stat_farm','gear_buy'].includes(chPhase)) {
          score += 380; // primary coin source during equipment-building phases
        } else {
          score += 150;
        }
        break;
      }

      case TileType.GUILD_ASSASSIN:
      case TileType.GUILD_THIEF:
        score += player.coins >= 50 ? 220 : 0;
        break;

      case TileType.STOP:
        score -= 520;
        break;

      case TileType.BACK:
        score -= 380;
        break;
    }

    return score;
  }

  function chooseMove(player, state) {
    const reachable = state.reachableTiles;
    if (!reachable || reachable.size === 0) return player.position;

    // PVP: rush to FINISH if carrying princess
    if (player.hasPrincess) {
      let finish = null;
      reachable.forEach((_, key) => {
        const [x, y] = key.split(',').map(Number);
        if (MapGrid.get(x, y) === TileType.FINISH) finish = { x, y };
      });
      if (finish) return finish;
    }

    // PVP: step onto princess tile to pick her up
    if (state.pvpActive && !player.hasPrincess && state.princess) {
      const pk = `${state.princess.x},${state.princess.y}`;
      if (reachable.has(pk)) return { x: state.princess.x, y: state.princess.y };
    }

    let best = null, bestScore = -Infinity;
    reachable.forEach((steps, key) => {
      const [x, y] = key.split(',').map(Number);
      const s = scoreTile(x, y, steps, player, state);
      if (s > bestScore) { bestScore = s; best = { x, y }; }
    });

    return best ?? player.position;
  }

  // ── Combat decisions ─────────────────────────────────────────────────────────
  function chooseCombatAction(player, mob) {
    // Bail on last heart if escape is available; try running if chained and desperate
    if (player.hearts.current <= 1 && player.canEscape()) {
      return { type: 'bail' };
    }
    if (player.hearts.current <= 1 && player.chainedTurns === 0) {
      return { type: 'run' };
    }

    const strat = getStrategy(player);
    const combatPhase = strat === 'C' ? getCPhase(player) : getGenericPhase(player, strat);

    // In stat_farm phase: try bard on low-tier mobs when C power is good enough for respect:3
    // (avg d6=3.5; need player.C + 3.5 > mob.C + 6.5 for tier-3 outcome, i.e. getStat('C') >= mob.C + 4)
    if (combatPhase === 'stat_farm' && mob.tier <= 1) {
      const cPow = player.getStat('C');
      if (cPow >= mob.stats.C + 3) return { type: 'bard' };
    }

    const defenseFor = { F:'A', D:'V', M:'M', C:'C' };
    const available  = ['F','D','M','C'].filter(t =>
      !(t === 'M' && !player.canAttackMagic())
    );

    // Score each attack type: player effective stat minus mob defense stat + strategy bias
    let best = null, bestScore = -Infinity;
    for (const t of available) {
      const s = player.getStat(t) - (mob.stats[defenseFor[t]] ?? 0)
              + (t === strat ? 0.5 : 0);
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

  // ── Charisma outcome decision ────────────────────────────────────────────────
  function charismaOutcomeDecision(player, combat) {
    const diff    = combat.charismaResult?.diff ?? 0;
    const maxTier = diff >= 7 ? 3 : diff >= 5 ? 2 : 1;

    if (diff < 1) return { type: 'charisma_outcome', retreat: true };

    // Tier 3: permanent +1 stat — always the top priority (core of C-strategy farming)
    if (maxTier >= 3) {
      return { type: 'charisma_outcome', family: 'respect', tier: 3 };
    }

    // Tier 2: heal if wounded; otherwise debuff mob's strongest attack stat
    if (maxTier >= 2) {
      if (player.hearts.current < player.hearts.max) {
        return { type: 'charisma_outcome', family: 'friendly', tier: 2 };
      }
      const mob     = combat.mob;
      const topStat = ['F','D','M','C']
        .reduce((b, s) => mob.stats[s] > mob.stats[b] ? s : b, 'F');
      return { type: 'charisma_outcome', family: 'mock', tier: 2, stat: topStat };
    }

    // Tier 1: retreat if hurt; else steal coins
    if (player.hearts.current <= Math.ceil(player.hearts.max / 2)) {
      return { type: 'charisma_outcome', retreat: true };
    }
    return { type: 'charisma_outcome', family: 'deceive', tier: 1 };
  }

  // ── Main turn dispatcher ─────────────────────────────────────────────────────
  function takeTurn(player) {
    const state = Game.getState();
    const phase = state.phase;

    if (phase === Game.Phase.ROLL_MOVE) {
      Game.submitAction({ type: 'roll' });
      return;
    }

    if (phase === Game.Phase.MOVING) {
      Game.submitAction({ type: 'move', dest: chooseMove(player, state) });
      return;
    }

    if (phase === Game.Phase.COMBAT) {
      const combat = state.pendingCombat;
      if (!combat) return;
      const sub = combat.combatSubPhase;
      if      (sub === 'mob_attack')      Game.submitAction({ type: 'defend' });
      else if (sub === 'charisma_pick')   Game.submitAction(charismaOutcomeDecision(player, combat));
      else if (sub === 'friend_fighting') Game.submitAction({ type: 'friend_round' });
      else if (sub === 'friend_died')     Game.submitAction({ type: 'friend_take_over' });
      else                                Game.submitAction(chooseCombatAction(player, combat.mob));
      return;
    }

    if (phase === Game.Phase.SHOP)            { handleShopTurn(player);             return; }
    if (phase === Game.Phase.MASTER)          { handleMasterTurn(player);           return; }
    if (phase === Game.Phase.TELEPORT_CHOICE) { handleTeleportTurn(player, state); return; }
    if (phase === Game.Phase.MAP_CHOICE)      { handleMapChoice();                  return; }
    if (phase === Game.Phase.CHEST) {
      const rolls = state.pendingChestRolls ?? [];
      Game.submitAction({ type: 'chest_pick', value: Math.max(...rolls) });
      return;
    }

    // LOOT_CONFIRM, PRIEST, WORK, CHEST, STOP_BLOCKED → auto-confirm
    Game.submitAction({ type: 'tile_confirm' });
  }

  return { chooseCombatAction, takeTurn };
})();
