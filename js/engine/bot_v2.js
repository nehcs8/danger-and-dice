// Bot AI v2 — "speedrun recipe" bot.
//
// Design:
//   1. FightModel  — fast Monte Carlo of a fight using the same rules as combat.js,
//                    with the same potion policy the bot uses in real fights.
//   2. Nav         — potential field (reverse Dijkstra) built on the REAL movement
//                    rules: uncleared minibosses stop movement (cost = fight + turn
//                    break, or wall if too dangerous); bosses are walls.
//                    The bot always moves to the reachable tile with the lowest
//                    potential, so it cannot ping-pong.
//   3. Macro       — a fixed priority list modelled on the human speedruns:
//                    weapon → armor → bloodlust → farm up the tiers → dragon kit
//                    → dragon → princess → finish (with Invisibility Cloak).
//
// External API (unchanged): BotAI.takeTurn(player), BotAI.chooseCombatAction(player, mob),
//                           BotAI.getPhase(player)

const BotAI = (() => {

  // ════════════════════════════════════════════════════════════════════════════
  // Constants
  // ════════════════════════════════════════════════════════════════════════════
  const DEF = { F:'A', D:'V', M:'M', C:'C' };
  const W = MapGrid.WIDTH ?? 51, H = MapGrid.HEIGHT ?? 38;
  const INF = 1e9;

  // Strategy profiles. `main` is the attack stat; `weapon` the tier-6 item for it.
  const PROFILES = {
    // +3 enchants beat Bloodlust once the build is geared (Bloodlust does nothing vs the dragon)
    F: { name:'F', main:'F', weapon:'halberd',  wslot:'strength',  weaponEnchant:'sharpness' },
    D: { name:'D', main:'D', weapon:'arquebus', wslot:'dexterity', weaponEnchant:'precision' },
    FB: { name:'FB', main:'F', weapon:'halberd',  wslot:'strength',  weaponEnchant:'bloodlust' },
    DB: { name:'DB', main:'D', weapon:'arquebus', wslot:'dexterity', weaponEnchant:'bloodlust' },
    M: { name:'M', main:'M', weapon:'grimoire', wslot:'magic', needsSpell:true },
    // Garrote: executes any mob at ≤2 hearts with an F attack. Farms z0 for free from turn one;
    // levels to F+6 through miniboss wins. G = Sharpness (+3F) on it, GB = Bloodlust (human route).
    G:  { name:'G',  main:'F', weapon:'garrote', wslot:'strength', guildWeapon:true, weaponEnchant:'sharpness', speedEarly:true, fallback:'F' },
    GB: { name:'GB', main:'F', weapon:'garrote', wslot:'strength', guildWeapon:true, weaponEnchant:'bloodlust', speedEarly:true, fallback:'F' },
    // Blowpipe: immune to Charisma attacks (they're redirected to the mob's best of F/D/M). Levels to D+6.
    BP: { name:'BP', main:'D', weapon:'blowpipe', wslot:'dexterity', guildWeapon:true, weaponEnchant:'precision', speedEarly:true, fallback:'D' },
    // Dark Tome: spells' magic value doubled. Levels to M+6. Spells become the dragon kit.
    DT: { name:'DT', main:'M', weapon:'dark_tome', wslot:'magic', needsSpell:true, guildWeapon:true, weaponEnchant:'bloodlust', fallback:'M' },
    // Stealth Shoes: escape always works → farm above your level, bail at 1 heart. Pegasus for bosses.
    SS: { name:'SS', main:'auto', guildExtra:'stealth_shoes', extraFirst:true, escapeFarming:true,
          slots:['W','armor','shield','speed','charisma'] },
    // Bottomless Bag: double item drops (potions, blood) → dragon kit comes from loot. Accordion for bosses.
    BB: { name:'BB', main:'auto', guildExtra:'bottomless_bag',
          slots:['W','armor','shield','speed','magic'], bossSlots:['W','armor','shield','speed','charisma'] },
  };
  // Tunable decisions. Defaults reproduce the hand-written behaviour; a strategy can be a
  // genome { base:'G', tune:{...} } (see strategy_search.js) instead of a profile name.
  const DEFAULT_TUNE = {
    shield: true, shieldRes: true, armorEnch: true,   // buy Large Shield / its Resistance / Arcane-or-Resistance on armor
    pegasus: true, accordion: true, cloak: true, rope: true, pvpKit: true,
    speedEarly: null,           // null = profile default; true/false forces weapon enchant + Pegasus before armor
    skills: 5,                  // Master stat points to buy (engine cap: 5, base stat < 6)
    skillOrder: 'main,A,V',     // priority; 'main' = the profile's attack stat
    skillsEarly: false,         // buy stat points right after the weapon instead of after Pegasus
    farmWin: 0.97, farmHearts: 1.3,   // farm the highest tier with winP ≥ farmWin and hearts lost ≤ farmHearts
    healMissing: 2,             // go heal when down this many hearts
    dragonGo: 0.85,             // attack the dragon at this simulated win probability
    kitTarget: 0.9,             // dragon kit planner aims for this win probability
    stockpileCoins: 250, curseCap: 24,   // buy curses whenever coins ≥ stockpileCoins, up to curseCap
    bosses: true,               // hunt normal bosses whose drops raise our dragon odds (King excluded: no battle model yet)
    bossGo: 0.9,                // fight a boss at this simulated win probability
    bossGain: 0.08,             // …if its drops raise our dragon win probability by at least this much
  };
  function tune(p) { const m = M(p); if (!m.profile) profile(p); return m.tune ?? DEFAULT_TUNE; }

  const BASE_WEAPON = { F:{ weapon:'halberd', wslot:'strength', weaponEnchant:'sharpness' }, D:{ weapon:'arquebus', wslot:'dexterity', weaponEnchant:'precision' } };
  const ATTACK_SPELLS = new Set(COMBAT_SPELLS.filter(s => s.subtype === 'attack').map(s => s.id));
  let defaultStrategy = 'auto';     // 'auto' | 'F' | 'D' | 'M'
  function configure(opts = {}) { if (opts.strategy) defaultStrategy = opts.strategy; }
  // Equipment we actually want in our 5 slots
  const KEEP_SLOTS = ['weapon','armor','shield','speed','charisma'];

  const mem = {};               // per-player memory
  function M(p) { return (mem[p.id] ??= { goal:null, turns:0, lastGoalKey:null, sameGoalTurns:0, banned:{} }); }

  // ════════════════════════════════════════════════════════════════════════════
  // Map helpers
  // ════════════════════════════════════════════════════════════════════════════
  const _tiles = {};
  function tilesOf(type) {
    if (_tiles[type]) return _tiles[type];
    const out = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (MapGrid.get(x, y) === type) out.push({ x, y });
    return (_tiles[type] = out);
  }
  function bossPos(id) {
    return tilesOf(TileType.BOSS).find(t => MapGrid.getTileData(t.x, t.y)?.bossId === id) ?? null;
  }
  let _zone = null;
  function zoneAt(x, y) {           // same rule as Game.zoneTierAt (nearest miniboss tier)
    if (!_zone) {
      _zone = new Int8Array(W * H);
      const mbs = tilesOf(TileType.MINIBOSS);
      for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
        let bd = INF, bt = 0;
        for (const m of mbs) { const d = Math.abs(m.x - xx) + Math.abs(m.y - yy); if (d < bd) { bd = d; bt = MapGrid.getTileData(m.x, m.y).minibossTier ?? 0; } }
        _zone[yy * W + xx] = bt;
      }
    }
    return _zone[y * W + x];
  }
  function shopMaxTier(s) { const z = zoneAt(s.x, s.y); return z <= 0 ? 3 : z === 1 ? 4 : 6; }
  function shopMinTier(s) { const z = zoneAt(s.x, s.y); return z <= 0 ? 1 : z === 1 ? 2 : 5; }
  function hasSecret(p) { return p.hasItem('compass') || p.hasEquipped('ragged_sandals'); }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Fight model (Monte Carlo, mirrors combat.js)
  // ════════════════════════════════════════════════════════════════════════════
  const d6 = () => 1 + Math.floor(Math.random() * 6);

  // Snapshot of everything about the player that matters in a fight.
  function snapshot(p, { usePots = false } = {}) {
    const st = {};
    for (const s of ['F','D','A','M','C','V']) st[s] = p.getStat(s) - (p.tempBonuses?.[s] ?? 0) - (p.priestBuff ?? 0);
    const pots = { F:[], D:[], A:[], M:[], C:[], V:[] };
    let heals = 0, curses = 0; const bloods = {};
    for (const id of p.inventory) {
      if (id === 'pot_heal') { heals++; continue; }
      if (id === 'sp_curse') { curses++; continue; }
      const it = getItem(id);
      if (usePots && it?.effect?.stat && /^pot_/.test(id)) pots[it.effect.stat].push(it.effect.value);
      if (usePots && it?.statBonus && !it.slot) for (const [s, v] of Object.entries(it.statBonus)) bloods[s] = Math.max(bloods[s] ?? 0, v);
    }
    for (const s in pots) pots[s].sort((a, b) => b - a);
    const arcane = p.hasEnchantment('arcane');
    const prot = arcane ? 0 : (p._equippedDefenseSpell?.()?.armorValue ?? 0);
    const canM = p.canAttackMagic();
    const spells = usePots ? castableSpells(p).map(id => getItem(id)) : [];
    return {
      atk: canM ? ['F','D','M'] : ['F','D'],
      spells, tome: p.hasEquipped('dark_tome') ? 2 : 1,
      smokes: usePots ? p.inventory.filter(x => x === 'sp_smoke').length : 0,
      st, pots, heals, curses: usePots ? curses : 0, bloods, arcane, prot,
      hearts: p.hearts.current, maxHearts: p.hearts.max,
      kryss: p.hasEquipped('kryss'), garrote: p.hasEquipped('garrote'), thorns: p.hasEnchantment('thorns'),
      flame: p.hasEnchantment('flame'), immuneC: p.hasEquipped('blowpipe'),
      fury: p.getEnchantmentTier('fury'), hawk: p.getEnchantmentTier('hawk_eye'),
      usePots,
    };
  }

  // Attack spells we may spend: all but one (the cheapest), so magic stays usable.
  function castableSpells(p) {
    const sp = p.inventory.filter(id => ATTACK_SPELLS.has(id));
    if (!sp.length) return [];
    sp.sort((a, b) => getItem(a).buyPrice - getItem(b).buyPrice);
    return sp.slice(1);
  }
  // Spell choice (shared by sim and real fights): extra damage first, then stun, then raw bonus.
  function spellScore(sp, mult, stunned) {
    const t = sp.effect?.type;
    return sp.magicValue * mult + (t === 'fire' ? 6 : 0) + (t === 'lightning' && !stunned ? 4 : 0) + (t === 'blood' ? 1 : 0);
  }
  function pickSpell(spells, mult, stunned) {
    let best = -1, bv = -INF;
    spells.forEach((sp, i) => { const v = spellScore(sp, mult, stunned); if (v > bv) { bv = v; best = i; } });
    return best;
  }

  // Blowpipe: a Charisma attack is redirected to the mob's best of F/D/M (ties random) — mirrors game.js.
  function redirectC(stats) {
    const best = Math.max(stats.F, stats.D, stats.M);
    const tied = ['F','D','M'].filter(s => stats[s] === best);
    return tied[Math.floor(Math.random() * tied.length)];
  }
  // Attack types the mob can actually use against us
  function effectiveAttackTypes(stats, immuneC) {
    const t = mobAttackTypes(stats);
    if (!immuneC || !t.includes('C')) return t;
    const best = Math.max(stats.F, stats.D, stats.M);
    return [...new Set(t.filter(x => x !== 'C').concat(['F','D','M'].filter(s => stats[s] === best)))];
  }

  function mobAttackTypes(stats) {
    const mx = Math.max(stats.F, stats.D, stats.M, stats.C);
    return ['F','D','M','C'].filter(s => stats[s] === mx);
  }

  // Which mob stat to curse right now (or null). ms = current mob stats incl. maluses,
  // active = set of stats already under a curse. Mirrors the real in-fight policy.
  function curseChoice(st, ms, arcane, active, atk = ['F','D'], immuneC = false) {
    const defOf = t => st[t === 'M' && arcane ? 'A' : DEF[t]];
    const types = effectiveAttackTypes(ms, immuneC);
    // 1) knock the mob's most dangerous attack type out of its top-stat tie
    const bestDef = Math.max(...['F','D','M','C'].map(defOf));
    const weak = types.filter(t => !active.has(t) && defOf(t) < bestDef - 1).sort((a, b) => defOf(a) - defOf(b));
    if (weak.length && types.length > weak.length) return weak[0];
    if (weak.length && types.length === weak.length) return weak[0];
    // 2) otherwise weaken the defence against our attack
    const a = bestAttackStat(st, ms, atk), d = DEF[a];
    if (!active.has(d)) return d;
    return null;
  }

  function bestAttackStat(st, ms, types = ['F','D']) {
    // maximise margin  (player stat) − (mob defence − 3)
    let best = 'F', bv = -INF;
    for (const s of types) { const v = st[s] - (ms[DEF[s]] - 3); if (v > bv) { bv = v; best = s; } }
    return best;
  }

  // One simulated fight. Returns { win, heartsLeft, healsUsed }
  function simOnce(snap, mobTpl) {
    const st = { ...snap.st };
    for (const [s, v] of Object.entries(snap.bloods)) st[s] += v;
    const pots = {}; for (const s in snap.pots) pots[s] = snap.pots[s].slice();
    let heals = snap.heals, hp = snap.hearts, healsUsed = 0, curses = snap.curses ?? 0, smokes = snap.smokes ?? 0;
    const spells = snap.spells.slice(); let fires = [], stunned = false, bloodKill = false;
    const base = { ...mobTpl.stats };
    let mal = [];                        // {stat, v, left}
    const ms = { ...base };
    const recompute = () => { for (const k in base) ms[k] = base[k]; for (const m of mal) ms[m.stat] = Math.max(0, ms[m.stat] - m.v); };
    let mhp = mobTpl.hearts.max ?? mobTpl.hearts.current;
    if (snap.kryss) mhp--;
    if (mhp <= 0) return { win:true, heartsLeft:hp, healsUsed };
    let playerTurn = (st.V + d6()) > ms.V;
    for (let r = 0; r < 120; r++) {
      if (playerTurn) {
        if (curses > 0) {
          const c = curseChoice(st, ms, snap.arcane, new Set(mal.map(m => m.stat)), snap.atk, snap.immuneC);
          if (c) { curses--; mal.push({ stat:c, v:d6(), left:4 }); recompute(); }
        }
        if (snap.garrote && mhp <= 2) return { win:true, heartsLeft:hp, healsUsed };   // Garrote execute (F, no roll)
        const a = bestAttackStat(st, ms, snap.atk);
        let roll = st[a] + d6();
        if (snap.usePots && pots[a].length) roll += pots[a].shift();
        let sp = null;
        if (a === 'M' && spells.length) { const i = pickSpell(spells, snap.tome, stunned); sp = spells.splice(i, 1)[0]; roll += sp.magicValue * snap.tome; }
        if (roll > ms[DEF[a]] - 3 + d6()) {
          mhp--;
          if (sp?.effect?.type === 'fire') fires.push(sp.effect.n);
          if (snap.flame) fires.push(1);
          if (sp?.effect?.type === 'lightning') stunned = true;
          if (sp?.effect?.type === 'explosion') { base.A = Math.max(0, base.A - sp.effect.n); recompute(); }
          if (sp?.effect?.type === 'ice') { base.V = Math.max(0, base.V - sp.effect.n); recompute(); }
          if (snap.fury) { base.A = Math.max(0, base.A - snap.fury); recompute(); }
          if (snap.hawk) { base.V = Math.max(0, base.V - snap.hawk); recompute(); }
          if (mhp <= 0) return { win:true, heartsLeft:hp, healsUsed };
        }
      } else {
        // fire ticks at the start of the mob's half
        if (fires.length) { fires = fires.map(f => f - 1); const dmg = fires.filter(f => f <= 0).length; fires = fires.filter(f => f > 0);
          if (dmg) { mhp -= dmg; if (mhp <= 0) return { win:true, heartsLeft:hp, healsUsed }; } }
        const skip = stunned && d6() <= 3; stunned = false;
        const atkTypes = mobAttackTypes(ms);
        let t = atkTypes[Math.floor(Math.random() * atkTypes.length)];
        if (t === 'C' && snap.immuneC) t = redirectC(ms);
        if (hp === 1 && heals > 0) { heals--; healsUsed++; hp++; }
        const dsPre = t === 'M' && snap.arcane ? 'A' : DEF[t];
        let smoked = false;
        if (!skip && smokes > 0 && smokeWorth(st[dsPre] + (t === 'M' ? snap.prot : 0), ms[t], hp)) { smokes--; smoked = true; }
        if (skip || smoked) { if (mal.length) { mal.forEach(m => m.left--); mal = mal.filter(m => m.left > 0); recompute(); } playerTurn = !playerTurn; continue; }
        const ds = t === 'M' && snap.arcane ? 'A' : DEF[t];
        let def = st[ds] + (t === 'M' ? snap.prot : 0) + d6();
        if (snap.usePots && pots[ds].length) def += pots[ds].shift();
        if (ms[t] - 3 + d6() > def) {
          if (snap.thorns && Math.random() < 0.3) { mhp--; if (mhp <= 0) return { win:true, heartsLeft:hp, healsUsed }; }
          else { hp--; if (hp <= 0) return { win:false, heartsLeft:0, healsUsed }; }
        }
        // end of round: maluses tick
        if (mal.length) { mal.forEach(m => m.left--); mal = mal.filter(m => m.left > 0); recompute(); }
      }
      playerTurn = !playerTurn;
    }
    return { win:false, heartsLeft:hp, healsUsed };
  }

  // Use smoke when the announced attack is likely to hit, or when on the last heart.
  function smokeWorth(defStat, mobAtk, hp) { return hp <= 1 || (mobAtk - 3) - defStat >= 2; }

  function simFight(snap, mobTpl, n = 200) {
    let w = 0, hl = 0, hu = 0;
    for (let i = 0; i < n; i++) { const r = simOnce(snap, mobTpl); if (r.win) { w++; hl += snap.hearts - r.heartsLeft; } hu += r.healsUsed; }
    return { winP: w / n, heartsLost: w ? hl / w : snap.hearts, healsUsed: hu / n };
  }

  // Win probability (and expected hearts lost) vs a whole miniboss tier (one of its 6 named
  // mobs at random), without stat potions. Cached per stat-signature.
  const _tierCache = {};
  function tierStats(p, tier, hearts = null) {
    const snap = snapshot(p);
    if (hearts != null) snap.hearts = hearts;
    snap.heals = 0;
    const key = `${p.id}|${tier}|${snap.atk.join('')}|${JSON.stringify(snap.st)}|${snap.hearts}|${snap.kryss}|${snap.garrote}|${snap.flame}|${snap.immuneC}|${snap.thorns}|${snap.fury}|${snap.arcane}`;
    if (_tierCache[key]) return _tierCache[key];
    const pool = MOBS.getByTier(tier).filter(m => !m.isBoss).slice(0, 6);
    let w = 0, hl = 0;
    for (const m of pool) { const r = simFight(snap, m, 120); w += r.winP; hl += r.heartsLost; }
    return (_tierCache[key] = { winP: w / pool.length, heartsLost: hl / pool.length });
  }
  function tierWinP(p, tier, hearts = null) { return tierStats(p, tier, hearts).winP; }

  // Win probability vs a boss (default: the dragon) at full hearts, with our potion policy.
  const _bossCache = {};
  function mobWinP(p, mobId, extraInv = [], n = 600) {
    const inv = p.inventory;
    const fake = Object.create(p);
    fake.inventory = inv.concat(extraInv);
    const snap = snapshot(fake, { usePots:true });
    snap.hearts = snap.maxHearts;
    const key = `${mobId}|${n}|${snap.garrote}|${snap.kryss}|${snap.flame}|${snap.immuneC}|${snap.atk.join('')}|${snap.spells.map(x => x.id).sort().join(',')}|${snap.tome}|${snap.smokes}|${JSON.stringify(snap.st)}|${JSON.stringify(snap.pots)}|${snap.heals}|${snap.curses}|${JSON.stringify(snap.bloods)}|${snap.arcane}|${snap.prot}|${snap.thorns}|${snap.fury}|${snap.hawk}|${snap.maxHearts}`;
    if (_bossCache[key] != null) return _bossCache[key];
    return (_bossCache[key] = simFight(snap, MOBS.getMob(mobId), n).winP);
  }
  function dragonWinP(p, extraInv = [], n = 600) { return mobWinP(p, 'dragon', extraInv, n); }

  // ── Boss hunting ────────────────────────────────────────────────────────────
  // Normal bosses drop gear that can make the dragon winnable. The King is excluded until
  // there is a model of the King battle (simulations auto-win it).
  const HUNT_BOSSES = ['sea_serpent', 'prince', 'grand_sorcerer', 'witch', 'phoenix'];
  const REF_KIT = [...Array(10).fill('sp_curse'), ...Array(4).fill('pot_heal')];   // odds are compared with a typical kit
  function enchantFor(p, slot) {
    const pr = profile(p), id = slot === pr.wslot ? (pr.weaponEnchant ?? 'bloodlust')
      : slot === 'armor' ? (p.getStat('A') > p.getStat('M') ? 'arcane' : 'resistance')
      : slot === 'shield' ? 'resistance' : null;
    const e = id && ENCHANTMENTS.find(x => x.id === id);
    return e ? { ...e, tier: 1 } : null;
  }
  function bossDrops(id) {
    return (MOBS.getMob(id)?.lootTable ?? []).filter(e => e.itemId).flatMap(e => Array(e.count ?? 1).fill(e.itemId));
  }
  // For each boss still alive: its own win probability, and how much its drops (re-enchanted
  // like ours) would raise the dragon win probability. Cached on our gear/stats/inventory.
  function bossOptions(p) {
    const m = M(p), st = Game.getState();
    const key = `${p.inventory.slice().sort().join(',')}|${Object.values(p.equipped).map(i => i ? i.id + (i.enchantment?.id ?? '') : '-').join(',')}|${['F','D','A','M','C','V'].map(s => p.getStat(s)).join(',')}|${[...st.defeatedBosses].join(',')}|${p.hearts.max}`;
    if (m.bossOpt?.key === key) return m.bossOpt.list;
    const base = withBossLoadout(p, () => dragonWinP(p, REF_KIT, 300));
    const list = [];
    for (const id of HUNT_BOSSES) {
      if (st.defeatedBosses.has(id) || !bossPos(id)) continue;
      const drops = bossDrops(id);
      const fake = Object.create(p);
      fake.inventory = p.inventory.concat(drops);
      fake.storedEnchantments = { ...p.storedEnchantments };
      for (const d of new Set(drops)) { const it = getItem(d); const e = it?.slot && enchantFor(p, it.slot); if (e) fake.storedEnchantments[d] = [e]; }
      const after = withBossLoadout(fake, () => dragonWinP(fake, REF_KIT, 300));
      const win = withBossLoadout(p, () => mobWinP(p, id, [], 300));
      list.push({ id, gain: after - base, win });
    }
    m.bossOpt = { key, list };
    return list;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Navigation — potential field on the real movement graph
  // ════════════════════════════════════════════════════════════════════════════
  // With guaranteed escape (Stealth Shoes) a fight can't kill us: we bail at 1 heart.
  // So "win" means winning before dropping to 1 heart, and much lower odds are acceptable.
  function canAlwaysEscape(p) { return p.hasEquipped('stealth_shoes'); }
  function fightOK(p, tier, hearts, need, needEscape) {
    if (canAlwaysEscape(p)) return hearts >= 2 && tierWinP(p, tier, hearts - 1) >= needEscape;
    return tierWinP(p, tier, hearts) >= need;
  }
  function safeMinibossTier(p) {
    // highest tier we may walk THROUGH (land on and fight) at current hearts
    let t = -1;
    const need = p.hasPrincess ? 0.6 : 0.95;
    for (let tier = 0; tier <= 3; tier++) if (fightOK(p, tier, p.hearts.current, need, 0.6)) t = tier;
    return t;
  }

  // targets: [{x,y,bias}] — bias added to that source (lower = more attractive)
  function field(p, targets, assumeCloak = false) {
    const dist = new Float64Array(W * H).fill(INF);
    const cloak = assumeCloak || p.hasEquipped('invis_cloak') || !!p.invisibleThisTurn;
    const occupied = pvpOccupied(p);
    const secret = hasSecret(p);
    const safeT = cloak ? 3 : safeMinibossTier(p);
    const tSet = new Set(targets.map(t => t.y * W + t.x));
    const turnLen = Math.max(4, p.getStat('V') + 3.5);
    // simple binary heap
    const heap = [];
    const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const q = (k - 1) >> 1; if (heap[q][0] <= heap[k][0]) break; [heap[q], heap[k]] = [heap[k], heap[q]]; k = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2*k+1, r = l+1, m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    for (const t of targets) { const i = t.y * W + t.x; const b = t.bias ?? 0; if (b < dist[i]) { dist[i] = b; push(b, i); } }
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      const x = i % W, y = (i / W) | 0;
      // cost of PASSING THROUGH tile i (we're computing dist from neighbours to target via i)
      let through = 1;
      const tt = MapGrid.get(x, y);
      if (!tSet.has(i)) {
        if (tt === TileType.BOSS) continue;                       // wall
        if (occupied.has(i)) continue;                             // PvP: other players stop movement
        if (tt === TileType.MINIBOSS && !p.hasUsedTile(x, y) && !cloak) {
          const tier = MapGrid.getTileData(x, y)?.minibossTier ?? 0;
          if (tier > safeT) continue;                              // wall
          through += turnLen;                                      // movement stops here
        }
        if (tt === TileType.STOP && !p.hasUsedTile(x, y)) through += turnLen * 0.5;
      }
      for (const n of MapGrid.getAdjacent(x, y, secret)) {
        const j = n.y * W + n.x, nd = d + through;
        if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
      }
    }
    return dist;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Macro planning
  // ════════════════════════════════════════════════════════════════════════════
  function profile(p) {
    const m = M(p);
    if (!m.profile) {
      let k = p.botStrategy ?? defaultStrategy;
      if (k && typeof k === 'object') { m.tune = { ...DEFAULT_TUNE, ...(k.tune ?? {}) }; k = k.base ?? 'auto'; }
      if (k === 'auto' || !PROFILES[k]) {
        const b = p.baseStats;
        k = b.M > Math.max(b.F, b.D) ? 'M' : b.D >= b.F ? 'D' : 'F';
      }
      m.profile = PROFILES[k];
      if (m.profile.main === 'auto') {
        const main = p.baseStats.D >= p.baseStats.F ? 'D' : 'F';
        m.profile = { ...m.profile, main, ...BASE_WEAPON[main], fallback: main };
      }
    }
    const pr = m.profile;
    // Fall back only if we never got the guild item and someone else bought it.
    // (Ownership is remembered: boss-loadout evaluations temporarily take items off.)
    const owns = id => p.hasItem(id) || p.hasEquipped(id);
    if (pr.guildWeapon && owns(pr.weapon)) m.gotWeapon = true;
    if (pr.guildExtra && owns(pr.guildExtra)) m.gotExtra = true;
    if (pr.guildWeapon && !m.gotWeapon && guildSoldOut(pr.weapon)) m.profile = PROFILES[pr.fallback];
    else if (pr.guildExtra && !m.gotExtra && guildSoldOut(pr.guildExtra)) m.profile = PROFILES[pr.fallback];
    return m.profile;
  }
  function mainStat(p) { return profile(p).main; }

  function guildTileFor(id) {
    const g = getItem(id)?.guild;
    return tilesOf(g === 'thief' ? TileType.GUILD_THIEF : TileType.GUILD_ASSASSIN)[0];
  }
  function guildSoldOut(id) {
    const g = guildTileFor(id);
    const st = g && Game.getState().shopStocks?.[`${g.x},${g.y}`];
    return !!st && !(st[id] > 0);
  }
  function cloakSoldOut() {
    const g = tilesOf(TileType.GUILD_ASSASSIN)[0];
    const st = g && Game.getState().shopStocks?.[`${g.x},${g.y}`];
    return !!st && !(st.invis_cloak > 0);
  }

  function itemVal(item, stat) { return item?.statBonus?.[stat] ?? 0; }

  // What do we want to buy next (in order)? Returns the first affordable-or-not need.
  function shoppingList(p) {
    const pr = profile(p), ms = pr.main, list = [];
    const eq = p.equipped;
    const wslot = pr.wslot;
    const has = id => p.hasItem(id) || p.hasEquipped(id);
    const tn = tune(p), speedEarly = tn.speedEarly ?? !!pr.speedEarly;
    const skillStep = () => {
      if ((p.masterSkillsBought ?? 0) >= Math.min(5, tn.skills)) return;
      for (const s0 of tn.skillOrder.split(',')) { const s = s0 === 'main' ? ms : s0; if (p.baseStats[s] < 6) { list.push({ where:'master', skill:s, cost:50 }); break; } }
    };
    if (pr.guildExtra && pr.extraFirst && !has(pr.guildExtra)) list.push({ where:'guild', id:pr.guildExtra });
    if (pr.needsSpell && !p.canAttackMagic()) list.push({ where:'master', buySpell:'bang', cost:10 });
    if (pr.guildWeapon) {
      if (!has(pr.weapon)) list.push({ where:'guild', id:pr.weapon });
    } else if (!has(pr.weapon) && itemVal(eq[wslot], ms) < 6) list.push({ where:'shop', id:pr.weapon, minTier:6 });
    const wench = pr.weaponEnchant ?? 'bloodlust';
    const wantWEnch = eq[wslot] && !eq[wslot].enchantment && (itemVal(eq[wslot], ms) >= 6 || eq[wslot].id === pr.weapon);
    if (tn.skillsEarly) skillStep();
    if (speedEarly) {
      if (wantWEnch) list.push({ where:'master', enchant:wench, slot:wslot, cost: ENCHANTMENTS.find(e => e.id === wench).cost });
      if (tn.pegasus && !has('pegasus') && itemVal(eq.speed, 'V') < 6) list.push({ where:'shop', id:'pegasus', minTier:6 });
    }
    if (!has('hv_armor') && itemVal(eq.armor, 'A') < 6) list.push({ where:'shop', id:'hv_armor', minTier:4 });
    if (tn.shield && !has('lg_shield') && itemVal(eq.shield, 'A') < 3) list.push({ where:'shop', id:'lg_shield', minTier:2 });
    if (!speedEarly && wantWEnch) list.push({ where:'master', enchant:wench, slot:wslot, cost: ENCHANTMENTS.find(e => e.id === wench).cost });
    if (pr.guildExtra && !pr.extraFirst && !has(pr.guildExtra)) list.push({ where:'guild', id:pr.guildExtra });
    if (tn.pegasus && !has('pegasus') && itemVal(eq.speed, 'V') < 6) list.push({ where:'shop', id:'pegasus', minTier:6 });
    if (!tn.skillsEarly) skillStep();
    if (tn.armorEnch && eq.armor && !eq.armor.enchantment && eq.armor.id !== 'invis_cloak' && itemVal(eq.armor, 'A') >= 6) {
      // Arcane only pays off if Armor beats Magic as a defence (true for F/D, often not for mages)
      const arc = p.getStat('A') > p.getStat('M');
      list.push({ where:'master', enchant: arc ? 'arcane' : 'resistance', slot:'armor', cost:50 });
    }
    if (tn.shieldRes && eq.shield && !eq.shield.enchantment) list.push({ where:'master', enchant:'resistance', slot:'shield', cost:50 });
    if (tn.accordion && !has('accordion') && itemVal(eq.charisma, 'C') < 6) list.push({ where:'shop', id:'accordion', minTier:6 });
    if (tn.cloak && !has('invis_cloak') && !cloakSoldOut()) list.push({ where:'guild', id:'invis_cloak', cost:100 });
    if (tn.rope && !has('rope')) list.push({ where:'shop', id:'rope' });
    // PvP kit (only matters with rivals alive): chains to stop escapes, invisibility to escape
    // or sneak, a teleport to ambush the carrier's route
    if (tn.pvpKit && rivalsAlive(p)) {
      const cnt = id => p.inventory.filter(x => x === id).length;
      if (cnt('chain') < 2)           list.push({ where:'shop', id:'chain' });
      if (cnt('sp_invisibility') < 2) list.push({ where:'master', buySpell:'sp_invisibility', cost:15 });
      if (cnt('sp_teleport') < 1)     list.push({ where:'master', buySpell:'sp_teleport', cost:20 });
    }
    for (const it of list) if (it.id && it.cost == null) it.cost = getItem(it.id).buyPrice;
    // de-duplicate (pegasus may appear twice for speedEarly profiles)
    const seen = new Set(); return list.filter(it => { const k = it.id ?? (it.enchant ? it.enchant + it.slot : it.skill ? 'skill' + it.skill : 'spell' + it.buySpell); if (seen.has(k)) return false; seen.add(k); return true; });
    return list;
  }

  // Greedy kit planner: repeatedly add the bundle with the best win-probability
  // gain per coin until the target is reached or the budget runs out.
  const KIT_STEP = 2;
  function kitCandidates(p) {
    const ms = mainStat(p);
    const c = ['sp_curse', 'sp_smoke', 'pot_heal', `pot_${ms}3`, 'pot_A3', 'pot_V6', 'pot_C3'];
    if (p.canAttackMagic() && ms === 'M') c.push('fireball', 'bolt', 'freeze', 'blaze');
    return c;
  }
  function planKit(p, budget, target = 0.9) {
    const kit = [];
    let cur = dragonWinP(p, kit, 300);
    while (cur < target) {
      let best = null, bestGain = 0;
      for (const id of kitCandidates(p)) {
        const c = getItem(id).buyPrice * KIT_STEP;
        if (c > budget) continue;
        const owned = p.inventory.filter(x => x === id).length + kit.filter(x => x === id).length;
        if (owned >= (id === 'sp_curse' ? 30 : 14)) continue;
        if (LIMITED.has(id) && kit.filter(x => x === id).length + KIT_STEP > masterStock(id)) continue;
        const add = Array(KIT_STEP).fill(id);
        const g = (dragonWinP(p, kit.concat(add), 300) - cur) / c;
        if (g > bestGain) { bestGain = g; best = add; }
      }
      if (!best) break;
      kit.push(...best); budget -= getItem(best[0]).buyPrice * KIT_STEP;
      cur = dragonWinP(p, kit, 300);
    }
    return { kit, winP: cur };
  }
  const LIMITED = new Set(['sp_curse','sp_smoke']);
  const MASTER_ONLY = new Set(['sp_curse','sp_smoke', ...ATTACK_SPELLS, 'sp_invisibility','sp_teleport','sp_transmutation','sp_disenchant']);
  function masterStock(id) {
    const st = Game.getState();
    const keys = { sp_curse:['masterCurseStock','masterCurseStockResetTurn'], sp_smoke:['masterSmokeStock','masterSmokeStockResetTurn'] }[id];
    if (!keys) return Infinity;
    return (st.turnNumber - (st[keys[1]] ?? -99)) >= 15 ? 10 : (st[keys[0]] ?? 10);
  }
  function cachedPlan(p) {
    const m = M(p);
    const key = `${Math.floor(p.coins / 50)}|${p.inventory.slice().sort().join(',')}|${['F','D','A','V','C'].map(s => p.getStat(s)).join(',')}`;
    if (m.plan?.key !== key) m.plan = { key, ...planKit(p, p.coins - 20, tune(p).kitTarget) };
    return m.plan;
  }

  function gearDone(p) { return shoppingList(p).filter(i => i.id !== 'invis_cloak' && !i.skill).length === 0; }

  // Possible stock check: shop at s may sell item?
  function shopMaySell(s, id) {
    const st = Game.getState().shopStocks?.[`${s.x},${s.y}`];
    if (st) return (st[id] ?? 0) > 0;
    const it = getItem(id);
    if (!it?.tier || !it.slot) return true;           // consumables everywhere
    return it.tier >= shopMinTier(s) && it.tier <= shopMaxTier(s);
  }

  function goalTargets(p, goal) {
    switch (goal.kind) {
      case 'finish':   return tilesOf(TileType.FINISH);
      case 'hunt':     return huntTargets(p);
      case 'stage':    return [goal.tile];
      case 'princess': { const pr = Game.getState().princess; return [{ x:pr.x, y:pr.y }]; }
      case 'dragon':   return [bossPos('dragon')];
      case 'boss':     return [bossPos(goal.id)];
      case 'heal':     return tilesOf(TileType.FIRE);
      case 'bar':      return tilesOf(TileType.BAR);
      case 'master':   return tilesOf(TileType.MASTER);
      case 'guild':    return [guildTileFor(goal.what?.id ?? 'invis_cloak')];
      case 'shop':     return tilesOf(TileType.SHOP).filter(s => goal.items.every(id => shopMaySell(s, id)) && !M(p).banned[`${s.x},${s.y}`]);
      case 'earn': {
        const out = tilesOf(TileType.CHEST).filter(t => !p.hasUsedTile(t.x, t.y));
        for (const t of tilesOf(TileType.WORK)) out.push({ x:t.x, y:t.y, bias:-4 });
        return out.length ? out : tilesOf(TileType.SHOP);
      }
      case 'refresh':  return [...tilesOf(TileType.SHOP), ...tilesOf(TileType.MASTER)];
      case 'farm': {
        const out = [];
        for (const t of tilesOf(TileType.MINIBOSS)) {
          if (p.hasUsedTile(t.x, t.y)) continue;
          const tier = MapGrid.getTileData(t.x, t.y)?.minibossTier ?? 0;
          if (tier !== goal.tier) continue;
          out.push(t);
        }
        // also chests and unexplored ? tiles in safe zones are worth a visit
        return out;
      }
    }
    return [];
  }

  function* goalCandidates(p) {
    const st = Game.getState();
    const m  = M(p);
    if (p.hasPrincess) yield { kind:'finish' };
    if (st.pvpActive && st.princess && !st.princess.carriedBy && !carrier(p)) yield { kind:'princess' };
    if (st.pvpActive && carrier(p)) {
      // a rival carries the princess: if healthy enough, hunt them (ambush their route or chase)
      if (p.hearts.current >= Math.min(3, p.hearts.max)) yield { kind:'hunt' };
    }
    if (!st.pvpActive) { const sg = stagingGoal(p); if (sg) yield sg; }

    // Heal when low (fire is free)
    // Heal when down 2+ hearts: all safety checks use *current* hearts, so at 3/5 almost
    // nothing passes and the bot would stall (seen in run 17: 76 turns at 3 hearts).
    const lowHP = p.hearts.current <= p.hearts.max - tune(p).healMissing;
    if (lowHP || (p.hearts.current < p.hearts.max && m.goal?.kind === 'heal')) {
      if (p.hearts.current < p.hearts.max) {
        const hg = healGoal(p);
        if (hg) yield hg;
      }
    }

    // Shopping list (gear, enchants, skills, cloak, rope)
    const list = shoppingList(p);
    const junk = junkValue(p);
    for (const it of list) {
      if (p.coins < it.cost) {
        // can't afford it yet — but selling junk would cover it: go sell first (shops buy anything)
        if (p.coins + junk >= it.cost) yield it.where === 'shop' ? { kind:'shop', items:[it.id], what:it } : { kind:'shop', items:[], sell:true };
        break;                               // strict order: save up for the next item
      }
      if (it.where === 'shop')   yield { kind:'shop', items:[it.id], what:it };
      if (it.where === 'master') yield { kind:'master', what:it };
      if (it.where === 'guild')  yield { kind:'guild', what:it };
    }

    // Dragon: gear done + cloak owned
    if (list.length === 0) {
      const go = tune(p).dragonGo;
      let wp = withBossLoadout(p, () => dragonWinP(p, [], 300));
      if (wp >= go - 0.05) wp = withBossLoadout(p, () => dragonWinP(p, [], 1500));   // confirm: avoid charging in on a lucky estimate
      m.lastDragonP = wp;
      if (wp >= go) {
        if (p.hearts.current < p.hearts.max) yield { kind:'heal' };
        yield { kind:'dragon', winP:wp };
      }
      // not ready: a boss whose drops would help, and which we can beat now
      const tn = tune(p);
      if (tn.bosses) {
        const opts = bossOptions(p).filter(b => b.gain >= tn.bossGain && b.win >= tn.bossGo).sort((a, b) => b.gain - a.gain);
        for (const b of opts) {
          if (p.hearts.current < p.hearts.max) yield { kind:'heal' };
          yield { kind:'boss', id:b.id, winP:b.win, gain:b.gain };
        }
      }
      const plan = withBossLoadout(p, () => cachedPlan(p));
      m.lastPlanP = plan.winP;
      if (plan.winP < go && wantStockpile(p)) yield { kind:'master', what:{ stockpile:true } };
      if (plan.kit.length && plan.winP >= go) {
        const needMaster = plan.kit.some(id => MASTER_ONLY.has(id) && masterStock(id) > 0);
        if (needMaster) yield { kind:'master', what:{ kit:true } };
        const shopItems = [...new Set(plan.kit.filter(id => !MASTER_ONLY.has(id)))];
        if (shopItems.length) yield { kind:'shop', items:shopItems.slice(0, 1), kit:true };
      }
    }

    // Too weak to fight anything yet → earn coins without fighting
    // Lots of junk in the bag → cash it in
    if (junk >= 150) yield { kind:'shop', items:[], sell:true };

    // Too weak to fight z0 yet → earn without fighting. The bar relaxes the longer we are stuck
    // earning, so a very weak start eventually accepts some risk instead of idling forever.
    m.earnTurns = m.goal?.kind === 'earn' ? (m.earnTurns ?? 0) + 1 : 0;
    const need0 = Math.max(0.8, 0.97 - 0.004 * m.earnTurns);
    if (!fightOK(p, 0, p.hearts.max, need0, 0.75)) yield { kind:'earn' };

    // Otherwise farm the best safe tier
    const tier = farmTier(p);
    const tgts = goalTargets(p, { kind:'farm', tier });
    if (tgts.length) yield { kind:'farm', tier };
    // nothing productive reachable at current hearts → heal up first
    if (p.hearts.current < p.hearts.max) { const hg = healGoal(p); if (hg) yield hg; }
    for (let t = tier - 1; t >= 0; t--) yield { kind:'farm', tier:t };
    yield { kind:'earn' };
    yield { kind:'refresh' };
  }

  // goals that travel straight to a target: skip optional detours, wear the cloak
  const RUSH = new Set(['dragon', 'boss', 'princess', 'finish']);
  const goalKey = g => JSON.stringify([g.kind, g.tier ?? '', (g.items ?? []).join(), g.what?.id ?? g.what?.enchant ?? g.what?.skill ?? g.id ?? '']);
  function chooseGoal(p) {
    const m = M(p);
    m.goalBan ??= {};
    let last = null;
    const hasCloak = p.hasItem('invis_cloak') || p.hasEquipped('invis_cloak');
    m.cloakNeeded = false;
    for (const g of goalCandidates(p)) {
      if ((m.goalBan[goalKey(g)] ?? -1) > m.turns) continue;
      last = g;
      const tg = goalTargets(p, g);
      if (!tg.length) continue;
      if (reachableFrom(p, tg, RUSH.has(g.kind) && hasCloak)) return g;
      // only reachable past minibosses we can't fight (e.g. coming back from a boss): wear the cloak
      if (hasCloak && !RUSH.has(g.kind) && reachableFrom(p, tg, true)) { m.cloakNeeded = true; return g; }
    }
    return last ?? { kind:'earn' };
  }

  function reachableFrom(p, targets, assumeCloak = false) {
    if (!targets.length) return false;
    const d = field(p, targets, assumeCloak);
    return d[p.position.y * W + p.position.x] < INF;
  }
  function healGoal(p) {
    if (reachableFrom(p, tilesOf(TileType.FIRE))) return { kind:'heal' };
    if (p.coins >= 10 && reachableFrom(p, tilesOf(TileType.BAR))) return { kind:'bar' };
    if (p.coins >= 50) {
      const shops = tilesOf(TileType.SHOP).filter(s => shopMaySell(s, 'pot_heal'));
      if (reachableFrom(p, shops)) return { kind:'shop', items:['pot_heal'], heal:true };
    }
    return null;
  }

  // Curses are the dragon bottleneck (10 per 15 turns): buy them whenever we can spare coins.
  function wantStockpile(p) {
    const tn = tune(p);
    return p.coins >= tn.stockpileCoins && masterStock('sp_curse') > 0 && p.inventory.filter(x => x === 'sp_curse').length < tn.curseCap;
  }

  // Coins we could raise right now by selling what keepItem() would sell anyway.
  function junkValue(p) {
    const mult = p.hasEquipped('crowbar') ? 0.75 : 0.5;
    let v = 0;
    for (const id of p.inventory) { const it = getItem(id); if (it?.buyPrice && !keepItem(p, id)) v += Math.floor(it.buyPrice * mult); }
    return v;
  }

  function masterHasCurses() {
    const st = Game.getState();
    return (st.masterCurseStock ?? 10) > 0 || (st.turnNumber - (st.masterCurseStockResetTurn ?? -99)) >= 15;
  }

  function farmTier(p) {
    // Highest tier with good win probability at full health; reward grows with tier.
    let best = 0;
    for (let t = 0; t <= 3; t++) {
      const { winP, heartsLost } = tierStats(p, t);
      const sustain = p.hasEnchantment('bloodlust') ? 1 : 0;
      if (canAlwaysEscape(p)) { if (fightOK(p, t, p.hearts.max, 0, 0.75)) best = t; continue; }
      if (winP >= tune(p).farmWin && heartsLost - sustain <= tune(p).farmHearts) best = t;
    }
    return best;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Move choice
  // ════════════════════════════════════════════════════════════════════════════
  function landingAdjust(p, x, y, goal, turnLen) {
    const t = MapGrid.get(x, y);
    const pvpAdj = pvpLandingAdjust(p, x, y, goal);
    if (pvpAdj != null) return pvpAdj;
    const used = p.hasUsedTile(x, y);
    const cloak = p.hasEquipped('invis_cloak');
    const coinStep = 0.15;                                 // 1 coin ≈ 0.15 step
    switch (t) {
      case TileType.MINIBOSS: {
        if (used || cloak) return 0;
        const tier = MapGrid.getTileData(x, y)?.minibossTier ?? 0;
        const w = tierWinP(p, tier, p.hearts.current);
        if (goal.kind === 'farm' && tier === goal.tier) return 0;
        if (!fightOK(p, tier, p.hearts.current, 0.95, 0.6)) return 1000;
        // with guaranteed escape a lost fight costs hearts, not the game
        const risk = canAlwaysEscape(p) ? (1 - tierWinP(p, tier, p.hearts.current - 1)) * 30 : (1 - w) * 400;
        return risk - (goal.kind === 'farm' ? 10 : 0);
      }
      case TileType.RANDOM_EVENT: {
        if (used) return 0;
        const z = zoneAt(x, y);
        const w = tierWinP(p, z, p.hearts.current);
        if (RUSH.has(goal.kind)) return 30;
        return (1 - w) * 120 - 6;
      }
      case TileType.CHEST:  return used || RUSH.has(goal.kind) ? 0 : -6;
      case TileType.REROLL: return Game.getState().rerollUsedThisTurn?.has(`${x},${y}`) ? turnLen : -3;
      case TileType.FIRE:   return -(p.hearts.max - p.hearts.current) * 4;
      case TileType.STOP:   return used ? 0 : turnLen * 0.5;
      case TileType.WORK: {
        const z = x < 21 ? 1 : x < 31 ? 2 : x < 41 ? 3 : 4;
        return RUSH.has(goal.kind) ? 0 : -z * 3.5 * 3 * coinStep;
      }
      case TileType.PRIEST: return used ? 0 : -2;
      case TileType.BAR:    return goal.kind === 'bar' && p.coins >= 10 ? -(p.hearts.max - p.hearts.current) * 4 : 0;
      case TileType.BOSS: {
        const id = MapGrid.getTileData(x, y)?.bossId;
        return (goal.kind === 'dragon' && id === 'dragon') || (goal.kind === 'boss' && id === goal.id) ? 0 : 5000;
      }
    }
    return 0;
  }

  function chooseMove(p, state) {
    const reach = state.reachableTiles;
    if (!reach || reach.size === 0) return p.position;
    const m = M(p);
    let goal = m.goal ?? { kind:'refresh' };
    let tg = goalTargets(p, goal);
    if (!tg.length) { goal = { kind:'refresh' }; tg = goalTargets(p, goal); }
    prepareDanger(p);
    const dist = field(p, tg);
    const turnLen = Math.max(4, p.getStat('V') + 3.5);
    const tset = new Set(tg.map(t => `${t.x},${t.y}`));
    let best = null, bs = INF;
    reach.forEach((steps, key) => {
      const [x, y] = key.split(',').map(Number);
      const d = dist[y * W + x];
      // Reaching a goal tile must beat any side bonus (? tiles, chests, rerolls).
      const s = (d >= INF ? 500 : d) + landingAdjust(p, x, y, goal, turnLen) + dangerAt(p, x, y) - (tset.has(key) ? 30 : 0) - steps * 0.001;
      if (s < bs) { bs = s; best = { x, y }; }
    });
    m.lastDist = best ? dist[best.y * W + best.x] : null;
    return best ?? p.position;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Equipment management (outside combat)
  // ════════════════════════════════════════════════════════════════════════════
  function slotScore(p, item) {
    const ms = mainStat(p);
    if (!item) return -INF;
    const b = item.statBonus ?? {};
    switch (item.slot) {
      case profile(p).wslot: return weaponScore(p, item);
      case 'armor':     return item.id === 'invis_cloak' ? (wantCloak(p) && !M(p).bossMode ? 100 : -100) : (b.A ?? 0) + (b.V ?? 0) * 0.3 + (item.enchantment ? 2 : 0);
      case 'shield':    return (b.A ?? 0) + (item.enchantment ? 2 : 0);
      case 'speed':     return item.id === profile(p).guildExtra && !M(p).bossMode ? 100 : (b.V ?? 0);
      case 'charisma':  return (b.C ?? 0) * 0.5;
      case 'magic':     return item.id === profile(p).guildExtra && !M(p).bossMode ? 100 : (b.M ?? 0) * 0.3;
    }
    return -INF;   // slots we don't use
  }
  // Main-stat value of a weapon once it carries our enchant (re-enchanting is a Master trip).
  // Guild weapons are the build's identity (special effect, levels): always preferred.
  function weaponScore(p, item) {
    const pr = profile(p), ms = pr.main;
    let v = item.statBonus?.[ms] ?? 0;
    const lv = item.guild ? (p.guildItemLevels?.[item.id]?.itemLevel ?? 1) - 1 : 0;
    v += lv;
    const statEnch = e => e?.effect?.type === 'stat_bonus' && e.effect.stat === ms ? e.effect.value : 0;
    if (item.enchantment) v += statEnch(item.enchantment) || 1;
    else v += (statEnch(ENCHANTMENTS.find(e => e.id === pr.weaponEnchant)) || 1) - 0.5;   // potential, slightly discounted
    return (pr.guildWeapon && item.id === pr.weapon ? 100 : 0) + v;
  }
  function wantCloak(p) {
    const k = M(p).goal?.kind;
    return p.hasPrincess || RUSH.has(k) || k === 'hunt' || !!M(p).cloakNeeded;
  }
  // Evaluate fn() as if our best real armor were worn instead of the cloak.
  function withRealArmor(p, fn) {
    if (!p.hasEquipped('invis_cloak')) return fn();
    const saved = p.equipped.armor;
    const alt = ['hv_armor','md_armor','lt_armor','jacket'].find(id => p.hasItem(id));
    p.equipped.armor = alt ? invItem(p, alt) : null;
    try { return fn(); } finally { p.equipped.armor = saved; }
  }
  function wantedSlots(p, boss = M(p).bossMode) {
    const pr = profile(p);
    const sl = (boss && pr.bossSlots) || pr.slots || ['W','armor','shield','speed','charisma'];
    return sl.map(x => x === 'W' ? pr.wslot : x);
  }
  // Best item per slot for the boss fight, chosen from equipped + inventory.
  function bossLoadout(p) {
    const m = M(p), saved = m.bossMode; m.bossMode = true;
    try {
      const pool = [...Object.values(p.equipped).filter(Boolean), ...new Set(p.inventory)].map(x => typeof x === 'string' ? invItem(p, x) : x).filter(it => it?.slot);
      const eq = {};
      for (const s of wantedSlots(p, true)) {
        let best = null, bv = -INF;
        for (const it of pool) if (it.slot === s) { const v = slotScore(p, it); if (v > bv) { bv = v; best = it; } }
        eq[s] = best;
      }
      return eq;
    } finally { m.bossMode = saved; }
  }
  // Inventory item as it would be once equipped (unequipped copies keep their enchantment).
  function invItem(p, id) {
    const it = getItem(id), ench = it?.slot && p.storedEnchantment?.(id);
    return ench ? { ...it, enchantment: ench } : it;
  }
  // Evaluate fn() as if wearing the boss loadout (replaces the old cloak-only version).
  function withBossLoadout(p, fn) {
    const saved = p.equipped;
    const eq = {}; for (const s of ALL_SLOTS) eq[s] = null;
    Object.assign(eq, bossLoadout(p));
    p.equipped = eq;
    try { return fn(); } finally { p.equipped = saved; }
  }

  // Returns one equip/unequip action or null.
  function equipStep(p) {
    const slots = wantedSlots(p);
    // unequip junk slots
    for (const s of ALL_SLOTS) if (p.equipped[s] && !slots.includes(s)) return { type:'unequip', slot:s };
    for (const s of slots) {
      const cur = p.equipped[s];
      let best = null, bv = cur ? slotScore(p, cur) : -INF + 1;
      for (const id of new Set(p.inventory)) {
        const it = invItem(p, id);
        if (it?.slot !== s) continue;
        const v = slotScore(p, it);
        if (v > bv) { bv = v; best = id; }
      }
      if (best) {
        if (cur) return { type:'unequip', slot:s };
        return { type:'equip', itemId:best };
      }
    }
    return null;
  }

  // Items worth keeping in inventory
  function keepItem(p, id) {
    if (id === 'pot_heal' || id === 'invis_cloak' || id === 'rope' || id === 'compass' || id === 'sp_curse' || id === 'sp_smoke') return true;
    if (id === 'chain' || id === 'sp_invisibility' || id === 'sp_teleport') return true;
    if (ATTACK_SPELLS.has(id)) return mainStat(p) === 'M';
    if (id === profile(p).weapon) return true;
    if (p.hasEquipped('invis_cloak') && getItem(id)?.slot === 'armor') return true;
    const it = getItem(id);
    if (!it) return false;
    if (/^pot_[FDACV]\d$/.test(id)) {
      const s = it.effect.stat, ms = mainStat(p);
      return s === ms || s === 'A' || s === 'V' || s === 'C';
    }
    if (it.statBonus && !it.slot) return true;                 // blood drops for the dragon
    if (id.startsWith('priest_pot')) return true;
    if (it.slot) {
      // keep an unequipped item only if it beats what's equipped in a used slot
      if (id === profile(p).guildExtra) return true;
      // part of the boss loadout — but only one copy, and not if that item is already equipped
      if (bossLoadout(p)[it.slot]?.id === id && p.equipped[it.slot]?.id !== id && p.inventory.indexOf(id) === p.inventory.lastIndexOf(id)) return true;
      if (!wantedSlots(p, false).includes(it.slot) && !wantedSlots(p, true).includes(it.slot)) return false;
      if (!wantedSlots(p, false).includes(it.slot)) {          // boss-only slot: keep the best one
        const others = p.inventory.filter(x => x !== id && getItem(x)?.slot === it.slot);
        return others.every(x => slotScore(p, getItem(x)) <= slotScore(p, it));
      }
      const cur = p.equipped[it.slot];
      return !cur || slotScore(p, it) > slotScore(p, cur);
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Shop / Master / Guild handlers (one action per call)
  // ════════════════════════════════════════════════════════════════════════════
  function act(a) { Game.submitAction(a); }

  function handleShop(p) {
    const st = Game.getState();
    const pos = st.currentShopPosition;
    const stock = pos ? st.shopStocks?.[`${pos.x},${pos.y}`] : null;
    const avail = id => !stock || (stock[id] ?? 0) > 0;

    const eq = equipStep(p);
    if (eq) return act(eq);

    // sell junk
    for (const id of p.inventory) if (!keepItem(p, id) && getItem(id)?.buyPrice) return act({ type:'sell', itemId:id });

    // shopping list in strict order
    for (const it of shoppingList(p)) {
      if (it.where !== 'shop' && it.where !== 'guild') continue;
      if (!avail(it.id) || !getItem(it.id)) continue;
      if (it.where === 'guild' && !stock?.[it.id]) continue;
      if (p.coins >= it.cost) { M(p).banned = {}; return act({ type:'buy', itemId:it.id }); }
      break;
    }
    if (M(p).goal?.heal && avail('pot_heal')) {
      const need = p.hearts.max - p.hearts.current - p.inventory.filter(x => x === 'pot_heal').length;
      if (need > 0 && p.coins >= 50) return act({ type:'buy', itemId:'pot_heal' });
    }
    // dragon kit
    if (shoppingList(p).length === 0) {
      const plan = cachedPlan(p);
      if (plan.winP >= 0.8 || M(p).goal?.kit) {
        for (const id of plan.kit) if (!MASTER_ONLY.has(id) && avail(id) && p.coins >= getItem(id).buyPrice)
          return act({ type:'buy', itemId:id });
      }
    }
    // we came here for something that is not in stock → ban this shop for that goal
    const g = M(p).goal;
    if (g?.kind === 'shop' && pos && g.items.some(id => !avail(id))) M(p).banned[`${pos.x},${pos.y}`] = true;
    return act({ type:'close' });
  }

  function handleMaster(p) {
    const st0 = Game.getState();
    const eq = equipStep(p);
    if (eq) return act(eq);
    for (const it of shoppingList(p)) {
      if (it.where !== 'master') continue;
      if (p.coins < it.cost) break;
      if (it.skill)   return act({ type:'buy_skill', stat:it.skill });
      if (it.buySpell) return act({ type:'buy', itemId:it.buySpell });
      if (it.enchant && p.equipped[it.slot] && !p.equipped[it.slot].enchantment)
        return act({ type:'enchant', slot:it.slot, enchantId:it.enchant, tier:1 });
    }
    if (shoppingList(p).length === 0) {
      const plan = withBossLoadout(p, () => cachedPlan(p));
      if (plan.winP >= 0.8 || M(p).goal?.kit) {
        for (const id of plan.kit) if (MASTER_ONLY.has(id) && masterStock(id) > 0 && p.coins >= getItem(id).buyPrice)
          return act({ type:'buy', itemId:id });
      }
      if (wantStockpile(p) && p.coins - 50 >= 200) return act({ type:'buy', itemId:'sp_curse' });
    }
    return act({ type:'close' });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Combat
  // ════════════════════════════════════════════════════════════════════════════
  function attackTypes(p) { return p.canAttackMagic() ? ['F','D','M'] : ['F','D']; }
  function chooseCombatAction(p, mob, useSpells = false) {
    if (p.hasEquipped('garrote') && mob.hearts.current <= 2) return { type:'attack', attackType:'F' };
    const types = attackTypes(p);
    const a = bestAttackStat(Object.fromEntries(types.map(s => [s, p.getStat(s)])), currentMobStats(mob), types);
    const action = { type:'attack', attackType:a };
    if (a === 'M' && useSpells) {
      const ids = castableSpells(p);
      if (ids.length) {
        const stunned = (mob.statusEffects ?? []).some(e => e.type === 'lightning');
        const i = pickSpell(ids.map(getItem), p.hasEquipped('dark_tome') ? 2 : 1, stunned);
        action.spellId = ids[i];
      }
    }
    return action;
  }
  function currentMobStats(mob) {
    const s = { ...mob.stats };
    for (const e of mob.statusEffects ?? []) if (e.stat) s[e.stat] = Math.max(0, (s[e.stat] ?? 0) + e.value);
    return s;
  }

  function bestPot(p, stat) {
    let best = null, bv = 0;
    for (const id of p.inventory) {
      const it = getItem(id);
      if (/^pot_/.test(id) && it?.effect?.stat === stat && it.effect.value > bv) { bv = it.effect.value; best = id; }
    }
    return best;
  }

  function combatTurn(p, state) {
    const c = state.pendingCombat;
    if (!c) return;
    const sub = c.combatSubPhase;
    const big = c.isBoss;                                   // spend potions on bosses
    if (sub === 'charisma_pick') return act({ type:'charisma_outcome', retreat:true });
    if (sub === 'friend_fighting') return act({ type:'friend_round' });
    if (sub === 'friend_died')     return act({ type:'friend_take_over' });

    if (sub === 'mob_attack') {
      if (p.hearts.current === 1 && p.hasItem('pot_heal')) return act({ type:'use_item', itemId:'pot_heal' });
      const t = c.mobNextAttackType;
      if (big && t) {
        const ds = t === 'M' && p.hasEnchantment('arcane') ? 'A' : DEF[t];
        if (!p.hasTempBonus(ds)) { const pot = bestPot(p, ds); if (pot) return act({ type:'use_item', itemId:pot }); }
        if (!p.isSmokeActive && p.hasItem('sp_smoke')) {
          const def = p.getStat(ds) + (t === 'M' && !p.hasEnchantment('arcane') ? (p._equippedDefenseSpell?.()?.armorValue ?? 0) : 0);
          if (smokeWorth(def, currentMobStats(c.mob)[t], p.hearts.current)) {
            // Smoke emits no combat_update (game.js returns early), so defend in the same call.
            Game.submitAction({ type:'use_item', itemId:'sp_smoke' });
            return act({ type:'defend' });
          }
        }
      }
      return act({ type:'defend' });
    }

    // player_attack
    if (big) {
      // blood drops once at the start of a boss fight
      for (const id of p.inventory) {
        const it = getItem(id);
        if (it?.statBonus && !it.slot) {
          const fresh = Object.keys(it.statBonus).some(s => !p.statusEffects.some(e => e.type === 'drop_bonus' && e.stat === s));
          if (fresh) return act({ type:'use_item', itemId:id });
        }
      }
    }
    if (big && p.hasItem('sp_curse') && !c.curseUsedThisTurn) {
      const st = Object.fromEntries(['F','D','A','M','C','V'].map(s => [s, p.getStat(s)]));
      const active = new Set((c.mob.statusEffects ?? []).filter(e => e.type === 'malus').map(e => e.stat));
      const cs = curseChoice(st, currentMobStats(c.mob), p.hasEnchantment('arcane'), active, attackTypes(p), p.hasEquipped('blowpipe'));
      if (cs) return act({ type:'use_curse', stat:cs });
    }
    const atk = chooseCombatAction(p, c.mob, big);
    if (big && !p.hasTempBonus(atk.attackType)) {
      const pot = bestPot(p, atk.attackType);
      if (pot) return act({ type:'use_item', itemId:pot });
    }
    // Stealth Shoes: never risk the last heart in an ordinary fight
    if (!big && p.hearts.current === 1 && canAlwaysEscape(p)) return act({ type:'bail' });
    // Desperate: last heart, no heal, ordinary fight → try to escape
    if (!big && p.hearts.current === 1 && !p.hasItem('pot_heal')) {
      if (p.canEscape()) return act({ type:'bail' });
    }
    return act(atk);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PvP — after the dragon dies (princess free) players fight each other.
  // ════════════════════════════════════════════════════════════════════════════
  const PDEF = { F:'A', D:'V', M:'M' };
  function rivals(p) { return Game.getState().players.filter(q => q !== p && q.isAlive); }
  function rivalsAlive(p) { return rivals(p).length > 0; }
  function pvpOccupied(p) {
    const st = Game.getState(), occ = new Set();
    if (!st.pvpActive) return occ;
    for (const q of rivals(p)) occ.add(q.position.y * W + q.position.x);
    return occ;
  }

  // ── simultaneous fight model (mirrors game.js resolvePvpRound) ───────────────
  function pvpSide(p) {
    const s = snapshot(p, { usePots:true });
    s.atk = p.canAttackMagic() ? ['F','D','M'] : ['F','D'];
    s.defM = p.hasEnchantment('arcane') ? s.st.A : s.st.M + s.prot;
    return s;
  }
  const defVal = (side, t) => t === 'M' ? side.defM : side.st[PDEF[t]];
  function pvpAttackType(me, opp) {
    let best = me.atk[0], bv = -INF;
    for (const t of me.atk) { const v = me.st[t] - defVal(opp, t); if (v > bv) { bv = v; best = t; } }
    return best;
  }
  // Alternating fight with V initiative (mirrors game.js): the attacker picks its best stat and an
  // attack potion; the defender answers the announced attack with a defence potion, heals at 1
  // heart, and uses Smoke on its last heart when out of heals.
  function simPvpOnce(A0, B0) {
    const S = [A0, B0].map(o => ({ o, hp: o.hearts, heals: o.heals, smokes: o.smokes,
      pots: Object.fromEntries(Object.entries(o.pots).map(([k, v]) => [k, v.slice()])), spells: o.spells.slice(), fire: 0 }));
    let ra, rb; do { ra = A0.st.V + d6(); rb = B0.st.V + d6(); } while (ra === rb);
    let i = ra > rb ? 0 : 1;
    for (let r = 0; r < 160; r++) {
      const a = S[i], d = S[1 - i];
      if (a.fire) { a.hp -= a.fire; a.fire = 0; if (a.hp <= 0) return i === 1; }
      if (a.hp === 1 && a.heals > 0) { a.heals--; a.hp++; }
      const t = pvpAttackType(a.o, d.o);
      let atk = a.o.st[t] + d6(); if (a.pots[t]?.length) atk += a.pots[t].shift();
      if (t === 'M' && a.spells.length) { const k = pickSpell(a.spells, a.o.tome, false); atk += a.spells.splice(k, 1)[0].magicValue * a.o.tome; }
      // defender's answer
      if (d.hp === 1 && d.heals > 0) { d.heals--; d.hp++; }
      const ds = t === 'M' && d.o.arcane ? 'A' : PDEF[t];
      let def = defVal(d.o, t) + d6(); if (d.pots[ds]?.length) def += d.pots[ds].shift();
      const smoked = d.hp === 1 && d.heals === 0 && d.smokes > 0 && atk > def ? (d.smokes--, true) : false;
      if (atk > def && !smoked) {
        if (a.o.garrote && t === 'F' && d.hp <= 2) d.hp = 0;
        else if (d.o.thorns && Math.random() < 0.3) a.hp--;
        else { d.hp--; if (a.o.flame) d.fire++; }
      }
      if (d.hp <= 0) return i === 0;
      if (a.hp <= 0) return i === 1;
      i = 1 - i;
    }
    return S[0].hp >= S[1].hp;
  }
  // P(A beats B) in a fight to the death, both using their consumables.
  function simPvp(A, B, n = 300) { let w = 0; for (let i = 0; i < n; i++) if (simPvpOnce(A, B)) w++; return w / n; }
  const _pvpCache = {};
  function pvpWinP(p, q, n = 200) {
    const k = `${p.id}>${q.id}|${p.hearts.current},${q.hearts.current}|${p.inventory.length},${q.inventory.length}|${['F','D','A','M','V','C'].map(s => p.getStat(s) + ':' + q.getStat(s)).join()}`;
    return _pvpCache[k] ??= simPvp(pvpSide(p), pvpSide(q), n);
  }

  // ── in-fight decisions (called for every bot participant that hasn't chosen yet) ──
  function pvpTick() {
    const st = Game.getState(), pv = Game.getPvpView?.();
    if (st.phase !== Game.Phase.PVP_COMBAT || !pv) return;
    for (const id of pv.waitingFor) {
      const p = st.players.find(q => q.id === id);
      if (p?.isBot) pvpAct(p, pv);
      if (Game.getState().phase !== Game.Phase.PVP_COMBAT) return;
    }
  }
  function pvpAct(p, pv) {
    const st = Game.getState();
    const oppId = pv.players.find(x => x.id !== p.id).id;
    const opp = st.players.find(q => q.id === oppId);
    const meV = pv.players.find(x => x.id === p.id), oppV = pv.players.find(x => x.id === oppId);
    const use = itemId => Game.submitAction({ type:'pvp_use_item', playerId:p.id, itemId });

    if (pv.step === 'defend') {
      // answer the announced attack: heal on the last heart, matching defence potion, smoke if desperate
      const t = pv.pendingAttack.attackType;
      while (p.hearts.current <= 1 && p.hasItem('pot_heal')) use('pot_heal');
      const ds = t === 'M' && p.hasEnchantment('arcane') ? 'A' : PDEF[t];
      if (!p.hasTempBonus(ds)) { const pot = bestPot(p, ds); if (pot) use(pot); }
      if (p.hearts.current <= 1 && !p.hasItem('pot_heal') && p.hasItem('sp_smoke') && !meV.smoke) use('sp_smoke');
      return Game.submitAction({ type:'pvp_defend', playerId:p.id });
    }

    // our action
    const choose = choice => Game.submitAction({ type:'pvp_choose', playerId:p.id, choice });
    while (p.hearts.current <= 1 && p.hasItem('pot_heal')) use('pot_heal');
    if (pv.round === 1) for (const id of [...new Set(p.inventory)]) { const it = getItem(id); if (it?.statBonus && !it.slot) use(id); }

    const winP = simPvp(pvpSide(p), pvpSide(opp), 250);
    const oppCanFlee = !oppV.chained && (opp.hasItem('rope') || opp.hasItem('sp_invisibility') || opp.hasEquipped('stealth_shoes') || opp.getStat('V') >= p.getStat('V') + 2);
    if (!oppV.chained && p.hasItem('chain') && oppCanFlee && (winP >= 0.5 || opp.hasPrincess)) use('chain');

    const fleeBelow = p.hasPrincess ? 0.5 : 0.35;
    if (winP < fleeBelow && !meV.chained) {
      if (p.hasItem('rope'))            return choose({ kind:'rope' });
      if (p.hasItem('sp_invisibility')) return choose({ kind:'invisibility' });
      if (p.hasEquipped('stealth_shoes') || p.getStat('V') >= opp.getStat('V') + 2) return choose({ kind:'run' });
      if (p.getStat('C') >= opp.getStat('C') + 3) return choose({ kind:'charm' });
    }
    const me = pvpSide(p), them = pvpSide(opp);
    const t = pvpAttackType(me, them);
    if (!p.hasTempBonus(t)) { const pot = bestPot(p, t); if (pot) use(pot); }
    const choice = { kind:'attack', attackType:t };
    if (t === 'M') { const ids = castableSpells(p); if (ids.length) choice.spellId = ids[pickSpell(ids.map(getItem), p.hasEquipped('dark_tome') ? 2 : 1, false)]; }
    return choose(choice);
  }

  // ── movement: landing on players, danger zones ──────────────────────────────
  function pvpLandingAdjust(p, x, y, goal) {
    const st = Game.getState(); if (!st.pvpActive) return null;
    const q = rivals(p).find(r => r.position.x === x && r.position.y === y);
    if (!q) return null;
    if (goal.kind === 'hunt' && q === carrier(p)) {       // the whole point: attack the carrier
      const w = pvpWinP(p, q);
      return w >= 0.25 ? -40 - 60 * w : 200;
    }
    if (!p.hasPrincess && st.princess && !st.princess.carriedBy && st.princess.x === x && st.princess.y === y) {
      const w = pvpWinP(p, q);                             // someone stands on the free princess
      return w >= 0.5 ? -30 : 1000;
    }
    return 1000;                                           // don't start pointless fights
  }
  let _danger = null;
  // Tiles each dangerous rival can land on next turn (their max roll), weighted by how badly we'd lose.
  function prepareDanger(p) {
    _danger = null;
    const st = Game.getState(); if (!st.pvpActive || !p.hasPrincess) return;   // hunters only go after the carrier
    const threats = rivals(p);
    const dz = new Map();
    for (const q of threats) {
      const lose = 1 - pvpWinP(p, q);
      if (lose < 0.3) continue;
      const reach = Movement.getReachable(q.position, q.getStat('V') + 6, q);
      reach.forEach((_, key) => dz.set(key, Math.max(dz.get(key) ?? 0, lose)));
    }
    _danger = { dz, weight: p.hasPrincess ? 120 : 40 };
  }
  function dangerAt(p, x, y) { if (!_danger) return 0; const v = _danger.dz.get(`${x},${y}`); return v ? v * _danger.weight : 0; }

  // ── hunting the carrier: ambush a tile on their route or chase them ─────────
  function carrier(p) {
    const st = Game.getState(), pr = st.princess;
    if (!st.pvpActive || !pr) return null;
    if (pr.carriedBy) return pr.carriedBy === p?.id ? null : (st.players.find(q => q.id === pr.carriedBy && q.isAlive) ?? null);
    return st.players.find(q => q !== p && q.isAlive && q.position.x === pr.x && q.position.y === pr.y) ?? null;
  }
  const ownsCloak = q => q.hasEquipped('invis_cloak') || q.hasItem('invis_cloak');
  function routeTiles(c) {
    const fin = tilesOf(TileType.FINISH);
    const toFin = field(c, fin, ownsCloak(c)), fromC = field(c, [c.position], ownsCloak(c));
    const T = toFin[c.position.y * W + c.position.x];
    const out = [];
    if (T >= INF) return out;
    for (let i = 0; i < W * H; i++) if (toFin[i] < T && fromC[i] + toFin[i] <= T + 1) out.push({ x: i % W, y: (i / W) | 0, dc: fromC[i] });
    return out;
  }
  // Intercept planning in "actions": whenever we act, the carrier's next move comes before our
  // next action (whatever the seating order). The carrier reaches route tile t on its move
  // rc = ceil(dist/speed); we block t if we can stand there within rh ≤ rc of our actions.
  // A teleport costs one action and puts us on a shop/master/guild tile.
  function huntPlan(p) {
    const c = carrier(p); if (!c) return null;
    const m = M(p);
    if (m.huntPlan && m.huntPlan.turn === m.turns && m.huntPlan.cid === c.id) return m.huntPlan;
    const speed = q => Math.max(4, q.getStat('V') + 3.5);
    const sc = speed(c), sh = speed(p);
    const tiles = routeTiles(c).filter(t => t.dc >= 1).sort((a, b) => a.dc - b.dc);
    const sample = tiles.filter((_, i) => i % 2 === 0).slice(0, 30);
    const dests = p.hasItem('sp_teleport') && !p.hasPrincess
      ? [...tilesOf(TileType.SHOP), ...tilesOf(TileType.MASTER), ...tilesOf(TileType.GUILD_ASSASSIN), ...tilesOf(TileType.GUILD_THIEF)]
          .filter(d => !rivals(p).some(q => q.position.x === d.x && q.position.y === d.y))   // don't teleport into another hunter
      : [];
    let best = null;
    for (const t of sample) {
      const f = field(p, [t], ownsCloak(p));
      const rc = Math.max(1, Math.ceil(t.dc / sc));
      const dWalk = f[p.position.y * W + p.position.x];
      let rh = dWalk < INF ? Math.ceil(dWalk / sh) : INF, via = null;
      for (const d of dests) { const dd = f[d.y * W + d.x]; if (dd >= INF) continue; const r = 1 + Math.ceil(dd / sh); if (r < rh) { rh = r; via = d; } }
      // prefer blocking early; among equal, the tile closest to the carrier
      if (rh <= rc && (!best || rh < best.rh || (rh === best.rh && t.dc < best.dc))) best = { tile: { x: t.x, y: t.y }, rh, rc, via, dc: t.dc };
    }
    m.huntPlan = { turn: m.turns, cid: c.id, ...(best ?? { tile: null }) };
    return m.huntPlan;
  }
  function huntTargets(p) {
    const c = carrier(p); if (!c) return [];
    const plan = huntPlan(p);
    const out = [{ x: c.position.x, y: c.position.y }];          // landing on the carrier = fight
    if (plan?.tile) out.push({ ...plan.tile, bias: 0 });
    return out;
  }

  // ── before the dragon falls: get in position when a rival is about to kill it ─
  function stagingGoal(p) {
    if (!rivalsAlive(p) || !p.hasItem('sp_teleport')) return null;
    const dr = bossPos('dragon'); if (!dr) return null;
    const close = rivals(p).some(q => Math.abs(q.position.x - dr.x) + Math.abs(q.position.y - dr.y) <= 3);
    if (!close) return null;
    if ((M(p).lastDragonP ?? 0) >= tune(p).dragonGo) return null;           // we're about to go ourselves
    // the shop nearest to the dragon→finish corridor
    const shop = tilesOf(TileType.SHOP).reduce((b, s) => (Math.abs(s.x - 40) + Math.abs(s.y - 10)) < (Math.abs(b.x - 40) + Math.abs(b.y - 10)) ? s : b);
    if (p.position.x === shop.x && p.position.y === shop.y) return null;
    return { kind:'stage', tile: shop, via: shop };
  }

  // ── pre-move actions in PvP: teleport for an ambush / staging, invisibility to sneak ─
  function pvpPreMove(p) {
    const st = Game.getState(), m = M(p);
    const g = m.goal;
    if (g?.kind === 'stage' && p.hasItem('sp_teleport')) {
      const f = field(p, [g.tile]);
      if (f[p.position.y * W + p.position.x] > 20) { m.teleportDest = g.via; Game.submitAction({ type:'use_item', itemId:'sp_teleport' }); return true; }
    }
    if (g?.kind === 'hunt') {
      const plan = huntPlan(p);
      if (plan?.via && p.hasItem('sp_teleport')) { m.teleportDest = plan.via; Game.submitAction({ type:'use_item', itemId:'sp_teleport' }); return true; }
    }
    // invisibility spell: sneak past minibosses when it shortens the trip a lot (carrier or hunter)
    if (st.pvpActive && !p.hasEquipped('invis_cloak') && !p.invisibleThisTurn && p.hasItem('sp_invisibility') && (g?.kind === 'finish' || g?.kind === 'hunt')) {
      const tg = goalTargets(p, g);
      if (tg.length) {
        const a = field(p, tg)[p.position.y * W + p.position.x], b = field(p, tg, true)[p.position.y * W + p.position.x];
        if (a - b >= 8) Game.submitAction({ type:'use_item', itemId:'sp_invisibility' });
      }
    }
    return false;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Main dispatcher
  // ════════════════════════════════════════════════════════════════════════════
  function takeTurn(player) {
    if (Game.getCurrentPlayer() !== player) return;
    const state = Game.getState();
    const P = Game.Phase;
    const m = M(player);

    switch (state.phase) {
      case P.ROLL_MOVE: {
        // all non-roll actions here are synchronous and do not need re-triggering
        // drink heal potions outside combat when low — unless they are the dragon kit
        const saving = shoppingList(player).length === 0 && !Game.getState().pvpActive;
        while (player.hearts.current <= 2 && player.hasItem('pot_heal') && !saving) Game.submitAction({ type:'use_item', itemId:'pot_heal' });
        if (m.goal?.heal) while (player.hearts.current < player.hearts.max && player.hasItem('pot_heal')) Game.submitAction({ type:'use_item', itemId:'pot_heal' });
        // PvP: the carrier (dragon drop: 10 healing potions) and hunters top up before moving
        if (Game.getState().pvpActive && (player.hasPrincess || carrier(player)))
          while (player.hearts.current < player.hearts.max - (player.hasPrincess ? 0 : 1) && player.hasItem('pot_heal')) Game.submitAction({ type:'use_item', itemId:'pot_heal' });
        // last resort: stuck on an idle goal while damaged → drink from the kit
        if (['refresh','earn'].includes(m.goal?.kind) && m.sameGoalTurns >= 6)
          while (player.hearts.current < player.hearts.max && player.hasItem('pot_heal')) Game.submitAction({ type:'use_item', itemId:'pot_heal' });
        // no-progress detector: same goal, distance not improving for 8 turns → ban it for 15 turns
        if (m.goal) {
          const k = goalKey(m.goal);
          if (k !== m.progKey) { m.progKey = k; m.progBest = m.lastDist ?? INF; m.progStall = 0; }
          else if ((m.lastDist ?? INF) < m.progBest - 0.5) { m.progBest = m.lastDist; m.progStall = 0; }
          else if (++m.progStall >= 8) { (m.goalBan ??= {})[k] = m.turns + 15; m.progStall = 0; m.progKey = null; }
        }
        m.goal = chooseGoal(player);
        const gk = JSON.stringify([m.goal.kind, m.goal.tier ?? '', (m.goal.items ?? []).join()]);
        m.sameGoalTurns = gk === m.lastGoalKey ? m.sameGoalTurns + 1 : 0;
        m.lastGoalKey = gk;
        m.turns++;
        m.bossMode = false;
        for (let k = 0; k < 12; k++) { const eq = equipStep(player); if (!eq) break; Game.submitAction(eq); }
        if (pvpPreMove(player)) return;      // used a teleport (turn continues in TELEPORT_CHOICE)
        return act({ type:'roll' });
      }
      case P.MOVING: {
        const dest = chooseMove(player, state);
        const fightsRival = Game.getState().pvpActive && rivals(player).some(q => q.position.x === dest.x && q.position.y === dest.y);
        if (MapGrid.get(dest.x, dest.y) === TileType.BOSS || fightsRival) {
          // switch to the boss loadout before landing (cloak → armor, shoes → Pegasus, bag → Accordion)
          m.bossMode = true;
          for (let k = 0; k < 12; k++) { const eq = equipStep(player); if (!eq) break; Game.submitAction(eq); }
        }
        return act({ type:'move', dest });
      }
      case P.COMBAT:          return combatTurn(player, state);
      case P.SHOP:            return handleShop(player);
      case P.MASTER:          return handleMaster(player);
      case P.CLOAK_CHOICE: {
        const mob = state.pendingCloakMob;
        const farming = m.goal?.kind === 'farm' && mob && mob.tier === m.goal.tier;
        return act({ type: farming ? 'cloak_fight' : 'cloak_sneak' });
      }
      case P.TELEPORT_CHOICE: {
        const d = m.teleportDest; m.teleportDest = null;
        return d ? act({ type:'teleport_confirm', dest:d }) : act({ type:'close' });
      }
      case P.PVP_COMBAT:      return pvpTick();
      case P.MAP_CHOICE:      return act({ type:'map_roll', value:6 });
      case P.CHEST: {
        const rolls = state.pendingChestRolls ?? [];
        return act({ type:'chest_pick', value: rolls.length ? Math.max(...rolls) : 6 });
      }
      case P.PRIEST: case P.WORK: case P.STOP_BLOCKED: case P.LOOT_CONFIRM:
      default:
        return act({ type:'tile_confirm' });
    }
  }

  function getPhase(p) {
    const g = M(p).goal;
    if (!g) return 'idle';
    return `[${profile(p).name}] ` + g.kind + (g.tier != null ? `:t${g.tier}` : '') + (g.items ? `:${g.items.join('+')}` : '') + (g.what?.skill ? `:skill_${g.what.skill}` : '') + (g.what?.enchant ? `:${g.what.enchant}` : '') + (g.kind === 'boss' ? `:${g.id}` : '');
  }

  function getStrategy(p) { return profile(p).name; }

  return { takeTurn, chooseCombatAction, getPhase, configure, getStrategy, pvpTick,
           _debug: { bossLoadout, withBossLoadout, reach: (p, c) => { const f = field(p, tilesOf(TileType.FINISH), c); return f[p.position.y * W + p.position.x] < INF; }, huntPlan, carrier, simPvp, snapshot, curseChoice, smokeWorth, planKit, dragonWinP, tierWinP, tierStats, farmTier, shoppingList, chooseGoal, simFight, snapshot, mem } };
})();
