/* ============================================================
   NEBULA CYCLE — appearance scheduler + variant rotation
   ------------------------------------------------------------
   Does not touch stars, shooting stars, planets, reels, UI, Zylo,
   audio, or gameplay. Only toggles .is-active on the .nebula-sky
   element that nebula.js builds, and calls Nebula.init() to switch
   between the three colour variants (nebula.js PALETTES). The pass
   animation itself (enter right, cross, exit left, fade, per-pass
   drift/scale/rotate) lives in nebula.css — this file is the timer
   and the per-pass randomization.

   ------------------------------------------------------------
   BACKGROUND TEST MODE — development only
   ------------------------------------------------------------
   Flip this one flag to switch between developing the nebula and
   shipping it:

     true  -> a pass starts almost immediately, passes repeat with
              only a few seconds of open sky between them, and the
              three colour variants cycle in a fixed A/B/C order
              with the active one logged to the console. Individual
              crossings also run shorter than production so you get
              more looks per minute of testing.

     false -> production behaviour: long, randomized, unpredictable
              gaps between passes, natural stretches of open star
              field, variants chosen at random (never repeating the
              immediately-previous one), full-length ~100-160s
              crossings, no console logging.

   Nothing about reel/game timing is read or touched by this file
   either way. */
const BACKGROUND_TEST_MODE =false;

(function () {
  'use strict';

  // ---- timing ----
  var NORMAL_MIN_DELAY_MS = 90 * 1000;    // production: ~1.5-6 min between passes
  var NORMAL_MAX_DELAY_MS = 360 * 1000;
  var TEST_MIN_DELAY_MS = 3 * 1000;       // test mode: a few seconds between passes
  var TEST_MAX_DELAY_MS = 7 * 1000;
  var TEST_FIRST_DELAY_MS = 1200;         // test mode: first pass within ~1-2s of load

  var NORMAL_DURATION_MIN_S = 100;        // production crossing length
  var NORMAL_DURATION_MAX_S = 160;
  var TEST_DURATION_MIN_S = 40;           // test mode: shorter so more passes fit per minute,
  var TEST_DURATION_MAX_S = 55;           // still slow enough to actually evaluate

  var FIND_ROOT_RETRY_MS = 150;
  var FIND_ROOT_MAX_TRIES = 40;           // ~6s of retrying before giving up

  // ---- the three nebula colour variants (see nebula.js PALETTES) ----
  // Deliberately independent of NEBULA_ROUTES below — pickVariant() and
  // pickRoute() are separate random calls, so no colour is ever tied to
  // a particular path (blue can go TOP_TO_BOTTOM one pass and
  // LOWER_LEFT_TO_UPPER_RIGHT the next).
  var NEBULA_VARIANTS = [
    { key: 'blue',  short: 'Cosmic Blue',  label: 'NEBULA A — Cosmic Blue',  seed: 20260805 },
    { key: 'teal',  short: 'Alien Teal',   label: 'NEBULA B — Alien Teal',   seed: 41133701 },
    { key: 'storm', short: 'Cosmic Storm', label: 'NEBULA C — Cosmic Storm', seed: 87651234 }
  ];

  var testVariantIndex = 0;
  var lastVariantKey = null;

  function pickVariant() {
    if (BACKGROUND_TEST_MODE) {
      var v = NEBULA_VARIANTS[testVariantIndex % NEBULA_VARIANTS.length];
      testVariantIndex++;
      return v;
    }
    // Production: random, but never immediately repeat the last variant,
    // so back-to-back passes don't look identical.
    var choices = NEBULA_VARIANTS.filter(function (v) { return v.key !== lastVariantKey; });
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function randRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function randSigned(min, max) {
    return randRange(min, max) * (Math.random() < 0.5 ? -1 : 1);
  }

  /* Smooth bounded random walk: `steps` values, each no more than
     stepMax away from the previous one (so consecutive keyframe stops
     never jump — that's what keeps the path from reading as a
     zigzag), softly clamped to +/-clampMax overall. Used to trace the
     Y / rotation / scale paths below independently, so each one
     wanders on its own schedule instead of all peaking together. */
  function randomWalk(steps, stepMax, clampMax) {
    var vals = [];
    var v = randSigned(0, clampMax * 0.5);
    for (var i = 0; i < steps; i++) {
      vals.push(v);
      if (i < steps - 1) {
        v += randSigned(0, stepMax);
        if (v > clampMax) v = clampMax - Math.random() * stepMax * 0.5;
        if (v < -clampMax) v = -clampMax + Math.random() * stepMax * 0.5;
      }
    }
    return vals;
  }

  // Evenly spaced sampling points for the whole pass (0-100%). The
  // route anchors below are resampled onto these 11 points (see
  // lerpAnchors/buildMotionKeyframes), so however few anchors a route
  // defines, the final @keyframes always has 11 closely-spaced stops —
  // that's what keeps everything smooth under `linear` timing no
  // matter how many anchors, or how differently spaced, a given route
  // uses internally.
  var MOTION_STOPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  /* ============================================================
     ROUTE SYSTEM
     ------------------------------------------------------------
     A route is a named path the whole .nebula-sky travels along
     during one pass, expressed as a handful of {t, x, y} anchors
     (t: 0-1 progress, x: vw, y: vh — these are translate3d offsets
     on the fixed, viewport-covering .nebula-sky element, so e.g.
     x:150 parks it off the right edge, y:-100 parks it above the
     top edge). buildMotionKeyframes() resamples whichever anchors
     the chosen route returns onto the 11 MOTION_STOPS.

     Every route function randomizes its own start/end/bend within
     controlled ranges, so no two passes of the same route look
     identical, and picks are independent of nebula colour (see the
     NEBULA_VARIANTS comment above).
     ============================================================ */

  /* Anchors at t=0,0.35,0.68,1 along the line from (sx,sy) to (ex,ey),
     bowed ONE direction (not alternating, so it reads as a single
     gentle arc rather than an S-curve) by `bend` units perpendicular
     to that line. x/y mix vw/vh, so "perpendicular" here is only an
     aesthetic approximation, not a true geometric perpendicular — a
     minor axis-scale mismatch that's invisible at these small bend
     amounts and this animation speed. */
  function buildBentPath(sx, sy, ex, ey, bend) {
    var dx = ex - sx, dy = ey - sy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var px = -dy / len, py = dx / len;
    return [
      { t: 0.00, x: sx, y: sy },
      { t: 0.35, x: sx + dx * 0.35 + px * bend * 0.6, y: sy + dy * 0.35 + py * bend * 0.6 },
      { t: 0.68, x: sx + dx * 0.68 + px * bend,        y: sy + dy * 0.68 + py * bend },
      { t: 1.00, x: ex, y: ey }
    ];
  }

  function lerpAnchors(anchors, t) {
    for (var i = 0; i < anchors.length - 1; i++) {
      var a = anchors[i], b = anchors[i + 1];
      if (t <= b.t || i === anchors.length - 2) {
        var span = b.t - a.t;
        var f = span > 0 ? (t - a.t) / span : 0;
        if (f < 0) f = 0; else if (f > 1) f = 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return { x: anchors[anchors.length - 1].x, y: anchors[anchors.length - 1].y };
  }

  // Route 1 — classic, kept as ONE possibility among several, not the
  // default. Right-center -> slightly upper-center -> left-center.
  function routeRightToLeft() {
    return buildBentPath(
      randRange(140, 160), randSigned(2, 5),
      -randRange(140, 160), randSigned(2, 5),
      randSigned(4, 10)
    );
  }

  // Routes 2-5 — the four diagonals. Ranges follow the brief's example
  // (~120-140vw horizontally, ~30-50% / 70-110% vertically at the
  // off-screen ends) so the vertical travel is genuinely visible, not
  // a token wobble.
  function routeUpperRightToLowerLeft() {
    return buildBentPath(
      randRange(120, 140), -randRange(30, 50),
      -randRange(120, 140), randRange(70, 110),
      randSigned(10, 20)
    );
  }
  function routeLowerRightToUpperLeft() {
    return buildBentPath(
      randRange(120, 140), randRange(70, 110),
      -randRange(120, 140), -randRange(30, 50),
      randSigned(10, 20)
    );
  }
  function routeUpperLeftToLowerRight() {
    return buildBentPath(
      -randRange(120, 140), -randRange(30, 50),
      randRange(120, 140), randRange(70, 110),
      randSigned(10, 20)
    );
  }
  function routeLowerLeftToUpperRight() {
    return buildBentPath(
      -randRange(120, 140), randRange(70, 110),
      randRange(120, 140), -randRange(30, 50),
      randSigned(10, 20)
    );
  }

  // Routes 6-7 — vertical passes. `lane` picks roughly where across
  // the width it falls (the brief's "25% / 50% / 70%" examples,
  // expressed as an offset from center); the bend then adds a gentle
  // horizontal wander through the fall/rise instead of a dead-straight
  // vertical ruler line.
  function routeTopToBottom() {
    var lane = randRange(-35, 35);
    return buildBentPath(
      lane, -randRange(90, 120),
      lane + randSigned(0, 12), randRange(90, 120),
      randSigned(10, 22)
    );
  }
  function routeBottomToTop() {
    var lane = randRange(-35, 35);
    return buildBentPath(
      lane, randRange(90, 120),
      lane + randSigned(0, 12), -randRange(90, 120),
      randSigned(10, 22)
    );
  }

  // Route 8 — edge graze. Stays mostly off-screen the whole pass and
  // only dips to a "closest approach" near one corner at the
  // midpoint, so only the outer cloud structure (bands are much
  // larger than .nebula-sky's own translated box) drifts across that
  // corner. Corner chosen randomly each time this route is picked.
  var EDGE_GRAZE_CORNERS = [
    { xSign:  1, ySign: -1 },  // top-right
    { xSign: -1, ySign: -1 },  // top-left
    { xSign: -1, ySign:  1 },  // bottom-left
    { xSign:  1, ySign:  1 }   // bottom-right
  ];
  function routeEdgeGraze() {
    var c = EDGE_GRAZE_CORNERS[Math.floor(Math.random() * EDGE_GRAZE_CORNERS.length)];
    var farX = c.xSign * randRange(105, 120), farY = c.ySign * randRange(80, 95);
    var nearX = c.xSign * randRange(50, 62), nearY = c.ySign * randRange(30, 42);
    return [
      { t: 0.00, x: farX + randSigned(0, 8),  y: farY + randSigned(0, 6) },
      { t: 0.30, x: (farX + nearX) / 2, y: (farY + nearY) / 2 },
      { t: 0.60, x: nearX, y: nearY },                              // closest approach — the graze
      { t: 1.00, x: farX + randSigned(0, 10), y: farY + randSigned(0, 8) }
    ];
  }

  // Weights roughly follow the brief: traditional ~30%, the four
  // diagonals sharing ~40% (~10% each), the two verticals sharing
  // ~20% (~10% each), edge graze ~10%. Not exact, doesn't need to be.
  var NEBULA_ROUTES = [
    { key: 'RIGHT_TO_LEFT',             weight: 30, build: routeRightToLeft },
    { key: 'UPPER_RIGHT_TO_LOWER_LEFT', weight: 10, build: routeUpperRightToLowerLeft },
    { key: 'LOWER_RIGHT_TO_UPPER_LEFT', weight: 10, build: routeLowerRightToUpperLeft },
    { key: 'UPPER_LEFT_TO_LOWER_RIGHT', weight: 10, build: routeUpperLeftToLowerRight },
    { key: 'LOWER_LEFT_TO_UPPER_RIGHT', weight: 10, build: routeLowerLeftToUpperRight },
    { key: 'TOP_TO_BOTTOM',             weight: 10, build: routeTopToBottom },
    { key: 'BOTTOM_TO_TOP',             weight: 10, build: routeBottomToTop },
    { key: 'EDGE_GRAZE',                weight: 10, build: routeEdgeGraze }
  ];

  var testRouteIndex = 0;
  function pickRoute() {
    if (BACKGROUND_TEST_MODE) {
      // Sequential round-robin so a short test session actually shows
      // every route, instead of weighted-random plausibly repeating
      // RIGHT_TO_LEFT (30% weight) several times in a row.
      var route = NEBULA_ROUTES[testRouteIndex % NEBULA_ROUTES.length];
      testRouteIndex++;
      return route;
    }
    var total = 0, i;
    for (i = 0; i < NEBULA_ROUTES.length; i++) total += NEBULA_ROUTES[i].weight;
    var r = Math.random() * total;
    for (i = 0; i < NEBULA_ROUTES.length; i++) {
      r -= NEBULA_ROUTES[i].weight;
      if (r <= 0) return NEBULA_ROUTES[i];
    }
    return NEBULA_ROUTES[NEBULA_ROUTES.length - 1];
  }

  var motionStyleEl = null;
  function ensureMotionStyleEl() {
    if (!motionStyleEl) {
      motionStyleEl = document.createElement('style');
      motionStyleEl.id = 'neb-motion-style';
      // Appended after nebula.css's <link>, so this @keyframes
      // nebulaCross wins the "last definition with this name" rule
      // and fully replaces the static fallback shipped in that file.
      document.head.appendChild(motionStyleEl);
    }
    return motionStyleEl;
  }

  /* Builds and installs a fresh @keyframes nebulaCross for this pass
     from the given route's anchors. Position (X/Y) comes from
     resampling the route onto the 11 MOTION_STOPS, plus a small extra
     Y micro-jitter layered on top purely for pass-to-pass texture —
     the route defines WHERE this pass travels, the jitter (along with
     the independent rotation/scale walks, unchanged from before) is
     the "still gets small randomized variation" layer on top of it.
     Returns nothing; call before .is-active is added. */
  function buildMotionKeyframes(route) {
    var n = MOTION_STOPS.length;
    var anchors = route.build();

    var microYRange = randRange(1, 2.2);      // vh, tiny extra texture on top of the route
    var microYWalk = randomWalk(n, microYRange * 0.5, microYRange);

    var rotAmp = randRange(1, 3);             // deg, this pass's rotation swing
    var rotWalk = randomWalk(n, rotAmp * 0.45, rotAmp);

    var baseScale = randRange(0.74, 0.94);
    var scaleSwing = randRange(0.02, 0.05);   // 2-5% breathing on top of baseScale
    var scaleWalk = randomWalk(n, scaleSwing * 0.45, scaleSwing);

    var peakOpacity = randRange(0.66, 0.86);

    var lines = MOTION_STOPS.map(function (pct, i) {
      var p = lerpAnchors(anchors, pct / 100);
      var x = p.x.toFixed(2) + 'vw';
      var y = (p.y + microYWalk[i]).toFixed(2) + 'vh';
      var r = rotWalk[i].toFixed(2) + 'deg';
      var s = (baseScale * (1 + scaleWalk[i])).toFixed(4);
      var decl = 'transform: translate3d(' + x + ', ' + y + ', 0) scale(' + s + ') rotate(' + r + ');';
      if (pct === 0 || pct === 100) decl = 'opacity: 0; ' + decl;
      else if (pct === 10 || pct === 90) decl = 'opacity: ' + peakOpacity.toFixed(3) + '; ' + decl;
      return '  ' + pct + '% { ' + decl + ' }';
    });

    ensureMotionStyleEl().textContent = '@keyframes nebulaCross {\n' + lines.join('\n') + '\n}';
  }

  /* Sets the crossing duration and builds this pass's motion path
     along the given route. Returns the chosen duration in ms, so the
     caller can size the animationend fallback timer correctly. */
  function applyPassVariation(sky, route) {
    var durMin = BACKGROUND_TEST_MODE ? TEST_DURATION_MIN_S : NORMAL_DURATION_MIN_S;
    var durMax = BACKGROUND_TEST_MODE ? TEST_DURATION_MAX_S : NORMAL_DURATION_MAX_S;
    var durationS = randRange(durMin, durMax);

    sky.style.setProperty('--neb-cross-duration', durationS.toFixed(1) + 's');
    buildMotionKeyframes(route);

    return Math.round(durationS * 1000);
  }

  function findSky(tries, cb) {
    var sky = document.querySelector('.nebula-sky');
    if (sky) { cb(sky); return; }
    if (tries >= FIND_ROOT_MAX_TRIES) return; // nebula.js never mounted; give up quietly
    setTimeout(function () { findSky(tries + 1, cb); }, FIND_ROOT_RETRY_MS);
  }

  function init() {
    var reducedMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return; // stays hidden permanently, no scheduling needed

    var running = false; // guards against overlapping passes

    function startPass() {
      if (running) return;
      running = true;

      // Independent picks — colour and route are never linked, so any
      // variant can land on any route.
      var variant = pickVariant();
      var route = pickRoute();
      lastVariantKey = variant.key;

      if (BACKGROUND_TEST_MODE) {
        console.log('[Nebula] ' + variant.short + ' — ' + route.key);
      }

      // init() tears down and rebuilds .nebula-sky with the chosen
      // palette/seed, so the element must be re-found afterward.
      window.Nebula.init({ seed: variant.seed, palette: variant.key });
      findSky(0, function (sky) { runPass(sky, route); });
    }

    function runPass(sky, route) {
      var durationMs = applyPassVariation(sky, route);

      // Two rAFs so the browser commits the freshly-set custom
      // properties (and the freshly-rebuilt layers) in one frame
      // before .is-active starts the animation in the next — avoids
      // the browser coalescing the property write and the class add
      // into a state where the animation reads stale values.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          sky.classList.add('is-active');
        });
      });

      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        sky.removeEventListener('animationend', finish);
        sky.classList.remove('is-active');
        running = false;
        scheduleNext();
      };

      sky.addEventListener('animationend', finish);
      // Safety fallback in case animationend is missed (e.g. tab was
      // backgrounded and throttled).
      setTimeout(finish, durationMs + 5000);
    }

    function scheduleNext(isFirst) {
      var delay;
      if (BACKGROUND_TEST_MODE) {
        delay = isFirst ? TEST_FIRST_DELAY_MS : randRange(TEST_MIN_DELAY_MS, TEST_MAX_DELAY_MS);
      } else {
        delay = randRange(NORMAL_MIN_DELAY_MS, NORMAL_MAX_DELAY_MS);
      }
      setTimeout(startPass, delay);
    }

    scheduleNext(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
