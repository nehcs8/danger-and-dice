# Bot strategy work — state (2026-10-12)

## Done, in the working tree (not committed)
- **Bot bug fixes** in `js/engine/bot_v2.js`:
  - The route planner and the landing check now share one walk-through threshold (`walkNeed`) and one risk cost (`walkRisk`). Before, the carrier ping-ponged in front of a miniboss.
  - A boxed-in bot slowly accepts riskier fights (`stuckTurns`).
  - Invisibility Potion trips also work for Shop, Master and Guild goals.
  - Staging uses a fresh dragon estimate.
  - A carrier whose route is blocked by a rival accepts worse odds over time (`finishStall`).
- **Engine fix** in `js/engine/game.js`: the princess is dropped when her carrier dies to a monster, boss or the King. Before, she vanished and the game could never end.
- **Result:** 4-bot tournament timeouts went from 25 to 3 of 1820 games (`results/t16_s1` before, `results/t16_fix1` after).
- **Tools:**
  - `strategy_tournament.js`: `--seed`, `--resume`, `--report dirA dirB`. Both the tournament and `strategy_search.js` recycle workers every 25 games (each worker leaked 2–3 GB) and default to 6 workers. `BOT_FILE=<path>` runs another bot file.

## In progress: `bot_dev/bot_v2_dev.js` (not yet in bot_v2.js)
| Change | Tune key | Solo result (median own turns to the dragon, 100 seeds) |
|---|---|---|
| Enchant all 5 equipped items: +3 main-stat enchant on Pegasus and Accordion, which stacks | `extraEnch:'main'` | **Big win:** F 96→85, D 105→87, DG 88→81, CH 92→78, DBG 106→83, GB 133→96, BP 125→99 |
| `extraEnch:'A'` / `'sim'` | | Worse than `'main'`. `'sim'` (pick by simulated dragon odds) is bad: it ignores farming value |
| Looser farm and heal thresholds for Bloodlust profiles | profile `tune` | No gain; "bolder" only adds deaths. Can revert or keep |
| Guild level ladder (z0 at Lv1, z1 at Lv2, z2 from Lv3) | `guildLadder`, `guildFarmWin` | No effect: guild bots already level fine |
| CH trades with bosses instead of killing them | `bossTrade:'only'` | CH 79→78. "No bosses at all" scores 76 |
| Owned-slot check (BB re-bought its Accordion forever) | — | Fixes 50% BB timeouts. **Must keep** |
| Simulated enchant pick now restores the real enchantment | — | Bug that made M/DT re-enchant ~8× per game. **Must keep** |
| M/DT weapon enchant chosen by `'sim'`; `weaponEnch` override | `weaponEnch` | Untested after the fix |

`bot_dev/eval_results.txt` has the full baseline / dev / ablation output. The dev numbers there predate the last two fixes.

## To do (on the fast PC)
1. Re-run the queued batch on the fixed dev copy:
   `nice -n 19 node bot_dev/evalbatch.js bot_dev/bot_v2_dev.js 100 6 "$(node bot_dev/genomes3.js)"`
   It covers all 16 strategies, M/DT with `weaponEnch:'bloodlust'`, and BM with `dragonGo:0.95`.
2. Decide per row:
   - Keep `extraEnch:'main'`.
   - For M and DT, take whichever weapon enchant wins.
   - BM: own deaths doubled (14→27). With better gear it now fights the dragon itself at 85% odds; test `dragonGo:0.95` for BM.
3. Copy `bot_v2_dev.js` over `js/engine/bot_v2.js`. Then run `node sim_v2.js 5 1`, `node sim_v2.js 2 4 0 F,D,M,G` and `node engine_sim.js`.
4. Run the tournament:
   `node strategy_tournament.js --workers N --out results/t16_dev`
   Compare with `node bot_dev/analyze.js results/t16_fix1` vs `results/t16_dev`.
5. Still open:
   - DT is still the slowest (~150 solo). It spends 37% of its turns going to the single Master at (30,25).
   - M has no +3M enchant, so it can't stack its main stat. That's a design question: add a "+3M" enchant?
   - BM loses the princess in PvP after its friend kills the dragon (only 76% of its dragon kills become wins).
   - Last timeout seen: two weak bots (DT, GB) left alive farm t0 forever.
6. Difficulty tiers: rank the strategies from step 4. Then handicap the strong ones through tunes (`dragonGo`, `farmWin`, `extraEnch:false`, …) rather than relying on weak strategies' bugs. `strategy_search.js --gens 8` can search the tune space; `extraEnch`, `guildLadder` and `guildFarmWin` are already in `SPACE`.

## Machine note
Each node worker uses about 1.5 cores. On the slow PC, keep at most 6 workers in total across all jobs.
