const Dice = {
  d6() { return Math.floor(Math.random() * 6) + 1; },
  d(sides) { return Math.floor(Math.random() * sides) + 1; },
  coinFlip() { return Math.random() < 0.5; },
  rollTable(entries) {
    // entries: [{ weight, value }]. Returns value of chosen entry.
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r <= 0) return e.value;
    }
    return entries[entries.length - 1].value;
  }
};
