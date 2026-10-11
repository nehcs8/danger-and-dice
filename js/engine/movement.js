// Movement — BFS over the walkable grid up to the movement cap.
// Returns a Map of reachable tiles: "x,y" → stepCount.
// The player can stop at any tile with stepCount ≤ cap.

const Movement = (() => {

  // PvP: the game registers a provider returning a Set of "x,y" tiles occupied by other
  // players. Those tiles stop movement like a boss (you may land there to fight, not pass).
  // The Invisibility Cloak / spell do NOT let you slip past players.
  let blockerProvider = null;
  function setBlockerProvider(fn) { blockerProvider = fn; }
  function blockersFor(player) { return blockerProvider ? blockerProvider(player) : null; }
  // Invisibility Cloak, or an Invisibility spell cast this turn: minibosses don't stop you.
  function sneaks(player) { return player.hasEquipped('invis_cloak') || !!player.invisibleThisTurn; }
  // Invisibility Potions: like the cloak, one uncleared miniboss (passed or landed on) per potion.
  function potionCharges(player) { return sneaks(player) ? 0 : (player.invisPotion | 0); }

  function canUseSecrets(player) {
    return player.hasItem('compass') || player.hasEquipped('ragged_sandals');
  }

  // 0-1 BFS over (tile, layer). Layer k = k Invisibility Potions spent passing uncleared
  // minibosses; with none left the next uncleared miniboss blocks. Secret-path traversal costs
  // 0 steps (whole passage = 1 step). Uncleared miniboss / boss / occupied tiles can be landed
  // on but block expansion; with stopBlocks, uncleared STOP tiles block expansion too.
  function search(origin, cap, player, { stopBlocks = false } = {}) {
    const secrets  = canUseSecrets(player);
    const blockers = blockersFor(player);
    const charges  = potionCharges(player);
    const best     = Array.from({ length: charges + 1 }, () => new Map());   // layer → "x,y" → min steps
    const prev     = new Map();                       // "layer|x,y" → "layer|x,y" (path trace)
    const originKey = `${origin.x},${origin.y}`;
    const queue    = [{ x: origin.x, y: origin.y, steps: 0, layer: 0 }];
    best[0].set(originKey, 0);
    prev.set(`0|${originKey}`, null);
    const visit = (layer, key, steps, from) => {
      if (best[layer].has(key) && best[layer].get(key) <= steps) return false;
      best[layer].set(key, steps); prev.set(`${layer}|${key}`, from);
      return true;
    };

    while (queue.length) {
      const { x, y, steps, layer } = queue.shift();
      const onSecret = MapGrid.get(x, y) === TileType.SECRET_PATH;
      if (steps >= cap && !onSecret) continue;
      const from = `${layer}|${x},${y}`;

      for (const nb of MapGrid.getAdjacent(x, y, secrets)) {
        const key      = `${nb.x},${nb.y}`;
        const newSteps = onSecret ? steps : steps + 1;
        if (!visit(layer, key, newSteps, from)) continue;
        const nbType = MapGrid.get(nb.x, nb.y);
        const blocked = nbType === TileType.BOSS
          || (blockers && blockers.has(key))
          || (stopBlocks && nbType === TileType.STOP && !player.hasUsedTile(nb.x, nb.y));
        if (blocked) continue;
        let next = layer;
        if (nbType === TileType.MINIBOSS && !player.hasUsedTile(nb.x, nb.y) && !sneaks(player)) {
          if (layer >= charges) continue;                  // stops you here
          next = layer + 1;                                // slip past it: one potion
          if (!visit(next, key, newSteps, from)) continue;
        }
        const st = { x: nb.x, y: nb.y, steps: newSteps, layer: next };
        if (onSecret) queue.unshift(st); else queue.push(st);
      }
    }
    return { best, prev, originKey };
  }

  // Returns Map<"x,y", steps> for every tile reachable in ≤ cap steps (origin excluded).
  // .potionUse: Map "x,y" → potions needed to get there (only tiles that need ≥ 1);
  // .potionOnly: the same tiles as a Set.
  function getReachable(origin, cap, player) {
    const { best, originKey } = search(origin, cap, player);
    const visited = new Map(), potionUse = new Map();
    best.forEach((layerMap, k) => {
      for (const [key, steps] of layerMap) {
        if (visited.has(key)) continue;                  // fewest potions wins (layers in order)
        visited.set(key, steps);
        if (k > 0) potionUse.set(key, k);
      }
    });
    visited.delete(originKey);
    potionUse.delete(originKey);
    visited.potionUse = potionUse;
    visited.potionOnly = new Set(potionUse.keys());
    return visited;
  }

  // Returns true if a given destination is reachable from origin in ≤ cap steps.
  function canReach(origin, dest, cap, player) {
    const reachable = getReachable(origin, cap, player);
    return reachable.has(`${dest.x},${dest.y}`);
  }

  // Shortest path from origin to dest using the fewest potions: array of {x,y} (origin excluded),
  // or null if unreachable. .potionsUsed = Invisibility Potions spent on the way.
  function pathTo(origin, dest, cap, player) {
    const { best, prev, originKey } = search(origin, cap, player);
    const destKey = `${dest.x},${dest.y}`;
    const layer = best.findIndex(m => m.has(destKey));
    if (layer < 0 || destKey === originKey) return null;
    const path = [];
    let cur = `${layer}|${destKey}`;
    while (cur && cur.slice(cur.indexOf('|') + 1) !== originKey) {
      const [px, py] = cur.slice(cur.indexOf('|') + 1).split(',').map(Number);
      path.unshift({ x: px, y: py });
      cur = prev.get(cur);
    }
    path.potionsUsed = layer;
    path.usedPotion = layer > 0;
    return path;
  }

  // Roll the movement cap for a player (V + d6).
  function rollCap(player) {
    return player.getMovementCap();
  }

  // Returns Set<"x,y"> of tiles that require passing through an uncleared STOP tile,
  // including the uncleared STOP tiles themselves.
  function getStopBlockedTiles(origin, cap, player) {
    const freeSearch = search(origin, cap, player, { stopBlocks: true });
    const free = new Set(freeSearch.best.flatMap(m => [...m.keys()]));
    const all  = getReachable(origin, cap, player);
    const result = new Set();
    for (const key of all.keys()) {
      const [x, y] = key.split(',').map(Number);
      if (!free.has(key) || (MapGrid.get(x, y) === TileType.STOP && !player.hasUsedTile(x, y))) {
        result.add(key);
      }
    }
    return result;
  }

  return { getReachable, getStopBlockedTiles, canReach, pathTo, rollCap, canUseSecrets, setBlockerProvider, sneaks, potionCharges };
})();
