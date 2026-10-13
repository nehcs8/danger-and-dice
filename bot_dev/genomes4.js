// Thorns on the shield (instead of Resistance) for every strategy, plus D with extraEnch 'sim'.
// Compare with the DEV3 rows in eval_results.txt (same seeds; the default bot is unchanged).
const B = 'F,D,FB,DB,DG,DBG,M,G,GB,BP,DT,SS,BB,BM,CH,CR'.split(',');
const g = (base, tune = {}, label) => ({ base, tune, label: label ?? base });
console.log(JSON.stringify([
  ...B.map(b => g(b, { shieldEnch:'thorns' }, b + ' shield Thorns')),
  g('D', { extraEnch:'sim' }, 'D extraEnch sim'),
]));
