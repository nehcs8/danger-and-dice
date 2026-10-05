// Mob catalog — Tier 0 through Tier 3 + Bosses.
// Stats: F=Forza, A=Armatura, M=Magia, C=Carisma, D=Destrezza, V=Velocità
// lootTable: one entry is picked at random (Bottomless Bag gives all).
// coins: flat coins on kill.  coinDice: roll that many d6 and add to coins.
// Drop notation used in design: nX = tier-n item of stat X, iNxW = spell tier N weight W,
//   PNxW = potion tier N weight W, sangue X = unique blood drop.

const MOBS = (() => {

  function mob(id, name, tier, F, A, M, C, D, V, hearts, lootTable, coins = 0, coinDice = 0) {
    return { id, name, tier, stats:{F,A,M,C,D,V}, hearts:{current:hearts, max:hearts}, lootTable, coins, coinDice };
  }

  const list = [

    // ── Tier 0 ────────────────────────────────────────────────────────────────
    // 2D=bow, 1A=jacket, soldix3
    mob('ladro',     'Thief',     0,  7, 7, 4, 7, 7, 8,  2,
      [{itemId:'bow'},{itemId:'jacket'}],
      0, 3),

    // 2F=sword, 2A=lt_armor
    mob('guardia',   'Guard',     0,  9, 9, 5, 5, 5, 6,  2,
      [{itemId:'sword'},{itemId:'lt_armor'}],
      20),

    // 4V=horse, 2F=sword
    mob('cavaliere', 'Knight',    0,  8, 9, 8, 6, 6, 8,  2,
      [{itemId:'horse'},{itemId:'sword'}],
      25),

    // 2V=boots, 2M=staff, P1=random stat
    mob('ranger',    'Ranger',    0,  5, 6, 8, 6, 8, 8,  2,
      [{itemId:'boots'},{itemId:'staff'},{rollForStat:true, potionValue:1}],
      15),

    // 3M=necklace, i1x3=bang×3
    mob('mago',      'Mage',      0,  6, 8, 9, 9, 4, 6,  2,
      [{itemId:'necklace'},{itemId:'bang', count:3}],
      20),

    // 3D=longbow, 1F=knife
    mob('goblin',    'Goblin',    0,  4, 6, 5, 4, 9, 9,  2,
      [{itemId:'longbow'},{itemId:'knife'}],
      5),

    // ── Tier 1 ────────────────────────────────────────────────────────────────
    // 4D=crossbow, soldix5
    mob('guerriero', 'Warrior',   1, 11, 7, 8, 8,11,11,  3,
      [{itemId:'crossbow'}],
      20, 5),

    // 4F=axe, 2A=lt_armor
    mob('nano',      'Dwarf',     1,  8,12, 9, 9,11, 8,  3,
      [{itemId:'axe'},{itemId:'lt_armor'}],
      30),

    // 4A-1V=md_armor, i1x3=bang×3
    mob('monaco',    'Monk',      1, 10, 9,10,10,10, 9,  3,
      [{itemId:'md_armor'},{itemId:'bang', count:3}],
      25),

    // 3F=mace, 2A=lt_armor, P1x3=random stat
    mob('orco',      'Orc',       1, 12,12, 8, 8, 7,10,  3,
      [{itemId:'mace'},{itemId:'lt_armor'},{rollForStat:true, potionValue:1, count:3}],
      25),

    // 3M=necklace, P1x3=random stat
    mob('centauro',  'Centaur',   1, 11,11,11, 7, 7,11,  3,
      [{itemId:'necklace'},{rollForStat:true, potionValue:1, count:3}],
      35),

    // 3M=necklace, 3D=longbow, i2x2expl=bomb×2
    mob('elfo',      'Elf',       1,  7, 8,11,10,11,12,  3,
      [{itemId:'necklace'},{itemId:'longbow'},{itemId:'bomb', count:2}],
      30),

    // ── Tier 2 ────────────────────────────────────────────────────────────────
    // 5D=pistol, sp_teleport
    mob('assassino', 'Assassin',  2,  9,12,12, 9,15,15,  4,
      [{itemId:'pistol'},{itemId:'sp_teleport'}],
      40),

    // sangue vampiro, 5M=orb, P2x3=random stat
    mob('vampiro',   'Vampire',   2, 10,10,14,12,14,15,  4,
      [{itemId:'vampire_blood'},{itemId:'orb'},{rollForStat:true, potionValue:2, count:3}],
      50),

    // sangue mannaro, i2x2bleed=laceration×2
    mob('mannaro',   'Werewolf',  2, 15,15,11,10,10,14,  5,
      [{itemId:'werewolf_blood'},{itemId:'laceration', count:2}],
      40),

    // 4M=ring, i2x2frost=blizzard×2
    mob('centauro_s','Greater Centaur',    2, 14,11,14,11,14,12, 4,
      [{itemId:'ring'},{itemId:'blizzard', count:2}],
      55),

    // 6A-2V=hv_armor, 4V=horse, 4F=axe
    mob('paladino',  'Paladin',   2, 15,14,10,11,15,12,  5,
      [{itemId:'hv_armor'},{itemId:'horse'},{itemId:'axe'}],
      55),

    // sangue di drago, 5F=greatsword, P2x3=random stat
    mob('draconiano','Draconian', 2, 16,13,16,10,10,10,  5,
      [{itemId:'dragon_blood'},{itemId:'greatsword'},{rollForStat:true, potionValue:2, count:3}],
      50),

    // ── Tier 3 ────────────────────────────────────────────────────────────────
    // 6A-2V=hv_armor, 5D=pistol, 4V=horse
    mob('generale',  'General',   3, 12,15,15,14,18,16,  5,
      [{itemId:'hv_armor'},{itemId:'pistol'},{itemId:'horse'}],
      75),

    // P3x3=random stat, 3F=mace, 4M=ring
    mob('troll',     'Troll',     3, 17,15,12,15,17,14,  6,
      [{rollForStat:true, potionValue:3, count:3},{itemId:'mace'},{itemId:'ring'}],
      60),

    // sangue di drago, i2x2lightning=lightning×2
    mob('viverna',   'Wyvern',    3, 17,17,17,12,12,17,  5,
      [{itemId:'dragon_blood'},{itemId:'lightning', count:2}],
      70),

    // 6M=grimoire, i2x2bleed=laceration×2
    mob('demone',    'Demon',     3, 15,15,18,15,18,14,  5,
      [{itemId:'grimoire'},{itemId:'laceration', count:2}],
      60),

    // 6D=arquebus, 5F=greatsword, 5V=carriage
    mob('eroe',      'Hero',      3, 16,15,16,15,16,15,  6,
      [{itemId:'arquebus'},{itemId:'greatsword'},{itemId:'carriage'}],
      75),

    // 6F=halberd, 6V=pegasus, soldix10
    mob('gigante',   'Giant',     3, 18,18,15,15,14,15,  6,
      [{itemId:'halberd'},{itemId:'pegasus'}],
      60, 10),

    // ── Bosses (fixed map tiles) ───────────────────────────────────────────────
    // 8M=magic_broom, 8C=enchanted_flute, lightning×10
    { ...mob('witch',        'Witch',           3, 16,16,20,18,18,20,  8,
        [{itemId:'magic_broom'},{itemId:'enchanted_flute'},{itemId:'lightning', count:10}],
        0), isBoss:true },

    // divine_lance(8D), draconic_sword(8F), dragon_blood×5
    { ...mob('sea_serpent',  'Sea Serpent',     3, 20,20,16,16,18,18,  8,
        [{itemId:'divine_lance'},{itemId:'draconic_sword'},{itemId:'dragon_blood', count:5}],
        0), isBoss:true },

    // legendary_bow(10D), swift_boots(8V)
    { ...mob('prince',       'Prince',          3, 16,18,18,18,20,18,  8,
        [{itemId:'legendary_bow'},{itemId:'swift_boots'}],
        0), isBoss:true },

    // winged_boots(10V), 5×pot_?3 (stat rolled at drop), 5×pot_?3 (second roll), pot_heal×5
    { ...mob('phoenix',      'Phoenix',         3, 18,18,16,16,18,20,  9,
        [{itemId:'winged_boots'},
         {rollForStat:true, potionValue:3, count:5},
         {rollForStat:true, potionValue:3, count:5},
         {itemId:'pot_heal', count:5}],
        0), isBoss:true },

    // supreme_grimoire(10M), arcane_armor(8A), rend×10
    { ...mob('grand_sorcerer','Grand Sorcerer', 3, 18,18,20,20,18,20,  9,
        [{itemId:'supreme_grimoire'},{itemId:'arcane_armor'},{itemId:'rend', count:10}],
        0), isBoss:true },

    // legendary_sword(10F), royal_crown(10A), boss_magic_flute(10C)
    { ...mob('king',         'King',            3, 20,20,20,20,20,18, 10,
        [{itemId:'legendary_sword'},{itemId:'royal_crown'},{itemId:'boss_magic_flute'}],
        0), isBoss:true },

    // principessa handled by game.js on death; dragon_blood×10, 100×d6 coins
    { ...mob('dragon',       'Dragon',          3, 20,20,20,20,20,20, 12,
        [{itemId:'dragon_blood', count:10}],
        0, 100), isBoss:true },

    // alpha_fang(9F), werewolf_blood×3, laceration×3
    { ...mob('supreme_werewolf', 'Supreme Werewolf',  3, 22,20,14,12,18,22, 10,
        [{itemId:'alpha_fang'},{itemId:'werewolf_blood', count:3},{itemId:'laceration', count:3}],
        0), isBoss:true },

    // iron_fortress(9A), legendary_sword(10F)
    { ...mob('supreme_knight',   'Supreme Knight',    3, 22,18,22,14,18,18, 10,
        [{itemId:'iron_fortress'},{itemId:'legendary_sword'}],
        0), isBoss:true },
  ];

  // ── Animal variants (random-event creatures with graded skewed stats) ──────
  {
    const GRADES = [
      { adj: 'Feeble', domStat:  6, otherStat: 2, hearts: 1, tier: 0 },
      { adj: 'Weak',   domStat: 10, otherStat: 3, hearts: 1, tier: 0 },
      { adj: 'Wild',   domStat: 14, otherStat: 4, hearts: 1, tier: 1 },
      { adj: 'Rabid',  domStat: 19, otherStat: 5, hearts: 2, tier: 1 },
      { adj: 'Fierce', domStat: 25, otherStat: 7, hearts: 2, tier: 2 },
      { adj: 'Savage', domStat: 32, otherStat: 9, hearts: 2, tier: 3 },
    ];
    const SPECIES = [
      { id: 'bear',    name: 'Bear',    dom: 'F'    },
      { id: 'fox',     name: 'Fox',     dom: 'D'    },
      { id: 'owl',     name: 'Owl',     dom: 'M'    },
      { id: 'parrot',  name: 'Parrot',  dom: 'C'    },
      { id: 'wolf',    name: 'Wolf',    dom: 'FD'   },
      { id: 'serpent', name: 'Serpent', dom: 'FM'   },
      { id: 'gorilla', name: 'Gorilla', dom: 'FC'   },
      { id: 'hawk',    name: 'Hawk',    dom: 'DM'   },
      { id: 'raven',   name: 'Raven',   dom: 'DC'   },
      { id: 'peacock', name: 'Peacock', dom: 'MC'   },
      { id: 'wyvern',  name: 'Wyvern',  dom: 'FDM'  },
      { id: 'panther', name: 'Panther', dom: 'FDC'  },
      { id: 'sphinx',  name: 'Sphinx',  dom: 'FMC'  },
      { id: 'harpy',   name: 'Harpy',   dom: 'DMC'  },
      { id: 'chimera', name: 'Chimera', dom: 'FDMC' },
    ];
    for (const sp of SPECIES) {
      const dominant = new Set(sp.dom.split(''));
      for (const g of GRADES) {
        const stats = {};
        for (const s of ['F','D','M','A','V','C'])
          stats[s] = dominant.has(s) ? g.domStat : g.otherStat;
        list.push({
          id: `${sp.id}_${g.adj.toLowerCase()}`,
          name: `${g.adj} ${sp.name}`,
          tier: g.tier,
          stats,
          hearts: { current: g.hearts, max: g.hearts },
          lootTable: [{ rollForStat: true, potionValue: Math.max(1, g.tier) }],
          coins: g.tier * 15,
          coinDice: g.tier,
          statusEffects: [],
          isAnimal: true,
        });
      }
    }
  }

  const registry = {};
  list.forEach(m => { registry[m.id] = m; });

  function getMob(id) { return registry[id] ?? null; }
  function getByTier(tier) { return list.filter(m => m.tier === tier); }

  // Returns a fresh copy so fights don't mutate the catalog.
  function spawn(id) {
    const template = getMob(id);
    if (!template) return null;
    return {
      ...template,
      stats: { ...template.stats },
      hearts: { ...template.hearts },
      statusEffects: [],
    };
  }

  return { list, getMob, getByTier, spawn };
})();
