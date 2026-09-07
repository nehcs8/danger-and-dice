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

        // Highlight reachable tiles (orange = requires passing a STOP tile)
        if (highlightedTiles?.has(`${x},${y}`)) {
          ctx.fillStyle = state.stopBlockedTiles?.has(`${x},${y}`) ? '#ffaa44' : '#aaff88';
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

    // ── Players ────────────────────────────────────────────────────────────
    players.forEach((p, i) => {
      if (!p.isAlive) return;
      const { x, y } = p.position;
      const px = PAD + x * TILE;
      const py = PAD + y * TILE;

      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.beginPath();
      ctx.arc(px + TILE / 2, py + TILE / 2, TILE * 0.38, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#fff';
      ctx.font      = `bold ${Math.max(8, Math.floor(TILE * 0.45))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.name[0].toUpperCase(), px + TILE / 2, py + TILE / 2);

      // Crown if carrying princess
      if (p.hasPrincess) {
        ctx.font = `${Math.floor(TILE * 0.5)}px sans-serif`;
        ctx.fillText('👑', px + TILE / 2, py + TILE * 0.15);
      }
    });

    // ── Current player highlight ────────────────────────────────────────────
    const cur = Game.getCurrentPlayer();
    if (cur?.isAlive) {
      const { x, y } = cur.position;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 2;
      ctx.strokeRect(PAD + x * TILE, PAD + y * TILE, TILE, TILE);
    }
  }

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

  return { init, draw, tileAt };
})();
