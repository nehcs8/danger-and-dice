const B = 'F,D,FB,DB,DG,DBG,M,G,GB,BP,DT,SS,BB,BM,CH,CR'.split(',');
const g = (base, tune = {}, label) => ({ base, tune, label: label ?? base });
console.log(JSON.stringify([
  ...B.map(b => g(b)),
  g('M', { weaponEnch:'bloodlust' }, 'M weapon Bloodlust'), g('DT', { weaponEnch:'bloodlust' }, 'DT weapon Bloodlust (old)'),
  ...['F','D','DG','CH'].map(b => g(b, { extraEnch:'sim' }, b + ' extraEnch sim')),
  g('BM', { dragonGo:0.95 }, 'BM dragonGo 0.95'),
]));
