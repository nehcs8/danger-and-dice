// Solo test of the screened enchant kits (results/enchant/ranking.json from enchant_screen.js):
// per strategy, the bot's own kit (no override), the top 3 kits and the best-ranked kit with Thorns.
const R = require('../results/enchant/ranking.json');
const out = [];
for (const [base, list] of Object.entries(R)) {
  const kits = list.filter(r => r.kit !== '(bot kit)').map(r => r.kit);
  const pick = kits.slice(0, 3);
  const th = kits.find(k => /thorns/.test(k) && !pick.includes(k));
  if (th) pick.push(th);
  out.push({ base, tune: {}, label: `${base} (bot kit)` });
  for (const kit of pick) out.push({ base, tune: { kit }, label: `${base} ${kit}` });
}
console.log(JSON.stringify(out));
