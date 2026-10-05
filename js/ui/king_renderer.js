// King Battle Renderer — 20×30 tactical grid canvas.

const KingRenderer = (() => {
  const CELL = 20;
  const W    = 20 * CELL;  // 400
  const H    = 30 * CELL;  // 600

  const BONUS_BG = {
    atk_2: '#ff9999', atk_1: '#ffd6d6',
    def_2: '#99bbff', def_1: '#cce0ff',
    none:  '#e8e0d0',
  };

  let canvas, ctx;
  let hoverCell = null;

  function init(el) {
    canvas = el;
    ctx    = canvas.getContext('2d');
    canvas.width  = W;
    canvas.height = H;
  }

  function bonusBg(s) {
    if (!s.bonus) return BONUS_BG.none;
    return BONUS_BG[`${s.bonus.type}_${s.bonus.value}`] ?? BONUS_BG.none;
  }

  function draw() {
    const bs = KingBattle.getState();
    if (!bs || bs.phase === 'weapon_assign') return;
    ctx.clearRect(0, 0, W, H);

    // ── Sector backgrounds ─────────────────────────────────────────────────
    for (const s of KingBattle.SECTORS) {
      ctx.fillStyle = bonusBg(s);
      for (const { x, y } of s.cells)
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }

    // ── Sector enemy-control tint ──────────────────────────────────────────
    if (bs.phase === 'planning') {
      for (const s of KingBattle.SECTORS) {
        const hasP = (bs.playerUnits ?? []).some(u => u.isAlive && u.sectorId === s.id);
        const hasK = (bs.kingUnits   ?? []).some(u => u.isAlive && u.sectorId === s.id);
        if (hasP && !hasK) {
          ctx.fillStyle = 'rgba(50,180,120,0.15)';
          for (const { x, y } of s.cells) ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
        } else if (hasK && !hasP) {
          ctx.fillStyle = 'rgba(200,50,50,0.15)';
          for (const { x, y } of s.cells) ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
        }
      }
    }

    // ── Cell grid ──────────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth   = 0.5;
    for (let r = 0; r <= 30; r++) { ctx.beginPath(); ctx.moveTo(0,r*CELL); ctx.lineTo(W,r*CELL); ctx.stroke(); }
    for (let c = 0; c <= 20; c++) { ctx.beginPath(); ctx.moveTo(c*CELL,0); ctx.lineTo(c*CELL,H); ctx.stroke(); }

    // ── Sector borders ─────────────────────────────────────────────────────
    ctx.strokeStyle = '#555';
    ctx.lineWidth   = 1.5;
    const drawn = new Set();
    for (const s of KingBattle.SECTORS) {
      for (const { x, y } of s.cells) {
        for (const [dx, dy] of [[1,0],[0,1]]) {
          const nx = x+dx, ny = y+dy;
          if (nx > 19 || ny > 29) continue;
          const nb = KingBattle.CELL_SECTOR[ny]?.[nx] ?? -1;
          if (nb !== s.id) {
            const key = dx ? `v_${x+1}_${y}` : `h_${x}_${y+1}`;
            if (!drawn.has(key)) {
              drawn.add(key);
              ctx.beginPath();
              if (dx) { ctx.moveTo((x+1)*CELL, y*CELL); ctx.lineTo((x+1)*CELL, (y+1)*CELL); }
              else    { ctx.moveTo(x*CELL, (y+1)*CELL); ctx.lineTo((x+1)*CELL, (y+1)*CELL); }
              ctx.stroke();
            }
          }
        }
      }
    }

    // ── Obstacles ──────────────────────────────────────────────────────────
    // 2×2 blocks drawn as unified stone pillars; isolated cells as rubble.
    const _drawnObs = new Set();
    for (const key of KingBattle.OBSTACLES) {
      if (_drawnObs.has(key)) continue;
      const [ox, oy] = key.split(',').map(Number);
      const is2x2 = KingBattle.OBSTACLES.has(`${ox+1},${oy}`) &&
                    KingBattle.OBSTACLES.has(`${ox},${oy+1}`) &&
                    KingBattle.OBSTACLES.has(`${ox+1},${oy+1}`);
      if (is2x2) {
        const px = ox * CELL, py = oy * CELL, pw = 2 * CELL, ph = 2 * CELL;
        ctx.fillStyle = '#5a5050';
        ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);
        ctx.fillStyle = '#3a3030';
        ctx.fillRect(px + 5, py + 5, pw - 10, ph - 10);
        ctx.strokeStyle = '#7a6a6a'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px + 2, py + ph - 4); ctx.lineTo(px + 2, py + 2); ctx.lineTo(px + pw - 4, py + 2);
        ctx.stroke();
        ctx.strokeStyle = '#2a2020';
        ctx.beginPath();
        ctx.moveTo(px + pw - 4, py + 2); ctx.lineTo(px + pw - 4, py + ph - 4); ctx.lineTo(px + 2, py + ph - 4);
        ctx.stroke();
        _drawnObs.add(key); _drawnObs.add(`${ox+1},${oy}`);
        _drawnObs.add(`${ox},${oy+1}`); _drawnObs.add(`${ox+1},${oy+1}`);
      } else {
        ctx.fillStyle = '#444';
        ctx.fillRect(ox*CELL + 1, oy*CELL + 1, CELL-2, CELL-2);
        ctx.fillStyle = '#333';
        ctx.fillRect(ox*CELL + 3, oy*CELL + 3, CELL-6, CELL-6);
        _drawnObs.add(key);
      }
    }

    // ── Sector group-move highlights ───────────────────────────────────────
    if (bs.phase === 'planning' && bs.selectedSectorId != null) {
      ctx.fillStyle = 'rgba(255,140,0,0.35)';
      for (const { x, y } of KingBattle.SECTORS[bs.selectedSectorId].cells)
        ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
      ctx.fillStyle = 'rgba(255,210,80,0.2)';
      for (const sid of KingBattle.reachableSectorsForSector(bs.selectedSectorId))
        for (const { x, y } of KingBattle.SECTORS[sid].cells)
          ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
    }

    // ── Move highlights (reachable cells for selected unit) ─────────────────
    if (bs.phase === 'planning' && bs.selectedUid) {
      const sel = bs.playerUnits.find(u => u.uid === bs.selectedUid);
      if (sel) {
        const cells = KingBattle.reachableCellsFor(sel);
        ctx.fillStyle = 'rgba(255,230,40,0.4)';
        for (const { x, y } of cells) ctx.fillRect(x*CELL, y*CELL, CELL, CELL);
      }
    }

    // ── LoS shadow (cells not visible from hovered reachable position) ──────
    if (bs.phase === 'planning' && bs.selectedUid && hoverCell) {
      ctx.fillStyle = 'rgba(0,0,0,0.48)';
      for (let y = 0; y < 30; y++)
        for (let x = 0; x < 20; x++)
          if (!KingBattle.canSee(hoverCell.x, hoverCell.y, x, y))
            ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    } else if (!bs.selectedUid || bs.phase !== 'planning') {
      hoverCell = null;
    }

    // ── Queued move arrows ─────────────────────────────────────────────────
    if (bs.phase === 'planning') {
      const allUnits = [...(bs.playerUnits ?? []), ...(bs.kingUnits ?? [])];
      for (const unit of allUnits) {
        if (!unit.isAlive || unit.team !== 'player') continue;
        const mv = bs.queuedMoves?.[unit.uid];
        if (!mv) continue;
        drawArrow(
          unit.pos.x, unit.pos.y, mv.x, mv.y,
          unit.uid === bs.selectedUid ? '#ffe000' : 'rgba(255,220,0,0.6)'
        );
      }
    }

    // ── Units ──────────────────────────────────────────────────────────────
    const allUnits = [...(bs.playerUnits ?? []), ...(bs.kingUnits ?? [])];
    for (const unit of allUnits) {
      if (!unit.isAlive) continue;
      const cx = unit.pos.x * CELL + CELL / 2;
      const cy = unit.pos.y * CELL + CELL / 2;
      const r  = CELL / 2 - 2;
      const isPlayer  = unit.team === 'player';
      const isSelected = unit.uid === bs.selectedUid;

      // HP bar (top of cell)
      const hpFrac = Math.max(0, unit.hp / unit.maxHp);
      ctx.fillStyle = '#222';
      ctx.fillRect(unit.pos.x*CELL, unit.pos.y*CELL, CELL, 3);
      ctx.fillStyle = hpFrac > 0.5 ? '#3c3' : hpFrac > 0.25 ? '#fc0' : '#f33';
      ctx.fillRect(unit.pos.x*CELL, unit.pos.y*CELL, CELL * hpFrac, 3);

      // Body
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = isPlayer ? '#229966' : '#bb2222';
      ctx.fill();

      // Outline
      if (isSelected) {
        ctx.strokeStyle = '#fff700';
        ctx.lineWidth = 2.5;
      } else {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
      }
      ctx.stroke();

      // Weapon indicator (small dot)
      const dotColors = { F: '#f88', D: '#8cf', M: '#4f8' };
      ctx.fillStyle = dotColors[unit.weapon] ?? '#fff';
      ctx.beginPath();
      ctx.arc(cx + r * 0.55, cy - r * 0.55, 3, 0, Math.PI * 2);
      ctx.fill();

      // Initial
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.floor(CELL * 0.5)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(unit.name[0].toUpperCase(), cx, cy);
    }

    // ── Border ─────────────────────────────────────────────────────────────
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, W, H);
  }

  function drawArrow(x1, y1, x2, y2, color) {
    const px1 = x1 * CELL + CELL / 2;
    const py1 = y1 * CELL + CELL / 2;
    const px2 = x2 * CELL + CELL / 2;
    const py2 = y2 * CELL + CELL / 2;
    const angle = Math.atan2(py2 - py1, px2 - px1);
    const headLen = 7;

    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = 2;

    ctx.beginPath();
    ctx.moveTo(px1, py1);
    ctx.lineTo(px2, py2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px2, py2);
    ctx.lineTo(px2 - headLen * Math.cos(angle - Math.PI/6), py2 - headLen * Math.sin(angle - Math.PI/6));
    ctx.lineTo(px2 - headLen * Math.cos(angle + Math.PI/6), py2 - headLen * Math.sin(angle + Math.PI/6));
    ctx.closePath();
    ctx.fill();
  }

  function cellAt(offsetX, offsetY) {
    const x = Math.floor(offsetX / CELL);
    const y = Math.floor(offsetY / CELL);
    if (x < 0 || x > 19 || y < 0 || y > 29) return null;
    return { x, y };
  }

  function setHoverCell(cell) { hoverCell = cell; }

  // ── Attack animations ──────────────────────────────────────────────────────
  function animateAttacks(attacks, onDone) {
    if (!attacks || !attacks.length) { onDone(); return; }

    const PROJ_DUR  = 320; // ms for D and M projectiles
    const SLASH_DUR = 260; // ms for F melee slash
    const DUR = Math.max(PROJ_DUR, SLASH_DUR);
    const start = performance.now();

    function frame(now) {
      const elapsed = now - start;
      const tGlobal = Math.min(1, elapsed / DUR);

      draw(); // base state

      for (const atk of attacks) {
        const dur = atk.isMelee ? SLASH_DUR : PROJ_DUR;
        const t   = Math.min(1, elapsed / dur);
        const alpha = atk.hit ? 1 : 0.5;

        const fx = atk.fromX * CELL + CELL / 2;
        const fy = atk.fromY * CELL + CELL / 2;
        const tx = atk.toX  * CELL + CELL / 2;
        const ty = atk.toY  * CELL + CELL / 2;

        if (atk.isMelee) {
          // F — slash: two diagonal lines at target, fade in then out
          const fade = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
          ctx.save();
          ctx.globalAlpha = fade * alpha;
          ctx.strokeStyle = '#ff6030';
          ctx.lineWidth   = 2.5;
          const sz = CELL * 0.45;
          ctx.beginPath(); ctx.moveTo(tx - sz, ty - sz); ctx.lineTo(tx + sz, ty + sz); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(tx + sz, ty - sz); ctx.lineTo(tx - sz, ty + sz); ctx.stroke();
          ctx.restore();
        } else if (atk.weapon === 'D') {
          // D — blue projectile dot moving toward target (stops at 75% on miss)
          const travel = atk.hit ? t : Math.min(t, 0.75) * (1 / 0.75) * 0.75;
          const px = fx + (tx - fx) * travel;
          const py = fy + (ty - fy) * travel;
          const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
          ctx.save();
          ctx.globalAlpha = fade * alpha;
          ctx.fillStyle   = '#8cf';
          ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        } else {
          // M — green glowing projectile, full range regardless of distance
          const travel = atk.hit ? t : Math.min(t, 0.75) * (1 / 0.75) * 0.75;
          const px = fx + (tx - fx) * travel;
          const py = fy + (ty - fy) * travel;
          const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
          ctx.save();
          ctx.globalAlpha = fade * alpha;
          ctx.shadowColor = '#4f8';
          ctx.shadowBlur  = 8;
          ctx.fillStyle   = '#4f8';
          ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }

      if (tGlobal < 1) {
        requestAnimationFrame(frame);
      } else {
        draw();
        onDone();
      }
    }

    requestAnimationFrame(frame);
  }

  return { init, draw, cellAt, CELL, setHoverCell, animateAttacks };
})();
