# Enchantment ideas (brainstorm, 2026-10-13)

Nothing here is implemented. These are candidates in case the tournaments show a strategy is weak by
design. Costs are first guesses. "Hook" says where in the code the effect would go.

**Gaps in the current set:**
1. M and C have no attack enchant (Fury and Hawk Eye do nothing for them).
2. Friends fight without the player's enchants (BM).
3. Mages lose many turns travelling to the single Master.
4. Only Thorns and Arcane help against mobs that attack with several stats (the dragon).

★ = the ones I'd try first.

## Attack

| | Name | Effect | Cost | Gap / for | Notes | Hook |
|---|---|---|---|---|---|---|
| ★ | Echo | A spell that misses is not used up | 80 | 1, 3 · M, DT | Halves spell use at 50% hit odds | `takePlayerAttack`: consume the spell only on a hit |
| | Unnerve | Each hit (F/D/M) gives the mob −1 to its announced attack stat for the fight | 80 | 1, 4 | A defensive Fury that also works for mages | `applyEnchantmentsOnHit` |
| | Momentum | +1 to your next attack roll for each hit in a row; a miss resets it | 80 | F/D, bosses | Snowballs in long fights | attack roll |
| | Cleave | Winning an attack roll by 5+ deals 2 damage | 100 | high-stat F/D | Attack-side version of Riposte | hit branch |
| | Coup de Grâce | +3 to hit a mob on its last heart | 60 | everyone | Non-guild cousin of the Garrote | attack roll |
| | Ambush | You always act first; your first attack gets +3 | 80 | bosses, PvP | A free half-turn | initiative in `initFight` |
| | Conduit | Spell status effects are 1 stronger (fire +1 turn, ice/explosion −1 more) | 60 | M | Mage only | `applyEffect` |
| | Static | Each hit has a 1-in-3 chance to stun (the mob must roll > 3 to attack) | 100 | everyone | Weaker cousin of Encore that works on any attack | `applyEnchantmentsOnHit` |
| | Fortune | Rolls with the item's own stat use two dice and keep the higher (≈ +1) | 40 | 1 · M, C, V | Also helps movement when on a speed item | dice roll for that stat |

## Defense

| | Name | Effect | Cost | Gap / for | Notes | Hook |
|---|---|---|---|---|---|---|
| ★ | Feint | Twice per fight, after the mob announces its attack, force it to pick one of its other three types at random | 100 | 4 · everyone | Vs the dragon: ~0.57 → 0.37 hit chance per use. Harsh vs one-stat mobs | `prepareNextMobAttack` + a button |
| ★ | Adaptation | After being hit by an attack type, +2 to defend against that type for the fight | 80 | 4 · dragon | Less random than Thorns | `takeMobAttack` |
| | Riposte | A defense roll that beats the mob by 4+ deals 1 damage | 100 | 4 · A-tanks (DG) | Rewards stacking A | `takeMobAttack` miss branch |
| | Second Wind | Once per fight, a hit that would kill you leaves you at 1 heart | 120 | BM, dragon | Strong with heals | `takeMobAttack` damage |
| | Stoneskin | The first hit each fight is ignored | 80 | farming | Best on many short fights | `takeMobAttack` |
| | Mirror | A magic attack that misses you deals 1 damage back | 60 | Witch, Sorcerer | Magic-only Riposte | `takeMobAttack` miss branch |
| | Bulwark | +2 to all defense rolls at half hearts or less | 60 | survival | Softer than Second Wind | defense roll |

## High risk, high reward

| | Name | Effect | Cost | Notes | Hook |
|---|---|---|---|---|---|
| ★ | Exploding Dice | A 6 on your attack roll lets you roll again and add it | 80 | New mechanic; low stats can still hit the dragon | attack roll |
| ★ | Greed | Kills pay double coins, but every mob gets +2 to all stats against you | 50 | Turns farming into a risk choice; pairs with Plunder | `resolveLoot` + `getMobStat` |
| | Berserk | +4 to attack rolls, −2 to defense rolls | 60 | Glass cannon | attack/defense rolls |
| | Blood Pact | Your hits deal 2 damage, but each miss costs you a heart | 60 | Only for builds that hit reliably | hit/miss branches |

## Map and movement

| | Name | Effect | Cost | Gap / for | Notes | Hook |
|---|---|---|---|---|---|---|
| | Homeward | Every 8 turns, instead of rolling, teleport to the Master/Shop where you bought it (not with the princess) | 60 | 3 · DT, M | Location-bound so the map still matters | new action in `ROLL_MOVE` |
| | Surefoot | Back and Stop tiles have no effect on you | 50 | speed builds | | `resolveTileEvent` |
| | Wayfinder | Once per turn, reroll your movement die | 60 | everyone | | `rollCap` |
| | Fortune's Favor | On a "?" tile, you may reroll the event once | 40 | | | `resolveRandomEvent` |
| | Escort | +3 V while carrying the princess | 60 | endgame | Could make the endgame faster | `getStat` |

## Economy, items, progression

| | Name | Effect | Cost | Notes | Hook |
|---|---|---|---|---|---|
| | Haggler | Shop and Master prices −20% | 80 | Pays off for builds that shop a lot | shop/master handlers |
| | Alchemist | Potions and Holy Blessings last two rolls instead of one | 60 | Pairs with BB (double drops) | `consumeTempBonus` |
| | Scavenger | Each kill has a 1-in-3 chance to drop an extra random-stat potion | 60 | | `resolveLoot` |
| | Treasure Sense | Chests roll two dice and keep the higher | 50 | Pairs with Lucky Glove | `handleChestOpen` |
| | Scholar | +50% XP for the enchanted item's stat | 80 | Fills the M/C gap without a flat +3. Wait for the XP rebalance | `gainXP` |
| | Attunement | Equipped guild items level up 50% faster | 60 | Guild builds | `applyMinibossProgress` |

## Charisma and friends

| | Name | Effect | Cost | Gap / for | Notes | Hook |
|---|---|---|---|---|---|---|
| ★ | Encore | A successful Talk (margin ≥ 3) also stuns the mob: it loses its next attack | 100 | 1 · CH, CR | Gives charmers a defense | `bard` branch |
| ★ | Silver Tongue | Talk margin thresholds are 1 lower (tier 1 at 2, tier 2 at 4, tier 3 at 6) | 80 | 1 · CH, CR | The attack-side Charisma enchant | `charismaTier` |
| ★ | Kinship | A deployed friend gets +2 to its attack stat and +1 heart | 100 | 2 · BM | | deploy / `resolveFriendRound` |
| | Ovation | Each successful Talk gives +1 to all your stats for the fight | 80 | CH, CR | Snowballs | bard branch |
| | Rally | Your friends heal 1 heart after every fight | 60 | BM | | end of combat |

## PvP

| | Name | Effect | Cost | Notes | Hook |
|---|---|---|---|---|---|
| | Shackle | Your hits stop a rival from escaping next round (a reusable Chain) | 80 | Counters Rope and Invisibility | PvP attack |

## Enchants that change other enchants

| | Name | Effect | Cost | Notes | Hook |
|---|---|---|---|---|---|
| ★ | Malleable | Re-enchanting this item is free | 50 | Makes switching between a farming kit and a boss kit a real choice | `handleEnchant` |
| | Resonance | Doubles the strength of the enchant on one other equipped item (Fury level ×2, Plunder 100%, Thorns 60%) | 120 | Hard to balance | per-effect lookups |

## Quick numbers

**Fortune** (keep the higher of two dice) compared with a flat +1. k = your stat minus the
opponent's stat; values are hit chances.

| k | normal | Fortune | flat +1 |
|---|---|---|---|
| −2 | 0.17 | 0.27 | 0.28 |
| 0 | 0.42 | 0.58 | 0.58 |
| +2 | 0.72 | 0.86 | 0.83 |
| +4 | 0.92 | 0.98 | 0.97 |

**Feint** vs the dragon, for an F build with defenses A21, V15, A21 vs M (Arcane) and C14: the chance
a dragon attack hits drops from ~0.57 to ~0.37 per use.
