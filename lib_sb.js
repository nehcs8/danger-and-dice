// Shared sandbox loader for my scripts.
// All engine files are concatenated into ONE function scope inside the vm context:
// top-level consts become closure locals and the builtins are aliased locally, so lookups
// skip the vm's global interceptor (which made every `Math`/`MOBS`/`getItem` access ~10-25x slower).
const fs=require('fs'),vm=require('vm');
const BUILTINS='Math,Array,Float32Array,Float64Array,Uint8Array,Int8Array,Int32Array,Uint16Array,ArrayBuffer,Object,JSON,Set,Map,Date,RegExp,String,Number,Boolean,Error,parseInt,parseFloat,isNaN,isFinite,Infinity,NaN,console,setTimeout,clearTimeout,window,document';
// seed (optional): replaces Math.random with a deterministic PRNG so a game can be replayed exactly.
function seededMath(seed){
  let a=seed>>>0;
  const m=Object.create(Math);
  m.random=()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};
  return m;
}
function makeSandbox(botFile='js/engine/bot_v2.js', extra=[], seed=null){
  const sb={Math:seed==null?Math:seededMath(seed),Array,Float32Array,Float64Array,Uint8Array,Int8Array,Int32Array,Uint16Array,ArrayBuffer,Object,JSON,Set,Map,Date,RegExp,String,Number,Boolean,Error,parseInt,parseFloat,isNaN,isFinite,Infinity,NaN,
    console:{log(){},warn(){},error:console.error.bind(console)},setTimeout(){},clearTimeout(){},window:{},document:{getElementById:()=>null}};
  vm.createContext(sb);
  const files=['js/engine/dice.js','js/data/items.js','js/data/mobs.js','js/data/map.js','js/engine/player.js','js/engine/movement.js','js/engine/combat.js','js/engine/game.js',...extra,botFile].filter(Boolean);
  const src=`(function(){const {${BUILTINS}}=globalThis;
const KingBattle=(()=>{let w=null;return{init:(p,a,b)=>{w=a},resolveWin:()=>{const f=w;w=null;if(f)f()},clearState(){},getState:()=>({})}})();
${files.map(f=>`// ── ${f}\n${fs.readFileSync(f,'utf8')}`).join('\n;\n')}
;return n=>eval(n);})()`;
  sb.__get=vm.runInContext(src,sb,{filename:'sandbox_bundle.js'});
  return sb;
}
module.exports={makeSandbox, get:(sb,n)=>sb.__get(n)};
