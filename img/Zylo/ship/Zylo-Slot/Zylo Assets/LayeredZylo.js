/* ============================================================
   LayeredZylo — assembles Zylo v2 from the layered PNG pack.
   ------------------------------------------------------------
   ship_body.png is the ROOT. Every other part is placed by an explicit
   (x, y) offset relative to it. Nothing is centred, nothing is inferred
   from image dimensions at runtime.

   UNITS
     x, y : percent of the SHIP ARTWORK's width / height.
            +x right, +y down. So y: -15 lifts a part by 15% of the
            ship image's height.
     s    : scale multiplier for that part.

   BASELINE
     With { x: 0, y: 0, s: 1 } a part is drawn exactly as its own PNG,
     overlaid 1:1 on the ship PNG. Scaling happens about the part's own
     ink centre, so changing s shrinks it in place without moving it.
     That means x/y and s are independent — tune either without the
     other drifting.

   These are the only numbers to touch. Everything below the constants
   is plumbing.
   ============================================================ */
(function (global) {
  'use strict';

  var ASSET_BASE = 'img/Zylo/';
  var FRAME = { w: 1536, h: 1024 };   // every source PNG shares this canvas

  /* ---------- DEBUG ISOLATION ----------
     Set to null for normal rendering. When it is an array of layer keys,
     ONLY those layers are drawn, every offset/scale is forced to identity
     (x:0 y:0 s:1), the rig's CSS animations and filters are switched off,
     and #app's overflow:hidden is lifted so nothing can crop the result.
     Valid keys: ship dashboard body armLeft armRight eyes mouth antenna
                 glass glow                                              */
  var DEBUG_ISOLATE = null;

  /* ---------- TUNE THESE ---------- */

  var SHIP_OFFSET           = { x:  0.00, y:   0.00, s: 1.0000 };  // root, keep at zero
  var DASHBOARD_OFFSET      = { x:  0.00, y:   0.00, s: 1.0000 };
  var BODY_OFFSET           = { x:  0.26, y:   0.87, s: 0.5800 };
  var LEFT_ARM_OFFSET       = { x: -8.37, y:   0.27, s: 0.1666 };
  var RIGHT_ARM_OFFSET      = { x:  6.61, y:   5.64, s: 0.1415 };
  var EYES_OFFSET           = { x:  0.65, y: -15.54, s: 0.1437 };
  var MOUTH_OFFSET          = { x:  0.29, y: -14.23, s: 0.0937 };
  var ANTENNA_OFFSET        = { x:  0.68, y: -27.91, s: 0.1354 };
  var GLASS_OFFSET          = { x:  0.00, y:   0.00, s: 1.0000 };
  var THRUSTER_GLOW_OFFSET  = { x:  0.00, y:   0.00, s: 1.0000 };

  /* -------- end of tuning section -------- */

  /* Ink centre of each PNG, measured once from the alpha channel of the
     supplied pack (opaque pixels, alpha > 200), as a fraction of the
     frame. Used only as the scale pivot so that s never shifts a part. */
  var INK = {
    ship:      { cx: 0.5088, cy: 0.5146 },
    dashboard: { cx: 0.5104, cy: 0.4849 },
    body:      { cx: 0.5046, cy: 0.4722 },
    armLeft:   { cx: 0.4867, cy: 0.5098 },
    armRight:  { cx: 0.5452, cy: 0.4556 },
    eyes:      { cx: 0.5007, cy: 0.4487 },
    mouth:     { cx: 0.5039, cy: 0.4727 },
    antenna:   { cx: 0.5003, cy: 0.4756 },
    glass:     { cx: 0.5068, cy: 0.5156 },
    glow:      { cx: 0.5042, cy: 0.5405 }
  };

  /* Paint order, bottom to top. */
  var LAYERS = [
    { key: 'ship',      cls: 'zl-ship',      file: 'ship/ship_body.png',           off: SHIP_OFFSET },
    { key: 'dashboard', cls: 'zl-dashboard', file: 'dashboard/zylo_dashboard.png',      off: DASHBOARD_OFFSET },
    { key: 'body',      cls: 'zl-body',      file: 'body/zylo_body.png',                off: BODY_OFFSET },
    { key: 'armLeft',   cls: 'zl-arm-left',  file: 'arms/Left_arm.png',            off: LEFT_ARM_OFFSET },
    { key: 'armRight',  cls: 'zl-arm-right', file: 'arms/Right_arm.png',           off: RIGHT_ARM_OFFSET },
    { key: 'eyes',      cls: 'zl-eyes',      file: 'eyes/zylo_eyes_center.png',                off: EYES_OFFSET },
    { key: 'mouth',     cls: 'zl-mouth',     file: 'mouths/zylo_mouth_smile.png',  off: MOUTH_OFFSET },
    { key: 'antenna',   cls: 'zl-antenna',   file: 'antenna/antenna.png',          off: ANTENNA_OFFSET },
    { key: 'glass',     cls: 'zl-cockpit',   file: 'ship/cockpit_glass.png',       off: GLASS_OFFSET },
    { key: 'glow',      cls: 'zl-glow',      file: 'thrusters/thruster_glow.png',  off: THRUSTER_GLOW_OFFSET }
  ];

  var els = {};

  /* The rig box is square while the art is 3:2, so object-fit: contain
     letterboxes the art into the middle two-thirds. A y offset given in
     percent of ART height therefore has to be scaled by artH/boxH before
     it becomes a CSS translate. Computed live so it stays correct if the
     box aspect ever changes. */
  function artRatio(box) {
    if (!box || !box.clientHeight) return (FRAME.h / FRAME.w);
    var fit = Math.min(box.clientWidth / FRAME.w, box.clientHeight / FRAME.h);
    return (FRAME.h * fit) / box.clientHeight;
  }

  function styleFor(layer, ratioY, ratioX) {
    var o = layer.off, ink = INK[layer.key];
    return {
      origin: (ink.cx * 100).toFixed(2) + '% ' +
              (((1 - ratioY) / 2 + ink.cy * ratioY) * 100).toFixed(2) + '%',
      transform: 'translate(' + (o.x * ratioX).toFixed(3) + '%, ' +
                 (o.y * ratioY).toFixed(3) + '%) scale(' + o.s + ')'
    };
  }

  function apply() {
    var box = els.root;
    if (!box) return;
    var dbg = Array.isArray(DEBUG_ISOLATE) ? DEBUG_ISOLATE : null;
    var rY = artRatio(box), rX = 1;
    LAYERS.forEach(function (L) {
      var el = els[L.key];
      if (!el) return;
      if (dbg) {
        if (dbg.indexOf(L.key) === -1) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.style.transformOrigin = '50% 50%';
        el.style.transform = 'none';          // identity: no offset, no scale
        return;
      }
      el.style.display = '';
      var st = styleFor(L, rY, rX);
      el.style.transformOrigin = st.origin;
      el.style.transform = st.transform;
    });
    if (dbg) debugReport(box, dbg);
  }

  /* Full per-layer diagnosis: load state, DOM presence, computed box and
     style, and every clipping ancestor. Call LayeredZylo.diagnose() from
     the console at any time. */
  function diagnose(key) {
    var keys = key ? [key] : LAYERS.map(function (L) { return L.key; });
    console.log('%c[LayeredZylo] diagnosis', 'font-weight:bold');
    keys.forEach(function (k) {
      var el = els[k];
      if (!el) { console.log(k, '-> NOT IN DOM'); return; }
      var cs = global.getComputedStyle ? global.getComputedStyle(el) : {};
      var r = el.getBoundingClientRect();
      var loaded = el.complete && el.naturalWidth > 0;
      console.groupCollapsed('%c' + k + '%c  ' + (loaded ? 'loaded' : 'NOT LOADED'),
        'font-weight:bold', loaded ? 'color:#5f5' : 'color:#f66');
      console.log('src            ', el.getAttribute('src'));
      console.log('1 loaded       ', loaded, '(complete=' + el.complete +
                  ', natural=' + el.naturalWidth + 'x' + el.naturalHeight + ')');
      console.log('2 in DOM       ', document.body ? document.body.contains(el) : 'n/a');
      console.log('3 computed size', cs.width + ' x ' + cs.height,
                  '| rendered box ' + r.width.toFixed(1) + ' x ' + r.height.toFixed(1));
      console.log('4 display      ', cs.display, '| visibility', cs.visibility,
                  '| opacity', cs.opacity, '| z-index', cs.zIndex);
      console.log('  transform    ', cs.transform, '| origin', cs.transformOrigin);
      var clippers = [], p = el.parentElement, guard = 0;
      while (p && guard++ < 30) {
        var pcs = global.getComputedStyle(p);
        if (pcs.overflow !== 'visible' || pcs.clipPath !== 'none') {
          var pr = p.getBoundingClientRect();
          var crops = r.top < pr.top || r.bottom > pr.bottom ||
                      r.left < pr.left || r.right > pr.right;
          clippers.push('<' + p.tagName.toLowerCase() +
            (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).split(' ')[0] : '') +
            '> overflow:' + pcs.overflow + (pcs.clipPath !== 'none' ? ' clip-path:' + pcs.clipPath : '') +
            (crops ? '  <-- ACTUALLY CROPS THIS LAYER' : '  (does not crop)'));
        }
        p = p.parentElement;
      }
      console.log('5 clipping     ', clippers.length ? clippers : 'none in the ancestor chain');
      if (!loaded) console.warn('6 CAUSE: image failed to load. Check the path above resolves.');
      else if (cs.display === 'none') console.warn('6 CAUSE: display:none');
      else if (cs.visibility === 'hidden') console.warn('6 CAUSE: visibility:hidden');
      else if (parseFloat(cs.opacity) === 0) console.warn('6 CAUSE: opacity 0');
      else if (r.width === 0 || r.height === 0) console.warn('6 CAUSE: zero-sized box');
      console.groupEnd();
    });
  }

  /* Turns off everything that could move or crop the rig, then measures
     what actually reaches the screen and prints it. */
  function debugReport(box, dbg) {
    box.classList.add('zylo-debug');
    var app = document.getElementById('app');
    if (app && !app.dataset.zyloPrevOverflow) {
      app.dataset.zyloPrevOverflow = app.style.overflow || 'unset';
      app.style.overflow = 'visible';
    }
    var r = box.getBoundingClientRect();
    var fit = Math.min(r.width / FRAME.w, r.height / FRAME.h);
    var artW = FRAME.w * fit, artH = FRAME.h * fit;
    console.log('[LayeredZylo] DEBUG isolate:', dbg.join(' + '));
    console.log('  rig box      ', r.width.toFixed(1) + ' x ' + r.height.toFixed(1),
                'at top ' + r.top.toFixed(1) + ', left ' + r.left.toFixed(1));
    console.log('  art after fit', artW.toFixed(1) + ' x ' + artH.toFixed(1),
                '(letterbox ' + ((r.height - artH) / 2).toFixed(1) + 'px top and bottom)');
    console.log('  body ink occupies frame y 5.5%-88.8% -> screen y ' +
                (r.top + (r.height - artH) / 2 + artH * 0.055).toFixed(1) + ' to ' +
                (r.top + (r.height - artH) / 2 + artH * 0.888).toFixed(1));
    if (r.top < 0) console.warn('  rig top is ABOVE the viewport (' + r.top.toFixed(1) + 'px)');
    console.log('  #app overflow temporarily set to visible for this test');
    diagnose();
  }

  function mount(mountPoint) {
    var host = mountPoint ||
               document.getElementById('zyloMount') ||
               document.querySelector('.zylo-orbit');
    if (!host) return null;

    var root = document.createElement('div');
    root.className = 'zylo-header-image zylo-rig';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', 'Zylo the alien pilot');

    LAYERS.forEach(function (L) {
      var img = document.createElement('img');
      img.className = 'zylo-layer ' + L.cls;
      img.src = ASSET_BASE + L.file;
      img.alt = '';
      // stacking order comes from the .zl-* z-index rules in style.css
      img.addEventListener('error', function () {
        console.warn('[LayeredZylo] missing asset:', img.getAttribute('src'));
      });
      els[L.key] = img;
      root.appendChild(img);
    });

    if (host.id === 'zyloMount' && host.parentNode) {
      host.parentNode.replaceChild(root, host);
    } else {
      host.insertBefore(root, host.firstChild);
    }
    els.root = root;
    apply();
    return root;
  }

  /* Mount immediately so that game.js, which does
     document.querySelector('.zylo-header-image') at load time, finds the
     rig root already in the DOM. This script must be included BEFORE
     game.js. */
  if (!mount()) {
    // Mount point not parsed yet (script moved above the markup): retry later.
    document.addEventListener('DOMContentLoaded', function () { mount(); });
  }
  global.addEventListener('resize', apply);

  global.LayeredZylo = {
    mount: mount,
    apply: apply,
    diagnose: diagnose,
    layers: LAYERS,
    ink: INK,
    frame: FRAME,
    assetBase: ASSET_BASE,
    offsets: {
      SHIP: SHIP_OFFSET, DASHBOARD: DASHBOARD_OFFSET, BODY: BODY_OFFSET,
      LEFT_ARM: LEFT_ARM_OFFSET, RIGHT_ARM: RIGHT_ARM_OFFSET, EYES: EYES_OFFSET,
      MOUTH: MOUTH_OFFSET, ANTENNA: ANTENNA_OFFSET, GLASS: GLASS_OFFSET,
      THRUSTER_GLOW: THRUSTER_GLOW_OFFSET
    }
  };
})(window);
