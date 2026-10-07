/* ============================================================
   NEBULA — procedural canvas background for Zylo's Slot
   ------------------------------------------------------------
   Replaces the CSS gradient version entirely.

   Why canvas: radial gradients only carry one scale of detail, so
   stacking them gives blobs. This builds the cloud from domain-warped
   fractal noise, which has structure at every scale, and it draws the
   pixels directly so it can make DARK dust lanes. Screen blending
   could only ever add light, which is why the old version had no
   definition.

   Cost: the noise runs once at load, sliced across frames so the page
   never freezes. After that there is no per-frame JavaScript at all.
   Drift is pure CSS transform on the wrapper, which the compositor
   handles on its own thread.

   Each layer is a wrapper div holding two canvases:
     .neb-cloud   texture resolution, stretched by CSS   (soft, fractal)
     .neb-stars   native screen resolution               (crisp specks)
   Splitting them keeps star points sharp instead of smearing them
   during the upscale. The stars cluster inside the cloud because they
   sample the density field the cloud was built from.

   Usage:
     <script src="nebula.js"></script>
   It self-starts on DOM ready. To control it yourself:
     window.NEBULA_NO_AUTOINIT = true;   // before the script tag
     Nebula.init({ seed: 1337 });
     Nebula.destroy();
   ============================================================ */

(function (global) {
  'use strict';

  /* ---------------- TUNING ----------------
     Threshold pair is where definition lives. Narrow the gap between
     thLo and thHi for harder, more torn edges. Widen it for haze. */

  var LAYERS = [
    {
      key: 'back',
      cls: 'nebula-back',
      texW: 880, texH: 415,
      scale: 3.2,       // noise zoom, lower is bigger features
      warp: 1.15,       // domain warp strength, this makes the wisps curl
      thLo: 0.20, thHi: 0.60,
      dustAmt: 0.55,
      filaments: 0.55,
      alpha: 0.46,
      starDensity: 0.00024,
      seedOffset: 0
    },
    {
      key: 'mid',
      cls: 'nebula-mid',
      texW: 1024, texH: 475,
      scale: 4.6,
      warp: 1.7,
      thLo: 0.22, thHi: 0.58,
      dustAmt: 1.0,
      filaments: 0.7,
      alpha: 0.80,
      starDensity: 0.00042,
      seedOffset: 977
    },
    {
      key: 'front',
      cls: 'nebula-front',
      texW: 950, texH: 425,
      scale: 6.8,
      warp: 2.1,
      thLo: 0.31, thHi: 0.55,
      dustAmt: 0.35,
      filaments: 1.0,
      alpha: 0.50,
      starDensity: 0.00056,
      seedOffset: 4231
    }
  ];

  /* Colour ramp. Hue is chosen by a slow noise field so the cloud
     changes colour across its length like the reference does, rather
     than being one flat tint. Warm rust is in there on purpose, it is
     what stops the whole thing reading as generic purple haze. */
  var RAMP = [
    { t: 0.00, c: [ 46,  26,  96] },   // deep indigo
    { t: 0.26, c: [124,  48, 200] },   // violet
    { t: 0.46, c: [186,  62, 138] },   // magenta
    { t: 0.66, c: [166, 100,  58] },   // rust
    { t: 0.84, c: [ 58, 150, 210] },   // steel blue
    { t: 1.00, c: [ 64, 202, 236] }    // cyan
  ];

  var CORE = [130, 224, 255];   // hot core colour, density pushes toward this
  var DUST = [ 12,   8,  18];   // dust lane colour, near black but not flat

  /* Ribbon: overlapping ellipses stepping up and to the right, so the
     union is a long winding band. Coordinates are 0..1 of the texture. */
  var RIBBON = [
    { x: 0.15, y: 0.68, rx: 0.16, ry: 0.21 },
    { x: 0.29, y: 0.61, rx: 0.17, ry: 0.20 },
    { x: 0.43, y: 0.53, rx: 0.18, ry: 0.19 },
    { x: 0.57, y: 0.46, rx: 0.17, ry: 0.18 },
    { x: 0.71, y: 0.40, rx: 0.16, ry: 0.17 },
    { x: 0.84, y: 0.34, rx: 0.13, ry: 0.15 },
    { x: 0.36, y: 0.74, rx: 0.11, ry: 0.13 },
    { x: 0.66, y: 0.27, rx: 0.10, ry: 0.12 }
  ];

  /* ---------------- noise ---------------- */

  /* Integer hash. The terms are added rather than XOR'd: XOR-combining
     the axes leaves straight artefacts along lattice lines, which show up
     as faint seams once the value is thresholded. */
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

  /* Ridged noise. Folding the value at its midpoint turns smooth humps
     into sharp creases, which is what reads as filaments and veins. */
  function rfbm(x, y, seed, oct) {
    var amp = 0.5, f = 1, sum = 0, norm = 0, n;
    for (var i = 0; i < oct; i++) {
      n = vnoise(x * f, y * f, seed + i * 131);
      n = 1 - Math.abs(n * 2 - 1);
      n *= n;
      sum += amp * n;
      norm += amp;
      amp *= 0.5;
      f *= 2.0;
    }
    return sum / norm;
  }

  /* Blobs are accumulated with a smooth falloff and clamped rather than
     max()'d together. A max of two cones leaves a crease along the line
     where they cross, and the density threshold turns that crease into a
     visible seam across the sky. */
  function ribbonMask(u, v) {
    var m = 0, i, b, dx, dy, d;
    for (i = 0; i < RIBBON.length; i++) {
      b = RIBBON[i];
      dx = (u - b.x) / b.rx;
      dy = (v - b.y) / b.ry;
      d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1) m += smooth(1 - d);
    }
    return m > 1 ? 1 : m;
  }

  function rampColour(t, out) {
    var i, a, b, f;
    if (t <= 0) { out[0] = RAMP[0].c[0]; out[1] = RAMP[0].c[1]; out[2] = RAMP[0].c[2]; return; }
    for (i = 0; i < RAMP.length - 1; i++) {
      a = RAMP[i]; b = RAMP[i + 1];
      if (t <= b.t) {
        f = (t - a.t) / (b.t - a.t);
        out[0] = a.c[0] + (b.c[0] - a.c[0]) * f;
        out[1] = a.c[1] + (b.c[1] - a.c[1]) * f;
        out[2] = a.c[2] + (b.c[2] - a.c[2]) * f;
        return;
      }
    }
    var last = RAMP[RAMP.length - 1].c;
    out[0] = last[0]; out[1] = last[1]; out[2] = last[2];
  }

  /* ---------------- cloud render ----------------
     Fills one row of the texture. Returns nothing, writes into data
     and records the density into dens so the stars can cluster later. */

  function renderRow(y, cfg, seed, data, dens) {
    var texW = cfg.texW, texH = cfg.texH;
    var aspect = texH / texW;
    var col = [0, 0, 0];
    var v = (y + 0.5) / texH;
    var ny = v * cfg.scale * aspect;
    var rowBase = y * texW;
    var x, u, nx, qx, qy, wx, wy, cloud, shape, field, density;
    var fil, dust, dark, hue, coreMix, bright, a, grain, o;

    /* Guaranteed fade to nothing before the texture edge, so the
       element boundary can never show up as a straight line. */
    var edgeV = smoothstep(0, 0.10, v) * smoothstep(0, 0.10, 1 - v);

    for (x = 0; x < texW; x++) {
      u = (x + 0.5) / texW;
      nx = u * cfg.scale;

      /* Domain warp. Offsetting the sample point by another noise
         field is what bends straight blobs into curling wisps. */
      qx = fbm(nx, ny, seed + 11, 4);
      qy = fbm(nx + 5.2, ny + 1.3, seed + 29, 4);
      wx = nx + cfg.warp * (qx - 0.5) * 2;
      wy = ny + cfg.warp * (qy - 0.5) * 2;

      cloud = fbm(wx, wy, seed + 47, 6);

      /* Large-scale thinning. Without this the band is one continuous
         slab of the same weight end to end, which is the thing that
         still reads as a blob even once the edges are torn. */
      cloud *= 0.42 + 1.05 * fbm(nx * 0.42 + 19.7, ny * 0.42 + 4.3, seed + 211, 3);
      shape = ribbonMask(u, v) * edgeV * smoothstep(0, 0.10, u) * smoothstep(0, 0.10, 1 - u);

      /* Thresholding noise against the ribbon is what tears the edge.
         A gradient stop would give a clean oval here. */
      field = cloud * (0.35 + 0.95 * shape);
      density = smoothstep(cfg.thLo, cfg.thHi, field);

      o = (rowBase + x) * 4;

      if (density <= 0.002) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
        dens[rowBase + x] = 0;
        continue;
      }

      fil = rfbm(wx * 2.1, wy * 2.1, seed + 71, 5);
      dust = fbm(wx * 0.85 + 11.3, wy * 0.85 + 7.9, seed + 103, 4);
      dark = smoothstep(0.40, 0.78, dust) * cfg.dustAmt;

      hue = fbm(nx * 0.55 + 3.1, ny * 0.55 + 8.4, seed + 157, 3);
      hue = clamp01(hue * 1.35 - 0.14);
      rampColour(hue, col);

      /* Hot core: dense areas drift toward the bright cyan white. */
      coreMix = Math.pow(density, 4.2) * 0.55;
      col[0] += (CORE[0] - col[0]) * coreMix;
      col[1] += (CORE[1] - col[1]) * coreMix;
      col[2] += (CORE[2] - col[2]) * coreMix;

      bright = 0.34 + cfg.filaments * 1.15 * fil;
      col[0] *= bright; col[1] *= bright; col[2] *= bright;

      /* Dust lanes. Colour goes near black while alpha stays up, so the
         lane occludes what is behind it instead of being a hole. */
      col[0] += (DUST[0] - col[0]) * dark;
      col[1] += (DUST[1] - col[1]) * dark;
      col[2] += (DUST[2] - col[2]) * dark;

      /* Push colour away from grey. Fractal noise averages toward the
         middle of the ramp, which desaturates everything if left alone. */
      var lum = (col[0] * 0.299 + col[1] * 0.587 + col[2] * 0.114);
      col[0] += (col[0] - lum) * 0.28;
      col[1] += (col[1] - lum) * 0.28;
      col[2] += (col[2] - lum) * 0.28;

      /* Fine grain breaks the plastic smoothness of pure noise. */
      grain = 0.88 + 0.24 * hash2(x * 7 + 1, y * 13 + 3, seed + 991);

      a = Math.pow(density, 1.25) * cfg.alpha * grain * (1 - 0.10 * dark);

      data[o]     = col[0] < 0 ? 0 : (col[0] > 255 ? 255 : col[0]);
      data[o + 1] = col[1] < 0 ? 0 : (col[1] > 255 ? 255 : col[1]);
      data[o + 2] = col[2] < 0 ? 0 : (col[2] > 255 ? 255 : col[2]);
      data[o + 3] = clamp01(a) * 255;

      dens[rowBase + x] = density;
    }
  }

  /* ---------------- stars ----------------
     Drawn at native screen resolution on their own canvas so the
     points stay crisp instead of being smeared by the cloud upscale. */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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

      /* Cluster inside the cloud, with a thin scatter of field stars
         outside it so the edge does not look cut out. */
      keep = 0.06 + d * 0.94;
      if (rnd() > keep) continue;

      px = u * w; py = v * h;
      r = 0.32 + rnd() * 0.62 + d * 0.42;
      alpha = (0.25 + rnd() * 0.55) * (0.35 + d * 0.75);
      tint = rnd();

      if (tint > 0.86) ctx.fillStyle = 'rgba(255,206,170,' + alpha.toFixed(3) + ')';
      else if (tint > 0.62) ctx.fillStyle = 'rgba(186,226,255,' + alpha.toFixed(3) + ')';
      else ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';

      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.283185307);
      ctx.fill();

      /* A few get a soft halo. Sparingly, or it turns into fog. */
      if (d > 0.45 && rnd() > 0.982) {
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
    if (w <= 480) return 0.62;
    if (cores <= 4) return 0.82;
    return 1;
  }

  function nextFrame() {
    return new Promise(function (res) {
      (global.requestAnimationFrame || function (f) { setTimeout(f, 16); })(res);
    });
  }

  function buildLayer(cfg, seed) {
    var wrap = document.createElement('div');
    wrap.className = 'nebula-layer ' + cfg.cls;

    var cloud = document.createElement('canvas');
    cloud.className = 'neb-cloud';
    cloud.width = cfg.texW;
    cloud.height = cfg.texH;

    var stars = document.createElement('canvas');
    stars.className = 'neb-stars';

    wrap.appendChild(cloud);
    wrap.appendChild(stars);

    return { cfg: cfg, seed: seed, wrap: wrap, cloud: cloud, stars: stars, dens: null };
  }

  function sizeStars(layer) {
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var r = layer.wrap.getBoundingClientRect();
    var w = Math.max(1, Math.round(r.width * dpr));
    var h = Math.max(1, Math.round(r.height * dpr));
    if (layer.stars.width === w && layer.stars.height === h) return false;
    layer.stars.width = w;
    layer.stars.height = h;
    return true;
  }

  function init(opts) {
    opts = opts || {};
    if (state.root) destroy();

    var seed = (opts.seed == null ? 20260804 : opts.seed) | 0;
    var q = opts.quality == null ? quality() : opts.quality;
    var mobile = (global.innerWidth || 1280) <= 480;

    var root = document.createElement('div');
    root.className = 'nebula-root';

    var defs = LAYERS.slice(0);
    if (mobile) defs = defs.slice(0, 2);   // drop the finest layer on phones

    defs.forEach(function (base) {
      var cfg = {};
      for (var k in base) cfg[k] = base[k];
      cfg.texW = Math.max(220, Math.round(cfg.texW * q));
      cfg.texH = Math.max(110, Math.round(cfg.texH * q));
      var layer = buildLayer(cfg, seed + cfg.seedOffset);
      state.layers.push(layer);
      root.appendChild(layer.wrap);
    });

    var mount = opts.mount ? document.querySelector(opts.mount) : document.body;
    (mount || document.body).insertBefore(root, (mount || document.body).firstChild);
    state.root = root;

    state.onResize = function () {
      clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        state.layers.forEach(function (l) {
          if (l.dens && sizeStars(l)) drawStars(l.stars, l.cfg, l.seed, l.dens);
        });
      }, 180);
    };
    global.addEventListener('resize', state.onResize);

    return generate();
  }

  /* Sliced generation. Keeps each frame's work under a budget so the
     reels never miss a frame while this is building. */
  function generate() {
    var budget = 9;   // ms of work per frame
    var layers = state.layers.slice(0);

    return (function run(idx) {
      if (idx >= layers.length) return Promise.resolve();
      var layer = layers[idx];
      var cfg = layer.cfg;
      var ctx = layer.cloud.getContext('2d');
      var img = ctx.createImageData(cfg.texW, cfg.texH);
      var dens = new Float32Array(cfg.texW * cfg.texH);
      var y = 0;

      function chunk() {
        var t0 = (global.performance || Date).now();
        while (y < cfg.texH) {
          renderRow(y, cfg, layer.seed, img.data, dens);
          y++;
          if (((global.performance || Date).now() - t0) > budget) break;
        }
        if (y < cfg.texH) return nextFrame().then(chunk);

        ctx.putImageData(img, 0, 0);
        layer.dens = dens;
        sizeStars(layer);
        drawStars(layer.stars, cfg, layer.seed, dens);
        layer.wrap.classList.add('is-ready');
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

  var Nebula = { init: init, destroy: destroy, _internals: {
    renderRow: renderRow, fbm: fbm, rfbm: rfbm, ribbonMask: ribbonMask, LAYERS: LAYERS
  } };

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
