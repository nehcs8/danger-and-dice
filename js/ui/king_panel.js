// King Panel — UI controller for the King's Hall tactical battle.

const KingPanel = (() => {
  let _showAnimals = true;

  let overlay, weaponDiv, battleDiv,
      assignList, btnConfirm,
      roundLabel, timerEl, unitList, logEl, sectorInfoEl,
      btnCommit, actionHint;

  const PLAN_SECONDS_NORMAL = 15;
  const PLAN_SECONDS_FAST   = 3;
  let fastMode = false;
  let planTimer = null;
  let planSecondsLeft = PLAN_SECONDS_NORMAL;
  let _logRenderedCount = 0;

  let _lastHoverKey = null;
  function _setHoverCell(cell) {
    const key = cell ? `${cell.x},${cell.y}` : null;
    if (key === _lastHoverKey) return;
    _lastHoverKey = key;
    KingRenderer.setHoverCell(cell);
    KingRenderer.draw();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    overlay     = _el('king-battle-overlay');
    weaponDiv   = _el('king-weapon-assign');
    battleDiv   = _el('king-battle-main');
    assignList  = _el('king-assign-units');
    btnConfirm  = _el('btn-king-assign-confirm');
    roundLabel  = _el('king-round-label');
    timerEl     = _el('king-timer');
    unitList    = _el('king-unit-list');
    logEl       = _el('king-log');
    sectorInfoEl= _el('king-sector-info');
    btnCommit   = _el('btn-king-commit');
    actionHint  = _el('king-action-hint');

    KingRenderer.init(_el('king-canvas'));

    btnConfirm.addEventListener('click', onConfirmWeapons);
    btnCommit.addEventListener('click',  onCommitPlanning);
    _el('btn-king-fast').addEventListener('click', () => {
      fastMode = !fastMode;
      _el('btn-king-fast').classList.toggle('king-fast-active', fastMode);
      if (planTimer) { startPlanningTimer(); }  // restart timer at new speed
    });

    // Weapon-assign delegated events (bound once; work across re-renders)
    assignList.addEventListener('change', e => {
      if (e.target.id === 'king-show-animals') {
        _showAnimals = e.target.checked;
        renderWeaponAssign();
        return;
      }
      if (e.target.type === 'radio' && e.target.name.startsWith('wpn_') && e.target.checked) {
        KingBattle.setWeapon(e.target.name.slice(4), e.target.value);
      } else if (e.target.classList.contains('king-mob-select')) {
        const val = e.target.value;
        if (val) {
          KingBattle.setStandaloneUnit(e.target.dataset.team, +e.target.dataset.idx, val);
          renderWeaponAssign();
        }
      } else if (e.target.classList.contains('king-qty-select')) {
        const qty = parseInt(e.target.value, 10);
        if (!isNaN(qty)) {
          KingBattle.setSlotQty(e.target.dataset.team, e.target.dataset.uid, qty);
          renderWeaponAssign();
        }
      } else if (e.target.classList.contains('king-team-counter')) {
        const v = parseInt(e.target.value, 10);
        if (!isNaN(v)) { KingBattle.resizeStandaloneTeam(e.target.dataset.team, v); renderWeaponAssign(); }
      }
    });
    assignList.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('king-add-unit')) {
        KingBattle.addStandaloneUnit(btn.dataset.team);
        renderWeaponAssign();
      } else if (btn.classList.contains('king-remove-unit')) {
        KingBattle.removeStandaloneUnit(btn.dataset.team, +btn.dataset.idx);
        renderWeaponAssign();
      } else if (btn.classList.contains('king-randomise-team')) {
        KingBattle.randomiseTeam(btn.dataset.team);
        renderWeaponAssign();
      }
    });
    _el('king-canvas').addEventListener('click',       onCanvasClick);
    _el('king-canvas').addEventListener('contextmenu', onCanvasRightClick);
    _el('king-canvas').addEventListener('mousemove',   onCanvasHover);
    _el('king-canvas').addEventListener('mouseleave', () => {
      if (sectorInfoEl) sectorInfoEl.textContent = '';
      _setHoverCell(null);
    });
  }

  // ── Show / hide ───────────────────────────────────────────────────────────
  function show() {
    const bs = KingBattle.getState();
    if (!bs) return;
    _el('king-standalone-result').style.display = 'none';
    overlay.classList.remove('hidden');
    if (bs.phase === 'weapon_assign') showWeaponAssign();
    else showBattle();
  }

  function hide() {
    stopTimer();
    overlay.classList.add('hidden');
    weaponDiv.classList.add('hidden');
    battleDiv.classList.add('hidden');
  }

  // ── Weapon assignment ─────────────────────────────────────────────────────
  function showWeaponAssign() {
    weaponDiv.classList.remove('hidden');
    battleDiv.classList.add('hidden');
    renderWeaponAssign();
  }

  function renderWeaponAssign() {
    const bs = KingBattle.getState();
    if (!bs) return;

    const byTier = [0,1,2,3].map(t => ({
      tier: t,
      mobs: MOBS.getByTier(t).filter(m => !m.isBoss && !m.isAnimal).sort((a,b) => a.name.localeCompare(b.name)),
    }));
    const bossMobs = [0,1,2,3].flatMap(t => MOBS.getByTier(t))
      .filter(m => m.isBoss)
      .sort((a, b) => a.name.localeCompare(b.name));

    const ANIMAL_SPECIES = [
      { id: 'bear',    name: 'Bears'    }, { id: 'fox',     name: 'Foxes'    },
      { id: 'owl',     name: 'Owls'     }, { id: 'parrot',  name: 'Parrots'  },
      { id: 'wolf',    name: 'Wolves'   }, { id: 'serpent', name: 'Serpents' },
      { id: 'gorilla', name: 'Gorillas' }, { id: 'hawk',    name: 'Hawks'    },
      { id: 'raven',   name: 'Ravens'   }, { id: 'peacock', name: 'Peacocks' },
      { id: 'wyvern',  name: 'Wyverns'  }, { id: 'panther', name: 'Panthers' },
      { id: 'sphinx',  name: 'Sphinxes' }, { id: 'harpy',   name: 'Harpies'  },
      { id: 'chimera', name: 'Chimeras' },
    ];

    function mobOptions(selectedId) {
      let html = '';
      for (const { tier, mobs } of byTier) {
        if (!mobs.length) continue;
        html += `<optgroup label="Tier ${tier}">` +
          mobs.map(m => {
            const s = m.stats;
            return `<option value="${m.id}"${m.id === selectedId ? ' selected' : ''}>${m.name}  F${s.F} D${s.D} M${s.M} A${s.A} V${s.V} C${s.C}</option>`;
          }).join('') + `</optgroup>`;
      }
      if (bossMobs.length) {
        html += `<optgroup label="Bosses">` +
          bossMobs.map(m => {
            const s = m.stats;
            return `<option value="${m.id}"${m.id === selectedId ? ' selected' : ''}>${m.name}  F${s.F} D${s.D} M${s.M} A${s.A} V${s.V} C${s.C}</option>`;
          }).join('') + `</optgroup>`;
      }
      if (_showAnimals) {
        for (const sp of ANIMAL_SPECIES) {
          const variants = MOBS.list.filter(m => m.isAnimal && m.id.startsWith(sp.id + '_'));
          if (!variants.length) continue;
          html += `<optgroup label="── ${sp.name} ──">` +
            variants.map(m => {
              const s = m.stats;
              return `<option value="${m.id}"${m.id === selectedId ? ' selected' : ''}>${m.name}  F${s.F} D${s.D} M${s.M} A${s.A} V${s.V} C${s.C}</option>`;
            }).join('') + `</optgroup>`;
        }
      }
      return html;
    }

    function autoWpnLabel(s) {
      if (s.F >= s.D && s.F >= s.M) return 'F';
      return s.D >= s.M ? 'D' : 'M';
    }

    function dispHp(m) {
      return m.maxHp !== undefined
        ? m.maxHp.toFixed(1)
        : (m.baseHearts + m.stats.F / 6).toFixed(1);
    }

    function unitAtk(s, weapon) { return s[weapon] + s.C; }
    function unitDef(s)         { return s.A + s.C; }

    function buildRows(units, team, editable) {
      const budget = editable ? (team === 'player' ? bs.playerBudget : bs.kingBudget) : null;
      const totalUsed = editable ? units.reduce((s, u) => s + (u.qty || 1), 0) : 0;

      return units.map((m, idx) => {
        const s      = m.stats;
        const curWpn = (s && team === 'player') ? (bs.weapons[m.uid] || 'F')
                     : s ? autoWpnLabel(s) : 'F';

        // Stats cells — show dashes for empty slots
        const sc = v => `<td class="king-td-stat">${s ? v : '—'}</td>`;

        let qtyCell = '';
        let rmBtn   = '<span class="king-rm-placeholder"></span>';
        let nameCell;
        let wpnCell;

        if (editable) {
          const qty         = m.qty || 1;
          const othersTotal = totalUsed - qty;
          const maxQty      = Math.max(1, budget - othersTotal);
          qtyCell =
            `<td class="king-td-qty">` +
            `<select class="king-qty-select" data-team="${team}" data-uid="${m.uid}">` +
            Array.from({ length: maxQty }, (_, i) => i + 1)
              .map(k => `<option value="${k}"${k === qty ? ' selected' : ''}>×${k}</option>`)
              .join('') +
            `</select></td>`;

          nameCell =
            `<select class="king-mob-select" data-team="${team}" data-idx="${idx}">` +
            (m.mobId ? '' : '<option value="" disabled selected>— pick unit —</option>') +
            mobOptions(m.mobId) +
            `</select>`;

          rmBtn = units.length > 1
            ? `<button class="king-remove-unit" data-team="${team}" data-idx="${idx}" title="Remove">✕</button>`
            : '<span class="king-rm-placeholder"></span>';

          wpnCell = team === 'player'
            ? ['F','D','M'].map(w =>
                `<label class="king-wpn-label">` +
                `<input type="radio" name="wpn_${m.uid}" value="${w}"${curWpn === w ? ' checked' : ''}${!s ? ' disabled' : ''}> ${w}` +
                `</label>`
              ).join('')
            : `<span class="king-auto-wpn">[${s ? autoWpnLabel(s) : '?'}]</span>`;
        } else {
          nameCell = `<span class="king-fixed-name">${m.name}</span>`;
          wpnCell = team === 'player'
            ? ['F','D','M'].map(w =>
                `<label class="king-wpn-label"><input type="radio" name="wpn_${m.uid}" value="${w}"${curWpn === w ? ' checked' : ''}> ${w}</label>`
              ).join('')
            : `<span class="king-auto-wpn">[${curWpn}]</span>`;
        }

        return `<tr>
          <td class="king-td-rm">${rmBtn}</td>
          ${qtyCell}
          <td class="king-td-name">${nameCell}</td>
          ${sc(s?.F)}${sc(s?.D)}${sc(s?.M)}${sc(s?.A)}${sc(s?.V)}${sc(s?.C)}
          <td class="king-td-hp">${s ? dispHp(m) : '—'}</td>
          <td class="king-td-atk">${s ? unitAtk(s, curWpn) : '—'}</td>
          <td class="king-td-def">${s ? unitDef(s) : '—'}</td>
          <td class="king-td-wpn">${wpnCell}</td>
        </tr>`;
      }).join('');
    }

    function buildTable(units, team, editable) {
      const budget     = editable ? (team === 'player' ? bs.playerBudget : bs.kingBudget) : null;
      const totalUsed  = editable ? units.reduce((s, u) => s + (u.qty || 1), 0) : 0;
      const addBtn     = editable && totalUsed < budget
        ? `<button class="king-add-unit" data-team="${team}">+ Add slot</button>` : '';
      const colSpan    = editable ? 13 : 12;
      const qtyHeader  = editable ? '<th class="king-td-qty" title="Quantity">×</th>' : '';
      return `<table class="king-stats-table">
        <thead><tr>
          <th class="king-td-rm"></th>
          ${qtyHeader}
          <th class="king-th-name">Name</th>
          <th class="king-th-stat" title="Strength">F</th>
          <th class="king-th-stat" title="Dexterity">D</th>
          <th class="king-th-stat" title="Magic">M</th>
          <th class="king-th-stat" title="Armor">A</th>
          <th class="king-th-stat" title="Speed">V</th>
          <th class="king-th-stat" title="Charisma">C</th>
          <th class="king-th-stat" title="Hit Points">HP</th>
          <th class="king-th-atk" title="Base attack (weapon stat + C, no terrain)">ATK</th>
          <th class="king-th-def" title="Base melee defense (A + C, no terrain)">DEF</th>
          <th class="king-th-wpn">${team === 'player' ? 'Weapon' : 'Auto'}</th>
        </tr></thead>
        <tbody>${buildRows(units, team, editable)}</tbody>
        ${addBtn ? `<tfoot><tr><td colspan="${colSpan}" class="king-td-add">${addBtn}</td></tr></tfoot>` : ''}
      </table>`;
    }

    const editable = bs.isStandalone;
    const enemyUnits = bs.pendingKingAssign ?? bs.kingUnits;

    function counterInput(team, units, budget) {
      if (!editable) return '';
      const used = units.reduce((s, u) => s + (u.qty || 1), 0);
      return `<input type="number" class="king-team-counter" data-team="${team}"
                min="1" max="29" value="${budget}">
              <small style="color:#aaa">${used}/${budget} units</small>`;
    }

    const rndBtn = team => editable
      ? `<button class="king-randomise-team" data-team="${team}" title="Fill all slots with random units">🎲 Random</button>`
      : '';

    assignList.innerHTML = `
      ${editable ? `<div class="king-assign-options">
        <label><input type="checkbox" id="king-show-animals"${_showAnimals ? ' checked' : ''}> Include animals in dropdown</label>
      </div>` : ''}
      <div id="king-assign-tables">
        <div class="king-assign-col">
          <div class="king-assign-col-hdr">
            Your Forces
            ${counterInput('player', bs.pendingAssign, bs.playerBudget)}
            ${rndBtn('player')}
          </div>
          ${buildTable(bs.pendingAssign, 'player', editable)}
        </div>
        <div class="king-assign-col">
          <div class="king-assign-col-hdr">
            Enemy Forces
            ${counterInput('king', enemyUnits, bs.kingBudget)}
            ${rndBtn('king')}
          </div>
          ${buildTable(enemyUnits, 'king', editable)}
        </div>
      </div>
    `;
  }

  function onConfirmWeapons() {
    KingBattle.confirmWeapons();
    weaponDiv.classList.add('hidden');
    battleDiv.classList.remove('hidden');
    logEl.innerHTML = '';
    _logRenderedCount = 0;
    updateBattleUI();
    KingRenderer.draw();
    startPlanningTimer();
  }

  // ── Battle UI ─────────────────────────────────────────────────────────────
  function showBattle() {
    weaponDiv.classList.add('hidden');
    battleDiv.classList.remove('hidden');
    updateBattleUI();
    KingRenderer.draw();
    if (KingBattle.getState()?.phase === 'planning') startPlanningTimer();
  }

  function updateBattleUI() {
    const bs = KingBattle.getState();
    if (!bs) return;

    roundLabel.textContent = `Round ${bs.round}`;

    // Sector group-move selection takes priority in the hint
    if (bs.selectedSectorId != null) {
      const sec = KingBattle.SECTORS[bs.selectedSectorId];
      actionHint.innerHTML =
        `<strong>Sector: ${sec?.name ?? '?'}</strong> selected — ` +
        `right-click a highlighted sector to move all units there. ` +
        `Right-click same sector to cancel.`;
      btnCommit.disabled = bs.phase !== 'planning';
      renderUnitList(bs);
      renderLog(bs);
      return;
    }

    // Selected unit info
    const sel = bs.playerUnits?.find(u => u.uid === bs.selectedUid);
    if (sel) {
      const s = sel.stats;
      actionHint.innerHTML =
        `<strong>${sel.name}</strong> [${sel.weapon}] — HP ${sel.hp.toFixed(1)}/${sel.maxHp.toFixed(1)}<br>` +
        `F:${s.F} D:${s.D} M:${s.M} A:${s.A} V:${s.V} C:${s.C}<br>` +
        `${SECTORS_REF(sel.sectorId)}<br>` +
        (bs.queuedMoves[sel.uid]
          ? `Move queued → ${SECTORS_REF(bs.queuedMoves[sel.uid].sectorId)} <span class="king-cancel-move" data-uid="${sel.uid}">[cancel]</span>`
          : 'Click a yellow cell to queue move');
      actionHint.querySelector('.king-cancel-move')?.addEventListener('click', e => {
        KingBattle.cancelMove(e.target.dataset.uid);
        updateBattleUI();
        KingRenderer.draw();
      });
    } else {
      actionHint.innerHTML = 'Click a unit to select it and queue a move.';
    }

    btnCommit.disabled = bs.phase !== 'planning';

    renderUnitList(bs);
    renderLog(bs);
  }

  function SECTORS_REF(sid) {
    return KingBattle.SECTORS[sid]?.name ?? '?';
  }

  function renderUnitList(bs) {
    // Interleave both teams sorted by V desc (mirrors actual execution order)
    const ap   = (bs.playerUnits ?? []).filter(u =>  u.isAlive).sort((a,b) => b.stats.V - a.stats.V);
    const ak   = (bs.kingUnits   ?? []).filter(u =>  u.isAlive).sort((a,b) => b.stats.V - a.stats.V);
    const dead = [...(bs.playerUnits ?? []), ...(bs.kingUnits ?? [])].filter(u => !u.isAlive);
    const order = [];
    for (let i = 0; i < Math.max(ap.length, ak.length); i++) {
      if (i < ap.length) order.push(ap[i]);
      if (i < ak.length) order.push(ak[i]);
    }
    order.push(...dead);

    const rows = [];
    for (const u of order) {
      const hpPct = Math.max(0, u.hp / u.maxHp * 100);
      const hpCol = hpPct > 50 ? '#3c3' : hpPct > 25 ? '#fc0' : '#f44';
      const dead  = u.isAlive ? '' : ' king-unit-dead';
      const hasMv = bs.queuedMoves?.[u.uid] ? ' king-unit-hasMove' : '';
      rows.push(
        `<div class="king-unit-row${dead}${hasMv}">` +
        `<span class="king-unit-team" style="color:${u.team==='player'?'#2a9':'#c33'}">${u.name[0]}</span>` +
        `<span class="king-unit-name">${u.name}</span>` +
        `<span class="king-unit-wpn">[${u.weapon}]</span>` +
        `<div class="king-unit-hpbar"><div class="king-unit-hpfill" style="width:${hpPct.toFixed(0)}%;background:${hpCol}"></div></div>` +
        `<span class="king-unit-hp">${u.hp.toFixed(1)}</span>` +
        `</div>`
      );
    }
    unitList.innerHTML = rows.join('');
  }

  function renderLog(bs) {
    const newLines = bs.log.slice(_logRenderedCount);
    if (!newLines.length) return;
    const html = newLines.map(l => {
      if (l.startsWith('──')) return `<span class="king-log-round">${l}</span>`;
      if (l.includes('falls'))  return `<span class="king-log-death">${l}</span>`;
      if (l.includes('miss'))   return `<span class="king-log-miss">${l}</span>`;
      if (l.includes('blocked')) return `<span class="king-log-miss">${l}</span>`;
      return `<span>${l}</span>`;
    }).join('');
    logEl.insertAdjacentHTML('afterbegin', html);
    _logRenderedCount = bs.log.length;
  }

  // ── Planning timer ────────────────────────────────────────────────────────
  function startPlanningTimer() {
    stopTimer();
    planSecondsLeft = fastMode ? PLAN_SECONDS_FAST : PLAN_SECONDS_NORMAL;
    updateTimerDisplay();
    planTimer = setInterval(() => {
      planSecondsLeft--;
      updateTimerDisplay();
      if (planSecondsLeft <= 0) onCommitPlanning();
    }, 1000);
  }

  function stopTimer() {
    if (planTimer) { clearInterval(planTimer); planTimer = null; }
  }

  function updateTimerDisplay() {
    if (!timerEl) return;
    timerEl.textContent = `${planSecondsLeft}s`;
    timerEl.style.color = planSecondsLeft <= 5 ? '#f44' : '#ffd700';
  }

  // ── Commit planning → execute ─────────────────────────────────────────────
  function onCommitPlanning() {
    stopTimer();
    const bs = KingBattle.getState();
    if (!bs || bs.phase !== 'planning') return;

    KingBattle.executeRound();
    const attacks = KingBattle.getLastRoundAttacks();
    KingRenderer.animateAttacks(attacks, () => {
      KingRenderer.draw();
      updateBattleUI();

      if (bs.phase === 'victory') { onVictory(); return; }
      if (bs.phase === 'defeat')  { onDefeat();  return; }

      startPlanningTimer();
    });
  }

  // ── Canvas interaction ────────────────────────────────────────────────────
  function onCanvasClick(e) {
    const bs = KingBattle.getState();
    if (!bs || bs.phase !== 'planning') return;

    KingRenderer.setHoverCell(null);
    _lastHoverKey = null;

    // Left-click always clears sector selection
    bs.selectedSectorId = null;

    const cell = KingRenderer.cellAt(e.offsetX, e.offsetY);
    if (!cell) return;
    if (KingBattle.OBSTACLES.has(`${cell.x},${cell.y}`)) return;

    const clickedUnit = (bs.playerUnits ?? []).find(
      u => u.isAlive && u.pos.x === cell.x && u.pos.y === cell.y
    );

    if (clickedUnit) {
      bs.selectedUid = bs.selectedUid === clickedUnit.uid ? null : clickedUnit.uid;
      updateBattleUI();
      KingRenderer.draw();
      return;
    }

    if (bs.selectedUid) {
      const ok = KingBattle.planMove(bs.selectedUid, cell.x, cell.y);
      if (ok) bs.selectedUid = null;
      updateBattleUI();
      KingRenderer.draw();
    }
  }

  function onCanvasRightClick(e) {
    e.preventDefault();
    const bs = KingBattle.getState();
    if (!bs || bs.phase !== 'planning') return;

    KingRenderer.setHoverCell(null);
    _lastHoverKey = null;

    const cell = KingRenderer.cellAt(e.offsetX, e.offsetY);
    if (!cell || KingBattle.OBSTACLES.has(`${cell.x},${cell.y}`)) return;

    const sid = KingBattle.sectorOf(cell.x, cell.y);
    if (sid === -1) return;

    if (bs.selectedSectorId == null) {
      // Select sector if the player has units there
      const hasUnits = (bs.playerUnits ?? []).some(u => u.isAlive && u.sectorId === sid);
      if (hasUnits) {
        bs.selectedSectorId = sid;
        bs.selectedUid = null; // clear single-unit selection
      }
    } else if (sid === bs.selectedSectorId) {
      // Right-click same sector → cancel
      bs.selectedSectorId = null;
    } else {
      // Attempt group move; clear selection regardless of success
      KingBattle.planSectorMove(bs.selectedSectorId, sid);
      bs.selectedSectorId = null;
      bs.selectedUid = null;
    }

    updateBattleUI();
    KingRenderer.draw();
  }

  function onCanvasHover(e) {
    const bs = KingBattle.getState();
    if (!bs || !sectorInfoEl) return;
    const cell = KingRenderer.cellAt(e.offsetX, e.offsetY);
    if (!cell) { sectorInfoEl.textContent = ''; _setHoverCell(null); return; }
    if (KingBattle.OBSTACLES.has(`${cell.x},${cell.y}`)) {
      sectorInfoEl.textContent = 'Obstacle';
      _setHoverCell(null);
      return;
    }
    const sid = KingBattle.sectorOf(cell.x, cell.y);
    const sec = KingBattle.SECTORS[sid];
    if (!sec) { sectorInfoEl.textContent = ''; _setHoverCell(null); return; }
    const bonus = sec.bonus ? ` (+${sec.bonus.value} ${sec.bonus.type === 'atk' ? 'ATK' : 'DEF'})` : '';
    const ctrl = KingBattle.sectorEnemyPresent('player', sid) ? ' [ENEMY]'
               : KingBattle.sectorEnemyPresent('king', sid)   ? ' [YOURS]' : '';
    sectorInfoEl.textContent = sec.name + bonus + ctrl;

    // LoS shadow: show visibility from this cell only if it's a reachable move target
    if (bs.phase === 'planning' && bs.selectedUid) {
      const sel = (bs.playerUnits ?? []).find(u => u.uid === bs.selectedUid);
      if (sel) {
        const reachable = KingBattle.reachableCellsFor(sel);
        const isReach = reachable.some(c => c.x === cell.x && c.y === cell.y);
        _setHoverCell(isReach ? cell : null);
        return;
      }
    }
    _setHoverCell(null);
  }

  // ── Outcome ───────────────────────────────────────────────────────────────
  function onVictory() {
    stopTimer();
    updateBattleUI();
    KingRenderer.draw();
    const bs = KingBattle.getState();
    setTimeout(() => {
      if (bs.isStandalone) {
        showStandaloneResult('Victory!', '#3c3');
      } else {
        hide();
        const cb = bs.onVictory;
        KingBattle.clearState();
        if (cb) cb();
      }
    }, 600);
  }

  function onDefeat() {
    stopTimer();
    updateBattleUI();
    KingRenderer.draw();
    const bs = KingBattle.getState();
    setTimeout(() => {
      if (bs.isStandalone) {
        showStandaloneResult('Defeated!', '#f44');
      } else {
        hide();
        const cb = bs.onDefeat;
        KingBattle.clearState();
        if (cb) cb();
      }
    }, 600);
  }

  function showStandaloneResult(text, color) {
    const resultDiv = _el('king-standalone-result');
    resultDiv.style.display = 'flex';
    _el('king-result-text').textContent = text;
    _el('king-result-text').style.color = color;
    renderBattleStats();
  }

  function renderBattleStats() {
    const statsEl = _el('king-battle-stats');
    if (!statsEl) return;
    const raw = KingBattle.getUnitStats();
    const units = Object.values(raw);
    if (!units.length) { statsEl.innerHTML = ''; return; }

    // Sort by damage descending for the "top" highlight
    const sorted = [...units].sort((a, b) => b.damage - a.damage);
    const topDmg = sorted[0];
    const topKills = [...units].sort((a, b) => b.kills - a.kills)[0];

    const teamLabel = t => t === 'player' ? '🟢' : '🔴';

    const rows = sorted.map(u => {
      const acc = u.hits + u.misses > 0
        ? Math.round(100 * u.hits / (u.hits + u.misses)) + '%'
        : '—';
      const highlight = u === topDmg ? ' class="king-stat-top"' : '';
      return `<tr${highlight}>
        <td>${teamLabel(u.team)} ${u.name}</td>
        <td>${u.hits}</td><td>${u.misses}</td>
        <td>${acc}</td>
        <td>${u.damage.toFixed(2)}</td>
        <td>${u.kills}</td>
      </tr>`;
    }).join('');

    statsEl.innerHTML = `
      <div class="king-stat-notes">
        Most damage: <strong>${topDmg.name}</strong> (${topDmg.damage.toFixed(2)}) &nbsp;|&nbsp;
        Most kills: <strong>${topKills.name}</strong> (${topKills.kills})
      </div>
      <table class="king-stat-table">
        <thead><tr>
          <th>Unit</th><th>Hits</th><th>Misses</th><th>Acc</th><th>Damage</th><th>Kills</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ── Standalone mode ───────────────────────────────────────────────────────
  function startStandalone() {
    _el('king-standalone-result').style.display = 'none';
    KingBattle.initStandalone(result => {
      // handled by onVictory/onDefeat → showStandaloneResult
    });
    show();
  }

  function _el(id) { return document.getElementById(id); }

  return { init, show, hide, startStandalone };
})();
