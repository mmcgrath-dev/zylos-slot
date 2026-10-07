// ---------- Tunables (feel) ----------
// Normal spins: ~3.0s total for the last reel
// Zap spins:    ~5.0s total for the last reel
const BASE_SPIN_MS    = 2000;  // base spin duration for the first reel
const REEL_STAGGER_MS = 250;   // extra per subsequent reel (5 reels → +1000ms)
const ZAP_EXTRA_MS    = 2000;  // extra time when zap occurs (more suspense)
// ~1 in 12 spins = moderately rare (use fractional probability). Some APIs
// or dev helpers may still pass a percent (0-100) so use `checkChance` to
// support both forms.
const ZAP_CHANCE = 1 / 5;

// ----- Reel anticipation (outcome-aware) -----
// Extra spin time added to a reel that is genuinely about to complete an
// event this spin (3rd scatter / 3rd jackpot symbol / high-value 5-line).
const REEL_ANTICIPATION_EXT_MS = 1200; // per extended reel
const REEL_ANTICIPATION_MAX_MS = 2600; // total cap per spin

// DOM hooks (queried early; script is loaded at the end of the page so these
// nodes should exist). We keep references here for other modules to use.
const zyloEl = document.querySelector('.zylo-header-image');
const zyloOrbit = document.querySelector('.zylo-orbit');
const zapBeam = document.querySelector('.zap-beam');
const appEl = document.getElementById('app');

// local run state
let isSpinning = false;
let isZapSpin = false;
// separate flag for the visual reel animation so we don't double-trigger
let reelSpinInFlight = false;
// NEW: which reel Zylo will zap this spin (0–4)
let currentZapCol = 2; // default to middle reel
// Flag to prevent spinning during celebrations
let isCelebrating = false;

// Zap control modes: 'off' (disabled), 'auto' (random), 'manual' (trigger button)
let zapMode = 'auto';
window.zapMode = zapMode; // expose for debugging
let zapManualQueue = 0;

// Jackpot control mode: 'off' (disabled), 'auto' (normal) or 'manual' (trigger button)
let jackpotMode = 'auto';
window.jackpotMode = () => jackpotMode;

// Global configuration object for feature tuning
const CONFIG = {
  // 🎰 Jackpot math
  JACKPOT_BASE_CHANCE: 0.001,      // 0.1% normal chance (for real play)
  JACKPOT_BET_BOOST: 0.00005,      // extra chance per credit bet

  // 🧪 Debug / test mode
  JACKPOT_DEBUG_MODE: false,       // OFF for production
  JACKPOT_DEBUG_CHANCE: 0.25,      // 25% chance per spin when debug mode is on

  // Developer Mode: off by default. Ctrl+Shift+D toggles it at runtime.
  DEV_MODE: false,
};

// ---------- Zap / Zylo helpers (add near top of game.js) ----------
(function(){
  // Use existing CONFIG if present, otherwise attach/use window.CONFIG
  const cfg = (typeof CONFIG !== 'undefined') ? CONFIG : (window.CONFIG = window.CONFIG || {});

  // Do not overwrite existing CONFIG entries if they exist
  Object.assign(cfg, {
    ZAP_CHANCE: (typeof cfg.ZAP_CHANCE === 'number') ? cfg.ZAP_CHANCE : 0.04,
    ZAP_EXTRA_MS: (typeof cfg.ZAP_EXTRA_MS === 'number') ? cfg.ZAP_EXTRA_MS : 900,
    ZAP_BEAM_DURATION: 700,
    ZYLO_MOVE_DURATION: 450,
    ZYLO_RETURN_DURATION: 3000,
    ZAP_DOM_HOLD: 1000,
    ZAP_CLEANUP_DELAY: 380
  });

  // convenience wrapper (use everywhere instead of checkChance(ZAP_CHANCE))
  function tryZap() {
    if (window.zapMode === 'off') return false;
    if (window.zapMode === 'manual') {
      if (zapManualQueue <= 0) return false;
      zapManualQueue = Math.max(0, zapManualQueue - 1);
      return true;
    }
    return Math.random() < cfg.ZAP_CHANCE;
  }
  window.tryZap = tryZap;
  
  // Update zap button UI based on current mode
  function updateZapButton() {
    const zapBtn = document.getElementById('zapToggle');
    const zapTriggerBtn = document.getElementById('zapTriggerBtn');
    if (!zapBtn) return;
    
    zapBtn.classList.remove('zap-off', 'zap-force', 'active');
    
    if (window.zapMode === 'off') {
      zapBtn.textContent = '⚡ ZAP: OFF';
      zapBtn.classList.add('zap-off');
      if (zapTriggerBtn) zapTriggerBtn.style.display = 'none';
    } else if (window.zapMode === 'manual') {
      zapBtn.textContent = '⚡ ZAP: MANUAL';
      zapBtn.classList.add('zap-force');
      if (zapTriggerBtn) zapTriggerBtn.style.display = 'inline-flex';
    } else {
      zapBtn.textContent = '⚡ ZAP: AUTO';
      zapBtn.classList.add('active');
      if (zapTriggerBtn) zapTriggerBtn.style.display = 'none';
    }
  }
  window.updateZapButton = updateZapButton;

  // find index of a Wild symbol in ALL_SYMBOLS (best-effort)
  function findWildIndex() {
    if (!Array.isArray(ALL_SYMBOLS)) return -1;
    for (let i = 0; i < ALL_SYMBOLS.length; i++){
      const s = ALL_SYMBOLS[i];
      // common heuristics
      if (s && (s.code === 'WILD' || s.name === 'Wild' || s.key === 'WILD' || s.isWild)) return i;
      if (s && typeof s.icon === 'string' && s.icon.toLowerCase().includes('w')) return i;
    }
    return -1;
  }
  window.findWildIndex = findWildIndex;

  // pick targets for a zap — default: full column (every row in selected reel)
  function pickZapTargets(reelIndex) {
    const picks = [];
    for (let row = 0; row < ROWS; row++){
      picks.push({ reel: reelIndex, row });
    }
    return picks;
  }
  window.pickZapTargets = pickZapTargets;

  // visually mark DOM cells as zapped/wild
  function paintZapToDOM(picks){
    try {
      const reelNodes = document.querySelectorAll(".reel");
      for (const p of picks){
        const strip = reelNodes[p.reel]?.querySelector(".strip");
        if (!strip) continue;
        const cells = strip.querySelectorAll(".cell");
        const targetCell = cells[p.row + 1]; // middle window is offset by +1 in your code
        if (!targetCell) continue;
        targetCell.classList.add("zapped","wild");
        // You can optionally change text/icon here; preserve original if desired:
        // targetCell.textContent = ALL_SYMBOLS[wildIndex].icon;
      }
    } catch(e){
      console.warn("paintZapToDOM failed", e);
    }
  }
  window.paintZapToDOM = paintZapToDOM;

  // remove visual marks
  function cleanupZapDOM(picks){
    try {
      const reelNodes = document.querySelectorAll(".reel");
      for (const p of picks){
        const strip = reelNodes[p.reel]?.querySelector(".strip");
        if (!strip) continue;
        const cells = strip.querySelectorAll(".cell");
        const targetCell = cells[p.row + 1];
        targetCell?.classList.remove("zapped","wild");
      }
    } catch(e){
      console.warn("cleanupZapDOM failed", e);
    }
  }
  window.cleanupZapDOM = cleanupZapDOM;

  // apply zap logically to finals array (modifies finals in-place to set WILD index)
  function applyZapToFinals(picks, finals){
    const wildIndex = findWildIndex();
    if (wildIndex === -1){
      console.warn("No WILD symbol found in ALL_SYMBOLS — skipping logical wild substitution. Wild will be visual only.");
      return false;
    }
    for (const p of picks){
      if (!Array.isArray(finals[p.reel])) continue;
      finals[p.reel][p.row] = wildIndex;
    }
    return true;
  }
  window.applyZapToFinals = applyZapToFinals;

  // Move Zylo visually above the given reel (returns a promise that resolves after move)
  function moveZyloToReelAnim(reelIndex){
    return new Promise(resolve => {
      try {
        const reelNodes = document.querySelectorAll(".reel");
        const targetReel = reelNodes[reelIndex];
        if (targetReel && zyloOrbit && appEl){
          const appRect = appEl.getBoundingClientRect();
          const reelRect = targetReel.getBoundingClientRect();
          const centerX = reelRect.left - appRect.left + reelRect.width / 2;
          // animate using left (or transform) so it plays nicely
          zyloOrbit.style.transition = `left ${cfg.ZYLO_MOVE_DURATION}ms cubic-bezier(.2,.7,.2,1)`;
          zyloOrbit.style.left = `${centerX}px`;
          // small visual cues
          zyloShip?.classList.add("shoot");
          zyloSaucer?.classList.add("flash");
          setTimeout(()=> resolve(), cfg.ZYLO_MOVE_DURATION + 20);
        } else {
          // nothing to animate; resolve immediately
          resolve();
        }
      } catch(e){
        console.warn("moveZyloToReelAnim failed", e);
        resolve();
      }
    });
  }
  window.moveZyloToReelAnim = moveZyloToReelAnim;

  // Fire beam animation (returns after its visual sequence has dissipated).
  function fireBeamAnim(targetReel, onImpact){
    try {
      return Promise.resolve(fireBeam(targetReel, onImpact));
    } catch(e) {
      if (typeof onImpact === 'function') onImpact();
      return Promise.resolve();
    }
  }
  window.fireBeamAnim = fireBeamAnim;

  // The main performZap sequence (async). It will animate Zylo, paint DOM, and modify finals.
  // - reelIndex: which reel to zap
  // - finals: the finals[][] array (modified in-place if wild symbol is found)
  async function performZap(reelIndex, finals){
    const picks = pickZapTargets(reelIndex);

    // Visual focus / pre-armed look
    document.body.classList.add("zap-focus");
    zyloEl?.classList.add('zap-armed');

    // Move Zylo above the chosen reel
    await moveZyloToReelAnim(reelIndex);

    // Change zylo state to firing
    zyloEl?.classList.remove('zap-armed');
    zyloEl?.classList.add('zap-firing');
    playTag && playTag("zapSfx");
    Sound?.zap && Sound.zap();

    // show beam + DOM marks
    paintZapToDOM(picks);
    await fireBeamAnim();

    // logically change finals to wilds (if possible)
    const logicallyApplied = applyZapToFinals(picks, finals);
    if (!logicallyApplied){
      // if we couldn't find a WILD symbol, show a short extra hold so visual matches expectation
      await new Promise(r => setTimeout(r, 200));
    }

    zyloSay && zyloSay('zap', 75);

    // hold the effect visually briefly so player sees it
    await new Promise(r => setTimeout(r, cfg.ZAP_DOM_HOLD));

    // cleanup visuals
    document.body.classList.remove("zap-focus");
    zyloShip?.classList.remove("shoot");
    zyloSaucer?.classList.remove("flash");
    zyloEl?.classList.remove('zap-firing');
    cleanupZapDOM(picks);

    // tiny delay to ensure things have settled
    await new Promise(r => setTimeout(r, cfg.ZAP_CLEANUP_DELAY));
  }
  window.performZap = performZap;

})();

// ---------- Sound helper ----------
function playTag(id){
  const el = document.getElementById(id);
  if (!el) { console.warn("Audio element not found:", id); return; }
  el.currentTime = 0;
  const p = el.play();
  if (p && p.catch) p.catch(err => console.warn("Audio play blocked:", id, err));
}

const Sound = {
  ctx: null,
  enable() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
  },
  click() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "square";
    o.frequency.value = 800;
    o.connect(g); g.connect(this.ctx.destination);
    g.gain.setValueAtTime(0.09, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.08);
    o.start(); o.stop(this.ctx.currentTime + 0.09);
  },
  zap() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(1400, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(420, this.ctx.currentTime + 0.16);
    o.connect(g); g.connect(this.ctx.destination);
    g.gain.setValueAtTime(0.10, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.18);
    o.start(); o.stop(this.ctx.currentTime + 0.2);
  },
  // --- REEL SOUND LAYERING (procedural, no files required) ---
  reelWhoosh() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    const ctx = this.ctx;

    // Short white-noise burst
    const bufferSize = Math.floor(ctx.sampleRate * 0.18);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      // Random noise tapered out
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }

    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;

    const gain = ctx.createGain();
    gain.gain.value = 0.26; // whoosh volume

    source.connect(gain).connect(ctx.destination);
    source.start();
    source.stop(ctx.currentTime + 0.18);
  },

  reelThud() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    osc.type = "sine";

    // Deep thud tone sliding downward
    osc.frequency.setValueAtTime(155, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.52, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.14);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  },

  reelTick() {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(980, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.05);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  },
  
  bigWin() {
    if (window.isSoundMuted && window.isSoundMuted()) return;
    this.enable();
    // Triumphant ascending notes
    const notes = [523, 659, 784, 1047]; // C, E, G, C (octave higher)
    notes.forEach((freq, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const startTime = this.ctx.currentTime + (i * 0.15);
      g.gain.setValueAtTime(0.2, startTime);
      g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.4);
      o.connect(g).connect(this.ctx.destination);
      o.start(startTime);
      o.stop(startTime + 0.4);
    });
  },
  anticipation(durSec = 0.9) {
    if (window.isSoundMuted && window.isSoundMuted()) return; // Check mute state
    this.enable();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    // Rising sweep — builds tension without being loud
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(160, t0);
    osc.frequency.exponentialRampToValueAtTime(720, t0 + durSec);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + Math.min(0.12, durSec * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    // Gentle tremolo so it pulses along with the reel glow
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain).connect(gain.gain);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + durSec);
    lfo.start(t0); lfo.stop(t0 + durSec);
  }
};

// ---------- RNG helpers ----------
function randInt(n){
  if (window.crypto && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return Number(a[0] % n);
  }
  return Math.floor(Math.random()*n);
}
const sample = a => a[randInt(a.length)];

// Accepts either a fractional probability (0..1) or a percent (0..100).
// Returns true when a random roll succeeds.
function checkChance(prob){
  if (typeof prob !== 'number') return false;
  if (prob > 1) return randInt(100) < prob; // percent-style
  return Math.random() < prob;               // fraction-style
}

// --- Scatter stats: count + distinct rows ---
function getScatterStats(finals){
  // finals[reel][row] uses symbol indexes (0=WILD, 1=SCATTER if you followed earlier)
  const positions = [];
  const rowSet = new Set();
  let count = 0;
  for (let c=0; c<REEL_COUNT; c++){
    for (let row=0; row<ROWS; row++){
      if (finals[c][row] === SCATTER_INDEX){
        count++;
        positions.push({col:c,row});
        rowSet.add(row);
      }
    }
  }
  return { count, distinctRows: rowSet.size, positions };
}

// ---------- JACK helpers ----------
function countJackSymbols(finals){
  let c = 0;
  for (let col=0; col<REEL_COUNT; col++){
    for (let row=0; row<ROWS; row++){
      if (finals[col][row] === JACK_INDEX) c++;
    }
  }
  return c;
}

function jackpotProbability(){
  const stacks = Math.min(jackStacks, JACK_STACKS_CAP);
  return JACK_BASE_CHANCE + stacks * JACK_PER_SYMBOL_BONUS;
}

// trigger helper: award the jackpot pot and run UI updates
// Placeholder for when we're ready
function triggerJackpotWin() {
  const prize = jackpot;
  balance += prize;
  jackpot = JACKPOT_MIN;
  jackStacks = 0;
  updateBalanceUI();

  const flash = document.createElement('div');
  flash.style.cssText = `
    position:fixed;inset:0;z-index:9999;pointer-events:none;
    background:radial-gradient(circle, rgba(255,220,0,0.55) 0%, rgba(255,140,0,0.25) 60%, transparent 100%);
    animation:jackpotFlash 2.4s ease-out forwards;
  `;
  document.body.appendChild(flash);

  const banner = document.createElement('div');
  banner.innerHTML = `
    <div style="font-size:2.8rem;font-weight:900;color:#ffe84d;text-shadow:0 0 30px #ffaa00,0 0 60px #ff6600;letter-spacing:2px;">⭐ JACKPOT! ⭐</div>
    <div style="font-size:1.6rem;margin-top:8px;color:#fff;text-shadow:0 0 12px #ffaa00;">+${prize} credits!</div>
  `;
  banner.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    z-index:10000;text-align:center;pointer-events:none;
    animation:jackpotBanner 2.8s ease-out forwards;
  `;
  document.body.appendChild(banner);

  if (!document.getElementById('jackpot-styles')) {
    const style = document.createElement('style');
    style.id = 'jackpot-styles';
    style.textContent = `
      @keyframes jackpotFlash {
        0%   { opacity:0; }
        15%  { opacity:1; }
        80%  { opacity:1; }
        100% { opacity:0; }
      }
      @keyframes jackpotBanner {
        0%   { opacity:0; transform:translate(-50%,-60%) scale(0.7); }
        20%  { opacity:1; transform:translate(-50%,-50%) scale(1.08); }
        80%  { opacity:1; transform:translate(-50%,-50%) scale(1); }
        100% { opacity:0; transform:translate(-50%,-44%) scale(0.95); }
      }
    `;
    document.head.appendChild(style);
  }

  zyloEl?.classList.add('zap-armed');
  zyloSay('jackpot', 100);

  setTimeout(() => {
    flash.remove();
    banner.remove();
    zyloEl?.classList.remove('zap-armed');
  }, 2800);
}

// Symbols (order matters: indexes 0..)
// feature symbols first
const WILD = {
  key: "WILD",
  icon: '<img src="img/symbols/wild.png">',
  isWild: true,
  pay: {5:588,4:172,3:44}
};

const SCATTER = {
  key: "SCATTER",
  icon: '<img src="img/symbols/scatter.png">',
  pay:{}
};  // triggers free spins
const JACK   = {
  key: "JACK",
  icon: '<img src="img/symbols/jackpotPlanet.png">',
  pay: {}
};

const SYMBOLS = [
  { key:"METEOR",  icon:'<img src="img/symbols/meteor.png">',   pay:{5:417,4:123,3:39} },
  { key:"CRYSTAL", icon:'<img src="img/symbols/crystal.png">',  pay:{5:380,4:110,3:34} },
  { key:"SAT",     icon:'<img src="img/symbols/sat.png">',      pay:{5:319,4:93,3:29} },
  { key:"COMET",   icon:'<img src="img/symbols/comet.png">',    pay:{5:233,4:69,3:25} },
  { key:"AST",     icon:'<img src="img/symbols/ast.png">',      pay:{5:196,4:59,3:22} },

  // A K Q letter symbols
  { key:"A", icon:'<img src="img/symbols/A.png">', pay:{5:167,4:49,3:20} },
  { key:"K", icon:'<img src="img/symbols/K.png">', pay:{5:142,4:44,3:17} },
  { key:"Q", icon:'<img src="img/symbols/Q.png">', pay:{5:123,4:39,3:15} }
];

const ALL_SYMBOLS   = [WILD, SCATTER, JACK, ...SYMBOLS];
const WILD_INDEX    = 0;
const SCATTER_INDEX = 1;
const JACK_INDEX    = 2;


// Editable weights per symbol (more = more frequent on strips)

// ---------- Game state ----------
let balance = 1000.00;
let bet = 0.20;
// feature state: free spins
let freeSpins = 0;
let isFreeSpin = false;
let freeSpinsTotalWin = 0; // accumulates winnings across an entire free spins session
let freeSpinMult = 2; // 2x wins during freebies

// Jackpot pot (you likely already have this)
const JACKPOT_MIN  = 100;
const JACKPOT_RATE = 0.02; // 2% of paid bet goes into pot

// two-step init: no self-reference in the initializer
let jackpot = JACKPOT_MIN;
if (typeof window !== "undefined" && typeof window.jackpot === "number") {
  jackpot = window.jackpot;
}
jackpot = Math.max(JACKPOT_MIN, jackpot);

// JACK feature tuning
const JACK_REQUIRED          = 3;      // 3+ jackpot symbols in one spin = guaranteed jackpot
const JACK_POP_CHANCE        = 0.007;  // 0.7% per landed jackpot symbol (rebalanced from 2%)
const JACK_BASE_CHANCE       = 0.001;  // 0.1% base chance each paid spin
const JACK_PER_SYMBOL_BONUS  = 0.0005; // +0.05% per JACK symbol seen (persistent)
const JACK_STACKS_CAP        = 400;    // cap the accumulation
const JACK_DECAY_ON_MISS     = 0.10;   // each paid non-trigger spin decays stacks 10%

// persistent “pity” meter
let jackStacks = 0; // increases when JACK symbols land (persists across spins)

// ===== SAVE / LOAD PERSISTENCE =====
// One centralized, versioned localStorage system. Persists long-term player
// state only, never transient flags like isSpinning, celebrations, travel,
// or autoplay, so a restored save can never boot the game into a stuck
// state. Bonus rounds are not resumed mid-way; refreshing during a bonus
// returns safely to the base game with the last stable balance.
const SAVE_KEY = 'zylosZapSave';
const SAVE_VERSION = 1;
let saveDebounceTimer = null;

// Settings that live inside wireControls closures. loadGame() fills this
// before wireControls runs, and wireControls seeds its local state from it.
const restoredSettings = { turboOn: false, soundMuted: false };

function isFiniteNum(v){ return typeof v === 'number' && Number.isFinite(v); }

function saveGame(){
  try {
    const payload = {
      v: SAVE_VERSION,
      balance: balance,
      bet: bet,
      jackpot: jackpot,
      jackStacks: jackStacks,
      zapMode: (typeof window.zapMode === 'string') ? window.zapMode : zapMode,
      jackpotMode: jackpotMode,
      turboOn: (typeof window.isTurboMode === 'function') ? !!window.isTurboMode() : restoredSettings.turboOn,
      soundMuted: (typeof window.isSoundMuted === 'function') ? !!window.isSoundMuted() : restoredSettings.soundMuted,
      t: Date.now()
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    // Storage unavailable or full. Persistence silently degrades.
  }
}

// Debounced save so rapid state changes produce one write instead of many
// and no writes ever happen inside animation frames.
function scheduleSave(){
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveGame, 400);
}

// The bet controls already call saveSettings() when it exists, so alias it
// to the debounced saver.
function saveSettings(){ scheduleSave(); }

function loadGame(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || d.v !== SAVE_VERSION) return false; // incompatible version, ignore

    // Each field is validated independently. Invalid, NaN, negative, or
    // out-of-range values are skipped so garbage never overwrites a safe
    // default, and valid loaded values are never overwritten afterwards.
    if (isFiniteNum(d.balance) && d.balance >= 0 && d.balance <= 1e9) {
      balance = Math.round(d.balance * 100) / 100;
    }
    if (isFiniteNum(d.bet) && d.bet >= 0.20 && d.bet <= 100) {
      bet = Math.round(d.bet * 100) / 100;
    }
    if (isFiniteNum(d.jackpot) && d.jackpot >= 0 && d.jackpot <= 1e9) {
      jackpot = Math.max(JACKPOT_MIN, Math.round(d.jackpot * 100) / 100);
    }
    if (isFiniteNum(d.jackStacks) && d.jackStacks >= 0) {
      jackStacks = Math.min(d.jackStacks, JACK_STACKS_CAP);
    }
    if (d.zapMode === 'auto' || d.zapMode === 'manual' || d.zapMode === 'off') {
      zapMode = d.zapMode;
      window.zapMode = d.zapMode;
    }
    if (d.jackpotMode === 'auto' || d.jackpotMode === 'manual' || d.jackpotMode === 'off') {
      jackpotMode = d.jackpotMode;
    }
    if (typeof d.turboOn === 'boolean') restoredSettings.turboOn = d.turboOn;
    if (typeof d.soundMuted === 'boolean') restoredSettings.soundMuted = d.soundMuted;
    return true;
  } catch (e) {
    // Corrupted JSON or blocked storage. Ignore the save entirely.
    return false;
  }
}

function resetSave(){
  clearTimeout(saveDebounceTimer);
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}
window.saveGame = saveGame;
window.resetSave = resetSave;

// Flush any pending debounced save when the tab closes or hides so the
// latest state always lands.
window.addEventListener('beforeunload', () => { try { saveGame(); } catch(e){} });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { try { saveGame(); } catch(e){} }
});
const REEL_COUNT = 5;
const ROWS = 3;
const reels = []; // each reel is an array of ALL_SYMBOLS idx (1..N; 0 reserved for WILD via zap)

// ---------- Build reel strips (no WILDs; zap creates them) ----------
// weights: bump JACK up to test, then lower later
// Rebalanced. The old table used legacy names (PLANET/GEM/ROCKET/LASER/EGG)
// that no longer matched any symbol, so all five high symbols silently fell
// back to weight 1. Keys now match SYMBOLS exactly.
const WEIGHTS = { SCATTER: 4, JACK: 1, METEOR: 4, CRYSTAL: 5, SAT: 6, COMET: 8, AST: 9, A: 13, K: 14, Q: 15 };

const SCATTER_GAP = 7;
const JACK_GAP    = 9;

function buildReels(){
  const makeStrip = (reelIndex) => {
    // 1) base (non-special) symbols
    const base = [];
    SYMBOLS.forEach((sym,i)=>{
      const w = WEIGHTS[sym.key] ?? 1;
      for (let k=0;k<w;k++) base.push(i+3); // +3 because 0=WILD,1=SCATTER,2=JACK
    });

    // 2) insert spaced SCATTER + JACK with per-reel offsets
    let strip = [...base];

    const sCount = WEIGHTS.SCATTER ?? 0;
    const sOffset = (reelIndex % 3);
    for (let s=0; s<sCount; s++){
      const pos = (sOffset + s*SCATTER_GAP) % strip.length;
      strip.splice(pos, 0, SCATTER_INDEX);
    }

    const jCount = WEIGHTS.JACK ?? 0;
    const jOffset = (1 + reelIndex) % 3; // offset differently from scatter
    for (let j=0; j<jCount; j++){
      const pos = (jOffset + j*JACK_GAP) % strip.length;
      strip.splice(pos, 0, JACK_INDEX);
    }

    // 3) Duplicate strip 2× instead of 3× (less DOM elements = better performance)
    // We only need enough to cover: visible window (3 cells) + travel distance (8 cells) + buffer
    strip = strip.concat(strip);

    // Shuffle the strip so symbols aren't bunched together
    for (let i = strip.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [strip[i], strip[j]] = [strip[j], strip[i]];
    }

    return strip;
  };

  for (let r=0; r<REEL_COUNT; r++) reels[r] = makeStrip(r);
}

// ---------- DOM ----------
const balanceEl = document.getElementById("balance");
const betEl = document.getElementById("bet");
const jackpotEl = document.getElementById("jackpot");
const spinBtn = document.getElementById("spin");
const lastWinEl = document.getElementById("lastWin");
const minusBtn = document.getElementById("minus");
const plusBtn = document.getElementById("plus");
const speech = document.getElementById("speech");
const zyloShip = document.querySelector(".ship");
const zyloSaucer = document.querySelector(".saucer");
const jackpotWrap = document.getElementById("jackpotPlanet") || document.querySelector(".jackpot-planet-wrap");
const jackpotOrbitParticles = jackpotWrap?.querySelector(".jackpot-orbit-particles");
const jackpotCracksEl = jackpotWrap?.querySelector(".jackpot-cracks");
const jackpotBeamEl = jackpotWrap?.querySelector(".jackpot-beam");
const freeSpinsWrap = document.getElementById("freeSpinsPlanet") || document.querySelector(".freespins-planet-wrap");
const freeSpinsOrbitParticles = freeSpinsWrap?.querySelector(".freespins-orbit-particles");
const jackpotDimEl = document.querySelector(".jackpot-dim");
const jackpotFlashEl = document.querySelector(".jackpot-screen-flash");
const jackpotBannerEl = document.querySelector(".jackpot-banner");
const jackpotBannerAmountEl = jackpotBannerEl?.querySelector(".jackpot-amount");
const jackpotCoinBurstEl = document.querySelector(".jackpot-coin-burst");
// Hook Zylo element (was previously #zylo). The `zyloEl` reference is
// declared near the top of this file so it can be used by other modules.

let currentJackpotPhase = "phase-1";
let jackpotRumbleEl = null;

function ensureOrbitParticles(container, dotClass){
  if (!container || container.childElementCount > 0) return;
  const count = 6;
  for (let i = 0; i < count; i++){
    const dot = document.createElement("div");
    dot.className = dotClass;
    const radius = 110 + Math.random() * 18;
    const duration = 9 + Math.random() * 6;
    const delay = -Math.random() * 6;
    dot.style.setProperty("--radius", `${radius}px`);
    dot.style.setProperty("--duration", `${duration}s`);
    dot.style.setProperty("--delay", `${delay}s`);
    dot.style.setProperty("--start", `${Math.round(i * (360 / count))}deg`);
    container.appendChild(dot);
  }
}

function setZyloLookAtJackpot(isLooking){
  if (!zyloEl) return;
  zyloEl.classList.toggle("look-jackpot", Boolean(isLooking));
}

function startJackpotRumble(){
  const el = document.getElementById("rumbleSfx");
  if (el){
    jackpotRumbleEl = el;
    jackpotRumbleEl.loop = true;
    jackpotRumbleEl.volume = 0.4;
    const p = jackpotRumbleEl.play();
    if (p && p.catch) p.catch(()=>{});
    return;
  }
  if (typeof playSound === "function") {
    try { playSound("rumble"); } catch(e) { /* ignore */ }
  } else if (typeof playTag === "function") {
    try { playTag("rumbleSfx"); } catch(e) { /* ignore */ }
  }
}

function stopJackpotRumble(){
  if (jackpotRumbleEl){
    jackpotRumbleEl.pause();
    jackpotRumbleEl.currentTime = 0;
  }
  jackpotRumbleEl = null;
}

function setJackpotPhase(phase){
  if (!jackpotWrap) return;
  if (currentJackpotPhase === phase) return;
  jackpotWrap.classList.remove("phase-1", "phase-2", "phase-3");
  jackpotWrap.classList.add(phase);
  currentJackpotPhase = phase;

  if (phase === "phase-2"){
    startJackpotRumble();
    setZyloLookAtJackpot(true);
  } else {
    stopJackpotRumble();
    setZyloLookAtJackpot(false);
  }
}

function setJackpotMeter(percent){
  scheduleSave();
  if (!jackpotWrap) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  jackpotWrap.style.setProperty("--jackpot-percent", p);
  ensureOrbitParticles(jackpotOrbitParticles, "jackpot-orbit-dot");
  ensureOrbitParticles(freeSpinsOrbitParticles, "freespins-orbit-dot");
  if (p >= 100) setJackpotPhase("phase-3");
  else if (p >= 90) setJackpotPhase("phase-2");
  else setJackpotPhase("phase-1");
}
window.setJackpotMeter = setJackpotMeter;

function fireJackpotBeam(){
  if (!jackpotBeamEl) return;
  const slot = document.getElementById("slot");
  const wrapRect = jackpotWrap?.getBoundingClientRect();
  const slotRect = slot?.getBoundingClientRect();
  if (!wrapRect || !slotRect) return;

  const startY = wrapRect.bottom;
  const targetY = slotRect.bottom;
  const beamLength = Math.max(0, Math.round(targetY - startY));

  jackpotBeamEl.classList.add("active");
  jackpotBeamEl.style.height = `${beamLength}px`;
  setTimeout(() => {
    jackpotBeamEl.classList.remove("active");
    jackpotBeamEl.style.height = "0px";
  }, 650);
}

function spawnJackpotCoins(count = 18){
  if (!jackpotCoinBurstEl || !jackpotWrap) return;
  const wrapRect = jackpotWrap.getBoundingClientRect();
  const originX = wrapRect.left + wrapRect.width / 2;
  const originY = wrapRect.top + wrapRect.height / 2;

  for (let i = 0; i < count; i++){
    const coin = document.createElement("div");
    coin.className = "jackpot-coin";
    const angle = Math.random() * Math.PI * 2;
    const distance = 120 + Math.random() * 160;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    coin.style.left = `${originX}px`;
    coin.style.top = `${originY}px`;
    coin.style.setProperty("--dx", `${dx}px`);
    coin.style.setProperty("--dy", `${dy}px`);
    jackpotCoinBurstEl.appendChild(coin);
    setTimeout(() => coin.remove(), 1000);
  }
}

function triggerJackpotAnimation({ amount } = {}){
  if (!jackpotWrap) return;
  const displayAmount = (typeof amount === "number") ? formatCurrency(amount) : "";

  jackpotWrap.classList.add("exploding", "phase-3");
  jackpotDimEl?.classList.add("active");
  jackpotFlashEl?.classList.add("active");
  if (jackpotBannerEl){
    if (jackpotBannerAmountEl) jackpotBannerAmountEl.textContent = displayAmount;
    jackpotBannerEl.classList.add("show");
  }

  zyloEl?.classList.add("celebrate");
  fireJackpotBeam();
  spawnJackpotCoins(22);

  setTimeout(() => jackpotFlashEl?.classList.remove("active"), 700);
  setTimeout(() => jackpotWrap.classList.remove("exploding"), 900);
  setTimeout(() => {
    jackpotBannerEl?.classList.remove("show");
    jackpotDimEl?.classList.remove("active");
    zyloEl?.classList.remove("celebrate");
    setJackpotMeter(0);
  }, 1800);
}
window.triggerJackpotAnimation = triggerJackpotAnimation;

setJackpotMeter(0);


const ZYLO_LINES = {
  spin: [
    "Let's gooo! 🚀",
    "Come on come on come on!",
    "Feel the cosmic energy!",
    "This is the one, I can feel it!"
  ],
  winSmall: [
    "Yeah! Keep it going!",
    "That's what I'm talking about!",
    "Credits incoming!"
  ],
  winBig: [
    "COSMIC JACKPOT! UNBELIEVABLE!",
    "THE STARS DELIVERED!",
    "ZYLO COMES THROUGH AGAIN!"
  ],
  loss: [
    "Next one's yours, trust me!",
    "The universe is just warming up!",
    "Don't sweat it, big win incoming!"
  ],
  zap: [
    "ZAP ZAP ZAP! You're welcome!",
    "Lemme help you out real quick!",
    "Watch this! WATCH THIS!"
  ],
  freeSpins: [
    "FREE SPINS! THE GIFT FROM THE COSMOS!",
    "BONUS TIME! ZYLO DELIVERS!",
    "FREE SPINS ACTIVATED! LET'S GO!"
  ],
  jackpot: [
    "THAT'S WHAT I'M TALKING ABOUT!",
    "THE UNIVERSE PROVIDES!"
  ],
  anticipation: [
    "Wait for it... WAIT FOR IT!",
    "One more! ONE MORE!",
    "Ohhh it's coming, I can feel it!",
    "Don't blink! DON'T BLINK!"
  ]
};

function zyloSay(category, chancePercent = 20) {
  // Only speak sometimes — chancePercent controls how often
  if (Math.random() * 100 > chancePercent) return;
  const lines = ZYLO_LINES[category];
  if (!lines) return;
  const line = lines[Math.floor(Math.random() * lines.length)];
  say(line);
}

function say(t){
  if (!speech) return;
  // Don't talk if Zylo is off screen
  if (zyloEl && (
    zyloEl.classList.contains('zylo-fly-out-left') ||
    zyloEl.classList.contains('zylo-fly-out-right') ||
    zyloEl.classList.contains('zylo-fly-out-top')
  )) return;
  speech.textContent = t;
  speech.classList.add('show');
  setTimeout(()=>speech.classList.remove('show'), 2200);
}

function formatCurrency(amount) {
  return '$' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Animate win counter from 0 to target amount
function animateWinCounter(targetAmount, duration = 800) {
  if (!lastWinEl) return;
  
  const startAmount = 0;
  const startTime = performance.now();
  
  function updateCounter(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Ease out cubic for smooth deceleration
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    
    const currentAmount = startAmount + (targetAmount - startAmount) * easeProgress;
    lastWinEl.textContent = formatCurrency(currentAmount);
    
    if (progress < 1) {
      requestAnimationFrame(updateCounter);
    } else {
      // Ensure final value is exact
      lastWinEl.textContent = formatCurrency(targetAmount);
    }
  }
  
  requestAnimationFrame(updateCounter);
}

// Big Win celebration - screen shake and particle burst
function celebrateBigWin(winAmount) {
  const appEl = document.getElementById('app');
  if (!appEl) return;
  
  // Set celebrating flag to block new spins
  isCelebrating = true;
  
  // Screen shake animation
  appEl.classList.add('big-win-shake');
  
  // Create particle burst
  createParticleBurst();
  
  // Play big win sound
  Sound.bigWin();
  
  // Show big win banner
  showBigWinBanner(winAmount);
  
  // Remove shake class after animation
  setTimeout(() => {
    appEl.classList.remove('big-win-shake');
  }, 600);
  
  // Clear celebrating flag after 3.5 seconds
  setTimeout(() => {
    isCelebrating = false;
  }, 3500);
}

function createParticleBurst() {
  const container = document.getElementById('app');
  if (!container) return;
  
  const particleCount = 30;
  
  for (let i = 0; i < particleCount; i++) {
    const particle = document.createElement('div');
    particle.className = 'win-particle';
    
    // Random position around center
    const angle = (Math.PI * 2 * i) / particleCount;
    const velocity = 200 + Math.random() * 100;
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity;
    
    particle.style.setProperty('--tx', `${tx}px`);
    particle.style.setProperty('--ty', `${ty}px`);
    particle.style.left = '50%';
    particle.style.top = '40%';
    
    container.appendChild(particle);
    
    // Remove after animation
    setTimeout(() => particle.remove(), 1000);
  }
}

function showBigWinBanner(winAmount) {
  const banner = document.createElement('div');
  banner.className = 'big-win-banner';
  banner.innerHTML = `
    <div class="big-win-text">BIG WIN!</div>
    <div class="big-win-amount">$0.00</div>
  `;
  
  document.body.appendChild(banner);
  
  // Trigger animation
  setTimeout(() => banner.classList.add('show'), 10);
  
  // Animate the win amount counting up
  const amountEl = banner.querySelector('.big-win-amount');
  const startAmount = 0;
  const duration = 1000; // Shortened to 1 second for counting
  const startTime = performance.now();
  
  function animateBannerAmount(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    // Ease out cubic for smooth deceleration
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    
    const currentAmount = startAmount + (winAmount - startAmount) * easeProgress;
    amountEl.textContent = formatCurrency(currentAmount);
    
    if (progress < 1) {
      requestAnimationFrame(animateBannerAmount);
    } else {
      // Ensure final value is exact
      amountEl.textContent = formatCurrency(winAmount);
    }
  }
  
  requestAnimationFrame(animateBannerAmount);
  
  // Remove after 2 seconds (shortened from 3)
  setTimeout(() => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 500);
  }, 2000);
}

function updateBalanceUI(){
  if (balanceEl) balanceEl.textContent = formatCurrency(balance);
  if (betEl) betEl.textContent = formatCurrency(bet);
  const betAmountEl = document.getElementById('betAmount');
  if (betAmountEl) betAmountEl.textContent = formatCurrency(bet);
  if (jackpotEl) jackpotEl.textContent = formatCurrency(jackpot);
  scheduleSave();
}

function updateJackpotUI(){
  if (jackpotEl) jackpotEl.textContent = formatCurrency(jackpot);
  scheduleSave();
}

// mount rotating strips into each .reel
function mountReels(){
  const reelNodes = document.querySelectorAll(".reel");
  reelNodes.forEach((node, reelIndex)=>{
    // Ensure consistent indexing for later querySelectors
    try { node.setAttribute('data-reel', String(reelIndex)); } catch(e){}
    const strip = document.createElement("div");
    strip.className = "strip";

    const stripData = reels[reelIndex] || [];

    if (!stripData.length){
      // fallback: 6 placeholder cells if reels not built yet
      for (let i=0;i<ROWS*2;i++){
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.textContent = "🌀";
        strip.appendChild(cell);
      }
    } else {
      // build a REAL long strip that mirrors the numeric reels[]
      // reels[reelIndex][i] is an index into ALL_SYMBOLS
      stripData.forEach(symIndex=>{
        const cell = document.createElement("div");
        cell.className = "cell";
        const sym = ALL_SYMBOLS[symIndex];
        cell.innerHTML = sym ? sym.icon : "❓";
        strip.appendChild(cell);
      });
    }

    node.innerHTML = "";
    node.appendChild(strip);

    // Set exact cell height for this reel (prevents subpixel rounding issues)
    try {
      const reelH = Math.max(0, Math.round(node.offsetHeight));
      const cellH = (reelH > 0) ? Math.max(10, Math.round(reelH / ROWS)) : 100;
      node.style.setProperty('--cell-h', `${cellH}px`);
    } catch(e) { /* ignore */ }

    // RANDOMIZE initial position so each page load shows different symbols
    if (stripData.length > 0) {
      const cellH = getCellHeightForReel(node);
      const randomOffset = Math.floor(Math.random() * stripData.length) * cellH;
      strip.style.transform = `translateY(-${randomOffset}px)`;
    }
  });

  // add beam once under Zylo (attach to the header image's parent so it sits under zylo stage)
  if (!document.querySelector(".beam")){
    const beam = document.createElement("div");
    beam.className = "beam";
    beam.style.height = "0px";
    // prefer a logical container for Zylo ('.zylo-stage') but fallback to parent
    const zyloContainer = zyloEl?.closest('.zylo-stage') ?? zyloEl?.parentElement;
    zyloContainer?.appendChild(beam);
  }
}

// ---------- Paylines (25) ----------
const PAYLINES = [
  [0,0,0,0,0],[1,1,1,1,1],[2,2,2,2,2],
  [0,1,2,1,0],[2,1,0,1,2],
  [0,0,1,2,2],[2,2,1,0,0],[0,1,1,1,2],[2,1,1,1,0],[1,0,0,0,1],
  [1,2,2,2,1],[0,0,0,1,2],[2,2,2,1,0],[0,1,0,1,0],[2,1,2,1,2],
  [1,0,1,2,1],[1,2,1,0,1],[0,2,0,2,0],[2,0,2,0,2],
  [0,2,1,0,2],[2,0,1,2,0],[0,1,2,2,1],[2,1,0,0,1],[1,1,0,1,2],[1,1,2,1,0]
];

// ---------- Helper Functions ----------
function chooseStopSymbols(reelIndex) {
  const strip = reels[reelIndex];
  const visible = 3;

  const startIndex = Math.floor(Math.random() * (strip.length - visible));

  const symbols = strip.slice(startIndex, startIndex + visible);
  
  console.log(`chooseStopSymbols(${reelIndex}):`, {
    startIndex,
    symbols,
    stripLength: strip.length
  });

  return {
    symbols,
    startIndex
  };
}

// Finds a position in the REAL strip where the given symbol already sits at
// targetRow, and returns the matching startIndex/symbols — so the reel
// actually scrolls to land on a genuine symbol, not one inserted after the fact.
function chooseForcedSymbolStop(reelIndex, targetRow, symbolIndex) {
  const strip = reels[reelIndex];
  const visible = 3;
  const candidates = [];
  for (let i = 0; i < strip.length; i++) {
    if (strip[i] === symbolIndex) {
      const startIndex = i - targetRow;
      // Only use positions where the full 3-row window fits without wrapping
      if (startIndex >= 0 && startIndex + visible <= strip.length) {
        candidates.push(startIndex);
      }
    }
  }
  if (candidates.length === 0) {
    console.warn(`chooseForcedSymbolStop(${reelIndex}, sym ${symbolIndex}): no valid position found, falling back`);
    return chooseStopSymbols(reelIndex);
  }
  const startIndex = candidates[Math.floor(Math.random() * candidates.length)];
  const symbols = strip.slice(startIndex, startIndex + visible);
  return { symbols, startIndex };
}

// Back-compat wrapper for the scatter-specific call sites.
function chooseForcedScatterStop(reelIndex, targetRow) {
  return chooseForcedSymbolStop(reelIndex, targetRow, SCATTER_INDEX);
}

function triggerReelGlow(reelEl) {
  if (!reelEl) return;

  // Clear old
  reelEl.classList.remove("glow-start","glow-stop");
  reelEl.style.transition = "none";
  reelEl.style.filter = "none";
  reelEl.offsetWidth;

  // INSTANT punch glow (frame synced)
  reelEl.style.filter = "drop-shadow(0 0 14px rgba(255,255,0,0.9))";

  // Smooth fade out
  setTimeout(() => {
    reelEl.style.transition = "filter 160ms ease-out";
    reelEl.style.filter = "none";
  }, 30);

  setTimeout(() => {
    reelEl.style.transition = "none";
  }, 210);
}

function getFinalGrid(finalData) {
  const grid = [[],[],[]];
  
  console.log("getFinalGrid - finalData length:", finalData.length);
  
  for (let col = 0; col < finalData.length; col++) {
    const symbols = finalData[col].symbols;
    console.log(`Col ${col} symbols:`, symbols);
    
    grid[0][col] = symbols[0];
    grid[1][col] = symbols[1];
    grid[2][col] = symbols[2];
  }
  
  console.log("getFinalGrid - resulting grid:", grid);

  return grid;
}

function getSymbolFromCell(cell) {
  // All your symbols use innerHTML of the <div class="cell">
  // So find symbol by matching icon
  const icon = cell.innerHTML;

  return ALL_SYMBOLS.find(s => s.icon === icon);
}

function getCellHeightForReel(reelEl) {
  if (!reelEl) return 100;
  const cssValue = getComputedStyle(reelEl).getPropertyValue('--cell-h');
  const parsed = parseFloat(cssValue);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const rectH = reelEl.offsetHeight;
  if (rectH && rectH > 0) return Math.max(10, Math.round(rectH / ROWS));
  return 100;
}

function snapStripToGrid(reelEl, stripEl, cellH) {
  if (!reelEl || !stripEl || !cellH) return;
  const reelRectH = Math.round(reelEl.getBoundingClientRect().height);
  const stripHeight = stripEl.scrollHeight || (stripEl.children.length * cellH);
  if (!stripHeight || !reelRectH) return;

  const maxDown = 0;
  const maxUp = -Math.max(0, stripHeight - reelRectH);
  const y = getTranslateYpx(stripEl);
  let snapped = Math.round(y / cellH) * cellH;
  if (!Number.isFinite(snapped)) snapped = 0;
  snapped = Math.min(maxDown, Math.max(maxUp, snapped));

  stripEl.style.transition = 'none';
  stripEl.style.transform = `translateY(${snapped}px)`;
  void stripEl.offsetHeight;
}

// ---------- Reel animation engine (long downward scroll) ----------
// ---------- Reel spin engine helpers (v2) ----------
// Small promise-based timers and animation phases. Everything here is
// finite: no permanent requestAnimationFrame loops and no per-frame layout
// reads — heights are measured once per spin before any reel moves.

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Animate one transform phase via the Web Animations API and settle the
// inline style at the end so phases chain without visual jumps.
function animateTransformPhase(el, fromY, toY, ms, easing) {
  return new Promise(resolve => {
    if (!el) { resolve(); return; }
    if (typeof el.animate !== "function") {
      // Ancient browser fallback: place instantly
      el.style.transform = `translateY(${toY}px)`;
      resolve();
      return;
    }
    let settled = false;
    let anim = null;
    const done = () => {
      if (settled) return;
      settled = true;
      el.style.transform = `translateY(${toY}px)`;
      try { if (anim) anim.cancel(); } catch (e) {}
      resolve();
    };
    anim = el.animate(
      [{ transform: `translateY(${fromY}px)` }, { transform: `translateY(${toY}px)` }],
      { duration: Math.max(1, ms), easing: easing || "linear", fill: "forwards" }
    );
    anim.onfinish = done;
    anim.oncancel = done;
  });
}

// Decide which reels (if any) deserve anticipation, based ONLY on the
// already-generated finalData. Rules:
//  - scatter / jackpot symbols: 2 have landed before the completing reel
//    AND the 3rd genuinely lands later this same spin. Paid spins only —
//    those events can't trigger during free spins, so teasing them there
//    would be fake.
//  - high line: a real 5-of-a-kind of a high-value symbol (top 5) is
//    completing on the last reel.
// If the event cannot complete, nothing is extended. Results are decided
// before this runs and are never altered by it.
function planReelAnticipation(finalData, totalReels) {
  const ext = new Array(totalReels).fill(0);
  const flags = new Array(totalReels).fill(null);
  const turboActive = window.isTurboMode && window.isTurboMode();
  const devFast = !!window.DEV_FAST_ANIMS;

  const perReelCount = (symIdx) =>
    finalData.map(fd => fd.symbols.reduce((n, s) => n + (s === symIdx ? 1 : 0), 0));

  function markCompletingTrigger(symIdx, label) {
    const per = perReelCount(symIdx);
    const total = per.reduce((a, b) => a + b, 0);
    if (total < 3) return; // event does not complete this spin — never fake it
    let cum = 0, reelWith2 = -1, reelWith3 = -1;
    for (let r = 0; r < totalReels; r++) {
      cum += per[r];
      if (reelWith2 === -1 && cum >= 2) reelWith2 = r;
      if (reelWith3 === -1 && cum >= 3) { reelWith3 = r; break; }
    }
    // All three arrive at once (or data is odd) — nothing to tease
    if (reelWith2 === -1 || reelWith3 === -1 || reelWith3 <= reelWith2) return;
    for (let r = reelWith2 + 1; r <= reelWith3; r++) if (!flags[r]) flags[r] = label;
  }

  if (!isFreeSpin) {
    markCompletingTrigger(SCATTER_INDEX, "scatter");
    markCompletingTrigger(JACK_INDEX, "jackpot");
  }

  // High-value 5-in-a-row completing on the last reel. Wild-aware for
  // safety, though pre-zap finals never actually contain wilds.
  const last = totalReels - 1;
  if (!flags[last]) {
    for (const line of PAYLINES) {
      let lineSym = -1, unbroken = true;
      for (let c = 0; c < totalReels; c++) {
        const s = finalData[c].symbols[line[c]];
        if (s === WILD_INDEX) continue;
        if (lineSym === -1) lineSym = s;
        else if (s !== lineSym) { unbroken = false; break; }
      }
      // Indices 3..7 are the five high-value symbols
      if (unbroken && lineSym >= 3 && lineSym <= 7) { flags[last] = "bigline"; break; }
    }
  }

  const any = flags.some(Boolean);
  // Turbo / dev-fast: extension disabled entirely (turbo stays fast);
  // a brief flash at the qualifying reel's stop is handled by the caller.
  const extended = any && !turboActive && !devFast;
  if (extended) {
    let budget = REEL_ANTICIPATION_MAX_MS;
    for (let r = 0; r < totalReels; r++) {
      if (flags[r] && budget > 0) {
        ext[r] = Math.min(REEL_ANTICIPATION_EXT_MS, budget);
        budget -= ext[r];
      }
    }
  }
  return { ext, flags, any, extended };
}

async function spinReels(isZapSpin = false) {

  const reelNodes = document.querySelectorAll(".reel");
  const totalReels = reelNodes.length;

  console.log("spinReels TRIGGERED", isZapSpin ? "⚡ ZAP SPIN!" : "");

  // Remove prior glow / anticipation state
  reelNodes.forEach(r => {
    r.classList.remove("glow-start","glow-stop","reel-anticipation");
    r.style.filter = "none";
  });

  // PRE-CHOOSE FINAL RESULTS for ALL reels BEFORE animation
  const forceScatters = !!window.DEV_FORCE_SCATTERS;
  if (forceScatters) window.DEV_FORCE_SCATTERS = false;
  const forceJackpot = !!window.DEV_FORCE_JACKPOT;
  if (forceJackpot) window.DEV_FORCE_JACKPOT = false;
  const forceBigWin = !!window.DEV_FORCE_BIGWIN;
  if (forceBigWin) window.DEV_FORCE_BIGWIN = false;

  // Dev Mode: pick the top-paying regular symbol for a forced big win so the
  // real scoring and celebration paths run with a genuine large result.
  let bigWinSymIdx = 3;
  if (forceBigWin) {
    let bestPay = -1;
    for (let i = 3; i < ALL_SYMBOLS.length; i++) {
      const p = (ALL_SYMBOLS[i].pay && ALL_SYMBOLS[i].pay[5]) || 0;
      if (p > bestPay) { bestPay = p; bigWinSymIdx = i; }
    }
  }

  // reelIndex -> row to land the forced symbol on
  const scatterReelTargets = { 0: 0, 2: 1, 4: 2 };
  const jackpotReelTargets = { 0: 0, 2: 1, 4: 2 };

  const finalData = [];
  for (let r = 0; r < totalReels; r++) {
    if (forceScatters && scatterReelTargets.hasOwnProperty(r)) {
      finalData[r] = chooseForcedSymbolStop(r, scatterReelTargets[r], SCATTER_INDEX);
    } else if (forceJackpot && jackpotReelTargets.hasOwnProperty(r)) {
      finalData[r] = chooseForcedSymbolStop(r, jackpotReelTargets[r], JACK_INDEX);
    } else if (forceBigWin) {
      // Five of the top symbol across the middle row.
      finalData[r] = chooseForcedSymbolStop(r, 1, bigWinSymIdx);
    } else {
      finalData[r] = chooseStopSymbols(r);
    }
  }

  // ZAP LOGIC: choose the BEST column to maximize payout
  let zapColumn = -1;
  const zapExtraTime = 2000; // extra time for Zylo to fly and zap
  
  if (isZapSpin) {
    // Test each column as wilds and see which gives best payout
    let bestColumn = -1;
    let bestWin = 0;
    
    console.log("🔍 Testing all columns for best zap target:");
    
    for (let col = 0; col < totalReels; col++) {
      // PERMANENT RULE: never zap a column that landed a scatter or a jackpot
      // symbol — zapping would overwrite it with a wild and silently cancel a
      // free spins or jackpot trigger.
      if (finalData[col].symbols.includes(SCATTER_INDEX)) continue;
      if (finalData[col].symbols.includes(JACK_INDEX)) continue;

      // Create FRESH test grid for each column (deep copy to avoid mutation)
      const testGrid = getFinalGrid(finalData);
      
      // Make a deep copy to avoid mutating the original testGrid between iterations
      const testGridCopy = [
        [...testGrid[0]],
        [...testGrid[1]],
        [...testGrid[2]]
      ];
      
      testGridCopy[0][col] = WILD_INDEX;
      testGridCopy[1][col] = WILD_INDEX;
      testGridCopy[2][col] = WILD_INDEX;
      
      const testWin = scoreGrid(testGridCopy);
      
      console.log(`  Column ${col}: Win = ${testWin}`);
      
      if (testWin > bestWin) {
        bestWin = testWin;
        bestColumn = col;
        console.log(`    ✓ New best! Column ${col} with win ${testWin}`);
      }
    }
    
    zapColumn = bestColumn;
    if (zapColumn === -1) {
      console.log('⚡ No valid non-scatter column to zap — skipping zap for this spin');
      isZapSpin = false;
    } else {
      console.log(`⚡ Final choice: Column ${zapColumn} for potential win: ${bestWin}`);
    }
  }

  // ===== Reel spin engine (v2) =====
  // Finite Web-Animations phases per reel:
  //   pull-back -> acceleration -> constant-speed passes ->
  //   linear approach -> deceleration -> controlled bounce.
  // The strip already sits on the true final symbols when it stops, so
  // nothing swaps or jumps at settle. No rAF loops; heights measured once.
  const turboActive = window.isTurboMode && window.isTurboMode();
  const devFast = !!window.DEV_FAST_ANIMS; // Dev Mode: accelerate everything

  const baseDuration = devFast ? 400 : (isZapSpin ? 4000 : (turboActive ? 1000 : 2000));
  const stagger = devFast ? 50 : (turboActive ? 100 : 200);
  const bounceDist = turboActive ? 3 : 6; // small controlled stop bounce

  // Phase timings
  const PULL_MS  = devFast ? 30 : (turboActive ? 50 : 80);    // tiny upward recoil
  const ACCEL_MS = devFast ? 60 : (turboActive ? 110 : 170);  // ramp up to full speed
  const PASS_MS  = devFast ? 130 : (turboActive ? 240 : 480); // one full strip sweep
  const DECEL_MS = devFast ? 80 : (turboActive ? 150 : 300);  // ease into the stop

  // PRE-MEASURE strip + cell heights once (no layout reads mid-animation)
  const stripHeights = [];
  const cellHeights = [];
  reelNodes.forEach((reelEl, i) => {
    const stripEl = reelEl.querySelector(".strip");
    stripHeights[i] = stripEl ? stripEl.scrollHeight : 0;
    cellHeights[i] = getCellHeightForReel(reelEl);
  });

  // OUTCOME-AWARE ANTICIPATION: finalData is fully decided above, so this
  // only extends reels when the landed result genuinely completes an event.
  const plan = planReelAnticipation(finalData, totalReels);
  const extraBefore = [];
  { let acc = 0; for (let r = 0; r < totalReels; r++) { acc += plan.ext[r]; extraBefore[r] = acc; } }

  // Deterministic per-reel loop budget: the main body ends at the classic
  // baseDuration + r*stagger mark (plus any anticipation extension), so
  // ordinary spins stay the same length and stops are always left -> right.
  const loopBudgetFor = (r) => Math.max(PASS_MS,
    baseDuration + r * stagger + extraBefore[r] - (PULL_MS + ACCEL_MS + DECEL_MS));
  const stopAtFor = (r) => r * stagger + PULL_MS + ACCEL_MS + loopBudgetFor(r) + DECEL_MS;

  // Schedule anticipation feedback to begin the moment the previous reel
  // lands. Restrained: glow + subtle vibration + rising sound + one Zylo
  // line, all removed when the reel stops.
  if (plan.any) {
    let zyloHyped = false;
    for (let r = 0; r < totalReels; r++) {
      if (!plan.flags[r]) continue;
      const flaggedReel = reelNodes[r];
      if (plan.extended) {
        const t = Math.max(0, stopAtFor(Math.max(0, r - 1)));
        setTimeout(() => {
          if (!flaggedReel) return;
          flaggedReel.classList.add("reel-anticipation");
          try { if (Sound.anticipation) Sound.anticipation(); } catch (e) {}
          if (!zyloHyped) { zyloHyped = true; zyloSay("anticipation", 85); }
        }, t);
      } else {
        // Turbo / dev-fast: no extension — just a quick flash + short ping
        // right as the qualifying reel lands, so turbo stays fast.
        setTimeout(() => {
          try {
            triggerReelGlow(flaggedReel);
            if (Sound.anticipation) Sound.anticipation(0.25);
          } catch (e) {}
        }, stopAtFor(r));
      }
    }
  }

  // PROMISE LIST FOR ALL REELS
  const reelPromises = [];

  reelNodes.forEach((reelEl, reelIndex) => {

    const stripEl = reelEl.querySelector(".strip");
    if (!stripEl) return;

    // WHAT THIS REEL MUST LAND ON
    const { startIndex } = finalData[reelIndex];
    const cellH = cellHeights[reelIndex] || 100;
    const reelH = cellH * ROWS;
    const stripHeight = stripHeights[reelIndex] || (reelH * 2);
    const finalOffset = -startIndex * cellH;
    const topY = Math.min(0, -(stripHeight - reelH)); // highest strip position
    const passLen = Math.max(cellH, 0 - topY);        // px covered by one full sweep
    const speed = passLen / PASS_MS;                  // px per ms at full speed
    const loopBudget = loopBudgetFor(reelIndex);

    const p = (async () => {
      // STAGGERED REEL START (preserved)
      await waitMs(reelIndex * stagger);

      // Neutralize legacy CSS transitions — all motion below runs through
      // the Web Animations API so phases can't fight a lingering transition.
      stripEl.style.transition = "none";
      const y0 = getTranslateYpx(stripEl) || 0;

      if (!turboActive) reelEl.classList.add("glow-start");
      if (reelIndex === 0) { try { if (Sound.reelWhoosh) Sound.reelWhoosh(); } catch (e) {} }

      // 1) PULL-BACK: small upward recoil before launch (classic slot feel)
      const pullDist = Math.min(12, Math.max(0, y0 - topY));
      await animateTransformPhase(stripEl, y0, y0 - pullDist, PULL_MS, "ease-out");

      // 2) ACCELERATION: quick ease-in downward until at full speed
      let yAccelStart = y0 - pullDist;
      const accelDist = reelH * (turboActive ? 0.7 : 1.1);
      if ((0 - yAccelStart) < accelDist * 0.5) {
        // Not enough headroom below — jump to the strip top first (the old
        // engine always did this hard reset; now it only happens when needed).
        stripEl.style.transform = `translateY(${topY}px)`;
        yAccelStart = topY;
      }
      const yAccelEnd = Math.min(0, yAccelStart + accelDist);
      await animateTransformPhase(stripEl, yAccelStart, yAccelEnd, ACCEL_MS, "cubic-bezier(.55,0,1,.45)");

      // 3) STABLE HIGH-SPEED PASSES: linear full-strip sweeps. The instant
      // reset between passes happens at max speed, where the strip travels
      // several full windows per frame, so consecutive frames share no
      // symbols anyway and the reset reads as one continuous spin.
      let remaining = loopBudget;
      stripEl.style.transform = `translateY(${topY}px)`;
      while (remaining >= PASS_MS * 1.5) {
        await animateTransformPhase(stripEl, topY, 0, PASS_MS, "linear");
        remaining -= PASS_MS;
        stripEl.style.transform = `translateY(${topY}px)`;
      }

      // 4) LINEAR APPROACH: burn the leftover budget at the same speed,
      // ending exactly one deceleration-distance above the target.
      const decelDist = Math.min(passLen, Math.max(cellH, reelH * 1.5));
      const approachMs = Math.max(0, remaining);
      const approachDist = speed * approachMs;
      const yDecelStart = Math.max(topY, finalOffset - decelDist);
      const yApproach = Math.max(topY, finalOffset - decelDist - approachDist);
      stripEl.style.transform = `translateY(${yApproach}px)`;
      if (approachMs > 24) {
        await animateTransformPhase(stripEl, yApproach, yDecelStart, approachMs, "linear");
      } else {
        stripEl.style.transform = `translateY(${yDecelStart}px)`;
      }

      // 5) SMOOTH DECELERATION into the exact final offset — the strip is
      // already showing the true final symbols, so nothing swaps late.
      await animateTransformPhase(stripEl, yDecelStart, finalOffset, DECEL_MS, "cubic-bezier(.22,.9,.32,1)");

      // 6) LANDING: thud/glow + small controlled bounce (skipped in turbo)
      if (turboActive) {
        snapStripToGrid(reelEl, stripEl, cellH);
      } else {
        Sound.reelThud();
        triggerReelGlow(reelEl);
        await waitMs(40);
        await animateTransformPhase(stripEl, finalOffset, finalOffset + bounceDist, 120, "cubic-bezier(.3,1.5,.4,1)");
        Sound.reelTick();
        await animateTransformPhase(stripEl, finalOffset + bounceDist, finalOffset, 90, "cubic-bezier(.3,1,.3,1)");
        snapStripToGrid(reelEl, stripEl, cellH);
      }
      reelEl.classList.remove("reel-anticipation");
    })();

    reelPromises.push(p);
  });

  // WAIT FOR ALL REELS TO FINISH
  await Promise.all(reelPromises);

  // ZAP SEQUENCE: After all reels have stopped
  if (isZapSpin) {
    console.log(`⚡ All reels locked! Zylo preparing to zap column ${zapColumn}...`);
    
    try {
      const reelNodes = document.querySelectorAll('.reel');
      const reelEl = reelNodes[zapColumn];
      const stripEl = reelEl?.querySelector('.strip');
      
      console.log(`⚡ Found reelEl:`, reelEl);
      console.log(`⚡ Found stripEl:`, stripEl);
      console.log(`⚡ stripEl children count:`, stripEl?.children.length);
      
      // STAGE 1: Zylo charges up (visual cue)
      if (zyloEl) {
        zyloEl.classList.add('zap-armed');
      }
      
      // Wait for charge
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // STAGE 2: Move Zylo to target column (smooth glide)
      if (typeof window.moveZyloToReelAnim === 'function') {
        await window.moveZyloToReelAnim(zapColumn);
      }
      
      // STAGE 3: Firing state + beam + INSTANT TRANSFORM
      if (zyloEl) {
        zyloEl.classList.remove('zap-armed');
        zyloEl.classList.add('zap-firing');
      }
      
      // Play sound FIRST (syncs with transformation)
      if (Sound.zap) Sound.zap();
      
      // Fire the visual sequence first. The established WILD conversion runs
      // at its impact point; target choice and payout math are unchanged.
      if (typeof window.fireBeamAnim === 'function') {
        await window.fireBeamAnim(reelEl, () => {
          reelEl?.classList.add('zap-impact');
          finalData[zapColumn].symbols = [WILD_INDEX, WILD_INDEX, WILD_INDEX];
          console.log(`⚡ Transformed column ${zapColumn} data to WILDS:`, finalData[zapColumn].symbols);

          if (!stripEl) return;
          const cells = stripEl.children;
          const wildIcon = ALL_SYMBOLS[WILD_INDEX].icon;
          const len = cells.length;
          const startIndex = finalData[zapColumn].startIndex;
          for (let row = 0; row < 3; row++) {
            const cell = cells[(startIndex + row) % len];
            if (!cell) continue;
            cell.innerHTML = wildIcon;
            cell.classList.add('zapped', 'wild');
          }
        });
      }
      
      // Hold briefly after impact before clearing state.
      await new Promise(resolve => setTimeout(resolve, 100));

      await new Promise(resolve => setTimeout(resolve, 200));

      // Final cleanup - return to normal
      await new Promise(resolve => setTimeout(resolve, 300));
      if (reelEl) {
        reelEl.classList.remove('zap-impact');
      }
      if (zyloEl) {
        zyloEl.classList.remove('zap-firing');
      }

      // Glide Zylo back to center after the zap finishes (do not block scoring)
      moveZyloToCenter();
      
      console.log("⚡ Zap complete! Column transformed to WILDS");
    } catch (err) {
      console.warn("Zap animation error:", err);
    }
  }

  // NOW evaluate results (finalData now has wilds if zapped)
  evaluateSpinResults(finalData);
}

function evaluateSpinResults(finalData) {
  console.log("finalData received:", finalData);
  console.log("finalData[0]:", finalData[0]);
  
  try {
    const grid = getFinalGrid(finalData);
    
    console.log("Final Grid:");
    console.log(grid[0].join(" | "));
    console.log(grid[1].join(" | "));
    console.log(grid[2].join(" | "));
    
    console.log("Grid sample check:", {
      grid00: grid[0][0],
      isNumber: typeof grid[0][0] === 'number',
      symbol: ALL_SYMBOLS[grid[0][0]],
      allSymbolsLength: ALL_SYMBOLS.length
    });
    
    // UPDATE DOM: Render final grid visually (includes wilds if zapped)
    const reelNodes = document.querySelectorAll('.reel');
    for (let col = 0; col < grid[0].length; col++) {
      const reelEl = reelNodes[col];
      const stripEl = reelEl?.querySelector('.strip');
      if (!stripEl) continue;
      
      const cells = stripEl.children;
      const startIndex = finalData[col].startIndex;
      const len = cells.length;
      
      // Update the 3 visible cells with final symbols
      for (let row = 0; row < 3; row++) {
        const cellIndex = (startIndex + row) % len;
        const cell = cells[cellIndex];
        const symbolIndex = grid[row][col];
        
        if (cell && ALL_SYMBOLS[symbolIndex]) {
          cell.innerHTML = ALL_SYMBOLS[symbolIndex].icon;
          // Add wild class if it's a wild symbol
          if (symbolIndex === WILD_INDEX) {
            cell.classList.add('wild', 'zapped');
          }
        }
      }
    }
    
    // grid is already symbol indices, ready to score
    const win = scoreGrid(grid);

    // Check for 3+ scatters landing -> award free spins + trigger intro sequence.
    // (No mid-session retrigger for now — only awards if not already in free spins.)
    let scatterCount = 0;
    finalData.forEach(fd => fd.symbols.forEach(s => { if (s === SCATTER_INDEX) scatterCount++; }));
    if (scatterCount >= 3 && !isFreeSpin) {
      // Feature transitions and auto-play don't mix: the free spins session
      // schedules its own spins, so a still-armed auto-play timer would
      // double-fire into the bonus. Stop it cleanly before the intro.
      if (isAutoPlaying) {
        stopAutoPlay();
        say("Free spins! Auto-play stopped.");
      }
      const award = (scatterCount === 3) ? 4 : (scatterCount === 4) ? 6 : 8; // rebalanced from 5/8/10
      freeSpins += award;
      freeSpinsTotalWin = 0; // fresh session
      updateFreeSpinsBanner();
      // Small pause so the player actually sees the 3 scatters land
      // before the shake/transition kicks in.
      setTimeout(() => {
        window.playFreeSpinsIntro(() => {
          console.log('Free spins intro complete — auto-starting first free spin');
          setTimeout(() => {
            if (!isSpinning) spin();
          }, 500);
        });
      }, 600);
    }

    // ===== JACKPOT =====
    // Count JACK symbols that landed this spin, feed the meter, and trigger
    // the jackpot when enough land on a paid spin.
    let jacksThisSpin = 0;
    finalData.forEach(fd => fd.symbols.forEach(s => { if (s === JACK_INDEX) jacksThisSpin++; }));

    // Free spins contribute half toward the meter; paid spins contribute full.
    jackStacks += isFreeSpin ? (jacksThisSpin * 0.5) : jacksThisSpin;
    jackStacks = Math.min(jackStacks, JACK_STACKS_CAP);

    let jackTriggered = false;
    let jackTriggerReason = '';
    if (!isFreeSpin) {
      // Path A: landing JACK_REQUIRED (3) or more jackpot symbols on a paid
      // spin guarantees the jackpot.
      if (jacksThisSpin >= JACK_REQUIRED) {
        jackTriggered = true;
        jackTriggerReason = `${jacksThisSpin} jackpot symbols`;
      } else if (jacksThisSpin > 0) {
        // Path B: every jackpot symbol that lands gets its OWN roll to "pop"
        // the jackpot — so even a single one can hit at any time.
        for (let i = 0; i < jacksThisSpin; i++) {
          if (Math.random() < JACK_POP_CHANCE) {
            jackTriggered = true;
            jackTriggerReason = 'jackpot symbol popped!';
            break;
          }
        }
      }

      // Didn't hit — decay the meter slightly so it can't creep up forever.
      if (!jackTriggered) {
        jackStacks = Math.max(0, jackStacks * (1 - JACK_DECAY_ON_MISS));
      }
    }

    // Keep the on-screen jackpot planet meter in sync with the stacks
    setJackpotMeter(Math.round((jackStacks / JACK_STACKS_CAP) * 100));

    if (jackTriggered && jackpotMode === 'auto') {
      // Same rule as free spins: never let auto-play race the jackpot round.
      if (isAutoPlaying) {
        stopAutoPlay();
        say("Jackpot! Auto-play stopped.");
      }
      console.log(`💥 JACKPOT TRIGGERED — ${jackTriggerReason}`);
      // Kick off the Hold & Win jackpot round.
      setTimeout(() => {
        window.playJackpotIntro(() => {
          startHoldAndWin();
        });
      }, 600);
    }

    // Track winnings earned during a free spins session for the banner total
    if (isFreeSpin && win > 0) {
      freeSpinsTotalWin += win;
    }
    if (isFreeSpin) {
      updateFreeSpinsBanner();
    }
    
    // Store finalData globally for highlighting
    window.lastFinalData = finalData;
    
    // Update UI
    if (isFreeSpin) {
      // Don't touch visible balance mid-session — winnings are held in
      // freeSpinsTotalWin and added to balance all at once when the
      // free spins session ends (see endFreeSpinsSession).
      animateWinCounter(win);
    } else {
      balance += win;
      updateBalanceUI();
      animateWinCounter(win);
    }
    
    // Check for big win BEFORE celebration
    const isBigWin = win >= bet * 3;
    
    // Big win celebration
    if (isBigWin) {
      celebrateBigWin(win);
      // Stop auto-play immediately on big win
      if (isAutoPlaying) {
        setTimeout(() => {
          say("Big win! Auto-play stopped.");
          stopAutoPlay();
        }, 500); // Small delay so user sees the message after celebration starts
      }
    }
    
    if (win > 0) {
      say(`Win: ${formatCurrency(win)}!`);
      flashWin(true);
      highlightWinningSymbols();
      showFloatingWinPopup(win);
    } else {
      say("Next time!");
    }

    // If that was the LAST free spin (session just ran out), wrap up the
    // bonus: show the total won, then transition back to normal play.
    if (isFreeSpin && freeSpins === 0) {
      setTimeout(() => {
        window.endFreeSpinsSession();
      }, 1400);
    }
  } catch (err) {
    console.error("evaluateSpinResults error:", err);
  }
  
  isSpinning = false;
  
  // Trigger auto-play continuation (only if not stopped by big win)
  if (isAutoPlaying) {
    onAutoSpinComplete();
  } else if (isFreeSpin && freeSpins > 0) {
    // Mid-session free spin with spins remaining — auto-continue so the
    // player doesn't have to keep clicking Spin during the bonus.
    setTimeout(() => {
      if (!isSpinning) spin();
    }, 1600);
  }
}

function getReelStagger(reelIndex) {
  // nonlinear stagger curve (feels more dramatic)
  // Try values: 0.9, 1.2, 1.5 to tune intensity
  const curve = 1.25;

  return Math.round(REEL_STAGGER_MS * Math.pow(curve, reelIndex));
}

function reelGlowStart(reelEl) {
  reelEl.classList.add("glow-start");
  setTimeout(() => reelEl.classList.remove("glow-start"), 180);
}

function reelGlowStop(reelEl) {
  reelEl.classList.add("glow-stop");
  setTimeout(() => {
    reelEl.classList.add("glow-clear");
    reelEl.classList.remove("glow-stop");
    setTimeout(() => reelEl.classList.remove("glow-clear"), 220);
  }, 160);
}

function setFrameGlowColumn(colIndex) {
  const frame = document.querySelector('.slot-frame'); // adjust to your frame element
  if (!frame) return;

  frame.style.setProperty('--glow-col', colIndex);
  frame.classList.add('glow-active');

  // If you want the glow to fade after last reel:
  // if (colIndex === REEL_COUNT - 1) {
  //   setTimeout(() => frame.classList.remove('glow-active'), 300);
  // }
}

function applyColumnGlow(colIndex) {
  const frame = document.querySelector('.slot-frame');
  if (!frame) return;

  frame.style.setProperty('--glow-col', colIndex);
}

function triggerReelGlow(reelEl) {
  if (!reelEl) return;

  // Remove existing glow states
  reelEl.classList.remove("glow-start", "glow-stop");

  // Force DOM reflow so the new class animates cleanly
  reelEl.offsetWidth;

  // Apply the stop glow (yellow thud glow)
  reelEl.classList.add("glow-stop");

  // Remove the glow after it fades (optional)
  setTimeout(() => {
    reelEl.classList.remove("glow-stop");
  }, 200);
}

// ---------- Spin flow ----------
async function spin(zapOverride){

  // Clear any leftover win lines before spinning
  if (window.winLineTimers) {
    window.winLineTimers.forEach(id => clearTimeout(id));
    window.winLineTimers = [];
  }
  if (window.winLineCleanupTimer) {
    clearTimeout(window.winLineCleanupTimer);
    window.winLineCleanupTimer = null;
  }
  document.querySelectorAll('.win-line, .win-line-overlay, .winning-cell, .highlighted').forEach(el => {
    el.classList.remove('win-line', 'win-line-overlay', 'winning-cell', 'highlighted');
    el.style.boxShadow = '';
    el.style.border = '';
  });

  if (isSpinning) return;

  try {
    // Cancel any pending win-line timers from a previous spin
    if (window.winLineTimers && Array.isArray(window.winLineTimers)) {
      window.winLineTimers.forEach(id => clearTimeout(id));
      window.winLineTimers = [];
    }
    if (window.winLineCleanupTimer) {
      clearTimeout(window.winLineCleanupTimer);
      window.winLineCleanupTimer = null;
    }
    window.winLineTotalDuration = 0;

    // Clear any lingering win animations immediately
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('winning-symbol');
    });
    document.querySelectorAll('.win-line').forEach(line => line.remove());
    
    console.log("spin() called - freeSpins:", freeSpins);
    const paidSpin = freeSpins === 0;
    isFreeSpin = !paidSpin;

    if (paidSpin){
      if (balance < bet) {
        say("Need more credits!");
        if (balance <= 0) {
          setTimeout(() => {
            if (confirm("You're out of credits! Reset to 1000 to keep playing?")) {
              balance = 1000;
              updateBalanceUI();
            }
          }, 400);
        }
        return;
      }
      if (!window.DEV_INFINITE_BALANCE) balance -= bet; // Dev Mode toggle
      updateBalanceUI();
      // seed the pot with a portion of the paid bet
      jackpot += Math.round(bet * JACKPOT_RATE * 100) / 100; // cents precision
      if (jackpot < JACKPOT_MIN) jackpot = JACKPOT_MIN;
      // updateJackpotUI(); // enable if you display the pot live
    } else {
      // consume one free spin
      freeSpins--;
      if (freeSpins > 0) say(`Free Spin! ${freeSpins} left`);
      else say("Free Spin used");
    }

    isSpinning = true;

    // sounds on user gesture
    playTag("spinSfx");   // try HTML audio
    Sound.click();        // guaranteed fallback

    zyloSay('spin');

    // decide zap ahead of time to extend spin & prep visuals
    const zapWillTrigger = (typeof zapOverride === 'boolean') ? zapOverride : tryZap();
    isZapSpin = zapWillTrigger;

    // Allow developer overrides for spin timing via window.DEV_* flags
    const baseSpin = (typeof window.DEV_BASE_SPIN_MS === 'number') ? window.DEV_BASE_SPIN_MS : BASE_SPIN_MS;
    const reelStagger = (typeof window.DEV_REEL_STAGGER_MS === 'number') ? window.DEV_REEL_STAGGER_MS : REEL_STAGGER_MS;
    const extra = zapWillTrigger
      ? ((typeof window.DEV_ZAP_EXTRA_MS === 'number') ? window.DEV_ZAP_EXTRA_MS : ZAP_EXTRA_MS)
      : 0;

    // pick which reel Zylo will zap (0..REEL_COUNT-1), default to center if not zapping
    currentZapCol = zapWillTrigger ? randInt(REEL_COUNT) : 2;

    // pick stops and compute final visible symbols for each reel
    const stops = [];
    const finals = []; // finals[reel][row] -> ALL_SYMBOLS index
    for (let r=0;r<REEL_COUNT;r++){
      stops[r] = randInt(reels[r].length);
      finals[r] = [];
      for (let row=0;row<ROWS;row++){
        const idx = (stops[r] + row) % reels[r].length;
        finals[r][row] = reels[r][idx];
      }
    }

    // VISUAL SPIN: long downward scroll on real strips
    await spinReels(zapWillTrigger);

    // spinReels now handles evaluation internally via evaluateSpinResults()

  } catch (err){
    console.error("spin() error:", err);
    isSpinning = false;
  }
}

// Small helper that provides the "longerSpin" boolean API the UI or other
// systems can call. It forwards to spin(zapOverride) so timing is centralized
// in a single place. Exposed on window for dev/testing.
function startSpin(longerSpin){
  spin(!!longerSpin);
}
window.startSpin = startSpin;

// ---------- Zap helpers ----------
// Convert finals (reels x rows) into grid (rows x reels)
// OLD VERSION - replaced by new getFinalGrid above
function getFinalGridOLD(finals){
  const grid = Array.from({length: ROWS}, ()=>Array(REEL_COUNT).fill(0));
  for (let r=0;r<REEL_COUNT;r++){
    for (let row=0;row<ROWS;row++) grid[row][r] = finals[r][row];
  }
  return grid;
}

// performZap(finals, done) — if finals already contain wilds this is a no-op.
// Otherwise it animates Zylo firing and turns 1-3 positions into WILDs, then
// calls done(). This is safe to call even if a mid-spin zap already ran.
function performZap(finalGrid, onComplete){
  // finalGrid is rows x reels
  if (!zyloEl || !zyloOrbit){
    isZapSpin = false;
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  const reelsEls = document.querySelectorAll('.reel');
  if (!reelsEls.length){
    isZapSpin = false;
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  const targets = chooseZapTargets(finalGrid);
  if (!targets || !targets.length){
    clearZapState();
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  // convert grid (rows x reels) -> finals (reels x rows) for data mutation helper
  const finals = getFinalsFromGrid(finalGrid);

  let index = 0;
  const zapNext = () => {
    if (index >= targets.length){
      // When all zap targets are done, glide Zylo back to center, THEN clean up & score.
      moveZyloToCenter(() => {
        clearZapState();
        if (typeof onComplete === 'function') onComplete();
      });
      return;
    }

    const target = targets[index];
    const symbolEl = getSymbolElement(target.row, target.col);

    if (!symbolEl){ index++; zapNext(); return; }

    zyloEl.classList.add('zap-armed');

    aimZyloAtSymbol(symbolEl, ()=>{
      fireZapBeamToSymbol(symbolEl, ()=>{
        // convert data + DOM
        zapSymbolToWild(finals, target.row, target.col);
        index++;
        setTimeout(zapNext, 100);
      });
    });
  };

  // ensure Zylo looks charged
  zyloEl.classList.add('zap-armed');
  zapNext();
}

function getFinalsFromGrid(grid){
  const finals = Array.from({length: REEL_COUNT}, ()=>Array(ROWS).fill(0));
  for (let r=0;r<REEL_COUNT;r++) for (let row=0;row<ROWS;row++) finals[r][row] = grid[row][r];
  return finals;
}

function getSymbolElement(row, col){
  // Primary approach: treat each `.reel` as a column (col index = `col`).
  const reels = document.querySelectorAll('.reel');
  const reel = reels[col];
  if (reel) {
    // 1) If strips/cells layout (common in this codebase)
    const strip = reel.querySelector('.strip');
    if (strip) {
      const cells = strip.querySelectorAll('.cell');
      // Many implementations add extra offscreen cells (e.g. visible middle window at index row+1).
      const useMiddle = (cells.length >= ROWS + 2) ? 1 : 0;
      return cells[row + useMiddle] || null;
    }

    // 2) If reel uses individual `.symbol` elements top->bottom
    const symbols = reel.querySelectorAll('.symbol');
    if (symbols && symbols.length) return symbols[row] || null;

    // 3) If reel has direct `.cell` children (no strip wrapper)
    const directCells = reel.querySelectorAll('.cell');
    if (directCells && directCells.length) return directCells[row] || null;

    // 4) Data attribute fallback (e.g. data-row="0")
    const byData = reel.querySelector(`[data-row="${row}"]`);
    if (byData) return byData;

    // 5) Last resort: return nth child
    return reel.children[row] || null;
  }

  // Global fallback: try to compute from all cells if layout is flattened
  const allStrips = document.querySelectorAll('.reel .strip');
  if (allStrips && allStrips.length > 0) {
    const strip = allStrips[col];
    if (strip) {
      const cells = strip.querySelectorAll('.cell');
      const useMiddle = (cells.length >= ROWS + 2) ? 1 : 0;
      return cells[row + useMiddle] || null;
    }
  }

  return null;
}

function aimZyloAtSymbol(symbolEl, cb){
  if (!zyloOrbit || !appEl || !symbolEl) { if (typeof cb==='function') cb(); return; }

  const appRect = appEl.getBoundingClientRect();
  const symbolRect = symbolEl.getBoundingClientRect();

  // Symbol center X in app coordinates
  const symbolCenterX = symbolRect.left - appRect.left + symbolRect.width / 2;

  // Decide visual tilt based on horizontal direction we're about to move
  try {
    const currentX = zyloOrbit.getBoundingClientRect().left;
    const targetX = symbolCenterX;
    if (targetX < currentX) {
      zyloOrbit.classList.add("tilt-left");
      zyloOrbit.classList.remove("tilt-right");
    } else {
      zyloOrbit.classList.add("tilt-right");
      zyloOrbit.classList.remove("tilt-left");
    }
  } catch (e) {
    // ignore measurement errors
  }

  // Because .zylo-orbit often uses `transform: translateX(-50%)`, setting
  // `left` to the symbol center in pixels places the visual center above
  // the symbol. Use pixels for a smooth, layout-stable glide.
  zyloOrbit.style.left = `${symbolCenterX}px`;

  // Wait a short moment for the transition to complete before zapping
  // Wait for the glide to finish before zapping
  const moveDuration = (window.CONFIG && typeof window.CONFIG.ZYLO_MOVE_DURATION === 'number')
    ? window.CONFIG.ZYLO_MOVE_DURATION
    : 450;
  setTimeout(() => {
    if (typeof cb === 'function') cb();
  }, moveDuration + 50);
}

function moveZyloToCenter(cb){
  if (!zyloOrbit) {
    if (typeof cb === 'function') cb();
    return;
  }

  // Glide back to the horizontal center of the Zylo stage
  const returnDuration = (window.CONFIG && typeof window.CONFIG.ZYLO_RETURN_DURATION === 'number')
    ? window.CONFIG.ZYLO_RETURN_DURATION
    : 3000;
  zyloOrbit.style.transition = `left ${returnDuration}ms cubic-bezier(.2,.7,.2,1)`;
  requestAnimationFrame(() => {
    zyloOrbit.style.left = '50%';
  });
  zyloOrbit.classList.remove('tilt-left', 'tilt-right');

  // Wait for the glide to finish. Match this to your CSS transition time.
  setTimeout(() => {
    if (typeof cb === 'function') cb();
  }, returnDuration + 50);
}

function fireZapBeamToSymbol(symbolEl, onDone){
  const beam = zapBeam ?? zyloOrbit?.querySelector('.zap-beam') ?? document.querySelector('.beam');
  if (!beam || !zyloOrbit || !symbolEl) { if (typeof onDone === 'function') onDone(); return; }

  const symbolRect = symbolEl.getBoundingClientRect();
  const zyloRect = zyloOrbit.getBoundingClientRect();

  // Start: just under Zylo
  const startY = zyloRect.bottom;
  // Hit: at the vertical center of the symbol
  const targetY = symbolRect.top + symbolRect.height / 2;

  const beamLength = Math.max(0, Math.round(targetY - startY));

  // Restart zap-firing animation cleanly
  zyloEl?.classList.remove('zap-firing');
  void zyloEl?.offsetWidth; // reset animation
  zyloEl?.classList.add('zap-firing');

  // Set beam length + show it
  beam.style.height = `${beamLength}px`;
  beam.classList.add('active');

  // Small delay then hide beam and call onDone
  setTimeout(() => {
    beam.classList.remove('active');
    beam.style.height = '0px';
    if (typeof onDone === 'function') onDone();
  }, 420); // was 140 — slower beam retreat for more impact
}

function clearZapState(){
  zyloEl?.classList.remove('zap-armed','zap-firing');
  zapBeam?.classList.remove('active');
  if (zapBeam) zapBeam.style.height = '0px';
  isZapSpin = false;
}

// Choose ONE column and zap all rows in that column
function chooseZapTargets(finalGrid){
  const rows = finalGrid.length;
  const cols = finalGrid[0].length;

  // Pick a column, biased towards the center reels on 5x3
  let col;
  if (cols === 5) {
    const choices = [1, 2, 3]; // middle reels
    col = sample(choices);
  } else {
    col = randInt(cols);
  }

  const targets = [];
  for (let row = 0; row < rows; row++) {
    targets.push({ row, col });
  }
  return targets;
}

// Convert one symbol to a wild in data + DOM. finals is reels x rows.
function zapSymbolToWild(gridOrFinals, row, col){
  // Support both shapes:
  // - finals (reels x rows): gridOrFinals[col][row]
  // - finalGrid (rows x reels): gridOrFinals[row][col]
  try {
    if (!gridOrFinals) return;

    if (Array.isArray(gridOrFinals) && gridOrFinals.length === ROWS && Array.isArray(gridOrFinals[0]) && gridOrFinals[0].length === REEL_COUNT) {
      // rows x reels
      gridOrFinals[row][col] = WILD_INDEX;
    } else if (Array.isArray(gridOrFinals) && gridOrFinals.length === REEL_COUNT && Array.isArray(gridOrFinals[0]) && gridOrFinals[0].length === ROWS) {
      // reels x rows
      if (gridOrFinals[col]) gridOrFinals[col][row] = WILD_INDEX;
    }
  } catch (e) {
    // If mutation fails, continue to try DOM update — do not throw
    console.warn('zapSymbolToWild: could not update data structure', e);
  }

  // DOM update: try to find the visible element for (row,col)
  const symbolEl = getSymbolElement(row, col);
  if (!symbolEl) return;

  symbolEl.classList.add('zap-wild', 'zap-wild-flash');
  // Use the configured WILD icon if available (render HTML)
  symbolEl.innerHTML = (ALL_SYMBOLS[WILD_INDEX] && ALL_SYMBOLS[WILD_INDEX].icon) ? ALL_SYMBOLS[WILD_INDEX].icon : 'W';

  setTimeout(() => {
    symbolEl.classList.remove('zap-wild-flash');
  }, 150);
}

// finishSpin handles scoring, jackpot checks, UI updates. Accepts grid (rows x reels)
// and finals (reels x rows) so it can compute both scoring and symbol counts.
function finishSpin(grid, finals){
  const { count: scatters, distinctRows } = getScatterStats(finals);

  // Only award if 3+ scatters AND they span all 3 rows
  if (!isFreeSpin && scatters >= 3){
    const award = (scatters===3?8 : scatters===4?12 : 15);
    freeSpins += award;
    zyloSay('freeSpins', 100);
  }

  // score
  let win = scoreGrid(grid);
  if (isFreeSpin) win = Math.round(win * freeSpinMult);

  // --- JACK feature: count symbols this spin, update stacks, decide trigger
  const jacksThisSpin = countJackSymbols(finals);

  // stack gains: paid spins add full, free spins add half (you can change this)
  if (isFreeSpin) jackStacks += jacksThisSpin * 0.5;
  else            jackStacks += jacksThisSpin;
  // clamp stacks to cap to avoid runaway
  jackStacks = Math.min(jackStacks, JACK_STACKS_CAP);

  const meterPercent = Math.round((jackStacks / JACK_STACKS_CAP) * 100);
  setJackpotMeter(meterPercent);

  let jackTriggered = false;
  if (!isFreeSpin){ // only award on paid spins (common choice)
    if (jacksThisSpin >= JACK_REQUIRED){
      jackTriggered = true;               // guarantee if ≥ required in one spin
    } else {
      // probabilistic jackpot trigger temporarily disabled (will rebuild later)
    }

    // decay stacks a little if it didn't trigger (prevents runaway)
    if (!jackTriggered) jackStacks = Math.max(0, jackStacks * (1 - JACK_DECAY_ON_MISS));
  }

  // if jackpot triggers → award pot, reset stacks & pot
  if (jackTriggered && jackpotMode === 'auto'){
    triggerJackpotWin();
  }

  // simple jackpot award chance that scales with pot size (tune later)
  function jackpotHitChance(){
    const n = Math.max(5000, 150000 - jackpot);
    return randInt(n) === 0;
  }

  if (!isFreeSpin && !jackTriggered && jackpotMode === 'auto' && jackpotHitChance()){
    triggerJackpotWin();
    // TODO: play sound / flash UI
  }

  balance += win; updateBalanceUI();
  animateWinCounter(win);
  
  // Big win celebration
  if (win >= bet * 3) {
    celebrateBigWin(win);
  }
  
  if (win >= bet*5) zyloSay('winBig', 100);
  else if (win>0) zyloSay('winSmall');
  else zyloSay('loss', 20);
  flashWin(win>0);

  // ensure any armed/firing visuals are cleared
  zyloEl?.classList.remove('zap-armed');
  zyloEl?.classList.remove('zap-firing');

  isSpinning = false;
  const sb = document.getElementById('spin');
  if (sb) sb.disabled = false;
}

// handleSpinEnd(grid, finals) delegates to performZap when needed then finishes
function handleSpinEnd(grid, finals){
  finishSpin(grid, finals);
}

// Compatibility helper: accept a finalGrid (rows x reels) and compute win using
// `calculateWin` if available, falling back to `scoreGrid`. Updates UI and
// balance and clears spinning. Exposed as `window.finishSpin(finalGrid)` for
// external callers and testing.
function finishSpinGrid(finalGrid){
  // clear any spinning state used elsewhere
  isSpinning = false;

  const calc = (typeof calculateWin === 'function') ? calculateWin : scoreGrid;
  const win = calc(finalGrid);

  animateWinCounter(win);
  balance += win; updateBalanceUI();
  
  // Big win celebration
  if (win >= bet * 3) {
    celebrateBigWin(win);
  }
  
  flashWin(win>0);

  // cleanup zylo visuals
  zyloEl?.classList.remove('zap-armed');
  zyloEl?.classList.remove('zap-firing');
}

// expose for console/testing without replacing the internal finishSpin
window.finishSpin = finishSpinGrid;
function pickZapTargets(){
  // usually 1, sometimes 2 wilds, but all on the same reel Zylo is beaming
  const count = 1 + (randInt(100) < 30 ? 1 : 0);
  const picks = [];
  const col = Math.min(Math.max(currentZapCol, 0), REEL_COUNT - 1);

  // build row choices only for that reel
  const rowChoices = [];
  for (let row = 0; row < ROWS; row++) rowChoices.push(row);

  while (picks.length < count && rowChoices.length){
    const rowIndex = rowChoices.splice(randInt(rowChoices.length), 1)[0];
    picks.push({ row: rowIndex, col });
  }

  return picks;
}

function fireBeam(targetReel, onImpact){
  const beam = document.querySelector('.zap-beam');
  const target = targetReel || document.querySelector(`.reel[data-reel="${currentZapCol}"]`);
  if (!beam || !target || !appEl || !zyloEl) {
    if (typeof onImpact === 'function') onImpact();
    return Promise.resolve();
  }

  const appRect = appEl.getBoundingClientRect();
  const zyloRect = zyloEl.getBoundingClientRect();
  const reelRect = target.getBoundingClientRect();
  const sourceY = zyloRect.bottom - appRect.top - 8;
  const targetCenterX = reelRect.left - appRect.left + reelRect.width / 2;
  const beamHeight = Math.max(0, reelRect.bottom - appRect.top - sourceY);

  beam.style.left = `${targetCenterX}px`;
  beam.style.top = `${sourceY}px`;
  beam.style.width = `${reelRect.width + 8}px`;
  beam.style.height = `${beamHeight}px`;
  beam.className = 'zap-beam';
  void beam.offsetWidth; // restart the CSS-only sequence cleanly

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  return (async () => {
    beam.classList.add('zap-charge');
    await wait(160);
    beam.classList.replace('zap-charge', 'zap-fire');
    await wait(240);
    beam.classList.replace('zap-fire', 'zap-impact');
    if (typeof onImpact === 'function') onImpact();
    await wait(180);
    beam.classList.replace('zap-impact', 'zap-dissipate');
    await wait(260);
    beam.className = 'zap-beam';
  })();
}

function applyZapToFinals(picks, finals){
  picks.forEach(({row,col})=>{ finals[col][row] = WILD_INDEX; });
}

function paintZapToDOM(picks){
  const strips = document.querySelectorAll(".reel .strip");
  picks.forEach(({row,col})=>{
    const strip = strips[col];
    const cell = strip.querySelectorAll(".cell")[row+1]; // the visible middle cell
    cell.innerHTML = WILD.icon;
    cell.classList.add("wild","zapped");
  });
}

// ---------- Free Spins banner helpers (UI) ----------
// Free-spins UI removed per user request (badge/banner handled elsewhere)

// ---------- Scoring (wild substitutes left-to-right) ----------
function scoreGrid(grid){
  let total = 0;
  // The displayed bet is the TOTAL wager for the whole spin. Line wins are
  // priced per line so all units stay consistent.
  const betPerLine = bet / PAYLINES.length;
  const winningLines = []; // Track winning lines for highlighting
  console.log("🎰 scoreGrid called with grid:", grid);
  
  for (let lineIndex = 0; lineIndex < PAYLINES.length; lineIndex++) {
    const line = PAYLINES[lineIndex];
    let matchSymbol = null, count = 0;

    for (let r=0;r<REEL_COUNT;r++){
      const idx = grid[line[r]][r];
      
      if (idx === WILD_INDEX){ 
        count++; 
        continue; 
      }
      
      if (matchSymbol === null){ 
        matchSymbol = idx; 
        count++; 
      }
      else if (idx === matchSymbol){ 
        count++; 
      }
      else break;
    }

    // determine which symbol we matched (treat leading wilds as the first actual)
    let si = (matchSymbol===null) ? WILD_INDEX : matchSymbol;
    const sym = ALL_SYMBOLS[si];

    if (count >= 3) {
      console.log(`  Line check: matchSymbol=${matchSymbol}, count=${count}, symbol=${sym?.key}, pay=${sym?.pay?.[count] || 0}`);
    }

    // Every symbol pays from 3-of-a-kind. The old 2-of-a-kind rule referenced
    // symbols that no longer exist (LASER, EGG) and never actually paid, so
    // it has been removed rather than repaired.
    const minCount = 3;

    if (count >= minCount){
      const pay = sym.pay?.[count] || 0;
      if (pay > 0) {
        // Pays are per-line multipliers of the per-line stake.
        const winAmount = betPerLine * pay;
        console.log(`    ✓ WIN! ${count}x ${sym.key} = ${winAmount}`);
        total += winAmount;
        
        // Store winning line info
        winningLines.push({
          lineIndex,
          line,
          count,
          symbolKey: sym.key
        });
      }
    }
  }
  
  total = Math.round(total * 100) / 100; // money rounds to cents
  console.log(`  Total win: ${total}`);
  if (!window.SIM_MODE) {
    // Presentation and state side effects, skipped while the simulator
    // runs so 100k+ logic-only calls never touch the DOM or spin state.
    isSpinning = false;
    const scoreSpinBtn = document.getElementById('spin');
    if (scoreSpinBtn) scoreSpinBtn.disabled = false;
    window.lastWinningLines = winningLines;
  }
  
  return total;
}

// Highlight winning symbols
function highlightWinningSymbols() {
  // Cancel any pending timers from a previous win
  if (window.winLineTimers && Array.isArray(window.winLineTimers)) {
    window.winLineTimers.forEach(id => clearTimeout(id));
  }
  if (window.winLineCleanupTimer) {
    clearTimeout(window.winLineCleanupTimer);
  }
  window.winLineTimers = [];

  // Clear any previous highlights
  document.querySelectorAll('.cell').forEach(cell => {
    cell.classList.remove('winning-symbol');
  });
  document.querySelectorAll('.win-line').forEach(line => line.remove());

  if (!window.lastWinningLines || window.lastWinningLines.length === 0) return;

  console.log("🎯 Highlighting winning symbols:", window.lastWinningLines);

  // Collect all winning cell positions
  const winningPositions = new Set();

  window.lastWinningLines.forEach(winLine => {
    const { line, count } = winLine;

    // Highlight the first 'count' symbols on this line
    for (let col = 0; col < count; col++) {
      const row = line[col];
      winningPositions.add(`${row}-${col}`);
    }
  });

  // Apply a pulsing glow to every winning symbol, all at once — simpler and
  // far less timer-juggling than drawing/staggering connecting lines, and
  // less prone to leftover visuals sticking around after a win.
  const reelsContainer = document.getElementById('slot');
  if (!reelsContainer) return;

  winningPositions.forEach(pos => {
    const [row, col] = pos.split('-').map(Number);
    const reelEl = document.querySelector(`.reel[data-reel="${col}"]`);
    if (!reelEl) return;

    const stripEl = reelEl.querySelector('.strip');
    if (!stripEl) return;

    // Get the finalData for this reel to find the correct cell
    const finalData = window.lastFinalData;
    if (!finalData || !finalData[col]) return;

    const startIndex = finalData[col].startIndex;
    const cells = stripEl.children;
    const cellIndex = (startIndex + row) % cells.length;
    const cell = cells[cellIndex];

    if (cell) {
      cell.classList.add('winning-symbol');
    }
  });

  // Fixed hold duration — no longer dependent on staggering multiple lines
  const totalDuration = 1400;
  window.winLineTotalDuration = totalDuration;
  window.winLineCleanupTimer = setTimeout(() => {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('winning-symbol');
    });
  }, totalDuration);
}

// Floating "+$X" popup that rises and fades next to the win display,
// giving a clear extra cue for a win without drawing connecting lines.
function showFloatingWinPopup(amount) {
  if (!amount || amount <= 0) return;
  const lastWinEl = document.getElementById('lastWin');
  if (!lastWinEl) return;

  const popup = document.createElement('div');
  popup.className = 'floating-win-popup';
  popup.textContent = `+${formatCurrency(amount)}`;

  const rect = lastWinEl.getBoundingClientRect();
  popup.style.left = `${rect.left + rect.width / 2}px`;
  popup.style.top = `${rect.top}px`;

  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 1400);
}

// Draw a line through winning symbols
function drawWinLine(winLine, lineIndex) {
  const { line, count } = winLine;
  const reelsContainer = document.getElementById('slot');
  if (!reelsContainer) return;
  
  const finalData = window.lastFinalData;
  if (!finalData) return;
  
  // Calculate positions for each symbol in the winning line
  const points = [];
  
  for (let col = 0; col < count; col++) {
    const row = line[col];
    const reelEl = document.querySelector(`.reel[data-reel="${col}"]`);
    if (!reelEl) continue;
    
    const stripEl = reelEl.querySelector('.strip');
    if (!stripEl) continue;
    
    const startIndex = finalData[col].startIndex;
    const cells = stripEl.children;
    const cellIndex = (startIndex + row) % cells.length;
    const cell = cells[cellIndex];
    
    if (cell) {
      const cellRect = cell.getBoundingClientRect();
      const containerRect = reelsContainer.getBoundingClientRect();
      
      // Get center of the cell relative to the container
      const x = cellRect.left - containerRect.left + cellRect.width / 2;
      const y = cellRect.top - containerRect.top + cellRect.height / 2;
      
      points.push({ x, y });
    }
  }
  
  if (points.length < 2) return;
  
  // Create SVG line
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('win-line');
  svg.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 15;
  `;
  
  // Create path through all points
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  let pathData = `M ${points[0].x} ${points[0].y}`;
  
  for (let i = 1; i < points.length; i++) {
    pathData += ` L ${points[i].x} ${points[i].y}`;
  }
  
  path.setAttribute('d', pathData);
  path.setAttribute('stroke', 'rgba(96, 240, 255, 0.65)');
  path.setAttribute('stroke-width', '1');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.style.filter = 'none';
  
  svg.appendChild(path);
  reelsContainer.appendChild(svg);
  
  // Lines will be removed together by highlightWinningSymbols() cleanup at 3s
}

// ---------- Win flash ----------
function flashWin(isWin){
  const slot = document.getElementById("slot");
  if (!slot) return;
  slot.classList.remove("win-flash");
  if (isWin){ void slot.offsetWidth; slot.classList.add("win-flash"); }
}

// ---------- Paytable Population ----------
// Pays are per-line multipliers of the per-line stake (bet / 25). Showing the
// raw numbers (e.g. "588x") reads like a total-bet multiplier, which is very
// misleading after the rebalance. The paytable now shows actual dollar wins
// at the current bet, mirroring live math: (bet / PAYLINES.length) * pay,
// rounded to cents. populatePaytable() runs on every modal open, so the
// values stay in sync when the bet changes.
function paytableWin(pay) {
  const betPerLine = bet / PAYLINES.length;
  const amount = Math.round(betPerLine * pay * 100) / 100;
  return `$${amount.toFixed(2)}`;
}

function paytableRows(sym) {
  let rows = '';
  for (const n of [5, 4, 3, 2]) {
    if (sym.pay?.[n]) rows += `<div>${n} = ${paytableWin(sym.pay[n])}</div>`;
  }
  return rows;
}

function populatePaytable() {
  // High-value symbols (first 5 symbols in SYMBOLS array)
  const highValueContainer = document.getElementById('highValueSymbols');
  if (highValueContainer) {
    highValueContainer.innerHTML = '';
    for (let i = 0; i < 5 && i < SYMBOLS.length; i++) {
      const sym = SYMBOLS[i];
      const item = document.createElement('div');
      item.className = 'paytable-item';
      item.innerHTML = `
        <div class="paytable-symbol">${sym.icon}</div>
        <div class="paytable-pays">${paytableRows(sym)}</div>
      `;
      highValueContainer.appendChild(item);
    }
  }
  
  // Letter symbols (last 3 symbols in SYMBOLS array)
  const letterContainer = document.getElementById('letterSymbols');
  if (letterContainer) {
    letterContainer.innerHTML = '';
    for (let i = 5; i < SYMBOLS.length; i++) {
      const sym = SYMBOLS[i];
      const item = document.createElement('div');
      item.className = 'paytable-item';
      item.innerHTML = `
        <div class="paytable-symbol">${sym.icon}</div>
        <div class="paytable-pays">${paytableRows(sym)}</div>
      `;
      letterContainer.appendChild(item);
    }
  }
  
  // Special symbols (WILD and SCATTER)
  const specialContainer = document.getElementById('specialSymbols');
  if (specialContainer) {
    specialContainer.innerHTML = `
      <div class="paytable-special-item">
        <div class="paytable-symbol">${WILD.icon}</div>
        <div class="paytable-desc">
          <strong>WILD</strong>
          <p>Substitutes for all symbols to create winning combinations. Appears via Zylo's Zap!</p>
        </div>
      </div>
      <div class="paytable-special-item">
        <div class="paytable-symbol">${SCATTER.icon}</div>
        <div class="paytable-desc">
          <strong>SCATTER</strong>
          <p>Special symbol that triggers bonus features. Does not need to be on a payline.</p>
        </div>
      </div>
    `;
  }
}

// ---------- Auto-Play Functions ----------
function startAutoPlay(spins) {
  if (isSpinning || isAutoPlaying) return;
  
  isAutoPlaying = true;
  autoSpinsRemaining = spins;
  
  // Hide spin button, show stop button
  const spinBtn = document.getElementById("spin");
  const autoPlayBtn = document.getElementById("autoPlayBtn");
  
  if (spinBtn) spinBtn.style.display = 'none';
  if (autoPlayBtn) {
    autoPlayBtn.style.display = 'block';
    updateAutoPlayButton();
  }
  
  say(`Auto-play started: ${spins} spins!`);
  executeNextAutoSpin();
}

function stopAutoPlay() {
  isAutoPlaying = false;
  autoSpinsRemaining = 0;
  
  // Clear any pending auto-spin timeout
  if (autoSpinTimeout) {
    clearTimeout(autoSpinTimeout);
    autoSpinTimeout = null;
  }
  
  // Show spin button, hide stop button
  const spinBtn = document.getElementById("spin");
  const autoPlayBtn = document.getElementById("autoPlayBtn");
  
  if (spinBtn) spinBtn.style.display = 'block';
  if (autoPlayBtn) autoPlayBtn.style.display = 'none';
  
  say("Auto-play stopped!");
}

function updateAutoPlayButton() {
  const autoPlayBtn = document.getElementById("autoPlayBtn");
  if (autoPlayBtn) {
    autoPlayBtn.textContent = `Stop Auto (${autoSpinsRemaining})`;
  }
}

function executeNextAutoSpin() {
  if (!isAutoPlaying || autoSpinsRemaining <= 0) {
    stopAutoPlay();
    return;
  }
  
  // Check if balance is sufficient
  if (balance < bet) {
    say("Insufficient balance!");
    stopAutoPlay();
    return;
  }
  
  // Safety net: never fire while a spin is still resolving or while a
  // feature (free spins session / Hold & Win round) is active. Auto-play is
  // stopped when features trigger, so reaching this means a stray timer.
  if (isSpinning || isFreeSpin || freeSpins > 0 || hwRunning) {
    stopAutoPlay();
    return;
  }
  
  // Pre-decide zap
  isZapSpin = tryZap();
  
  if (isZapSpin && zyloEl) {
    zyloEl.classList.add('zap-armed');
  }
  
  // Execute spin
  spin(isZapSpin);
  
  autoSpinsRemaining--;
  updateAutoPlayButton();
}

// Hook into spin completion to continue auto-play
function onAutoSpinComplete() {
  if (!isAutoPlaying) return;
  
  // Calculate delay based on animations
  let delay = window.isTurboMode && window.isTurboMode() ? 500 : 1000;
  
  // Check if there was a win with animations
  const lastWinEl = document.getElementById("lastWin");
  const lastWinText = lastWinEl ? lastWinEl.textContent : "$0.00";
  const lastWinAmount = parseFloat(lastWinText.replace(/[$,]/g, ''));
  
  // If there was a win, wait for win line animations to complete
  if (lastWinAmount > 0 && window.lastWinningLines && window.lastWinningLines.length > 0) {
    const winLineAnimationTime = (typeof window.winLineTotalDuration === 'number' && window.winLineTotalDuration > 0)
      ? (window.winLineTotalDuration + 400)
      : (window.lastWinningLines.length * 400) + 800 + 500;
    delay = Math.max(delay, winLineAnimationTime);
  }
  
  // Schedule next spin after appropriate delay
  autoSpinTimeout = setTimeout(() => {
    executeNextAutoSpin();
  }, delay);
}

// ---- Safe init & controls wiring ----

// Auto-play state
let isAutoPlaying = false;
let autoSpinsRemaining = 0;
let autoSpinTimeout = null;

function wireControls(){
  const spinBtn  = document.getElementById("spin");
  const autoPlayBtn = document.getElementById("autoPlayBtn");
  const betUpBtn = document.getElementById("betUp");
  const betDownBtn = document.getElementById("betDown");

  if (!spinBtn){
    console.warn("Controls missing in DOM");
    return;
  }
  
  // Prefer addEventListener and decide zap at click time so UI can show an
  // 'armed' look before the reels start. We call spin(isZapSpin) so spin()
  // uses the preselected value and spins longer when it's a zap.
  spinBtn.addEventListener('click', () => {
    if (isSpinning || isAutoPlaying || isCelebrating) return;

    // pre-decide zap using zap mode logic
    isZapSpin = tryZap();

    if (isZapSpin && zyloEl) {
      zyloEl.classList.add('zap-armed'); // visual: charged look
    }

    spinBtn.disabled = true;
    spin(isZapSpin);
  });
  
  // Zap toggle button
  const zapToggleBtn = document.getElementById('zapToggle');
  if (zapToggleBtn) {
    zapToggleBtn.addEventListener('click', () => {
      // Cycle through modes: off -> auto -> manual -> off
      if (window.zapMode === 'off') {
        window.zapMode = 'auto';
        say("Zap auto mode ON");
      } else if (window.zapMode === 'auto') {
        window.zapMode = 'manual';
        say("Zap manual mode ON");
      } else {
        window.zapMode = 'off';
        say("Zap disabled.");
      }
      updateZapButton();
      scheduleSave();
    });
    // Initialize button state
    updateZapButton();
  }

  const zapTriggerBtn = document.getElementById('zapTriggerBtn');
  if (zapTriggerBtn) {
    zapTriggerBtn.addEventListener('click', () => {
      if (window.zapMode !== 'manual') return;
      zapManualQueue += 1;
      say("Zap armed for next spin!");
    });
  }
  
  // Auto-play stop button
  if (autoPlayBtn) {
    autoPlayBtn.addEventListener('click', () => {
      stopAutoPlay();
    });
  }
  
  // Bet levels array: $0.20 - $2.00 (by 0.20), $3.00-$5.00 (by 1.00), then $10, $20, $30... up to $100
  const betLevels = [
    0.20, 0.40, 0.60, 0.80, 1.00, 1.20, 1.40, 1.60, 1.80, 2.00,  // $0.20 increments
    3.00, 4.00, 5.00,                                              // $1.00 increments
    10.00, 20.00, 30.00, 40.00, 50.00, 60.00, 70.00, 80.00, 90.00, 100.00  // $10 increments
  ];
  
  // BET UP/DOWN buttons (in modal)
  if (betDownBtn) {
    betDownBtn.onclick = () => { 
      const currentIndex = betLevels.findIndex(level => Math.abs(level - bet) < 0.01);
      if (currentIndex > 0) {
        bet = betLevels[currentIndex - 1];
        updateBalanceUI(); 
        (typeof saveSettings === 'function' && saveSettings()); 
      }
    };
  }
  if (betUpBtn) {
    betUpBtn.onclick = () => { 
      const currentIndex = betLevels.findIndex(level => Math.abs(level - bet) < 0.01);
      if (currentIndex < betLevels.length - 1) {
        bet = betLevels[currentIndex + 1];
        updateBalanceUI(); 
        (typeof saveSettings === 'function' && saveSettings()); 
      }
    };
  }
  
  // MAX BET button (in bet modal)
  const maxBetBtn = document.getElementById("maxBet");
  if (maxBetBtn) {
    maxBetBtn.addEventListener('click', () => {
      bet = Math.min(100, balance); // Max bet is 100 or current balance, whichever is lower
      updateBalanceUI();
      if (typeof saveSettings === 'function') saveSettings();
      say("Max bet!");
    });
  }
  
  // MODAL CONTROLS
  const settingsBtn = document.getElementById("settingsBtn");
  const betBtn = document.getElementById("betBtn");
  const settingsModal = document.getElementById("settingsModal");
  const betModal = document.getElementById("betModal");
  
  // Open modals
  if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', () => {
      settingsModal.classList.add('modal-open');
    });
  }
  
  if (betBtn && betModal) {
    betBtn.addEventListener('click', () => {
      betModal.classList.add('modal-open');
    });
  }
  
  // Close modals
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modalId = e.target.getAttribute('data-modal');
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove('modal-open');
    });
  });
  
  // Close modal when clicking outside
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('modal-open');
      }
    });
  });
  
  // AUTO-PLAY MODAL CONTROLS
  const autoBtn = document.getElementById("autoBtn");
  const autoPlayModal = document.getElementById("autoPlayModal");
  
  if (autoBtn && autoPlayModal) {
    autoBtn.addEventListener('click', () => {
      autoPlayModal.classList.add('modal-open');
    });
  }
  
  // Auto-play option buttons
  document.querySelectorAll('.auto-play-option').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const spins = parseInt(e.target.getAttribute('data-spins'));
      startAutoPlay(spins);
      autoPlayModal.classList.remove('modal-open');
    });
  });
  
  // PAYTABLE MODAL CONTROLS
  const paytableBtn = document.getElementById("paytableBtn");
  const paytableModal = document.getElementById("paytableModal");
  
  if (paytableBtn && paytableModal) {
    paytableBtn.addEventListener('click', () => {
      populatePaytable(); // Populate with current values
      paytableModal.classList.add('modal-open');
    });
  }
  
  // TURBO MODE toggle (initial state restored by the save system)
  let isTurboMode = !!restoredSettings.turboOn;
  const turboBtn = document.getElementById("turboMode");
  if (turboBtn) {
    turboBtn.classList.toggle('active', isTurboMode);
    turboBtn.addEventListener('click', () => {
      isTurboMode = !isTurboMode;
      turboBtn.classList.toggle('active', isTurboMode);
      say(isTurboMode ? "Turbo ON!" : "Turbo OFF");
      scheduleSave();
    });
  }
  // Store turbo state globally so spinReels can access it
  window.isTurboMode = () => isTurboMode;
  
  // SOUND TOGGLE (initial state restored by the save system)
  let isSoundMuted = !!restoredSettings.soundMuted;
  const soundBtn = document.getElementById("soundToggle");
  if (soundBtn) {
    soundBtn.classList.toggle('active', !isSoundMuted);
    soundBtn.textContent = isSoundMuted ? "🔇" : "🔊";
    soundBtn.addEventListener('click', () => {
      isSoundMuted = !isSoundMuted;
      soundBtn.classList.toggle('active', !isSoundMuted);
      soundBtn.textContent = isSoundMuted ? "🔇" : "🔊";
      
      // Mute all Sound functions
      if (Sound) {
        Object.keys(Sound).forEach(key => {
          const originalFn = Sound[key];
          if (typeof originalFn === 'function') {
            if (!originalFn._original) {
              Sound[key]._original = originalFn;
            }
          }
        });
      }
      
      say(isSoundMuted ? "Sound OFF" : "Sound ON");
      scheduleSave();
    });
  }
  // RTP simulation moved into Developer Mode (Ctrl+Shift+D).
  // Jackpot is always in 'auto' mode now. Use Dev Mode's Force Jackpot to test.

  // Store muted state globally
  window.isSoundMuted = () => isSoundMuted;
  
  // test button removed
}

function safeInit(){
  try{
    // Restore persisted player state before any UI renders.
    loadGame();
    buildReels();
    mountReels();
    // After the reels are mounted, compute exact cell sizes and observe resizes
    try { resizeReelsSnap(); setupResizeObservers(); } catch(e){}
    updateBalanceUI();
    wireControls();
    // Zylo random fly in/out behavior
// ===== FREE SPINS TRIGGER SEQUENCE =====
// Stars rush OUTWARD from center toward the camera (warp-speed feel).
let fsWarpRAF = null;
function startWarpStars(streakColor) {
  const color = streakColor || 'rgba(180,255,220,0.85)';
  const canvas = document.getElementById('fsWarpStars');
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  let stars = [];
  for (let i = 0; i < 250; i++) {
    stars.push({
      angle: Math.random() * Math.PI * 2,
      radius: Math.random() * 60,
      speed: Math.random() * 6 + 4,
      length: Math.random() * 18 + 6
    });
  }
  function draw() {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    stars.forEach(s => {
      const x1 = cx + Math.cos(s.angle) * s.radius;
      const y1 = cy + Math.sin(s.angle) * s.radius;
      s.radius += s.speed;
      s.speed += 0.18; // accelerate outward
      const x2 = cx + Math.cos(s.angle) * s.radius;
      const y2 = cy + Math.sin(s.angle) * s.radius;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const maxR = Math.max(canvas.width, canvas.height);
      if (s.radius > maxR) {
        s.angle = Math.random() * Math.PI * 2;
        s.radius = Math.random() * 40;
        s.speed = Math.random() * 6 + 4;
      }
    });
    fsWarpRAF = requestAnimationFrame(draw);
  }
  draw();
}

function stopWarpStars() {
  if (fsWarpRAF) {
    cancelAnimationFrame(fsWarpRAF);
    fsWarpRAF = null;
  }
  const canvas = document.getElementById('fsWarpStars');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// Orchestrates: shake -> planet grows to fill screen + reels fade + warp stars
// -> reels return glowing green in front of the green planet scene.
// Spawns a quick burst of spark particles flying outward from screen center,
// used to punctuate the FREE SPINS ACTIVATED moment.
function spawnFreeSpinsSparkBurst() {
  const sparkCount = 16;
  for (let i = 0; i < sparkCount; i++) {
    const angle = (Math.PI * 2 * i) / sparkCount + (Math.random() * 0.3 - 0.15);
    const distance = 160 + Math.random() * 120;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;

    const spark = document.createElement('div');
    spark.className = 'fs-spark';
    spark.style.setProperty('--spark-end', `translate(${x}px, ${y}px)`);
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 950);
  }
}

function playFreeSpinsIntro(onComplete) {
  console.log('[FS] sequence started');
  const app = document.getElementById('app');
  const reelsContainer = document.getElementById('reels-container');
  const planetWrap = document.getElementById('freeSpinsPlanet');
  const warpCanvas = document.getElementById('fsWarpStars');
  const groundScene = document.getElementById('fsGroundScene');
  console.log('[FS] elements found:', { app: !!app, reelsContainer: !!reelsContainer, planetWrap: !!planetWrap, warpCanvas: !!warpCanvas, groundScene: !!groundScene });

  // Phase 1: screen shake on landing
  app?.classList.add('screen-shake');
  setTimeout(() => app?.classList.remove('screen-shake'), 450);

  // Phase 2: reels fade out, warp stars kick in (no more planet zoom —
  // straight into travel), and the "FREE SPINS ACTIVATED" text announces
  // the feature clearly.
  setTimeout(() => {
    console.log('[FS] phase 2: fade out reels, start warp, announce activation');
    reelsContainer?.classList.remove('fs-fade-in');
    reelsContainer?.classList.add('fs-fade-out');
    warpCanvas?.classList.add('active');
    startWarpStars();

    const activatedText = document.getElementById('fsActivatedText');
    activatedText?.classList.add('show');

    // Screen flash + spark burst for extra impact
    const flash = document.getElementById('fsActivationFlash');
    flash?.classList.remove('flash');
    flash?.getBoundingClientRect(); // force reflow so the animation replays
    flash?.classList.add('flash');
    spawnFreeSpinsSparkBurst();
  }, 300);

  // Phase 2b: announcement text fades back out partway through travel
  setTimeout(() => {
    document.getElementById('fsActivatedText')?.classList.remove('show');
  }, 1700);

  // Phase 3: arrival — swap to green bonus scene, bring reels back glowing
  setTimeout(() => {
    console.log('[FS] phase 3: arrival, adding freespins-active + fsGroundScene.active');
    document.body.classList.add('freespins-active');
    groundScene?.classList.add('active');
    warpCanvas?.classList.remove('active');
    stopWarpStars();
    reelsContainer?.classList.remove('fs-fade-out');
    reelsContainer?.classList.add('fs-fade-in');
    window.updateFreeSpinsBanner?.();
    document.getElementById('freeSpinsBanner')?.classList.add('show');
    console.log('[FS] body classes now:', document.body.className);
    console.log('[FS] groundScene classes now:', groundScene?.className);
  }, 2100);

  // Phase 4: sequence complete
  setTimeout(() => {
    console.log('[FS] phase 4: sequence complete');
    if (onComplete) onComplete();
  }, 3000);
}

// Reverses the bonus scene back to normal space view when free spins end.
function endFreeSpinsScene(onComplete) {
  document.body.classList.remove('freespins-active');
  document.getElementById('fsGroundScene')?.classList.remove('active');
  if (onComplete) onComplete();
}

// Updates the "FREE SPINS: X remaining • $Y won" banner text.
function updateFreeSpinsBanner() {
  const countEl = document.getElementById('freeSpinsCount');
  const winEl = document.getElementById('freeSpinsWin');
  if (countEl) countEl.textContent = String(freeSpins);
  if (winEl) winEl.textContent = formatCurrency(freeSpinsTotalWin);
}

// Called when the free spins session has run out (freeSpins hits 0 after a
// free spin completes). Shows the total won, then transitions back to the
// normal scene.
function endFreeSpinsSession() {
  const totalWon = freeSpinsTotalWin;

  // Add the held winnings to the real balance now, all at once
  balance += totalWon;
  updateBalanceUI();

  // Safety net: force-clear any win lines/highlights that might still be
  // lingering from the final free spin's win, so nothing carries over
  // visually once we're back on the normal screen.
  if (window.winLineTimers && Array.isArray(window.winLineTimers)) {
    window.winLineTimers.forEach(id => clearTimeout(id));
    window.winLineTimers = [];
  }
  if (window.winLineCleanupTimer) {
    clearTimeout(window.winLineCleanupTimer);
    window.winLineCleanupTimer = null;
  }
  document.querySelectorAll('.cell').forEach(cell => cell.classList.remove('winning-symbol'));
  document.querySelectorAll('.win-line, .win-line-overlay, .winning-cell, .highlighted').forEach(el => {
    el.classList.remove('win-line', 'win-line-overlay', 'winning-cell', 'highlighted');
    el.style.boxShadow = '';
    el.style.border = '';
    if (el.classList.contains('win-line')) el.remove();
  });

  document.getElementById('freeSpinsBanner')?.classList.remove('show');
  zyloSay('winBig', 100);

  // Show the "TOTAL WON" celebration, counting up from $0 to the total
  const overlay = document.getElementById('fsTotalWinOverlay');
  const amountEl = document.getElementById('fsTotalWinAmount');
  if (amountEl) amountEl.textContent = formatCurrency(0);
  overlay?.classList.add('show');

  const countDuration = 1400;
  const startTime = performance.now();
  function countUp(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / countDuration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (amountEl) amountEl.textContent = formatCurrency(totalWon * eased);
    if (progress < 1) requestAnimationFrame(countUp);
  }
  requestAnimationFrame(countUp);

  // Hold on the final total for a beat, then fade the overlay and transition
  // back to the normal scene.
  setTimeout(() => {
    overlay?.classList.remove('show');
    setTimeout(() => {
      endFreeSpinsScene(() => {
        freeSpinsTotalWin = 0;
      });
    }, 600);
  }, countDuration + 1200);
}
window.updateFreeSpinsBanner = updateFreeSpinsBanner;
window.endFreeSpinsSession = endFreeSpinsSession;
window.playFreeSpinsIntro = playFreeSpinsIntro;

// ===== JACKPOT TRIGGER SEQUENCE =====
// Mirrors the free spins intro, but themed gold/fire and travelling to the
// jackpot planet instead of the free spins planet.

// Spawns a burst of gold spark particles for the JACKPOT reveal.
function spawnJackpotSparkBurst() {
  const sparkCount = 24;
  for (let i = 0; i < sparkCount; i++) {
    const angle = (Math.PI * 2 * i) / sparkCount + (Math.random() * 0.3 - 0.15);
    const distance = 180 + Math.random() * 160;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;

    const spark = document.createElement('div');
    spark.className = 'jp-spark';
    spark.style.setProperty('--spark-end', `translate(${x}px, ${y}px)`);
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 1100);
  }
}

function playJackpotIntro(onComplete) {
  console.log('[JP] sequence started');
  const app = document.getElementById('app');
  const reelsContainer = document.getElementById('reels-container');
  const warpCanvas = document.getElementById('fsWarpStars');
  const groundScene = document.getElementById('jpGroundScene');

  // Phase 1: screen shake on landing
  app?.classList.add('screen-shake');
  setTimeout(() => app?.classList.remove('screen-shake'), 450);

  // Phase 2: reels fade out, gold warp stars, "JACKPOT" announcement
  setTimeout(() => {
    console.log('[JP] phase 2: warp + announce');
    reelsContainer?.classList.remove('fs-fade-in');
    reelsContainer?.classList.add('fs-fade-out');
    warpCanvas?.classList.add('active');
    startWarpStars('rgba(255,215,120,0.9)'); // gold streaks

    const activatedText = document.getElementById('jpActivatedText');
    activatedText?.classList.add('show');

    const flash = document.getElementById('jpActivationFlash');
    flash?.classList.remove('flash');
    flash?.getBoundingClientRect(); // force reflow so it replays
    flash?.classList.add('flash');
    spawnJackpotSparkBurst();
  }, 300);

  // Phase 2b: announcement fades out partway through travel
  setTimeout(() => {
    document.getElementById('jpActivatedText')?.classList.remove('show');
  }, 1700);

  // Phase 3: arrival at the jackpot planet — reels return glowing gold
  setTimeout(() => {
    console.log('[JP] phase 3: arrival at jackpot planet');
    document.body.classList.add('jackpot-active');
    groundScene?.classList.add('active');
    warpCanvas?.classList.remove('active');
    stopWarpStars();
    reelsContainer?.classList.remove('fs-fade-out');
    reelsContainer?.classList.add('fs-fade-in');
  }, 2100);

  // Phase 4: arrived. Hand control back so the jackpot mini-feature can run.
  setTimeout(() => {
    console.log('[JP] phase 4: arrived — ready for jackpot feature');
    if (onComplete) onComplete();
  }, 3000);
}

// Reverses the jackpot scene back to the normal space view.
function endJackpotScene(onComplete) {
  document.body.classList.remove('jackpot-active');
  document.getElementById('jpGroundScene')?.classList.remove('active');
  if (onComplete) onComplete();
}

window.playJackpotIntro = playJackpotIntro;
window.endJackpotScene = endJackpotScene;
window.spawnJackpotSparkBurst = spawnJackpotSparkBurst;
window.endFreeSpinsScene = endFreeSpinsScene;

    function zyloFlyIn() {
      if (!zyloEl || isSpinning) return;
      const sides = ['left', 'right', 'top'];
      const side = sides[Math.floor(Math.random() * sides.length)];
      
      const speeds = ['0.5s', '0.8s', '1.4s', '2s'];
      const speed = speeds[Math.floor(Math.random() * speeds.length)];
      
      zyloEl.classList.remove('zylo-fly-in-left','zylo-fly-in-right','zylo-fly-in-top','zylo-fly-out-left','zylo-fly-out-right','zylo-fly-out-top');
      zyloEl.style.animationDuration = speed;
      zyloEl.classList.add(`zylo-fly-in-${side}`);
      
      // Stays on screen a long time — 20 to 40 seconds
      const idleTime = 20000 + Math.random() * 20000;
      setTimeout(() => zyloFlyOut(side), idleTime);
    }

    function zyloFlyOut(side) {
      // Don't fly out if a zap spin just happened — let him stay
      if (isZapSpin) {
        const idleTime = 8000 + Math.random() * 6000;
        setTimeout(() => zyloFlyOut(side), idleTime);
        return;
      }
      if (!zyloEl) return;
      const outSide = side === 'top' ? 'top' : (side === 'left' ? 'right' : 'left');
      
      const speeds = ['0.4s', '0.6s', '1.2s', '1.8s'];
      const speed = speeds[Math.floor(Math.random() * speeds.length)];
      
      zyloEl.style.animationDuration = speed;
      zyloEl.classList.remove('zylo-fly-in-left','zylo-fly-in-right','zylo-fly-in-top');
      zyloEl.classList.add(`zylo-fly-out-${outSide}`);
      
      // Only gone for 3 to 6 seconds before coming back
      const gapTime = 3000 + Math.random() * 3000;
      setTimeout(zyloFlyIn, gapTime);
    }

    // Start right away
    // DISABLED: Zylo used to fly on and off the screen forever via
    // recursive zyloFlyIn/zyloFlyOut setTimeouts. Uncomment to restore.
    // setTimeout(zyloFlyIn, 1500);

    // Dev/test buttons consolidated into Developer Mode (Ctrl+Shift+D).

    console.log("Zylo Zap initialized.");
  }catch(e){
    console.error("Init error:", e);
  }
}

// Run after DOM is ready (covers cases where script is in <head> by mistake)
if (document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", safeInit);
}else{
  safeInit();
}

// Manual test button and debug listeners removed

// ======== RTP / Balance Simulator (DEV ONLY) ========

// Live-faithful outcome for one spin. Mirrors the real pipeline exactly:
// chooseStopSymbols stop distribution, tryZap frequency from
// CONFIG.ZAP_CHANCE, and the real zap effect (best full column turned
// wild, never a scatter or jack column, skipped when no column improves
// the win). Scores with scoreGrid against the real reel strips, so there
// is one source of truth. Returns win in currency at the current bet.
function pureSpinOnce(opts = {}) {
  const zapChance = (typeof opts.zapChance === 'number') ? opts.zapChance
    : ((typeof CONFIG.ZAP_CHANCE === 'number') ? CONFIG.ZAP_CHANCE : 0.04);
  const zapEnabled = (opts.zapEnabled !== undefined) ? !!opts.zapEnabled
    : (window.zapMode === 'auto');

  // Stops drawn exactly like chooseStopSymbols: no wraparound.
  const finals = [];
  for (let r = 0; r < REEL_COUNT; r++) {
    const strip = reels[r];
    const s = Math.floor(Math.random() * (strip.length - ROWS));
    finals.push([strip[s], strip[s + 1], strip[s + 2]]);
  }

  const grid = [[], [], []];
  for (let r = 0; r < REEL_COUNT; r++) for (let row = 0; row < ROWS; row++) grid[row][r] = finals[r][row];

  // Real zap model: decided before seeing the result like tryZap, applied
  // like spinReels (best full column, scatter and jack columns excluded,
  // no zap if nothing improves the win).
  let zapped = false;
  let preZapWin = 0;
  if (zapEnabled && Math.random() < zapChance) {
    preZapWin = scoreGrid(grid);
    let bestCol = -1, bestWin = 0;
    for (let c = 0; c < REEL_COUNT; c++) {
      let blocked = false;
      for (let row = 0; row < ROWS; row++) {
        const v = grid[row][c];
        if (v === SCATTER_INDEX || v === JACK_INDEX) blocked = true;
      }
      if (blocked) continue;
      const t = [grid[0].slice(), grid[1].slice(), grid[2].slice()];
      t[0][c] = WILD_INDEX; t[1][c] = WILD_INDEX; t[2][c] = WILD_INDEX;
      const w = scoreGrid(t);
      if (w > bestWin) { bestWin = w; bestCol = c; }
    }
    if (bestCol >= 0) {
      grid[0][bestCol] = WILD_INDEX; grid[1][bestCol] = WILD_INDEX; grid[2][bestCol] = WILD_INDEX;
      zapped = true;
    }
  }

  const win = scoreGrid(grid);
  const zapGain = zapped ? (win - preZapWin) : 0;
  return { win, zapped, zapGain, finals, grid };
}

// One full Hold & Win jackpot round using the same constants and value
// picker (hwPickMeteorMult) as the real round. Returns total bet multiplier.
function simHoldAndWinMult() {
  const cells = new Array(HW_TOTAL).fill(0);
  let filled = 0, spinsLeft = HW_START_SPINS, sum = 0;
  while (spinsLeft > 0) {
    let landed = 0;
    for (let i = 0; i < HW_TOTAL; i++) {
      if (cells[i]) continue;
      if (Math.random() < HW_METEOR_CHANCE) {
        const m = hwPickMeteorMult();
        cells[i] = m; sum += m; filled++; landed++;
      }
    }
    if (landed > 0) spinsLeft = HW_START_SPINS; else spinsLeft--;
    if (filled === HW_TOTAL) return HW_FULL_BOARD_MULT;
  }
  return sum;
}

// Stats helpers
function mean(a){ return a.reduce((s,x)=>s+x,0)/a.length; }
function stddev(a){ const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length); }
function quantile(a, q){ if (a.length===0) return 0; const b=[...a].sort((x,y)=>x-y); const i=Math.min(b.length-1, Math.max(0, Math.floor(q*(b.length-1)))); return b[i]; }

// Logic-only simulation of the CURRENT live game: base spins with the real
// zap model, scatter-triggered free spins sessions (5/8/10 spins, wins
// accumulated, no retrigger, no jackpot during free spins), and jackpot
// triggers (3+ JACK guaranteed, otherwise JACK_POP_CHANCE per landed
// symbol) resolved through the Hold & Win math. Never touches the DOM,
// balance, saves, jackStacks, or the jackpot pot. Runs at the current bet
// unless opts.betPerSpin is given, in which case bet is temporarily set so
// scoreGrid stays unit-consistent, then restored.
// Usage: simulateSpins(100000)
window.simulateSpins = function simulateSpins(n = 1000, opts = {}) {
  const savedBet = bet;
  const savedSimMode = window.SIM_MODE;
  const savedLog = console.log;
  const results = [];
  let totalBet = 0, totalWin = 0, baseWin = 0, fsWinTotal = 0, jpWinTotal = 0;
  let zapGainTotal = 0;
  let hits = 0, zaps = 0, fsTriggers = 0, jpTriggers = 0, maxWin = 0;
  try {
    if (typeof opts.betPerSpin === 'number' && opts.betPerSpin > 0) bet = opts.betPerSpin;
    window.SIM_MODE = true;
    console.log = function(){}; // silence per-spin logging during the run

    for (let i = 0; i < n; i++) {
      totalBet += bet;
      let spinTotal = 0;

      const r = pureSpinOnce(opts);
      spinTotal += r.win;
      baseWin += r.win;
      if (r.zapped) { zaps++; zapGainTotal += r.zapGain; }

      // Free spins: award and play out the full session, live rules.
      let sc = 0;
      r.finals.forEach(col => col.forEach(s => { if (s === SCATTER_INDEX) sc++; }));
      if (sc >= 3) {
        fsTriggers++;
        let fs = (sc === 3) ? 5 : (sc === 4) ? 8 : 10;
        while (fs > 0) {
          fs--;
          const fr = pureSpinOnce(opts);
          spinTotal += fr.win;
          fsWinTotal += fr.win;
          if (fr.zapped) { zaps++; zapGainTotal += fr.zapGain; }
        }
      }

      // Jackpot: live trigger rules on paid spins, Hold & Win resolution.
      let jk = 0;
      r.finals.forEach(col => col.forEach(s => { if (s === JACK_INDEX) jk++; }));
      let jt = false;
      if (jk >= JACK_REQUIRED) jt = true;
      else for (let k = 0; k < jk; k++) { if (Math.random() < JACK_POP_CHANCE) { jt = true; break; } }
      if (jt) {
        jpTriggers++;
        const w = bet * simHoldAndWinMult();
        spinTotal += w;
        jpWinTotal += w;
      }

      totalWin += spinTotal;
      results.push(spinTotal);
      if (spinTotal > 0) hits++;
      if (spinTotal > maxWin) maxWin = spinTotal;
    }
  } finally {
    bet = savedBet;
    window.SIM_MODE = savedSimMode;
    console.log = savedLog;
  }

  const bp = (typeof opts.betPerSpin === 'number' && opts.betPerSpin > 0) ? opts.betPerSpin : savedBet;
  const rtp = (totalWin / totalBet) * 100;
  const baseRTP = (baseWin / totalBet) * 100;
  const fsRTP = (fsWinTotal / totalBet) * 100;
  const jpRTP = (jpWinTotal / totalBet) * 100;
  // Overlay metric: how much the zap added versus the un-zapped grids.
  // Included INSIDE BaseRTP (and FreeSpinsRTP for zaps during free
  // spins). Never add it to the other columns.
  const zapContribRTP = (zapGainTotal / totalBet) * 100;
  const out = {
    n, betPerSpin: bp,
    rtp, baseRTP, fsRTP, jpRTP, zapContribRTP,
    bonusRTP: fsRTP + jpRTP,
    hitRate: (hits / n) * 100,
    zapRate: (zaps / n) * 100,
    fsTriggerRate: (fsTriggers / n) * 100,
    jpTriggerRate: (jpTriggers / n) * 100,
    avg: mean(results),
    median: quantile(results, 0.5),
    p90: quantile(results, 0.90),
    p99: quantile(results, 0.99),
    stddev: stddev(results),
    maxWin
  };

  console.clear();
  console.log("%cZylo Slot RTP Simulation (live math)", "color:#0ff;font-weight:bold");
  console.table({
    Spins: n,
    BetPerSpin: bp,
    TotalRTP: rtp.toFixed(2) + "%",
    BaseRTP: baseRTP.toFixed(2) + "%",
    FreeSpinsRTP: fsRTP.toFixed(2) + "%",
    JackpotRTP: jpRTP.toFixed(2) + "%",
    "ZapContrib (incl in Base+FS)": zapContribRTP.toFixed(2) + "%",
    HitRate: out.hitRate.toFixed(1) + "%",
    ZapRate: out.zapRate.toFixed(2) + "%",
    FSTriggerRate: out.fsTriggerRate.toFixed(3) + "%",
    JPTriggerRate: out.jpTriggerRate.toFixed(3) + "%",
    AvgWin: out.avg.toFixed(2),
    MedianWin: out.median.toFixed(2),
    StdDev: out.stddev.toFixed(2),
    MaxWin: maxWin.toFixed(2)
  });
  return out;
};

// ======== Auto-calibration helpers (DEV) ========
function scalePays(factor){
  // scales every paytable value by 'factor'
  const scaleObj = o => Object.fromEntries(Object.entries(o).map(([k,v])=>[k, Math.max(1, Math.round(v*factor))]));
  WILD.pay = scaleObj(WILD.pay);
  SYMBOLS.forEach(s => s.pay = scaleObj(s.pay));
}

function spinStats(n=20000){
  const s = simulateSpins(n);
  return {rtp: s.rtp/100, hit: s.hitRate/100}; // normalized 0..1
}

/**
 * calibrate({targetHit:0.32, targetRTP:0.95, spins:50000, maxIters:8})
 * 1) nudges low-symbol WEIGHTS to reach target hit rate
 * 2) rescales paytable to reach target RTP
 */
window.calibrate = async function calibrate(opts={}){
  const targetHit = opts.targetHit ?? 0.32;   // 32% hit rate
  const targetRTP = opts.targetRTP ?? 0.95;   // 95% RTP
  const spins     = opts.spins ?? 40000;
  const maxIters  = opts.maxIters ?? 8;

  // symbols we’ll adjust for hit rate (low tiers)
  const lowKeys = ["A","K","Q"]; // EGG and LASER no longer exist

  for (let it=0; it<maxIters; it++){
    // 1) measure
    buildReels(); // rebuild strips after any prior tweaks
    const {rtp, hit} = spinStats(spins);
    console.log(`Iter ${it} → RTP ${(rtp*100).toFixed(2)}%  |  Hit ${(hit*100).toFixed(1)}%`);

    // 2) if hit too low, raise low symbol weights; if too high, lower slightly
    const errH = targetHit - hit;
    if (Math.abs(errH) > 0.02){ // > ±2% off
      const step = errH > 0 ? 2 : -2;  // nudge size
      lowKeys.forEach(k=>{
        WEIGHTS[k] = Math.max(1, WEIGHTS[k] + step);
      });
      // continue loop to remeasure
      continue;
    }

    // 3) Hit rate is close; rescale payouts to match RTP
    const rtpErr = targetRTP - rtp;
    if (Math.abs(rtpErr) > 0.01){ // > ±1% off RTP
      const factor = targetRTP / rtp; // e.g., 0.95 / 0.90 = 1.055
      scalePays(factor);
      // continue loop to remeasure
      continue;
    }

    console.log("✅ Calibrated:", {RTP:(rtp*100).toFixed(2)+"%", Hit:(hit*100).toFixed(1)+"%", WEIGHTS, SYMBOLS});
    return {rtp, hit, WEIGHTS};
  }
  // final measure after max iters
  buildReels();
  const {rtp: r2, hit: h2} = spinStats(spins);
  console.log("⚠️ Reached max iterations.", {RTP:(r2*100).toFixed(2)+"%", Hit:(h2*100).toFixed(1)+"%", WEIGHTS});
  return {rtp:r2, hit:h2, WEIGHTS};
};

// Convenience: sweep zap chances to see effect on RTP quickly.
// Usage: sweepZap(5000, [10,15,20,25,30])
window.sweepZap = function sweepZap(n = 5000, zapList = [10, 15, 20, 25, 30]) {
  const rows = {};
  for (const z of zapList) {
    const s = simulateSpins(n, { zapChance: z, zapEnabled: true });
    rows[z + "%"] = { RTP: s.rtp.toFixed(2) + "%", HitRate: s.hitRate.toFixed(1) + "%", ZapRate: s.zapRate.toFixed(1) + "%", P90: s.p90.toFixed(2) };
  }
  console.log("%cZap sweep","color:#0f9");
  console.table(rows);
  return rows;
};
// ===== DEVELOPER MODE =====
// Consolidates every dev/test hook into one hidden panel. Off by default
// through CONFIG.DEV_MODE, toggled at runtime with Ctrl+Shift+D. While off,
// nothing renders, no timers run, and all dev flags are cleared so normal
// gameplay is untouched. Forced events reuse the real spin pipeline
// (DEV_FORCE_* flags consumed by spinReels), so they test production paths.
(function devMode(){
  let active = false;
  let statsTimer = null;
  let fpsRAF = null;
  let frameCount = 0;
  let lastFpsTime = 0;
  let fpsValue = 0;

  function buildPanel(){
    const panel = document.getElementById('devPanel');
    if (!panel) return null;
    if (panel.dataset.built === '1') return panel;
    panel.dataset.built = '1';
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:rgba(10,5,25,0.92);border:1px solid #19d7ff;border-radius:10px;padding:10px;display:none;flex-direction:column;gap:8px;min-width:230px;font:12px/1.4 monospace;color:#cfefff;';
    panel.innerHTML = `
      <div style="font-weight:900;color:#19d7ff;letter-spacing:1px;">DEV MODE</div>
      <div id="devStats" style="white-space:pre;"></div>
      <button data-action="forceZap">Force Zap Spin</button>
      <button data-action="forceFS">Force Free Spins</button>
      <button data-action="forceJackpot">Force Jackpot</button>
      <button data-action="forceBigWin">Force Big Win</button>
      <button data-action="toggleTurbo">Turbo: OFF</button>
      <button data-action="toggleInfinite">Infinite Balance: OFF</button>
      <button data-action="toggleFastAnims">Fast Anims: OFF</button>
      <button data-action="runSim">Run RTP Sim (100k)</button>
      <button data-action="resetSave">Reset Save</button>
    `;
    panel.querySelectorAll('button').forEach(b => {
      b.style.cssText = 'padding:6px 8px;border:none;border-radius:6px;background:#123a55;color:#cfefff;font-weight:700;cursor:pointer;text-align:left;';
    });
    return panel;
  }

  function refreshStats(){
    const el = document.getElementById('devStats');
    if (!el) return;
    const zapP = (window.SETTINGS && typeof window.SETTINGS.zapChance === 'number') ? window.SETTINGS.zapChance : ZAP_CHANCE;
    const zapPct = zapP > 1 ? zapP : zapP * 100;
    // Real trigger model: 3+ JACK symbols guarantee the jackpot, otherwise
    // each landed JACK pops at JACK_POP_CHANCE.
    const jpPct = JACK_POP_CHANCE * 100;
    el.textContent =
      `Balance: ${formatCurrency(balance)}\n` +
      `Bet:     ${formatCurrency(bet)}\n` +
      `Jackpot: ${formatCurrency(jackpot)}\n` +
      `Stacks:  ${jackStacks.toFixed(1)} / ${JACK_STACKS_CAP}\n` +
      `JP pop:  ${jpPct.toFixed(1)}% per JACK\n` +
      `Zap:     ${zapPct.toFixed(1)}%\n` +
      `FreeSp:  ${freeSpins}\n` +
      `FPS:     ${fpsValue}`;
    const panel = document.getElementById('devPanel');
    if (panel) {
      const t = panel.querySelector('[data-action="toggleTurbo"]');
      if (t) t.textContent = 'Turbo: ' + ((window.isTurboMode && window.isTurboMode()) ? 'ON' : 'OFF');
      const i = panel.querySelector('[data-action="toggleInfinite"]');
      if (i) i.textContent = 'Infinite Balance: ' + (window.DEV_INFINITE_BALANCE ? 'ON' : 'OFF');
      const f = panel.querySelector('[data-action="toggleFastAnims"]');
      if (f) f.textContent = 'Fast Anims: ' + (window.DEV_FAST_ANIMS ? 'ON' : 'OFF');
    }
  }

  function fpsLoop(t){
    frameCount++;
    if (t - lastFpsTime >= 500) {
      fpsValue = Math.round(frameCount * 1000 / (t - lastFpsTime));
      frameCount = 0;
      lastFpsTime = t;
    }
    if (active) fpsRAF = requestAnimationFrame(fpsLoop);
  }

  function setActive(on){
    const panel = buildPanel();
    if (!panel) return;
    active = on;
    panel.style.display = on ? 'flex' : 'none';
    if (on) {
      refreshStats();
      statsTimer = setInterval(refreshStats, 500);
      frameCount = 0; lastFpsTime = performance.now();
      fpsRAF = requestAnimationFrame(fpsLoop);
      console.log('Dev Mode ON');
    } else {
      clearInterval(statsTimer); statsTimer = null;
      if (fpsRAF) cancelAnimationFrame(fpsRAF);
      fpsRAF = null;
      // Leaving dev mode clears every dev flag so gameplay is fully normal.
      window.DEV_INFINITE_BALANCE = false;
      window.DEV_FAST_ANIMS = false;
      window.DEV_FORCE_SCATTERS = false;
      window.DEV_FORCE_JACKPOT = false;
      window.DEV_FORCE_BIGWIN = false;
      console.log('Dev Mode OFF');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const panel = buildPanel();
    if (!panel) { console.warn('Dev panel mount not found.'); return; }

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'forceZap':
          if (!isSpinning) spin(true);
          break;
        case 'forceFS':
          if (!isSpinning) { window.DEV_FORCE_SCATTERS = true; spin(false); }
          break;
        case 'forceJackpot':
          if (!isSpinning) { window.DEV_FORCE_JACKPOT = true; spin(false); }
          break;
        case 'forceBigWin':
          if (!isSpinning) { window.DEV_FORCE_BIGWIN = true; spin(false); }
          break;
        case 'toggleTurbo':
          // Route through the real settings button so visuals and the save
          // system stay in sync.
          const tb = document.getElementById('turboMode');
          if (tb) tb.click();
          refreshStats();
          break;
        case 'toggleInfinite':
          window.DEV_INFINITE_BALANCE = !window.DEV_INFINITE_BALANCE;
          refreshStats();
          break;
        case 'toggleFastAnims':
          window.DEV_FAST_ANIMS = !window.DEV_FAST_ANIMS;
          refreshStats();
          break;
        case 'runSim':
          if (isSpinning || isAutoPlaying || isCelebrating) break;
          if (typeof window.simulateSpins !== 'function') { console.warn('Simulator not available.'); break; }
          btn.disabled = true;
          btn.textContent = 'Running...';
          setTimeout(() => {
            try {
              const stats = window.simulateSpins(100000);
              if (stats && typeof stats.rtp === 'number') say(`RTP ${stats.rtp.toFixed(2)}%`);
            } catch (err) {
              console.warn('RTP sim failed:', err);
            } finally {
              btn.disabled = false;
              btn.textContent = 'Run RTP Sim (100k)';
            }
          }, 50);
          break;
        case 'resetSave':
          resetSave();
          location.reload();
          break;
      }
    });

    if (CONFIG.DEV_MODE) setActive(true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      setActive(!active);
    }
  });
})();

// Fix for blank reels on resize - refresh reel positions when viewport changes
// --------- Robust reel resize handling ---------
function getTranslateYpx(elem){
  const st = window.getComputedStyle(elem);
  const tr = st.transform || st.webkitTransform || st.mozTransform;
  if (!tr || tr === 'none') return 0;
  const m = tr.match(/matrix\(([^)]+)\)/);
  if (m && m[1]){
    const parts = m[1].split(',').map(Number);
    return parts.length === 6 ? parts[5] : 0;
  }
  const m2 = tr.match(/matrix3d\(([^)]+)\)/);
  if (m2 && m2[1]){
    const parts = m2[1].split(',').map(Number);
    return parts.length === 16 ? parts[13] : 0;
  }
  return 0;
}

function resizeReelsSnap(){
  if (isSpinning || reelSpinInFlight) return; // never interrupt a live spin
  const reelNodes = document.querySelectorAll('.reel');
  if (!reelNodes.length) return;

  // Defer a tick to ensure layout settles after UI chrome changes
  requestAnimationFrame(() => {
    reelNodes.forEach(reel => {
      const strip = reel.querySelector('.strip');
      if (!strip) return;

      const reelRectH = Math.round(reel.offsetHeight);
      if (!reelRectH || reelRectH < 10) return; // wait for a real size next tick

      const cellH = Math.max(10, Math.round(reelRectH / ROWS));
      reel.style.setProperty('--cell-h', `${cellH}px`);

      // current offset and strip metrics
      const y = getTranslateYpx(strip);
      const stripHeight = strip.scrollHeight || (strip.children.length * cellH);
      const maxDown = 0; // can't go below the top
      const maxUp = -Math.max(0, stripHeight - reelRectH); // negative value

      // snap to nearest row and clamp to valid range
      let snapped = Math.round(y / cellH) * cellH;
      if (!Number.isFinite(snapped)) snapped = 0;
      snapped = Math.min(maxDown, Math.max(maxUp, snapped));

      // snap without animating
      const prev = strip.style.transition;
      strip.style.transition = 'none';
      strip.style.transform = `translateY(${snapped}px)`;
      void strip.offsetHeight; // reflow
      strip.style.transition = prev;
    });
  });
}

// Observe size changes of the slot area and reels
let reelResizeObserver = null;
function setupResizeObservers(){
  try {
    if (reelResizeObserver) return;
    reelResizeObserver = new ResizeObserver(() => resizeReelsSnap());
    const slot = document.getElementById('slot');
    if (slot) reelResizeObserver.observe(slot);
    document.querySelectorAll('.reel').forEach(r => reelResizeObserver.observe(r));
    window.addEventListener('orientationchange', resizeReelsSnap);
    window.addEventListener('resize', resizeReelsSnap);
  } catch(e){ /* ignore */ }
}

// (safeInit now calls resizeReelsSnap/setupResizeObservers directly)


// ===== JACKPOT HOLD & WIN =====
const HW_ROWS = 3;
const HW_COLS = 5;
const HW_TOTAL = HW_ROWS * HW_COLS;
const HW_START_SPINS = 3;
const HW_METEOR_CHANCE = 0.08; // rebalanced from 0.25, which made a full 1000x board near-certain
const HW_FULL_BOARD_MULT = 1000;
const HW_VALUES = [
  { mult: 1,   weight: 40 },
  { mult: 2,   weight: 25 },
  { mult: 3,   weight: 15 },
  { mult: 5,   weight: 10 },
  { mult: 10,  weight: 6  },
  { mult: 25,  weight: 3  },
  { mult: 100, weight: 1  },
];
let hwBoard = null;
let hwSpinsLeft = 0;
let hwRunning = false;
let hwSpinInFlight = false;

function hwPickMeteorMult() {
  const total = HW_VALUES.reduce((s, v) => s + v.weight, 0);
  let r = Math.random() * total;
  for (const v of HW_VALUES) { r -= v.weight; if (r <= 0) return v.mult; }
  return HW_VALUES[0].mult;
}

function ensureHoldWinBoard() {
  let board = document.getElementById('holdWinBoard');
  if (board) return board;
  board = document.createElement('div');
  board.id = 'holdWinBoard';
  board.innerHTML = `
    <div id="holdWinHeader">
      <div id="holdWinStatus"><span id="holdWinSpinsLeft">3</span> SPINS</div>
      <div id="holdWinTotal">Total: <span id="holdWinTotalMult">0</span>x</div>
    </div>
    <div id="holdWinGrid"></div>
    <button id="holdWinSpinBtn" type="button">SPIN</button>
  `;
  document.body.appendChild(board);
  const grid = board.querySelector('#holdWinGrid');
  for (let i = 0; i < HW_TOTAL; i++) {
    const cell = document.createElement('div');
    cell.className = 'hw-cell';
    cell.dataset.index = i;
    grid.appendChild(cell);
  }
  board.querySelector('#holdWinSpinBtn').addEventListener('click', () => {
    if (!hwRunning || hwSpinInFlight) return;
    doHoldWinSpin();
  });
  return board;
}

function renderHoldWinBoard(newlyLanded) {
  const board = ensureHoldWinBoard();
  const cells = board.querySelectorAll('.hw-cell');
  let totalMult = 0;
  hwBoard.forEach((slot, i) => {
    const cell = cells[i];
    if (slot) {
      totalMult += slot.mult;
      if (!cell.classList.contains('filled')) {
        cell.classList.add('filled');
        cell.innerHTML = `<div class="hw-meteor"><span>${slot.mult}x</span></div>`;
      }
      if (newlyLanded && newlyLanded.has(i)) {
        cell.classList.remove('landing');
        void cell.offsetWidth;
        cell.classList.add('landing');
      }
    } else {
      cell.classList.remove('filled', 'landing');
      cell.innerHTML = '';
    }
  });
  const spinsEl = board.querySelector('#holdWinSpinsLeft');
  const totalEl = board.querySelector('#holdWinTotalMult');
  if (spinsEl) spinsEl.textContent = hwSpinsLeft;
  if (totalEl) totalEl.textContent = totalMult;
}

function startHoldAndWin() {
  hwBoard = new Array(HW_TOTAL).fill(null);
  hwSpinsLeft = HW_START_SPINS;
  hwRunning = true;
  hwSpinInFlight = false;
  const board = ensureHoldWinBoard();
  renderHoldWinBoard(null);
  board.classList.add('show');
}

function doHoldWinSpin() {
  hwSpinInFlight = true;
  const btn = document.getElementById('holdWinSpinBtn');
  if (btn) btn.disabled = true;
  const landed = new Set();
  for (let i = 0; i < HW_TOTAL; i++) {
    if (hwBoard[i] !== null) continue;
    if (Math.random() < HW_METEOR_CHANCE) {
      hwBoard[i] = { mult: hwPickMeteorMult() };
      landed.add(i);
    }
  }
  if (landed.size > 0) hwSpinsLeft = HW_START_SPINS;
  else hwSpinsLeft -= 1;
  renderHoldWinBoard(landed);
  const boardFull = hwBoard.every(s => s !== null);
  setTimeout(() => {
    hwSpinInFlight = false;
    if (btn) btn.disabled = false;
    if (boardFull) endHoldAndWin(true);
    else if (hwSpinsLeft <= 0) endHoldAndWin(false);
  }, window.DEV_FAST_ANIMS ? 200 : 900);
}

function endHoldAndWin(boardFull) {
  hwRunning = false;
  const board = document.getElementById('holdWinBoard');
  const sumMult = hwBoard.reduce((s, c) => s + (c ? c.mult : 0), 0);
  const totalMult = boardFull ? HW_FULL_BOARD_MULT : sumMult;
  const payout = bet * totalMult;
  balance += payout;
  updateBalanceUI();
  const overlay = document.getElementById('fsTotalWinOverlay');
  const amountEl = document.getElementById('fsTotalWinAmount');
  if (amountEl) amountEl.textContent = formatCurrency(0);
  overlay?.classList.add('show');
  const countDuration = window.DEV_FAST_ANIMS ? 400 : 1400;
  const startTime = performance.now();
  function countUp(t) {
    const elapsed = t - startTime;
    const progress = Math.min(elapsed / countDuration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (amountEl) amountEl.textContent = formatCurrency(payout * eased);
    if (progress < 1) requestAnimationFrame(countUp);
  }
  requestAnimationFrame(countUp);
  setTimeout(() => {
    overlay?.classList.remove('show');
    setTimeout(() => {
      if (board) {
        board.classList.remove('show');
        board.querySelectorAll('.hw-cell').forEach(c => {
          c.classList.remove('filled', 'landing');
          c.innerHTML = '';
        });
      }
      window.endJackpotScene?.();
    }, 600);
  }, countDuration + 1200);
}

window.startHoldAndWin = startHoldAndWin;

/* ============================================================
   ZYLO ANIMATION STATE MACHINE (Polish Pass — Operation 1)
   ------------------------------------------------------------
   Presentation only. This module is entirely ADDITIVE: it does not edit
   a single existing line of game.js. It attaches to gameplay by wrapping
   three presentation functions and by observing class changes that the
   game already makes. Nothing here reads, writes or influences reel
   timing, stop positions, paylines, payouts, RTP, feature triggers,
   Zap/Free Spins/Jackpot logic, saves, the simulator or Dev Mode.

   States (highest priority first): BIG_WIN > ZAP > ANTICIPATION > SPIN > IDLE
   Gameplay events request a state; this module owns all transitions.

   No requestAnimationFrame loops. No getBoundingClientRect or offset*
   reads. Gaze targets are constants, not measured positions.
   ============================================================ */
(function ZyloAnimModule(){
  'use strict';

  const img   = document.querySelector('.zylo-header-image');
  const orbit = document.querySelector('.zylo-orbit');
  if (!img) return; // no Zylo on this page: stay completely inert

  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  img.classList.add('zy-managed'); // enables the smooth return-to-neutral transitions

  // ---------- Idle beat catalogue (class -> duration, must match CSS) ----------
  const BEATS = [
    { cls: 'zy-beat-bob2',      ms: 1900 },
    { cls: 'zy-beat-tilt-l',    ms: 1500 },
    { cls: 'zy-beat-tilt-r',    ms: 1500 },
    { cls: 'zy-beat-glance-l',  ms: 1750 },
    { cls: 'zy-beat-glance-r',  ms: 1750 },
    { cls: 'zy-beat-reels',     ms: 1650 },
    { cls: 'zy-beat-player',    ms: 1600 },
    { cls: 'zy-beat-thruster',  ms: 1150 },
    { cls: 'zy-beat-sway',      ms: 2600 },
    { cls: 'zy-beat-nod',       ms: 1300 }
  ];
  const BEAT_CLASSES = BEATS.map(b => b.cls);
  const WIN_CLASSES  = ['zy-win-pump', 'zy-win-hover', 'zy-win-dance', 'zy-win-point'];
  const WIN_MS       = { 'zy-win-pump': 1500, 'zy-win-hover': 1860, 'zy-win-dance': 1800, 'zy-win-point': 1700 };

  // Where Zylo looks for each reel. Constants on purpose: no layout reads.
  const GAZE_X = [-9, -4.5, 0, 4.5, 9];      // px
  const GAZE_R = [-3.2, -1.6, 0, 1.6, 3.2];  // deg

  const PRIORITY = { IDLE: 0, SPIN: 1, ANTICIPATION: 2, ZAP: 3, BIG_WIN: 4 };

  let active = 'IDLE';
  const held = new Set(['IDLE']);
  let lastBeat = -1;
  let idleTimer = null;
  let beatTimer = null;
  let winTimer = null;
  let recoilTimer = null;

  // Existing game classes that own the image's transform. While any of
  // them is present the state machine stays out of the way entirely.
  function foreignPose() {
    return img.classList.contains('zap-armed')
        || img.classList.contains('zap-firing')
        || img.classList.contains('celebrate')
        || img.classList.contains('look-jackpot');
  }

  function clearBeat() {
    if (beatTimer) { clearTimeout(beatTimer); beatTimer = null; }
    img.classList.remove(...BEAT_CLASSES);
  }
  function clearWin() {
    if (winTimer) { clearTimeout(winTimer); winTimer = null; }
    img.classList.remove(...WIN_CLASSES);
  }
  function setGaze(reelIndex) {
    const i = Math.max(0, Math.min(GAZE_X.length - 1, reelIndex | 0));
    img.style.setProperty('--zy-gx', GAZE_X[i] + 'px');
    img.style.setProperty('--zy-gr', GAZE_R[i] + 'deg');
  }
  function centerGaze() {
    img.style.setProperty('--zy-gx', '0px');
    img.style.setProperty('--zy-gr', '0deg');
  }

  // ---------- Idle scheduler: one beat at a time, never the same twice ----------
  function scheduleIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (reduceMotion) return;
    const gap = 2600 + Math.random() * 2600; // 2.6s - 5.2s between beats
    idleTimer = setTimeout(playIdleBeat, gap);
  }

  function playIdleBeat() {
    idleTimer = null;
    if (active !== 'IDLE') return;
    // Skip this beat (don't cancel the rhythm) if the page is hidden or
    // the game is currently posing Zylo itself.
    if (document.hidden || foreignPose()) { scheduleIdle(); return; }

    let pick = Math.floor(Math.random() * BEATS.length);
    if (pick === lastBeat) pick = (pick + 1 + Math.floor(Math.random() * (BEATS.length - 1))) % BEATS.length;
    lastBeat = pick;

    const beat = BEATS[pick];
    clearBeat();
    img.classList.add(beat.cls);
    beatTimer = setTimeout(() => {
      beatTimer = null;
      img.classList.remove(beat.cls); // keyframes end at neutral: clean return to idle pose
      scheduleIdle();
    }, beat.ms);
  }

  // ---------- State application ----------
  function apply(state) {
    clearBeat();
    if (state !== 'BIG_WIN') clearWin();
    img.classList.remove('zy-spin', 'zy-antic');
    orbit && orbit.classList.remove('zy-vibe');
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    switch (state) {
      case 'SPIN':
        img.classList.add('zy-spin');
        break;
      case 'ANTICIPATION':
        img.classList.add('zy-antic');
        if (orbit && !reduceMotion) orbit.classList.add('zy-vibe');
        break;
      case 'ZAP':
        // The game already drives .zap-armed / .zap-firing on the image.
        // We only add the ship recoil on the orbit so the two never fight.
        break;
      case 'BIG_WIN':
        break;
      case 'IDLE':
      default:
        centerGaze();
        scheduleIdle();
        break;
    }
  }

  function resolve() {
    let best = 'IDLE';
    held.forEach(s => { if (PRIORITY[s] > PRIORITY[best]) best = s; });
    if (best === active) return;
    active = best;
    apply(active);
  }

  function request(state) {
    if (!(state in PRIORITY)) return;
    held.add(state);
    resolve();
  }
  function release(state) {
    if (state === 'IDLE') return;
    held.delete(state);
    resolve();
  }

  // ---------- Public API ----------
  const ZyloAnim = {
    request, release,
    get state(){ return active; },
    lookAtReel: setGaze,
    // Big win: pick a celebration from the pool, then fall back to idle.
    celebrate(ms) {
      request('BIG_WIN');
      clearWin();
      if (!reduceMotion && !foreignPose()) {
        const cls = WIN_CLASSES[Math.floor(Math.random() * WIN_CLASSES.length)];
        img.classList.add(cls);
        winTimer = setTimeout(() => { winTimer = null; img.classList.remove(cls); }, WIN_MS[cls] || 1700);
      }
      setTimeout(() => { clearWin(); release('BIG_WIN'); }, ms || 2400);
    },
    // Zap: brief ship recoil at the moment of firing.
    recoil() {
      if (!orbit || reduceMotion) return;
      if (recoilTimer) { clearTimeout(recoilTimer); recoilTimer = null; }
      orbit.classList.remove('zy-recoil');
      void orbit.offsetWidth; // restart the keyframes (write-only reflow nudge)
      orbit.classList.add('zy-recoil');
      recoilTimer = setTimeout(() => { recoilTimer = null; orbit.classList.remove('zy-recoil'); }, 420);
    }
  };
  window.ZyloAnim = ZyloAnim;

  // ============================================================
  // HOOKS — all additive. Existing functions are wrapped, never edited.
  // ============================================================

  // 1) SPIN: wrap spin() so Zylo grips in and leans while the reels run.
  if (typeof window.spin === 'function') {
    const origSpin = window.spin;
    window.spin = async function wrappedSpin(){
      request('SPIN');
      centerGaze();
      try {
        return await origSpin.apply(this, arguments);
      } finally {
        release('SPIN');
      }
    };
  }

  // 2) GAZE: wrap triggerReelGlow(), which the game already calls as each
  //    reel lands. Zylo's look tracks the stops left -> right for free.
  if (typeof window.triggerReelGlow === 'function') {
    const origGlow = window.triggerReelGlow;
    window.triggerReelGlow = function wrappedReelGlow(reelEl){
      try {
        if (reelEl && (active === 'SPIN' || active === 'ANTICIPATION')) {
          const idx = parseInt(reelEl.getAttribute('data-reel'), 10);
          if (Number.isFinite(idx)) setGaze(idx);
        }
      } catch (e) {}
      return origGlow.apply(this, arguments);
    };
  }

  // 3) BIG WIN: wrap celebrateBigWin() for the celebration pool.
  if (typeof window.celebrateBigWin === 'function') {
    const origBigWin = window.celebrateBigWin;
    window.celebrateBigWin = function wrappedBigWin(){
      try { ZyloAnim.celebrate(2600); } catch (e) {}
      return origBigWin.apply(this, arguments);
    };
  }

  // 4) ANTICIPATION: observe the .reel-anticipation class the engine
  //    already applies. Pure observation — the anticipation planner, its
  //    timing, extensions, glow, vibration, audio and Zylo line are all
  //    untouched and still fire exactly where they did before.
  try {
    const reelNodes = document.querySelectorAll('.reel');
    if (reelNodes.length) {
      const anticipating = new Set();
      const reelObserver = new MutationObserver(muts => {
        for (const m of muts) {
          const el = m.target;
          const on = el.classList.contains('reel-anticipation');
          const idx = parseInt(el.getAttribute('data-reel'), 10);
          if (on && !anticipating.has(el)) {
            anticipating.add(el);
            if (Number.isFinite(idx)) setGaze(idx); // point toward the anticipated reel
            request('ANTICIPATION');
          } else if (!on && anticipating.has(el)) {
            anticipating.delete(el);
            if (anticipating.size === 0) release('ANTICIPATION');
          }
        }
      });
      reelNodes.forEach(r => reelObserver.observe(r, { attributes: true, attributeFilter: ['class'] }));
    }
  } catch (e) {}

  // 5) ZAP: observe the zap-armed / zap-firing classes the game already
  //    sets on Zylo. Zap logic, targeting and scoring are untouched.
  try {
    let wasFiring = false, zapHeld = false, inZapCb = false;
    const zyloObserver = new MutationObserver(() => {
      // Our own reactions below change classes on this same element, so the
      // edge flags are latched and `wasFiring` is updated BEFORE any side
      // effect runs. Re-entrancy guard included: correct whether the observer
      // batches asynchronously (browsers) or fires synchronously.
      if (inZapCb) return;
      inZapCb = true;
      try {
        const armed  = img.classList.contains('zap-armed');
        const firing = img.classList.contains('zap-firing');
        const startedFiring = firing && !wasFiring;
        const stoppedFiring = !firing && wasFiring;
        wasFiring = firing;
        if ((armed || firing) && !zapHeld) { zapHeld = true; request('ZAP'); }
        if (startedFiring) ZyloAnim.recoil();       // control pressed -> ship kicks back
        if (stoppedFiring) ZyloAnim.celebrate(1500); // brief celebration afterwards
        if (!armed && !firing && zapHeld) { zapHeld = false; release('ZAP'); }
      } finally { inZapCb = false; }
    });
    zyloObserver.observe(img, { attributes: true, attributeFilter: ['class'] });
  } catch (e) {}

  // Start in idle.
  apply('IDLE');
})();
