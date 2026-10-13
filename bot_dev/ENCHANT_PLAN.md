# Enchantments & guild items: plan for choosing them properly (2026-10-13)

The current choices are hand rules: weapon = Sharpness/Precision (Bloodlust for the B profiles,
`'sim'` for mages), armor = Arcane if A > M else Resistance, shield = Resistance, every other
equipped item = +3 main stat. This note lists what the engine actually does (read from the code,
not the docs), which kits make sense for each strategy, and how to test them.

## 1. How the enchantments really work (combat.js, player.js, game.js)

**Two kinds of enchantment:**
- **Stat enchants stack.** Sharpness +3F, Precision +3D and Resistance +3A add up across items, and
  any slot can carry any of them (the Accordion can carry Sharpness).
- **Effect enchants don't stack.** Fury, Hawk Eye, Flame, Thorns, Arcane, Bloodlust, Plunder and
  Lightness are checked with `hasEnchantment(id)`, so a second copy does nothing. Fury and Hawk Eye
  use the tier of the first copy found.
- With 5 items equipped, a kit is: a set of distinct effects, with the remaining items filled by +3s.
- An effect works from **any** slot. Thorns on Pegasus works just like Thorns on the shield.

**Each enchantment, as coded:**

| Enchant | Cost | What the code does | Who benefits |
|---|---|---|---|
| Sharpness / Precision / Resistance | 60 / 60 / 50 | +3F / +3D / +3A | F / D / everyone |
| **Flame** | 100 | Every F/D/M hit adds a 1-turn burn, which deals **1 more damage** before the mob's next attack. Effectively **2 damage per hit** | F, D, M, DT (doubles each spell) |
| Fury (level t = 1–3) | 33·t | Each hit permanently lowers the mob's A by t this fight. A only defends against **F**, so it's useless for D and M | F, G (helps on long fights) |
| Hawk Eye (level t = 1–3) | 33·t | Each hit lowers the mob's V by t. V defends against D, so it only helps **D** | D, BP |
| **Thorns** | 100 | When the mob hits you, 30% of the time **you take no damage** and it loses 1 heart. Works against all 4 attack types | everyone, especially vs the dragon |
| Arcane | 50 | M defense uses A instead of M (+Protection spells stop counting) | builds with high A and low M |
| Lightness | 30 | Removes that item's own V malus: +2V on Heavy Armor | cheap V; competes for the armor slot |
| Bloodlust | 100 | +1 heart per kill (including Garrote, Rattle and friend kills) | farming only; nothing vs the dragon |
| Plunder | 100 | **Changed 2026-10-13:** +50% of the loot's worth (coins after Big Knife and Small Pistol, plus the items' sell value) per kill. A t3 Giant pays about +76 | farmers; the bot doesn't consider it yet |

**Things the bot gets wrong or ignores:**
- **Flame is never tried for F/D/G/BP.** It's only in `SIM_ENCH`, which only mages use. With
  decent hit odds it nearly halves the dragon fight (section 2).
- **The bot never enchants the Invisibility Cloak** (`eq.armor.id !== 'invis_cloak'`). Its A+1 makes
  Resistance weak, but Thorns, Flame or Arcane on it work at full strength.
- **`'sim'` picks by dragon win probability minus cost.** Win probability saturates near 100%, so
  cost decides the pick. That's why Thorns was almost never chosen (37 of 22k picks).
- **Fury and Hawk Eye levels (Q1, decided):** you pick level 1–3 at the Master, at 33 coins per
  level. The UI now has a level picker.
- **There's no +3M, +3C or +3V enchant.** Mages and charmers only have defensive or effect
  enchants to buy.

**The dragon** has 22 in every stat and 12 hearts, and each turn picks F, D, M or C uniformly at
random to attack with. Each of those is defended by a different stat (A, V, M-or-A with Arcane,
C), and your **weakest** one costs the most hearts. The chance a dragon attack hits, by your
defense stat: 12→100%, 15→92%, 18→58%, 21→17%, 24→0%.

## 2. Quick math (no game sims): expected swings to kill the dragon

This counts F attacks against the dragon's defense of 19+d6, with 3 enchantable slots besides armor
and shield. It ignores the dragon hitting back.

| Kit on weapon + 2 extras | F base+weapon 14 | F base+weapon 17 |
|---|---|---|
| 3× Sharpness | 13.1 | 12.0 |
| **2× Sharpness + Flame** | **10.3** | **6.5** |
| 2× Sharpness + Fury 1 | 13.4 | 12.1 |
| 2× Sharpness + Fury 3 | 12.8 | 12.1 |
| Sharpness + Flame + Fury 3 | 11.8 | 6.8 |

**What this shows:**
- Once you hit reliably, Flame beats a third +3 by a wide margin. That's 2–6 fewer dragon attacks
  taken, worth more than any defensive +3.
- Fury only matters while hit odds are poor: early tiers, or high-A targets like the Giant (A18)
  or Werewolf (A15).
- The same trade applies to D with Precision and Hawk Eye.
- For mages, Flame halves the number of spells a fight uses.

Thorns works the other way round: it cuts hearts lost by 30% against every attack type and turns
those blocks into damage. Resistance only helps against F attacks, plus M attacks with Arcane, so
against a mob that mixes 4 types it's the weaker pick.

## 3. Candidate kits per strategy (to test, not to adopt blindly)

The slots are weapon / armor / shield / speed / 5th item (the Accordion, unless the strategy says otherwise).

| Strategy | Current | Candidate kits |
|---|---|---|
| F, D | +3 weapon, Arcane armor, Res shield, +3 Pegasus, +3 Accordion | **K1** Flame on Pegasus (rest unchanged) · **K2** K1 + Thorns on shield · **K3** K2 + Fury/Hawk Eye 1 on Accordion |
| FB, DB, DBG, GB | Bloodlust weapon | Bloodlust for farming only, then **re-enchant to Flame** before the dragon (re-enchant cost vs keeping a second enchanted weapon in the bag) |
| G (Garrote) | Sharpness | **Flame**: executes at ≤2 hearts, so the dragon needs only ~5 hits with Flame. Kryss is in the same slot, so not both |
| DG (A-tank map farmer) | Resistance armor + shield | Keep Resistance while farming F-only mobs; for the dragon, Thorns on the shield and Flame on an extra slot |
| BP (Blowpipe) | Precision | The Blowpipe already covers C defense, so Thorns adds less; **Flame + Hawk Eye** on the offensive side |
| M, DT | `'sim'` (mostly Resistance) | **Flame** on the weapon (halves spells used) + **Thorns** + Resistance + Arcane only if A > M |
| CH, CR | Resistance / +3 main | Charisma hits get no on-hit effects. **Thorns** is the best enchant they can buy; CR: **Bloodlust** works on Rattle kills |
| SS (Stealth Shoes) | +3 main | Escaping means fewer long fights, so Thorns matters less. Test Flame |
| BB, BM | +3 main / — | BM: the friend fights, and player enchants don't apply during friend rounds. Only Thorns/Bloodlust apply when BM fights itself |
| Cloak carriers (all) | cloak unenchanted | Put the unique effect that would otherwise sit on the shield (e.g. Thorns) on the cloak |

## 4. New strategy ideas from the guild items

Things the bot doesn't use yet:
- **Every equipped guild item levels at once** on miniboss wins (non-Charisma items to Lv.6,
  Charisma items to Lv.8). At Lv.6 a guild item gives +6, the same as a tier-6 shop item, and keeps
  its effect.
- **Guild armor has no V malus.** Lucky Glove or Cloak at Lv.6 gives A6, as much as Heavy Armor,
  without the −2V.

**Candidate new strategies:**
- **Full guild ("GG").** Garrote/Big Knife (F) + Pickpocket Glove or Small Pistol (D) + Cloak or
  Lucky Glove (armor) + Stealth Shoes (speed) + shield. Everything levels together. Ends with
  tier-6 stats plus 4 effects, no Heavy Armor malus, and coin income.
  - Risk: guild stock is shared between the 4 players.
- **Coin thief ("TH").** Big Knife + Small Pistol equipped together gives (loot + 15) × 2 coins
  per kill. That turns into Curses (the bot's dragon kit), Master points and heals.
  - Plunder only becomes worth testing here.
- **Flame Garrote ("GF").** G with Flame, plus Kryss swapped in for bosses. That only works if
  carrying both pays off, since Kryss also uses the strength slot.
- **Thorns tank.** An A-tank (DG-style) where Thorns + Arcane + 2× Resistance make the dragon's 4
  attack types cost few hearts and the reflections deal damage.
- **Magic Flute charmer.** C guild item to Lv.8 + Magic Flute's C cap of 8 + Thorns. Charmers
  currently have nothing on the defensive side.

## 5. How to decide, step by step

1. **Fix the objective first.** In `simEnchant`, score kits by **expected hearts lost + expected
   rounds** in the dragon fight (or win probability at a deliberately weak reference gear) instead
   of saturated win probability minus cost. This is a small change in `bot_dev/bot_v2_dev.js`.
2. **Screen kits with the fight model only** (minutes, not hours):
   - Take end-of-race gear snapshots per strategy from the tournament logs.
   - Enumerate the legal kits: ~4 effects × 5 slots + fills, about 50–100 per strategy.
   - Score each against the dragon, the 3 tier-3 targets the strategy farms, and the bosses it
     hunts.
   - Keep the top 3 per strategy.
   - New script: `bot_dev/enchant_screen.js`, reusing `dragonWinP` and the Markov fight model.
3. **Separate farm kits from dragon kits.** Enchantments live on items, and unequipped copies keep
   theirs, so a bot can farm with Bloodlust and fight the dragon with Flame/Thorns. Score whether a
   re-enchant (cost) or a second item beats one compromise kit.
4. **Run solo batches on the survivors.** Use `evalbatch.js` with genomes like
   `{ base:'F', tune:{ kit:'K2' } }`, 100 seeds each. Compare median and mean turns to the dragon
   and deaths against DEV3.
   - This needs a `kit` tunable that maps slot → enchant (or a priority list of effects), replacing
     `weaponEnch` / `extraEnch` / `shieldEnch`.
5. **Prototype the new strategies** (GG, TH, GF) as profiles only after step 4 shows which effects
   matter. Then solo-test them like the others.
6. **Confirm in the tournament** (dev vs baseline, same seeds). Then feed the results into the
   difficulty tiers (to-do item 4 in NOTES.md).

## 5b. Screening results (2026-10-13, `node bot_dev/enchant_screen.js`, full report in `results/enchant/report.md`)

Setup: 20 solo games per strategy with the dev bot. Checkpoints with a full 5-item loadout were
re-scored with every kit. Dragon odds include the standard kit (10 Curses + 4 heals).

| Strategy | Games | Best kit (cost-aware) | Ready turn | Mean dragon P | Bot's kit rank | Bot ready turn | Bot mean P |
|---|---|---|---|---|---|---|---|
| F | 20 | Flame + 4× Sharpness | 32 | 0.99 | 135 | 74 | 0.55 |
| D | 18 | Flame + 4× Precision | 35 | 1.00 | 95 | 71 | 0.63 |
| FB | 20 | Flame + 4× Sharpness | 30 | 0.99 | (Bloodlust, not scored) | | |
| DB | 19 | Flame + 4× Precision | 30 | 1.00 | (Bloodlust) | | |
| DG | 19 | Flame + Hawk Eye 1 + 3× Precision | 35 | 0.97 | 22 | 46 | 0.83 |
| DBG | 19 | Flame + Hawk Eye 1 + 3× Precision | 30 | 0.98 | (Bloodlust) | | |
| M | 19 | Fury 2 + Hawk Eye 1 + Lightness + 2× Resistance | 84 | 0.40 | 28 | 84 | 0.42 |
| G | 20 | Flame + 4× Sharpness | 50 | 0.85 | 29 | 76 | 0.43 |
| GB | 19 | Flame + 4× Sharpness | 55 | 0.85 | (Bloodlust) | | |
| BP | 19 | Flame + 4× Precision | 58 | 0.86 | 27 | 84 | 0.42 |
| DT | 19 | Fury 3 + Lightness + 2× Resistance + Sharpness | 110 | 0.37 | 949 | 150 | 0.18 |
| SS | 6 | Flame + Lightness + 3× Sharpness | 35 | 0.98 | (4-enchant kit, not scored) | | |
| BB | 7 | Flame + Lightness + 3× Sharpness | 30 | 0.96 | (4-enchant kit) | | |
| BM | 7 | Flame + Lightness + 3× Sharpness | 25 | 0.95 | 121 | 63 | 0.63 |
| CH | 13 | Flame + Lightness + 3× Precision | 25 | 0.96 | 184 | 59 | 0.56 |
| CR | 7 | Flame + 4× Sharpness | 25 | 1.00 | 161 | 67 | 0.60 |

**Findings:**
- **Flame + fill the rest with the main +3** is the best kit for every F/D-type strategy, by a wide margin.
  By the model, it's ready 25–40 own turns earlier than the bot's kit. Thorns is a close second in
  raw strength but costs more.
- **Farming trade-off:** the Flame kits lose more hearts per farming fight than the bot's
  Arcane/Resistance kit (F: 0.32 vs 0.14). That argues for a farm kit (Arcane) and a dragon kit
  (Flame) with one re-enchant, which the planner should weigh.
- **M: every kit scores within ~3 turns of the others** (mean P ~0.40). Enchants don't fix M.
- **DT:** the current kit is nearly the worst (rank 949). Fury 3 kits help (ready 110 vs 150), but
  DT stays the weakest. Like M, DT needs something other than enchants (spells, travel, or a
  new enchant like Echo).
- **Caveats:**
  - SS, BB, BM and CR have only 6–7 usable games.
  - BM fights the dragon through its friend, so its kit matters less than the table suggests.
  - Bloodlust kits and 4-enchant kits aren't in the candidate set.
  - Ready turns assume the standard kit is already paid for (optimistic, but the same for every kit).

## 5c. Screening v2 (proposed after review, not built yet)

What was wrong with v1:
- The standard dragon kit (10 Curses + 4 heals) was free.
- The kit was a fixed placeholder rather than the best supplies for each build.
- Solo games ignored competition. Curses and Smoke share one Master stock of 10 per 15 rounds;
  shops have limited stock.

The fix:
1. **Ready** = the candidate kit plus the supplies the bot can afford reach 0.85. Budget = coins +
   refund of the bot's own enchant spending − kit price. Supplies are chosen by the bot's `planKit`.
2. **Capture inside 4-bot tournament games** (60–80 games per strategy), saving the Master's
   Curse/Smoke stock at each checkpoint.
3. **The output is a shortlist per strategy** (top 5 by readiness + the best farming kit + the
   best PvP kit). Real solo races and a tournament decide between them, and only then is the
   planner built.

## 5d. Screening v2 results (2026-10-13, old stacking rules; report in `results/enchant/report.md`)

Setup: 160 four-bot games of the 13 non-Charisma strategies, with budgeted supplies and stock. Ready =
own turn where the kit plus the supplies the bot could afford reach 0.85.

| Strategy | Best kit | Ready (med) | Ready at all | Bot's kit: rank / ready / ready at all |
|---|---|---|---|---|
| F | Flame + 4× Sharpness | 70 | 94% | 6 / 80 / 58% |
| D | Flame + 4× Precision | 70 | 81% | 10 / > 75 / 42% |
| FB | Flame + 4× Sharpness | 70 | 81% | 20 / > 80 / 30% |
| DB | Flame + 4× Precision | 70 | 78% | 27 / > 80 / 13% |
| DG | Flame + 4× Precision | 65 | 90% | 8 / 75 / 68% |
| DBG | Flame + 4× Precision | 65 | 90% | 29 / 85 / 33% |
| G | Flame + 4× Sharpness | 75 | 80% | 7 / > 75 / 50% |
| GB | Flame + 4× Sharpness | 75 | 71% | 26 / > 80 / 23% |
| BP | Flame + 4× Precision | > 80 | 58% | 13 / > 85 / 30% |
| M | Arcane + Flame + Lightness + Resistance + Thorns | > 85 | 25% | 3 / > 85 / 22% |
| DT | Flame + 3× Resistance + Thorns | > 90 | 18% | 39 / > 90 / 5% |
| SS | Flame + 3× Precision + Resistance | > 85 | 24% | 3 / > 85 / 24% |

**What it shows:**
- With real budgets and competition, **Flame + filling every other slot with the main +3** is still
  the top kit for every F/D build. It's ready about 5–15 own turns earlier than the bot's kit, and
  much more often. Thorns kits trade a little readiness for fewer hearts lost and better duels.
- This degenerate "stack the +3" answer is what led to the proposal that +3 enchants count only
  once (pending decision).
- **Mages and SS are rarely ready at all** (18–25%). That's not an enchant problem.
- **The best-farm / best-PvP rows are still thin** (few samples); treat them as hints.

## 5e. Screening v3 (2026-10-13, Sharpness/Precision count once; report in `results/enchant/report.md`, v2 archived in `results/enchant/v2/`)

Same setup as v2 (160 four-bot games, budgeted supplies and stock), with a fresh capture under the new rule.

| Strategy | Best kit (price) | Ready (med) | Ready at all (v2 → v3, best kit) | Bot's kit: rank / ready at all |
|---|---|---|---|---|
| F | Fury 1 + Lightness + Sharpness + 2× Resistance (223) | 85 | 94% → 71% | 6 / 47% |
| D | Hawk Eye 1 + Lightness + Precision + 2× Resistance (223) | 90 | 81% → 56% | 7 / 37% |
| FB | Fury 1 + Lightness + Sharpness + 2× Resistance (223) | > 80 | 81% → 49% | 18 / 30% |
| DB | Hawk Eye 1 + Lightness + Precision + 2× Resistance (223) | 90 | 78% → 59% | 11 / 39% |
| DG | Hawk Eye 1 + Lightness + Precision + 2× Resistance (223) | 80 | 90% → 81% | 28 / 35% |
| DBG | Flame + Hawk Eye 3 + Precision + 2× Resistance (359) | 80 | 90% → 74% | 31 / 40% |
| G | Flame + Fury 2 + Sharpness + 2× Resistance (326) | 85 | 80% → 68% | 17 / 45% |
| GB | Arcane + Fury 1 + Sharpness + 2× Resistance (243) | 85 | 71% → 62% | 29 / 27% |
| BP | Arcane + Hawk Eye 2 + Precision + 2× Resistance (276) | 90 | 58% → 64% | 37 / 14% |
| BB | Flame + Hawk Eye 2 + Precision + 2× Resistance (326) | > 80 | – → 38% | 6 / 35% |
| M | Arcane + Flame + Lightness + Resistance + Thorns (330) | > 90 | 25% → 42% | 5 / 33% |
| DT (12 bot-games only) | Flame + Fury 3 + Sharpness + 2× Resistance (359) | 100 | 18% → 50% | 40 / 8% |
| SS | (bot's own kit ranks 1st) | > 90 | 24% → 19% | 1 / 19% |

**Findings:**
- **The degenerate answer is gone.** The top kits now differ by strategy: cheap Fury 1 / Hawk Eye 1 +
  Lightness kits for F/D, Flame + Hawk Eye for DBG/BB, Flame + Fury for G, Arcane + Hawk Eye for BP,
  and Flame + Thorns + Arcane for the mages.
- **F/D builds got weaker, as expected:** ready 10–20 own turns later, and less often. The mages
  improved relative to them (M 42%, DT 50% ready at some point), so the gap narrowed.
- **Cheap kits rank well because supplies compete for the same coins.** Fury/Hawk Eye level 1 (33)
  and Lightness (30) are the cheapest options; worth watching whether 33 per level is too cheap for level 1.
- **Limits:**
  - Resistance always fills the free slots.
  - Bloodlust/Plunder aren't candidates.
  - The best-farm/PvP rows are thin.
  - DT has only 12 usable bot-games.

## 5f. Solo races of the screened kits (2026-10-13, `results/enchant/solo_kits.txt`)

Setup: dev bot with a fixed `kit` (tune) vs its own kit, 100 seeds each (same seeds). The score is
own turns to the dragon, with a death counted as 250. The first run hit a bot equip loop and is
archived in `solo_v1_buggy/`.

| Strategy | Bot's kit (mean / median / deaths) | Best kit | Best (mean / median / deaths) |
|---|---|---|---|
| F | 110.8 / 93 / 12 | Fury 1 + Lightness + Sharpness + 2× Resistance | 104.1 / 91 / 8 |
| D | 120.5 / 99 / 14 | Flame + Hawk Eye 3 + Precision + 2× Resistance | 100.7 / 83 / 10 |
| FB | 112.1 / 96 / 10 | Flame + Fury 2 + Sharpness + 2× Resistance | 106.4 / 87 / 12 |
| DB | 121.5 / 106 / 13 | Arcane + Hawk Eye 1 + Lightness + Precision + Resistance | 108.6 / 88 / 13 |
| DG | 119.0 / 95 / 16 | Flame + Hawk Eye 2 + Precision + 2× Resistance | 101.8 / 89 / 9 |
| DBG | 110.1 / 90 / 13 | Hawk Eye 1 + Lightness + Precision + 2× Resistance | 109.0 / 91 / 11 |
| M | 127.8 / 114 / 13 | Arcane + Flame + 2× Resistance + Thorns | 112.2 / 101 / 8 |
| G | 126.0 / 101 / 18 | Arcane + Fury 2 + Sharpness + 2× Resistance | 114.0 / 88 / 16 |
| GB | 127.2 / 108 / 14 | Arcane + Fury 1 + Sharpness + 2× Resistance | 117.3 / 94 / 15 |
| BP | 126.9 / 114 / 10 | Arcane + Hawk Eye 1 + Precision + 2× Resistance | 115.4 / 93 / 16 |
| DT | 166.3 / 155 / 14 | Flame + Fury 3 + Sharpness + 2× Resistance | 146.2 / 135 / 12 |
| SS | 150.7 / 122 / 26 | Arcane + Flame + Lightness + Resistance + Thorns | 133.6 / 113 / 16 |
| BB | 105.8 / 94 / 8 | Flame + Hawk Eye 3 + Precision + 2× Resistance | 102.5 / 89 / 10 |

**Findings:**
- The best kit beats the bot's own for every strategy: by 10–20 turns on the mean for D, DB, DG, M,
  G, GB, BP, DT and SS, and about 3–7 for F, FB and BB. DBG is even.
- The answers are mixed. Arcane, Flame and a level of Fury/Hawk Eye each appear in many
  winners, always with the main +3 and Resistance. There's no single dominant kit any more.
- Noise: about ±5 turns on a mean of 100 seeds, so gains under ~5 are not conclusive.

Next: tournament, same 715 line-ups of the 13 strategies, current bot (`results/enchant/t13_base`)
vs best kits fixed (`bot_dev/bot_v2_kits.js`, `results/enchant/t13_kits`).

## 5g. Tournament: current bot vs best kits (2026-10-13)

Setup: 715 line-ups of the 13 non-Charisma strategies, same seeds, dev bot.
`results/enchant/t13_base` = the bot's own kits; `results/enchant/t13_kits` = the best solo kit per
strategy fixed (`results/enchant/best_kits.json`).

| Strategy | Win % (bot's kits → best kits) | Own turns to dragon, median |
|---|---|---|
| DB | 39.1 → 35.9 | 93.5 → 85.5 |
| BP | 19.5 → 31.4 | 103 → 84 |
| DG | 28.6 → 29.1 | 90 → 85 |
| BB | 28.2 → 28.6 | 89 → 81 |
| M | 13.2 → 26.8 | 94 → 85 |
| D | 28.2 → 26.8 | 92 → 81 |
| G | 33.6 → 26.8 | 90 → 84 |
| GB | 24.1 → 25.5 | 92 → 82 |
| F | 30.5 → 23.2 | 90 → 86 |
| FB | 28.6 → 21.4 | 86.5 → 78 |
| SS | 10.9 → 18.2 | 102 → 95 |
| DBG | 33.6 → 16.8 | 88 → 90 |
| DT | 5.5 → 13.6 | 112.5 → 101 |

**Findings:**
- **Everyone reaches the dragon sooner:** median game 369 → 338 turns, most strategies 5–10 own
  turns earlier (DT 11, BP 19).
- **The spread narrows:** win % 5.5–39 → 13.6–36. M doubles, DT more than doubles, SS and BP gain a
  lot; F, G, FB and DBG lose share. Win % is zero-sum, so they lose share because others got faster.
- **DBG gets worse** (33.6 → 16.8, own turns 88 → 90). Its "best" kit was only a tie in the solo
  races, so the bot's own kit (Bloodlust farming) should stay or be re-tested.
- **The dragon killer wins less often (90% → 78%),** and M, DT and SS win often without the kill
  (22–25 wins each). Rivals now arrive together, and the Thorns/Flame/Arcane kits are strong in
  duels.
- **Failed games:** base had 3 timeouts; with kits, 1 timeout and 1 stall.

## 5h. Default kits installed + enchant planner v1 (2026-10-13)

- **Installed:** `PROFILE_KITS` in the dev bot (the 12 best kits; DBG and the Charisma builds keep
  their rules), copied to `js/engine/bot_v2.js`.
- **Planner v1** (`tune.planner`, `plannedKit`): among each strategy's `KIT_CANDIDATES`, it picks the
  reachable kit with the best dragon P (reference supplies) − missing price / 2000. It never
  overwrites an enchant (humans can't), and it needs a 0.03 margin to switch.
- **Solo races, planner − fixed default kit** (paired by seed, 100 seeds; 95% interval; positive =
  planner slower):

  | F | D | FB | DB | DG | DBG | M | G | GB | BP | DT | SS | BB | all |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | +8.6 ±8.0 | −4.3 ±7.0 | +7.9 ±12.5 | −2.9 ±12.8 | +8.7 ±11.8 | −5.3 ±13.4 | +7.7 ±8.7 | +3.5 ±12.5 | −5.2 ±10.7 | +7.6 ±13.0 | +15.7 ±11.8 | −0.8 ±15.8 | −2.3 ±11.3 | +3.0 |

- **Verdict:** v1 doesn't beat the fixed kits. It's worse for DT (significant) and F (borderline),
  and no strategy gains clearly.
- **Its deaths go up** for F (8→14), FB, DG, DT (12→21) and SS: scoring only the dragon fight pushes
  out farm safety. Not taken to a tournament.
- **v2 idea:** add a farm-safety term (hearts lost per fight at the current farm tier) and/or score
  at the real budget near the go point.

## 5i. Planner v2: farm-safety term (2026-10-13, `results/enchant/solo_planner2.*`)

Score = dragon P (reference supplies) − missing price / 2000 − `planFarm` × hearts lost per fight at the
farm tier. Planner − fixed default kit, paired by seed, 100 seeds (positive = slower):

| | F | D | FB | DB | DG | DBG | M | G | GB | BP | DT | SS | BB | all |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v1 (no farm term) | +8.6 | −4.3 | +7.9 | −2.9 | +8.7 | −5.3 | +7.7 | +3.5 | −5.2 | +7.6 | +15.7 | −0.8 | −2.3 | +3.0 ±3.3 |
| planFarm 0.05 | +6.3 | −4.6 | +10.8 | −3.2 | +7.1 | −5.1 | +8.7 | +8.0 | −5.4 | +5.9 | +12.2 | +0.7 | +0.7 | +3.2 ±3.3 |
| **planFarm 0.15** | +0.7 | −2.9 | +5.9 | −6.1 | +7.2 | −5.0 | +9.7 | +9.1 | −5.4 | +7.4 | +2.9 | +2.7 | −1.3 | **+1.9 ±3.3** |
| planFarm 0.3 | +2.3 | +7.2 | +11.4 | −5.6 | +7.1 | −1.7 | +12.3 | +5.5 | −7.1 | +6.5 | +3.3 | −1.2 | +1.5 | +3.2 ±3.5 |

(Each strategy's interval is about ±8–16.)

- **The farm term fixes the worst cases:** DT +15.7 → +2.9 and F +8.6 → +0.7 at 0.15. Overall the
  planner is still not better than the fixed kits (+1.9 ± 3.3, a tie at best). Deaths don't drop
  below the fixed kits'.
- **Selection bias favours the fixed kits here:** they were picked as the best of 5 variants on these
  same 100 seeds. A fair verdict needs fresh seeds.
- **Default `planFarm` set to 0.15.** The planner stays opt-in; the fixed kits stay the default.

## 5j. Fresh-seed validation (2026-10-13, seeds 100–199, `results/enchant/solo_fresh.*`)

Three variants per strategy on 100 seeds that played no part in any choice: old enchant rules
(`kit:null`), the fixed default kits, and the planner (planFarm 0.15). Paired differences in turns
to the dragon (negative = faster), 95% interval.

| Strategy | Old | Kit | Planner | Kit − old | Planner − kit | Deaths old / kit / planner |
|---|---|---|---|---|---|---|
| F | 110.2 | 108.1 | 111.5 | −2.2 ±7.8 | +3.4 ±12.4 | 11 / 11 / 15 |
| D | 116.4 | 113.6 | 108.9 | −2.8 ±13.4 | −4.7 ±9.7 | 10 / 17 / 14 |
| FB | 110.8 | 102.5 | 100.0 | −8.3 ±11.0 | −2.5 ±11.0 | 10 / 11 / 10 |
| DB | 117.0 | 108.1 | 109.0 | −8.9 ±10.1 | +0.9 ±11.9 | 10 / 12 / 13 |
| DG | 125.8 | 106.7 | 109.7 | **−19.1 ±15.2** | +3.0 ±11.5 | 21 / 12 / 13 |
| DBG | 113.7 | 113.7 | 115.5 | 0 (same rules) | +1.8 ±13.9 | 15 / 15 / 16 |
| M | 124.4 | 112.0 | 124.9 | **−12.4 ±12.2** | +12.8 ±13.1 | 11 / 9 / 15 |
| G | 133.7 | 117.0 | 113.2 | **−16.6 ±12.0** | −3.8 ±10.7 | 21 / 17 / 14 |
| GB | 137.7 | 117.5 | 124.3 | **−20.1 ±11.3** | +6.8 ±10.7 | 22 / 16 / 20 |
| BP | 133.8 | 122.5 | 114.8 | −11.3 ±15.0 | −7.6 ±15.5 | 16 / 20 / 16 |
| DT | 159.3 | 145.2 | 141.0 | **−14.1 ±10.5** | −4.2 ±11.4 | 11 / 10 / 12 |
| SS | 143.1 | 134.6 | 131.5 | −8.5 ±13.0 | −3.0 ±15.2 | 21 / 17 / 20 |
| BB | 104.2 | 111.9 | 102.5 | +7.7 ±12.2 | −9.4 ±12.1 | 7 / 15 / 11 |
| **All** | | | | **−9.0 ±3.2** | **−0.5 ±3.4** | |

**Verdict:**
- **The fixed default kits are a real gain over the old rules:** 9 turns faster on average, and
  significant for DG, G, GB, DT and M.
- **BB may be better off with its old rules** (+7.7, not significant; deaths 7 → 15). Worth a
  re-test.
- **The planner ties with the fixed kits** (−0.5 ± 3.4). It's not worth its complexity and 0.6 s per
  game as the default. It stays opt-in (`planner: true`), with planFarm 0.15.
- No timeouts or stalls in these 3,900 games.

## 6. Questions for Simone

- ~~Q1~~ Decided: Fury and Hawk Eye levels 1–3, 33 coins per level, chosen at the Master.
- ~~Q2~~ Decided: Flame's double damage per hit is intended, and it stays as is for now (confirmed again after the screening showed it on top for almost every F/D build).
- **Q3.** Open. New enchants only if the tournaments show a strategy is weak by design rather than
  played badly. Candidates are in ENCHANT_IDEAS.md.
- ~~Q4~~ Decided: Plunder gives +50% of the loot's worth (coins + item sell value). Add it to the bot's
  farm-kit options (step 3).


## 7. Candidate new enchantments

They're in [ENCHANT_IDEAS.md](ENCHANT_IDEAS.md), ~37 ideas with effects, costs and code hooks.
