// Zylo Slot - Node simulator extracted from game.js
// Run with: node simulator.js

const crypto = require('crypto');

// Tunables copied from game.js
const ZAP_CHANCE = 22;
const REEL_COUNT = 5;
const ROWS = 3;
let bet = 10; // default bet used by simulator

// Symbols
const WILD = {key:"WILD", icon:"👽", pay:{5:200,4:60,3:15}};
const SYMBOLS = [
  {key:"PLANET", icon:"🪐", pay:{5:150,4:40,3:12}},
  {key:"GEM",    icon:"💎", pay:{5:120,4:32,3:10}},
  {key:"ROCKET", icon:"🚀", pay:{5:100,4:24,3:8}},
  {key:"LASER",  icon:"🔫", pay:{5:80, 4:18,3:6}},
  {key:"EGG",    icon:"🥚", pay:{5:60, 4:14,3:5}},
  {key:"A",      icon:"A",  pay:{5:40, 4:10,3:4}},
  {key:"K",      icon:"K",  pay:{5:32, 4:8, 3:3}},
  {key:"Q",      icon:"Q",  pay:{5:28, 4:6, 3:2}},
];
const ALL_SYMBOLS = [WILD, ...SYMBOLS];
const WILD_INDEX = 0;

// RNG helper using Node's crypto
function randInt(n){
  if (n <= 0) return 0;
  // crypto.randomInt is available in modern Node versions
  try { return crypto.randomInt(0, n); }
  catch(e){ return Math.floor(Math.random()*n); }
}

// build reels
const reels = [];
function buildReels(){
  const makeStrip = () => {
    const strip = [];
    SYMBOLS.forEach((sym,i)=>{
      const weight =
        sym.key==="PLANET" ? 2 :
        sym.key==="GEM"    ? 3 :
        sym.key==="ROCKET" ? 4 :
        sym.key==="LASER"  ? 6 :
        sym.key==="EGG"    ? 7 :
        sym.key==="A"      ? 10 :
        sym.key==="K"      ? 12 : 12; // Q
      for (let k=0;k<weight;k++) strip.push(i+1);
    });
    return strip;
  };
  for (let r=0;r<REEL_COUNT;r++) reels[r] = makeStrip();
}

// scoring (wild substitutes left-to-right)
function scoreGrid(grid){
  let total = 0;
  for (const line of PAYLINES){
    let matchSymbol = null, count = 0;

    for (let r=0;r<REEL_COUNT;r++){
      const idx = grid[line[r]][r];
      if (idx === WILD_INDEX){ count++; continue; }
      if (matchSymbol === null){ matchSymbol = idx; count++; }
      else if (idx === matchSymbol){ count++; }
      else break;
    }

    // determine which symbol we matched (treat leading wilds as the first actual)
    let si = (matchSymbol===null) ? WILD_INDEX : matchSymbol;
    const sym = ALL_SYMBOLS[si];

    // lows can pay from 2-of-a-kind, others need 3+
    const lowKeys = new Set(["LASER","EGG","A","K","Q"]);
    const minCount = lowKeys.has(sym.key) ? 2 : 3;

    if (count >= minCount){
      const pay = sym.pay?.[count] || 0;
      if (pay > 0) total += Math.round((bet/25) * pay);
    }
  }
  return total;
}

// Paylines from original
const PAYLINES = [
  [0,0,0,0,0],[1,1,1,1,1],[2,2,2,2,2],
  [0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[0,1,1,1,2],[2,1,1,1,0],[1,0,0,0,1],
  [1,2,2,2,1],[0,0,0,1,2],[2,2,2,1,0],[0,1,0,1,0],[2,1,2,1,2],
  [1,0,1,2,1],[1,2,1,0,1],[0,2,0,2,0],[2,0,2,0,2],
  [0,2,1,0,2],[2,0,1,2,0],[0,1,2,2,1],[2,1,0,0,1],[1,1,0,1,2],[1,1,2,1,0]
];

// pureSpinOnce (logic-only)
function pureSpinOnce(opts = {}){
  const zapChance = (opts.zapChance ?? (ZAP_CHANCE));
  const zapEnabled = (opts.zapEnabled ?? true);
  const betPerSpin = (opts.betPerSpin ?? bet);

  const stops = Array.from({length: REEL_COUNT}, (_, r) => randInt(reels[r].length));
  const finals = stops.map((s, r) => Array.from({length: ROWS}, (_, row) => reels[r][(s + row) % reels[r].length]));

  let zapped = false;
  if (zapEnabled && randInt(100) < zapChance){
    zapped = true;
    const positions = [];
    for (let c=0;c<REEL_COUNT;c++) for (let row=0;row<ROWS;row++) positions.push({row, col:c});
    const count = 1 + randInt(3);
    for (let k=0;k<count;k++){
      const pick = positions.splice(randInt(positions.length),1)[0];
      finals[pick.col][pick.row] = WILD_INDEX;
    }
  }

  // build grid and score
  const grid = [[],[],[]];
  for (let r=0;r<REEL_COUNT;r++) for (let row=0;row<ROWS;row++) grid[row][r] = finals[r][row];
  const win = scoreGrid(grid);
  return { win, zapped, stops, finals, bet: betPerSpin };
}

// stats helpers
function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function stddev(a){ const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length); }
function quantile(a, q){ if (a.length===0) return 0; const b=[...a].sort((x,y)=>x-y); const i=Math.min(b.length-1, Math.max(0, Math.floor(q*(b.length-1)))); return b[i]; }

// simulate spins
function simulateSpins(n = 1000, opts = {}){
  const results = [];
  let totalBet = 0, totalWin = 0, hits = 0, zaps = 0;
  for (let i=0;i<n;i++){
    const r = pureSpinOnce(opts);
    results.push(r.win);
    totalBet += (opts.betPerSpin ?? bet);
    totalWin += r.win;
    if (r.win > 0) hits++;
    if (r.zapped) zaps++;
  }
  const rtp = (totalWin / totalBet) * 100;
  const hr = (hits / n) * 100;
  const sd = stddev(results);
  const avg = mean(results);
  const med = quantile(results, 0.5);
  const p90 = quantile(results, 0.90);
  const p99 = quantile(results, 0.99);

  const bp = (opts.betPerSpin ?? bet);
  const buckets = {"0x":0,"(0,1x]":0,"(1x,2x]":0,"(2x,5x]":0,"(5x,10x]":0,">10x":0};
  for (const w of results){
    const x = w / bp;
    if (w === 0) buckets["0x"]++;
    else if (x <= 1) buckets["(0,1x]"]++;
    else if (x <= 2) buckets["(1x,2x]"]++;
    else if (x <= 5) buckets["(2x,5x]"]++;
    else if (x <= 10) buckets["(5x,10x]"]++;
    else buckets[">10x"]++;
  }

  console.log('\nZylo Slot — RTP Simulation');
  console.table({
    Spins: n,
    BetPerSpin: bp,
    RTP: rtp.toFixed(2) + "%",
    HitRate: hr.toFixed(1) + "%",
    ZapRate: (zaps / n * 100).toFixed(1) + "%",
    AvgWin: avg.toFixed(2),
    MedianWin: med.toFixed(2),
    P90: p90.toFixed(2),
    P99: p99.toFixed(2),
    StdDev: sd.toFixed(2)
  });
  console.table(buckets);

  return { rtp, hitRate: hr, zapRate: (zaps / n * 100), avg, median: med, p90, p99, stddev: sd, buckets, n, betPerSpin: bp };
}

// build and run
buildReels();
const res = simulateSpins(10000);
console.log('\nResult object:', res);

// exit
process.exit(0);
