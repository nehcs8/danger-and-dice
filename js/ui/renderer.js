// Canvas renderer — draws the map grid and player tokens.
// Tile size is configurable; default 16px suits the 40×48 grid.

const Renderer = (() => {
  const TILE  = 16; // px per tile
  const PAD   = 0;

  // Miniboss tile color by tier (0–3): blue, green, yellow, red
  const MINIBOSS_COLORS = ['#66aaff', '#66cc66', '#ffee00', '#cc4444'];

  const TILE_COLORS = {
    [0]:  null,          // BLOCKED — not drawn
    [1]:  '#e8dcc8',     // PATH
    [2]:  '#b8b2a4',     // RANDOM_EVENT ?
    [3]:  '#f09030',     // MINIBOSS (overridden per-tile below)
    [4]:  '#a89880',     // CHEST
    [5]:  '#7ec8e3',     // REROLL
    [6]:  '#6abf69',     // WORK
    [7]:  '#b4b4b4',     // STOP
    [8]:  '#b0a8a0',     // BACK
    [9]:  '#c07ed0',     // PRIEST
    [10]: '#4a90d9',     // SHOP
    [11]: '#7b2fa0',     // MASTER
    [12]: '#ff7733',     // FIRE
    [13]: '#800000',     // BOSS
    [14]: '#303030',     // GUILD_ASSASSIN
    [15]: '#303030',     // GUILD_THIEF
    [16]: '#ffd700',     // FINISH
    [17]: '#44bb44',     // START
    [18]: '#d4a0c0',     // BAR
    [19]: '#556677',     // SECRET_PATH
  };

  const TILE_LABELS = {
    [2]:  '?',  [3]:  '!',  [4]:  '🎁',
    [5]:  '↺',  [6]:  '⚒', [7]:  '✋',
    [8]:  '←',  [9]:  '✝', [10]: '🏪',
    [11]: '⚗',  [12]: '🔥', [13]: '☠',
    [14]: '🗡', [15]: '🔓', [16]: '★',
    [17]: '⚑',  [18]: '🍺', [19]: '…',
  };

  const PLAYER_COLORS = ['#e63946','#457b9d','#2a9d8f','#e9c46a'];

  let canvas, ctx;
  let highlightedTiles = null; // Map<"x,y", steps>

  function init(canvasEl) {
    canvas = canvasEl;
    canvas.width  = MapGrid.WIDTH  * TILE + PAD * 2;
    canvas.height = MapGrid.HEIGHT * TILE + PAD * 2;
    ctx = canvas.getContext('2d');
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const grid    = MapGrid.getGrid();
    const players = Game.getPlayers();
    const state   = Game.getState();
    highlightedTiles = state.reachableTiles;

    // ── Background fill ────────────────────────────────────────────────────
    ctx.fillStyle = '#12121f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ── Tiles ──────────────────────────────────────────────────────────────
    for (let y = 0; y < MapGrid.HEIGHT; y++) {
      for (let x = 0; x < MapGrid.WIDTH; x++) {
        const tType = grid[y][x];
        let color = TILE_COLORS[tType];

        // Miniboss: color by tier from tileData
        if (tType === TileType.MINIBOSS) {
          const tier = MapGrid.getTileData(x, y).minibossTier ?? 0;
          color = MINIBOSS_COLORS[Math.min(tier, 3)];
        }

        const px = PAD + x * TILE;
        const py = PAD + y * TILE;

        if (!color) {
          // Blocked — draw a faint grid cell so the whole board is visible
          ctx.fillStyle = '#1c1c2e';
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = 'rgba(255,255,255,0.04)';
          ctx.lineWidth = 0.5;
          ctx.strokeRect(px, py, TILE, TILE);
          continue;
        }

        // Highlight reachable tiles (orange = passes a STOP tile, violet = needs Invisibility Potions)
        if (highlightedTiles?.has(`${x},${y}`)) {
          ctx.fillStyle = highlightedTiles.potionOnly?.has(`${x},${y}`) ? '#c9a0ff'
            : state.stopBlockedTiles?.has(`${x},${y}`) ? '#ffaa44' : '#aaff88';
        } else {
          ctx.fillStyle = color;
        }
        ctx.fillRect(px, py, TILE, TILE);

        // Tile border
        ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        ctx.lineWidth   = 0.5;
        ctx.strokeRect(px, py, TILE, TILE);

        // Tile label (small icon/text for special tiles)
        const label = TILE_LABELS[tType];
        if (label && TILE >= 14) {
          ctx.font      = `${Math.floor(TILE * 0.6)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.fillText(label, px + TILE / 2, py + TILE / 2);
        }
      }
    }

    // ── Princess ───────────────────────────────────────────────────────────
    const princess = state.princess;
    if (princess.x !== null && !princess.carriedBy) {
      drawToken(princess.x, princess.y, '👸', '#fff0d0');
    }

    // ── Last-turn trails (each player's path in their colour; current player on top) ──
    const cur = Game.getCurrentPlayer();
    const paths = typeof Activity !== 'undefined' ? Activity.lastPaths() : {};
    const order = players.filter(p => p !== cur).concat(cur ? [cur] : []);
    for (const p of order) {
      const segs = paths[p.id]; if (!segs || !p.isAlive) continue;
      const col = PLAYER_COLORS[players.indexOf(p)];
      const mine = p === cur;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const seg of segs) {
        if (seg.length < 2) continue;
        const jump = seg.length === 2 && Math.abs(seg[0].x - seg[1].x) + Math.abs(seg[0].y - seg[1].y) > 1;
        ctx.setLineDash(jump ? [4, 4] : []);
        // dark underlay for contrast, then the colour
        for (const [w, c, a] of [[mine ? 6 : 5, '#000', 0.45], [mine ? 3.5 : 2.5, col, mine ? 0.95 : 0.7]]) {
          ctx.globalAlpha = a; ctx.strokeStyle = c; ctx.lineWidth = w;
          ctx.beginPath();
          seg.forEach((t, k) => { const cx = PAD + t.x * TILE + TILE / 2, cy = PAD + t.y * TILE + TILE / 2; k ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
          ctx.stroke();
        }
        // start marker
        const s0 = seg[0];
        ctx.setLineDash([]); ctx.globalAlpha = mine ? 0.95 : 0.7; ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(PAD + s0.x * TILE + TILE / 2, PAD + s0.y * TILE + TILE / 2, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    // ── Players (big outlined tokens; players sharing a tile are nudged apart) ──
    const byTile = {};
    players.forEach(p => { if (p.isAlive) (byTile[`${p.position.x},${p.position.y}`] ??= []).push(p); });
    tokenSpots = [];
    players.forEach((p, i) => {
      if (!p.isAlive) return;
      const group = byTile[`${p.position.x},${p.position.y}`];
      const k = group.indexOf(p), n = group.length;
      const off = n > 1 ? TILE * 0.32 : 0, ang = (k / n) * Math.PI * 2 - Math.PI / 2;
      const cx = PAD + p.position.x * TILE + TILE / 2 + Math.cos(ang) * off;
      const cy = PAD + p.position.y * TILE + TILE / 2 + Math.sin(ang) * off;
      const r = TILE * (n > 1 ? 0.5 : 0.62);
      tokenSpots.push({ p, cx, cy, r });

      if (p === cur) {                         // current player: gold halo + pointer
        ctx.fillStyle = 'rgba(255,215,0,0.35)';
        ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd700';
        ctx.beginPath(); ctx.moveTo(cx, cy - r - 2); ctx.lineTo(cx - 5, cy - r - 10); ctx.lineTo(cx + 5, cy - r - 10); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = p === cur ? '#ffd700' : '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2); ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font      = `bold ${Math.max(9, Math.floor(r * 1.1))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tokenLabel(p, players), cx, cy + 0.5);

      if (p.hasPrincess) {                     // crown if carrying the princess
        ctx.font = `${Math.floor(TILE * 0.7)}px sans-serif`;
        ctx.fillText('👑', cx + r * 0.7, cy - r * 0.8);
      }
    });
  }

  // Initial of the name, or the player number when initials clash ("Player 1".."Player 4")
  function tokenLabel(p, players) {
    const ini = q => (q.name.trim()[0] ?? '?').toUpperCase();
    return players.some(q => q !== p && ini(q) === ini(p)) ? String(players.indexOf(p) + 1) : ini(p);
  }

  let tokenSpots = [];
  // Player whose token is under the canvas point (for hover cards)
  function playerAt(canvasX, canvasY) {
    for (let i = tokenSpots.length - 1; i >= 0; i--) {
      const t = tokenSpots[i];
      if ((canvasX - t.cx) ** 2 + (canvasY - t.cy) ** 2 <= (t.r + 2) ** 2) return t.p;
    }
    return null;
  }
  const playerColor = i => PLAYER_COLORS[i] ?? '#888';

  function drawToken(x, y, label, bg) {
    const px = PAD + x * TILE;
    const py = PAD + y * TILE;
    ctx.fillStyle = bg;
    ctx.fillRect(px, py, TILE, TILE);
    ctx.font = `${Math.floor(TILE * 0.6)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, px + TILE / 2, py + TILE / 2);
  }

  // Convert canvas click coordinates to tile coordinates
  function tileAt(canvasX, canvasY) {
    const x = Math.floor((canvasX - PAD) / TILE);
    const y = Math.floor((canvasY - PAD) / TILE);
    if (x < 0 || x >= MapGrid.WIDTH || y < 0 || y >= MapGrid.HEIGHT) return null;
    if (!MapGrid.isWalkable(x, y)) return null;
    return { x, y };
  }

  // Like tileAt but without the walkability filter — used for tooltips.
  function coordsAt(canvasX, canvasY) {
    const x = Math.floor((canvasX - PAD) / TILE);
    const y = Math.floor((canvasY - PAD) / TILE);
    if (x < 0 || x >= MapGrid.WIDTH || y < 0 || y >= MapGrid.HEIGHT) return null;
    return { x, y };
  }

  return { init, draw, tileAt, coordsAt, playerAt, playerColor };
})();
