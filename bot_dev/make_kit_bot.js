// Writes a copy of the dev bot for tournaments (strategy_tournament.js only takes strategy names):
//   node bot_dev/make_kit_bot.js '{"F":"fury1+lightness+sharpness+2×resistance", ...}' [out]   fixed kits per strategy
//   node bot_dev/make_kit_bot.js --planner [out]                                                   enchant planner on for everyone
// then: BOT_FILE=<out> node strategy_tournament.js ...   (default out: bot_dev/bot_v2_kits.js)
const fs = require('fs'), path = require('path');
const planner = process.argv[2] === '--planner';
const out = process.argv[3] ?? path.join(__dirname, 'bot_v2_kits.js');
let src = fs.readFileSync(path.join(__dirname, 'bot_v2_dev.js'), 'utf8');
const swap = (from, to) => { if (!src.includes(from)) throw new Error(`marker not found in bot_v2_dev.js: ${from}`); src = src.replace(from, to); };
if (planner) swap('    planner: false,', '    planner: true,');
else swap('const KIT_OVERRIDES = {};', `const KIT_OVERRIDES = ${JSON.stringify(JSON.parse(process.argv[2]))};`);
fs.writeFileSync(out, src);
console.log(`${out}: ${planner ? 'planner on for every strategy' : 'fixed kits per strategy'}`);
