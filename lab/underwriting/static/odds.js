/* Odds board: what has to be true for GP IRR to hold a target.

   REAL DATA — web/story/futures.json (scripts/build_story_data.py): 5,001
   engine runs of one deal, twenty assumptions sampled together inside their
   verified ranges, row 0 the deal as underwritten. Every count and share the
   board shows is counted from those rows, here, in the browser.

   Top: every future as a dot, piled by its GP IRR; the ones at or above the
   target are green. Below: one row per assumption, its worse end on the left
   and its better end on the right (each dim's "flip" says which end helps GP
   IRR), cut into ten bands; a band's bar is the share of the futures in it
   that hold the target. Drag across a row to believe a range of it: the pile
   keeps only the futures that fit every belief, and every row recounts
   against the other rows' beliefs (a row never filters itself). The dotted
   line is the share among all futures; the ticks over the bars are each
   band's share before any belief.

     var board = OddsBoard.mount(root, { data: futures, target: 22, names: { rgrow: "rent growth" } });
     board.set("rgrow", [3, null]);        // a range in the assumption's units; null = that end
     board.clear(); board.state(); board.oddsFor({ hold: [null, 120] }); board.play();
     board.view({ data: lpView, target: 15, field: "lp_irr", metric: "LP IRR" });   // the same runs, another return
     board.onChange = function (state) {};  // after every change, from the user or a script
     board.onUser = function () {};         // the first time the user touches a row

   Motion is on site.css's clock: the pour is a --beat, a change of belief or
   of view carries every dot from where it is over --dur-4, the bars settle
   over --dur-3. Nothing is torn down and poured again.

   Styles are web/story.css (.ob-*); colors come from the host's tokens. */
(function () {
  "use strict";
  var BINS = 10, FEW = 20, FLOOR = -20;

  function fmtVal(d, v) {
    // a rate shown as a spread over a reference (the exit cap over the entry yield), in basis points
    if (d.spread != null) { var s = Math.round((v - d.spread) * 100); return (s < 0 ? "−" : "+") + Math.abs(s) + " bps"; }
    switch (d.unit) {
      case "$": return "$" + Math.round(v).toLocaleString("en-US");
      case "$M": return "$" + (+v.toFixed(2)) + "M";
      case " mo": return Math.round(v) + " mo";
      case " FTE": return +v.toFixed(2) + " FTE";
      case "": return +v.toFixed(2) + " hrs";
      default: return +v.toFixed(2) + d.unit;
    }
  }
  var easeOut = function (x) { return 1 - Math.pow(1 - x, 3); };                                       // arriving
  var easeMove = function (x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };    // travelling
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  function tok(name, fb) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(), n = parseFloat(v);
    return isNaN(n) ? fb : /ms$/.test(v) ? n : n * 1000;
  }

  function mount(root, o) {
    var names = o.names || {};
    var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    var DUR3 = tok("--dur-3", 360), DUR4 = tok("--dur-4", 720), BEAT = tok("--beat", 1300);
    var api = { onChange: null, onUser: null };
    function css(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }

    /* the runs and the return the board counts. Each future: its place along every row (0 = worse end,
       1 = better end), its return (no IRR counts as the floor) and whether it holds the target.
       A view of the same runs can be swapped in (view()), so N never changes */
    var data, T, dims, D, N = o.data.rows.length, gpAt, M, hiIRR;
    var P = [], G = new Float64Array(N), HOLD = new Uint8Array(N), held = 0, BASE = 0;   // 64-bit places: a future exactly at today's value must count on both sides
    var cntAll = [];
    function zeros() { var a = []; for (var i = 0; i < D; i++) a.push({ n: new Uint32Array(BINS), h: new Uint32Array(BINS) }); return a; }
    function load(v) {
      data = v.data; T = v.target; dims = data.dims; D = dims.length;
      gpAt = data.row_fields.indexOf(v.field || "gp_irr"); M = v.metric || "GP IRR"; hiIRR = data.irr.hi;
      P = []; held = 0;
      data.rows.forEach(function (r, k) {
        var p = new Float64Array(D);
        for (var i = 0; i < D; i++) {
          var d = dims[i], t = (r[i] - d.min) / (d.max - d.min);
          p[i] = d.flip ? 1 - t : t;
        }
        P.push(p);
        G[k] = r[gpAt] === null ? FLOOR : Math.max(FLOOR, r[gpAt]);
        HOLD[k] = r[gpAt] !== null && r[gpAt] >= T ? 1 : 0;
        held += HOLD[k];
      });
      BASE = held / N;
      cntAll = zeros();
      for (var k = 0; k < N; k++) for (var j = 0; j < D; j++) { var b = binOf(P[k][j]); cntAll[j].n[b]++; cntAll[j].h[b] += HOLD[k]; }
    }
    function posOf(d, v) { var t = (v - d.min) / (d.max - d.min); return d.flip ? 1 - t : t; }
    function valOf(d, p) { return d.min + (d.flip ? 1 - p : p) * (d.max - d.min); }
    function binOf(p) { return Math.min(BINS - 1, Math.max(0, Math.floor(p * BINS))); }
    load(o);

    /* beliefs: per assumption, a [lo, hi] range of places along its row */
    var bel = new Array(D).fill(null);
    function toPlaces(d, range) {
      var a = posOf(d, range[0] === null ? d.min : range[0]), b = posOf(d, range[1] === null ? d.max : range[1]);
      return [clamp(Math.min(a, b), 0, 1), clamp(Math.max(a, b), 0, 1)];
    }
    function inside(p, r) { return p >= r[0] - 1e-9 && p <= r[1] + 1e-9; }
    function count(beliefs) {
      var fit = 0, hold = 0;
      for (var k = 0; k < N; k++) {
        var ok = true;
        for (var i = 0; i < D && ok; i++) if (beliefs[i] && !inside(P[k][i], beliefs[i])) ok = false;
        if (ok) { fit++; hold += HOLD[k]; }
      }
      return { fit: fit, hold: hold, odds: fit ? hold / fit : null };
    }

    /* counts: per row and band, futures and how many hold, against every
       belief but the row's own; and the same before any belief (the ticks) */
    var cnt = [], last = { fit: N, hold: held, odds: BASE };
    function recount() {
      cnt = zeros();
      var fit = 0, hold = 0;
      for (var k = 0; k < N; k++) {
        var fails = 0, failed = -1, p = P[k];
        for (var i = 0; i < D; i++) if (bel[i] && !inside(p[i], bel[i])) { fails++; failed = i; if (fails > 1) break; }
        if (fails > 1) continue;
        if (!fails) { fit++; hold += HOLD[k]; }
        for (var j = 0; j < D; j++) {
          if (fails && failed !== j) continue;
          var b = binOf(p[j]);
          cnt[j].n[b]++; cnt[j].h[b] += HOLD[k];
        }
      }
      last = { fit: fit, hold: hold, odds: fit ? hold / fit : null };
    }

    /* ---------- markup: the pile, then two columns of rows ---------- */
    var pile = root.querySelector("[data-ob=pile]"), colsHost = root.querySelector("[data-ob=cols]");
    var pctx = pile.getContext("2d");
    var groups = [];
    dims.forEach(function (d) { if (groups.indexOf(d.group) < 0) groups.push(d.group); });
    var rows = [], heads = [];
    groups.forEach(function (g) {
      var col = document.createElement("div");
      col.className = "ob-col";
      /* the header carries the legend, so the board needs no paragraph to be read */
      col.innerHTML = '<h4><span>' + g + '</span><span class="ob-leg"><i class="lg-bar"></i><span class="ob-legt"></span>' +
        '<i class="lg-dot"></i>all that fit</span></h4><p class="ob-dir"><span></span><span></span></p>';
      heads.push({ leg: col.querySelector(".ob-legt"), dir: col.querySelectorAll(".ob-dir span") });
      dims.forEach(function (d, i) {
        if (d.group !== g) return;
        var name = names[d.id] || d.label;
        var row = document.createElement("div");
        row.className = "ob-row";
        row.dataset.id = d.id;
        row.innerHTML = '<div class="ob-lab"><b>' + name + '</b><small></small></div>' +
          '<div class="ob-tr"><canvas tabindex="0"></canvas><div class="ob-ends"><span></span><span></span></div></div>';
        col.appendChild(row);
        var cv = row.querySelector("canvas");
        rows.push({ i: i, el: row, cv: cv, ctx: cv.getContext("2d"), name: name, w: 0, h: 0,
          today: row.querySelector(".ob-lab small"), ends: row.querySelectorAll(".ob-ends span") });
      });
      colsHost.appendChild(col);
    });
    var rowOf = {};
    rows.forEach(function (r) { rowOf[r.i] = r; });
    /* the words of the board that depend on whose return it counts */
    function labelRows() {
      heads.forEach(function (h) { h.leg.textContent = "share of its scenarios at " + T + "%+"; h.dir[0].textContent = "lower " + M; h.dir[1].textContent = "higher " + M; });
      rows.forEach(function (r) {
        var d = dims[r.i];
        r.today.textContent = "today " + fmtVal(d, d.base);
        r.ends[0].textContent = fmtVal(d, d.flip ? d.max : d.min);
        r.ends[1].textContent = fmtVal(d, d.flip ? d.min : d.max);
      });
    }
    labelRows();

    /* ---------- drawing ---------- */
    var C = {}, grow = 0, dpr = 1;
    function colors() {
      C = { proof: css("--proof") || "#3a8", ink: css("--ink") || "#eee", mut: css("--ink-muted") || "#999",
        line: css("--line") || "#444", strong: css("--line-strong") || "#888", acc: css("--accent") || "#e85", paper: css("--surface") || "#222",
        mono: css("--mono") || "monospace" };
    }
    function sizeCanvas(cv) {
      var w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      return [w, h];
    }
    /* what each row shows, eased: the bars' shares, the dotted reference and today's mark travel to their new
       values instead of jumping (S, REF, TD shown; GS, GREF, GTD goals; FS, FREF, FTD where they started) */
    var S = new Float32Array(D * BINS), FS = new Float32Array(D * BINS), GS = new Float32Array(D * BINS);
    var REF = new Float32Array(D), FREF = new Float32Array(D), GREF = new Float32Array(D);
    var TD = new Float32Array(D), FTD = new Float32Array(D), GTD = new Float32Array(D);
    function goals() {
      for (var i = 0; i < D; i++) {
        var nAll = 0, hAll = 0;
        for (var b = 0; b < BINS; b++) { var n = cnt[i].n[b]; GS[i * BINS + b] = n ? cnt[i].h[b] / n : 0; nAll += n; hAll += cnt[i].h[b]; }
        /* the line every band is read against: the share among the futures that fit every other belief */
        GREF[i] = nAll ? hAll / nAll : BASE;
        GTD[i] = posOf(dims[i], dims[i].base);
      }
    }
    function settle() { S.set(GS); REF.set(GREF); TD.set(GTD); }
    function drawRow(r) {
      var g = r.ctx, w = r.w, h = r.h, top = 4, base = h - 1, i = r.i, B = bel[i], any = bel.some(Boolean);
      var ref = REF[i];
      var yOf = function (share) { return base - share * grow * (base - top); };
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (B) {
        g.fillStyle = C.acc; g.globalAlpha = 0.13;
        g.fillRect(B[0] * w, 0, (B[1] - B[0]) * w, h);
        g.globalAlpha = 1; g.fillRect(B[0] * w - 1, 0, 2, h); g.fillRect(B[1] * w - 1, 0, 2, h);
      }
      var bw = w / BINS;
      for (var b = 0; b < BINS; b++) {
        var n = cnt[i].n[b], s = S[i * BINS + b], x0 = b * bw + 1.5, x1 = (b + 1) * bw - 1.5;
        var mid = (b + 0.5) / BINS, on = !B || inside(mid, B), up = s >= ref;
        g.globalAlpha = on ? (up ? 1 : 0.55) : 0.25;
        if (n < FEW) {
          g.strokeStyle = up ? C.proof : C.mut; g.lineWidth = 1;
          if (n) g.strokeRect(x0 + 0.5, yOf(s) + 0.5, x1 - x0 - 1, base - yOf(s) - 0.5);
        } else {
          g.fillStyle = up ? C.proof : C.mut;
          g.fillRect(x0, yOf(s), x1 - x0, base - yOf(s));
        }
        g.globalAlpha = 1;
        if (any) {   /* this band before any belief */
          var a = cntAll[i], s0 = a.n[b] ? a.h[b] / a.n[b] : 0;
          g.fillStyle = C.ink; g.globalAlpha = 0.55;
          g.fillRect(x0, Math.round(yOf(s0)) - 0.5, x1 - x0, 1.5);
          g.globalAlpha = 1;
        }
      }
      /* the reference share, dotted */
      g.strokeStyle = C.strong; g.lineWidth = 1; g.setLineDash([2, 3]);
      g.beginPath(); g.moveTo(0, Math.round(yOf(ref)) + 0.5); g.lineTo(w, Math.round(yOf(ref)) + 0.5); g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.line; g.fillRect(0, base, w, 1);
      /* today */
      var xt = TD[i] * w;
      g.fillStyle = C.ink;
      g.beginPath(); g.moveTo(xt, base - 6); g.lineTo(xt - 4, base + 1); g.lineTo(xt + 4, base + 1); g.closePath(); g.fill();
    }

    /* the pile: every future that fits, stacked in columns by its return */
    var PITCH = 3, COLS = 0, PH = 0, PW = 0, PAD = 4, AXIS = 16;
    var cx = new Float32Array(N), cy = new Float32Array(N), ca = new Float32Array(N), hg = new Float32Array(N);
    var fx = new Float32Array(N), fy = new Float32Array(N), fa = new Float32Array(N), fhg = new Float32Array(N);
    var tx = new Float32Array(N), ty = new Float32Array(N), ta = new Float32Array(N);
    for (var k0 = 0; k0 < N; k0++) hg[k0] = HOLD[k0];
    function colOf(gv) { return Math.min(COLS - 1, Math.floor((gv - FLOOR) / (hiIRR - FLOOR) * COLS)); }
    function xOfIRR(gv) { return PAD + (gv - FLOOR) / (hiIRR - FLOOR) * (PW - 2 * PAD); }
    function layoutPile() {
      var wh = sizeCanvas(pile); PW = wh[0]; PH = wh[1];
      var room = PH - AXIS - 6;
      /* the largest pitch at which the full pile still fits */
      for (PITCH = 5; PITCH > 1.2; PITCH -= 0.1) {
        COLS = Math.floor((PW - 2 * PAD) / PITCH);
        var h = new Uint16Array(COLS), mx = 0;
        for (var k = 0; k < N; k++) { var c = colOf(G[k]); h[c]++; if (h[c] > mx) mx = h[c]; }
        if (mx * PITCH <= room) break;
      }
      COLS = Math.floor((PW - 2 * PAD) / PITCH);
    }
    function targets() {
      var h = new Uint16Array(COLS), floorY = PH - AXIS;
      for (var k = 0; k < N; k++) {
        var p = P[k], ok = true;
        for (var i = 0; i < D && ok; i++) if (bel[i] && !inside(p[i], bel[i])) ok = false;
        var c = colOf(G[k]);
        tx[k] = PAD + c * (PW - 2 * PAD) / COLS;
        if (ok) { ty[k] = floorY - (h[c] + 1) * PITCH; h[c]++; ta[k] = 1; }
        else { ta[k] = 0; }
      }
    }
    var ghost = null;
    function ghostCols() {
      ghost = new Uint16Array(COLS);
      for (var k = 0; k < N; k++) ghost[colOf(G[k])]++;
    }
    function drawPile() {
      var g = pctx, floorY = PH - AXIS, any = bel.some(Boolean);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, PW, PH);
      if (any) {   /* the pile before any belief */
        g.strokeStyle = C.mut; g.globalAlpha = 0.45; g.lineWidth = 1;
        g.beginPath(); g.moveTo(PAD, floorY);
        var cw = (PW - 2 * PAD) / COLS;
        for (var c = 0; c < COLS; c++) { var y = floorY - ghost[c] * PITCH; g.lineTo(PAD + c * cw, y); g.lineTo(PAD + (c + 1) * cw, y); }
        g.lineTo(PW - PAD, floorY); g.stroke(); g.globalAlpha = 1;
      }
      /* a dot that changes sides (a new target) cross-fades between the two colours */
      var s = Math.max(1, PITCH - 0.7);
      for (var pass = 0; pass < 2; pass++) {
        g.fillStyle = pass ? C.proof : C.mut;
        for (var k = 0; k < N; k++) {
          var wgt = pass ? hg[k] : (1 - hg[k]) * 0.7, al = ca[k] * wgt;
          if (al < 0.01) continue;
          g.globalAlpha = al;
          g.fillRect(cx[k], cy[k], s, s);
        }
      }
      g.globalAlpha = 1;
      /* the target, and the axis */
      var xt = Math.round(xOfIRR(T)) + 0.5;
      g.strokeStyle = C.ink; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(xt, 2); g.lineTo(xt, floorY + 3); g.stroke();
      g.fillStyle = C.line; g.fillRect(PAD, floorY, PW - 2 * PAD, 1);
      g.font = "10px " + C.mono; g.textBaseline = "top";
      g.fillStyle = C.mut; g.textAlign = "left";
      g.fillText(PW < 560 ? "≤" + FLOOR + "%" : M + " ≤" + FLOOR + "% or none", PAD, floorY + 4);
      g.textBaseline = "top"; g.fillStyle = C.mut;
      g.fillText(PW < 560 ? "one dot, one run" : "each dot is one run of the model, piled by its " + M, PAD, 2);
      g.textAlign = "center";
      for (var v = 0; v <= hiIRR - 10; v += 20) g.fillText(v + "%", xOfIRR(v), floorY + 4);
      g.textAlign = "right"; g.fillText(hiIRR + "%", PW - PAD, floorY + 4);
      g.fillStyle = C.ink; g.textAlign = "left"; g.font = "600 11px " + C.mono;
      g.fillText(T + "%", xt + 5, 2);
    }

    /* ---------- motion: one loop for the pile and the bars ---------- */
    var anim = null, bars = null, growAnim = null, raf = 0;
    function animate(ms, ease) {
      for (var k = 0; k < N; k++) { fx[k] = cx[k]; fy[k] = cy[k]; fa[k] = ca[k]; fhg[k] = hg[k]; }
      anim = { t0: performance.now(), ms: reduce ? 0 : ms, ease: ease };
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function settleBars(ms) {
      FS.set(S); FREF.set(REF); FTD.set(TD);
      bars = { t0: performance.now(), ms: reduce ? 0 : ms };
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function frame(now) {
      raf = 0;
      if (dead) return;
      var more = false, redraw = false;
      if (anim) {
        var q = anim.ms ? clamp((now - anim.t0) / anim.ms, 0, 1) : 1, e = anim.ease(q);
        for (var k = 0; k < N; k++) {
          cx[k] = fx[k] + (tx[k] - fx[k]) * e;
          cy[k] = ta[k] ? fy[k] + (ty[k] - fy[k]) * e : fy[k];
          ca[k] = fa[k] + (ta[k] - fa[k]) * (ta[k] ? e : Math.min(1, q * 2.5));
          hg[k] = fhg[k] + (HOLD[k] - fhg[k]) * e;
        }
        if (q < 1) more = true; else anim = null;
      }
      if (bars) {
        var qb = bars.ms ? clamp((now - bars.t0) / bars.ms, 0, 1) : 1, eb = easeOut(qb);
        for (var j = 0; j < S.length; j++) S[j] = FS[j] + (GS[j] - FS[j]) * eb;
        for (var i = 0; i < D; i++) { REF[i] = FREF[i] + (GREF[i] - FREF[i]) * eb; TD[i] = FTD[i] + (GTD[i] - FTD[i]) * easeMove(qb); }
        redraw = true;
        if (qb < 1) more = true; else bars = null;
      }
      if (growAnim) {
        var qg = growAnim.ms ? clamp((now - growAnim.t0) / growAnim.ms, 0, 1) : 1;
        grow = easeOut(qg);
        redraw = true;
        if (qg < 1) more = true; else growAnim = null;
      }
      if (redraw) rows.forEach(drawRow);
      drawPile();
      if (more) raf = requestAnimationFrame(frame);
    }

    /* ---------- changes ---------- */
    function changed(user) {
      recount();
      targets();
      goals();
      animate(DUR4, easeMove);
      settleBars(DUR3);
      rows.forEach(drawRow);   // the belief band answers the hand at once; the bars follow
      rows.forEach(function (r) {
        var B = bel[r.i];
        r.el.classList.toggle("on", !!B);
        r.cv.setAttribute("aria-label", r.name + ": " + (B ? "you believe " + rangeText(r.i) : "no belief") +
          ". Drag across to believe a range; Escape lets it go.");
      });
      if (api.onChange) api.onChange(state(), !!user);
    }
    function rangeText(i) {
      var d = dims[i], B = bel[i];
      if (!B) return "";
      var a = valOf(d, B[0]), b = valOf(d, B[1]), lo = Math.min(a, b), hi = Math.max(a, b);
      var atMin = lo <= d.min + 1e-9, atMax = hi >= d.max - 1e-9;
      if (atMax && !atMin) return fmtVal(d, lo) + " or more";
      if (atMin && !atMax) return fmtVal(d, hi) + " or less";
      return fmtVal(d, lo) + " to " + fmtVal(d, hi);
    }
    function state() {
      var b = {};
      bel.forEach(function (B, i) { if (B) b[dims[i].id] = { text: rangeText(i), name: rowOf[i].name }; });
      return { total: N, base: BASE, held: held, fit: last.fit, hold: last.hold, odds: last.odds, beliefs: b };
    }
    var touched = false;
    function user() { if (!touched) { touched = true; if (api.onUser) api.onUser(); } }

    /* ---------- the user: drag across a row, tap a band again to let it go ---------- */
    rows.forEach(function (r) {
      var drag = null;
      function placeAt(e) { var b = r.cv.getBoundingClientRect(); return clamp((e.clientX - b.left) / b.width, 0, 0.99999); }
      r.cv.addEventListener("pointerdown", function (e) {
        user();
        var p = placeAt(e), B = bel[r.i], tol = 9 / Math.max(1, r.w), anchor = binOf(p);
        if (B && Math.abs(p - B[0]) < tol) anchor = binOf(B[1] - 1e-6);
        else if (B && Math.abs(p - B[1]) < tol) anchor = binOf(B[0] + 1e-6);
        drag = { anchor: anchor, x: e.clientX, moved: false, tap: B && inside(p, B), had: !!B };
        r.cv.setPointerCapture(e.pointerId);
      });
      r.cv.addEventListener("pointermove", function (e) {
        if (!drag) return;
        if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
        if (!drag.moved) return;
        var b = binOf(placeAt(e)), lo = Math.min(drag.anchor, b), hi = Math.max(drag.anchor, b);
        var nb = [lo / BINS, (hi + 1) / BINS], B = bel[r.i];
        if (!B || B[0] !== nb[0] || B[1] !== nb[1]) { bel[r.i] = nb; changed(true); }
      });
      function end(e) {
        if (!drag) return;
        if (!drag.moved && e.type === "pointerup") {
          var b = binOf(placeAt(e));
          bel[r.i] = drag.tap ? null : [b / BINS, (b + 1) / BINS];
          changed(true);
        }
        drag = null;
      }
      r.cv.addEventListener("pointerup", end);
      r.cv.addEventListener("pointercancel", end);
      /* keys: left widens the belief from the better end, right narrows it, Escape lets it go */
      r.cv.addEventListener("keydown", function (e) {
        var B = bel[r.i], k = B ? Math.round(B[0] * BINS) : BINS;
        if (e.key === "ArrowLeft") k = Math.max(0, k - 1);
        else if (e.key === "ArrowRight") k = Math.min(BINS, k + 1);
        else if (e.key === "Escape" || e.key === "Backspace") k = BINS;
        else return;
        e.preventDefault(); user();
        bel[r.i] = k >= BINS ? null : [k / BINS, 1];
        changed(true);
      });
    });

    function layout() {
      dpr = devicePixelRatio || 1;
      colors();
      layoutPile(); ghostCols(); targets();
      for (var k = 0; k < N; k++) { cx[k] = tx[k]; if (ta[k] && played) cy[k] = ty[k]; }
      rows.forEach(function (r) { var wh = sizeCanvas(r.cv); r.w = wh[0]; r.h = wh[1]; drawRow(r); });
      drawPile();
    }
    var played = false;
    recount(); goals(); settle();
    layout();
    var dead = false, ro = new ResizeObserver(function () { if (!dead) layout(); });
    ro.observe(root);

    api.set = function (id, range) {
      var i = dims.findIndex(function (d) { return d.id === id; });
      if (i < 0) return;
      bel[i] = range ? toPlaces(dims[i], range) : null;
      changed(false);
    };
    api.clear = function () { bel = new Array(D).fill(null); changed(false); };
    api.state = state;
    /* the odds for a set of beliefs, counted without showing them */
    api.oddsFor = function (spec) {
      var b = new Array(D).fill(null);
      Object.keys(spec).forEach(function (id) {
        var i = dims.findIndex(function (d) { return d.id === id; });
        if (i >= 0) b[i] = toPlaces(dims[i], spec[id]);
      });
      return count(b);
    };
    /* the futures pour into the pile and the bars rise */
    api.play = function () {
      if (played) return;
      played = true;
      targets();
      for (var k = 0; k < N; k++) { cx[k] = tx[k]; cy[k] = ty[k] - PH - Math.random() * PH * 1.5; ca[k] = 0; }
      animate(BEAT, easeOut);
      growAnim = { t0: performance.now() + (reduce ? 0 : DUR3), ms: reduce ? 0 : DUR4 };
      if (!raf) raf = requestAnimationFrame(frame);
    };
    /* another view of the same runs (whose return, its target): every dot moves from where it is to its new place
       and colour, the bars and today's marks settle; the beliefs are let go, because "better" may have changed ends */
    api.view = function (v) {
      load(v);
      bel = new Array(D).fill(null);
      labelRows();
      layoutPile(); ghostCols();
      changed(false);
    };
    /* a board can be taken down */
    api.destroy = function () { dead = true; ro.disconnect(); if (raf) cancelAnimationFrame(raf); raf = 0; colsHost.innerHTML = ""; };
    api.fmt = function (id, v) { var d = dims.find(function (x) { return x.id === id; }); return fmtVal(d, v); };
    return api;
  }

  window.OddsBoard = { mount: mount };
})();
