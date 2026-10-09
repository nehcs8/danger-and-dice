# Danger & Dice — cleanup and fix list for Claude Code

Repo: `nehcs8/danger-and-dice`, branch `main`, current HEAD `2ee7698`.
Work on a new branch `cleanup-2026-10`, one commit per phase, then open a PR (or push to main if I say so).

## Ground rules

- Read `CLAUDE.md`, but **don't trust it over the code**: it is out of date (see Phase 7). It already misled one session into deleting PvP.
- Don't change game rules beyond what is listed here. If something is ambiguous, stop and ask me.
- After every phase, run the headless check and note the result in the commit message:
  - `node sim_v2.js 5 1` — single bot, expect most games won in roughly 80–130 turns
  - `node sim_v2.js 2 4 0 F,D,M,G` — four bots, expect a winner and no freeze or crash
  - Open `index.html` in a browser (or jsdom) and play a few turns: no console errors.
- **Before Phase 1**, record a baseline: run both commands above on the current HEAD and save wins, turns and runtime in the PR description.

---

## Phase 1 — Restore PvP (removed by mistake in `2ee7698`)

Commit `2ee7698` said it removed an "unused, simultaneous" PvP system. It was neither: it was the alternating-turn PvP I specified, and it was in use.

1. Restore the PvP code from `2ee7698^` in `js/engine/game.js` and `js/ui/panels.js` **without undoing the charisma changes in the same commit**. Use `git show 2ee7698 -- js/engine/game.js js/ui/panels.js` and re-apply only the PvP hunks: `pendingPvp`, `maybeStartPvp`, `startPvpCombat`, `pvpView`, `getPvpView`, the `pvp_*` actions in `submitAction`, player-blocking in movement, and the PvP rendering in the combat panel.
2. The restored behaviour must match these rules:
   - PvP starts only after the dragon is dead.
   - Living players block movement like bosses; moving onto a player starts a fight.
   - Normal **alternating** turns. Initiative is V + d6 each, ties re-rolled, the winner acts first. Not simultaneous.
   - Both sides can use consumables.
   - Escapes work as in normal fights, unless the escaper is chained.
   - The Invisibility Cloak does **not** let you pass other players.
   - The loser dies; the winner takes all their items and coins.
   - Killing every other player does **not** end the game; the survivor must still bring the princess to the finish tile.
   - PvP uses the normal combat panel (no separate panel) and the combat log shows newest lines on top.
3. `main.js` already has the `pvp_update` → `BotAI.pvpTick()` hook and `bot_v2.js` still has the PvP logic; check they work with the restored engine.
4. Delete `js/ui/pvp_panel.js` (not loaded, superseded by the combat panel).
5. Check: a 4-bot sim reaches PvP and resolves it, with fights alternating and a winner who then reaches the finish.

## Phase 2 — Engine bugs still on main

1. **`equip()` deletes every copy of an item.** `js/engine/player.js:141` filters all matching ids out of the inventory. Remove only one copy (`indexOf` + `splice`).
2. **Enchantments are written onto the shared catalog object.** `equip()` stores the object from `getItem()` and `applyEnchantment` (`player.js:187`) mutates it, so every copy and every player gets the enchantment.
   - Store a per-player copy when equipping (e.g. `{ ...item }`) so the enchantment lives on that copy.
   - Check everything that compares equipped items by reference or reads `.enchantment`: `hasEnchantment`, `unequip`, sell, disenchant, transmutation, spectate export, save/load of runs.
   - `bot_v2.js:~761` (`withBossLoadout` armor swap) currently relies on the shared-object bug. Make sure it still works after the fix.
3. **Work tiles are never marked used.** `handleWork()` (`game.js:~898`) never calls `player.markTileUsed`, so one tile can be farmed forever. Mark it used and add the `hasUsedTile` check the other tile types have (around `game.js:551–577`).
4. **Blowpipe charisma redirect.** `game.js:~1302` falls back in a fixed F/D/M/V order. It should use whichever of the mob's **F, D, M** is highest (random among ties).
5. **Arcane XP is never credited.** `game.js:~1560` checks `player.equipped?.Armor?.enchantment === 'arcane'`. The slot key is lowercase `armor` and `enchantment` is an object. Use `player.equipped.armor?.enchantment?.id === 'arcane'` (or `player.hasEnchantment('arcane')` if it checks the right slot).
6. **Smoke freezes bots.** Using Smoke in combat (`game.js:~1159`, effect `immune_one_turn`) emits only `item_used`, never `combat_update`, so nothing re-triggers the bot. Emit a `combat_update` with `outcome: 'ongoing'` like other in-combat items, then remove the workaround in `bot_v2.js`.
7. **"Need a spell to attack with Magic" is only enforced in the UI.** Add the same `player.canAttackMagic()` check in `combat.js` `takePlayerAttack` for attack type `M`.

## Phase 3 — Rebalance charisma XP (no stat ceilings)

**Design rule: no stat has a ceiling from XP or from abilities.** Don't add any cap to `Player.gainXP`. The problem in run 18 was that C levelled far faster than F/D/M, because charisma lets you loop abilities inside one fight. Fix the *rate*, not the maximum.

Current state, for reference:
- Each C roll gives XP (`combat.js:~487`: success +1, fail +2) and shares the 10-per-fight `combatXpHits` counter with attacks and defences.
- `mock:1`, `mock:2` and `mock:3` return `outcome: 'ongoing'`, so the player can roll C, mock, roll C again, and repeat for the whole fight. With near-miss buffs stacking, late rolls almost always succeed. Every loop earns XP.
- `deceive`, `friendly` and `respect` end the fight with no damage risk, so charisma fights are also short and safe.
- `?` tiles give +1 XP to F, D, M and C each (`game.js:805/812`). Leave those as they are.

**New rule: C XP comes from distinct abilities used, not from repeated rolls.**

1. Remove the per-roll C XP at `combat.js:~487`. A C roll on its own gives no XP; near-miss rolls also give none.
2. Each **distinct** charisma ability (`family:tier`, e.g. `mock:2`) gives C XP **once per fight**. Repeating the same ability in the same fight gives nothing. Track it with a per-fight set on the player, cleared in `clearFightEffects()`.
3. XP per ability scales with tier (higher tier = harder roll). Start from tier 1 = 1, tier 2 = 2, tier 3 = 3 and tune in step 5.
4. Keep a hard limit as a safety net: at most **3 XP-giving charisma actions per fight** (constant `CHA_XP_ACTIONS_PER_FIGHT`), counted separately from `combatXpHits`. That stops a long mock loop from collecting every family and tier.
5. **Calibrate against the other stats** with `engine_sim.js` (or the sim from Phase 5.6). Run full games for an F, D, M and C build and measure XP gained in the main stat **per game turn** (not per fight; charisma fights are shorter and safer). Tune the numbers in steps 3 and 4 until the C build's rate is within ±15% of the median of F/D/M. Put all constants at the top of `combat.js` with a comment showing the measured rates.
6. **Learn (`respect:3`) has no stat ceiling either.** Remove `CHA_LEARN_CAP` and the M/A/V fallback: Learn always gives +1 C. Keep the existing limit of 4 dialogue gains per game.
7. Don't touch the Master's purchase limit (`game.js:1032`: max 6, C 8 with Magic Flute, 5 purchases). That's a shop rule, not an XP ceiling.
8. Check with the sim:
   - A C build's C stat over a game grows at a pace similar to the main stat of F/D/M builds.
   - Looping mock in one fight gives at most the per-fight limit.
   - Report the before/after XP-per-turn table in the commit message.

## Phase 4 — Remove dead code from the browser bundle

`index.html` loads ~967 KB of JS; ~520 KB of it is never used by the live bot (`bot_v2.js`). The headless harness (`lib_sb.js`) loads none of these and the bot works.

1. Remove these `<script>` tags from `index.html` and move the files out of `js/` (see Phase 5):
   - `js/engine/rl_combat.js`
   - `js/engine/combat_estimator.js`
   - `js/engine/combat_nn.js`
   - `js/engine/upgrade_advisor.js`
   - `js/engine/inventory_manager.js`
   - `js/data/weights/combat_weights.js`
   - `js/data/weights/estimator_weights.js`
   - `js/data/weights/nn_combat_weights.js`
   - `js/data/weights/upgrade_advisor_weights.js`
2. Before removing, grep for each global (`RLCombat`, `CombatEstimator`, `CombatNN`, `UpgradeAdvisor`, `InventoryManager`, `*_WEIGHTS`) in `js/` to confirm nothing live uses them.
3. Delete `js/engine/bot.js` (not loaded; `BotAI` comes from `bot_v2.js`).
4. Delete the legacy `resolve()` in `js/engine/combat.js` (lines ~597–681). It has no callers; the restored PvP doesn't use it.
5. Remove any other dead branches you find while doing this (e.g. `typeof BotAI.pvpTick` guards that are always true).

## Phase 5 — Repo cleanup (~4 MB of 4.7 MB tracked)

Before deleting anything here, create a tag `legacy-ml-2026-10` on the current HEAD so nothing is lost.

1. **Old ML/tooling pipeline** — move to a `legacy/` folder (or delete, since the tag keeps it): `simulate.js`, `sim_deaths.js`, `diag.js`, `sim_builds.js`, `sim_dragon.js`, `sim_vc_slots.js`, `benchmark_progression.js`, `ml/`, `train/`, plus the modules removed in Phase 4. They all depend on `bot.js` or the ML modules.
2. **Generated data**, delete from git:
   - `ml/model_weights.json` (copy of the NN weights)
   - `js/data/weights/build_viability.json` (read by nothing)
   - `benchmark_results.json`
   - `wins/plots/*.png`, `wins/run_comparison.png`
3. **Duplicates**: keep one of `BOARD GAME.ods` / `BOARD GAME.xlsx` (ask me which).
4. **Images in the root**: move `king_layout_*.png`, `map_preview.png` and `wins/D&D 1st run D-money-hard.png` to `docs/img/` (or delete if unused — check `gen_layouts.py` and the README).
5. **Keep**: `sim_v2.js`, `lib_sb.js`, `wins/*.json` run exports, `analyse_runs.py`, `gen_layouts.py`, `map.csv`.
6. Add the charisma balance harness `engine_sim.js` back to the repo (it was built in the charisma chat but never committed). If you don't have it, write a small one on top of `lib_sb.js`: run N fights per mob for F/D/M/C builds and print win rate, XP and rewards per build.
7. Add a `.gitignore`: `ml/training_data.jsonl`, `*.cpuprofile`, `node_modules/`, generated plots and benchmark JSON, editor files.

## Phase 6 — Performance

Profile first: `node --cpu-prof sim_v2.js 4 1`. Currently ~85% of bot time is the Monte Carlo fight sim in `bot_v2.js` (`d6` 31%, `simOnce` 29%, `simFight` 11%, `recompute` 9%). Pathfinding is under 1%. About 30 ms per bot turn on average.

1. **Exact win probability for plain fights.** When there are no curses, spells, fire, potions or smokes (most `tierWinP` / `tierStats` calls), compute the win chance exactly with a small DP over (player hearts, mob hearts, whose turn). Per-hit chances come from the exact 2d6 difference distribution; the mob's attack type is a uniform mix over its tied top stats. Keep Monte Carlo for everything else.
   - Add a test that DP and Monte Carlo (n = 20 000) agree within 1% on several mob/build pairs.
2. **Single-random roll comparisons.** Precompute `P(a + d6 > b + d6)` for margins −5..+5 (clamp outside) and replace two `d6()` calls with one `Math.random() < P[margin]` wherever only the comparison matters (not when the roll value is shown or reused).
3. **Fewer allocations in `simOnce`.** Avoid `new Set(mal.map(...))` every player turn, `Object.entries` on bloods every fight, and rebuilding `mal` arrays; use small fixed arrays/counters.
4. **Cache `tierStats`** the same way `tierWinP` is cached.
5. **Board rendering.** `Renderer.draw()` redraws all 51×38 tiles with fill, stroke and label on every event. Draw the static board once to an offscreen canvas (redraw only when the map changes) and per frame just blit it, then draw highlights, players and princess.
6. Report before/after timings for `node sim_v2.js 5 1` and `node sim_v2.js 2 4` in the PR, and confirm win rates didn't drop.

## Phase 7 — Update CLAUDE.md

Rewrite the outdated parts so future sessions don't repeat mistakes:

- Project structure: `bot_v2.js` is the bot (`BotAI`); `bot.js` and the ML modules are gone (or in `legacy/`).
- Script load order: copy the real order from `index.html`.
- PvP section: describe the rules from Phase 1 as implemented. Remove "`startPvpCombat()` is implemented but never triggered" (line ~349) and "Legacy `resolve()` kept for PVP" (line ~48).
- Stats: no ceiling from XP or Learn. The only limit is the Master purchase rule (max 6, C 8 with Magic Flute, 5 purchases).
- Charisma: near-miss +1 C buff, zone-scaled Deceive/Gift, Learn always +1 C (max 4 dialogue gains), C XP once per distinct ability per fight with a per-fight limit, tuned to match F/D/M XP pace.
- Design decision to keep: enchantment categories are intentionally **not** enforced (any enchant on any slot).
- Testing: how to run `sim_v2.js` and `engine_sim.js`, and that both must pass before committing.
- Add a line: "Don't delete systems described as unused without checking the code and asking."

## Final check before the PR

- [ ] Baseline vs final: win rate, average turns, runtime for both sim commands
- [ ] 4-bot game reaches and resolves PvP
- [ ] XP-per-turn table for F/D/M/C builds, C within ±15% of the F/D/M median
- [ ] Browser: start a game with 1 human + 3 bots, play to a fight, a shop, a charisma roll; no console errors
- [ ] `index.html` loads only the scripts it uses
- [ ] PR description lists every phase, anything skipped, and every question for me
