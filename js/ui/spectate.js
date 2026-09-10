// SpectateStats — metrics tracking and canvas chart rendering for all players (bots and humans).
// Always activated from main.js; speed controls revealed only in all-bot spectate mode.

const SpectateStats = (() => {

  const COLORS  = ['#ff6b6b', '#6bcbff', '#6bff6b', '#ffcb6b'];
  const METRICS = [
    { key: 'coins',     label: 'Coins' },
    { key: 'kills',     label: 'Kills (cumulative)' },
    { key: 'statSum',   label: 'Total Stats  (F+D+A+M+C+V)' },
    { key: 'items',     label: 'Items Held (inventory + equipped)' },
  ];

  const STAT_KEYS = ['F','D','A','M','C','V'];

  let active  = false;
  let msDelay = 600;
  let players = [];

  const kills            = {};   // playerId → cumulative kill count
  const pturn            = {};   // playerId → that player's own turn count (for X axis)
  const series           = {};   // playerId → { turns, coins, kills, statSum, maxHearts, items }
  const milestones       = {};   // playerId → [{ turn, label }]
  const statFlags        = {};   // playerId → { allSix, any8 }
  const bestTier         = {};   // playerId → highest item tier equipped so far
  const guildLevelSix    = {};   // playerId → [{ turn, itemName, stat, guild }]
  const guildLevelSixSeen = {};  // playerId → Set<stat> already flagged

  // ── Initialise ─────────────────────────────────────────────────────────────
  function init(playerList) {
    active  = true;
    players = playerList;

    playerList.forEach(p => {
      kills[p.id]             = 0;
      pturn[p.id]             = 0;
      series[p.id]            = { turns:[], coins:[], kills:[], statSum:[], maxHearts:[], items:[] };
      milestones[p.id]        = [];
      statFlags[p.id]         = { allSix: false, any8: false };
      bestTier[p.id]          = 0;
      guildLevelSix[p.id]     = [];
      guildLevelSixSeen[p.id] = new Set();
    });

    // Count kills and track milestones
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

    // Stat upgrade may push a guild weapon stat to 6
    Game.on('skill_upgraded', ev => {
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
    s.maxHearts.push(player.hearts.max);
    s.items.push(
      player.inventory.length +
      Object.values(player.equipped).filter(Boolean).length
    );

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
      if (!stat || seen.has(stat)) continue;

      if (playerObj.getStat(stat) >= 6) {
        seen.add(stat);
        const turn = pturn[p.id];
        guildLevelSix[p.id].push({ turn, itemName: item.name, stat, guild: item.guild });
        addMilestone(p.id, turn, `Guild mastery: ${item.name} — ${stat} reached 6`);
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
        finalStats: playerObj ? { ...playerObj.baseStats } : {},
        milestones: (milestones[p.id] ?? []).slice(),
        guildLevelSix: (guildLevelSix[p.id] ?? []).slice(),
        series: series[p.id]
          ? {
              turns:     series[p.id].turns.slice(),
              coins:     series[p.id].coins.slice(),
              kills:     series[p.id].kills.slice(),
              statSum:   series[p.id].statSum.slice(),
              maxHearts: series[p.id].maxHearts.slice(),
              items:     series[p.id].items.slice(),
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
