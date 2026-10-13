# Bot strategy work — state (2026-10-13)

## Done, in the working tree (not committed)
- **Bot bug fixes** in `js/engine/bot_v2.js`:
  - The route planner and the landing check now share one walk-through threshold (`walkNeed`) and one risk cost (`walkRisk`). Before, the carrier ping-ponged in front of a miniboss.
  - A boxed-in bot slowly accepts riskier fights (`stuckTurns`).
  - Invisibility Potion trips also work for Shop, Master and Guild goals.
  - Staging uses a fresh dragon estimate.
  - A carrier whose route is blocked by a rival accepts worse odds over time (`finishStall`).
- **Engine fix** in `js/engine/game.js`: the princess is dropped when her carrier dies to a monster, boss or the King. Before, she vanished and the game could never end.
- **Result:** 4-bot tournament timeouts went from 25 to 3 of 1820 games (`results/t16_s1` before, `results/t16_fix1` after; both on the fast PC).
- **Tools:**
  - `strategy_tournament.js`: `--seed`, `--resume`, `--report dirA dirB`. Both the tournament and `strategy_search.js` recycle workers every 25 games (each worker leaked 2–3 GB) and default to 6 workers. `BOT_FILE=<path>` runs another bot file.
- **2026-10-13: dev bot installed.** `bot_v2_dev.js` (with the extra enchants, the owned-slot fix and the enchant-restore fix) was copied over `js/engine/bot_v2.js`. `sim_v2.js 5 1` gives 5/5 wins (78–120 turns), `sim_v2.js 2 4 0 F,D,M,G` gives 2/2 winners, and the root `engine_sim.js` runs clean. `js/engine/engine_sim.js` is a stale copy that reads `js/new/` and crashes; use the root one.
- **2026-10-13: speed.**
  - `evalbatch.js` played every game twice. Its workers used the `--worker` flag, and `strategy_search.js` (which they `require`) then registered a second message handler. Results were right, but half the CPU was wasted. The workers now use `--evalworker`.
  - `evalbatch.js` appends each game to `--out` (default `bot_dev/evalbatch.jsonl`) and prints progress/ETA on stderr. `--resume` skips the games already in the file; `node bot_dev/evalbatch.js --report <file>` prints the table of a partial run.
  - Fight model (`simOnce`, `charmDecide`): no per-round allocations, numeric memo keys, and a Charisma decision is reused while its inputs haven't changed. It's 1.2–1.45× faster with **identical** game logs (checked on all 16 strategies plus tunes).
  - `bot_dev/baseline/bot_v2_base.js` = the last committed bot (HEAD `bot_v2.js`) with the same speed-up. It's for baseline runs via `BOT_FILE`.

## Solo results (DEV3, 100 seeds, in `eval_results.txt`)
| Change | Tune key | Result (median own turns to the dragon) |
|---|---|---|
| Enchant all 5 equipped items, +3 main-stat enchant on the extras (stacks) | `extraEnch:'main'` | **Keep.** F 86, D 90, DG 83, CH 79, DBG 84, GB 101, BP 100 |
| `extraEnch:'sim'` after the enchant-restore fix | | About even for F/DG/CH. **Better for D**: mean 105 vs 114, deaths 12 vs 16. Consider it for D |
| Owned-slot check | — | BB: 50 timeouts → 0, median 93. **Keep** |
| Enchant-restore fix | — | M 137 → 115. **Keep** |
| M/DT weapon Bloodlust | `weaponEnch` | No better than `'sim'` (M 116 vs 115; DT mean 163 vs 160, deaths 17 vs 12). Keep the default |
| BM `dragonGo:0.95` | | **Much worse** (189 vs 97). Rejected |
| Looser Bloodlust thresholds, guild ladder, CH `bossTrade` | | No real effect (see DEV2) |

## Enchant findings (2026-10-13)
- In the tournament, F/D/G stack +3 on 3 slots (weapon, Accordion, Pegasus), shield = Resistance (~80%), armor = Arcane (~70%). Re-enchants are rare now (0.04–0.7 per bot; Bloodlust bots re-enchant their upgraded weapon).
- M/DT have no +3M enchant, so they put Resistance everywhere.
- **Thorns was effectively never tried**: 37 of 22k enchants. The shield/armor picks are fixed, and `'sim'` scores dragon odds minus cost, which saturates near 100%. Thorns costs 100 and Resistance 50, so the cost decides.
- **Model check** (bot's own fight model, end-of-race gear, Thorns swapped onto the shield):
  - Tier-3 win: F 83→97, D 88→98, BM 88→98.
  - Dragon: M 84→99, DT 8→59.
  - Looks like a clear win; not yet measured in real games.
- New tune `shieldEnch` (default null = Resistance; e.g. `'thorns'`) is wired into `enchantPick` and both shield entries of the shopping list.

## To do (next session)
1. ~~Tournaments~~ **Done 2026-10-13** (`results/t16_dev` vs `results/t16_base`, same seeds, 1820 games each):
   - The dev bot is much faster: the median game is 335 turns vs 394, and most strategies reach the dragon 10–30 own turns sooner.
   - Win % (base → dev):
     - Up: G 34→43, GB 15→30, DB 13→26, DBG 19→28, BP 15→23, CR 30→33.
     - Down: BB 38→22, BM 36→21, M 21→9, DT 7→4, DG 37→32, F 30→27.
     - About the same: CH 45→43, D, FB, SS.
   - Mages fall furthest behind: M kills the dragon 6% of the time, DT 2%.
   - The dragon killer wins less often (90%→87%): more rivals arrive at the same time and steal the princess.
   - Non-wins: base had 1 timeout. Dev had 4, worth investigating:
     - STALL seeds 22153652 [DT,F,DG,DBG] and 23713695 [F,SS,BM,DT], both ending in combat after PvP.
     - ALL_DEAD seed 30128085 [CH,G,GB,DB] at T127.
     - TIMEOUT seed 33335280 [M,CH,GB,SS].
     - Replay with `node strategy_tournament.js --replay <seed> <lineup>`.
   - **Engine change 2026-10-13 (later):** Sharpness and Precision count once (Resistance still stacks). The dev bot (now installed as `js/engine/bot_v2.js`) falls back to Resistance instead of buying a second copy. Validation: `sim_v2.js 20 1` 17/20 wins, `sim_v2.js 4 4 0 F,D,M,G` 4/4, `engine_sim.js` clean.
   - **Engine changes after these runs** (they don't affect either result): Plunder = +50% of the loot's worth (coins + item sell value); Fury and Hawk Eye levels 1–3 at 33 coins per level, picked at the Master. Future runs use the new rules, so rerun the baseline before comparing again.
2. **Thorns solo batch** (~15 min with the fixed evalbatch):
   `nice -n 19 node bot_dev/evalbatch.js bot_dev/bot_v2_dev.js 100 6 "$(node bot_dev/genomes4.js)" --out bot_dev/eval_thorns.jsonl > bot_dev/eval_thorns.txt`
   Compare each row with DEV3. If Thorns wins, make it the default shield enchant (perhaps per profile), copy the dev bot to `js/engine/bot_v2.js`, and rerun the sims and the tournament. Also test Thorns on the armor for mages (no +3M to stack).
3. Still open:
   - DT is still the slowest (~150 solo). It spends 37% of its turns going to the single Master at (30,25).
   - M has no +3M enchant: design question (add one?). Thorns may cover most of it.
   - BM: own deaths 27/100 solo; in the tournament 89% of its dragon kills become wins.
   - Last timeout seen: two weak bots (DT, GB) left alive farm t0 forever.
3a. **Enchant work 2026-10-13 (see bot_dev/ENCHANT_PLAN.md, sections 5–5j):** screening tool `bot_dev/enchant_screen.js`; fixed default kits per strategy (`PROFILE_KITS`, installed in `js/engine/bot_v2.js`), −9 ±3 turns to the dragon vs the old rules on fresh seeds; the enchant planner (`tune.planner`) ties with the fixed kits and stays opt-in. Open: BB may prefer its old rules; DBG keeps them.
3b. Known stalls (seen 2026-10-13 in solo kit races; they also happen with the bot's own kit):
   - GB stuck between (16,31) and (16,32) next to the Priest ("already carrying a blessing") for 100+ turns: seeds 5253425, 5760241 (solo, `runSolo`).
   - Boss fights where neither side can hit never end (DT vs Witch seeds 5467238, 5673132; GB vs Sea Serpent 5696889). PvE has no round cap (PvP draws after 40 rounds).
4. Difficulty tiers: rank the strategies from the tournament. Then handicap the strong ones through tunes (`dragonGo`, `farmWin`, `extraEnch:false`, …) rather than relying on weak strategies' bugs. `strategy_search.js --gens 8` can search the tune space; `extraEnch`, `guildLadder` and `guildFarmWin` are already in `SPACE`.

## Machine note
Each node worker uses about 1.5 cores. On the slow PC (8 cores, 16 GB), keep at most 6 workers in total across all jobs: run the tournaments and batches one after another, not side by side.
