/* ============================================================
   NEBULA — procedural canvas background for Zylo's Zap
   ------------------------------------------------------------
   WHAT CHANGED vs the previous version, and why:

   The old generator built the cloud from one fbm field masked by a
   chain of 8 ellipses. Fractal noise is self-similar, so masking it
   with a smooth shape gives you a smooth shape with fuzz on it — one
   blob. Real nebulae are not one object, they are hundreds of knots,
   sheets and cavities at different scales.

   Four mechanisms replace that:

     1. CLUMP FIELD    ~180 blobs in 5 tiers. Each tier anchors on a
                       parent from the tier above and shrinks. This is
                       the single biggest reason the cloud now reads as
                       many structures instead of one.
     2. FILAMENT WEB   cellular F2-F1 noise. Cell walls form a branching
                       strand network, which fbm cannot produce. Masked
                       so it appears in patches, not as cracked mud.
     3. CARVED DUST    dust is SUBTRACTED from density before the
                       threshold, so it opens real holes and cavities.
                       The old version painted dark over solid cloud,
                       which is why lanes read as smudges.
     4. PRE-THRESHOLD  high-frequency noise added to the field BEFORE
        DETAIL         smoothstep. Post-threshold detail only textures a
                       solid mass; pre-threshold detail shatters the
                       edge into separate islands.

   Cost: noise runs once at load, sliced across frames under a per-frame
   ms budget so the reels never drop a frame. After that there is ZERO
   per-frame JavaScript. Drift is a CSS transform on the compositor
   thread.

   Structure it builds (no HTML needed):

     .nebula-sky                       fixed, z-index 0
       .nebula-band.neb-back           one parallax layer
         .nebula-track                 200% wide, scrolls right-to-left
           .nebula-panel               50% of track
             canvas.neb-cloud          texture res, stretched
             canvas.neb-stars          native res, crisp
           .nebula-panel               identical copy, makes the loop seamless
       .nebula-band.neb-mid
       .nebula-band.neb-front

   Class names are deliberately NOT .nebula-layer any more. The old
   gradient rules in style.css target that name, and fighting them in
   the cascade was fragile. Different names means they simply never
   match. Delete the old block from style.css when convenient.

   Usage:
     <link rel="stylesheet" href="nebula.css">
     <script src="nebula.js"></script>
   Self-starts on DOM ready. Manual control:
     window.NEBULA_NO_AUTOINIT = true;   // before the script tag
     Nebula.init({ seed: 1337 });
     Nebula.destroy();
   ============================================================ */

(function (global) {
  'use strict';

  /* ================= TUNING =================
     The parameters that actually matter, in order of impact:

     thGain        HOW FAST THE THRESHOLD RISES as the clump mask falls
                   off. This is the coverage dial. Raise it and the
                   clouds shrink toward their cores, leaving more open
                   sky; lower it and they spread and eventually merge
                   back into one continuous ribbon. Change this first.
     thLo / thHi   The threshold at the centre of a mass, and the width
                   of the transition. NARROW the gap for hard torn
                   edges and more separate islands, WIDEN for haze.
                   thLo on its own sets how solid the cores read.
     detail        Pre-threshold high-frequency amount. Raise it to
                   fragment the cloud further and cut finer holes.
                   Above ~0.75 it starts to look like static.
     dustAmt       How aggressively cavities are carved and lanes are
                   darkened. Raise for more voids, at the cost of mass.
     filaments     Strength of the cellular strand web.
     clumpDetail   Multiplier on the two smallest clump tiers. This is
                   the "many small structures" dial. 0 = smooth mass.
     warp          Domain warp. Curls everything. High values on a
                   low-frequency layer produce combing artefacts, which
                   is why back is kept low.
     alpha         Final opacity of the layer. Keep the sum modest —
                   this is background art, the reels are the subject.

     Composition lives in MASSES (how many separate clouds, where, how
     big) and MASS_JITTER_* (how far each layer displaces them, which
     is what stops the three layers stacking into one band).

     Colour lives in PALETTES (three named variants — blue/teal/storm,
     see below) — each has its own RAMP, HUE_CENTRE / HUE_SPREAD, and
     ACCENT_A / ACCENT_B accent tints. init({palette: 'teal'}) selects
     one; it becomes ACTIVE_PALETTE for that generation pass.
     ============================================ */

  var LAYERS = [
    {
      key: 'back',
      cls: 'neb-back',
      /* texW/texH bumped ~1.4x (from 1100x500/1180x520/1000x460) so the
         cloud stays crisp now that nebula.css displays it much closer to
         full size (scale ~0.75-0.95) instead of the old ~0.5 shrink —
         fewer pixels stretched over more screen space reads as blur. */
      texW: 1540, texH: 700,
      scale: 3.0,
      warp: 0.85,
      thLo: 0.26, thHi: 0.56, thGain: 0.52,
      detail: 0.34,
      dustAmt: 0.62,
      filaments: 0.48,
      clumpDetail: 0.60,
      alpha: 0.32,
      starDensity: 0.00022,
      seedOffset: 0
    },
    {
      key: 'mid',
      cls: 'neb-mid',
      texW: 1650, texH: 730,
      scale: 4.4,
      warp: 1.35,
      thLo: 0.34, thHi: 0.52, thGain: 0.64,
      detail: 0.56,
      dustAmt: 1.05,
      filaments: 0.94,
      clumpDetail: 1.15,
      alpha: 0.56,
      starDensity: 0.00040,
      seedOffset: 977
    },
    {
      key: 'front',
      cls: 'neb-front',
      texW: 1400, texH: 645,
      scale: 6.2,
      warp: 1.7,
      thLo: 0.38, thHi: 0.51, thGain: 0.68,
      detail: 0.66,
      dustAmt: 0.80,
      filaments: 1.06,
      clumpDetail: 1.45,
      alpha: 0.40,
      starDensity: 0.00052,
      seedOffset: 4231
    }
  ];

  /* Colour ramp. The hue field is a slow noise so colour varies along
     the cloud instead of being one flat tint.

     Three variants (see PALETTES below). Each has the same shape:
     RAMP (7 stops), HUE_CENTRE/HUE_SPREAD (where the hue field sits
     and how much it swings), CORE/GLOW/DUST (hot core / rim light /
     cavity colour) and two accent tints applied through patchy fields
     — ACCENT_A rides hot cores and filament crests, ACCENT_B sits in
     the mid-density gas. Swapping the whole object per pass is what
     lets nebula-cycle.js rotate between "Cosmic Blue", "Alien Teal"
     and "Cosmic Storm" without touching the generator itself. */
  var PALETTES = {

    /* NEBULA A — Cosmic Blue. The original palette, unchanged.
       Mystical / futuristic / classic deep space: deep blue, violet,
       cyan, small magenta accents. Ramp is weighted toward
       violet/magenta and the hue lookup is biased low (HUE_CENTRE) —
       an unbiased fractal field averages to the MIDDLE of whatever
       ramp you give it, so this keeps it from washing out to grey. */
    blue: {
      RAMP: [
        { t: 0.00, c: [ 34,  18,  78] },   // deep indigo
        { t: 0.20, c: [ 96,  40, 178] },   // violet
        { t: 0.42, c: [168,  54, 186] },   // purple-magenta
        { t: 0.58, c: [206,  62, 132] },   // magenta
        { t: 0.74, c: [188,  92,  84] },   // rose-rust
        { t: 0.88, c: [166, 108,  52] },   // amber rust
        { t: 1.00, c: [ 66, 168, 208] }    // teal, rare accent only
      ],
      HUE_CENTRE: 0.34,
      HUE_SPREAD: 1.55,
      CORE: [242, 230, 255],
      GLOW: [186, 232, 255],
      DUST: [  8,   5,  16],
      ACCENT_A: [110, 240, 255],   // cyan
      ACCENT_B: [255,  84, 196]    // magenta
    },

    /* NEBULA B — Alien Teal. Alien / mysterious / energetic: deep
       teal, emerald, aqua, small yellow-green highlights. Complements
       Zylo/Free Spins without copying their exact hues. */
    teal: {
      RAMP: [
        { t: 0.00, c: [ 10,  40,  42] },   // near-black teal
        { t: 0.18, c: [ 14,  74,  78] },   // deep teal
        { t: 0.38, c: [ 24, 128, 108] },   // teal-emerald
        { t: 0.55, c: [ 46, 168, 110] },   // emerald
        { t: 0.72, c: [ 70, 200, 170] },   // aqua-green
        { t: 0.88, c: [ 60, 220, 210] },   // aqua
        { t: 1.00, c: [190, 230,  90] }    // yellow-green, rare accent only
      ],
      HUE_CENTRE: 0.40,
      HUE_SPREAD: 1.40,
      CORE: [225, 255, 240],
      GLOW: [140, 255, 230],
      DUST: [  4,  10,   9],
      ACCENT_A: [130, 255, 225],   // aqua
      ACCENT_B: [214, 255, 110]    // yellow-green
    },

    /* NEBULA C — Cosmic Storm. Powerful / rare / cosmic storm: deep
       crimson, magenta, burnt orange, purple transitions. Complements
       the Jackpot side without looking like another Jackpot planet. */
    storm: {
      RAMP: [
        { t: 0.00, c: [ 30,   6,  20] },   // deep purple-black
        { t: 0.16, c: [ 70,  14,  60] },   // deep purple
        { t: 0.35, c: [130,  20,  70] },   // crimson-purple
        { t: 0.52, c: [178,  30,  50] },   // crimson
        { t: 0.68, c: [200,  70,  40] },   // burnt orange-red
        { t: 0.85, c: [214, 108,  40] },   // burnt orange
        { t: 1.00, c: [220,  40, 150] }    // magenta, rare accent only
      ],
      HUE_CENTRE: 0.40,
      HUE_SPREAD: 1.50,
      CORE: [255, 236, 214],
      GLOW: [255, 176, 140],
      DUST: [ 12,   4,   6],
      ACCENT_A: [255, 150,  70],   // burnt orange
      ACCENT_B: [255,  60, 150]    // magenta
    }
  };

  /* The palette actually in use for the current generation pass. Set
     at the top of init() from opts.palette. Generation is never
     concurrent (init() tears down any previous run first), so one
     shared mutable reference is safe. */
  var ACTIVE_PALETTE = PALETTES.blue;

  /* ---------------- noise ---------------- */

  /* Integer hash. Terms are ADDED, not XOR'd: XOR-combining the axes
     leaves straight artefacts along lattice lines, which become visible
     seams once the value is thresholded. */
  function hash2(x, y, seed) {
    var h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(seed | 0, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function smoothstep(e0, e1, x) {
    var t = (x - e0) / (e1 - e0);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function vnoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var u = smooth(x - xi), v = smooth(y - yi);
    var a = hash2(xi,     yi,     seed);
    var b = hash2(xi + 1, yi,     seed);
    var c = hash2(xi,     yi + 1, seed);
    var d = hash2(xi + 1, yi + 1, seed);
    var top = a + (b - a) * u;
    var bot = c + (d - c) * u;
    return top + (bot - top) * v;
  }

  function fbm(x, y, seed, oct) {
    var amp = 0.5, f = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f, y * f, seed + i * 101);
      norm += amp;
      amp *= 0.5;
      f *= 2.0;
    }
    return sum / norm;
  }

  /* Cellular F2 - F1. Small values sit on the wall between two cells,
     so inverting gives a connected branching web. fbm genuinely cannot
     make this shape — its ridges are parallel, not networked. */
  function cellDiff(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var f1 = 1e9, f2 = 1e9;
    var i, j, cx, cy, px, py, dx, dy, d;
    for (j = -1; j <= 1; j++) {
      for (i = -1; i <= 1; i++) {
        cx = xi + i; cy = yi + j;
        px = cx + hash2(cx, cy, seed);
        py = cy + hash2(cx, cy, seed + 7919);
        dx = px - x; dy = py - y;
        d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; }
        else if (d < f2) { f2 = d; }
      }
    }
    return Math.sqrt(f2) - Math.sqrt(f1);
  }

  /* Two scales of web, combined with max so strands branch into finer
     strands rather than sitting side by side. */
  function filamentWeb(x, y, seed) {
    /* Two scales only, and both are FINE. An earlier version started
       an octave lower to give the web a broad backbone, but at that
       frequency the cells are large enough to read as what they are —
       pentagons and hexagons outlined across the cloud. There is no
       weighting that hides it once filament strength goes up; the
       coarse scale simply has to go. Starting high means the strands
       branch without the tiling ever becoming legible. */
    var a = 1 - smoothstep(0.0, 0.30, cellDiff(x, y, seed));
    var b = 1 - smoothstep(0.0, 0.20, cellDiff(x * 2.40 - 2.1, y * 2.40 + 5.3, seed + 877));
    a *= 0.82;
    return a > b ? a : b;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- clump field ----------------
     Hierarchical blobs, but grouped into SEPARATE MASSES. Each mass
     runs its own 5-tier hierarchy: one core blob, then children
     scattered around a parent from the tier above, smaller each time.

     Why masses rather than one hierarchy: previously all tiers drew
     parents from a single pool, so tier-1 blobs bridged the gaps
     between the tier-0 anchors and the whole thing fused into one
     continuous ribbon. Confining each hierarchy to its own mass, and
     cutting the tier spreads so children stay close to their parent,
     leaves real empty sky between the clouds.

     Radii and counts are also down from the first version — this is
     where most of the coverage reduction comes from.

     Baked into a grid and bilinearly sampled; looping 200+ blobs per
     pixel would be tens of millions of distance tests per layer. */

  /* Position, and a size multiplier so the masses are not triplets.
     Keep them well separated in x or they will merge again. */
  var MASSES = [
    { x: 0.17, y: 0.56, size: 0.86, weight: 0.94 },
    { x: 0.43, y: 0.34, size: 1.00, weight: 1.00 },
    { x: 0.65, y: 0.68, size: 0.80, weight: 0.92 },
    { x: 0.86, y: 0.42, size: 0.70, weight: 0.86 }
  ];

  /* Per-layer jitter. Without it every layer puts its masses at the
     same coordinates and the three stack into one horizontal band —
     which is exactly the continuous-ribbon look we are trying to get
     away from. Generous values here are what makes the layers read as
     separate clouds at different depths. */
  var MASS_JITTER_X = 0.055;
  var MASS_JITTER_Y = 0.110;

  var TIERS = [
    { n: 1,  r: 0.205, spread: 0.000, w: 0.62 },
    { n: 5,  r: 0.122, spread: 0.132, w: 0.48 },
    { n: 12, r: 0.072, spread: 0.104, w: 0.40 },
    { n: 28, r: 0.041, spread: 0.074, w: 0.34 },
    { n: 54, r: 0.023, spread: 0.050, w: 0.29 }
  ];

  var GRID_W = 384, GRID_H = 192;

  function buildClumpGrid(cfg, seed) {
    var rnd = mulberry32(seed + 8123);
    var ar = cfg.texH / cfg.texW;          // keeps blobs round in pixels
    var grid = new Float32Array(GRID_W * GRID_H);

    var prev, cur, blobs = [];
    var mi, t, i, p, b, r;

    for (mi = 0; mi < MASSES.length; mi++) {
      var M = MASSES[mi];
      var mx = M.x + (rnd() - 0.5) * 2 * MASS_JITTER_X;
      var my = M.y + (rnd() - 0.5) * 2 * MASS_JITTER_Y;
      prev = [{ x: mx, y: my }];

      for (t = 0; t < TIERS.length; t++) {
        var tier = TIERS[t];
        cur = [];
        var detailScale = (t >= 3) ? cfg.clumpDetail : 1;
        var n = (t === 0) ? 1 : Math.max(1, Math.round(tier.n * M.size));
        for (i = 0; i < n; i++) {
          if (t === 0) {
            b = { x: mx, y: my };
          } else {
            p = prev[(rnd() * prev.length) | 0];
            b = {
              x: p.x + (rnd() - 0.5) * 2 * tier.spread * M.size,
              y: p.y + (rnd() - 0.5) * 2 * tier.spread * M.size * 0.74
            };
          }
          b.r = tier.r * M.size * (0.60 + rnd() * 0.72);
          b.w = tier.w * M.weight * (0.7 + rnd() * 0.6) * detailScale;
          cur.push(b);
          blobs.push(b);
        }
        prev = cur;
      }
    }

    /* Rasterise. Each blob only touches its own bounding box, so this
       is roughly O(total blob area) rather than blobs x pixels. */
    for (i = 0; i < blobs.length; i++) {
      b = blobs[i];
      r = b.r;
      var ry = r / ar;
      var x0 = Math.max(0, Math.floor((b.x - r) * GRID_W));
      var x1 = Math.min(GRID_W - 1, Math.ceil((b.x + r) * GRID_W));
      var y0 = Math.max(0, Math.floor((b.y - ry) * GRID_H));
      var y1 = Math.min(GRID_H - 1, Math.ceil((b.y + ry) * GRID_H));
      for (var gy = y0; gy <= y1; gy++) {
        var vv = (gy + 0.5) / GRID_H;
        for (var gx = x0; gx <= x1; gx++) {
          var uu = (gx + 0.5) / GRID_W;
          var dx = (uu - b.x) / r;
          var dy = ((vv - b.y) * ar) / r;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < 1) grid[gy * GRID_W + gx] += b.w * smooth(1 - d);
        }
      }
    }

    /* Soft clamp rather than hard: a hard clamp flattens the core into
       a plateau and the threshold then produces a bald patch. */
    for (i = 0; i < grid.length; i++) {
      grid[i] = 1 - Math.exp(-grid[i] * 1.35);
    }
    return grid;
  }

  /* Generic low-res field, bilinearly sampled. Used for the slow hue
     and large-scale mass variation, which do not need pixel accuracy
     and are expensive to evaluate per pixel. */
  function buildNoiseGrid(w, h, fn) {
    var g = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        g[y * w + x] = fn((x + 0.5) / w, (y + 0.5) / h);
      }
    }
    return g;
  }

  function sampleGrid(grid, gw, gh, u, v) {
    var fx = u * gw - 0.5, fy = v * gh - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var tx = fx - x0, ty = fy - y0;
    var x1 = x0 + 1, y1 = y0 + 1;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > gw - 1) x1 = gw - 1; if (y1 > gh - 1) y1 = gh - 1;
    if (x0 > gw - 1) x0 = gw - 1; if (y0 > gh - 1) y0 = gh - 1;
    var a = grid[y0 * gw + x0], b = grid[y0 * gw + x1];
    var c = grid[y1 * gw + x0], d = grid[y1 * gw + x1];
    var top = a + (b - a) * tx;
    var bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  function rampColour(t, out) {
    var ramp = ACTIVE_PALETTE.RAMP;
    var i, a, b, f;
    if (t <= 0) { out[0] = ramp[0].c[0]; out[1] = ramp[0].c[1]; out[2] = ramp[0].c[2]; return; }
    for (i = 0; i < ramp.length - 1; i++) {
      a = ramp[i]; b = ramp[i + 1];
      if (t <= b.t) {
        f = (t - a.t) / (b.t - a.t);
        out[0] = a.c[0] + (b.c[0] - a.c[0]) * f;
        out[1] = a.c[1] + (b.c[1] - a.c[1]) * f;
        out[2] = a.c[2] + (b.c[2] - a.c[2]) * f;
        return;
      }
    }
    var last = ramp[ramp.length - 1].c;
    out[0] = last[0]; out[1] = last[1]; out[2] = last[2];
  }

  /* ---------------- per-layer precompute ---------------- */

  /* Warp and dust are LOW frequency relative to the texture, so they
     are baked to grids and bilinearly sampled. Evaluating them per
     pixel was over half the total generation cost and, being smooth
     fields, the interpolation is visually free. The high-frequency
     detail noise stays per-pixel — gridding that would defeat it. */
  var WGW = 256, WGH = 128, DGW = 352, DGH = 176;

  function prepare(cfg, seed) {
    var aspect = cfg.texH / cfg.texW;
    var offX = new Float32Array(WGW * WGH);
    var offY = new Float32Array(WGW * WGH);
    var x, y, u, v, nx, ny, i;

    for (y = 0; y < WGH; y++) {
      v = (y + 0.5) / WGH; ny = v * cfg.scale * aspect;
      for (x = 0; x < WGW; x++) {
        u = (x + 0.5) / WGW; nx = u * cfg.scale;
        i = y * WGW + x;
        offX[i] = cfg.warp * (fbm(nx, ny, seed + 11, 4) - 0.5) * 2;
        offY[i] = cfg.warp * (fbm(nx + 5.2, ny + 1.3, seed + 29, 4) - 0.5) * 2;
      }
    }

    var dust = new Float32Array(DGW * DGH);
    for (y = 0; y < DGH; y++) {
      v = (y + 0.5) / DGH; ny = v * cfg.scale * aspect;
      for (x = 0; x < DGW; x++) {
        u = (x + 0.5) / DGW; nx = u * cfg.scale;
        var ox = sampleGrid(offX, WGW, WGH, u, v);
        var oy = sampleGrid(offY, WGW, WGH, u, v);
        dust[y * DGW + x] = fbm((nx + ox) * 0.90 + 11.3, (ny + oy) * 0.90 + 7.9, seed + 103, 4);
      }
    }

    return {
      offX: offX, offY: offY, dust: dust,
      clump: buildClumpGrid(cfg, seed),
      hue: buildNoiseGrid(192, 96, function (u, v) {
        return fbm(u * 5.4 + 3.1, v * 2.8 + 8.4, seed + 157, 4);
      }),
      mass: buildNoiseGrid(160, 80, function (u, v) {
        return fbm(u * 3.4 + 19.7, v * 1.8 + 4.3, seed + 211, 3);
      }),
      /* Where the filament web is allowed to show. Without this mask
         every cell wall lights up and the cloud looks like cracked
         mud. Patchy is what reads as real strand structure. */
      /* Which accent dominates locally. Low -> magenta, high -> cyan,
         middle -> neither, which is most of the cloud. */
      accent: buildNoiseGrid(160, 80, function (u, v) {
        return fbm(u * 4.2 - 7.3, v * 2.4 + 1.7, seed + 1471, 3);
      }),
      webMask: buildNoiseGrid(128, 64, function (u, v) {
        return smoothstep(0.50, 0.86, fbm(u * 4.6 - 5.5, v * 2.4 + 2.2, seed + 613, 3));
      })
    };
  }

  /* ---------------- cloud render ----------------
     One texture row. Writes RGBA into data and records density into
     dens so stars can cluster in the cloud afterwards. */

  function renderRow(y, cfg, seed, pre, data, dens) {
    var pal = ACTIVE_PALETTE;
    var texW = cfg.texW, texH = cfg.texH;
    var aspect = texH / texW;
    var col = [0, 0, 0];
    var v = (y + 0.5) / texH;
    var ny = v * cfg.scale * aspect;
    var rowBase = y * texW;
    var x, u, nx, qx, qy, wx, wy, sx, sy;
    var clump, mass, base, web, det, dustN, dust, fine, fineDust, field, density;
    var hue, coreMix, rim, lum, grain, a, o, bright;

    /* The cloud must reach zero alpha before every texture edge. The
       vertical fade stops the element boundary showing as a straight
       line; the HORIZONTAL fade is what makes the two-panel scroll
       loop invisibly, because the join lands on empty sky. */
    var edgeV = smoothstep(0, 0.12, v) * smoothstep(0, 0.12, 1 - v);

    for (x = 0; x < texW; x++) {
      u = (x + 0.5) / texW;

      clump = sampleGrid(pre.clump, GRID_W, GRID_H, u, v);

      o = (rowBase + x) * 4;

      /* Early out. Shape multiplier below starts at 0.06, so anywhere
         the clump field is near zero cannot clear thLo no matter what
         the noise does. Skipping those pixels saves roughly a third of
         the generation cost. */
      if (clump < 0.045) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
        dens[rowBase + x] = 0;
        continue;
      }

      nx = u * cfg.scale;

      /* Domain warp — bends straight structure into curling wisps. */
      qx = sampleGrid(pre.offX, WGW, WGH, u, v);
      qy = sampleGrid(pre.offY, WGW, WGH, u, v);
      wx = nx + qx;
      wy = ny + qy;

      base = fbm(wx, wy, seed + 47, 6);

      /* Contrast expansion around the mean. THIS IS LOAD-BEARING.
         fbm clusters hard around 0.5, so once the shape mask scales it
         up, the whole interior sits above thHi and thresholds to a
         flat slab — the grey blob problem. Widening the distribution
         first means the interior straddles the threshold and breaks
         into knots and holes instead. */
      base = 0.5 + (base - 0.5) * 2.25;

      mass = sampleGrid(pre.mass, 160, 80, u, v);

      /* Large-scale thinning. Without it the cloud is one slab of even
         weight end to end, which still reads as a blob however torn
         the edges are. */
      base *= 0.52 + 0.94 * mass;

      /* The clump mask no longer SCALES the field. It used to, and
         that was the reason mass interiors came out as smooth pale
         blobs: multiplying pushed the whole interior far above thHi,
         so the threshold only ever bit at the rim and there was
         nothing to carve holes inside.

         Instead the mask now RAISES THE THRESHOLD as it falls off.
         Inside a mass the threshold is low but the noise still dips
         under it in hundreds of places, so cavities and filament gaps
         appear right through the core. Out at the mass edge the
         threshold climbs until only the brightest peaks survive,
         which is what gives the torn wispy boundary. */
      field = base;

      /* Filament web. Sampled on a only LIGHTLY warped coordinate:
         pushing the full warp through cellular noise shears the cells
         into parallel combed strokes. */
      /* Pre-threshold detail. This is the step that breaks the cloud
         into separate islands — the same noise applied after the
         threshold would only texture a solid mass. */
      det = fbm(wx * 4.7 + 12.9, wy * 4.7 - 4.4, seed + 733, 4);
      field += (det - 0.5) * cfg.detail;

      web = 0;
      if (cfg.filaments > 0.01) {
        var wm = sampleGrid(pre.webMask, 128, 64, u, v);
        if (wm > 0.02) {            // cellular is the priciest term; skip it
          sx = nx * 3.6 + qx * 0.60;
          sy = ny * 3.6 + qy * 0.60;
          /* Modulating by the detail noise chews the strands into
             broken lengths instead of unbroken continuous walls. */
          web = filamentWeb(sx, sy, seed + 401) * wm * (0.12 + 1.10 * det);
          field += web * cfg.filaments * 0.22;
        }
      }

      /* Dust SUBTRACTS. It removes material and opens cavities, rather
         than painting dark over cloud that is still there. */
      dustN = sampleGrid(pre.dust, DGW, DGH, u, v);
      dust = smoothstep(0.34, 0.68, dustN) * cfg.dustAmt;
      field -= dust * 0.40;

      /* Second, much finer dust scale. The gridded field above is
         smooth enough to only produce large cavities; this one is
         evaluated per pixel and punches the small pockmark holes
         inside the clouds that the big lanes cannot reach. Kept on a
         high threshold so it removes specks, not mass. */
      fine = fbm(wx * 2.9 - 6.1, wy * 2.9 + 14.2, seed + 1907, 3);
      fineDust = smoothstep(0.54, 0.86, fine) * cfg.dustAmt;
      field -= fineDust * 0.38;

      /* Two-part response. A single smoothstep gives torn edges but
         clamps everything past thHi to exactly 1, so the interior
         becomes a flat matte patch with a cut-paper rim. The
         smoothstep now only carves the SILHOUETTE; a second,
         unclamped ramp carries the interior so density keeps varying
         all the way through the densest cores. */
      /* Edge fade is applied to the threshold too, so the cloud dies
         out before the texture boundary in every direction and the
         two-panel scroll still joins on empty sky. */
      var fade = edgeV * smoothstep(0, 0.15, u) * smoothstep(0, 0.15, 1 - u);
      var th0 = cfg.thLo + (1 - clump * fade) * cfg.thGain;
      var th1 = th0 + (cfg.thHi - cfg.thLo);

      var edge = smoothstep(th0, th1, field);
      var core = clamp01((field - th0) / 0.44);
      density = edge * (0.18 + 0.82 * core);

      if (density <= 0.003) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
        dens[rowBase + x] = 0;
        continue;
      }

      hue = sampleGrid(pre.hue, 192, 96, u, v);
      hue = clamp01(pal.HUE_CENTRE + (hue - 0.5) * pal.HUE_SPREAD);
      rampColour(hue, col);

      var acc = sampleGrid(pre.accent, 160, 80, u, v);

      /* Hot cores. Tighter exponent than a plain falloff so only the
         genuinely dense knots go white — spread it wider and the whole
         cloud washes out to grey. */
      coreMix = Math.pow(density, 8.5) * 0.52;
      col[0] += (pal.CORE[0] - col[0]) * coreMix;
      col[1] += (pal.CORE[1] - col[1]) * coreMix;
      col[2] += (pal.CORE[2] - col[2]) * coreMix;

      /* Strands read brighter than the gas around them. */
      bright = 0.62 + 0.42 * web * cfg.filaments + 0.42 * density;
      col[0] *= bright; col[1] *= bright; col[2] *= bright;

      /* Accent A on crests, in the patches where the accent field is high. */
      var cy = smoothstep(0.54, 0.88, density) * smoothstep(0.52, 0.82, acc) * 0.32;
      col[0] += (pal.ACCENT_A[0] - col[0]) * cy;
      col[1] += (pal.ACCENT_A[1] - col[1]) * cy;
      col[2] += (pal.ACCENT_A[2] - col[2]) * cy;

      /* Accent B in the mid-density gas only. Excluded from the cores
         so it never fights accent A for the same pixels. */
      var mg = smoothstep(0.16, 0.46, density)
             * (1 - smoothstep(0.50, 0.80, density))
             * smoothstep(0.56, 0.86, 1 - acc) * 0.30;
      col[0] += (pal.ACCENT_B[0] - col[0]) * mg;
      col[1] += (pal.ACCENT_B[1] - col[1]) * mg;
      col[2] += (pal.ACCENT_B[2] - col[2]) * mg;

      /* Tiny accent specks. det is already high-frequency, so
         thresholding it near the top of its range picks out a few
         scattered pixels rather than regions — these read as
         individual bright knots of ionised gas, not as a colour cast.
         Restricted to mid-and-up density so they sit ON the cloud. */
      var spark = (hash2(x >> 1, y >> 1, seed + 3301) > 0.9955 ? 1 : 0)
                * smoothstep(0.28, 0.60, density);
      var sc = spark * smoothstep(0.42, 0.74, acc) * 0.60;
      col[0] += (pal.ACCENT_A[0] - col[0]) * sc;
      col[1] += (pal.ACCENT_A[1] - col[1]) * sc;
      col[2] += (pal.ACCENT_A[2] - col[2]) * sc;

      var sm = spark * smoothstep(0.42, 0.74, 1 - acc) * 0.52;
      col[0] += (pal.ACCENT_B[0] - col[0]) * sm;
      col[1] += (pal.ACCENT_B[1] - col[1]) * sm;
      col[2] += (pal.ACCENT_B[2] - col[2]) * sm;

      /* Cool rim on the leading edge of dense knots. Cheap fake of
         ionisation fronts and it stops the cores looking like blobs
         of icing. */
      rim = smoothstep(0.74, 0.97, density) * smoothstep(0.62, 0.28, dustN) * 0.11;
      col[0] += (pal.GLOW[0] - col[0]) * rim;
      col[1] += (pal.GLOW[1] - col[1]) * rim;
      col[2] += (pal.GLOW[2] - col[2]) * rim;

      /* Dark lanes. Dust already removed material from the density
         field; this darkens what SURVIVES at the edges of a cavity, so
         a lane fades into black instead of stopping abruptly. */
      var darkMix = (smoothstep(0.30, 0.66, dustN) * 0.52
                   + smoothstep(0.52, 0.86, fine) * 0.30) * cfg.dustAmt;
      if (darkMix > 1) darkMix = 1;
      col[0] += (pal.DUST[0] - col[0]) * darkMix;
      col[1] += (pal.DUST[1] - col[1]) * darkMix;
      col[2] += (pal.DUST[2] - col[2]) * darkMix;

      /* Push away from grey. Fractal fields average toward the middle
         of the ramp, which desaturates everything if left alone. */
      lum = col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114;
      col[0] += (col[0] - lum) * 0.34;
      col[1] += (col[1] - lum) * 0.34;
      col[2] += (col[2] - lum) * 0.34;

      grain = 0.90 + 0.20 * hash2(x * 7 + 1, y * 13 + 3, seed + 991);

      /* S-curve on the way to alpha. This is the local-contrast dial:
         it pulls thin gas down and pushes dense gas up WITHOUT raising
         the peak, so the cloud sharpens rather than brightens. */
      var shaped = density * density * (3 - 2 * density);

      a = Math.pow(shaped, 1.12) * cfg.alpha * grain;

      data[o]     = col[0] < 0 ? 0 : (col[0] > 255 ? 255 : col[0]);
      data[o + 1] = col[1] < 0 ? 0 : (col[1] > 255 ? 255 : col[1]);
      data[o + 2] = col[2] < 0 ? 0 : (col[2] > 255 ? 255 : col[2]);
      data[o + 3] = clamp01(a) * 255;

      dens[rowBase + x] = density;
    }
  }

  /* ---------------- stars ----------------
     Native screen resolution on their own canvas so points stay crisp
     instead of being smeared by the cloud upscale. */

  function drawStars(canvas, cfg, seed, dens) {
    var w = canvas.width, h = canvas.height;
    if (!w || !h) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    var rnd = mulberry32(seed + 5501);
    var count = Math.round(w * h * cfg.starDensity);
    var texW = cfg.texW, texH = cfg.texH;
    var i, u, v, d, keep, r, alpha, tint, px, py, g;

    for (i = 0; i < count; i++) {
      u = rnd(); v = rnd();
      d = dens[(Math.min(texH - 1, (v * texH) | 0)) * texW + (Math.min(texW - 1, (u * texW) | 0))];

      keep = 0.06 + d * 0.94;
      if (rnd() > keep) continue;

      px = u * w; py = v * h;
      r = 0.32 + rnd() * 0.60 + d * 0.40;
      alpha = (0.22 + rnd() * 0.52) * (0.35 + d * 0.72);
      tint = rnd();

      if (tint > 0.86) ctx.fillStyle = 'rgba(255,206,170,' + alpha.toFixed(3) + ')';
      else if (tint > 0.62) ctx.fillStyle = 'rgba(186,226,255,' + alpha.toFixed(3) + ')';
      else ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';

      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.283185307);
      ctx.fill();

      if (d > 0.45 && rnd() > 0.984) {
        g = ctx.createRadialGradient(px, py, 0, px, py, r * 7);
        g.addColorStop(0, 'rgba(210,244,255,' + (alpha * 0.5).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(210,244,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, r * 7, 0, 6.283185307);
        ctx.fill();
      }
    }
  }

  /* ---------------- build ---------------- */

  var state = { root: null, layers: [], resizeTimer: 0, onResize: null };

  function quality() {
    var w = global.innerWidth || 1280;
    var cores = (global.navigator && navigator.hardwareConcurrency) || 4;
    if (w <= 480) return 0.58;
    if (cores <= 4) return 0.80;
    return 1;
  }

  function nextFrame() {
    return new Promise(function (res) {
      (global.requestAnimationFrame || function (f) { setTimeout(f, 16); })(res);
    });
  }

  function buildLayer(cfg, seed) {
    var band = document.createElement('div');
    band.className = 'nebula-band ' + cfg.cls;

    var track = document.createElement('div');
    track.className = 'nebula-track';
    band.appendChild(track);

    var panels = [];
    for (var i = 0; i < 2; i++) {
      var panel = document.createElement('div');
      panel.className = 'nebula-panel';

      var cloud = document.createElement('canvas');
      cloud.className = 'neb-cloud';
      cloud.width = cfg.texW;
      cloud.height = cfg.texH;

      var stars = document.createElement('canvas');
      stars.className = 'neb-stars';

      panel.appendChild(cloud);
      panel.appendChild(stars);
      track.appendChild(panel);
      panels.push({ panel: panel, cloud: cloud, stars: stars });
    }

    return { cfg: cfg, seed: seed, band: band, panels: panels, dens: null };
  }

  /* Panel 1 is a straight copy of panel 0 — same pixels, so the moment
     the track wraps, the image is already identical. */
  function mirrorPanel(layer) {
    var a = layer.panels[0], b = layer.panels[1];
    var cc = b.cloud.getContext('2d');
    cc.clearRect(0, 0, b.cloud.width, b.cloud.height);
    cc.drawImage(a.cloud, 0, 0);
    if (b.stars.width && b.stars.height) {
      var sc = b.stars.getContext('2d');
      sc.clearRect(0, 0, b.stars.width, b.stars.height);
      sc.drawImage(a.stars, 0, 0);
    }
  }

  function sizeStars(layer) {
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var r = layer.panels[0].panel.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (layer.panels[0].stars.width === w && layer.panels[0].stars.height === h) return false;
    layer.panels.forEach(function (p) { p.stars.width = w; p.stars.height = h; });
    return true;
  }

  function init(opts) {
    opts = opts || {};
    if (state.root) destroy();

    ACTIVE_PALETTE = PALETTES[opts.palette] || PALETTES.blue;

    var seed = (opts.seed == null ? 20260805 : opts.seed) | 0;
    var q = opts.quality == null ? quality() : opts.quality;
    var mobile = (global.innerWidth || 1280) <= 480;

    var root = document.createElement('div');
    root.className = 'nebula-sky';

    var defs = LAYERS.slice(0);
    if (mobile) defs = defs.slice(0, 2);   // drop the finest layer on phones

    defs.forEach(function (base) {
      var cfg = {};
      for (var k in base) cfg[k] = base[k];
      cfg.texW = Math.max(260, Math.round(cfg.texW * q));
      cfg.texH = Math.max(130, Math.round(cfg.texH * q));
      var layer = buildLayer(cfg, seed + cfg.seedOffset);
      state.layers.push(layer);
      root.appendChild(layer.band);
    });

    var mount = opts.mount ? document.querySelector(opts.mount) : document.body;
    mount = mount || document.body;
    mount.insertBefore(root, mount.firstChild);
    state.root = root;

    state.onResize = function () {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        state.layers.forEach(function (l) {
          if (l.dens && sizeStars(l)) {
            drawStars(l.panels[0].stars, l.cfg, l.seed, l.dens);
            mirrorPanel(l);
          }
        });
      }, 180);
    };
    global.addEventListener('resize', state.onResize);

    return generate();
  }

  /* Sliced generation: each frame's work stays under a budget so the
     reels never miss a frame while the sky is building. */
  function generate() {
    var budget = 9;   // ms of work per frame
    var layers = state.layers.slice(0);

    return (function run(idx) {
      if (idx >= layers.length) return Promise.resolve();
      var layer = layers[idx];
      var cfg = layer.cfg;
      var ctx = layer.panels[0].cloud.getContext('2d');
      var img = ctx.createImageData(cfg.texW, cfg.texH);
      var dens = new Float32Array(cfg.texW * cfg.texH);
      var pre = prepare(cfg, layer.seed);
      var y = 0;

      function chunk() {
        var t0 = (global.performance || Date).now();
        while (y < cfg.texH) {
          renderRow(y, cfg, layer.seed, pre, img.data, dens);
          y++;
          if (((global.performance || Date).now() - t0) > budget) break;
        }
        if (y < cfg.texH) return nextFrame().then(chunk);

        ctx.putImageData(img, 0, 0);
        layer.dens = dens;
        sizeStars(layer);
        drawStars(layer.panels[0].stars, cfg, layer.seed, dens);
        mirrorPanel(layer);
        layer.band.classList.add('is-ready');
        return nextFrame().then(function () { return run(idx + 1); });
      }

      return chunk();
    })(0);
  }

  function destroy() {
    if (state.onResize) global.removeEventListener('resize', state.onResize);
    clearTimeout(state.resizeTimer);
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.root = null;
    state.layers = [];
    state.onResize = null;
  }

  var Nebula = {
    init: init,
    destroy: destroy,
    _internals: {
      renderRow: renderRow, prepare: prepare, fbm: fbm,
      filamentWeb: filamentWeb, buildClumpGrid: buildClumpGrid,
      sampleGrid: sampleGrid, LAYERS: LAYERS, GRID_W: GRID_W, GRID_H: GRID_H
    }
  };

  global.Nebula = Nebula;

  if (!global.NEBULA_NO_AUTOINIT && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      init();
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Nebula;

})(typeof window !== 'undefined' ? window : globalThis);
