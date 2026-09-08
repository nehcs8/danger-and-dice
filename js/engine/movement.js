// Movement — BFS over the walkable grid up to the movement cap.
// Returns a Map of reachable tiles: "x,y" → stepCount.
// The player can stop at any tile with stepCount ≤ cap.

const Movement = (() => {

  function canUseSecrets(player) {
    return player.hasItem('compass') || player.hasEquipped('ragged_sandals');
  }

  // Returns Map<"x,y", steps> for every tile reachable in ≤ cap steps.
  // Origin tile is excluded (player is already there).
  // 0-1 BFS: traversal *within* a SECRET_PATH tile costs 0 steps (whole passage = 1 step).
  function getReachable(origin, cap, player) {
    const secrets  = canUseSecrets(player);
    const visited  = new Map();               // "x,y" → minSteps
    const queue    = [{ x: origin.x, y: origin.y, steps: 0 }];
    visited.set(`${origin.x},${origin.y}`, 0);

    while (queue.length) {
      const { x, y, steps } = queue.shift();
      const onSecret = MapGrid.get(x, y) === TileType.SECRET_PATH;
      if (steps >= cap && !onSecret) continue;

      for (const nb of MapGrid.getAdjacent(x, y, secrets)) {
        const key = `${nb.x},${nb.y}`;
        const newSteps = onSecret ? steps : steps + 1;
        if (!visited.has(key) || visited.get(key) > newSteps) {
          visited.set(key, newSteps);
          const nbType = MapGrid.get(nb.x, nb.y);
          // Uncleared miniboss and boss tiles block further BFS expansion.
          // A miniboss the player already defeated is treated as a normal path tile.
          const blocksExpansion = nbType === TileType.BOSS
            || (nbType === TileType.MINIBOSS && !player.hasUsedTile(nb.x, nb.y) && !player.hasEquipped('invis_cloak'));
          if (!blocksExpansion) {
            if (onSecret) queue.unshift({ x: nb.x, y: nb.y, steps: newSteps });
            else          queue.push   ({ x: nb.x, y: nb.y, steps: newSteps });
          }
        }
      }
    }

    visited.delete(`${origin.x},${origin.y}`);
    return visited;
  }

  // Returns true if a given destination is reachable from origin in ≤ cap steps.
  function canReach(origin, dest, cap, player) {
    const reachable = getReachable(origin, cap, player);
    return reachable.has(`${dest.x},${dest.y}`);
  }

  // Build the shortest path from origin to dest (0-1 BFS trace).
  // Returns array of {x,y} tiles in order, or null if unreachable.
  // Secret-path traversal costs 0 steps; entry into a secret path costs 1 as normal.
  function pathTo(origin, dest, cap, player) {
    const secrets   = canUseSecrets(player);
    const prev      = new Map();
    const minSteps  = new Map();
    const queue     = [{ x: origin.x, y: origin.y, steps: 0 }];
    const originKey = `${origin.x},${origin.y}`;
    const destKey   = `${dest.x},${dest.y}`;
    minSteps.set(originKey, 0);
    prev.set(originKey, null);

    while (queue.length) {
      const { x, y, steps } = queue.shift();
      const onSecret = MapGrid.get(x, y) === TileType.SECRET_PATH;
      if (steps >= cap && !onSecret) continue;

      for (const nb of MapGrid.getAdjacent(x, y, secrets)) {
        const key      = `${nb.x},${nb.y}`;
        const newSteps = onSecret ? steps : steps + 1;
        if (!minSteps.has(key) || minSteps.get(key) > newSteps) {
          minSteps.set(key, newSteps);
          prev.set(key, `${x},${y}`);
          if (key === destKey) {
            // Reconstruct path
            const path = [];
            let cur = key;
            while (cur !== originKey) {
              const [px, py] = cur.split(',').map(Number);
              path.unshift({ x: px, y: py });
              cur = prev.get(cur);
            }
            return path;
          }
          const nbType = MapGrid.get(nb.x, nb.y);
          const blocksExpansion = nbType === TileType.BOSS
            || (nbType === TileType.MINIBOSS && !player.hasUsedTile(nb.x, nb.y) && !player.hasEquipped('invis_cloak'));
          if (!blocksExpansion) {
            if (onSecret) queue.unshift({ x: nb.x, y: nb.y, steps: newSteps });
            else          queue.push   ({ x: nb.x, y: nb.y, steps: newSteps });
          }
        }
      }
    }
    return null;
  }

  // Roll the movement cap for a player (V + d6).
  function rollCap(player) {
    return player.getMovementCap();
  }

  // 0-1 BFS identical to getReachable but also blocks expansion at uncleared STOP tiles.
  function _getReachableNoStop(origin, cap, player) {
    const secrets = canUseSecrets(player);
    const visited = new Map();
    const queue   = [{ x: origin.x, y: origin.y, steps: 0 }];
    visited.set(`${origin.x},${origin.y}`, 0);

    while (queue.length) {
      const { x, y, steps } = queue.shift();
      const onSecret = MapGrid.get(x, y) === TileType.SECRET_PATH;
      if (steps >= cap && !onSecret) continue;

      for (const nb of MapGrid.getAdjacent(x, y, secrets)) {
        const key      = `${nb.x},${nb.y}`;
        const newSteps = onSecret ? steps : steps + 1;
        if (!visited.has(key) || visited.get(key) > newSteps) {
          visited.set(key, newSteps);
          const nbType = MapGrid.get(nb.x, nb.y);
          const blocksExpansion = nbType === TileType.BOSS
            || (nbType === TileType.MINIBOSS && !player.hasUsedTile(nb.x, nb.y) && !player.hasEquipped('invis_cloak'))
            || (nbType === TileType.STOP     && !player.hasUsedTile(nb.x, nb.y));
          if (!blocksExpansion) {
            if (onSecret) queue.unshift({ x: nb.x, y: nb.y, steps: newSteps });
            else          queue.push   ({ x: nb.x, y: nb.y, steps: newSteps });
          }
        }
      }
    }

    visited.delete(`${origin.x},${origin.y}`);
    return visited;
  }

  // Returns Set<"x,y"> of tiles that require passing through an uncleared STOP tile,
  // including the uncleared STOP tiles themselves.
  function getStopBlockedTiles(origin, cap, player) {
    const free = _getReachableNoStop(origin, cap, player);
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

  return { getReachable, getStopBlockedTiles, canReach, pathTo, rollCap, canUseSecrets };
})();
