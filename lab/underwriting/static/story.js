/* The story page (/). Three sticky stages draw the same workbook map with
   WebGL: 52,148 formula cells at their real row and column. The reader's
   scroll is the clock: each stage maps its scroll position to a time t
   (step index + progress through that step) and draws the state at t. The
   blocks between stages (proof, asking backwards) are ordinary figures.
   Every number drawn comes from web/story/*.json, written by
   scripts/build_story_data.py; the page does no financial arithmetic.

   Motion runs on site.css's clock (--dur-*, --beat), read here so a figure
   and its CSS move together. Whatever will be written later already has its
   room, so nothing moves when an answer lands or a readout changes. */
(async function () {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);   // --ease-move
  const outCubic = (x) => 1 - Math.pow(1 - x, 3);                                   // the runs come in
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpBox = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const pct = (v, d = 1) => (v * 100).toFixed(d) + "%";
  const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + " " + r.status); return r.json(); });
  // the motion tokens, in ms (reduced motion shortens them in site.css)
  const tok = (name, fb) => { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(), n = parseFloat(v);
    return isNaN(n) ? fb : /ms$/.test(v) ? n : n * 1000; };
  const DUR3 = tok("--dur-3", 360), DUR4 = tok("--dur-4", 720), BEAT = tok("--beat", 1300);
  const COUNT = 1800;   // one cadence for "the runs come in", in every beat

  const [map, signoff, rev, ctxData, lender, lterms, opData, stress] = await Promise.all([
    json("/static/story/map.json"), json("/static/story/signoff.json"), json("/static/story/reverse.json"), json("/static/story/context.json"),
    json("/static/story/lender.json"), json("/static/story/lender_terms.json"), json("/static/story/operator.json"),
    json("/static/story/stress.json"),
  ]);
  await Promise.all([document.fonts.load("400 76px Newsreader"), document.fonts.load("400 12px 'IBM Plex Mono'")]).catch(() => {});
  await document.fonts.ready;

  /* ---------- numbers in the copy that come straight from the data ---------- */
  const colName = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const sheetOf = Object.fromEntries(map.sheets.map((s) => [s.name, s]));
  const addr = (cell) => { const s = sheetOf[cell[0]]; return `${cell[0]}!${colName(cell[2] + s.c0)}${cell[1] + s.r0}`; };
  $$('[data-k="l1"]').forEach((el) => (el.textContent = addr(map.chain[1])));
  $$('[data-k="l2"]').forEach((el) => (el.textContent = fmt(map.cone.per_click[1])));
  const perScenario = rev.engine_seconds_per_scenario.toFixed(2) + " s";
  // the hero's answer: the most you can pay and keep LP IRR at 15%, from the same 101 runs as beat 1
  {
    const pts = rev.scan.points, last = pts.reduce((k, p, i) => (p[1] != null && p[1] >= 0.15 ? i : k), -1);
    if (last >= 0) $("#heroPay").innerHTML = "$" + (pts[last][0] / 1e6).toFixed(1) + "<small>M</small>";
    $("#heroPayK").textContent = `${pts.length} runs, ${Math.round(rev.scan.seconds)} s`;
  }
  // a link to the sources opens them, so the proof never points at a closed box; the page glides there
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href="#sources"]'); if (!a) return;
    const d = $("#sources"); d.open = true;
    if (!reduce) { e.preventDefault(); d.scrollIntoView({ behavior: "smooth", block: "start" }); history.replaceState(null, "", "#sources"); }
  });
  $("#leadRuns").textContent = `${rev.scan.points.length} runs in ${Math.round(rev.scan.seconds)} seconds`;
  const SD = signoff.design, WORD = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  $("#dPts").textContent = fmt(SD.point_runs); $("#dIn").textContent = fmt(SD.inputs); $("#dMix").textContent = fmt(SD.mixed_runs);
  $("#dMov").textContent = `${WORD[SD.moved[0]] || SD.moved[0]} to ${WORD[SD.moved[1]] || SD.moved[1]}`;
  $("#dLev").textContent = fmt(SD.lever_runs);
  document.body.classList.add("focus");
  $("#slotSec").textContent = perScenario + " a scenario";
  if (rev.engine) $("#srcEngine").textContent = "engine " + rev.engine;
  // the turn answers the paper's question with a real run: 90% occupancy, today's exit cap
  {
    if (rev.ladder && rev.ladder.gp_irr != null) { $("#payA").textContent = pct(rev.ladder.gp_irr); $("#payB").textContent = pct(rev.base.gp_irr); }
    $("#payS").textContent = perScenario;
  }
  // the map that comes with the model: three cells as Excel shows them, and as the model names them
  {
    const unitWord = (u) => (/percent/.test(u || "") ? "a percent" : u || "a number");
    const xlNum = (v) => (typeof v === "number" ? (+v.toPrecision(6)).toString() : String(v));
    $("#ctx").innerHTML = ctxData.rows.map((r) => `<div class="ctx-r"><div class="xl"><span class="tag">Excel</span><code>${r.cell}</code><b>${xlNum(r.excel)}</b></div>` +
      `<div class="me"><span class="tag">Model</span><b>${r.label}</b><em>${pct(r.value)}</em><small>${r.kind === "output"
        ? `output · ${fmt(r.behind)} formulas behind it`
        : `input · ${unitWord(r.unit)} · feeds ${fmt(r.feeds)} formulas`}</small></div></div>`).join("");
    $("#ctxKB").textContent = Math.round(ctxData.map_gzip_bytes / 1000) + " KB";
    $("#ctxIn").textContent = fmt(ctxData.inputs_named);
    $("#ctxOut").textContent = fmt(ctxData.outputs_named);
  }
  const ctxRows = $$("#ctx .ctx-r");

  /* ---------- room for what will be written later ----------
     An element whose words change (an answer that lands, a readout under the pointer, a caption that follows a
     chip) is measured with the longest things it can say and keeps that height, so nothing beside or below it moves. */
  const reserves = [];
  const reserve = (el, list, opt = {}) => {
    if (!el) return;
    const into = opt.into || el, html = !!opt.html;
    const cands = [...new Set(list.filter((s) => s != null))].sort((a, b) => b.length - a.length).slice(0, opt.n || 6);
    const run = () => {
      const keep = html ? into.innerHTML : into.textContent;
      el.style.minHeight = "";
      let h = 0;
      for (const s of cands) { if (html) into.innerHTML = s; else into.textContent = s; h = Math.max(h, el.getBoundingClientRect().height); }
      if (html) into.innerHTML = keep; else into.textContent = keep;
      if (h) el.style.minHeight = Math.ceil(h) + "px";
    };
    reserves.push(run); run();
  };
  let rsv = 0; addEventListener("resize", () => { clearTimeout(rsv); rsv = setTimeout(() => reserves.forEach((f) => f()), 160); });

  /* ---------- the workbook: every formula cell ---------- */
  const names = map.sheets.map((s) => s.name);
  const N = map.formulas;
  const SH = new Uint8Array(N), R = new Uint16Array(N), Cc = new Uint16Array(N), LEV = new Uint8Array(N), RD = new Float32Array(N);
  const rowsOf = [];                       // per sheet: [[first cell, count], ...] per formula row
  {
    let k = 0;
    map.sheets.forEach((s, si) => {
      const rows = [];
      const lev = []; for (let i = 0; i < s.lev.length; i += 2) for (let n = 0; n < s.lev[i + 1]; n++) lev.push(s.lev[i]);
      let li = 0;
      s.spans.forEach((row) => {
        const start = k;
        for (let i = 1; i < row.length; i += 2) for (let c = row[i]; c < row[i] + row[i + 1]; c++) { SH[k] = si; R[k] = row[0]; Cc[k] = c; LEV[k] = lev[li++]; k++; }
        rows.push([start, k - start]);
      });
      rowsOf.push(rows);
    });
  }
  // characters read so far at the end of each formula row, in the workbook's own tab order
  const TOTAL = map.chars;
  const order = [];
  { let acc = 0;
    map.tabs.forEach((t) => {
      const si = names.indexOf(t); if (si < 0) return;
      rowsOf[si].forEach(([start, n], ri) => {
        acc += map.sheets[si].chars[ri];
        for (let i = start; i < start + n; i++) { RD[i] = acc / TOTAL; order.push(i); }
      });
    });
  }
  // GP IRR is drawn last so its enlarged dot sits on top
  const swap = (a, b) => { for (const A of [SH, R, Cc, LEV, RD]) { const x = A[a]; A[a] = A[b]; A[b] = x; } };
  const gpAt = LEV.indexOf(16), iGP = N - 1;
  swap(gpAt, iGP);
  for (let j = 0; j < order.length; j++) { if (order[j] === iGP) order[j] = gpAt; else if (order[j] === gpAt) order[j] = iGP; }
  const iL1 = LEV.indexOf(1);
  const L2 = []; for (let i = 0; i < N; i++) if (LEV[i] === 2) L2.push(i);
  const RC = Math.ceil(Math.sqrt(N)), RR = Math.ceil(N / RC);
  const aRect = new Float32Array(N * 2), aMeta = new Float32Array(N * 4);
  let seed = 20260715; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  order.forEach((i, j) => { aRect[2 * i] = ((j % RC) + 0.5) / RC; aRect[2 * i + 1] = (Math.floor(j / RC) + 0.5) / RR; });
  for (let i = 0; i < N; i++) { aMeta[4 * i] = LEV[i]; aMeta[4 * i + 1] = RD[i]; aMeta[4 * i + 2] = rnd(); aMeta[4 * i + 3] = rnd(); }
  const l2rand = L2.map(() => rnd());
  const cum = [1]; const sheetsAt = [1];
  { const per = map.cone.per_click; let n = 1; const touched = new Set([names[SH[iGP]]]);
    for (let h = 1; h <= per.length; h++) {
      n += per[h - 1]; cum.push(n);
      for (let i = 0; i < N; i++) if (LEV[i] === h) touched.add(names[SH[i]]);
      sheetsAt.push(touched.size);
    } }
  const CLICKS = map.cone.clicks;

  /* ---------- colours from the CSS tokens ---------- */
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const rgb = (v) => { probe.clearRect(0, 0, 2, 2); probe.fillStyle = "#000"; probe.fillStyle = cssVar(v); probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255]; };
  let COL = {};
  const readColours = () => { COL = { dim: rgb("--line"), ink: rgb("--ink"), acc: rgb("--accent"), accD: rgb("--accent-dark"), proof: rgb("--proof"), err: rgb("--error"), blue: cssVar("--blue") }; };
  readColours();

  /* ---------- WebGL: one draw call, every formula cell ---------- */
  const VS = `
  precision highp float;
  attribute vec2 aMap; attribute vec2 aGlyph; attribute vec2 aRect; attribute vec4 aMeta;
  uniform vec2 uRes; uniform float uDpr;
  uniform float uFly, uGlyphA, uRead, uCap, uReadOn, uLevel, uTraceOn, uCompile, uLit, uDim, uCell, uRectCell;
  uniform vec4 uBox;
  uniform vec3 cDim, cInk, cAcc, cAccD, cProof, cErr;
  varying vec4 vCol;
  float stag(float p, float r, float s) { return clamp((p - r * s) / (1.0 - s), 0.0, 1.0); }
  float eio(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) / 2.0; }
  void main() {
    float lev = aMeta.x, rd = aMeta.y, rn = aMeta.z, rn2 = aMeta.w;
    float f = eio(stag(uFly, rn, 0.5));
    vec2 d = aMap - aGlyph;
    vec2 p = aGlyph + d * f + vec2(-d.y, d.x) * 0.22 * sin(3.14159 * f) * (rn2 - 0.5);
    float k = eio(stag(uCompile, rn2, 0.4));
    p = mix(p, uBox.xy + aRect * uBox.zw, k);
    float size = mix(mix(1.4, uCell, f), uRectCell, k);
    vec3 col = mix(cInk, cDim, f);
    float a = mix(uGlyphA, 1.0, f);
    float isRead = 1.0 - step(uRead + 1e-7, rd);
    col = mix(col, mix(cInk, cErr, step(uCap, rd)), uReadOn * isRead);
    if (lev > 15.5) {
      col = mix(col, cAcc, uTraceOn);
      size = mix(size, max(uCell * 2.8, 4.5), uTraceOn * (1.0 - k));
    } else if (lev > 0.5) {
      float on = clamp(uLevel - lev + 1.0, 0.0, 1.0);
      float fresh = clamp(1.0 - (uLevel - lev), 0.0, 1.0);
      col = mix(col, mix(mix(cAcc, cDim, 0.38), cAcc, fresh), uTraceOn * on);
    }
    col = mix(col, cInk, k);
    col = mix(col, cProof, uLit);
    a *= mix(1.0, 0.16, uDim);
    float px = size * uDpr;
    a *= clamp(px * px, 0.22, 1.0);
    gl_PointSize = max(px, 1.0);
    vec2 c = p / uRes * 2.0 - 1.0;
    gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
    vCol = vec4(col * a, a);
  }`;
  const FS = "precision mediump float; varying vec4 vCol; void main() { gl_FragColor = vCol; }";
  function makeGL(canvas) {
    let gl = null;
    try { gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true }); } catch (e) { gl = null; }
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    const buf = (name, data, size, usage) => {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const loc = gl.getAttribLocation(prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const bufs = { map: buf("aMap", new Float32Array(N * 2), 2, gl.DYNAMIC_DRAW), glyph: buf("aGlyph", new Float32Array(N * 2), 2, gl.DYNAMIC_DRAW) };
    buf("aRect", aRect, 2, gl.STATIC_DRAW); buf("aMeta", aMeta, 4, gl.STATIC_DRAW);
    const U = {};
    for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) { const u = gl.getActiveUniform(prog, i); U[u.name] = gl.getUniformLocation(prog, u.name); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return { gl, bufs, U };
  }

  /* ---------- layout ---------- */
  const isMobile = () => innerWidth < 860;
  const SMALL = ["Print Summary", "Checks & Audit", "Assumptions"];
  function regionOf(W, H) {
    if (isMobile()) return { x: 14, y: 26, w: W - 28, h: H - 26 - 96 };
    // the card sits on the site frame's content edge (site.css), read off the hero's frame
    const frame = document.querySelector(".top .site-frame");
    const cardLeft = frame.getBoundingClientRect().left + parseFloat(getComputedStyle(frame).paddingLeft), cardW = Math.min(390, W * 0.34);
    const x = cardLeft + cardW + 56, right = W - Math.max(28, cardLeft);
    return { x, y: 70, w: right - x, h: H - 70 - 160 };
  }
  function layoutMap(box) {
    const m = isMobile(), S = sheetOf, lab = m ? 14 : 20, gapR = m ? 8 : 14, gapC = m ? 10 : 22, smallGap = m ? 8 : 14;
    const lc = Math.max(S["Cash Flow"].cols, S["Capex & Debt"].cols), rc = S["Ops & Staffing"].cols;
    const smallRows = Math.max(...SMALL.map((n) => S[n].rows));
    const rowsL = S["Cash Flow"].rows + S["Capex & Debt"].rows, rowsR = S["Ops & Staffing"].rows + smallRows;
    const s = Math.min((box.w - gapC) / (lc + rc), (box.h - 2 * lab - gapR) / Math.max(rowsL, rowsR));
    const cw = (lc + rc) * s + gapC, chh = Math.max(rowsL, rowsR) * s + 2 * lab + gapR;
    const ox = box.x + (box.w - cw) / 2, oy = box.y + (box.h - chh) / 2;
    const B = {};
    B["Cash Flow"] = { x: ox, y: oy + lab };
    B["Capex & Debt"] = { x: ox, y: oy + lab + S["Cash Flow"].rows * s + gapR + lab };
    const xr = ox + lc * s + gapC;
    B["Ops & Staffing"] = { x: xr, y: oy + lab };
    const smallW = Math.min(m ? 26 : 104, (rc * s - 2 * smallGap) / 3);
    let xs = xr; const ys = oy + lab + S["Ops & Staffing"].rows * s + gapR + lab;
    SMALL.forEach((n) => { B[n] = { x: xs, y: ys, small: true }; xs += Math.max(S[n].cols * s, smallW) + smallGap; });
    return { s, B, lab, showSmall: smallW >= 90 };
  }
  const shared = { W: 0, H: 0 };
  function measureShared(stage) {
    const r = stage.getBoundingClientRect();
    if (!r.width) return false;
    if (shared.W === r.width && shared.H === r.height && shared.pos) return true;
    shared.W = r.width; shared.H = r.height; shared.dpr = Math.min(2, devicePixelRatio || 1);
    const reg = shared.region = regionOf(r.width, r.height);
    const L = shared.L = layoutMap(reg);
    const pos = shared.pos = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { const b = L.B[names[SH[i]]]; pos[2 * i] = b.x + (Cc[i] + 0.5) * L.s; pos[2 * i + 1] = b.y + (R[i] + 0.5) * L.s; }
    // the compiled block and the 48 KB chip, drawn to scale (1,234,933 bytes -> 48,485)
    const m = isMobile();
    const G = Math.round(Math.min(reg.h * (m ? 0.92 : 0.74), reg.w * (m ? 0.44 : 0.42)));
    const y = reg.y + (reg.h - G) / 2;
    shared.boxC = { x: reg.x + (reg.w - G) / 2, y, w: G, h: G };
    shared.boxG = { x: reg.x, y, w: G, h: G };
    const c = G * Math.sqrt(MODEL_BYTES / BOOK_BYTES);
    shared.chip = c;
    shared.boxChip = { x: reg.x, y: y + G - c, w: c, h: c };
    shared.boxMid = { x: reg.x + (reg.w - c) / 2, y: reg.y + (reg.h - c) / 2, w: c, h: c };
    shared.v = (shared.v || 0) + 1;
    return true;
  }

  // the dots start as the glyphs of "52,148" in the hero, exactly where the text is drawn
  const hero = $(".hero"), heroN = $("#heroN");
  function glyphPositions(stageRect) {
    hero.style.setProperty("--lift", "0px");
    const r = heroN.getBoundingClientRect(), cs = getComputedStyle(heroN);
    const out = new Float32Array(N * 2);
    if (!r.width) { out.set(shared.pos); return out; }
    const w = Math.ceil(r.width) + 2, h = Math.ceil(r.height) + 2;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const mt = g.measureText(heroN.textContent), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize);
    g.fillText(heroN.textContent, 0, (lh - (mt.fontBoundingBoxAscent + mt.fontBoundingBoxDescent)) / 2 + mt.fontBoundingBoxAscent);
    const px = g.getImageData(0, 0, w, h).data, pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 110) pts.push(x, y);
    if (!pts.length) { out.set(shared.pos); return out; }
    const ox = r.left - stageRect.left, oy = r.top - stageRect.top, M = pts.length / 2;
    let s2 = 99; const rr = () => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) { const j = Math.floor(rr() * M); out[2 * i] = ox + pts[2 * j] + rr(); out[2 * i + 1] = oy + pts[2 * j + 1] + rr(); }
    return out;
  }

  /* ---------- chapters ---------- */
  function chapter(id, render, place) {
    const root = document.getElementById(id);
    const steps = $$(".step", root);
    return { id, root, render, place, rest: root.dataset.rest.split(",").map(Number), stage: $(".stage", root),
      steps, labels: $(".labels", root), canvas: $("canvas.gl", root), arrows: $("canvas.arrows", root),
      lastCard: $(".card", steps[steps.length - 1]),
      shown: 0, target: 0, drawn: -1, dirty: true, G: null, v: -1, off: [0], len: [1] };
  }
  const A = chapter("chA", renderA, placeA), Cch = chapter("chC", renderC, placeC), D = chapter("chD", renderD, null);
  const CH = [A, Cch, D];

  function measure(ch) {
    if (!measureShared(ch.stage)) return;
    const r = ch.stage.getBoundingClientRect(), m = isMobile();
    if (!ch.G && !ch.glTried) { ch.G = makeGL(ch.canvas); ch.glTried = true; }
    ch.canvas.width = Math.round(shared.W * shared.dpr); ch.canvas.height = Math.round(shared.H * shared.dpr);
    if (ch.arrows) { ch.arrows.width = ch.canvas.width; ch.arrows.height = ch.canvas.height; ch.ctx = ch.arrows.getContext("2d"); }
    if (ch.G) {
      const { gl, bufs } = ch.G;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.map); gl.bufferSubData(gl.ARRAY_BUFFER, 0, shared.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.glyph); gl.bufferSubData(gl.ARRAY_BUFFER, 0, ch === A ? glyphPositions(r) : shared.pos);
    }
    if (ch.labels) placeLabels(ch);
    const reg = shared.region;
    const hudBox = m ? { x: 14, y: shared.H - 90, w: shared.W - 28 } : { x: reg.x, y: reg.y + reg.h + 26, w: reg.w };
    $$(".hud", ch.root).forEach((h) => { h.style.left = hudBox.x + "px"; h.style.top = hudBox.y + "px"; h.style.width = hudBox.w + "px"; });
    if (ch.place) ch.place(ch);
    ch.off = ch.steps.map((s) => s.offsetTop - ch.steps[0].offsetTop);
    ch.len = ch.steps.map((s) => s.offsetHeight);
    const last = ch.len.length - 1;
    ch.len[last] = Math.max(ch.len[last] - (m ? shared.H * 0.6 : innerHeight), innerHeight * 0.5);
    if (ch.lastCard) { ch.lastCard.style.transform = ""; ch.lastCard._ty = ""; ch.cardTop = parseFloat(getComputedStyle(ch.lastCard).top) || 0; ch.cardH = ch.lastCard.offsetHeight; }
    ch.v = shared.v; ch.dirty = true;
  }
  function placeLabels(ch) {
    const L = shared.L, pos = shared.pos, m = isMobile();
    ch.labels.innerHTML = "";
    names.forEach((n) => {
      const b = L.B[n];
      if (b.small && !L.showSmall) return;
      const d = document.createElement("div"); d.className = "lab";
      d.textContent = b.small || m ? n : `${n} · ${fmt(sheetOf[n].n)}`;
      d.style.left = b.x + "px"; d.style.top = (b.y - L.lab + (m ? 1 : 4)) + "px";
      ch.labels.appendChild(d);
    });
    const gx = pos[2 * iGP], gy = pos[2 * iGP + 1];
    ch.ring = document.createElement("div"); ch.ring.className = "ring"; ch.ring.style.left = gx + "px"; ch.ring.style.top = gy + "px";
    ch.gplab = document.createElement("div"); ch.gplab.className = "gplab"; ch.gplab.textContent = "GP IRR";
    ch.gplab.style.left = (gx + 14) + "px"; ch.gplab.style.top = (gy - 6) + "px";
    ch.labels.append(ch.ring, ch.gplab);
    ch.labelEls = $$(".lab", ch.labels);
  }

  /* chapter A overlay: the paper sits over the dimmed map */
  const paper = $("#paper");
  function placeA() {
    const reg = shared.region, m = isMobile();
    const pw = m ? reg.w : Math.min(460, reg.w * 0.72);
    Object.assign(paper.style, { left: (reg.x + (reg.w - pw) / 2) + "px", top: (m ? 18 : reg.y + 30) + "px", width: pw + "px" });
  }
  /* chapter C overlays: the workbook outline, the chip's label, what the model knows, three places it runs, the next models */
  // the workbook and the compiled model, in bytes
  const BOOK_BYTES = 1234933, MODEL_BYTES = 48485;
  function placeC() {
    const m = isMobile(), reg = shared.region, G = shared.boxG, c = shared.chip;
    Object.assign($("#ghost").style, { left: G.x + "px", top: G.y + "px", width: G.w + "px", height: G.h + "px" });
    const lab = $("#chipLab"); lab.style.left = (G.x + c + (m ? 8 : 14)) + "px"; lab.style.top = (G.y + G.h - (m ? 40 : 52)) + "px";
    // four places it goes: a server, a skill, a browser tab, and back into Excel
    const x0 = G.x + G.w + (m ? 14 : 52), sw = reg.x + reg.w - x0, gap = m ? 5 : 12, sh = (G.h - 3 * gap) / 4;
    const fh = Math.min(sh, m ? 38 : 70), fw = Math.round(fh * 1.25);
    [0, 1, 2, 3].forEach((i) => {
      const el = $("#slot" + i);
      Object.assign(el.style, { left: x0 + "px", top: (G.y + i * (sh + gap) + (sh - fh) / 2) + "px", width: sw + "px", height: fh + "px" });
      const fr = $(".frame", el); fr.style.width = fw + "px"; fr.style.height = fh + "px";
      const top = i === 2 ? 15 : i === 3 ? 16 : 6, ws = Math.min(fh - top - (i === 0 ? 18 : 10), fw - 14);
      Object.assign($(".well", el).style, { left: (fw - ws) / 2 - 1.5 + "px", top: top + "px", width: ws + "px", height: ws + "px" });
      $$(".u", el).forEach((u, k) => { u.style.top = (fh - 18 + k * 5) + "px"; });
      $$(".ln", el).forEach((u, k) => { u.style.top = (fh - 14 + k * 5) + "px"; u.style.right = (8 + k * 12) + "px"; });
    });
    const sz = $("#sizes");
    Object.assign(sz.style, { left: reg.x + "px", top: (m ? Math.max(6, reg.y - 10) : G.y) + "px", width: reg.w + "px" });
    { const st0 = Cch.stage.getBoundingClientRect(), r0 = $("#sizes .sz-chips i").getBoundingClientRect();
      Cch.sizeChip = { x: r0.left - st0.left, y: r0.top - st0.top, w: r0.width, h: r0.height }; }
    const cx = $("#ctx");
    if (m) Object.assign(cx.style, { left: reg.x + "px", top: Math.max(6, reg.y - 16) + "px", width: reg.w + "px" });
    else Object.assign(cx.style, { left: x0 + "px", top: (G.y - 6) + "px", width: sw + "px" });
    // every side of the deal: four model cards at the corners, one shared name in the middle
    const sd = $("#sides"), cx0 = reg.x + reg.w / 2, cy0 = reg.y + reg.h / 2 + (m ? 10 : -10);
    let dyM = 0;
    const dx = m ? reg.w * 0.29 : Math.min(reg.w * 0.34, 250);
    const hubH = $(".hub", sd).offsetHeight, cardH = $(".mcard", sd).offsetHeight;
    // on a phone the rows of cards sit just clear of the shared name
    if (m) dyM = cardH / 2 + hubH / 2 + 12;
    const dy = m ? dyM : Math.min(reg.h * 0.31, 150);
    const at = { buyer: [cx0 - dx, cy0 - dy], broker: [cx0 + dx, cy0 - dy], seller: [cx0 - dx, cy0 + dy], lender: [cx0 + dx, cy0 + dy] };
    const st0 = Cch.stage.getBoundingClientRect(), lines = [];
    $$(".mcard", sd).forEach((el) => {
      const [x, y] = at[el.dataset.side], w = el.offsetWidth, h = el.offsetHeight, left = x - w / 2, top = y - h / 2;
      el.style.left = left + "px"; el.style.top = top + "px";
      // one thread per row, from the card's edge nearest the middle, at that row's height
      const ex = x < cx0 ? left + w : left;
      $$(".mc-rows li", el).forEach((li, j) => {
        const ry = top + li.offsetTop + $(".mc-rows", el).offsetTop + li.offsetHeight / 2;
        lines.push(`<line class="row j${j}" style="--j:${j}" pathLength="1" x1="${ex}" y1="${ry}" x2="${cx0}" y2="${cy0}"/>`);
      });
    });
    const hub = $(".hub", sd); hub.style.left = (cx0 - hub.offsetWidth / 2) + "px"; hub.style.top = (cy0 - hub.offsetHeight / 2) + "px";
    $(".threads", sd).innerHTML = lines.join("");
    const st = Cch.stage.getBoundingClientRect();
    Cch.wells = [0, 1, 2, 3].map((i) => { const w = $("#slot" + i + " .well").getBoundingClientRect(); return { x: w.left - st.left, y: w.top - st.top, s: w.width }; });
    // the story's own model is the buyer's: the chip flies into that card's mark
    { const ic = $('.mcard[data-side="buyer"] .mc-ico', sd), r0 = ic.getBoundingClientRect(), sc = 1.1 - 0.1;   // the card's resting scale is 1
      Cch.boxNext = { x: r0.left - st0.left, y: r0.top - st0.top, w: r0.width / sc, h: r0.height / sc }; }
  }

  /* ---------- scroll -> t ---------- */
  // before a chapter's stage pins, t runs below 0 (the last chapter uses that to hold its chip until it arrives)
  function target(ch) {
    const d = -ch.root.getBoundingClientRect().top;
    let t = d < ch.off[0] ? Math.max(-1, (d - ch.off[0]) / ch.len[0]) : 0;
    for (let i = 0; i < ch.off.length; i++) if (d >= ch.off[i]) t = i + clamp((d - ch.off[i]) / ch.len[i]);
    if (reduce) t = ch.rest[clamp(Math.floor(t), 0, ch.rest.length - 1)];
    return t;
  }

  /* ---------- drawing ---------- */
  function draw(ch, u) {
    if (!ch.G) return;
    const { gl, U } = ch.G;
    gl.viewport(0, 0, ch.canvas.width, ch.canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uRes, shared.W, shared.H); gl.uniform1f(U.uDpr, shared.dpr);
    for (const k of ["uFly", "uGlyphA", "uRead", "uCap", "uReadOn", "uLevel", "uTraceOn", "uCompile", "uLit", "uDim", "uCell", "uRectCell"]) gl.uniform1f(U[k], u[k] ?? 0);
    const b = u.uBox || shared.boxC; gl.uniform4f(U.uBox, b.x, b.y, b.w, b.h);
    gl.uniform3fv(U.cDim, COL.dim); gl.uniform3fv(U.cInk, COL.ink); gl.uniform3fv(U.cAcc, COL.acc); gl.uniform3fv(U.cAccD, COL.accD);
    gl.uniform3fv(U.cProof, COL.proof); gl.uniform3fv(U.cErr, COL.err);
    gl.drawArrays(gl.POINTS, 0, N);
  }
  const setOp = (el, v) => { if (!el) return; const s = v.toFixed(3); if (el._op !== s) { el.style.opacity = s; el._op = s; } };
  const setText = (el, s) => { if (el._tx !== s) { el.textContent = s; el._tx = s; } };
  const setHTML = (el, s) => { if (el._h !== s) { el.innerHTML = s; el._h = s; } };
  const clicks = (x, n) => { const L = x * n, i = Math.floor(L); return i >= n ? n : i + eio(clamp((L - i) / 0.5)); };
  // a passage that plays on the clock once the reader reaches it, and plays back the same way if they scroll
  // back above it, so no reader stops on a half-finished one and none snaps
  const plays = {};
  const playFor = (ch, key, on, ms) => {
    const now = performance.now(), p = plays[key] || (plays[key] = { k: 0, at: now });
    const dt = Math.min(64, now - p.at), goal = on ? 1 : 0; p.at = now;
    if (reduce) p.k = goal;
    else if (p.k !== goal) p.k = clamp(p.k + Math.sign(goal - p.k) * dt / ms);
    if (p.k !== goal) ch.dirty = true;
    return p.k;
  };

  const E = { hudTrace: $("#hudTrace"), trN: $("#trN"), trSmall: $("#trSmall"), trSub: $("#trSub"),
    hudBytes: $("#hudBytes"), byN: $("#byN"), sizes: $("#sizes"), hudKeep: $("#hudKeep"), ghost: $("#ghost"), chipLab: $("#chipLab"),
    slots: [0, 1, 2, 3].map((i) => $("#slot" + i)), copies: [0, 1, 2, 3].map((i) => $("#copy" + i)), sides: $("#sides"),
    ctx: $("#ctx"), hudCtx: $("#hudCtx") };
  E.sizeRows = $$("#sizes .sz-row").map((row) => {
    const n = Math.floor(+row.dataset.bytes / MODEL_BYTES), host = $(".sz-chips", row);
    host.innerHTML = "<i></i>".repeat(n);
    return { n, chips: $$("i", host), num: $("b", row), shown: -1 };
  });
  E.sizeRows.forEach((r) => { r.shown = r.n; });
  const retrigger = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  let lastClick = 0;

  function renderA(t) {
    const ch = A;
    // hero: the number dissolves into the map
    const glyphA = seg(t, 0.1, 0.24), fly = seg(t, 0.28, 0.95);
    setOp(heroN, 1 - glyphA);
    setOp(hero, 1 - seg(t, 0.2, 0.45));
    hero.style.setProperty("--lift", (-28 * eio(seg(t, 0.26, 0.6))).toFixed(1) + "px");
    // the paper, over the dimmed map
    const paperOn = seg(t, 1.0, 1.12) * (1 - seg(t, 1.88, 2.0));
    const dim = paperOn;
    // Trace Precedents from GP IRR, then the turn: the map compiles into a block. Both play on the clock once
    // reached, and back again if the reader scrolls back
    const comp = eio(playFor(A, "compile", t >= 4.05, BEAT));
    const traceOn = seg(t, 2.04, 2.14) * (1 - seg(t, 4.0, 4.12));
    let lev, a1 = 0, a2 = 0;
    const keepClicking = playFor(A, "clicks", t >= 3.0, BEAT);
    if (t < 3) { a1 = seg(t, 2.14, 2.28); a2 = seg(t, 2.36, 2.66); lev = eio(a1) + eio(a2); }
    else { a1 = a2 = 1; lev = 2 + clicks(keepClicking, CLICKS - 2); }
    draw(ch, { uFly: fly, uGlyphA: glyphA, uRead: 0, uCap: 1, uReadOn: 0, uLevel: lev, uTraceOn: traceOn, uDim: dim * 0.95,
      uCompile: comp, uBox: shared.boxC, uCell: shared.L.s * 0.86, uRectCell: shared.boxC.w / RC * 0.86 });
    // the sheet names step back with the map while the paper is up, so they never show through it
    const lab = seg(t, 0.8, 0.98) * (1 - dim) * (1 - seg(t, 4.0, 4.2));
    ch.labelEls.forEach((el) => setOp(el, lab));
    setOp(ch.ring, traceOn); setOp(ch.gplab, traceOn);
    // the paper
    setOp(paper, paperOn);
    paper.style.setProperty("--u", eio(seg(t, 1.35, 1.6)).toFixed(3));
    { const e = eio(seg(t, 1.0, 1.24)); paper.style.transform = `translateY(${(1 - e) * 26}px) rotate(${(1 - e) * -2}deg)`; }
    // HUD: Trace Precedents
    setOp(E.hudTrace, traceOn);
    // a click counts from the moment it starts, so the counter agrees with the card ("Click again: 386")
    const n = lev <= 0.001 ? 0 : Math.min(CLICKS, Math.ceil(lev - 1e-3)), fr = 0;
    const cells = cum[n];
    setText(E.trN, fmt(cells));
    if (n !== lastClick && n > 0 && traceOn > 0.5) retrigger(E.trN, "tick");
    lastClick = n;
    setText(E.trSmall, n === 0 ? "cell · GP IRR" : `cells so far · after ${n} click${n > 1 ? "s" : ""} of Trace Precedents`);
    setText(E.trSub, n === 0 ? "select GP IRR" : `+${fmt(cum[n] - cum[n - 1])} on this click · ${sheetsAt[n]} sheet${sheetsAt[n] > 1 ? "s" : ""}` +
      (n === CLICKS && fr < 0.02 ? ` · ${(cum[CLICKS] / N * 100).toFixed(1)}% of the workbook's formulas` : ""));
    // the arrows of the first two clicks fade out entirely once the cone takes over
    drawArrows(ch, a1, a2, traceOn * (1 - seg(t, 3.0, 3.2)));
  }

  function arrow(g, tail, head, k, w, dot) {
    const x = head[0] + (tail[0] - head[0]) * k, y = head[1] + (tail[1] - head[1]) * k;
    g.lineWidth = w; g.beginPath(); g.moveTo(head[0], head[1]); g.lineTo(x, y); g.stroke();
    if (dot && k > 0.98) { g.beginPath(); g.arc(tail[0], tail[1], w + 1.2, 0, 7); g.fill(); }
  }
  function arrowHead(g, tail, hd, size) {
    const a = Math.atan2(hd[1] - tail[1], hd[0] - tail[0]);
    g.beginPath(); g.moveTo(hd[0], hd[1]);
    g.lineTo(hd[0] - size * Math.cos(a - 0.42), hd[1] - size * Math.sin(a - 0.42));
    g.lineTo(hd[0] - size * Math.cos(a + 0.42), hd[1] - size * Math.sin(a + 0.42)); g.closePath(); g.fill();
  }
  function drawArrows(ch, a1, a2, alpha) {
    const g = ch.ctx; if (!g) return;
    g.setTransform(shared.dpr, 0, 0, shared.dpr, 0, 0); g.clearRect(0, 0, shared.W, shared.H);
    if (alpha < 0.002 || (a1 <= 0 && a2 <= 0)) return;
    const pos = shared.pos, P = (i) => [pos[2 * i], pos[2 * i + 1]], m = isMobile();
    const gp = P(iGP), l1 = P(iL1);
    g.strokeStyle = COL.blue; g.fillStyle = COL.blue;
    if (a2 > 0) {
      g.globalAlpha = alpha * 0.5;
      L2.forEach((j, q) => { const k = eio(clamp((a2 - l2rand[q] * 0.5) / 0.5)); if (k > 0) arrow(g, P(j), l1, k, m ? 0.5 : 0.7, true); });
      g.globalAlpha = alpha; if (a2 > 0.05) arrowHead(g, [l1[0] + 40, l1[1] - 30], l1, m ? 5 : 7);
    }
    if (a1 > 0) { g.globalAlpha = alpha; arrow(g, l1, gp, eio(a1), m ? 1.2 : 1.6, true); arrowHead(g, l1, gp, m ? 7 : 9); }
    g.globalAlpha = 1;
  }

  function renderC(t) {
    const ch = Cch, m = isMobile();
    const slide = eio(seg(t, 0.05, 0.15)), shrink = eio(playFor(Cch, "shrink", t >= 0.12, BEAT)), move = eio(seg(t, 3.05, 3.3));
    let box = lerpBox(lerpBox(shared.boxC, shared.boxG, slide), shared.boxChip, shrink);
    // the 48 KB chip becomes the first square of the size comparison, then comes back
    const toRow = eio(seg(t, 0.4, 0.52)) * (1 - eio(seg(t, 0.92, 1.0)));
    if (ch.sizeChip && toRow > 0) box = lerpBox(box, ch.sizeChip, toRow);
    if (ch.boxNext) box = lerpBox(box, ch.boxNext, move);
    // step 1: what the model knows, next to what Excel shows
    const ctxOn = seg(t, 1.0, 1.08) * (1 - seg(t, 1.94, 2.04));
    // the size comparison takes the whole stage for a moment, in turn: the workbook box and its labels step
    // back first (gone by .46), the comparison comes in after (from .46), and the other way on the way out
    const sizesAway = seg(t, 0.38, 0.46) * (1 - seg(t, 0.95, 1.0));
    const sizesOn = seg(t, 0.46, 0.54) * (1 - seg(t, 0.9, 0.95));
    const away = Math.max(m ? ctxOn : 0, sizesAway);
    draw(ch, { uFly: 1, uGlyphA: 1, uCompile: 1, uBox: box, uDim: m ? ctxOn * 0.9 : 0, uCell: shared.L.s * 0.86, uRectCell: box.w / RC * 0.86 });
    const out3 = 1 - seg(t, 3.0, 3.1), hideM = 1 - away;
    setOp(E.ghost, seg(t, 0.06, 0.14) * out3 * hideM);
    setOp(E.hudBytes, seg(t, 0.06, 0.14) * (1 - seg(t, 0.38, 0.46)));
    // never below the model's own size, even while the chip flies into the size comparison
    setText(E.byN, fmt(Math.max(MODEL_BYTES, BOOK_BYTES * Math.pow(Math.min(box.w, shared.boxG.w) / shared.boxG.w, 2))));
    // then, side by side: how many copies of the model fit in things an analyst knows by size
    setOp(E.sizes, sizesOn);
    const fill = playFor(Cch, "sizes", t >= 0.46, BEAT);
    E.sizeRows.forEach((r, k) => {
      const q = eio(clamp((fill - k * 0.16) / 0.45)), shown = Math.round(r.n * q);
      if (shown !== r.shown) {
        for (let j = Math.min(shown, r.shown); j < Math.max(shown, r.shown); j++) r.chips[j].classList.toggle("on", j < shown);
        r.shown = shown; r.num.textContent = fmt(shown);
      }
    });
    setOp(E.chipLab, seg(t, 0.2, 0.3) * out3 * hideM);
    setOp(E.ctx, ctxOn); setOp(E.hudCtx, ctxOn);
    ctxRows.forEach((r, k) => { r.classList.toggle("xl-on", t >= 1.08 + k * 0.16); r.classList.toggle("me-on", t >= 1.18 + k * 0.16); });
    // step 2: inputs only, and it runs anywhere
    setOp(E.hudKeep, seg(t, 2.0, 2.1) * (1 - seg(t, 2.94, 3.04)));
    E.slots.forEach((el, i) => setOp(el, (i < 3 ? seg(t, 2.08, 2.18) : seg(t, 2.52, 2.62)) * out3));
    E.copies.forEach((el, i) => {
      const t0 = i < 3 ? 2.2 + i * 0.1 : 2.62, k = eio(seg(t, t0, t0 + 0.22)), w = ch.wells && ch.wells[i], c = shared.boxChip;
      if (!w) return;
      const sz = lerp(c.w, w.s, k);
      el.style.width = el.style.height = sz.toFixed(1) + "px";
      el.style.transform = `translate(${lerp(c.x, w.x, k).toFixed(1)}px, ${lerp(c.y, w.y, k).toFixed(1)}px)`;
      setOp(el, (k > 0 ? 0.92 : 0) * out3);
      E.slots[i].classList.toggle("landed", k >= 0.999 && out3 > 0.5);
    });
    // step 3: every side of the deal. The other three models appear as workbooks and compress to chips,
    // threads tie each one's own name for a thing to one shared name
    setOp(E.sides, seg(t, 3.12, 3.26));
    E.sides.style.setProperty("--k", eio(seg(t, 3.2, 3.42)).toFixed(3));
    E.sides.style.setProperty("--d", eio(seg(t, 3.4, 3.62)).toFixed(3));
    E.sides.classList.toggle("live", !reduce && t >= 3.6);
  }

  // the last chapter: the same model, carried in. It waits until its stage arrives, starts where chapter C left the
  // chip (the buyer's mark), comes to the middle, and unfolds into the map with every cell lit
  function renderD(t) {
    const from = Cch.boxNext || shared.boxMid, box = lerpBox(from, shared.boxMid, eio(seg(t, 0, 0.15)));
    setOp(D.canvas, seg(t, -0.03, 0.02));
    const unfold = seg(t, 0.12, 0.5);
    draw(D, { uFly: 1, uGlyphA: 1, uCompile: 1 - unfold, uBox: box, uLit: seg(t, 0.2, 0.6),
      uCell: shared.L.s * 0.86, uRectCell: box.w / RC * 0.86 });
    const lab = seg(t, 0.45, 0.65);
    D.labelEls.forEach((el) => setOp(el, lab)); setOp(D.ring, 0); setOp(D.gplab, 0);
  }

  /* ---------- loop: the reader holds time; damping keeps it smooth ---------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last); last = now;
    for (const ch of CH) {
      const r = ch.root.getBoundingClientRect();
      if (!r.height || r.bottom < -innerHeight * 0.5 || r.top > innerHeight * 1.5) continue;
      if (ch.v !== shared.v) measure(ch);
      // without WebGL the map is not drawn, but the cards, the paper, the counters and the labels still play
      if (ch.v !== shared.v || !ch.labelEls && ch.labels) continue;
      ch.target = target(ch);
      const si = clamp(Math.floor(ch.target + 1e-6), 0, ch.steps.length - 1);
      if (ch.now !== si) { ch.steps.forEach((s, i) => s.classList.toggle("now", i === si)); ch.now = si; }
      if (reduce) ch.shown = ch.target;
      else {
        // a long jump (a reload, an anchor) lands next to the reader's place instead of replaying everything between
        if (Math.abs(ch.target - ch.shown) > 1) ch.shown = ch.target - Math.sign(ch.target - ch.shown) * 0.15;
        ch.shown += (ch.target - ch.shown) * (1 - Math.exp(-dt / 95)); if (Math.abs(ch.target - ch.shown) < 1e-4) ch.shown = ch.target;
      }
      if (ch.shown !== ch.drawn || ch.dirty) { ch.dirty = false; ch.render(ch.shown); ch.drawn = ch.shown; }
      // at a chapter's end its last card leaves with its stage, not after it (on a phone the stage sits above the cards)
      if (ch.lastCard) {
        const lift = Math.min(0, r.bottom - innerHeight), natural = Math.min(ch.cardTop, r.bottom - ch.cardH);
        const dy = isMobile() ? 0 : Math.min(0, ch.cardTop + lift - natural);
        const s = dy ? `translateY(${dy.toFixed(1)}px)` : "";
        if (ch.lastCard._ty !== s) { ch.lastCard.style.transform = s; ch.lastCard._ty = s; }
      }
    }
    requestAnimationFrame(frame);
  }
  const relayout = () => { shared.pos = null; shared.W = 0; CH.forEach((c) => { c.v = -1; }); };
  let rz = 0; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(relayout, 120); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColours(); CH.forEach((c) => (c.dirty = true)); });
  requestAnimationFrame(frame);
  // a card's lines arrive the first time it comes into view, so a card is never an empty frame and its words
  // arrive with the map beside it (story.css .seen)
  {
    const cards = $$(".scrolly .card");
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.closest(".step").classList.add("seen"); io.unobserve(e.target); } }), { threshold: 0.35 });
      cards.forEach((c) => io.observe(c));
    } else cards.forEach((c) => c.closest(".step").classList.add("seen"));
  }

  /* ---------- blocks ---------- */
  const whenSeen = (el, fn, threshold = 0.35) => {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { fn(); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold });
    io.observe(el);
  };
  const tween = (ms, step, done) => {
    if (reduce || ms <= 0) { step(1); if (done) done(); return () => {}; }
    const t0 = performance.now(); let raf = 0;
    const go = (now) => { const p = clamp((now - t0) / ms); step(p); if (p < 1) raf = requestAnimationFrame(go); else if (done) done(); };
    raf = requestAnimationFrame(go); return () => cancelAnimationFrame(raf);
  };
  // the runs come in: every beat counts its runs on the same clock (fast, then settling), then its answer lands
  const countIn = (el, total, step, done) => whenSeen(el, () => tween(COUNT, (p) => step(Math.round(outCubic(p) * total), outCubic(p)), done), 0.45);
  // a ticker's numbers keep the width of their final value, so " of 101 runs" never moves as they count
  const fixTicker = (nSel, sSel, nFinal, sFinal) => { $(nSel).style.minWidth = fmt(nFinal).length + "ch"; $(sSel).style.minWidth = String(sFinal).length + "ch"; };

  // the Excel runs, lit at Excel's real pace, sped up to about seven seconds; the page's own levers come last,
  // darker, as a block of their own (512 = 32 x 16, then 70 = 35 x 2), so every row of both is full
  const runsEl = $("#runs"), RUNS = signoff.runs;
  const rbMain = document.createElement("div"), rbLev = document.createElement("div");
  rbMain.className = "rb"; rbLev.className = "rb lvs"; runsEl.append(rbMain, rbLev);
  const runCells = RUNS.map((_, k) => { const i = document.createElement("i");
    if (k >= SD.lever_from) { i.classList.add("lv"); rbLev.appendChild(i); } else rbMain.appendChild(i); return i; });
  const ends = []; { let s = 0; RUNS.forEach((r) => { s += r[2]; ends.push(s); }); }
  const REPLAY = 7, factor = signoff.seconds / REPLAY;
  $("#clockK").textContent = `of Excel time, played back ${fmt(factor)}× faster`;
  const hms = (s) => { s = Math.round(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  let stopRuns = () => {}, resetAt = 0;
  function playRuns(again) {
    stopRuns(); clearTimeout(resetAt);
    runsEl.classList.remove("finished"); $("#mis").classList.remove("ok");
    const go = () => {
      runsEl.classList.remove("reset");
      stopRuns = tween(REPLAY * 1000, (p) => {
        const t = p * ends[ends.length - 1]; let compared = 0, bad = 0;
        for (let i = 0; i < RUNS.length; i++) { const on = ends[i] <= t + 1e-6; if (runCells[i]._on !== on) { runCells[i].classList.toggle("done", on); runCells[i]._on = on; } if (on) { compared += RUNS[i][0]; bad += RUNS[i][1]; } }
        $("#cmp").textContent = fmt(compared); $("#mis").textContent = fmt(bad); $("#clock").textContent = hms(t);
      }, () => { runsEl.classList.add("finished"); $("#mis").classList.add("ok"); });
    };
    // a replay first lets the lit squares go grey, together, over a moment; then the runs come in again
    if (again && !reduce && runCells.some((c) => c._on)) {
      runsEl.classList.add("reset"); runCells.forEach((c) => { c.classList.remove("done"); c._on = false; });
      resetAt = setTimeout(go, DUR3);
    } else go();
  }
  whenSeen(runsEl, () => playRuns(false), 0.4);
  $("#runsBtn").addEventListener("click", () => playRuns(true));

  /* ---------- asking backwards: the climax ---------- */
  const NS = "http://www.w3.org/2000/svg";
  const P = rev.scan.points, X = rev.grid.x.values, Y = rev.grid.y.values, GV = rev.grid.values;
  const base = rev.base, RUNS1 = P.length, RUNS2 = rev.grid.runs;
  // ask forward opens on the model's own run (its exact price); dragging moves along the 101-run scan
  const P0 = [base.price, base.lp_irr, base.gp_irr];
  const nearPi = () => P.reduce((b, p, i) => (Math.abs(p[0] - base.price) < Math.abs(P[b][0] - base.price) ? i : b), 0);
  const state = { T: 0.15, pi: -1,
    shown1: reduce ? RUNS1 : 0, shown2: reduce ? RUNS2 : 0 };
  const T_MIN = 0.06, T_MAX = 0.24;
  const T_ALL = []; for (let k = Math.round(T_MIN * 400); k <= Math.round(T_MAX * 400); k++) T_ALL.push(k / 400);
  const fmtM = (v) => "$" + (v / 1e6).toFixed(1) + "M", fmtM2 = (v) => "$" + (v / 1e6).toFixed(2) + "M";
  // beat 1: LP IRR against the purchase price, a forward handle and a backward target line
  const F1 = { w: 560, h: 332, l: 46, r: 14, t: 16, b: 46 }, Y1 = 0.27;
  const PX0 = P[0][0], PX1 = P[P.length - 1][0];
  const x1 = (x) => F1.l + (x - PX0) / (PX1 - PX0) * (F1.w - F1.l - F1.r);
  const y1 = (y) => F1.t + (1 - y / Y1) * (F1.h - F1.t - F1.b);
  const txt = (x, y, str, a = "start") => `<text x="${x}" y="${y}" text-anchor="${a}">${str}</text>`;
  const ticks1 = []; for (let v = Math.ceil(PX0 / 2e6) * 2e6; v <= PX1; v += 2e6) ticks1.push(v);
  $("#plot1").innerHTML = `<svg viewBox="0 0 ${F1.w} ${F1.h}" id="svg1" tabindex="0" role="img" aria-label="LP IRR against the purchase price, ${RUNS1} runs. Arrow keys move the price; up and down move the target.">` +
    `<rect id="f1band" y="${F1.t}" height="${F1.h - F1.t - F1.b}" fill="var(--proof)" fill-opacity="0.1" x="0" width="0"/>` +
    [0, 0.05, 0.1, 0.15, 0.2, 0.25].map((v) => `<line x1="${F1.l}" x2="${F1.w - F1.r}" y1="${y1(v)}" y2="${y1(v)}" stroke="var(--line)"/>` + txt(F1.l - 8, y1(v) + 4, Math.round(v * 100) + "%", "end")).join("") +
    ticks1.map((v) => txt(x1(v), F1.h - 24, "$" + v / 1e6 + "M", "middle")).join("") +
    txt(F1.w - F1.r, F1.h - 5, "purchase price →", "end") + txt(F1.l, F1.t - 4, "LP IRR") +
    `<g id="f1pts"></g><line id="f1edge" y1="${F1.t}" y2="${F1.h - F1.b}" stroke="var(--proof)" stroke-width="1.5" stroke-dasharray="3 3"/>` +
    `<text id="f1el" class="halo pf b6" text-anchor="middle"></text>` +
    `<g id="f1tgt"><line x1="${F1.l}" x2="${F1.w - F1.r}" stroke="var(--proof)" stroke-width="2.5"/><text id="f1tl" class="halo pf b6" x="${F1.w - F1.r - 40}" text-anchor="end"></text></g>` +
    `<g id="f1grip"><rect width="30" height="16" rx="8" fill="var(--proof)"/><text class="wf" x="15" y="12" text-anchor="middle">↕</text></g>` +
    `<g id="f1fwd"><line id="f1fl" stroke="var(--ink)" stroke-dasharray="2 3"/><circle id="f1fc" r="7" fill="var(--paper)" stroke="var(--ink)" stroke-width="2.5"/></g></svg>`;
  const svg1 = $("#svg1"), f1pts = $("#f1pts");
  const dots1 = P.map((q) => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", x1(q[0])); c.setAttribute("cy", y1(q[1] ?? 0)); c.setAttribute("r", 2.8); f1pts.appendChild(c); return c; });
  // beat 2: purchase price x occupancy, revealed column by column as the runs come in
  const F2 = { w: 560, h: 330, l: 50, r: 14, t: 10, b: 38 };
  const cw = (F2.w - F2.l - F2.r) / X.length, chh = (F2.h - F2.t - F2.b) / Y.length;
  const jBase = Y.reduce((b, y, j) => (Math.abs(y - base.occ) < Math.abs(Y[b] - base.occ) ? j : b), 0);
  const cellsSvg = [];
  for (let j = 0; j < Y.length; j++) for (let i = 0; i < X.length; i++)
    cellsSvg.push(`<rect x="${(F2.l + i * cw).toFixed(1)}" y="${(F2.t + (Y.length - 1 - j) * chh).toFixed(1)}" width="${(cw - 1).toFixed(1)}" height="${(chh - 1).toFixed(1)}" data-i="${i}" data-j="${j}"/>`);
  const bx = F2.l + (base.price - X[0]) / (X[X.length - 1] - X[0]) * (X.length - 1) * cw + cw / 2;
  const by = F2.t + (Y.length - 1 - jBase) * chh + chh / 2, midY = F2.t + (F2.h - F2.t - F2.b) / 2;
  $("#plot2").innerHTML = `<svg viewBox="0 0 ${F2.w} ${F2.h}" id="svg2" role="img" aria-label="Which combinations of purchase price and occupancy clear the target LP IRR, ${RUNS2} runs">` +
    `<defs><pattern id="hatch2" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" stroke-width="1.3"/></pattern>` +
    `<mask id="m2bank" maskUnits="userSpaceOnUse" x="0" y="0" width="${F2.w}" height="${F2.h}"><path id="f2bankM" fill="none" stroke="#fff" stroke-width="8" pathLength="1"/></mask></defs>` +
    `<g id="f2cells">${cellsSvg.join("")}</g><g id="f2cut"></g><path id="f2bank" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" mask="url(#m2bank)"/>` +
    `<polyline id="f2front" fill="none" stroke="var(--proof)" stroke-width="2.5" pathLength="1"/>` +
    `<circle cx="${bx}" cy="${by}" r="6" fill="none" stroke="var(--accent)" stroke-width="2.2"/>` +
    `<text class="halo af" x="${bx + 9}" y="${by - 8}">the deal today</text>` +
    txt(F2.l, F2.h - 20, fmtM(X[0])) + txt(F2.w - F2.r, F2.h - 20, fmtM(X[X.length - 1]), "end") + txt((F2.l + F2.w - F2.r) / 2, F2.h - 4, "purchase price →", "middle") +
    txt(F2.l - 8, F2.t + 10, pct(Y[Y.length - 1], 0), "end") + txt(F2.l - 8, F2.h - F2.b, pct(Y[0], 0), "end") +
    `<text x="12" y="${midY}" transform="rotate(-90 12 ${midY})" text-anchor="middle">occupancy</text></svg>`;
  const svg2 = $("#svg2"), rects = $$("#f2cells rect");
  const rank = (r) => +r.dataset.i * Y.length + +r.dataset.j;
  const inkMix = (v) => `color-mix(in oklch, var(--ink) ${Math.round(8 + clamp(v / Y1) * 50)}%, var(--paper))`;
  const maxPriceAt = (j, T) => { let best = -1; for (let i = 0; i < X.length; i++) if (GV[j][i][0] != null && GV[j][i][0] >= T) best = i; return best; };
  // the lowest occupancy (row) at which, in price column i, the LP reaches T / the bank still lends the full cap
  const lpEdge = (i, T) => { let e = -1; for (let j = Y.length - 1; j >= 0; j--) { if (GV[j][i][0] != null && GV[j][i][0] >= T) e = j; else break; } return e; };
  const bankEdge = (i) => { let e = -1; for (let j = Y.length - 1; j >= 0; j--) { if (GV[j][i][2] === 0) e = j; else break; } return e; };
  let hoverEl = null, touched = false;
  const setBump = (el, str) => { if (el.textContent !== str) { el.textContent = str; retrigger(el, "bump"); } };
  const setStyle = (el, k, v) => { const c = "_" + k; if (el[c] !== v) { el.style[k] = v; el[c] = v; } };
  // what beat 1 says at a target: the most you can pay, its caption and the verdict at the model's own price
  const lastAt = (T) => { let last = -1; P.forEach((pt, k) => { if (pt[1] != null && pt[1] >= T) last = k; }); return last; };
  const say1 = (T) => {
    const last = lastAt(T), most = last >= 0 ? P[last][0] : null;
    return { last,
      a: last < 0 ? "none" : fmtM(P[last][0]) + (last === P.length - 1 ? "+" : ""),
      q: last >= 0 ? `the most you can pay and keep LP IRR at ${pct(T)} or more` +
        (P[last][3] ? ` · $${fmt(P[last][3])} a unit, ${pct(P[last][4])} of the price in stabilized NOI` : "") + ` · the model's price is ${fmtM2(base.price)}`
        : `no price from ${fmtM(PX0)} up gets LP IRR to ${pct(T)}`,
      // the verdict at the model's own price, in the reader's terms: how far over (or under) the target it is
      ans: most === null ? "" : base.price > most
        ? `At the model's own price, ${fmtM2(base.price)}, the LP gets ${pct(base.lp_irr)}: <b>${fmtM2(base.price - most)}</b> more than ${pct(T)} allows.`
        : `At the model's own price, ${fmtM2(base.price)}, the LP gets ${pct(base.lp_irr)}: <b>${fmtM2(most - base.price)}</b> of room under ${pct(T)}.` };
  };
  // the bank's cuts do not depend on the target: count them once
  let CUTS = 0; for (let i = 0; i < X.length; i++) { const je = bankEdge(i); for (let j = 0; j < je; j++) if (GV[j][i][2] === 1) CUTS++; }
  // what beat 2 says at a target: who walks first, at the price beat 1 just answered
  const say2 = (T) => {
    const last = lastAt(T), at = last >= 0 ? P[last][0] : base.price;
    const iAt = X.reduce((b, x, i) => (Math.abs(x - at) < Math.abs(X[b] - at) ? i : b), 0);
    const jl = lpEdge(iAt, T), jb = bankEdge(iAt);
    let n, c;
    if (jl >= 0 && jb >= 0) {
      const gap = +((Y[jl] - Y[jb]) * 100).toFixed(1);
      n = `${Math.abs(gap)} point${Math.abs(gap) === 1 ? "" : "s"}`;
      c = gap >= 0
        ? `of occupancy the LP gives up before the bank lends a dollar less, at ${fmtM2(X[iAt])} (the grid's nearest price to the answer above): ` +
          `the LP's ${pct(T)} needs ${pct(Y[jl])} or more; the bank lends its full ${Math.round(rev.grid.ltc_cap * 100)}% of cost down to ${pct(Y[jb])}. ` +
          `At the model's own price that line is question 3's bend: a lower price means a smaller loan, so the bank holds on longer`
        : `of occupancy the bank cuts the loan before the LP walks, at ${fmtM2(X[iAt])}: the bank lends less below ${pct(Y[jb])}; the LP's ${pct(T)} holds down to ${pct(Y[jl])}`;
    } else { n = "none"; c = `no occupancy on this grid gets the LP to ${pct(T)} at ${fmtM2(X[iAt])}`; }
    let met = 0; for (let j = 0; j < Y.length; j++) for (let i = 0; i < X.length; i++) if (GV[j][i][0] != null && GV[j][i][0] >= T) met++;
    return { n, c, ans: `<b>${met}</b> of ${fmt(RUNS2)} combinations clear ${pct(T)}. In <b>${CUTS}</b>, coverage cuts the loan.` };
  };
  function renderRev() {
    const T = state.T, q = state.pi < 0 ? P0 : P[state.pi];
    // ask forward
    $("#fwdQ").textContent = fmtM2(q[0]); setBump($("#fwdA"), pct(q[1]));
    $("#f1fl").setAttribute("x1", x1(q[0])); $("#f1fl").setAttribute("x2", x1(q[0])); $("#f1fl").setAttribute("y1", y1(q[1])); $("#f1fl").setAttribute("y2", F1.h - F1.b);
    $("#f1fc").setAttribute("cx", x1(q[0])); $("#f1fc").setAttribute("cy", y1(q[1]));
    // ask backwards: the highest price that still clears the target
    const tl = $("#f1tgt line"); tl.setAttribute("y1", y1(T)); tl.setAttribute("y2", y1(T));
    $("#f1tl").setAttribute("y", y1(T) - 6); $("#f1tl").textContent = "target " + pct(T);
    $("#f1grip").setAttribute("transform", `translate(${F1.w - F1.r - 30},${(y1(T) - 8).toFixed(1)})`);
    // the runs come in one by one, each fading in where it lands
    dots1.forEach((c, k) => { setStyle(c, "fill", P[k][1] != null && P[k][1] >= T ? "var(--proof)" : "var(--ink-muted)"); setStyle(c, "opacity", k < state.shown1 ? "1" : "0"); });
    const s1 = say1(T), last = s1.last;
    // the answer's guides are always drawn where they belong; story.css settles them in once the runs are in
    const edge = $("#f1edge"), band = $("#f1band"), el = $("#f1el");
    if (last >= 0) {
      const ex = x1(P[last][0]);
      edge.setAttribute("x1", ex); edge.setAttribute("x2", ex); edge.setAttribute("visibility", "visible");
      band.setAttribute("x", x1(PX0)); band.setAttribute("width", ex - x1(PX0));
      el.setAttribute("x", clamp(ex, F1.l + 34, F1.w - F1.r - 34)); el.setAttribute("y", F1.h - F1.b - 8); el.textContent = "≤ " + fmtM(P[last][0]);
    } else { edge.setAttribute("visibility", "hidden"); band.setAttribute("width", 0); el.textContent = ""; }
    $("#bkA").textContent = s1.a;
    $("#bkQ").textContent = s1.q;
    setHTML($("#ans1"), s1.ans);
    // two levers: read across from the occupancy you believe; each square fades in as its run comes in
    rects.forEach((r) => {
      const i = +r.dataset.i, j = +r.dataset.j, v = GV[j][i][0], ok = v != null && v >= T, on = rank(r) < state.shown2;
      setStyle(r, "fill", !on ? "var(--paper-deep)" : ok ? "color-mix(in oklch, var(--proof) 72%, var(--paper))" : inkMix(v ?? 0));
    });
    const pts = [];
    for (let j = 0; j < Y.length; j++) { const i = maxPriceAt(j, T); if (i >= 0) pts.push([F2.l + (i + 1) * cw - 0.5, F2.t + (Y.length - 1 - j) * chh + chh / 2]); }
    $("#f2front").setAttribute("points", pts.map((pt) => pt.join(",")).join(" "));
    // the bank's wall: in each price column, the lowest occupancy at which the loan is still the full cap
    let bankD = "", cutSvg = "";
    for (let i = 0; i < X.length; i++) {
      const je = bankEdge(i);
      if (je < 0) continue;
      const yb = F2.t + (Y.length - je) * chh, xl = F2.l + i * cw;
      bankD += (bankD ? "L" : "M") + xl.toFixed(1) + " " + yb.toFixed(1) + "H" + (xl + cw).toFixed(1);
      for (let j = 0; j < je; j++) if (GV[j][i][2] === 1)
        cutSvg += `<rect x="${xl.toFixed(1)}" y="${(F2.t + (Y.length - 1 - j) * chh).toFixed(1)}" width="${(cw - 1).toFixed(1)}" height="${(chh - 1).toFixed(1)}"/>`;
    }
    if ($("#f2bank")._d !== bankD) { $("#f2bank").setAttribute("d", bankD); $("#f2bankM").setAttribute("d", bankD); $("#f2bank")._d = bankD; }
    if ($("#f2cut")._h !== cutSvg) { $("#f2cut").innerHTML = cutSvg; $("#f2cut")._h = cutSvg; }
    const s2 = say2(T);
    setBump($("#big2n"), s2.n);
    $("#big2c").textContent = s2.c;
    setHTML($("#ans2"), s2.ans);
  }
  // pointer: drag near the target line moves the target, anywhere else moves the price
  const svgPoint = (e) => { const r = svg1.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * F1.w, (e.clientY - r.top) / r.height * F1.h]; };
  const priceFromX = (px) => { const x = PX0 + (px - F1.l) / (F1.w - F1.l - F1.r) * (PX1 - PX0); return P.reduce((b, pt, i) => (Math.abs(pt[0] - x) < Math.abs(P[b][0] - x) ? i : b), 0); };
  const tFromY = (py) => clamp(Math.round((1 - (py - F1.t) / (F1.h - F1.t - F1.b)) * Y1 * 400) / 400, T_MIN, T_MAX);
  const nearOf = (py) => (Math.abs(py - y1(state.T)) < 16 ? "t" : "x");
  let dragging = null;
  svg1.addEventListener("pointerdown", (e) => {
    const [px, py] = svgPoint(e);
    touched = true; dragging = nearOf(py); svg1.dataset.drag = dragging;
    svg1.setPointerCapture(e.pointerId);
    if (dragging === "t") state.T = tFromY(py); else state.pi = priceFromX(px);
    renderRev();
  });
  svg1.addEventListener("pointermove", (e) => {
    const [px, py] = svgPoint(e);
    if (!dragging) { const n = nearOf(py); svg1.dataset.near = n; svg1.style.cursor = n === "t" ? "ns-resize" : "ew-resize"; return; }
    if (dragging === "t") state.T = tFromY(py); else state.pi = priceFromX(px);
    renderRev();
  });
  svg1.addEventListener("pointerup", () => { dragging = null; delete svg1.dataset.drag; });
  svg1.addEventListener("pointerleave", () => { if (!dragging) delete svg1.dataset.near; });
  svg1.addEventListener("keydown", (e) => {
    const k = e.key; touched = true;
    if (k === "ArrowLeft" || k === "ArrowRight") state.pi = clamp((state.pi < 0 ? nearPi() : state.pi) + (k === "ArrowRight" ? 1 : -1), 0, P.length - 1);
    else if (k === "ArrowUp" || k === "ArrowDown") state.T = clamp(+(state.T + (k === "ArrowUp" ? 0.0025 : -0.0025)).toFixed(4), T_MIN, T_MAX);
    else return;
    e.preventDefault(); renderRev();
  });
  // hover: the square under the pointer, found from its position so the 1 px gaps never blank it;
  // only the one readout line changes, in a box already as tall as its longest reading, so nothing beside it moves
  const hov2 = $("#hov2"), xl2 = $("#xl2");
  let sel2 = null;
  const read2 = (i, j) => { const c = GV[j][i]; return `${pct(Y[j])} occupancy · ${fmtM2(X[i])} → LP IRR ${c[0] == null ? "n/a" : pct(c[0])}${c[1] == null ? "" : " · GP IRR " + pct(c[1])}`; };
  // the square's own inputs, written into a copy of the workbook: every formula live, for the reader to check
  xl2.addEventListener("click", async () => {
    if (!sel2) return;
    const { i, j } = sel2, scenario = { [rev.grid.x.id]: X[i] }, was = xl2.textContent;
    rev.grid.y.ids.forEach((id) => { scenario[id] = Y[j]; });
    xl2.disabled = true; xl2.textContent = "Building the workbook…";
    try {
      const res = await fetch("/api/export/workbook", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: rev.model_id, scenario }) });
      if (!res.ok) throw new Error(res.status === 503 ? "Excel export needs the live model; try the desk." : `Excel export failed (${res.status}).`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = `run-${(X[i] / 1e6).toFixed(2)}M-${(Y[j] * 100).toFixed(1)}pct.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      xl2.textContent = was;
    } catch (err) {
      xl2.textContent = err.message;
      setTimeout(() => { xl2.textContent = was; }, 3500);
    } finally { xl2.disabled = false; }
  });
  const setHover = (r) => {
    if (hoverEl === r) return;
    if (hoverEl) { hoverEl.removeAttribute("stroke"); hoverEl.removeAttribute("stroke-width"); }
    hoverEl = r;
    if (!r) { hov2.textContent = "Point at a square to see its run."; return; }
    r.setAttribute("stroke", "var(--ink)"); r.setAttribute("stroke-width", "1.5");
    const i = +r.dataset.i, j = +r.dataset.j;
    sel2 = { i, j };
    if (!xl2.disabled) { xl2.classList.add("is-on"); xl2.textContent = `Open this run in Excel: ${fmtM2(X[i])} at ${pct(Y[j])}`; }
    hov2.textContent = read2(i, j);
  };
  const pick2 = (e) => {
    if (state.shown2 < RUNS2) return;
    const r = svg2.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * F2.w, py = (e.clientY - r.top) / r.height * F2.h;
    const i = Math.floor((px - F2.l) / cw), j = Y.length - 1 - Math.floor((py - F2.t) / chh);
    setHover(i >= 0 && i < X.length && j >= 0 && j < Y.length ? rects[j * X.length + i] : null);
  };
  svg2.addEventListener("pointermove", pick2);
  svg2.addEventListener("pointerdown", pick2);
  svg2.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setHover(null); });
  if (matchMedia("(hover: none)").matches) hov2.textContent = "Tap a square to see its run.";

  // the beats play once each, as they come into view: the runs land, then the answer
  const beat1 = $("#beat1"), beat2 = $("#beat2"), beat3 = $("#beat3");
  const tick = (n, total, secs, a, b) => { $(a).textContent = fmt(n); $(b).textContent = (n / total * secs).toFixed(1); };
  fixTicker("#t1n", "#t1s", RUNS1, rev.scan.seconds.toFixed(1)); fixTicker("#t2n", "#t2s", RUNS2, rev.grid.seconds.toFixed(1));
  tick(state.shown1, RUNS1, rev.scan.seconds, "#t1n", "#t1s"); tick(state.shown2, RUNS2, rev.grid.seconds, "#t2n", "#t2s");
  renderRev();
  {
    const s1 = T_ALL.map(say1), s2 = T_ALL.map(say2);
    reserve($("#bkQ"), s1.map((s) => s.q)); reserve($("#ans1"), s1.map((s) => s.ans), { html: true });
    reserve($("#big2c"), s2.map((s) => s.c)); reserve($("#ans2"), s2.map((s) => s.ans), { html: true });
    const reads = []; for (let j = 0; j < Y.length; j++) for (let i = 0; i < X.length; i++) reads.push(read2(i, j));
    reserve(hov2, [hov2.textContent, ...reads]);
  }
  // the hint that the green line moves: its grip breathes twice once the answer has landed, unless the reader is already there
  const hintGrip = () => { if (touched || reduce) return; const g = $("#f1grip"); g.classList.remove("hint"); void g.getBoundingClientRect(); g.classList.add("hint"); };
  if (reduce) { beat1.classList.add("done"); beat2.classList.add("done"); }
  else {
    countIn(beat1, RUNS1, (n) => { state.shown1 = n; tick(n, RUNS1, rev.scan.seconds, "#t1n", "#t1s"); renderRev(); },
      () => { beat1.classList.add("done"); setTimeout(hintGrip, DUR4); });
    countIn(beat2, RUNS2, (n) => { state.shown2 = n; tick(n, RUNS2, rev.grid.seconds, "#t2n", "#t2s"); renderRev(); },
      () => beat2.classList.add("done"));
  }

  // beat 3: the lender's question, on the reader's terms. For every coverage minimum, amortization and cap, the engine
  // ran the loan across occupancy at four rates, and each point records which test set it
  const LD = lender, LT = lterms, OC = LT.occupancy, beatL = $("#beatL");
  const FL = { w: 560, h: 320, l: 58, r: 16, t: 22, b: 30 };
  const allLoans = LT.lines.flatMap((L) => L.loan.filter((v) => v != null));
  const LY0 = Math.floor(Math.min(...allLoans) / 2e6) * 2e6, LY1 = Math.ceil(Math.max(...allLoans) / 2e6) * 2e6;
  const xL = (o) => FL.l + (o - OC[0]) / (OC[OC.length - 1] - OC[0]) * (FL.w - FL.l - FL.r);
  const yL = (v) => FL.t + (1 - (v - LY0) / (LY1 - LY0)) * (FL.h - FL.t - FL.b);
  const pct2 = (v) => (+(v * 100).toFixed(2)) + "%";
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const TM = LD.terms, yrs = (m) => (m % 12 ? m + " months" : m / 12 + "-year"), an = (p) => (/^(8|11|18)\b/.test(p) ? "an" : "a");
  const capName = (c) => (LT.caps[c].ltc < 1 ? `the ${pct2(LT.caps[c].ltc)} loan-to-cost cap` : `the ${pct2(LT.caps[c].ltv)} loan-to-value cap`);
  const capShort = (c) => (LT.caps[c].ltc < 1 ? `${pct2(LT.caps[c].ltc)} of cost, ${pct2(LT.caps[c].ltv)} of value` : `${pct2(LT.caps[c].ltv)} of value, no cost cap`);
  const stL = { dscr: LT.base.dscr, amort: LT.base.amort, cap: LT.base.cap, rate: LT.base.rate, q: reduce ? 1 : 0 };
  const sameTerms = (L, d, a, c) => near(L.dscr, d) && L.amort === a && L.cap === c;
  LT.lines.forEach((L) => { L.occ = LT.occupancy; });
  // the model's own terms keep the finer occupancy steps of the original lender runs (lender.json), so the bend reads the same
  const FINE = LD.lines.map((F) => ({ dscr: LT.base.dscr, amort: LT.base.amort, cap: LT.base.cap, rate: F.rate, occ: LD.occupancy,
    loan: F.points.map((q) => q[1]), binds: F.points.map((q) => (Math.abs(q[2] - LD.dscr_min) < 1e-4 ? "coverage" : "cost")),
    today: LT.lines.find((L) => sameTerms(L, LT.base.dscr, LT.base.amort, LT.base.cap) && near(L.rate, F.rate)).today }));
  const baseTerms = (s = stL) => near(s.dscr, LT.base.dscr) && s.amort === LT.base.amort && s.cap === LT.base.cap;
  const linesNow = (s = stL) => (baseTerms(s) ? FINE : LT.lines.filter((L) => sameTerms(L, s.dscr, s.amort, s.cap)));
  const lineNow = (s = stL) => linesNow(s).find((L) => near(L.rate, s.rate));
  const isBase = (s = stL) => baseTerms(s) && near(s.rate, LT.base.rate);
  const todayOf = (L) => L.occ.findIndex((o) => near(o, LT.base.occ));
  // where a line bends: the lowest occupancy from which the cap, not coverage, sets the loan
  const kinkOf = (L) => { let k = -1; for (let i = L.occ.length - 1; i >= 0; i--) { if (L.binds[i] && L.binds[i] !== "coverage") k = i; else break; } return k; };
  const slopeOf = (L) => { const k = kinkOf(L), hi = k < 0 ? L.occ.length - 1 : k - 1; return hi > 0 ? (L.loan[hi] - L.loan[0]) / ((L.occ[hi] - L.occ[0]) * 100) : null; };
  const bindName = (b, s = stL) => (b === "coverage" ? `${s.dscr.toFixed(2)}x coverage` : b === "debt yield" ? `the ${pct2(LT.dy_min)} debt yield` : capName(s.cap));
  const ticksY = []; for (let v = LY0; v <= LY1; v += 2e6) ticksY.push(v);
  // every line is drawn on the finer occupancy steps (the coarser runs fall on them exactly), so a change of terms
  // can carry each line to its new shape point by point
  const U = LD.occupancy;
  const resample = (L) => { const out = new Float64Array(U.length); let j = 0;
    for (let k = 0; k < U.length; k++) { const o = U[k]; while (j < L.occ.length - 2 && L.occ[j + 1] < o - 1e-9) j++;
      const o0 = L.occ[j], o1 = L.occ[j + 1], f = o1 > o0 ? clamp((o - o0) / (o1 - o0)) : 0; out[k] = yL(L.loan[j] + (L.loan[j + 1] - L.loan[j]) * f); }
    return out; };
  $("#plotL").innerHTML = `<svg viewBox="0 0 ${FL.w} ${FL.h}" id="svgL" role="img" aria-label="The loan the model sizes against stabilized occupancy, on the terms you set, at four interest rates">` +
    `<rect class="cover" id="lCover" x="${FL.l}" y="${FL.t}" width="0" height="${FL.h - FL.t - FL.b}"/>` +
    ticksY.map((v) => `<line x1="${FL.l}" x2="${FL.w - FL.r}" y1="${yL(v)}" y2="${yL(v)}" stroke="var(--line)"/>` + txt(FL.l - 8, yL(v) + 4, "$" + v / 1e6 + "M", "end")).join("") +
    [0.8, 0.85, 0.9, 0.95, 1].map((v) => txt(xL(v), FL.h - 10, Math.round(v * 100) + "%", v === 1 ? "end" : "middle")).join("") +
    txt(FL.l, FL.t - 8, "loan, by stabilized occupancy") +
    `<line class="cap" id="lCap" x1="${FL.l}" x2="${FL.w - FL.r}"/><text class="halo" id="lCapT" x="${FL.w - FL.r}" text-anchor="end"></text>` +
    LT.rates.map((r, k) => `<path class="ln" data-k="${k}" d=""/>`).join("") +
    `<line class="kink" id="lKink" y1="${FL.t}" y2="${FL.h - FL.b}"/><text id="lKinkT" class="halo pf b6" text-anchor="end"></text>` +
    `<circle id="lToday" r="6" fill="none" stroke="var(--accent)" stroke-width="2.2"/><text id="lTodayT" class="halo af" text-anchor="end">today</text></svg>`;
  // the shape of the figure on a set of terms
  const geomL = (s = stL) => { const Ls = linesNow(s), L = lineNow(s), k = kinkOf(L), iT = todayOf(L);
    return { ys: LT.rates.map((r) => { const M = Ls.find((m) => near(m.rate, r)); return M ? resample(M) : null; }),
      on: LT.rates.findIndex((r) => near(r, s.rate)), capY: k >= 0 ? yL(L.loan[k]) : null, kx: k > 0 ? xL(L.occ[k]) : FL.l, kink: k > 0,
      tx: xL(L.occ[iT]), ty: yL(L.loan[iT]) }; };
  const lerpGeom = (a, b, e) => ({ ys: b.ys.map((y, n) => (y && a.ys[n] ? y.map((v, k) => lerp(a.ys[n][k], v, e)) : y)), on: b.on,
    capY: a.capY != null && b.capY != null ? lerp(a.capY, b.capY, e) : b.capY, kx: lerp(a.kx, b.kx, e), kink: b.kink,
    tx: lerp(a.tx, b.tx, e), ty: lerp(a.ty, b.ty, e) });
  let gShown = null, stopL = () => {};
  const drawL = (g) => {
    gShown = g;
    const n = Math.max(2, Math.round(stL.q * U.length));
    $$("#svgL .ln").forEach((el, k) => { const ys = g.ys[k];
      let d = ""; if (ys) for (let i = 0; i < n; i++) d += (i ? "L" : "M") + xL(U[i]).toFixed(1) + " " + ys[i].toFixed(1);
      el.setAttribute("d", d); el.classList.toggle("on", k === g.on); });
    $("#lCap").style.opacity = g.capY == null ? 0 : 1;
    if (g.capY != null) { ["y1", "y2"].forEach((a) => $("#lCap").setAttribute(a, g.capY)); $("#lCapT").setAttribute("y", g.capY - 8); }
    ["x1", "x2"].forEach((a) => $("#lKink").setAttribute(a, g.kx));
    $("#lKink").setAttribute("visibility", g.kink ? "visible" : "hidden");
    $("#lKinkT").setAttribute("x", g.kx - 6); $("#lKinkT").setAttribute("y", FL.h - FL.b - 8);
    $("#lKinkT").textContent = g.kink ? "coverage takes over" : "";
    $("#lCover").setAttribute("width", g.kink ? Math.max(0, g.kx - FL.l) : 0);
    $("#lToday").setAttribute("cx", g.tx); $("#lToday").setAttribute("cy", g.ty);
    $("#lTodayT").setAttribute("x", g.tx - 10); $("#lTodayT").setAttribute("y", g.ty + 20);
  };
  // what beat 3 says on a set of terms
  const sayL = (s = stL) => {
    const L = lineNow(s), k = kinkOf(L), sl = slopeOf(L), t = L.today, OCL = L.occ, iToday = todayOf(L);
    const cap = k >= 0 ? L.loan[k] : null;
    const cushion = k > 0 ? +((OCL[iToday] - OCL[k]) * 100).toFixed(2) : null;
    const ex = LT.exit, capLtv = LT.caps[s.cap].ltv, reach = ex.find((e) => e[1] != null && e[1] >= capLtv), lastE = ex[ex.length - 1];
    return {
      capT: cap == null ? "" : `${capShort(s.cap)} · ${fmtM(cap)}`,
      big: k > 0 ? pct2(OCL[k]) : fmtM(t.loan),
      cap: k > 0 ? `the occupancy below which ${s.dscr.toFixed(2)}x coverage, not ${capName(s.cap)}, sets the loan · at a ${pct2(s.rate)} rate`
        : `the loan at today's occupancy: ${k === 0 ? capName(s.cap) : s.dscr.toFixed(2) + "x coverage"} sets it at every occupancy here · at a ${pct2(s.rate)} rate`,
      ans: `Today: <b>${fmtM(t.loan)}</b>, a ${pct(t.ltv)} loan-to-value, at ${t.dscr.toFixed(2)}x coverage on the first stabilized year's net cash flow; ${bindName(L.binds[iToday], s)} sets it. ` +
        (sl && k !== 0 ? `Each point of occupancy below ${k > 0 ? pct2(OCL[k]) : "today"} costs <b>${fmtM2(sl)}</b> of loan. ` : "") +
        (cushion == null ? "" : cushion > 0 ? `Today's ${pct2(OCL[iToday])} sits <b>${cushion} point${cushion === 1 ? "" : "s"}</b> above the bend.`
          : `Today's ${pct2(OCL[iToday])} is already below it.`),
      // the lender's questions, asked backwards, at today's occupancy on these terms
      rev: `<li><b>${pct(t.breakeven_occ)}</b> occupancy: as low as year 1 can go and still cover its costs and the interest-only payments due.</li>` +
        `<li><b>${t.leaseup_dscr.toFixed(2)}x</b>: the weakest month of lease-up, on the interest-only payments due. Below 1.00x, the model's own check calls for liquidity support until the building fills.</li>` +
        `<li><b>${pct(t.exit_ltv)}</b> of the sale value is still owed at the exit.` +
        (isBase(s) ? (reach ? ` It reaches ${pct2(capLtv)} only at a ${pct2(reach[0])} exit cap.` : ` Even at a ${pct2(lastE[0])} exit cap, it is ${pct(lastE[1])}.`) : "") + `</li>`,
      terms: `The loan: ${yrs(TM.term_months)} term, ${TM.io_months / 12} years interest-only, then ${yrs(s.amort)} amortization. ` +
        `It lends the least of ${pct2(LT.caps[s.cap].ltv)} of the price, ${LT.caps[s.cap].ltc < 1 ? pct2(LT.caps[s.cap].ltc) + " of the cost, " : ""}what ` +
        `${s.dscr.toFixed(2)}x coverage allows and what ${an(pct2(LT.dy_min))} ${pct2(LT.dy_min)} debt yield allows. The coverage that sizes the loan is tested on ` +
        `amortizing debt service; the lease-up figures above use the interest-only payments actually due. The purchase price stands in for an appraisal, ` +
        `and the cost includes the capital reserve the equity funds after closing.` };
  };
  function renderL(g) {
    drawL(g || geomL());
    const s = sayL();
    $("#lCapT").textContent = s.capT;
    setBump($("#bigL"), s.big);
    $("#bigLc").textContent = s.cap;
    setHTML($("#ansL"), s.ans);
    setHTML($("#revL"), s.rev);
    setText($("#termsL"), s.terms);
  }
  // the terms, as chips
  const TERMS = { dscr: LT.dscr.map((v) => [v, v.toFixed(2) + "x"]), amort: LT.amort.map((v) => [v, v / 12 + " yr"]),
    cap: Object.keys(LT.caps).map((c) => [c, capShort(c)]), rate: LT.rates.map((v) => [v, pct2(v)]) };
  const LABEL = { dscr: "Coverage", amort: "Amortization", cap: "Cap", rate: "Rate" };
  $$("#termsSel .rates").forEach((p) => {
    const k = p.dataset.k;
    p.innerHTML = `<span class="tk">${LABEL[k]}</span>` + TERMS[k].map(([v, l], n) => `<button type="button" data-n="${n}">${l}</button>`).join("");
  });
  const markTerms = () => $$("#termsSel .rates").forEach((p) => { const k = p.dataset.k;
    $$("button", p).forEach((b) => { const v = TERMS[k][+b.dataset.n][0]; b.classList.toggle("on", typeof v === "number" ? near(v, stL[k]) : v === stL[k]); }); });
  // a change of terms carries every line, the cap, the bend and today's point to their new places
  $("#termsSel").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const k = b.closest(".rates").dataset.k;
    stL[k] = TERMS[k][+b.dataset.n][0]; stL.q = 1; markTerms(); beatL.classList.add("done");
    stopL();
    const from = gShown, to = geomL();
    renderL(from ? lerpGeom(from, to, 0) : to);
    if (from) stopL = tween(DUR4, (p) => drawL(lerpGeom(from, to, eio(p))));
  });
  markTerms(); renderL();
  {
    const combos = [];
    LT.dscr.forEach((d) => LT.amort.forEach((a) => Object.keys(LT.caps).forEach((c) => LT.rates.forEach((r) => {
      const s = { dscr: d, amort: a, cap: c, rate: r }; if (lineNow(s)) combos.push(sayL(s)); }))));
    reserve($("#bigLc"), combos.map((s) => s.cap)); reserve($("#ansL"), combos.map((s) => s.ans), { html: true });
    reserve($("#revL"), combos.map((s) => s.rev), { html: true }); reserve($("#termsL"), combos.map((s) => s.terms));
  }
  $("#tLr").textContent = fmt(LT.runs);
  // minutes on the ticker, and what that is per run, so a long sweep never reads as a slow model
  const tickL = (n) => { $("#tLn").textContent = fmt(n); $("#tLs").textContent = (n / LT.runs * LT.seconds / 60).toFixed(1); };
  $("#tLe").textContent = ` · ${(LT.seconds / LT.runs).toFixed(2)} s a run`;
  fixTicker("#tLn", "#tLs", LT.runs, (LT.seconds / 60).toFixed(1));
  tickL(reduce ? LT.runs : 0);
  if (reduce) beatL.classList.add("done");
  else countIn(beatL, LT.runs, (n, q) => { if (beatL.classList.contains("done")) return; stL.q = q; tickL(n); drawL(geomL()); },
    () => { tickL(LT.runs); if (stL.q < 1) { stL.q = 1; drawL(geomL()); } beatL.classList.add("done"); });

  // beat 4: the operator's question. Staffing held where it is: wage growth across, occupancy up, at three fees.
  // A square holds when the LP still earns its pref and no year after lease-up drops below the coverage minimum
  const OPD = opData, beatO = $("#beatO"), OW = OPD.wage, OO = OPD.occ;
  const PREF = ((ctxData.believe.lean.find((l) => l.id === "pref") || { base: 8 }).base) / 100, DMIN = TM.dscr_min;
  const FO = { w: 560, h: 330, l: 50, r: 14, t: 10, b: 38 };
  const owc = (FO.w - FO.l - FO.r) / OW.length, ohc = (FO.h - FO.t - FO.b) / OO.length;
  const stO = { f: Math.max(0, OPD.fees.findIndex((f) => near(f, OPD.base.fee))), shown: reduce ? OPD.runs : 0 };
  const oCells = [];
  for (let j = 0; j < OO.length; j++) for (let i = 0; i < OW.length; i++)
    oCells.push(`<rect x="${(FO.l + i * owc).toFixed(1)}" y="${(FO.t + (OO.length - 1 - j) * ohc).toFixed(1)}" width="${(owc - 1).toFixed(1)}" height="${(ohc - 1).toFixed(1)}" data-i="${i}" data-j="${j}"/>`);
  const oBx = FO.l + OW.findIndex((w) => near(w, OPD.base.wage)) * owc + owc / 2, jOB = OO.findIndex((o) => near(o, OPD.base.occ));
  const oBy = FO.t + (OO.length - 1 - jOB) * ohc + ohc / 2, oMid = FO.t + (FO.h - FO.t - FO.b) / 2;
  $("#plotO").innerHTML = `<svg viewBox="0 0 ${FO.w} ${FO.h}" id="svgO" role="img" aria-label="Which combinations of wage growth and occupancy the deal can carry, at the management fee you pick">` +
    `<defs><pattern id="hatchO" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" stroke-width="1.3"/></pattern></defs>` +
    `<g id="oCells">${oCells.join("")}</g><g id="oCut"></g>` +
    `<circle cx="${oBx}" cy="${oBy}" r="6" fill="none" stroke="var(--accent)" stroke-width="2.2"/><text class="halo af" x="${oBx + 9}" y="${oBy - 8}">the deal today</text>` +
    txt(FO.l, FO.h - 20, "+" + OW[0] + "%") + txt(FO.w - FO.r, FO.h - 20, "+" + OW[OW.length - 1] + "%", "end") + txt((FO.l + FO.w - FO.r) / 2, FO.h - 4, "wage growth a year, every role →", "middle") +
    txt(FO.l - 8, FO.t + 10, pct(OO[OO.length - 1], 0), "end") + txt(FO.l - 8, FO.h - FO.b, pct(OO[0], 0), "end") +
    `<text x="12" y="${oMid}" transform="rotate(-90 12 ${oMid})" text-anchor="middle">occupancy</text></svg>`;
  const oRects = $$("#oCells rect");
  const oCellAt = (f, j, i) => OPD.cells[f].grid[j][i];
  const oCell = (j, i) => oCellAt(stO.f, j, i);
  const lpOK = (c) => c[0] != null && c[0] >= PREF, covOK = (c) => c[1] == null || c[1] >= DMIN;
  // the most wage growth at today's occupancy before either breaks, and which breaks first
  const wageRoom = (f) => {
    const g = OPD.cells[f].grid[jOB]; let w = -1;
    for (let i = 0; i < OW.length; i++) { if (lpOK(g[i]) && covOK(g[i])) w = i; else break; }
    const nx = w + 1 < OW.length ? g[w + 1] : null;
    return { w, by: nx == null ? null : !covOK(nx) ? "coverage" : "lp" };
  };
  // what beat 4 says at a fee
  const sayO = (f) => {
    let held = 0; for (let j = 0; j < OO.length; j++) for (let i = 0; i < OW.length; i++) { const c = oCellAt(f, j, i); if (lpOK(c) && covOK(c)) held++; }
    const fee = OPD.fees[f], room = wageRoom(f);
    const others = OPD.fees.map((x, n) => [x, wageRoom(n)]).filter(([, r], n) => n !== f);
    return {
      big: room.w < 0 ? "none" : room.by == null ? "+" + OW[room.w] + "%+" : "+" + OW[room.w] + "%",
      cap: room.w < 0 ? `no wage path here keeps the LP's ${pct(PREF, 0)} pref and ${DMIN.toFixed(2)}x coverage at ${pct(OO[jOB], 0)} occupancy and a ${pct(fee, 0)} fee`
        : `a year: the most wage growth the deal carries at ${pct(OO[jOB], 0)} occupancy and a ${pct(fee, 0)} fee` +
          (room.by == null ? ", across every path here" : room.by === "coverage" ? `, before a year drops below ${DMIN.toFixed(2)}x debt coverage` : `, before the LP misses its ${pct(PREF, 0)} pref`),
      ans: `<b>${held}</b> of ${fmt(OW.length * OO.length)} squares hold at a ${pct(fee, 0)} fee. ` +
        others.map(([x, r], n) => `${n ? "at" : "At"} ${pct(x, 0)}: ${r.w < 0 ? "none" : "+" + OW[r.w] + "%"}`).join("; ") + "." };
  };
  function renderO() {
    let cutSvg = "";
    oRects.forEach((r) => {
      const i = +r.dataset.i, j = +r.dataset.j, c = oCell(j, i), on = i * OO.length + j < stO.shown * (OW.length * OO.length) / OPD.runs;
      setStyle(r, "fill", !on ? "var(--paper-deep)" : lpOK(c) ? "color-mix(in oklch, var(--proof) 72%, var(--paper))" : inkMix(c[0] ?? 0));
      if (on && !covOK(c)) cutSvg += `<rect x="${r.getAttribute("x")}" y="${r.getAttribute("y")}" width="${r.getAttribute("width")}" height="${r.getAttribute("height")}"/>`;
    });
    if ($("#oCut")._h !== cutSvg) { $("#oCut").innerHTML = cutSvg; $("#oCut")._h = cutSvg; }
    const s = sayO(stO.f);
    setBump($("#bigO"), s.big);
    $("#bigOc").textContent = s.cap;
    setHTML($("#ansO"), s.ans);
  }
  $("#feesO").innerHTML = `<span class="tk">Fee</span>` + OPD.fees.map((f, n) => `<button type="button" data-n="${n}">${pct(f, 0)}</button>`).join("");
  const markFee = () => $$("#feesO button").forEach((b) => b.classList.toggle("on", +b.dataset.n === stO.f));
  $("#feesO").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; stO.f = +b.dataset.n; stO.shown = OPD.runs; markFee(); renderO(); beatO.classList.add("done"); });
  const hovO = $("#hovO"); let oHover = null;
  const readO = (f, j, i) => { const c = oCellAt(f, j, i);
    return `${pct(OO[j], 0)} occupancy · wages +${OW[i]}% a year → LP IRR ${c[0] == null ? "n/a" : pct(c[0])} · weakest year ${c[1] == null ? "n/a" : c[1].toFixed(2) + "x"}`; };
  const pickO = (e) => {
    if (stO.shown < OPD.runs) return;
    const svg = $("#svgO"), r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * FO.w, py = (e.clientY - r.top) / r.height * FO.h;
    const i = Math.floor((px - FO.l) / owc), j = OO.length - 1 - Math.floor((py - FO.t) / ohc);
    const el = i >= 0 && i < OW.length && j >= 0 && j < OO.length ? oRects[j * OW.length + i] : null;
    if (oHover === el) return;
    if (oHover) { oHover.removeAttribute("stroke"); oHover.removeAttribute("stroke-width"); }
    oHover = el;
    if (!el) { hovO.textContent = "Point at a square to see its run."; return; }
    el.setAttribute("stroke", "var(--ink)"); el.setAttribute("stroke-width", "1.5");
    hovO.textContent = readO(stO.f, j, i);
  };
  $("#svgO").addEventListener("pointermove", pickO); $("#svgO").addEventListener("pointerdown", pickO);
  $("#svgO").addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && oHover) { oHover.removeAttribute("stroke"); oHover = null; hovO.textContent = "Point at a square to see its run."; } });
  if (matchMedia("(hover: none)").matches) hovO.textContent = "Tap a square to see its run.";
  markFee(); renderO();
  {
    const all = OPD.fees.map((f, n) => sayO(n));
    reserve($("#bigOc"), all.map((s) => s.cap)); reserve($("#ansO"), all.map((s) => s.ans), { html: true });
    const reads = []; OPD.fees.forEach((f, n) => { for (let j = 0; j < OO.length; j++) for (let i = 0; i < OW.length; i++) reads.push(readO(n, j, i)); });
    reserve(hovO, [hovO.textContent, ...reads]);
  }
  $("#tOr").textContent = fmt(OPD.runs);
  fixTicker("#tOn", "#tOs", OPD.runs, OPD.seconds.toFixed(1));
  tick(reduce ? OPD.runs : 0, OPD.runs, OPD.seconds, "#tOn", "#tOs");
  if (reduce) beatO.classList.add("done");
  else countIn(beatO, OPD.runs, (n) => { if (beatO.classList.contains("done")) return; stO.shown = n; tick(n, OPD.runs, OPD.seconds, "#tOn", "#tOs"); renderO(); },
    () => { stO.shown = OPD.runs; tick(OPD.runs, OPD.runs, OPD.seconds, "#tOn", "#tOs"); renderO(); beatO.classList.add("done"); });

  // beat 5: everything at once. Columns move operations (occupancy down, wage growth up), rows move capital markets
  // (exit cap and rate up); every cell one run with loan sizing and the waterfall. Then occupancy alone, to show who
  // loses first: the equity against the debt, and the GP against the deal
  const SX = stress, beatS = $("#beatS"), MXF = ["Deal IRR", "LP IRR", "GP IRR"];
  let mxF = 2, mxSel = null, mxIn = reduce ? SX.grid.flat().length : 0;
  const bp = (b) => (b == null ? "n/a" : (b / 100).toFixed(2) + "%");
  // the exit cap, shown as a spread over the entry yield (stabilized NOI over the price, as underwritten)
  const overEntry = (exitPct) => { const s = Math.round((exitPct / 100 - SX.entry_yield) * 10000);
    return `exit ${s < 0 ? "−" : "+"}${Math.abs(s)} bps vs entry`; };
  // the matrix is built once; a change of whose return, a selection or a cell coming in changes each cell in place
  {
    let h = `<thead><tr><th class="corner">capital markets ↓<br>operations →</th>` +
      SX.cols.map((c) => `<th scope="col"><span class="ml">${c.label}</span><span class="md">${c.occ}% · wages +${c.wage}%</span></th>`).join("") + "</tr></thead><tbody>";
    SX.rows.forEach((r, i) => {
      h += `<tr><th scope="row"><span class="ml">${r.label}</span><span class="md">${overEntry(r.exit)} · rate ${r.rate.toFixed(2)}%</span></th>` +
        SX.grid[i].map((c, j) => `<td><button type="button" class="mc" data-r="${i}" data-c="${j}"></button></td>`).join("") + "</tr>";
    });
    $("#mx").innerHTML = h + "</tbody>";
  }
  const mxCells = $$("#mx .mc");
  if (!reduce) $("#mx").classList.add("counting");
  function renderMx() {
    const vals = SX.grid.flat().map((c) => c[mxF]).filter((v) => v != null), lo = Math.min(...vals), hi = Math.max(...vals);
    const tone = (b) => { if (b == null) return ["var(--paper-deep)", ""];
      const up = b >= SX.pref_bps, t = up ? (b - SX.pref_bps) / Math.max(1, hi - SX.pref_bps) : (SX.pref_bps - b) / Math.max(1, SX.pref_bps - lo);
      const mix = Math.round(14 + Math.min(1, t) * 46);
      return [`color-mix(in oklch, var(${up ? "--proof" : "--ink"}) ${mix}%, var(--paper))`, !up && mix >= 36 ? "var(--paper)" : ""]; };
    mxCells.forEach((b, k) => {
      const i = +b.dataset.r, j = +b.dataset.c, c = SX.grid[i][j], [bg, fg] = tone(c[mxF]);
      const cls = "mc" + (i === SX.base[0] && j === SX.base[1] ? " base" : "") + (c[mxF] != null && c[mxF] < SX.pref_bps ? " below" : "") +
        (mxSel && mxSel[0] === i && mxSel[1] === j ? " sel" : "") + (k < mxIn ? " in" : "");
      if (b.className !== cls) b.className = cls;
      setStyle(b, "backgroundColor", bg); setStyle(b, "color", fg);
      const v = bp(c[mxF]); if (b.textContent !== v) b.textContent = v;
    });
    const keep = SX.grid.flat().filter((c) => c[1] != null && c[1] >= SX.pref_bps).length, n = SX.grid.flat().length;
    setHTML($("#ansS"), `<b>${keep}</b> of ${n} keep the LP at its ${bp(SX.pref_bps)} pref. The base case is outlined.`);
  }
  const readMx = (i, j) => { const c = SX.grid[i][j], col = SX.cols[j], row = SX.rows[i];
    return `${col.label} operations (${col.occ}%, wages +${col.wage}%) × ${row.label} capital markets (${overEntry(row.exit)}, rate ${row.rate.toFixed(2)}%) → ` +
      `Deal ${bp(c[0])} · LP ${bp(c[1])} · GP ${bp(c[2])} · unlevered ${bp(c[3])} · loan ${c[4] == null ? "n/a" : fmtM2(c[4])} · coverage ${c[5] == null ? "n/a" : (c[5] / 100).toFixed(2) + "x"}`; };
  const mxShow = (i, j) => { $("#mxDetail").textContent = readMx(i, j); };
  $("#mx").addEventListener("click", (e) => { const b = e.target.closest(".mc"); if (!b) return; mxSel = [+b.dataset.r, +b.dataset.c]; renderMx(); mxShow(mxSel[0], mxSel[1]); });
  $("#mx").addEventListener("pointerover", (e) => { const b = e.target.closest(".mc"); if (b) mxShow(+b.dataset.r, +b.dataset.c); });
  $("#mx").addEventListener("focusin", (e) => { const b = e.target.closest(".mc"); if (b) mxShow(+b.dataset.r, +b.dataset.c); });
  $("#mxWho").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; mxF = +b.dataset.f;
    $$("#mxWho button").forEach((x) => x.classList.toggle("on", x === b)); renderMx(); });
  if (matchMedia("(hover: none)").matches) $("#mxDetail").textContent = "Tap a cell to see its run.";
  renderMx();
  {
    const reads = []; SX.grid.forEach((row, i) => row.forEach((c, j) => reads.push(readMx(i, j))));
    reserve($("#mxDetail"), [$("#mxDetail").textContent, ...reads]);
  }
  {
    // occupancy alone: the first step where leverage turns on the equity, how hard the GP falls, and where the promote is gone
    const R = SX.occ_runs, S = SX.occ_steps, b0 = R[0], lines = [];
    const flip = R.findIndex((c) => c[0] != null && c[3] != null && c[0] < c[3]);
    if (flip > 0) lines.push(`<li><b>${Math.abs(S[flip])} points</b> of occupancy lost and the debt starts costing the equity: ${bp(R[flip][0])} levered against ${bp(R[flip][3])} without the loan.</li>`);
    const mid = S.indexOf(-5);
    if (mid > 0 && R[mid][0] != null && R[mid][2] != null) {
      const dDeal = b0[0] - R[mid][0], dGp = b0[2] - R[mid][2];
      lines.push(`<li>At <b>5 points</b> down, the deal loses ${fmt(dDeal)} bps and the GP ${fmt(dGp)}: about <b>${(dGp / dDeal).toFixed(1)} times</b> as much.</li>`);
    }
    const flat = R.findIndex((c) => c[0] != null && c[0] === c[1] && c[1] === c[2]);
    if (flat > 0) lines.push(`<li>At <b>${Math.abs(S[flat])} points</b> down, deal, LP and GP all land on ${bp(R[flat][0])}: below the pref, the promote is gone.</li>`);
    setHTML($("#revS"), lines.join(""));
  }
  $("#tSr").textContent = fmt(SX.runs);
  fixTicker("#tSn", "#tSs", SX.runs, SX.seconds.toFixed(1));
  const nCells = mxCells.length;
  tick(reduce ? SX.runs : 0, SX.runs, SX.seconds, "#tSn", "#tSs");
  if (reduce) beatS.classList.add("done");
  else countIn(beatS, SX.runs, (n, q) => { tick(n, SX.runs, SX.seconds, "#tSn", "#tSs"); const k = Math.round(q * nCells); if (k !== mxIn) { mxIn = k; renderMx(); } },
    () => { mxIn = nCells; renderMx(); $("#mx").classList.remove("counting"); beatS.classList.add("done"); });

  // beat 6: twenty assumptions on the odds board (web/odds.js). Every share it shows is counted from
  // futures.json in the browser; the script believes, one at a time, the three assumptions the futures
  // that reach 22% lean on most (context.json), each on its better side of today's value
  const B3 = ctxData.believe, T3 = B3.gp_at_least;
  // plain names for the assumptions; the numbers still come from the data
  const PLAIN = { occ: "occupancy", arent: "assisted-living rent", mrent: "memory-care rent", lease: "lease-up", cna: "aide hours per resident day",
    lpn: "licensed-nurse staffing", opex: "non-labor cost growth", conc: "resident concessions", ptax: "property-tax growth", mgmt: "management fee", price: "purchase price", hold: "hold",
    ltc: "loan-to-cost", coinv: "GP co-invest", exit: "exit cap vs entry", rate: "interest rate" };
  const fmtBase = (l) => {
    const v = l.base;
    if (l.unit === "$") return "$" + Math.round(v).toLocaleString("en-US") + " a month";
    if (l.unit === "$M") return "$" + v.toFixed(1) + "M";
    if (l.unit === " mo") return v + " months";
    if (l.unit === " FTE") return (+v.toFixed(2)) + " FTEs";
    if (l.unit === "") return (+v.toFixed(2)) + " a resident-day";
    return (+v.toFixed(2)) + l.unit;
  };
  const plainName = (l) => PLAIN[l.id] || l.label;
  const better = (l) => (l.side === "above" ? [l.base, null] : [null, l.base]);
  // staffing levels stay on the board, but the script never sells thinner care: it believes rents and growth
  const CARE = new Set(["cna", "lpn"]);
  const top3 = B3.lean.filter((l) => !CARE.has(l.id)).slice(0, 3);
  // which side of the deal the top three are on, and which assumptions hardly lean at all (under 5 points either way)
  const nBld = top3.filter((l) => l.group === "the building").length;
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const ranked = B3.lean.filter((l) => !CARE.has(l.id)), firstDeal = ranked.find((l) => l.group === "the deal");
  const ORD = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  $("#kicker").textContent = (nBld === 3 ? "All three are about the building." : nBld === 2 ? "Two of the three are about the building." : "") +
    (nBld >= 2 && firstDeal ? ` ${cap(plainName(firstDeal))}, the first of the deal's terms, ranks ${ORD[ranked.indexOf(firstDeal) + 1] || ranked.indexOf(firstDeal) + 1}.` : "");
  const NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
    "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const flatL = B3.lean.filter((l) => Math.abs(l.keep - l.all) < 0.05);
  const and = (xs) => xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
  $("#tally").textContent = fmt(RUNS1 + RUNS2 + LT.runs + OPD.runs + SX.runs + B3.futures);

  const boardRoot = $("#board"), say = (t) => { $("#oddsSay").textContent = t; };
  let board = null, prev = null, timers = [], scripted = true;
  // whose return the board counts: the GP's 22% (the story's script) or the LP's 15%, each with its own sense of "better"
  const VIEWS = { gp: { key: "gp", field: "gp_irr", T: T3, metric: "GP IRR" }, lp: { key: "lp", field: "lp_irr", T: 15, metric: "LP IRR" } };
  let W = VIEWS.gp, FUT = null, LPV = null, few = null, kickGP = "", flatGP = "";
  const capOf = (any, fit, V) => !any ? `sampled scenarios of the deal reach ${V.metric} of ${V.T}% or more.`
    : fit ? `scenarios that fit what you believe reach ${V.metric} of ${V.T}% or more.` : "No scenario fits all of that. Let something go.";
  const chipsOf = (list) => "You believe " + list.map((b) => `<b>${b.name}</b> ${b.text}`).join(" · ") + ' <button type="button" class="ob-clear">clear</button>';
  // the presets show which one the reader believes, until they change a row themselves
  const markPreset = (b) => $$("#presets button").forEach((x) => x.classList.toggle("on", x === b));
  const showOdds = (st, user) => {
    const any = Object.keys(st.beliefs).length > 0;
    // where the count started stays in its place, faded until there is a belief, so the answer never moves
    boardRoot.classList.toggle("nobel", !any);
    // counts of runs, never a percentage: "375 of 627" cannot be mistaken for a forecast
    $("#oddsFrom").textContent = `${fmt(st.held)} of ${fmt(st.total)}`;
    const to = any ? `${fmt(st.hold)}<small> of ${fmt(st.fit)}</small>` : `${fmt(st.held)}<small> of ${fmt(st.total)}</small>`, el = $("#oddsTo");
    if (el.innerHTML !== to) { el.innerHTML = to; retrigger(el, "bump"); }
    $("#oddsCap").textContent = capOf(any, st.fit, W);
    $("#oddsChips").innerHTML = any ? chipsOf(Object.values(st.beliefs)) : "";
    // a belief that barely moves the odds says so, so a flat row never looks broken
    if (user) { markPreset(null); say(prev !== null && st.odds !== null && Math.abs(st.odds - prev) < 0.02 ? `That barely changes how many reach ${W.T}%.` : ""); }
    prev = st.odds;
  };
  const stopScript = () => { if (!scripted) return; scripted = false; timers.forEach(clearTimeout); timers = []; beat3.classList.add("done"); };
  $("#oddsChips").addEventListener("click", (e) => { if (e.target.closest(".ob-clear") && board) { stopScript(); markPreset(null); board.clear(); say(""); } });
  const play = () => {
    board.play();
    const st0 = board.state();
    say(`${fmt(st0.total)} scenarios of the deal, each one run through the model. ${fmt(st0.held)} of them reach GP IRR of ${T3}% or more.`);
    const steps = top3.map((l, k) => () => { board.set(l.id, better(l)); say(`${k ? "…and " : "Believe "}${plainName(l)} ${l.side} today's ${fmtBase(l)}.`); });
    steps.push(() => { const st = board.state(); say(`Believe all three: ${fmt(st.fit)} scenarios are left, and ${fmt(st.hold)} of them reach ${T3}%.`); stopScript(); });
    if (reduce) { steps.forEach((fn) => fn()); return; }
    let at = 2800;
    steps.forEach((fn) => { timers.push(setTimeout(() => { if (scripted) fn(); }, at)); at += 2400; });
  };
  // the LP's view of the same runs: which end of each row is better for LP IRR, read off the runs (rank correlation)
  const ranks = (a) => { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Float64Array(a.length);
    for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; } return s / Math.sqrt(sa * sb); };
  function lpView(F) {
    const at = F.row_fields.indexOf("lp_irr"), rows = F.rows.slice(1), ok = rows.map((r) => r[at]).filter((v) => v != null);
    const lo = Math.min(...ok), ry = ranks(rows.map((r) => (r[at] == null ? lo - 1 : r[at])));
    const dims = F.dims.map((d, k) => ({ ...d, flip: corr(ranks(rows.map((r) => r[k])), ry) < 0 }));
    // what the runs that give the LP its 15% lean on: the share on the better side of today, against all runs
    const hold = rows.filter((r) => r[at] != null && r[at] >= VIEWS.lp.T);
    const side = (d, v) => (d.flip ? v <= d.base : v >= d.base);
    const lean = dims.map((d, k) => ({ id: d.id, label: d.label, lean: hold.filter((r) => side(d, r[k])).length / Math.max(1, hold.length) - rows.filter((r) => side(d, r[k])).length / rows.length }))
      .sort((a, b) => b.lean - a.lean);
    return { ...F, dims, irr: { lo: Math.floor(lo), hi: Math.ceil(Math.max(...ok)) }, lean };
  }
  const keepFew = () => { if (few && boardRoot.classList.contains("ob-few")) $$(".ob-row", boardRoot).forEach((r) => r.classList.toggle("keep", few.has(r.dataset.id))); };
  const q5Of = (V) => (V.key === "lp" ? `Twenty assumptions at once. For the LP to reach ${V.T}%, what has to be true?`
    : `Twenty assumptions at once. For GP IRR to reach ${T3}%, what has to be true?`);
  const kickLPOf = (L) => `For the LP's ${VIEWS.lp.T}%, the three it leans on most: ${and(L.lean.filter((l) => !CARE.has(l.id)).slice(0, 3).map(plainName))}.`;
  // a change of whose return carries the same board over: the dots move from where they are, nothing is poured again
  $("#whose").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]"); if (!b || !board || b.dataset.m === W.key) return;
    stopScript(); W = VIEWS[b.dataset.m]; prev = null; markPreset(null);
    $$("#whose button").forEach((x) => x.classList.toggle("on", x === b));
    if (W.key === "lp" && !LPV) LPV = lpView(FUT);
    board.view({ data: W.key === "lp" ? LPV : FUT, target: W.T, field: W.field, metric: W.metric });
    const st = board.state();
    $("#q5").textContent = q5Of(W);
    if (W.key === "lp") {
      $("#kicker").textContent = kickLPOf(LPV);
      $("#flat").textContent = "";
      say(`${fmt(st.total)} scenarios, the same runs. ${fmt(st.held)} of them give the LP ${W.T}% or more.`);
    } else { $("#kicker").textContent = kickGP; $("#flat").textContent = flatGP; say(""); }
  });
  // believe several rows together: the honest way to say they move together, with no correlation made up
  const PRESETS = { soft: ["occ", "arent", "mrent", "rgrow"], labor: ["wage", "opex"], capital: ["exit", "rate"] };
  $("#presets").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]"); if (!b || !board) return;
    stopScript(); board.clear();
    const dims = (W.key === "lp" ? LPV : FUT).dims;
    PRESETS[b.dataset.p].forEach((id) => { const d = dims.find((x) => x.id === id); if (d) board.set(id, d.flip ? [d.base, null] : [null, d.base]); });
    markPreset(b);
    const st = board.state();
    say(`${b.textContent}: ${fmt(st.fit)} scenarios fit, and ${fmt(st.hold)} of them reach ${W.metric} of ${W.T}%.`);
  });
  const mountBoard = (futures) => {
    if (!window.OddsBoard) { beat3.hidden = true; return; }
    // the exit cap row reads as a spread over the entry yield (its runs are unchanged)
    futures.dims.forEach((d) => { if (d.id === "exit") d.spread = SX.entry_yield * 100; });
    FUT = futures;
    board = window.OddsBoard.mount(boardRoot, { data: futures, target: T3, names: PLAIN });
    board.onChange = showOdds;
    board.onUser = stopScript;
    showOdds(board.state(), false);
    // the honest punchline: three that barely move GP IRR across their ranges, believed instead, side by side
    // with the three above (care staffing is never offered as one that doesn't matter)
    const f3 = flatL.filter((l) => !CARE.has(l.id)).slice(0, 3), o3 = board.oddsFor(Object.fromEntries(f3.map((l) => [l.id, better(l)])));
    few = new Set(B3.lean.filter((l) => !CARE.has(l.id)).slice(0, 5).map((l) => l.id));
    $("#noIrr").textContent = `${fmt(futures.no_irr)} of the ${fmt(futures.rows.length)} runs have no GP IRR at all; they sit at the far left.`;
    const oT = board.oddsFor(Object.fromEntries(top3.map((l) => [l.id, better(l)])));
    $("#flat").textContent = flatL.length > 1 ? `${cap(NUM[flatL.length])} of the ${NUM[B3.assumptions]} barely move GP IRR across the ranges drawn here. ` +
      `Believe three of them instead (${and(f3.map(plainName))}): ${fmt(o3.hold)} of ${fmt(o3.fit)} scenarios reach ${T3}%, ` +
      `against ${fmt(oT.hold)} of ${fmt(oT.fit)} for the three above.` : "";
    kickGP = $("#kicker").textContent; flatGP = $("#flat").textContent;
    // a phone opens the board on six rows, the three the script believes and the three set against them
    const phone = matchMedia("(max-width: 859px)").matches;
    if (phone) {
      boardRoot.classList.add("ob-few");
      keepFew();
      const more = document.createElement("button");
      more.type = "button"; more.className = "ob-more"; more.textContent = `Show all ${NUM[B3.assumptions]} rows`;
      more.addEventListener("click", () => { boardRoot.classList.remove("ob-few"); more.remove(); });
      $(".ob-cols", boardRoot).after(more);
    }
    // the room every sentence of the board needs, for both views, so the pile and the rows never move
    {
      const st = board.state(), lpAt = futures.row_fields.indexOf("lp_irr"), lpHeld = futures.rows.filter((r) => r[lpAt] != null && r[lpAt] >= VIEWS.lp.T).length;
      const fitT = board.oddsFor(Object.fromEntries(top3.map((l) => [l.id, better(l)])));
      const big = fmt(st.total);
      const says = [`${fmt(st.total)} scenarios of the deal, each one run through the model. ${fmt(st.held)} of them reach GP IRR of ${T3}% or more.`,
        ...top3.map((l, k) => `${k ? "…and " : "Believe "}${plainName(l)} ${l.side} today's ${fmtBase(l)}.`),
        `Believe all three: ${fmt(fitT.fit)} scenarios are left, and ${fmt(fitT.hold)} of them reach ${T3}%.`,
        `${fmt(st.total)} scenarios, the same runs. ${fmt(lpHeld)} of them give the LP ${VIEWS.lp.T}% or more.`,
        `That barely changes how many reach ${T3}%.`,
        ...$$("#presets button").map((b) => `${b.textContent}: ${big} scenarios fit, and ${big} of them reach ${VIEWS.lp.metric} of ${T3}%.`)];
      reserve($("#oddsSay"), says);
      reserve($("#oddsCap"), [VIEWS.gp, VIEWS.lp].flatMap((V) => [capOf(false, 1, V), capOf(true, 1, V), capOf(true, 0, V)]));
      const lab = (id) => { const d = futures.dims.find((x) => x.id === id); return d ? PLAIN[id] || d.label : null; };
      const chip = (id, range) => ({ name: lab(id), text: range[0] != null ? board.fmt(id, range[0]) + " or more" : board.fmt(id, range[1]) + " or less" });
      const scriptChips = top3.map((l) => chip(l.id, better(l)));
      const chipSets = [scriptChips.slice(0, 1), scriptChips.slice(0, 2), scriptChips];
      if (!phone) Object.values(PRESETS).forEach((ids) => chipSets.push(ids.filter(lab).map((id) => { const d = futures.dims.find((x) => x.id === id); return chip(id, d.flip ? [d.base, null] : [null, d.base]); })));
      reserve($("#oddsChips"), chipSets.map(chipsOf), { html: true });
      reserve($("#beat3 .q"), [q5Of(VIEWS.gp), q5Of(VIEWS.lp)], { into: $("#q5") });
      LPV = LPV || lpView(futures);
      reserve($("#kicker"), [kickGP, kickLPOf(LPV)]);
      reserve($("#flat"), [flatGP]);
    }
    whenSeen($(".ob-top", boardRoot), play, 0.6);
  };
  // futures.json is ~650 KB: fetch it when the board is a screen away
  if (beat3 && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      json("/static/story/futures.json").then(mountBoard).catch((e) => { console.error(e); beat3.hidden = true; });
    }, { rootMargin: "100% 0px 100% 0px" });
    io.observe(beat3);
  } else if (beat3) {
    json("/static/story/futures.json").then(mountBoard).catch((e) => { console.error(e); beat3.hidden = true; });
  }

  window.__story = {
    go(id, t) { const ch = CH.find((c) => c.id === id); const i = Math.min(ch.off.length - 1, Math.floor(t)); scrollTo(0, ch.root.getBoundingClientRect().top + scrollY + ch.off[i] + (t - i) * ch.len[i] + 1); },
    settled: () => CH.every((c) => { const r = c.root.getBoundingClientRect(); return !r.height || r.bottom < -50 || r.top > innerHeight + 50 || Math.abs(target(c) - c.shown) < 1e-3; }),
    chapters: CH,
  };
})();
