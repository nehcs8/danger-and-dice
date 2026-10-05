// SpectateStats — metrics tracking and canvas chart rendering for all players (bots and humans).
// Always activated from main.js; speed controls revealed only in all-bot spectate mode.

const SpectateStats = (() => {

  const COLORS  = ['#ff6b6b', '#6bcbff', '#6bff6b', '#ffcb6b'];
  const METRICS = [
    { key: 'coins',     label: 'Coins' },
    { key: 'kills',     label: 'Kills (cumulative)' },
    { key: 'statSum',   label: 'Total Stats  (F+D+A+M+C+V)' },
    { key: 'items',     label: 'Items Held (inventory + equipped)' },
    { key: 'wealth',    label: 'Wealth Generated (coins + loot value)' },
    { key: 'hp',        label: 'HP (hearts at turn start)' },
  ];

  // Consumable categories — order determines pie-chart segment order
  const CONSUMABLE_CATS = [
    { key: 'stat_F',        label: 'Stat F',          color: '#ff6b6b' },
    { key: 'stat_D',        label: 'Stat D',          color: '#ffcb6b' },
    { key: 'stat_A',        label: 'Stat A',          color: '#aaaaaa' },
    { key: 'stat_M',        label: 'Stat M',          color: '#6bcbff' },
    { key: 'stat_C',        label: 'Stat C',          color: '#c87bff' },
    { key: 'stat_V',        label: 'Stat V',          color: '#6bff6b' },
    { key: 'heal',          label: 'Healing',         color: '#ff88aa' },
    { key: 'blessing',      label: 'Holy Blessing',   color: '#ffe066' },
    { key: 'alcohol',       label: 'Alcohol',         color: '#c8853a' },
    { key: 'blood',         label: 'Bloods / Drops',  color: '#8b1a1a' },
    { key: 'invisibility',  label: 'Invisibility',    color: '#d0c0ff' },
    { key: 'attack_spell',  label: 'Attack Spells',   color: '#ff9944' },
    { key: 'defense_spell', label: 'Defense Spells',  color: '#44aaff' },
    { key: 'utility_spell', label: 'Utility Spells',  color: '#44ddcc' },
    { key: 'object',        label: 'Objects',         color: '#88aa44' },
  ];

  const STAT_KEYS  = ['F','D','A','M','C','V'];
  const SKILL_KEYS = ['F','D','A','M','C','V'];
  const ZONE_KEYS  = [0, 1, 2, 3];

  let active  = false;
  let msDelay = 600;
  let players = [];

  const kills             = {};   // playerId → cumulative kill count
  const pturn             = {};   // playerId → that player's own turn count (for X axis)
  const series            = {};   // playerId → { turns, coins, kills, statSum, hp, items, wealth }
  const milestones        = {};   // playerId → [{ turn, label }]
  const statFlags         = {};   // playerId → { allSix, any8 }
  const bestTier          = {};   // playerId → highest item tier equipped so far
  const guildLevelSix     = {};   // playerId → [{ turn, itemName, stat, guild }]
  const guildLevelSixSeen = {};   // playerId → Set<stat> already flagged
  const chestsOpened      = {};   // playerId → { total, empty }
  const wealthGen         = {};   // playerId → cumulative wealth (coins + sell value of loot)
  const killsByZone       = {};   // playerId → { 0, 1, 2, 3 }
  const lootByZone        = {};   // playerId → { 0, 1, 2, 3 }
  const skillUsage        = {};   // playerId → { F, D, A, M, C, V }
  const consumableUsage   = {};   // playerId → { itemId: count }

  // ── Initialise ─────────────────────────────────────────────────────────────
  function init(playerList) {
    active  = true;
    players = playerList;

    playerList.forEach(p => {
      kills[p.id]             = 0;
      pturn[p.id]             = 0;
      series[p.id]            = { turns:[], coins:[], kills:[], statSum:[], hp:[], items:[], wealth:[] };
      milestones[p.id]        = [];
      statFlags[p.id]         = { allSix: false, any8: false };
      bestTier[p.id]          = 0;
      guildLevelSix[p.id]     = [];
      guildLevelSixSeen[p.id] = new Set();
      chestsOpened[p.id]      = { total: 0, empty: 0 };
      wealthGen[p.id]         = 0;
      killsByZone[p.id]       = { 0: 0, 1: 0, 2: 0, 3: 0 };
      lootByZone[p.id]        = { 0: 0, 1: 0, 2: 0, 3: 0 };
      skillUsage[p.id]        = { F: 0, D: 0, A: 0, M: 0, C: 0, V: 0 };
      consumableUsage[p.id]   = {};
    });

    // Count kills, loot, wealth by zone + milestones
    Game.on('combat_victory', ev => {
      const p = players.find(q => q.name === ev.player);
      if (!p) return;
      kills[p.id]++;
      const turn = pturn[p.id];
      if (ev.mob === 'Dragon') {
        addMilestone(p.id, turn, 'Defeated the Dragon');
      } else if (MOBS.list.find(m => m.name === ev.mob)?.isBoss) {
        addMilestone(p.id, turn, `Defeated ${ev.mob}`);
      } else if (players.some(q => q.name === ev.mob)) {
        addMilestone(p.id, turn, `Eliminated ${ev.mob}`);
      }
      // Zone tracking (use mapZone for animals, mobTier otherwise)
      const zone = (ev.isAnimal ? (ev.mapZone ?? 0) : (ev.mobTier ?? 0));
      const zk = zone in killsByZone[p.id] ? zone : 0;
      killsByZone[p.id][zk]++;
      const lootVal = (ev.loot?.coins ?? 0) +
        (ev.loot?.items ?? []).reduce((s, id) => s + (sellPrice(getItem(id)) ?? 0), 0);
      lootByZone[p.id][zk] = (lootByZone[p.id][zk] ?? 0) + lootVal;
      wealthGen[p.id] += lootVal;
    });

    // Track best item equipped + guild weapon mastery
    Game.on('item_equipped', ev => {
      const p = players.find(q => q.name === ev.player);
      if (!p) return;
      const tier = ev.item?.tier ?? 0;
      if (tier >= 5 && tier > bestTier[p.id]) {
        bestTier[p.id] = tier;
        addMilestone(p.id, pturn[p.id], `Equipped ${ev.item.name} (Tier ${tier})`);
      }
      checkGuildLevelSix(ev.player);
    });

    // Chest tracking + wealth
    Game.on('chest_opened', ev => {
      const p = players.find(q => q.name === ev.player);
      if (!p) return;
      chestsOpened[p.id].total++;
      if (ev.isEmpty) chestsOpened[p.id].empty++;
      const w = (ev.coins ?? 0) + (ev.itemId ? (sellPrice(getItem(ev.itemId)) ?? 0) : 0);
      wealthGen[p.id] += w;
    });

    // Skill usage (attack and defense rolls in combat)
    Game.on('combat_update', ev => {
      if (!ev.skillUsed) return;
      const p = players.find(q => q.name === ev.player);
      if (!p || !skillUsage[p.id]) return;
      if (ev.skillUsed in skillUsage[p.id]) skillUsage[p.id][ev.skillUsed]++;
    });

    // Consumable usage
    Game.on('item_used', ev => {
      const p = players.find(q => q.name === ev.player);
      if (!p || !ev.item?.id) return;
      if (getConsumableCategory(ev.item) === null) return;
      const cu = consumableUsage[p.id];
      cu[ev.item.id] = (cu[ev.item.id] ?? 0) + 1;
    });

    // Stat upgrade may push a guild weapon stat to 6
    Game.on('skill_upgraded', ev => {
      checkGuildLevelSix(ev.player);
    });

    // Guild item level-up happens on combat victory
    Game.on('combat_victory', ev => {
      checkGuildLevelSix(ev.player);
    });

    // Snapshot each player's state at the start of their movement roll (for charts)
    Game.on('state_change', ev => {
      if (ev.phase !== Game.Phase.ROLL_MOVE) return;
      const st = Game.getState();
      const pl = st.players[st.currentIdx];
      if (pl) record(pl);
    });
  }

  function addMilestone(playerId, turn, label) {
    if (!milestones[playerId]) return;
    milestones[playerId].push({ turn, label });
  }

  function record(player) {
    const s = series[player.id];
    if (!s) return;
    pturn[player.id]++;
    const bs = player.baseStats;
    s.turns.push(pturn[player.id]);
    s.coins.push(player.coins);
    s.kills.push(kills[player.id]);
    s.statSum.push(STAT_KEYS.reduce((sum, k) => sum + (bs[k] ?? 0), 0));
    s.hp.push(player.hearts.current);
    s.items.push(
      player.inventory.length +
      Object.values(player.equipped).filter(Boolean).length
    );
    s.wealth.push(wealthGen[player.id] ?? 0);

    // Stat milestones
    const sf = statFlags[player.id];
    if (sf) {
      if (!sf.allSix && STAT_KEYS.every(k => (bs[k] ?? 0) >= 6)) {
        sf.allSix = true;
        addMilestone(player.id, pturn[player.id], 'All base stats at 6');
      }
      if (!sf.any8) {
        const stat8 = STAT_KEYS.find(k => (bs[k] ?? 0) >= 8);
        if (stat8) {
          sf.any8 = true;
          addMilestone(player.id, pturn[player.id], `Stat ${stat8} reached 8`);
        }
      }
    }
  }

  // ── Guild weapon level-6 tracking ───────────────────────────────────────────
  function checkGuildLevelSix(playerName) {
    const p = players.find(q => q.name === playerName);
    if (!p) return;
    const seen = guildLevelSixSeen[p.id];
    if (!seen) return;

    const st = Game.getState();
    const playerObj = st.players.find(q => q.name === playerName);
    if (!playerObj) return;

    for (const slot of Object.keys(playerObj.equipped)) {
      const item = playerObj.equipped[slot];
      if (!item?.guild) continue;

      const stat = Object.keys(item.statBonus ?? {})[0];
      if (!stat || seen.has(item.id)) continue;

      const lvlData = playerObj.guildItemLevels[item.id];
      if ((lvlData?.itemLevel ?? 1) >= 6) {
        seen.add(item.id);
        const turn = pturn[p.id];
        guildLevelSix[p.id].push({ turn, itemName: item.name, stat, guild: item.guild });
        addMilestone(p.id, turn, `Guild mastery: ${item.name} — reached Lv.6`);
      }
    }
  }

  // ── Run summary (for saving) ─────────────────────────────────────────────────
  function getRunSummary() {
    const st = Game.getState();
    const result = {
      date: new Date().toISOString(),
      totalGameTurns: st.turnNumber ?? 0,
      players: {},
    };

    players.forEach(p => {
      const playerObj = st.players.find(q => q.name === p.name);
      result.players[p.name] = {
        isBot: p.isBot ?? false,
        totalTurns: pturn[p.id] ?? 0,
        kills: kills[p.id] ?? 0,
        killsByZone: { ...(killsByZone[p.id] ?? {}) },
        lootByZone: { ...(lootByZone[p.id] ?? {}) },
        chestsOpened: { ...(chestsOpened[p.id] ?? { total: 0, empty: 0 }) },
        totalWealth: wealthGen[p.id] ?? 0,
        skillUsage: { ...(skillUsage[p.id] ?? {}) },
        consumableUsage: { ...(consumableUsage[p.id] ?? {}) },
        finalStats: playerObj ? { ...playerObj.baseStats } : {},
        milestones: (milestones[p.id] ?? []).slice(),
        guildLevelSix: (guildLevelSix[p.id] ?? []).slice(),
        series: series[p.id]
          ? {
              turns:   series[p.id].turns.slice(),
              coins:   series[p.id].coins.slice(),
              kills:   series[p.id].kills.slice(),
              statSum: series[p.id].statSum.slice(),
              hp:      series[p.id].hp.slice(),
              items:   series[p.id].items.slice(),
              wealth:  series[p.id].wealth.slice(),
            }
          : null,
      };
    });

    return result;
  }

  // ── Speed control ───────────────────────────────────────────────────────────
  function setSpeed(ms) {
    msDelay = ms;
    document.querySelectorAll('.speed-btn').forEach(b =>
      b.classList.toggle('speed-active', +b.dataset.delay === ms)
    );
  }

  function getDelay() { return msDelay; }
  function isActive()  { return active; }

  // ── Stats modal ─────────────────────────────────────────────────────────────
  function openStatsModal() {
    renderCharts();
    document.getElementById('spectate-overlay').classList.remove('hidden');
  }

  function closeStatsModal() {
    document.getElementById('spectate-overlay').classList.add('hidden');
  }

  // ── Chart rendering ─────────────────────────────────────────────────────────
  function renderCharts() {
    const container = document.getElementById('spectate-charts');
    container.innerHTML = '';

    METRICS.forEach(m => {
      const wrap = document.createElement('div');
      wrap.className = 'spectate-chart-wrap';

      const title = document.createElement('div');
      title.className = 'spectate-chart-title';
      title.textContent = m.label;
      wrap.appendChild(title);

      const canvas = document.createElement('canvas');
      canvas.width  = 580;
      canvas.height = 160;
      wrap.appendChild(canvas);
      container.appendChild(wrap);
      drawChart(canvas, m.key);
    });

    // Player colour legend
    document.getElementById('spectate-legend').innerHTML =
      players.map((p, i) =>
        `<span class="spectate-legend-item" style="color:${COLORS[i % COLORS.length]}">■ ${p.name}</span>`
      ).join('');

    // Consumable pie charts — one per player in a horizontal row
    const pieTitle = document.createElement('div');
    pieTitle.className = 'spectate-chart-title';
    pieTitle.textContent = 'Consumables Used';
    container.appendChild(pieTitle);

    const pieRow = document.createElement('div');
    pieRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;';
    players.forEach((p, i) => {
      const pieH   = 200 + Math.ceil(CONSUMABLE_CATS.filter(c =>
        (aggregateConsumables(p.id)[c.key] ?? 0) > 0).length / 2) * 13;
      const canvas = document.createElement('canvas');
      canvas.width  = 240;
      canvas.height = Math.max(220, pieH);
      pieRow.appendChild(canvas);
      drawPieChart(canvas, p.id, p.name, COLORS[i % COLORS.length]);
    });
    container.appendChild(pieRow);
  }

  function drawChart(canvas, key) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const P = { t: 12, r: 14, b: 28, l: 38 };
    const PW = W - P.l - P.r;
    const PH = H - P.t  - P.b;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080d14';
    ctx.fillRect(0, 0, W, H);

    // Determine axis range
    let maxX = 1, maxY = 1;
    players.forEach(p => {
      const s = series[p.id];
      if (!s?.turns.length) return;
      maxX = Math.max(maxX, s.turns[s.turns.length - 1]);
      s[key].forEach(v => { if (v > maxY) maxY = v; });
    });
    maxY = Math.ceil(maxY * 1.05) || 1; // small headroom

    const toX = t => P.l + (t / maxX) * PW;
    const toY = v => P.t + PH - (v / maxY) * PH;

    // Horizontal grid lines + Y labels
    ctx.font      = '9px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = P.t + (i / 4) * PH;
      ctx.strokeStyle = '#1a2035';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(W - P.r, y); ctx.stroke();
      ctx.fillStyle = '#4a5570';
      ctx.fillText(Math.round(maxY * (1 - i / 4)), P.l - 3, y + 3);
    }

    // X tick labels
    ctx.textAlign = 'center';
    ctx.fillStyle = '#3a4560';
    for (let i = 0; i <= 5; i++) {
      const t = Math.round((i / 5) * maxX);
      ctx.fillText(t, toX(t), H - P.b + 11);
    }
    ctx.fillStyle = '#2a3550';
    ctx.fillText('player turns', P.l + PW / 2, H - 2);

    // Axes
    ctx.strokeStyle = '#2a3050';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(P.l, P.t); ctx.lineTo(P.l, H - P.b);
    ctx.lineTo(W - P.r,  H - P.b);
    ctx.stroke();

    // One line per player
    players.forEach((p, i) => {
      const s = series[p.id];
      if (!s?.turns.length) return;
      const xs = s.turns;
      const ys = s[key];

      ctx.strokeStyle = COLORS[i % COLORS.length];
      ctx.lineWidth   = 2;
      ctx.lineJoin    = 'round';
      ctx.beginPath();
      xs.forEach((t, j) => {
        const x = toX(t), y = toY(ys[j] ?? 0);
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Dot at current value
      const lx = toX(xs[xs.length - 1]);
      const ly = toY(ys[ys.length - 1] ?? 0);
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
    });
  }

  // ── Consumable categorisation ────────────────────────────────────────────────
  function getConsumableCategory(item) {
    if (!item?.id) return null;
    const id = item.id;
    const statM = id.match(/^pot_([FDAMCV])\d+$/);
    if (statM) return 'stat_' + statM[1];
    if (id === 'pot_heal')                            return 'heal';
    if (id === 'pot_invis' || id === 'sp_invisibility') return 'invisibility';
    if (id.startsWith('priest_pot_'))                 return 'blessing';
    if (id.startsWith('alcohol_'))                    return 'alcohol';
    if (['werewolf_blood','dragon_blood','vampire_blood','dragon_scales',
         'witch_powder','meat','fur','fairy_dust','harpy_feathers',
         'ivory','troll_tooth'].includes(id))          return 'blood';
    if (['bang','fireball','flare','blaze','blizzard','freeze','discharge',
         'lightning','bolt','explosion','bomb','destruction','slash',
         'laceration','rend'].includes(id))            return 'attack_spell';
    if (id.startsWith('protection_'))                 return 'defense_spell';
    if (['sp_smoke','sp_transmutation','sp_teleport',
         'sp_curse','sp_disenchant'].includes(id))     return 'utility_spell';
    if (['rope','map','trap','key'].includes(id))      return 'object';
    return null;
  }

  // Returns { catKey → total } aggregated from consumableUsage[playerId]
  function aggregateConsumables(playerId) {
    const cu = consumableUsage[playerId] ?? {};
    const totals = {};
    for (const [id, count] of Object.entries(cu)) {
      const cat = getConsumableCategory(getItem(id));
      if (!cat) continue;
      totals[cat] = (totals[cat] ?? 0) + count;
    }
    return totals;
  }

  // Formats the per-item detail for a player as grouped text lines.
  // Returns an array of strings, one per non-empty category.
  function consumableDetailLines(playerId) {
    const cu = consumableUsage[playerId] ?? {};
    // Group by category
    const grouped = {};
    for (const [id, count] of Object.entries(cu)) {
      const cat = getConsumableCategory(getItem(id));
      if (!cat) continue;
      (grouped[cat] = grouped[cat] ?? []).push({ id, count });
    }
    return CONSUMABLE_CATS
      .filter(c => grouped[c.key]?.length)
      .map(c => {
        const parts = grouped[c.key]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, count }) => `${getItem(id)?.name ?? id}×${count}`)
          .join(', ');
        return `${c.label}: ${parts}`;
      });
  }

  function drawPieChart(canvas, playerId, playerName, playerColor) {
    const totals = aggregateConsumables(playerId);
    const cats   = CONSUMABLE_CATS.filter(c => (totals[c.key] ?? 0) > 0);
    const total  = cats.reduce((s, c) => s + totals[c.key], 0);

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#080d14';
    ctx.fillRect(0, 0, W, H);

    // Title
    ctx.font      = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = playerColor ?? '#cccccc';
    ctx.fillText(playerName ?? '', W / 2, 14);

    if (total === 0) {
      ctx.fillStyle = '#4a5570';
      ctx.fillText('No consumables used', W / 2, H / 2 + 20);
      return;
    }

    const cx = W / 2, cy = 110, r = 80;
    let angle = -Math.PI / 2;

    cats.forEach(c => {
      const slice = (totals[c.key] / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.strokeStyle = '#080d14';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      angle += slice;
    });

    // Centre hole (donut)
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = '#080d14';
    ctx.fill();

    // Total label in hole
    ctx.font      = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8899aa';
    ctx.fillText(`${total}`, cx, cy + 4);

    // Legend (2 columns)
    const legY0 = cy + r + 10;
    const colW  = W / 2;
    ctx.font      = '9px monospace';
    ctx.textAlign = 'left';
    cats.forEach((c, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const lx  = 8 + col * colW;
      const ly  = legY0 + row * 13;
      ctx.fillStyle = c.color;
      ctx.fillRect(lx, ly - 7, 8, 8);
      ctx.fillStyle = '#8899aa';
      ctx.fillText(`${c.label} (${totals[c.key]})`, lx + 11, ly);
    });
  }

  // ── Game-over recap ─────────────────────────────────────────────────────────
  function renderRecap(winnerName) {
    const wrap = document.createElement('div');
    wrap.className = 'recap-wrap';

    // ── Milestone timeline ─────────────────────────────────────────────────
    const winner = players.find(p => p.name === winnerName);
    if (winner) {
      const ms = [
        ...(milestones[winner.id] ?? []),
        { turn: pturn[winner.id] ?? '?', label: 'Reached the Finish!' },
      ];

      const msSection = document.createElement('div');
      msSection.className = 'recap-milestones';

      const msTitle = document.createElement('div');
      msTitle.className = 'recap-section-title';
      msTitle.textContent = `${winnerName}'s Journey`;
      msSection.appendChild(msTitle);

      if (ms.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'recap-empty';
        empty.textContent = 'No milestones recorded.';
        msSection.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'milestone-list';
        ms.forEach(m => {
          const item = document.createElement('div');
          item.className = 'milestone-item';
          item.innerHTML =
            `<span class="milestone-turn">Turn\u00a0${m.turn}</span>` +
            `<span class="milestone-label">${m.label}</span>`;
          list.appendChild(item);
        });
        msSection.appendChild(list);
      }
      wrap.appendChild(msSection);
    }

    // ── Per-player stats table ─────────────────────────────────────────────
    const statsSection = document.createElement('div');
    statsSection.className = 'recap-stats-section';

    const statsTitle = document.createElement('div');
    statsTitle.className = 'recap-section-title';
    statsTitle.textContent = 'End-Game Stats';
    statsSection.appendChild(statsTitle);

    players.forEach((p, i) => {
      const pid = p.id;
      const color = COLORS[i % COLORS.length];
      const block = document.createElement('div');
      block.className = 'recap-player-stats';

      const header = document.createElement('div');
      header.className = 'recap-player-header';
      header.style.color = color;
      header.textContent = p.name;
      block.appendChild(header);

      // Chests
      const ch = chestsOpened[pid] ?? { total: 0, empty: 0 };
      const chestLine = document.createElement('div');
      chestLine.className = 'recap-stat-line';
      chestLine.textContent = `Chests: ${ch.total} opened, ${ch.empty} empty`;
      block.appendChild(chestLine);

      // Total wealth
      const wLine = document.createElement('div');
      wLine.className = 'recap-stat-line';
      wLine.textContent = `Wealth generated: ${wealthGen[pid] ?? 0} g`;
      block.appendChild(wLine);

      // Kills by zone
      const kz = killsByZone[pid] ?? {};
      const lz = lootByZone[pid] ?? {};
      const zoneDiv = document.createElement('div');
      zoneDiv.className = 'recap-stat-line';
      const zoneParts = ZONE_KEYS.map(z => `T${z}: ${kz[z] ?? 0} kills (${lz[z] ?? 0}g loot)`);
      zoneDiv.textContent = 'By zone — ' + zoneParts.join(' | ');
      block.appendChild(zoneDiv);

      // Skill usage
      const su = skillUsage[pid] ?? {};
      const skillDiv = document.createElement('div');
      skillDiv.className = 'recap-stat-line';
      const skillParts = SKILL_KEYS.map(k => `${k}:${su[k] ?? 0}`);
      skillDiv.textContent = 'Skill rolls — ' + skillParts.join(' ');
      block.appendChild(skillDiv);

      // Consumable usage detail + pie chart
      const cuLines = consumableDetailLines(pid);
      if (cuLines.length) {
        const cuTitle = document.createElement('div');
        cuTitle.className = 'recap-stat-line';
        cuTitle.style.fontWeight = 'bold';
        cuTitle.style.marginTop  = '4px';
        cuTitle.textContent = 'Consumables used:';
        block.appendChild(cuTitle);
        cuLines.forEach(line => {
          const d = document.createElement('div');
          d.className   = 'recap-stat-line';
          d.style.paddingLeft = '8px';
          d.textContent = line;
          block.appendChild(d);
        });
      }

      const pieH   = 200 + Math.ceil(CONSUMABLE_CATS.filter(c =>
        (aggregateConsumables(pid)[c.key] ?? 0) > 0).length / 2) * 13;
      const pieCanvas = document.createElement('canvas');
      pieCanvas.width  = 240;
      pieCanvas.height = Math.max(220, pieH);
      pieCanvas.style.display = 'block';
      pieCanvas.style.marginTop = '6px';
      block.appendChild(pieCanvas);
      drawPieChart(pieCanvas, pid, p.name, color);

      statsSection.appendChild(block);
    });
    wrap.appendChild(statsSection);

    // ── Charts ────────────────────────────────────────────────────────────
    const chartsSection = document.createElement('div');
    chartsSection.className = 'recap-charts';

    const recapTitle = document.createElement('div');
    recapTitle.className = 'recap-section-title';
    recapTitle.textContent = 'Game Statistics';
    chartsSection.appendChild(recapTitle);

    const legend = document.createElement('div');
    legend.className = 'spectate-legend';
    legend.innerHTML = players.map((p, i) =>
      `<span class="spectate-legend-item" style="color:${COLORS[i % COLORS.length]}">■ ${p.name}</span>`
    ).join('');
    chartsSection.appendChild(legend);

    METRICS.forEach(m => {
      const chartWrap = document.createElement('div');
      chartWrap.className = 'spectate-chart-wrap';
      const title = document.createElement('div');
      title.className = 'spectate-chart-title';
      title.textContent = m.label;
      chartWrap.appendChild(title);
      const canvas = document.createElement('canvas');
      canvas.width  = 520;
      canvas.height = 140;
      chartWrap.appendChild(canvas);
      chartsSection.appendChild(chartWrap);
      drawChart(canvas, m.key);
    });

    wrap.appendChild(chartsSection);
    return wrap;
  }

  return { init, openStatsModal, closeStatsModal, setSpeed, getDelay, isActive, renderRecap, getRunSummary };
})();
