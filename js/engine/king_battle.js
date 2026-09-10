// King Battle — simultaneous-turn tactical 5v5 in the King's Hall.
// Grid: 20×30, 40 sectors of varying size and shape (several L-shaped).
// Each round: 15 s planning → execute all moves in V order (alternating teams) → auto-attacks.
// Sector control: if a team has a living unit in sector S, the enemy cannot enter S.
// Obstacles block movement and ranged line of sight.

const KingBattle = (() => {

  // ── Sector definitions ───────────────────────────────────────────────────
  // makeSec accepts an array of [x1,y1,x2,y2] sub-rectangles so sectors can be L/T-shaped.
  function makeSec(id, name, rects, bonus) {
    const cells = [];
    const seen = new Set();
    for (const [x1, y1, x2, y2] of rects) {
      for (let r = y1; r <= y2; r++)
        for (let c = x1; c <= x2; c++) {
          const k = `${c},${r}`;
          if (!seen.has(k)) { seen.add(k); cells.push({ x: c, y: r }); }
        }
    }
    return { id, name, cells, bonus };
  }

  const SECTORS = [
    // ── Band A: rows 0-2 — Throne Level ──────────────────────────────────────
    makeSec( 0, 'Throne',                [[7,0,12,2]],                 { type:'atk', value:2 }),
    makeSec( 1, 'Left Guard Chamber',    [[3,0,6,2]],                  { type:'atk', value:1 }),
    makeSec( 2, 'Right Guard Chamber',   [[13,0,16,2]],                { type:'atk', value:1 }),
    makeSec( 3, 'Left Royal Alcove',     [[0,0,2,2]],                  { type:'def', value:1 }),
    makeSec( 4, 'Right Royal Alcove',    [[17,0,19,2]],                { type:'def', value:1 }),
    // ── Band B: rows 3-9 — Upper Hall ────────────────────────────────────────
    // 2×2 stone pillars at (3-4,5-6) left and (15-16,5-6) right
    makeSec( 5, 'Left Curtain Wall',     [[0,3,1,9]],                  { type:'def', value:2 }),
    makeSec( 6, 'Left Colonnade',        [[2,3,6,6]],                  { type:'def', value:1 }),
    makeSec( 7, 'Left Side Aisle',       [[2,7,6,9]],                  null),
    makeSec( 8, 'Nave Upper',            [[7,3,12,5],[7,6,9,6]],       { type:'atk', value:1 }),  // L-shape: stair into row 6
    makeSec( 9, 'Nave Lower',            [[10,6,12,6],[7,7,12,9]],     { type:'atk', value:2 }),  // L-shape: stair from row 6
    makeSec(10, 'Right Colonnade',       [[13,3,17,6],[13,7,15,7]],    { type:'def', value:1 }),  // L-shape: arm into row 7
    makeSec(11, 'Right Side Aisle',      [[16,7,17,7],[13,8,17,9]],    null),                     // L-shape: notch in row 7
    makeSec(12, 'Right Curtain Wall',    [[18,3,19,9]],                { type:'def', value:2 }),
    // ── Band C: rows 10-14 — Upper Middle ────────────────────────────────────
    makeSec(13, 'Left Gallery',          [[0,10,2,12],[0,13,1,14]],    null),  // L: wide top, narrow bottom
    makeSec(14, 'Left Forward',          [[3,10,6,12]],                { type:'atk', value:1 }),
    makeSec(15, 'Left Ground',           [[2,13,6,14]],                null),
    makeSec(16, 'Center High',           [[7,10,12,11]],               { type:'atk', value:2 }),
    makeSec(17, 'Center Field',          [[7,12,12,14]],               null),
    makeSec(18, 'Right Forward',         [[13,10,16,12]],              { type:'atk', value:1 }),
    makeSec(19, 'Right Ground',          [[13,13,17,14]],              null),
    makeSec(20, 'Right Gallery',         [[17,10,19,12],[18,13,19,14]],null),  // L: wide top, narrow bottom
    // ── Band D: rows 15-20 — Lower Middle ────────────────────────────────────
    // 2×2 stone pillars at (3-4,19-20) left and (15-16,19-20) right
    makeSec(21, 'Left Flank',            [[0,15,2,20]],                null),
    makeSec(22, 'Left Battle Hall',      [[3,15,6,18]],                { type:'def', value:1 }),
    makeSec(23, 'Left Gate Yard',        [[3,19,6,20]],                null),
    makeSec(24, 'Center Advance',        [[7,15,12,17]],               { type:'atk', value:1 }),
    makeSec(25, 'Center Clash',          [[7,18,12,20]],               { type:'atk', value:2 }),
    makeSec(26, 'Right Battle Hall',     [[13,15,16,18]],              { type:'def', value:1 }),
    makeSec(27, 'Right Gate Yard',       [[13,19,16,20]],              null),
    makeSec(28, 'Right Flank',           [[17,15,19,20]],              null),
    // ── Band E: rows 21-26 — Lower Hall ──────────────────────────────────────
    makeSec(29, 'Left Wall Entry',       [[0,21,1,26]],                { type:'def', value:2 }),
    makeSec(30, 'Left Entry Hall',       [[2,21,4,23],[2,24,5,26]],    { type:'def', value:1 }),  // L: narrow top, wide bottom
    makeSec(31, 'Entry Left Wing',       [[5,21,9,23],[6,24,9,26]],    null),                     // L: wide top, narrow bottom
    makeSec(32, 'Entry Right Wing',      [[10,21,14,23],[10,24,13,26]],null),                     // L: wide top, narrow bottom
    makeSec(33, 'Right Entry Hall',      [[15,21,17,23],[14,24,17,26]],{ type:'def', value:1 }),  // L: narrow top, wide bottom
    makeSec(34, 'Right Wall Entry',      [[18,21,19,26]],              { type:'def', value:2 }),
    // ── Band F: rows 27-29 — Player's Entrance ───────────────────────────────
    makeSec(35, "Player's Left Flank",   [[0,27,3,29]],                { type:'def', value:1 }),
    makeSec(36, "Player's Left Wing",    [[4,27,7,29]],                { type:'def', value:1 }),
    makeSec(37, "Player's Gate",         [[8,27,11,29]],               { type:'def', value:2 }),
    makeSec(38, "Player's Right Wing",   [[12,27,15,29]],              { type:'def', value:1 }),
    makeSec(39, "Player's Right Flank",  [[16,27,19,29]],              { type:'def', value:1 }),
  ];

  const CELL_SECTOR = Array.from({ length: 30 }, () => new Array(20).fill(-1));
  for (const s of SECTORS)
    for (const { x, y } of s.cells)
      CELL_SECTOR[y][x] = s.id;

  const ADJACENT = Array.from({ length: 40 }, () => new Set());
  for (const s of SECTORS) {
    for (const { x, y } of s.cells) {
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x+dx, ny = y+dy;
        if (nx < 0 || nx > 19 || ny < 0 || ny > 29) continue;
        const nb = CELL_SECTOR[ny][nx];
        if (nb !== -1 && nb !== s.id) {
          ADJACENT[s.id].add(nb);
          ADJACENT[nb].add(s.id);
        }
      }
    }
  }

  function sectorOf(x, y) { return CELL_SECTOR[y]?.[x] ?? -1; }
  function areAdjacent(a, b) { return a === b || (ADJACENT[a]?.has(b) ?? false); }
  function sectorDist(a, b) {
    if (a === b) return 0;
    const vis = new Set([a]);
    const q = [{ id: a, d: 0 }];
    while (q.length) {
      const { id, d } = q.shift();
      for (const nb of ADJACENT[id]) {
        if (nb === b) return d + 1;
        if (!vis.has(nb)) { vis.add(nb); q.push({ id: nb, d: d + 1 }); }
      }
    }
    return 99;
  }

  // ── Obstacles (impassable cells — pillars/rubble blocking movement & LoS) ──
  const OBSTACLES = new Set([
    // Upper hall — left stone pillar (2×2)
    '3,5', '4,5', '3,6', '4,6',
    // Upper hall — right stone pillar (2×2)
    '15,5', '16,5', '15,6', '16,6',
    // Lower middle — left stone pillar (2×2)
    '3,19', '4,19', '3,20', '4,20',
    // Lower middle — right stone pillar (2×2)
    '15,19', '16,19', '15,20', '16,20',
  ]);

  // ── Line-of-sight ────────────────────────────────────────────────────────
  function hasLoS(x1, y1, x2, y2) {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2 + 1;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const cx = Math.round(x1 + t * (x2 - x1));
      const cy = Math.round(y1 + t * (y2 - y1));
      if (cx === x2 && cy === y2) break;
      if (OBSTACLES.has(`${cx},${cy}`)) return false;
    }
    return true;
  }

  // ── Pre-computed visibility table ────────────────────────────────────────
  // Uses a flat Uint8Array [sy][sx][ty][tx] indexed as sy*12000+sx*600+ty*20+tx.
  // Obstacle boolean grid avoids string creation in the hot path.
  const _OBS = Array.from({ length: 30 }, (_, y) =>
    Array.from({ length: 20 }, (_, x) => OBSTACLES.has(`${x},${y}`))
  );
  const _VIS = new Uint8Array(20 * 30 * 20 * 30);
  (function buildVis() {
    for (let sy = 0; sy < 30; sy++)
      for (let sx = 0; sx < 20; sx++) {
        if (_OBS[sy][sx]) continue;
        for (let ty = 0; ty < 30; ty++)
          for (let tx = 0; tx < 20; tx++) {
            const dx = tx - sx, dy = ty - sy;
            const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2 + 1;
            let los = true;
            for (let i = 1; i < steps && los; i++) {
              const t  = i / steps;
              const cx = Math.round(sx + dx * t);
              const cy = Math.round(sy + dy * t);
              if (cx === tx && cy === ty) break;
              if (_OBS[cy][cx]) los = false;
            }
            if (los) _VIS[sy * 12000 + sx * 600 + ty * 20 + tx] = 1;
          }
      }
  })();
  function canSee(sx, sy, tx, ty) {
    return _VIS[sy * 12000 + sx * 600 + ty * 20 + tx] === 1;
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  const KING_MOB_IDS      = ['king', 'generale', 'eroe', 'paladino', 'guerriero'];
  const KING_START_SEC    = [0, 1, 2, 3, 4];
  const PLAYER_START_SEC  = [35, 36, 37, 38, 39];

  function autoWeapon(stats) {
    if (stats.F >= stats.D && stats.F >= stats.M) return 'F';
    return stats.D >= stats.M ? 'D' : 'M';
  }

  function makeUnit(uid, name, team, stats, baseHearts, weapon, startSectors, isPlayerChar) {
    const allCells = startSectors.flatMap(sid => SECTORS[sid].cells);
    const cell = allCells[Math.floor(Math.random() * allCells.length)];
    const hp = baseHearts + stats.F / 6;
    return { uid, name, team, hp, maxHp: hp, weapon, stats: { ...stats },
             pos: { x: cell.x, y: cell.y }, sectorId: sectorOf(cell.x, cell.y),
             isAlive: true, isPlayerChar };
  }

  function extractStats(player) {
    return { F: player.getStat('F'), A: player.getStat('A'), M: player.getStat('M'),
             C: player.getStat('C'), D: player.getStat('D'), V: player.getStat('V') };
  }

  // ── State ────────────────────────────────────────────────────────────────
  let state = null;

  function _mkPending(m, uid, isPlayerChar) {
    return {
      uid, mobId: m.id, name: m.name, isPlayerChar, qty: 1,
      stats: { F: m.stats.F, D: m.stats.D, M: m.stats.M, A: m.stats.A, V: m.stats.V, C: m.stats.C },
      baseHearts: m.hearts.max,
    };
  }

  function baseState(kingUnits, pendingAssign, pendingKingAssign, isStandalone, onVictory, onDefeat) {
    return {
      phase: 'weapon_assign',
      isStandalone,
      kingUnits,
      playerUnits: [],
      pendingAssign,
      pendingKingAssign,
      playerBudget: pendingAssign.length,
      kingBudget:   (pendingKingAssign ?? kingUnits).length,
      weapons: {},
      queuedMoves: {},    // uid → { x, y, sectorId }
      selectedUid: null,      // which player unit is selected during planning
      selectedSectorId: null, // which sector is selected for group move
      round: 1,
      log: ['── Round 1 ──'],
      onVictory,
      onDefeat,
    };
  }

  function init(player, onVictory, onDefeat) {
    const kingUnits = KING_MOB_IDS.map(id => {
      const m = MOBS.spawn(id);
      return makeUnit(`k_${m.id}`, m.name, 'king', m.stats, m.hearts.max,
                      autoWeapon(m.stats), KING_START_SEC, false);
    });
    const pending = [
      { uid: 'p_player', name: player.name, stats: extractStats(player),
        baseHearts: player.hearts.max, isPlayerChar: true, qty: 1 },
      ...player.friendsList.slice(0, 4).map((f, i) => ({
        uid: `p_f${i}`, name: f.name,
        stats: { F:f.stats.F, A:f.stats.A, M:f.stats.M, C:f.stats.C, D:f.stats.D, V:f.stats.V },
        baseHearts: f.hearts.max, isPlayerChar: false, qty: 1,
      })),
    ];
    state = baseState(kingUnits, pending, null, false, onVictory, onDefeat);
    return state;
  }

  function initStandalone(onDone) {
    const allNonBoss = [0,1,2,3].flatMap(t => MOBS.getByTier(t)).filter(m => !m.isBoss);
    function rnd5() {
      const picks = [];
      for (let i = 0; i < 5; i++) picks.push(allNonBoss[Math.floor(Math.random() * allNonBoss.length)]);
      return picks;
    }
    const pendingPlayer = rnd5().map((m, i) => _mkPending(MOBS.spawn(m.id), `p_${i}`, i === 0));
    const pendingKing   = rnd5().map((m, i) => _mkPending(MOBS.spawn(m.id), `k_${i}`, false));
    state = baseState([], pendingPlayer, pendingKing, true, () => onDone('victory'), () => onDone('defeat'));
    return state;
  }

  // ── Weapon assignment ────────────────────────────────────────────────────
  function setWeapon(uid, weapon) {
    if (state?.phase === 'weapon_assign') state.weapons[uid] = weapon;
  }

  function confirmWeapons() {
    if (state.phase !== 'weapon_assign') return;
    for (const m of state.pendingAssign)
      if (m.mobId && !state.weapons[m.uid]) state.weapons[m.uid] = 'F';
    // Expand each slot by its qty; skip empty slots (no stats)
    state.playerUnits = [];
    for (const m of state.pendingAssign) {
      if (!m.stats) continue;
      const weapon = state.weapons[m.uid] || 'F';
      const qty = m.qty || 1;
      for (let i = 0; i < qty; i++) {
        state.playerUnits.push(
          makeUnit(`${m.uid}_${i}`, m.name, 'player', m.stats, m.baseHearts,
                   weapon, PLAYER_START_SEC, i === 0 && m.isPlayerChar)
        );
      }
    }
    if (state.pendingKingAssign) {
      state.kingUnits = [];
      for (const m of state.pendingKingAssign) {
        if (!m.mobId || !m.stats) continue;
        const qty = m.qty || 1;
        for (let i = 0; i < qty; i++) {
          state.kingUnits.push(
            makeUnit(`${m.uid}_${i}`, m.name, 'king', m.stats, m.baseHearts,
                     autoWeapon(m.stats), KING_START_SEC, false)
          );
        }
      }
    }
    state.phase = 'planning';
    aiPlanMoves();
  }

  // ── Sector control ────────────────────────────────────────────────────────
  function sectorEnemyPresent(team, sectorId) {
    const enemies = team === 'player' ? state.kingUnits : state.playerUnits;
    return enemies.some(u => u.isAlive && u.sectorId === sectorId);
  }

  // ── Reachable cells for a unit (movement planning highlight) ─────────────
  function reachableCellsFor(unit) {
    const secIds = new Set([unit.sectorId, ...ADJACENT[unit.sectorId]]);
    const allUnits = [...state.playerUnits, ...state.kingUnits];
    const occupied = new Set(allUnits.filter(u => u.isAlive && u !== unit).map(u => `${u.pos.x},${u.pos.y}`));
    const out = [];
    for (const sid of secIds) {
      if (sectorEnemyPresent(unit.team, sid)) continue;
      for (const { x, y } of SECTORS[sid].cells) {
        if (!occupied.has(`${x},${y}`) && !OBSTACLES.has(`${x},${y}`))
          out.push({ x, y, sectorId: sid });
      }
    }
    return out;
  }

  // ── Move queuing (planning phase) ─────────────────────────────────────────
  function planMove(uid, x, y) {
    if (state.phase !== 'planning') return false;
    const unit = state.playerUnits.find(u => u.uid === uid && u.isAlive);
    if (!unit) return false;
    const sid = sectorOf(x, y);
    if (sid === -1 || OBSTACLES.has(`${x},${y}`)) return false;
    if (!areAdjacent(unit.sectorId, sid) && sid !== unit.sectorId) return false;
    if (sectorEnemyPresent('player', sid)) return false;
    state.queuedMoves[uid] = { x, y, sectorId: sid };
    return true;
  }

  function cancelMove(uid) {
    delete state.queuedMoves[uid];
  }

  // Adjacent sectors reachable for a group move (not enemy-controlled).
  function reachableSectorsForSector(sectorId) {
    return [...(ADJACENT[sectorId] ?? [])].filter(sid => !sectorEnemyPresent('player', sid));
  }

  // Queue moves for all alive player units in fromSectorId → toSectorId,
  // preserving their relative positions as closely as possible.
  function planSectorMove(fromSectorId, toSectorId) {
    if (state.phase !== 'planning') return false;
    if (!areAdjacent(fromSectorId, toSectorId)) return false;
    if (sectorEnemyPresent('player', toSectorId)) return false;

    const units = state.playerUnits.filter(u => u.isAlive && u.sectorId === fromSectorId);
    if (!units.length) return false;

    // Cells available in the destination (not obstacles, not occupied by non-moving units)
    const movingUids = new Set(units.map(u => u.uid));
    const blockedByOthers = new Set(
      [...state.playerUnits, ...state.kingUnits]
        .filter(u => u.isAlive && !movingUids.has(u.uid))
        .map(u => `${u.pos.x},${u.pos.y}`)
    );
    const destCells = SECTORS[toSectorId].cells.filter(
      c => !OBSTACLES.has(`${c.x},${c.y}`) && !blockedByOthers.has(`${c.x},${c.y}`)
    );
    if (destCells.length < units.length) return false;

    // Centroid offset: shift source centroid to destination centroid
    const srcCx = units.reduce((s, u) => s + u.pos.x, 0) / units.length;
    const srcCy = units.reduce((s, u) => s + u.pos.y, 0) / units.length;
    const dstCx = destCells.reduce((s, c) => s + c.x, 0) / destCells.length;
    const dstCy = destCells.reduce((s, c) => s + c.y, 0) / destCells.length;
    const offX  = Math.round(dstCx - srcCx);
    const offY  = Math.round(dstCy - srcCy);

    // Greedy assignment: each unit tries its ideal shifted cell, falls back to nearest free
    const assigned = new Set();
    const moves    = new Map(); // uid → cell
    for (const unit of units) {
      const ix = unit.pos.x + offX;
      const iy = unit.pos.y + offY;
      const ideal = destCells.find(c => c.x === ix && c.y === iy && !assigned.has(`${c.x},${c.y}`));
      if (ideal) {
        moves.set(unit.uid, ideal);
        assigned.add(`${ideal.x},${ideal.y}`);
      } else {
        let best = null, bestD = Infinity;
        for (const c of destCells) {
          if (assigned.has(`${c.x},${c.y}`)) continue;
          const d = Math.abs(c.x - ix) + Math.abs(c.y - iy);
          if (d < bestD) { bestD = d; best = c; }
        }
        if (!best) return false;
        moves.set(unit.uid, best);
        assigned.add(`${best.x},${best.y}`);
      }
    }

    for (const [uid, cell] of moves)
      state.queuedMoves[uid] = { x: cell.x, y: cell.y, sectorId: toSectorId };
    return true;
  }

  // ── AI move planning ──────────────────────────────────────────────────────
  function aiPlanMoves() {
    for (const unit of state.kingUnits) {
      if (!unit.isAlive) continue;
      const enemies = state.playerUnits.filter(u => u.isAlive);
      if (!enemies.length) continue;
      const nearest = enemies.reduce((b, e) =>
        sectorDist(unit.sectorId, e.sectorId) < sectorDist(unit.sectorId, b.sectorId) ? e : b
      );
      const cells = reachableCellsFor(unit);
      if (!cells.length) continue;
      const best = cells.reduce((b, c) =>
        sectorDist(c.sectorId, nearest.sectorId) < sectorDist(b.sectorId, nearest.sectorId) ? c : b
      );
      if (sectorDist(best.sectorId, nearest.sectorId) <= sectorDist(unit.sectorId, nearest.sectorId))
        state.queuedMoves[unit.uid] = { x: best.x, y: best.y, sectorId: best.sectorId };
    }
  }

  // ── Combat math ──────────────────────────────────────────────────────────
  function atkNum(unit, isMelee) {
    const s = unit.stats;
    const w = isMelee ? s.F : s[unit.weapon];
    const b = SECTORS[unit.sectorId]?.bonus;
    return w + s.C + (b?.type === 'atk' ? b.value : 0);
  }

  function defNum(unit, isMelee) {
    const s = unit.stats;
    const d = isMelee ? s.A : s.V;
    const b = SECTORS[unit.sectorId]?.bonus;
    return d + s.C + (b?.type === 'def' ? b.value : 0);
  }

  function resolveHit(attacker, target, isMelee) {
    let aN = atkNum(attacker, isMelee);
    const dN = defNum(target, isMelee);
    if (!isMelee) {
      const dist = sectorDist(attacker.sectorId, target.sectorId);
      aN = aN * Math.max(0.3, 1 - (dist - 2) * 0.15);
    }
    const aRoll = Math.random() * aN;
    const dRoll = Math.random() * dN;
    const hit = aRoll > dRoll;
    const s = attacker.stats;
    const wStat     = isMelee ? s.F : s[attacker.weapon];
    const otherStats = Math.max(1, s.F + s.D + s.M + s.A + s.V + s.C - wStat);
    return { hit, damage: hit ? wStat / otherStats : 0, aRoll, dRoll, aN, dN };
  }

  // ── Auto-attack ───────────────────────────────────────────────────────────
  function autoAttack(unit) {
    const enemies = (unit.team === 'player' ? state.kingUnits : state.playerUnits)
      .filter(e => e.isAlive);
    if (!enemies.length) return;

    function sqDist(a, b) { return (a.pos.x-b.pos.x)**2 + (a.pos.y-b.pos.y)**2; }

    let target, isMelee;

    if (unit.weapon === 'F') {
      // Melee: only attack enemies in adjacent/same sector; pick nearest by cell distance
      const adj = enemies.filter(e => areAdjacent(unit.sectorId, e.sectorId));
      if (!adj.length) return;
      target = adj.reduce((best, e) => sqDist(unit, e) < sqDist(unit, best) ? e : best);
      isMelee = true;
    } else {
      // Ranged: nearest visible enemy by actual cell distance
      const visible = enemies.filter(e => canSee(unit.pos.x, unit.pos.y, e.pos.x, e.pos.y));
      if (!visible.length) return;
      target = visible.reduce((best, e) => sqDist(unit, e) < sqDist(unit, best) ? e : best);
      isMelee = areAdjacent(unit.sectorId, target.sectorId);
    }

    const res = resolveHit(unit, target, isMelee);
    const t = isMelee ? 'melee' : 'ranged';
    if (res.hit) {
      target.hp = Math.max(0, target.hp - res.damage);
      if (target.hp <= 0) { target.hp = 0; target.isAlive = false; }
      _log(`${unit.name} ${t} → ${target.name}: ${res.damage.toFixed(2)} dmg`);
      if (!target.isAlive) _log(`  ${target.name} falls!`);
    } else {
      _log(`${unit.name} ${t} → ${target.name}: miss`);
    }
  }

  // ── Victory check ─────────────────────────────────────────────────────────
  function checkVictory() {
    if (state.isStandalone) {
      if (state.kingUnits.every(u => !u.isAlive))  { state.phase = 'victory'; return true; }
      if (state.playerUnits.every(u => !u.isAlive)) { state.phase = 'defeat';  return true; }
    } else {
      const kingAlive   = state.kingUnits.find(u => u.uid === 'k_king' && u.isAlive);
      const playerAlive = state.playerUnits.find(u => u.isPlayerChar && u.isAlive);
      if (!kingAlive)   { state.phase = 'victory'; return true; }
      if (!playerAlive) { state.phase = 'defeat';  return true; }
    }
    return false;
  }

  // ── Execute round ─────────────────────────────────────────────────────────
  function executeRound() {
    if (state.phase !== 'planning') return;
    state.phase = 'executing';
    state.selectedUid = null;

    const ap = state.playerUnits.filter(u => u.isAlive).sort((a,b) => b.stats.V - a.stats.V);
    const ak = state.kingUnits.filter(u => u.isAlive).sort((a,b) => b.stats.V - a.stats.V);
    const order = [];
    for (let i = 0; i < Math.max(ap.length, ak.length); i++) {
      if (i < ap.length) order.push(ap[i]);
      if (i < ak.length) order.push(ak[i]);
    }

    for (const unit of order) {
      if (!unit.isAlive) continue;

      // Execute queued move
      const mv = state.queuedMoves[unit.uid];
      if (mv) {
        const blocked = sectorEnemyPresent(unit.team, mv.sectorId);
        const occ = [...state.playerUnits, ...state.kingUnits]
          .some(u => u.isAlive && u !== unit && u.pos.x === mv.x && u.pos.y === mv.y);
        if (!blocked && !occ && !OBSTACLES.has(`${mv.x},${mv.y}`)) {
          unit.pos = { x: mv.x, y: mv.y };
          unit.sectorId = mv.sectorId;
          _log(`${unit.name} → ${SECTORS[mv.sectorId].name}`);
        } else if (blocked) {
          _log(`${unit.name}: path blocked`);
        }
      }

      autoAttack(unit);
      if (checkVictory()) break;
    }

    state.queuedMoves = {};

    if (state.phase === 'executing') {
      state.round++;
      _log(`── Round ${state.round} ──`);
      state.phase = 'planning';
      aiPlanMoves();
    }
  }

  function _log(msg) {
    state.log.push(msg);
    if (state.log.length > 200) state.log.shift();
  }

  // ── Standalone team editing ───────────────────────────────────────────────
  function setStandaloneUnit(team, idx, mobId) {
    if (!state?.isStandalone) return;
    const arr = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    if (!arr || idx < 0 || idx >= arr.length) return;
    const old = arr[idx];
    const fresh = _mkPending(MOBS.spawn(mobId), old.uid, old.isPlayerChar);
    fresh.qty = old.qty || 1; // preserve quantity
    arr[idx] = fresh;
    if (team === 'player') delete state.weapons[old.uid];
  }

  function addStandaloneUnit(team) {
    if (!state?.isStandalone) return;
    const arr    = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    const budget = team === 'player' ? state.playerBudget  : state.kingBudget;
    if (!arr) return;
    const totalUsed = arr.reduce((s, u) => s + (u.qty || 1), 0);
    if (totalUsed >= budget) return;
    // Add an empty slot — user picks the mob type
    arr.push({ uid: `${team[0]}_empty_${Date.now()}`, mobId: null, name: '',
               stats: null, baseHearts: 0, isPlayerChar: false, qty: 1 });
  }

  function resizeStandaloneTeam(team, newSize) {
    if (!state?.isStandalone) return;
    newSize = Math.max(1, Math.min(29, newSize));
    if (team === 'player') state.playerBudget = newSize;
    else                   state.kingBudget   = newSize;
    const arr = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    if (!arr) return;
    // Clip total units down to newSize from the last slot backwards
    let total = arr.reduce((s, u) => s + (u.qty || 1), 0);
    for (let i = arr.length - 1; i >= 0 && total > newSize; i--) {
      const cur    = arr[i].qty || 1;
      const excess = total - newSize;
      if (cur > 1) {
        const trim  = Math.min(cur - 1, excess);
        arr[i].qty  = cur - trim;
        total      -= trim;
      } else if (arr.length > 1) {
        const [removed] = arr.splice(i, 1);
        if (team === 'player') delete state.weapons[removed.uid];
        total--;
      }
    }
  }

  // Set the qty for a specific slot (identified by uid).
  function setSlotQty(team, uid, qty) {
    if (!state?.isStandalone) return;
    const arr    = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    const budget = team === 'player' ? state.playerBudget  : state.kingBudget;
    if (!arr) return;
    const slot = arr.find(u => u.uid === uid);
    if (!slot) return;
    const othersTotal = arr.filter(u => u.uid !== uid).reduce((s, u) => s + (u.qty || 1), 0);
    slot.qty = Math.max(1, Math.min(qty, budget - othersTotal));
  }

  function removeStandaloneUnit(team, idx) {
    if (!state?.isStandalone) return;
    const arr = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    if (!arr || arr.length <= 1) return;
    const [removed] = arr.splice(idx, 1);
    if (team === 'player') delete state.weapons[removed.uid];
  }

  function randomiseTeam(team) {
    if (!state?.isStandalone) return;
    const arr = team === 'player' ? state.pendingAssign : state.pendingKingAssign;
    if (!arr) return;
    const allMobs = [0,1,2,3].flatMap(t => MOBS.getByTier(t)).filter(m => !m.isBoss);
    for (const slot of arr) {
      const m = MOBS.spawn(allMobs[Math.floor(Math.random() * allMobs.length)].id);
      slot.mobId      = m.id;
      slot.name       = m.name;
      slot.stats      = { F:m.stats.F, D:m.stats.D, M:m.stats.M, A:m.stats.A, V:m.stats.V, C:m.stats.C };
      slot.baseHearts = m.hearts.max;
      if (team === 'player') delete state.weapons[slot.uid];
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    SECTORS, ADJACENT, CELL_SECTOR, OBSTACLES,
    sectorOf, areAdjacent, sectorDist, hasLoS, canSee,
    sectorEnemyPresent,
    init, initStandalone,
    getState:  () => state,
    clearState: () => { state = null; },
    setWeapon, confirmWeapons,
    setStandaloneUnit, addStandaloneUnit, removeStandaloneUnit, resizeStandaloneTeam, randomiseTeam,
    setSlotQty,
    reachableCellsFor,
    planMove, cancelMove, planSectorMove, reachableSectorsForSector,
    executeRound,
  };
})();
