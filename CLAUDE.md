# Danger & Dice — Project Guide for Claude

## Overview

Browser-based D&D-inspired board game. Runs from `index.html` with no server, no install, no dependencies.
Vanilla HTML/CSS/JavaScript — global namespace pattern, no ES6 modules (file:// compatibility).
Single-player with bots now; 2–4 player multiplayer via WebSockets planned later.

---

## Project Structure

```
Danger and Dice/
├── index.html              # Single page; all screens and modals in one file
├── map.csv                 # Source map (hand-designed); parsed by Python script into map.js
├── css/
│   └── style.css
└── js/
    ├── main.js             # Bootstrap: wires Game, Renderer, HUD, Panels; binds input
    ├── data/
    │   ├── items.js        # All item catalogs: EQUIPMENT, COMBAT_SPELLS, UTILITY_SPELLS,
    │   │                   #   POTIONS, OBJECTS, DROPS, SPECIAL_EQUIPMENT, BOSS_DROPS,
    │   │                   #   ENCHANTMENTS, BARD_ABILITIES. Also: ITEM_REGISTRY, getItem(), sellPrice()
    │   ├── mobs.js         # MOBS IIFE: mob catalog tiers 0–3 + bosses, spawn(), getByTier()
    │   └── map.js          # AUTO-GENERATED from map.csv. TileType constants, MapGrid IIFE,
    │                       #   51×38 grid, tileData (minibossTier / backAmount / bossId per tile),
    │                       #   isWalkable(x,y,hasSecretAccess), getAdjacent(x,y,hasSecretAccess)
    └── engine/
        ├── dice.js         # Dice.d6(), Dice.d(n), Dice.coinFlip(), Dice.rollTable(entries)
        ├── player.js       # Player class: baseStats, hearts, coins, equipped (7 slots),
        │                   #   inventory[], statusEffects[], tempBonuses{}, transmutation,
        │                   #   isSmokeActive, friendsList[], quests[]. Full stat/equip API.
        ├── movement.js     # Movement IIFE: BFS getReachable(), pathTo(), rollCap()
        ├── combat.js       # Combat IIFE: step-based API — initFight(), takePlayerAttack(),
        │                   #   takeMobAttack(), rollMobAttack(). Legacy resolve() kept for PVP.
        ├── game.js         # Game IIFE: state machine, all phase handlers, event bus (on/emit)
        ├── bot.js          # BotAI IIFE: chooseCombatAction(), takeTurn()
    └── ui/
        ├── renderer.js     # Canvas renderer (16px tiles, 51×38). Draws grid, players, princess.
        │                   #   MINIBOSS tiles colored by tier (blue/green/yellow/red for 0–3).
        ├── hud.js          # Left panel: stats, hearts, coins, equipped, phase label, roll button,
        │                   #   inventory with Use/Equip buttons. Combat-only spells shown faded.
        └── panels.js       # Overlay modals: setup roll, combat, shop, master, priest, map choice,
                            #   loot confirm, teleport choice, game over.
```

**Script load order in index.html (must be preserved):**
`dice → items → mobs → map → player → movement → combat → game → bot → renderer → hud → panels → main`

---

## Game State Machine (game.js)

### Phases

| Phase | Description |
|---|---|
| `SETUP_ROLL` | Each player rolls stats (d6×6) + starting item before game begins |
| `ROLL_MOVE` | Current player clicks "Roll Movement" button |
| `MOVING` | Player clicks a highlighted reachable tile on canvas |
| `COMBAT` | Step-based fight vs mob/miniboss/boss; subphases: `player_attack` / `mob_attack` / `charisma_pick` / `friend_fighting` / `friend_died` |
| `PVP_COMBAT` | Modal fight vs another player (post-dragon) |
| `SHOP` | Shop modal (normal or guild-specific) |
| `MASTER` | Master modal (skill upgrades, enchantments, spells) |
| `CHEST` | Chest modal |
| `PRIEST` | Priest modal |
| `WORK` | Auto-resolves: earn coins based on a rolled stat |
| `STOP_BLOCKED` | Player rolled ≤3 on Stop tile; turn is skipped |
| `MAP_CHOICE` | Player uses Map item to choose tile roll result |
| `LOOT_CONFIRM` | Popup confirming loot received before continuing |
| `TELEPORT_CHOICE` | Player using Teleport spell picks destination |
| `GAME_OVER` | Winner declared |

**Key flow:** `init()` → `SETUP_ROLL` per player → `startTurn()` → `ROLL_MOVE` → `MOVING` → `handleMove()` calls `resolveTileEvent()` directly → tile-specific phase or `endTileInteraction()` → `nextTurn()`.

### Event Bus

`Game.on(event, fn)` / `Game.emit(event, data)`.
Key events: `state_change`, `log`, `player_moved`, `setup_rolled`, `combat_update`, `combat_victory`, `player_defeated`, `dragon_defeated`, `game_over`, `loot`, `coins_changed`, `item_used`.

---

## Tile Types (TileType constants in map.js)

| Value | Name | Behavior |
|---|---|---|
| 0 | BLOCKED | Not walkable; rendered as dark grid cell |
| 1 | PATH | No event |
| 2 | RANDOM_EVENT | d6: 1-2=two weak mobs, 3=strong mob, 4=lose coins, 5=find coins, 6=find item |
| 3 | MINIBOSS | Spawn random mob of `tileData.minibossTier` (0–3). Color by tier. Map item works here. |
| 4 | CHEST | d6 roll: 1=empty, 2=coins×3, 3=consumable, 4=coins×10, 5=item t1-2, 6=item t3-6 |
| 5 | REROLL | Roll extra movement, player moves again |
| 6 | WORK | Earn zone × base_stat × d6 coins |
| 7 | STOP | Must roll >3 at turn start to leave |
| 8 | BACK | Go back `tileData.backAmount` tiles |
| 9 | PRIEST | Receive a one-time +1 to a random stat |
| 10 | SHOP | Buy/sell equipment, potions, objects |
| 11 | MASTER | Buy skill points, enchant equipment, buy spells |
| 12 | FIRE | Restore all hearts |
| 13 | BOSS | Fight fixed boss from `tileData.bossId` |
| 14 | GUILD_ASSASSIN | Buy assassin-only special equipment |
| 15 | GUILD_THIEF | Buy thief-only special equipment |
| 16 | FINISH | Win condition if player has princess |
| 17 | START | Starting position; no event |
| 18 | BAR | Pay 10 coins → restore 1 heart |
| 19 | SECRET_PATH | Only walkable with Compass (object) or Ragged Sandals equipped |

**tileData keys per tile:** `minibossTier` (0–3), `backAmount` (int), `bossId` (string matching MOBS key).

---

## Full Game Rules

### Objective
Defeat the Dragon (fixed BOSS tile). On Dragon's death: Princess drops at that position, PVP activates. First player to carry the Princess to the FINISH tile wins.

### Setup
Each player rolls d6 for each base stat (F, D, A, M, C, V) and receives one random starting item (tier-1 equipment or an object).

### Turn Sequence
1. If on STOP tile: roll d6 — ≤3 means turn is lost.
2. Roll movement: `V + d6` = movement cap.
3. Move to any tile reachable in ≤ cap steps (BFS). May stop early.
4. Tile event triggers immediately on landing.

### Stats
- **F** (Strength) — melee attack
- **D** (Dexterity) — ranged attack
- **A** (Armor) — defense vs F attacks; and vs M if Arcane enchantment
- **M** (Magic) — magic attack and defense vs M attacks
- **C** (Charisma) — bard attacks and defense vs C attacks
- **V** (Speed) — movement cap component; defense vs D attacks; initiative

Base stats rolled at start (d6 each). Can be raised +1 at Master for 50 coins (max 6 via Master; charisma `respect:3` can push to 8).

### Equipment & Slots
7 slots: Strength, Dexterity, Magic, Charisma, Speed, Armor, Shield.
**Max 5 equipped simultaneously** — forces build specialization.
Each slot has tiers 1–6 (armor has 4 tiers, shield has 2). Stats: +1 to +6 for the slot's stat. Medium/Heavy Armor give speed malus (−1V / −2V).
Sell price = half buy price. Sell list sorted alphabetically.

### Combat (step-based, interactive)

Combat alternates between `player_attack` and `mob_attack` subphases, tracked in `state.pendingCombat.combatSubPhase`. The `combat_update` event drives UI refresh between half-turns.

1. **Kryss** check (if equipped): roll d6 — if >3, mob takes 1 heart before fight starts.
2. **Initiative**: `player.V + d6` vs `mob.V` (flat). Higher goes first. Tie → mob goes first.
3. **Consumables phase** (free action, any subphase): player may use potions or combat items before rolling; bots skip this.
4. **Player attack half-turn** (`player_attack` subphase):
   - Choose attack type F / D / M / C (or Bail / Bard).
   - Roll: `player_stat + d6` (+ spell's `magicValue` for magic). Temp bonus from potions consumed after roll.
   - Mob defends: `mob_defense_stat − 3 + d6`.
   - Hit if `player_roll > mob_roll`. Spells consumed on use.
   - On hit: apply enchantment effects (Fury, Hawk Eye, Flame, Bloodlust, Plunder).
   - After resolving, mob's next attack type is pre-rolled from tied-highest stats and announced in the log.
5. **Mob attack half-turn** (`mob_attack` subphase):
   - Mob uses the pre-announced attack type (randomly selected each turn from all stats tied at the maximum).
   - Mob rolls: `mob_attack_stat − 3 + d6`.
   - Player defends: `defense_stat + d6`. Temp bonus from potions consumed after roll.
   - Hit if `mob_roll > player_roll`. Damage = 1 heart. Thorns: 30% reflect.
   - Smoke (`isSmokeActive`): player is immune this half-turn; cleared at end of tick.
   - Status effects (fire, ice, lightning) tick at end of the mob attack half-turn.
6. **Bail**: player escapes if has Rope (consumed) or Invisibility spell (consumed) or Stealth Shoes (reusable). If both Rope and Invisibility available, a picker appears. Blocked if `chainedTurns > 0`.
7. **Loot on victory**: `resolveLoot()`. Bottomless Bag doubles quantities. Coins modified by Big Knife (+3), Small Pistol (×3), Plunder (+5). Stat-potion drops use `rollForStat` — a d6 determines which stat the potion buffs.

### Mob roll formula
Both mob attack and defense use: `stat − 3 + d6` (base can be negative for low-stat mobs).
The combat panel shows each mob stat as `value (base)` e.g. `5 (+2)` so the player knows the roll range.

### Potions (stat bonuses)
Stat potions are named **Potion {N}{X}** (e.g., `Potion 3M`, `Potion 2F`; id: `pot_M3`). They apply a `tempBonus` for exactly one dice roll on the matching stat, then are consumed. Unused bonuses are cleared at fight end via `clearFightEffects()`.
Also available: **Healing Potion** (+1❤, `pot_heal`), **Invisibility Potion** (`pot_invis`), and **Alcohol 1–6** (`alcohol_1`–`alcohol_6`: +C with a malus, bought at Bar).

### Drops with stat bonuses
Items like **Dragon Blood 2F2M2V**, **Vampire Blood 2D2V**, **Werewolf Blood 2F2V**, etc. use `statBonus` and grant a persistent status effect for the duration of the current fight.

### Magic Combat
- Requires a spell (subtype: `attack`) in inventory, or Cursed Ring equipped.
- Roll: `M + d6 + spell.magicValue`. Spell consumed on use.
- Spell effects on hit: fire (burn n turns), ice (−nV), lightning (must roll >3 to act next turn), explosion (−nA), blood (+1 heart on kill).
- Magic defense: `M + d6` by default; `A + d6` with Arcane enchantment; +armorValue bonus with Protection spell in inventory.

### Bard (Charisma combat)
- Roll `C + d6` vs mob's flat C stat. If `diff >= 1`, enters `charisma_pick` subphase.
- No damage unless Cursed Rattle equipped.
- On success, player picks a **family + tier** action (`applyCharismaOutcome` in combat.js):
  - **friendly** (1=gift item, 2=heal 1❤, 3=befriend mob → adds to `friendsList`)
  - **mock** (1=swap mob stats, 2=debuff mob stat, 3=buff player stat)
  - **deceive** (1/2/3=steal coins and flee; amount scales)
  - **respect** (1=item exchange, 2=receive quest, 3=permanent +1 stat)
- Befriended mobs join `player.friendsList` and can be deployed in later combat (`deploy_friend` action).
- Charisma outcomes: `charisma_end` (flee), `befriended`, `ongoing` (fight continues).
- The `BARD_ABILITIES` catalog in items.js (I/II/III tiers) is a legacy structure; not used by combat.

### Utility Spells
| Spell | Effect | Notes |
|---|---|---|
| Invisibility | Bail from combat (consumed) | Shown via Bail button picker; not in combat consumables list |
| Teleport | Jump to any Shop / Master / Guild tile | Blocked in combat and if carrying princess; destination picked from modal |
| Transmutation | Swap any two stats for the whole fight | Used from combat consumables "Transmute" button → two-step stat picker |
| Smoke | Immune to next mob attack this turn | Used from combat consumables "Use" button |
| Disenchant | Remove enchantment from an item | Not yet implemented |
| Curse | Unknown / placeholder | Not yet implemented |

Combat-only spells (Invisibility, Transmutation, Smoke) appear faded without a Use button in the HUD inventory outside combat.

### Enchantments (applied at Master)
Sharpness (+3F), Fury (−tier×A on hit), Bloodlust (+1 heart on kill), Plunder (+5 coins on kill), Flame (fire status on hit), Precision (+3D), Hawk Eye (−tier×V on hit), Arcane (magic defense uses A), Thorns (30% reflect on being hit), Lightness (removes speed malus), Resistance (+3A).

### PVP (post-Dragon)
After Dragon dies, Princess appears at Dragon's tile. PVP is active.
- Any player who steps on Princess's tile picks her up (`hasPrincess = true`).
- Players can fight each other; if carrier is defeated, Princess drops at that tile.
- Carrier who reaches FINISH tile wins the game.

### Death
Player with 0 hearts: `isAlive = false`, removed from turn rotation. Drops all inventory and equipped items (loot pool for killer). If last player alive dies, game over.

---

## Implementation Status

### Done ✓
- All engine files (dice, player, movement, combat, game state machine)
- All data files (items catalog, mob catalog tiers 0–3 + all bosses, map from CSV)
- Bot AI (rule-based; combat and movement)
- Setup roll phase (stat rolling + starting item before game)
- All tile event handlers (random event, miniboss, chest, reroll, work, stop, back, priest, shop, master, fire, boss, guilds, finish, bar)
- Canvas renderer: 16px tiles, full 51×38 grid, miniboss tier colors, player tokens, princess token, reachable tile highlights
- HUD: stats with bonus/malus coloring, hearts, coins, equipped grid, phase label, legend, inventory with Use/Equip buttons
- Modals: setup roll, combat, shop (sell alphabetically sorted), master (skill, enchant, spells), priest, map choice (including miniboss), loot confirm, teleport choice, game over
- BFS pathfinding respecting SECRET_PATH tiles
- Dragon death → princess drop → PVP activation
- **Step-based interactive combat**: player_attack / mob_attack subphases; combat_update event drives UI
- **Both sides roll dice**: player rolls stat+d6 to attack; mob rolls stat−3+d6 to both attack and defend
- **Stat potions**: temp bonus for one roll only; named Potion NX (Potion 3M, etc.)
- **Mob attack randomisation**: ties in highest stat broken randomly each turn; attack type pre-announced in combat log
- **Mob roll base displayed**: combat panel shows `stat (base)` e.g. `5 (+2)`
- **Combat consumable filter**: rope, compass, map, chain, trap, and non-combat spells excluded from combat list
- **Bail picker**: if both Rope and Invisibility present, player picks which to consume
- **Teleport spell**: TELEPORT_CHOICE phase, destination modal, princess guard, cancel
- **Transmutation spell**: two-step stat picker in combat, swaps two stats for the fight
- **Smoke spell**: sets isSmokeActive, player immune to next mob attack
- **Drop names with stat suffixes**: Dragon Blood 2F2M2V, Vampire Blood 2D2V, etc.
- **Map item works on MINIBOSS tiles**: player can pick which mob to fight
- **Bard/Charisma system**: fully implemented — family+tier actions (friendly/mock/deceive/respect), all outcomes applied
- **Friends system**: befriended mobs stored in `player.friendsList`; deployable in combat via `deploy_friend` / `friend_round` / `friend_take_over` actions
- **Quest system**: `player.quests[]` tracks active quests; granted via charisma `respect:2`

### Pending / Known Issues

**BACK tile** — `game.js` emits a `go_back` event with step count but does not actually move the player. Needs implementation: BFS-based reverse path, or snap to nearest walkable tile n steps back.

**Priest buff application** — `handlePriestRoll()` adds a `priest_X` pseudo-item to inventory but it has no consumption logic. Need to let player click to apply it as a permanent +1 stat bonus.

**Multiple start positions** — Only `{x:6, y:2}` defined for player 1. Players 2–4 all start at same tile. Need 3 more start positions near the START tile.

**Hermit boss** — Missing from the map. Should be placed and added to `tileData`.

**`w`-prefix tiles in CSV** — CSV notation `wX` (wall between this tile and adjacent) is treated as tile type `X` with no wall. Wall direction logic unimplemented.

**PVP combat flow** — `startPvpCombat()` is implemented but never triggered. Need: when a player moves onto a tile occupied by another player (during PVP), start PVP combat.

**Disenchant spell** — `effect: 'disenchant'` in catalog, no handler.

**Curse spell** — `effect: 'curse'` in catalog, pure placeholder; mechanic not yet designed.

**Master cost floor** — After rolling setup stats of 0, `handleBuySkill` costs 0 coins. Should have a minimum cost or stat floor of 1.

---

## Map Details

- Grid: **51 columns × 38 rows** (WIDTH × HEIGHT). `grid[y][x]`.
- Canvas: `51 × 16 = 816px` wide, `38 × 16 = 608px` tall.
- Generated by Python script from `map.csv`. Do not edit `map.js` by hand.
- CSV notation: plain tile codes, `w`-prefix = wall, `F1`=BAR, `F2`=FIRE, `.`=SECRET_PATH, `B_xxx`=boss tile.
- SECRET_PATH corridors: walkable only if player has Compass (object) or Ragged Sandals equipped.
- Single player start: `{x:6, y:2}` (the `⚑` START tile).
- Boss positions (from tileData): dragon `(18,32)`, witch `(6,33)`, king `(9,41)`, supreme_werewolf `(27,38)`, supreme_knight `(24,44)`, grand_sorcerer `(20,46)`, sea_serpent `(14,48)`.

---

## Key Design Decisions

- **No ES6 modules** — all files are plain `<script>` tags; all globals on `window`. Required for `file://` protocol.
- **IIFE pattern** — `const X = (() => { ...; return {...}; })();` for all engine/data modules.
- **Step-based combat** — `initFight` → alternating `takePlayerAttack` / `takeMobAttack` calls driven by player input. Bot auto-submits via `BotAI.takeTurn()`. `combat_update` event refreshes UI between half-turns.
- **Mob roll formula** — `stat − 3 + d6` for both attack and defense. Base can be negative.
- **Temp bonuses** — `player.tempBonuses` map consumed after a specific stat roll via `consumeTempBonus(stat)`; cleared at fight end by `clearFightEffects()`.
- **Mob attack announcement** — mob's next attack type is pre-rolled via `prepareNextMobAttack()` when transitioning to mob_attack subphase, stored in `state.pendingCombat.mobNextAttackType`, and passed to `takeMobAttack()` so the announced type is used exactly.
- **Specialization via slot cap** — 7 slots, max 5 equipped. Core tension of the game.
- **Tier system** — enemies and loot scale across 4 tiers (0–3) as players progress across the map.
- **Bot AI is swappable** — `BotAI.chooseCombatAction(player, mob)` and `BotAI.takeTurn(player)` are designed as a drop-in replacement target for a neural network.
