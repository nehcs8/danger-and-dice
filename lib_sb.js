// Shared sandbox loader for my scripts
const fs=require('fs'),vm=require('vm');
function makeSandbox(botFile='js/engine/bot_v2.js', extra=[]){
  const sb={Math,Array,Float32Array,Float64Array,Uint8Array,Int32Array,Uint16Array,ArrayBuffer,Object,JSON,Set,Map,Date,RegExp,String,Number,Boolean,Error,parseInt,parseFloat,isNaN,isFinite,Infinity,NaN,
    console:{log(){},warn(){},error:console.error.bind(console)},setTimeout(){},clearTimeout(){},window:{},document:{getElementById:()=>null}};
  vm.createContext(sb);
  vm.runInContext(`const KingBattle=(()=>{let w=null;return{init:(p,a,b)=>{w=a},resolveWin:()=>{const f=w;w=null;if(f)f()},clearState(){},getState:()=>({})}})();`,sb);
  for(const f of ['js/engine/dice.js','js/data/items.js','js/data/mobs.js','js/data/map.js','js/engine/player.js','js/engine/movement.js','js/engine/combat.js','js/engine/game.js',...extra,botFile])
    if(f) vm.runInContext(fs.readFileSync(f,'utf8'),sb,{filename:f});
  return sb;
}
module.exports={makeSandbox, get:(sb,n)=>vm.runInContext(n,sb)};
