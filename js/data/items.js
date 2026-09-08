// Stat keys: F=Strength, D=Dexterity, A=Armor, M=Magic, C=Charisma, V=Speed

const EQUIPMENT = [
  // --- Strength ---
  { id:'knife',       name:'Knife',        slot:'strength', tier:1, statBonus:{F:1},        buyPrice:10 },
  { id:'sword',       name:'Sword',        slot:'strength', tier:2, statBonus:{F:2},        buyPrice:20 },
  { id:'mace',        name:'Mace',         slot:'strength', tier:3, statBonus:{F:3},        buyPrice:30 },
  { id:'axe',         name:'Axe',          slot:'strength', tier:4, statBonus:{F:4},        buyPrice:40 },
  { id:'greatsword',  name:'Greatsword',   slot:'strength', tier:5, statBonus:{F:5},        buyPrice:50 },
  { id:'halberd',     name:'Halberd',      slot:'strength', tier:6, statBonus:{F:6},        buyPrice:60 },
  // --- Dexterity ---
  { id:'sling',       name:'Sling',        slot:'dexterity', tier:1, statBonus:{D:1},       buyPrice:10 },
  { id:'bow',         name:'Bow',          slot:'dexterity', tier:2, statBonus:{D:2},       buyPrice:20 },
  { id:'longbow',     name:'Longbow',      slot:'dexterity', tier:3, statBonus:{D:3},       buyPrice:30 },
  { id:'crossbow',    name:'Crossbow',     slot:'dexterity', tier:4, statBonus:{D:4},       buyPrice:40 },
  { id:'pistol',      name:'Pistol',       slot:'dexterity', tier:5, statBonus:{D:5},       buyPrice:50 },
  { id:'arquebus',    name:'Arquebus',     slot:'dexterity', tier:6, statBonus:{D:6},       buyPrice:60 },
  // --- Magic ---
  { id:'wand',        name:'Wand',         slot:'magic', tier:1, statBonus:{M:1},           buyPrice:15 },
  { id:'staff',       name:'Staff',        slot:'magic', tier:2, statBonus:{M:2},           buyPrice:30 },
  { id:'necklace',    name:'Necklace',     slot:'magic', tier:3, statBonus:{M:3},           buyPrice:45 },
  { id:'ring',        name:'Ring',         slot:'magic', tier:4, statBonus:{M:4},           buyPrice:60 },
  { id:'orb',         name:'Orb',          slot:'magic', tier:5, statBonus:{M:5},           buyPrice:75 },
  { id:'grimoire',    name:'Grimoire',     slot:'magic', tier:6, statBonus:{M:6},           buyPrice:90 },
  // --- Charisma ---
  { id:'flute',       name:'Flute',        slot:'charisma', tier:1, statBonus:{C:1},        buyPrice:10 },
  { id:'lyre',        name:'Lyre',         slot:'charisma', tier:2, statBonus:{C:2},        buyPrice:20 },
  { id:'lute',        name:'Lute',         slot:'charisma', tier:3, statBonus:{C:3},        buyPrice:30 },
  { id:'trumpet',     name:'Trumpet',      slot:'charisma', tier:4, statBonus:{C:4},        buyPrice:40 },
  { id:'guitar',      name:'Guitar',       slot:'charisma', tier:5, statBonus:{C:5},        buyPrice:50 },
  { id:'accordion',   name:'Accordion',    slot:'charisma', tier:6, statBonus:{C:6},        buyPrice:60 },
  // --- Speed ---
  { id:'shoes',       name:'Shoes',        slot:'speed', tier:1, statBonus:{V:1},           buyPrice:10 },
  { id:'boots',       name:'Boots',        slot:'speed', tier:2, statBonus:{V:2},           buyPrice:20 },
  { id:'mule',        name:'Mule',         slot:'speed', tier:3, statBonus:{V:3},           buyPrice:30 },
  { id:'horse',       name:'Horse',        slot:'speed', tier:4, statBonus:{V:4},           buyPrice:40 },
  { id:'carriage',    name:'Carriage',     slot:'speed', tier:5, statBonus:{V:5},           buyPrice:50 },
  { id:'pegasus',     name:'Pegasus',      slot:'speed', tier:6, statBonus:{V:6},           buyPrice:60 },
  // --- Armor ---
  { id:'jacket',      name:'Jacket',       slot:'armor', tier:1, statBonus:{A:1},           buyPrice:10 },
  { id:'lt_armor',    name:'Light Armor',  slot:'armor', tier:2, statBonus:{A:2},           buyPrice:20 },
  { id:'md_armor',    name:'Medium Armor', slot:'armor', tier:3, statBonus:{A:4, V:-1},     buyPrice:30 },
  { id:'hv_armor',    name:'Heavy Armor',  slot:'armor', tier:4, statBonus:{A:6, V:-2},     buyPrice:40 },
  // --- Shield ---
  { id:'shield',      name:'Shield',       slot:'shield', tier:1, statBonus:{A:2},          buyPrice:20 },
  { id:'lg_shield',   name:'Large Shield', slot:'shield', tier:2, statBonus:{A:3},          buyPrice:30 },
];

const COMBAT_SPELLS = [
  { id:'bang',         name:'Bang',         subtype:'attack', magicValue:1, effect:null,                     buyPrice:10 },
  { id:'fireball',     name:'Fireball',     subtype:'attack', magicValue:1, effect:{type:'fire',    n:1},    buyPrice:30 },
  { id:'flare',        name:'Flare',        subtype:'attack', magicValue:2, effect:{type:'fire',    n:2},    buyPrice:40 },
  { id:'blaze',        name:'Blaze',        subtype:'attack', magicValue:3, effect:{type:'fire',    n:3},    buyPrice:50 },
  { id:'blizzard',     name:'Blizzard',     subtype:'attack', magicValue:2, effect:{type:'ice',     n:2},    buyPrice:20 },
  { id:'freeze',       name:'Freeze',       subtype:'attack', magicValue:3, effect:{type:'ice',     n:3},    buyPrice:30 },
  { id:'discharge',    name:'Discharge',    subtype:'attack', magicValue:1, effect:{type:'lightning'},       buyPrice:30 },
  { id:'lightning',    name:'Lightning',    subtype:'attack', magicValue:2, effect:{type:'lightning'},       buyPrice:40 },
  { id:'bolt',         name:'Bolt',         subtype:'attack', magicValue:3, effect:{type:'lightning'},       buyPrice:50 },
  { id:'explosion',    name:'Explosion',    subtype:'attack', magicValue:1, effect:{type:'explosion', n:1},  buyPrice:30 },
  { id:'bomb',         name:'Bomb',         subtype:'attack', magicValue:2, effect:{type:'explosion', n:2},  buyPrice:40 },
  { id:'destruction',  name:'Destruction',  subtype:'attack', magicValue:3, effect:{type:'explosion', n:3},  buyPrice:50 },
  { id:'slash',        name:'Slash',        subtype:'attack', magicValue:1, effect:{type:'blood'},           buyPrice:30 },
  { id:'laceration',   name:'Laceration',   subtype:'attack', magicValue:2, effect:{type:'blood'},           buyPrice:60 },
  { id:'rend',         name:'Rend',         subtype:'attack', magicValue:3, effect:{type:'blood'},           buyPrice:90 },
  { id:'protection_1', name:'Protection I',  subtype:'defense', armorValue:2, buyPrice:10 },
  { id:'protection_2', name:'Protection II', subtype:'defense', armorValue:4, buyPrice:20 },
  { id:'protection_3', name:'Protection III',subtype:'defense', armorValue:6, buyPrice:30 },
];

const UTILITY_SPELLS = [
  { id:'sp_invisibility',  name:'Invisibility',  effect:'skip_fight',      buyPrice:15 },
  { id:'sp_teleport',      name:'Teleport',       effect:'teleport',        buyPrice:20 },
  { id:'sp_transmutation', name:'Transmutation',  effect:'transmutation',   buyPrice:20 },
  { id:'sp_disenchant',    name:'Disenchant',     effect:'disenchant',      buyPrice:30 },
  { id:'sp_curse',         name:'Curse',          effect:'curse',           buyPrice:30 },
  { id:'sp_smoke',         name:'Smoke',          effect:'immune_one_turn', buyPrice:30 },
];

const POTIONS = [
  { id:'pot_F1', name:'Potion 1F', effect:{stat:'F', value:1}, buyPrice:10 },
  { id:'pot_F2', name:'Potion 2F', effect:{stat:'F', value:2}, buyPrice:20 },
  { id:'pot_F3', name:'Potion 3F', effect:{stat:'F', value:3}, buyPrice:30 },
  { id:'pot_A1', name:'Potion 1A', effect:{stat:'A', value:1}, buyPrice:10 },
  { id:'pot_A2', name:'Potion 2A', effect:{stat:'A', value:2}, buyPrice:20 },
  { id:'pot_A3', name:'Potion 3A', effect:{stat:'A', value:3}, buyPrice:30 },
  { id:'pot_M1', name:'Potion 1M', effect:{stat:'M', value:1}, buyPrice:10 },
  { id:'pot_M2', name:'Potion 2M', effect:{stat:'M', value:2}, buyPrice:20 },
  { id:'pot_M3', name:'Potion 3M', effect:{stat:'M', value:3}, buyPrice:30 },
  { id:'pot_D1', name:'Potion 1D', effect:{stat:'D', value:1}, buyPrice:10 },
  { id:'pot_D2', name:'Potion 2D', effect:{stat:'D', value:2}, buyPrice:20 },
  { id:'pot_D3', name:'Potion 3D', effect:{stat:'D', value:3}, buyPrice:30 },
  { id:'pot_C1', name:'Potion 1C', effect:{stat:'C', value:1}, buyPrice:10 },
  { id:'pot_C2', name:'Potion 2C', effect:{stat:'C', value:2}, buyPrice:20 },
  { id:'pot_C3', name:'Potion 3C', effect:{stat:'C', value:3}, buyPrice:30 },
  { id:'pot_V1', name:'Potion 1V', effect:{stat:'V', value:1}, buyPrice:5  },
  { id:'pot_V2', name:'Potion 2V', effect:{stat:'V', value:2}, buyPrice:10 },
  { id:'pot_V3', name:'Potion 3V', effect:{stat:'V', value:3}, buyPrice:15 },
  { id:'pot_V4', name:'Potion 4V', effect:{stat:'V', value:4}, buyPrice:20 },
  { id:'pot_V5', name:'Potion 5V', effect:{stat:'V', value:5}, buyPrice:25 },
  { id:'pot_V6', name:'Potion 6V', effect:{stat:'V', value:6}, buyPrice:30 },
  { id:'pot_invis', name:'Invisibility Potion', effect:{type:'skip_fight'},    buyPrice:30 },
  { id:'pot_heal',  name:'Healing Potion',       effect:{type:'heal', value:1}, buyPrice:50 },
  { id:'alcohol_1', name:'Alcohol 1', effect:{type:'alcohol', C:1, malus:1}, buyPrice:10 },
  { id:'alcohol_2', name:'Alcohol 2', effect:{type:'alcohol', C:2, malus:1}, buyPrice:20 },
  { id:'alcohol_3', name:'Alcohol 3', effect:{type:'alcohol', C:3, malus:2}, buyPrice:30 },
  { id:'alcohol_4', name:'Alcohol 4', effect:{type:'alcohol', C:4, malus:2}, buyPrice:40 },
  { id:'alcohol_5', name:'Alcohol 5', effect:{type:'alcohol', C:5, malus:3}, buyPrice:50 },
  { id:'alcohol_6', name:'Alcohol 6', effect:{type:'alcohol', C:6, malus:3}, buyPrice:60 },
];

// Priest blessings — given by the Priest tile, one per visit, cannot be stacked.
// When used, grants +N to ALL stats for exactly one roll (attack, defense, or movement).
const PRIEST_POTIONS = [
  { id:'priest_pot_1', name:'Holy Blessing +1', effect:{type:'all_stats', value:1} },
  { id:'priest_pot_2', name:'Holy Blessing +2', effect:{type:'all_stats', value:2} },
  { id:'priest_pot_3', name:'Holy Blessing +3', effect:{type:'all_stats', value:3} },
  { id:'priest_pot_4', name:'Holy Blessing +4', effect:{type:'all_stats', value:4} },
  { id:'priest_pot_5', name:'Holy Blessing +5', effect:{type:'all_stats', value:5} },
  { id:'priest_pot_6', name:'Holy Blessing +6', effect:{type:'all_stats', value:6} },
];

const OBJECTS = [
  { id:'key',     name:'Key',     effect:{type:'open_door'},                       buyPrice:15 },
  { id:'chain',   name:'Chain',   effect:{type:'prevent_escape'},                  buyPrice:20 },
  { id:'rope',    name:'Rope',    effect:{type:'escape'},                          buyPrice:25 },
  { id:'compass', name:'Compass', effect:{type:'fast_travel'},                     buyPrice:30 },
  { id:'map',     name:'Map',     effect:{type:'choose_category'},                 buyPrice:35 },
  { id:'trap',    name:'Trap',    effect:{type:'place_trap'},                      buyPrice:40 },
];

const DROPS = [
  { id:'werewolf_blood', name:'Werewolf Blood 2F2V',   statBonus:{F:2, V:2} },
  { id:'dragon_scales',  name:'Dragon Scales 2F2A',    statBonus:{F:2, A:2} },
  { id:'witch_powder',   name:'Witch Powder 2M',       statBonus:{M:2} },
  { id:'meat',           name:'Meat 1F',               statBonus:{F:1} },
  { id:'fur',            name:'Fur 1A',                statBonus:{A:1} },
  { id:'fairy_dust',     name:'Fairy Dust 1M',         statBonus:{M:1} },
  { id:'dragon_blood',   name:'Dragon Blood 2F2M2V',   statBonus:{F:2, M:2, V:2} },
  { id:'harpy_feathers', name:'Harpy Feathers 5V',     statBonus:{V:5} },
  { id:'vampire_blood',  name:'Vampire Blood 2D2V',    statBonus:{D:2, V:2} },
  { id:'ivory',          name:'Ivory 2F2D',            statBonus:{F:2, D:2} },
  { id:'troll_tooth',    name:'Troll Tooth 3A3C3V',    statBonus:{A:3, C:3, V:3} },
];

// Special equipment sold at Assassin Guild and Thief Guild
const SPECIAL_EQUIPMENT = [
  { id:'kryss',             name:'Kryss',             slot:'strength',  statBonus:{F:1}, effect:'kryss',               guild:'assassin', buyPrice:50  },
  { id:'garrote',           name:'Garrote',           slot:'strength',  statBonus:{F:1}, effect:'garrote_kill',         guild:'assassin', buyPrice:75  },
  { id:'invis_cloak',       name:'Invisibility Cloak',slot:'armor',     statBonus:{A:1}, effect:'skip_miniboss',        guild:'assassin', buyPrice:50  },
  { id:'dark_tome',         name:'Dark Tome',         slot:'magic',     statBonus:{M:1}, effect:'double_magicvalue',    guild:'assassin', buyPrice:100 },
  { id:'cursed_ring',       name:'Cursed Ring',       slot:'magic',     statBonus:{M:1}, effect:'magic_no_spell',       guild:'assassin', buyPrice:100 },
  { id:'cursed_rattle',     name:'Cursed Rattle',     slot:'charisma',  statBonus:{C:1}, effect:'charisma_damage',      guild:'assassin', buyPrice:50  },
  { id:'blowpipe',          name:'Blowpipe',          slot:'dexterity', statBonus:{D:1}, effect:'dex_first',            guild:'assassin', buyPrice:50  },
  { id:'stealth_shoes',     name:'Stealth Shoes',     slot:'speed',     statBonus:{V:1}, effect:'always_escape',        guild:'assassin', buyPrice:50  },
  { id:'big_knife',         name:'Big Knife',         slot:'strength',  statBonus:{F:1}, effect:'coins_plus3',          guild:'thief',    buyPrice:50  },
  { id:'crowbar',           name:'Crowbar',           slot:'strength',  statBonus:{F:1}, effect:'sell_75pct',           guild:'thief',    buyPrice:75  },
  { id:'lucky_glove',       name:'Lucky Glove',       slot:'armor',     statBonus:{A:1}, effect:'double_chest',         guild:'thief',    buyPrice:100 },
  { id:'bottomless_bag',    name:'Bottomless Bag',    slot:'magic',     statBonus:{M:1}, effect:'all_drops',            guild:'thief',    buyPrice:100 },
  { id:'magic_flute_thief', name:'Magic Flute',       slot:'charisma',  statBonus:{C:1}, effect:'bard_lv2_free',        guild:'thief',    buyPrice:50  },
  { id:'con_artist_hat',    name:"Con Artist's Hat",  slot:'charisma',  statBonus:{C:1}, effect:'deceive_double_coins', guild:'thief',    buyPrice:75  },
  { id:'small_pistol',      name:'Small Pistol',      slot:'dexterity', statBonus:{D:1}, effect:'coins_times3',         guild:'thief',    buyPrice:50  },
  { id:'pickpocket_glove',  name:'Pickpocket Glove',  slot:'dexterity', statBonus:{D:1}, effect:'pickpocket',           guild:'thief',    buyPrice:75  },
  { id:'ragged_sandals',    name:'Ragged Sandals',    slot:'speed',     statBonus:{V:1}, effect:'pass_obstacles',       guild:'thief',    buyPrice:50  },
];

// Unique boss drops — tier beyond normal equipment (not buyable)
const BOSS_DROPS = [
  { id:'winged_boots',     name:'Winged Boots',      slot:'speed',     statBonus:{V:10} },
  { id:'swift_boots',      name:'Swift Boots',       slot:'speed',     statBonus:{V:8}  },
  { id:'arcane_armor',     name:'Arcane Armor',      slot:'armor',     statBonus:{A:8}  },
  { id:'enchanted_flute',  name:'Enchanted Flute',   slot:'charisma',  statBonus:{C:8}  },
  { id:'boss_magic_flute', name:'Grand Magic Flute', slot:'charisma',  statBonus:{C:10} },
  { id:'magic_broom',      name:'Magic Broom',       slot:'magic',     statBonus:{M:8}  },
  { id:'divine_lance',     name:'Divine Lance',      slot:'dexterity', statBonus:{D:8}  },
  { id:'draconic_sword',   name:'Draconic Sword',    slot:'strength',  statBonus:{F:8}  },
  { id:'supreme_grimoire', name:'Supreme Grimoire',  slot:'magic',     statBonus:{M:10} },
  { id:'legendary_sword',  name:'Legendary Sword',   slot:'strength',  statBonus:{F:10} },
  { id:'royal_crown',      name:'Royal Crown',       slot:'armor',     statBonus:{A:10} },
  { id:'legendary_bow',    name:'Legendary Bow',     slot:'dexterity', statBonus:{D:10} },
  { id:'alpha_fang',       name:'Alpha Fang',        slot:'strength',  statBonus:{F:9}  },
  { id:'iron_fortress',    name:'Iron Fortress',     slot:'shield',    statBonus:{A:9}  },
];

const ENCHANTMENTS = [
  { id:'sharpness',  name:'Sharpness',  category:'F',   cost:60,  effect:{type:'stat_bonus',            stat:'F', value:3} },
  { id:'fury',       name:'Fury',       category:'F',   cost:null, effect:{type:'armor_reduction_on_hit'} }, // cost = tier*50
  { id:'bloodlust',  name:'Bloodlust',  category:'F/D', cost:100, effect:{type:'heal_on_kill'} },
  { id:'plunder',    name:'Plunder',    category:'F/D', cost:100, effect:{type:'coins_on_kill', value:5} },
  { id:'flame',      name:'Flame',      category:'F/D', cost:100, effect:{type:'fire_on_hit'} },
  { id:'precision',  name:'Precision',  category:'D',   cost:60,  effect:{type:'stat_bonus',            stat:'D', value:3} },
  { id:'hawk_eye',   name:'Hawk Eye',   category:'D',   cost:null, effect:{type:'speed_reduction_on_hit'} }, // cost = tier*50
  { id:'arcane',     name:'Arcane',     category:'A',   cost:50,  effect:{type:'magic_defense_via_armor'} },
  { id:'thorns',     name:'Thorns',     category:'A',   cost:100, effect:{type:'reflect_30pct'} },
  { id:'lightness',  name:'Lightness',  category:'A',   cost:30,  effect:{type:'remove_speed_malus'} },
  { id:'resistance', name:'Resistance', category:'A',   cost:50,  effect:{type:'stat_bonus',            stat:'A', value:3} },
];

const BARD_ABILITIES = {
  I: [
    { id:'passage',    name:'Passage',    cost:0,   effect:'nearest_shop' },
    { id:'learn',      name:'Learn',      cost:0,   effect:'learn_lv2' },
    { id:'alms',       name:'Alms',       cost:0,   effect:'coins_x2' },
    { id:'friendship1',name:'Friendship I',cost:0,  effect:'use_mob_stats' },
    { id:'binge',      name:'Binge',      cost:0,   effect:'alcohol' },
    { id:'sympathy',   name:'Sympathy',   cost:0,   effect:'get_item_t1' },
  ],
  II: [
    { id:'joke',       name:'Joke',       cost:5,   effect:'coins_x3' },
    { id:'riddle',     name:'Riddle',     cost:10,  effect:'get_consumable' },
    { id:'poetry',     name:'Poetry',     cost:15,  effect:'coins_x5' },
    { id:'tale',       name:'Tale',       cost:20,  effect:'get_item_t2_4' },
    { id:'song',       name:'Song',       cost:30,  effect:'get_item_t4_6' },
    { id:'friendship2',name:'Friendship II',cost:40,effect:'use_miniboss_stats' },
  ],
  III: [
    { id:'epic',        name:'Epic',        cost:30,  effect:'coins_x10' },
    { id:'friendship3', name:'Friendship',  cost:100, effect:'use_boss_stats' },
    { id:'praise',      name:'Praise',      cost:50,  effect:'stat_boost_1fight' },
    { id:'philippic',   name:'Philippic',   cost:40,  effect:'enemy_malus_1fight' },
    { id:'confusion',   name:'Confusion',   cost:30,  effect:'control_enemy_attack' },
    { id:'stalling',    name:'Stalling',    cost:30,  effect:'multi_ability_safe' },
  ],
};

// Flat lookup map
const ITEM_REGISTRY = {};
[
  ...EQUIPMENT, ...COMBAT_SPELLS, ...UTILITY_SPELLS,
  ...POTIONS, ...PRIEST_POTIONS, ...OBJECTS, ...DROPS, ...SPECIAL_EQUIPMENT,
  ...BOSS_DROPS,
].forEach(item => { ITEM_REGISTRY[item.id] = item; });

function getItem(id) { return ITEM_REGISTRY[id] ?? null; }
function sellPrice(item) { return item.buyPrice ? Math.floor(item.buyPrice / 2) : 0; }
