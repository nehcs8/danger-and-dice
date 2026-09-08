const DEFENSE_FOR = { F:'A', D:'V', M:'M', C:'C' };
const ALL_SLOTS    = ['strength','dexterity','magic','charisma','speed','armor','shield'];
const MAX_EQUIPPED = 5;

class Player {
  constructor({ id, name, isBot = false }) {
    this.id     = id;
    this.name   = name;
    this.isBot  = isBot;
    this.position = { x:0, y:0 };

    this.baseStats = { F:1, D:1, A:1, M:1, C:1, V:1 };
    this.hearts    = { current:5, max:5 };
    this.coins     = 0;

    // One item per slot, max MAX_EQUIPPED slots filled at once
    this.equipped = {
      strength:null, dexterity:null, magic:null,
      charisma:null, speed:null, armor:null, shield:null
    };

    this.inventory      = [];   // item ids (strings)
    this.statusEffects  = [];   // { type, stat?, value?, turnsLeft }
    this.friendsList    = [];   // befriended mobs: { id, name, hearts, stats, lootTable }
    this.quests         = [];   // active quests: { type, targetType, count, progress, id }

    this.tempBonuses    = {};   // {stat: value} — consumed after one roll per stat
    this.priestBuff     = 0;   // +N to ALL stats for exactly one roll (from Priest tile item)
    this.transmutation  = null; // { from:'M', to:'F' } active for current fight
    this.hasPrincess    = false;
    this.guildItemLevels = {}; // itemId → { itemLevel:1..6, levelProgress:{ mbUnits, secondaryUnits } }
    this.isAlive        = true;
    this.isSmokeActive  = false; // immune to attacks this turn
    this.chainedTurns   = 0;    // turns remaining where player cannot escape
    this.usedTiles          = new Set(); // "x,y" keys of tiles already used this cycle
    this.xp                 = { F:0, D:0, A:0, M:0, C:0, V:0 };
    this.masterSkillsBought = 0;
    this.dialogueSkillsGained = 0;
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getStat(stat) {
    // Transmutation: swap magic with chosen stat for one fight
    let resolvedStat = stat;
    if (this.transmutation) {
      if (stat === this.transmutation.from) resolvedStat = this.transmutation.to;
      else if (stat === this.transmutation.to) resolvedStat = this.transmutation.from;
    }

    let value = this.baseStats[resolvedStat] ?? 0;

    for (const slot of ALL_SLOTS) {
      const item = this.equipped[slot];
      if (!item) continue;
      value += item.statBonus?.[resolvedStat] ?? 0;
      // Enchantments that grant flat stat bonuses
      if (item.enchantment?.effect?.type === 'stat_bonus' &&
          item.enchantment.effect.stat === resolvedStat) {
        value += item.enchantment.effect.value;
      }
      // Lightness enchantment removes speed malus from heavy armor
      if (resolvedStat === 'V' && item.enchantment?.effect?.type === 'remove_speed_malus') {
        const rawMalus = item.statBonus?.V ?? 0;
        if (rawMalus < 0) value -= rawMalus; // add back the malus
      }
    }

    // Status effect modifiers
    for (const e of this.statusEffects) {
      if (e.stat === resolvedStat) value += e.value; // negative = malus
    }

    // One-roll temp bonus (potions used in combat)
    value += this.tempBonuses[resolvedStat] ?? 0;

    // Priest blessing: +N to ALL stats, consumed on the very next roll
    value += this.priestBuff ?? 0;

    // Guild item level bonus: each level above 1 adds +1 to the item's boosted stat
    for (const s of ALL_SLOTS) {
      const eItem = this.equipped[s];
      if (!eItem?.guild) continue;
      const lvlData = this.guildItemLevels[eItem.id];
      if (!lvlData || lvlData.itemLevel <= 1) continue;
      const boostedStat = Object.keys(eItem.statBonus ?? {})[0];
      if (boostedStat === resolvedStat) value += lvlData.itemLevel - 1;
    }

    return Math.max(0, value);
  }

  addTempBonus(stat, value) {
    if (this.tempBonuses[stat] === undefined) this.tempBonuses[stat] = value;
  }

  hasTempBonus(stat) {
    return this.tempBonuses[stat] !== undefined;
  }

  consumeTempBonus(stat) {
    delete this.tempBonuses[stat];
    this.priestBuff = 0; // priest blessing is consumed on the first roll that uses any stat
  }

  getDefenseStat(attackType) {
    const defStat = DEFENSE_FOR[attackType];
    let value = this.getStat(defStat);

    if (attackType === 'M') {
      // Arcane enchantment: defend magic with Armor instead of Magic
      if (this.hasEnchantment('arcane')) {
        value = this.getStat('A');
      } else {
        // Protection spell adds armorValue to magic defense
        const protSpell = this._equippedDefenseSpell();
        if (protSpell) value += protSpell.armorValue ?? 0;
      }
    }

    return value;
  }

  // ── Equipment ────────────────────────────────────────────────────────────

  equippedCount() {
    return ALL_SLOTS.filter(s => this.equipped[s] !== null).length;
  }

  canEquip(item) {
    if (!ALL_SLOTS.includes(item.slot)) return false;
    if (this.equipped[item.slot] !== null) return false;
    if (this.equippedCount() >= MAX_EQUIPPED) return false;
    return true;
  }

  equip(item) {
    if (!this.canEquip(item)) return false;
    this.equipped[item.slot] = item;
    this.inventory = this.inventory.filter(id => id !== item.id);
    return true;
  }

  unequip(slot) {
    const item = this.equipped[slot];
    if (!item) return false;
    this.equipped[slot] = null;
    this.inventory.push(item.id);
    return true;
  }

  hasEquipped(itemId) {
    return ALL_SLOTS.some(s => this.equipped[s]?.id === itemId);
  }

  hasEnchantment(enchantId) {
    return ALL_SLOTS.some(s => this.equipped[s]?.enchantment?.id === enchantId);
  }

  getEnchantmentTier(enchantId) {
    for (const slot of ALL_SLOTS) {
      const item = this.equipped[slot];
      if (item?.enchantment?.id === enchantId) return item.enchantment.tier ?? 1;
    }
    return 0;
  }

  // ── Guild item levels ─────────────────────────────────────────────────────

  initGuildItemLevel(itemId) {
    if (!this.guildItemLevels[itemId]) {
      this.guildItemLevels[itemId] = { itemLevel: 1, levelProgress: { mbUnits: 0, secondaryUnits: 0 } };
    }
  }

  removeGuildItemLevel(itemId) {
    delete this.guildItemLevels[itemId];
  }

  getGuildItemLevel(itemId) {
    return this.guildItemLevels[itemId] ?? null;
  }

  applyEnchantment(slot, enchantment, tier) {
    if (!this.equipped[slot]) return false;
    this.equipped[slot].enchantment = { ...enchantment, tier };
    return true;
  }

  // ── Inventory ────────────────────────────────────────────────────────────

  addItem(itemId) { this.inventory.push(itemId); }

  removeItem(itemId) {
    const idx = this.inventory.indexOf(itemId);
    if (idx === -1) return false;
    this.inventory.splice(idx, 1);
    return true;
  }

  hasItem(itemId) { return this.inventory.includes(itemId); }

  hasCombatAttackSpell() {
    if (this.hasEquipped('cursed_ring')) return true;
    return this.inventory.some(id => {
      const item = getItem(id);
      return item && item.subtype === 'attack';
    });
  }

  getAttackSpell(spellId) {
    return getItem(spellId) ?? null;
  }

  canAttackMagic() {
    return this.hasEquipped('cursed_ring') ||
           this.inventory.some(id => getItem(id)?.subtype === 'attack');
  }

  canDefendMagic() {
    return this.hasEnchantment('arcane') ||
           this.inventory.some(id => getItem(id)?.subtype === 'defense');
  }

  _equippedDefenseSpell() {
    for (const id of this.inventory) {
      const item = getItem(id);
      if (item?.subtype === 'defense') return item;
    }
    return null;
  }

  // ── Combat helpers ───────────────────────────────────────────────────────

  canEscape() {
    if (this.chainedTurns > 0) return false;
    if (this.hasEquipped('stealth_shoes')) return true;
    return this.hasItem('rope') || this.hasItem('sp_invisibility');
  }

  consumeEscape(method = null) {
    if (this.hasEquipped('stealth_shoes')) return; // reusable
    if (method === 'sp_invisibility') { this.removeItem('sp_invisibility'); return; }
    this.removeItem('rope');
  }

  takeDamage(amount = 1) {
    if (this.isSmokeActive) return; // smoke: immune this turn
    this.hearts.current = Math.max(0, this.hearts.current - amount);
    if (this.hearts.current === 0) this.isAlive = false;
  }

  healHeart(amount = 1) {
    this.hearts.current = Math.min(this.hearts.max, this.hearts.current + amount);
  }

  addStatusEffect(effect) { this.statusEffects.push({ ...effect }); }

  tickStatusEffects() {
    this.statusEffects = this.statusEffects
      .map(e => ({ ...e, turnsLeft: e.turnsLeft - 1 }))
      .filter(e => e.turnsLeft > 0);
    this.isSmokeActive = false;
    if (this.chainedTurns > 0) this.chainedTurns--;
  }

  clearFightEffects() {
    this.statusEffects = this.statusEffects.filter(e => e.persistent);
    this.transmutation = null;
    this.isSmokeActive = false;
    this.tempBonuses   = {};
    this.priestBuff    = 0;
  }

  // ── Tile memory ──────────────────────────────────────────────────────────

  hasUsedTile(x, y)  { return this.usedTiles.has(`${x},${y}`); }
  markTileUsed(x, y) { this.usedTiles.add(`${x},${y}`); }
  refreshTiles()     { this.usedTiles.clear(); }

  // ── XP ───────────────────────────────────────────────────────────────────

  // Grants XP to stat. Threshold = baseStat × 10. Levels up and carries over excess.
  gainXP(stat, amount) {
    if (!(stat in this.xp)) return false;
    this.xp[stat] += amount;
    const threshold = this.baseStats[stat] * 10;
    if (this.xp[stat] >= threshold) {
      this.xp[stat] -= threshold;
      this.baseStats[stat]++;
      if (typeof Game !== 'undefined') {
        Game.emit('xp_levelup', { player: this.name, stat, newValue: this.baseStats[stat] });
      }
      return true;
    }
    return false;
  }

  // ── Movement ─────────────────────────────────────────────────────────────

  getMovementCap() {
    return this.getStat('V') + Dice.d6();
  }

  // ── Death & loot ─────────────────────────────────────────────────────────

  dropLoot() {
    const items = [...this.inventory];
    const equippedItems = ALL_SLOTS
      .filter(s => this.equipped[s])
      .map(s => this.equipped[s]);
    return { items, equippedItems, coins: this.coins };
  }

}
