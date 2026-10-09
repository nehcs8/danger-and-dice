// Combat training environment — Node.js only.
// Loads game engine files into an isolated vm sandbox and exposes a
// RL-style interface: reset() → obs, step(action) → {obs, reward, done}.

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

// ── vm sandbox ────────────────────────────────────────────────────────────────
// Provides the minimal globals the game engine files expect.
const sandbox = {
  Math, Array, Float32Array, Uint8Array, Int32Array,
  Object, JSON, Set, Map, Date,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
  console, setTimeout: () => {}, clearTimeout: () => {},
  window: {}, // guard against accidental window references
};
vm.createContext(sandbox);

function loadFile(relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInContext(code, sandbox);
}

loadFile('js/engine/dice.js');
loadFile('js/data/items.js');
loadFile('js/data/mobs.js');
loadFile('js/engine/player.js');
loadFile('js/engine/combat.js');

// `const` declarations in vm contexts don't become sandbox properties;
// they live in the context's lexical scope. Retrieve via runInContext.
function get(name) { return vm.runInContext(name, sandbox); }
const Dice   = get('Dice');
const MOBS   = get('MOBS');
const Player = get('Player');
const Combat = get('Combat');
const getItem = get('getItem');

// ── Constants ─────────────────────────────────────────────────────────────────

const STATS        = ['F','D','A','M','C','V'];
const ATK_TYPES    = ['F','D','M','C'];
const STATE_DIM    = 32;
const ACTION_DIM   = 5;   // 0:F  1:D  2:M  3:bail  4:run
const ACTION_NAMES = ['F','D','M','bail','run'];

// All non-boss mobs available for training episodes (sampled by tier for curriculum)
const MOB_POOL = MOBS.list.filter(m => m.tier !== undefined && !['dragon','king','witch','grand_sorcerer','supreme_werewolf','supreme_knight','sea_serpent'].includes(m.id));

// ── State vector ──────────────────────────────────────────────────────────────

function getStateVec(player, mob, pendingMobAtk) {
  const v = new Array(STATE_DIM).fill(0);
  let i   = 0;

  // Player — HP ratio and absolute
  v[i++] = player.hearts.current / Math.max(player.hearts.max, 1);
  v[i++] = Math.min(player.hearts.current, 10) / 10;

  // Player stats (effective, includes equipment/status bonuses)
  for (const s of STATS) v[i++] = Math.min(player.getStat(s), 12) / 12;

  // Potion availability per stat (any pot_X* in inventory)
  for (const s of STATS) {
    v[i++] = player.inventory.some(id => id.startsWith(`pot_${s}`)) ? 1 : 0;
  }

  // Can bail (rope / stealth_shoes / invisibility potion)
  v[i++] = player.canEscape() ? 1 : 0;

  // Player status
  v[i++] = player.statusEffects.some(e => e.type === 'fire')       ? 1 : 0;
  v[i++] = player.statusEffects.some(e => e.type === 'lightning')  ? 1 : 0;

  // Mob — HP ratio and effective stats
  v[i++] = mob.hearts.current / Math.max(mob.hearts.max, 1);
  for (const s of STATS) {
    const base = mob.stats[s] ?? 0;
    const eff  = (mob.statusEffects ?? []).reduce((a, e) => e.stat === s ? a + e.value : a, 0);
    v[i++] = Math.min(Math.max(base + eff, 0), 12) / 12;
  }

  // Mob tier (0–3)
  v[i++] = (mob.tier ?? 0) / 3;

  // Mob's pre-announced next attack type (one-hot F,D,M,C)
  for (const s of ATK_TYPES) v[i++] = pendingMobAtk === s ? 1 : 0;

  // Mob status
  v[i++] = (mob.statusEffects ?? []).some(e => e.type === 'fire')               ? 1 : 0;
  v[i++] = (mob.statusEffects ?? []).some(e => e.stat === 'V' && e.value < 0)   ? 1 : 0;

  // i == 32
  return v;
}

// Actions that are valid given current state
function getActionMask(player) {
  return [
    true,                      // 0: F attack — always available
    true,                      // 1: D attack — always available
    player.canAttackMagic(),   // 2: M attack — requires a combat spell
    player.canEscape(),        // 3: bail      — requires rope/stealth/invis
    player.chainedTurns === 0, // 4: run       — blocked if chained
  ];
}

// ── Environment ───────────────────────────────────────────────────────────────

class CombatEnv {
  constructor() {
    this.player        = null;
    this.mob           = null;
    this.fightLog      = [];
    this.pendingMobAtk = null;
    this.done          = false;
    this.stepCount     = 0;
    this._totalReward  = 0;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  static _randomPlayer(tier = 0) {
    const p    = new Player({ id: 'rl_bot', name: 'RLBot', isBot: true });
    // Stats scale with tier to match how real players progress:
    //   tier 0 → stats 1–3 (fresh start)
    //   tier 1 → stats 2–4 (some gear)
    //   tier 2 → stats 3–6 (mid-game)
    //   tier 3 → stats 4–7 (late-game)
    const lo = 1 + tier, hi = 3 + tier * 2;
    for (const s of STATS) {
      p.baseStats[s] = lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    const hp = 3 + tier + Math.floor(Math.random() * 2); // 3–4, 4–5, 5–6, 6–7
    p.hearts = { current: hp, max: hp };

    // Give potions proportional to tier (simulate having shopped)
    const potCount = tier; // 0 for t0, 1 for t1, etc.
    for (let i = 0; i < potCount; i++) {
      const s = STATS[Math.floor(Math.random() * STATS.length)];
      p.inventory.push(`pot_${s}${1 + Math.floor(Math.random() * 3)}`);
    }
    return p;
  }

  static _randomMob(tier = null) {
    const pool = tier !== null ? MOB_POOL.filter(m => m.tier === tier) : MOB_POOL;
    const tmpl = pool[Math.floor(Math.random() * pool.length)];
    return MOBS.spawn(tmpl.id);
  }

  // ── reset ────────────────────────────────────────────────────────────────

  // tier: if given, sample player and mob from that tier for curriculum learning
  reset(tier = null) {
    this.fightLog     = [];
    this.done         = false;
    this.stepCount    = 0;
    this._totalReward = 0;

    const t      = tier ?? Math.floor(Math.random() * 4);
    this.player  = CombatEnv._randomPlayer(t);
    this.mob     = CombatEnv._randomMob(t);

    const init = Combat.initFight(this.player, this.mob);
    this.fightLog.push(...(init.log ?? []));

    if (init.outcome === 'victory') {
      this.done = true;
      return { obs: this._obs(), reward: 30, done: true };
    }

    // If mob has initiative, it attacks first before the player's first turn
    if (!init.playerFirst) {
      this.pendingMobAtk = Combat.rollMobAttack(this.mob);
      const r = Combat.takeMobAttack(this.player, this.mob, this.fightLog, this.pendingMobAtk);
      if (r.outcome === 'defeat')  { this.done = true; return { obs: this._obs(), reward: -30, done: true }; }
      if (r.outcome === 'victory') { this.done = true; return { obs: this._obs(), reward:  30, done: true }; }
    }

    // Pre-roll mob's next attack type (shown in obs for strategic planning)
    this.pendingMobAtk = Combat.rollMobAttack(this.mob);
    return { obs: this._obs(), reward: 0, done: false };
  }

  // ── step ─────────────────────────────────────────────────────────────────

  // action: integer 0–4 (see ACTION_NAMES)
  step(action) {
    if (this.done) throw new Error('Call reset() before step()');
    this.stepCount++;

    // Build game action object
    let gameAction;
    if (action === 3) {
      gameAction = { type: 'bail' };
    } else if (action === 4) {
      gameAction = { type: 'run' };
    } else {
      const atkType = ['F','D','M'][action];
      let spellId = null;
      if (atkType === 'M') {
        const spell = this.player.inventory
          .map(id => getItem(id))
          .filter(i => i?.subtype === 'attack')
          .sort((a, b) => (b.magicValue ?? 0) - (a.magicValue ?? 0))[0];
        spellId = spell?.id ?? null;
      }
      gameAction = { type: 'attack', attackType: atkType, spellId };
    }

    let reward = -0.5; // small step penalty to prefer faster wins

    // ── Player attack half-turn ─────────────────────────────────────────────
    const pResult = Combat.takePlayerAttack(this.player, this.mob, gameAction, this.fightLog);
    const hitLog  = pResult.newLog ?? [];
    const didHit  = hitLog.some(l => (typeof l === 'string' ? l : l.text ?? '').startsWith('Hit!'));

    if (pResult.outcome === 'victory') {
      reward += 30;
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward, done: true };
    }
    if (pResult.outcome === 'defeat') {
      reward -= 30;
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward, done: true };
    }
    if (pResult.outcome === 'escaped') {
      // Reward escaping when low on HP, penalise fleeing healthy fights
      reward += this.player.hearts.current <= 1 ? 8 : -8;
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward, done: true };
    }
    if (didHit) reward += 4; // reward landing a hit

    // ── Mob attack half-turn ────────────────────────────────────────────────
    const hpBefore = this.player.hearts.current;
    const mResult  = Combat.takeMobAttack(this.player, this.mob, this.fightLog, this.pendingMobAtk);

    if (mResult.outcome === 'victory') {
      reward += 30;
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward, done: true };
    }
    if (mResult.outcome === 'defeat') {
      reward -= 30;
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward, done: true };
    }

    const dmgTaken = hpBefore - this.player.hearts.current;
    if (dmgTaken > 0) reward -= 5 * dmgTaken;

    // Safety cap — shouldn't happen with normal combat, but avoid infinite loops
    if (this.stepCount >= 80) {
      this.done = true;
      this._totalReward += reward;
      return { obs: this._obs(), reward: reward - 10, done: true };
    }

    // Pre-roll mob's next attack for next observation
    this.pendingMobAtk = Combat.rollMobAttack(this.mob);
    this._totalReward += reward;
    return { obs: this._obs(), reward, done: false };
  }

  _obs()        { return getStateVec(this.player, this.mob, this.pendingMobAtk); }
  getActionMask() { return getActionMask(this.player); }
}

module.exports = { CombatEnv, getStateVec, getActionMask, STATE_DIM, ACTION_DIM, ACTION_NAMES };
