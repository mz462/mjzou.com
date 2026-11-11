(function () {
  'use strict';

  /* Chat-first demo page. Adapted from the reviewed workstation renderers
     (markdown narration, solver) with two hard red lines:
     - every dynamic string enters the DOM via textContent (element() /
       document.createTextNode / appendInlineMarkdown) — no HTML-string
       injection pathway exists in this file;
     - no number is computed here beyond formatting: deltas come from the
       server's delta_vs_base / is_base enrichment, values from payloads. */

  const LANDING_MODEL_ID = 'cleanroom_senior_living';

  const state = {
    catalog: null,
    modelId: new URLSearchParams(window.location.search).get('model_id') || LANDING_MODEL_ID,
    busy: false,
    railOpen: !window.matchMedia('(max-width: 900px)').matches,
    lastScenarios: [],
    lastRun: null,
    activeTrace: null,
    suggestions: [],
    askedPresetIds: new Set(),
    instances: [],
    conversation: [],
    inputMeta: {},
    // Journey step 6: the boundary card renders once per page load, after the
    // first successful save or export — an in-memory flag, so it never nags.
    boundaryShown: false,
    // performance.now() of the last card or narration to land: the rest of
    // the landing (narration, trace collapse, Tab hint) is timed from it.
    lastArrival: -Infinity,
    // Rail values as last shown, so a new run cross-fades over the old one.
    railShown: null,
  };

  const $ = (selector) => document.querySelector(selector);

  // The motion tokens live in site.css (:root) and shrink under reduced
  // motion; JS timings read them so CSS and JS keep one rhythm.
  function tokenMs(name) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return 0;
    return /ms$/.test(raw) ? value : value * 1000;
  }

  function reducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Waits until `delay` ms after the last arrival (never negative).
  function afterArrival(delay) {
    return Math.max(0, state.lastArrival + delay - performance.now());
  }

  function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    if (options.attrs) {
      Object.entries(options.attrs).forEach(([key, value]) => {
        if (value !== undefined && value !== null) node.setAttribute(key, String(value));
      });
    }
    return node;
  }

  function displayText(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return String(value);
  }

  function titleCase(value) {
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function humanizeId(id) {
    return titleCase(id);
  }

  // The page is English copy; pin number formatting to en-US so a zh-CN
  // browser does not render "US$764万" beside "$226,977".
  const NUMBER_LOCALE = 'en-US';

  // User-facing name for a model. Raw registry ids never reach the page
  // (they can carry internal names, see tests/test_neutral_model_name.py).
  function modelDisplayName(modelId) {
    const catalog = state.catalog || {};
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const match = [catalog.model, ...models].find((item) => item && item.id === (modelId || state.modelId));
    return match?.name || 'the model';
  }

  function modelFileStem(modelId) {
    const stem = modelDisplayName(modelId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return stem || 'model';
  }

  function isScalarNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function formatNumber(value, unit = '') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return displayText(value);
    const normalizedUnit = String(unit).toLowerCase();
    if (normalizedUnit.includes('percent') || normalizedUnit === 'decimal') {
      return new Intl.NumberFormat(NUMBER_LOCALE, {
        style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(value);
    }
    if (normalizedUnit === 'pts') {
      // A scenario delta input (-0.05) is a shift in points, not a level.
      const pts = Math.round(value * 1000) / 10;
      if (!pts) return '0 pts';
      return `${pts < 0 ? '−' : '+'}${Math.abs(pts)} ${Math.abs(pts) === 1 ? 'pt' : 'pts'}`;
    }
    if (normalizedUnit.includes('multiple')) return `${value.toFixed(2)}×`;
    if (normalizedUnit.includes('currency') || normalizedUnit === 'usd') {
      const magnitude = Math.abs(value);
      return new Intl.NumberFormat(NUMBER_LOCALE, {
        style: 'currency',
        currency: 'USD',
        notation: magnitude >= 1_000_000 ? 'compact' : 'standard',
        maximumFractionDigits: magnitude >= 1_000_000 ? 2 : (magnitude >= 1_000 ? 0 : 2),
      }).format(value);
    }
    return new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 3 }).format(value);
  }

  // Formats an engine-provided delta (delta_vs_base). Never subtracts here.
  function formatDeltaValue(delta, unit) {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return '—';
    if (delta === 0) return 'no change';
    const normalizedUnit = String(unit).toLowerCase();
    if (normalizedUnit.includes('percent') || normalizedUnit === 'decimal') {
      return `${delta >= 0 ? '+' : ''}${Math.round(delta * 10000)} bp`;
    }
    if (normalizedUnit.includes('multiple')) return `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}×`;
    return `${delta >= 0 ? '+' : ''}${formatNumber(delta, unit)}`;
  }

  // Card footer: the engine's own wall time for this call, so the speed of
  // the compiled workbook is visible next to the LLM's writing time.
  function engineFooterText(payload, label = 'Workbook engine') {
    if (payload?.mock) return 'Fixture engine · not investment output';
    const seconds = payload?.engine_seconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return label;
    const took = seconds < 1 ? `${Math.max(1, Math.round(seconds * 1000))} ms` : `${seconds.toFixed(1)} s`;
    return `${label} · ${took}`;
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
      return payload;
    });
  }

  /* ---------- busy state / toast ---------- */

  let busyStartedAt = 0;
  let busyElapsedTimer = 0;
  let workingTimer = 0;

  function setBusy(busy, label = 'Running verified analysis…') {
    state.busy = busy;
    $('#activity').setAttribute('aria-busy', String(busy));
    // The loader line only shows for work with no trace of its own (the
    // catalog), and only once it has taken longer than --dur-3, so a fast
    // load never flashes it.
    const working = $('#working');
    if (!busy || state.activeTrace) {
      window.clearTimeout(workingTimer);
      workingTimer = 0;
      working.hidden = true;
    } else if (working.hidden && !workingTimer) {
      workingTimer = window.setTimeout(() => {
        workingTimer = 0;
        if (state.busy && !state.activeTrace) working.hidden = false;
      }, tokenMs('--dur-3'));
    }
    $('#model-select').disabled = busy;
    window.clearInterval(busyElapsedTimer);
    if (busy) {
      busyStartedAt = Date.now();
      $('#working-label').textContent = label;
      updateWorkingLabel();
      busyElapsedTimer = window.setInterval(updateWorkingLabel, 100);
    } else {
      $('#working-elapsed').textContent = '';
      $('#working-hint').hidden = true;
    }
    updateComposer();
  }

  function updateWorkingLabel() {
    const elapsed = Math.max(0, (Date.now() - busyStartedAt) / 1000);
    $('#working-elapsed').textContent = elapsed < 60
      ? `${elapsed.toFixed(1)}s`
      : `${Math.floor(elapsed / 60)}m ${(elapsed % 60).toFixed(1)}s`;
    if (elapsed >= 12) $('#working-hint').hidden = false;
  }

  // The toast rises in and fades out (classes, not [hidden], so both ends
  // can transition); it ships hidden so it never flashes on load.
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    if (toast.hidden) {
      toast.hidden = false;
      void toast.offsetWidth;
    }
    toast.classList.add('on');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => { toast.classList.remove('on'); }, 3200);
  }

  // Screen readers hear what lands (a card's title, the narration, a
  // failure) from one quiet live region, not from the whole feed and its
  // 100 ms timers.
  function announce(text) {
    const live = $('#desk-live');
    if (!live || !text) return;
    live.append(element('p', { text }));
    while (live.childElementCount > 4) live.firstElementChild.remove();
  }

  /* ---------- scroll follow ----------
     The feed follows new content only while the reader is within 40 px of
     the bottom, and never past the point where the latest question would
     leave the top. Scrolling up stops the follow; the jump button shows
     whenever there is more below. A new question or the button starts the
     follow again. Following runs from a ResizeObserver (after layout, before
     paint): small steps at once, a landing card in a --dur-3 glide. */

  const FOLLOW_SLACK = 40;
  // Steps up to this many px are taken at once (a trace row); a card or a
  // narration landing glides over --dur-3 on --ease-move instead of jumping.
  const GLIDE_FROM_PX = 48;
  // anchor: the latest question. Following stops where that question would
  // leave the top, so a whole answer never pushes its own question away.
  const scroller = { follow: false, lastTop: 0, anchor: null, glide: null };

  function distanceFromBottom() {
    const activity = $('#activity');
    return activity.scrollHeight - activity.scrollTop - activity.clientHeight;
  }

  function hasConversation() {
    return $('#transcript').childElementCount > 0;
  }

  function updateJump() {
    const show = hasConversation() && !scroller.glide && distanceFromBottom() > FOLLOW_SLACK;
    $('#jump-latest').classList.toggle('on', show);
  }

  // cubic-bezier() from a site.css easing token, for the JS glide.
  function easingToken(name) {
    const match = /cubic-bezier\(([^)]+)\)/.exec(getComputedStyle(document.documentElement).getPropertyValue(name));
    const points = match ? match[1].split(',').map(Number) : [];
    if (points.length !== 4 || points.some((value) => !Number.isFinite(value))) return (x) => x;
    const [x1, y1, x2, y2] = points;
    const curve = (a, b, t) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
    return (x) => {
      let lo = 0;
      let hi = 1;
      let t = x;
      for (let i = 0; i < 24; i += 1) {
        const value = curve(x1, x2, t);
        if (Math.abs(value - x) < 1e-4) break;
        if (value < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return curve(y1, y2, t);
    };
  }

  function followTarget() {
    const activity = $('#activity');
    let target = activity.scrollHeight - activity.clientHeight;
    if (scroller.anchor?.isConnected) {
      // A question settles where the first one sits, under both paddings.
      const pad = (parseFloat(getComputedStyle(activity).paddingTop) || 0)
        + (parseFloat(getComputedStyle($('#transcript')).paddingTop) || 0);
      target = Math.min(target, scroller.anchor.offsetTop - pad);
    }
    // Following only ever moves the reader down.
    return Math.max(activity.scrollTop, target);
  }

  function stepGlide() {
    const glide = scroller.glide;
    if (!glide) return;
    if (!scroller.follow) {
      scroller.glide = null;
      updateJump();
      return;
    }
    const activity = $('#activity');
    const t = Math.min(1, (performance.now() - glide.start) / glide.duration);
    activity.scrollTop = glide.from + (glide.to - glide.from) * glide.ease(t);
    scroller.lastTop = activity.scrollTop;
    if (t < 1) {
      requestAnimationFrame(stepGlide);
    } else {
      scroller.glide = null;
      updateJump();
    }
  }

  function glideTo(target) {
    const activity = $('#activity');
    if (reducedMotion() || Math.abs(target - activity.scrollTop) < GLIDE_FROM_PX) {
      scroller.glide = null;
      activity.scrollTop = target;
      scroller.lastTop = activity.scrollTop;
      return;
    }
    if (scroller.glide && Math.abs(scroller.glide.to - target) < 1) return;
    const running = Boolean(scroller.glide);
    scroller.glide = {
      from: activity.scrollTop,
      to: target,
      start: performance.now(),
      duration: tokenMs('--dur-3'),
      ease: easingToken('--ease-move'),
    };
    if (!running) requestAnimationFrame(stepGlide);
  }

  function pinToBottom() {
    if (scroller.follow && hasConversation()) {
      const target = followTarget();
      if (Math.abs(target - $('#activity').scrollTop) > 0.5) glideTo(target);
    }
    updateJump();
  }

  function followConversation(anchor = null) {
    scroller.follow = true;
    scroller.anchor = anchor;
    pinToBottom();
  }

  function initScrollFollow() {
    const activity = $('#activity');
    activity.addEventListener('scroll', () => {
      const top = activity.scrollTop;
      if (distanceFromBottom() <= FOLLOW_SLACK) scroller.follow = true;
      // Only a move up is the reader's; content growing under a pinned
      // feed leaves scrollTop where it was.
      else if (top < scroller.lastTop - 1) scroller.follow = false;
      scroller.lastTop = top;
      updateJump();
    }, { passive: true });
    // A wheel or finger moving up lets go at once, before its first scroll
    // event, so a pin from arriving content cannot swallow it.
    const scrollable = () => activity.scrollHeight > activity.clientHeight;
    activity.addEventListener('wheel', (event) => {
      if (event.deltaY < 0 && scrollable()) scroller.follow = false;
    }, { passive: true });
    let touchY = null;
    activity.addEventListener('touchstart', (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    activity.addEventListener('touchmove', (event) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y > touchY + 2 && scrollable()) scroller.follow = false;
    }, { passive: true });
    const observer = new ResizeObserver(() => pinToBottom());
    observer.observe($('#transcript'));
    observer.observe(activity);
    // The jump goes all the way down and follows from there.
    $('#jump-latest').addEventListener('click', () => followConversation(null));
  }

  /* ---------- transcript primitives ---------- */

  // The welcome fades and lifts away (--dur-1) before the first turn lands;
  // the request is already in flight while it goes.
  let welcomeLeaving = null;
  function leaveWelcome() {
    const welcome = $('#welcome');
    if (welcome.hidden) return Promise.resolve();
    if (welcomeLeaving) return welcomeLeaving;
    welcome.classList.add('leaving');
    welcomeLeaving = new Promise((resolve) => {
      let timer = 0;
      const done = (event) => {
        if (event && (event.target !== welcome || event.propertyName !== 'opacity')) return;
        welcome.removeEventListener('transitionend', done);
        window.clearTimeout(timer);
        welcome.hidden = true;
        welcome.classList.remove('leaving');
        welcomeLeaving = null;
        resolve();
      };
      welcome.addEventListener('transitionend', done);
      // in case no transition runs at all
      timer = window.setTimeout(done, tokenMs('--dur-1') + tokenMs('--dur-2'));
    });
    return welcomeLeaving;
  }

  // A card, error or note has landed: time the rest of the landing from it.
  function landed(turn) {
    state.lastArrival = performance.now();
    return turn;
  }

  function clearAnalysis() {
    $('#transcript').replaceChildren();
    $('#welcome').hidden = false;
    $('#activity').scrollTop = 0;
    scroller.follow = false;
    scroller.anchor = null;
    scroller.glide = null;
    state.lastArrival = -Infinity;
    state.railShown = null;
    state.lastRun = null;
    state.lastScenarios = [];
    state.suggestions = [];
    state.askedPresetIds = new Set();
    state.conversation = [];
    state.inputMeta = {};
    renderDealState();
    updateSuggestion();
  }

  function userTurn(text) {
    $('#welcome').hidden = true;
    const turn = element('div', { className: 'turn user-row' });
    turn.append(element('div', { className: 'user-turn', text }));
    $('#transcript').append(turn);
    if (text) state.conversation.push({ role: 'user', content: String(text) });
    // A new question always brings the reader to it, and its answer
    // follows below it.
    followConversation(turn);
  }

  // Last 16 user/assistant text turns. Result-card figures stay off this
  // list; deal memory still posts labels + saved inputs only.
  function conversationMessages(currentText) {
    const prior = state.conversation.slice(-16);
    if (!currentText) return prior;
    const last = prior[prior.length - 1];
    if (last && last.role === 'user' && last.content === currentText) return prior;
    return prior.concat([{ role: 'user', content: currentText }]);
  }

  // Every action button in the conversation prefills the composer and never
  // auto-sends: the user stays in command of what is asked.
  function prefillComposer(text) {
    const input = $('#ask-input');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function prefillButton(label, prefill, className = 'demo-prefill-button') {
    const button = element('button', { className, text: label, attrs: { type: 'button' } });
    button.addEventListener('click', () => prefillComposer(prefill));
    return button;
  }

  /* ---------- agent trace (workstation port) ---------- */

  function itemLabel(item) {
    return item.label || item.title || item.matched_reference || item.id || item.key;
  }

  // 8 x 5 chevron, drawn: a 9 px "▾" glyph renders as a dot.
  function chevron(className) {
    const NS = 'http://www.w3.org/2000/svg';
    const wrap = element('span', { className, attrs: { 'aria-hidden': 'true' } });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '8');
    svg.setAttribute('height', '5');
    svg.setAttribute('viewBox', '0 0 8 5');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M1 1l3 3 3-3');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    wrap.append(svg);
    return wrap;
  }

  // After this long a running trace says, quietly, that it is still going.
  const TRACE_NOTE_AFTER_S = 12;

  function createTrace() {
    $('#welcome').hidden = true;
    const el = element('div', { className: 'trace open' });
    const head = element('button', {
      className: 'trace-head',
      attrs: { type: 'button', 'aria-expanded': 'true' },
    });
    const icon = element('span', { className: 'trace-icon' });
    const loader = element('span', { className: 'pixel-loader', attrs: { 'aria-hidden': 'true' } });
    for (let i = 0; i < 9; i += 1) loader.append(element('span'));
    const check = element('span', { className: 'trace-check', attrs: { 'aria-hidden': 'true' } });
    icon.append(loader, check);
    const label = element('span', { className: 'trace-label active', text: 'Dispatching analysis…' });
    const elapsedEl = element('span', { className: 'trace-elapsed' });
    head.append(icon, label, elapsedEl, chevron('trace-chevron'));
    const body = element('div', { className: 'trace-body' });
    const rows = element('div', { className: 'trace-rows' });
    body.append(rows);
    el.append(head, body);
    const turn = element('div', { className: 'turn trace-turn' });
    turn.append(el);
    $('#transcript').append(turn);
    const trace = {
      el, head, icon, check, label, elapsedEl, rows, note: null,
      start: Date.now(), manual: false, settled: false, timer: 0,
    };
    trace.timer = window.setInterval(() => {
      const seconds = (Date.now() - trace.start) / 1000;
      trace.elapsedEl.textContent = seconds < 60
        ? `${seconds.toFixed(1)}s`
        : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
      if (seconds >= TRACE_NOTE_AFTER_S && !trace.note) {
        // Same words as the loader's hint; it fades in under the trace head.
        trace.note = element('p', { className: 'trace-note' });
        trace.note.append(element('span', { text: $('#working-hint').textContent }));
        head.after(trace.note);
      }
    }, 100);
    head.addEventListener('click', () => {
      trace.manual = true;
      const open = el.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
    });
    state.activeTrace = trace;
    return trace;
  }

  function traceStatus(trace, text) {
    if (!trace.settled) trace.label.textContent = text;
  }

  function traceRow(trace, primary, secondary, detail) {
    if (trace.settled) return null;
    const item = element('div', { className: 'trace-item' });
    const expandable = Array.isArray(detail) && detail.length > 0;
    const row = element(expandable ? 'button' : 'div', { className: 'trace-row' });
    if (expandable) {
      row.setAttribute('type', 'button');
      row.setAttribute('aria-expanded', 'false');
      row.addEventListener('click', () => {
        const open = item.classList.toggle('open');
        row.setAttribute('aria-expanded', String(open));
      });
    }
    row.append(element('span', { className: 'tick', text: '✓' }));
    row.append(element('span', { className: 'primary', text: primary }));
    if (secondary) row.append(element('span', { className: 'secondary', text: secondary }));
    if (expandable) row.append(chevron('row-chevron'));
    item.append(row);
    if (expandable) {
      const box = element('div', { className: 'trace-detail' });
      const list = element('div', { className: 'trace-detail-rows' });
      detail.slice(0, 8).forEach((line) => list.append(element('span', { className: 'line', text: line })));
      box.append(list);
      item.append(box);
    }
    trace.rows.append(item);
    return item;
  }

  // Settling: the loader's pixels light in wavefront order, then ✓ (or × on
  // a failure) fades in, and the trace folds away a beat after the last
  // card landed (CSS: .trace.settled).
  function settleTrace(trace, text, { failed = false } = {}) {
    if (!trace || trace.settled) return;
    trace.settled = true;
    window.clearInterval(trace.timer);
    const seconds = (Date.now() - trace.start) / 1000;
    const elapsed = seconds < 1 ? '<1s' : seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
    const steps = trace.rows.childElementCount;
    trace.el.classList.add('settled');
    trace.el.classList.toggle('failed', failed);
    trace.check.textContent = failed ? '×' : '✓';
    trace.elapsedEl.textContent = '';
    trace.label.classList.remove('active');
    trace.label.textContent = text || `Worked for ${elapsed} · ${steps} step${steps === 1 ? '' : 's'}`;
    if (!trace.manual) {
      window.setTimeout(() => {
        if (trace.manual) return;
        trace.el.classList.remove('open');
        trace.head.setAttribute('aria-expanded', 'false');
      }, afterArrival(tokenMs('--dur-3')));
    }
    if (state.activeTrace === trace) state.activeTrace = null;
  }

  function resultShell(kicker, title, meta = '') {
    $('#welcome').hidden = true;
    const turn = element('div', { className: 'turn' });
    const block = element('article', { className: 'result-block' });
    const header = element('header', { className: 'result-header' });
    const heading = element('div');
    heading.append(
      element('p', { className: 'result-kicker', text: kicker }),
      element('h2', { text: title }),
    );
    header.append(heading, element('div', { className: 'result-meta', text: meta }));
    block.append(header);
    turn.append(block);
    $('#transcript').append(landed(turn));
    announce(title);
    return block;
  }

  // Wide tables scroll inside their card, never the feed; an edge fades
  // only on the side that has more to show.
  const overflowWatch = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => entries.forEach((entry) => markOverflow(entry.target)))
    : null;

  function markOverflow(wrap) {
    const max = wrap.scrollWidth - wrap.clientWidth;
    wrap.classList.toggle('more-right', max > 1 && wrap.scrollLeft < max - 1);
    wrap.classList.toggle('more-left', max > 1 && wrap.scrollLeft > 1);
  }

  function watchOverflow(wrap) {
    wrap.addEventListener('scroll', () => markOverflow(wrap), { passive: true });
    if (overflowWatch) overflowWatch.observe(wrap);
    return wrap;
  }

  function scrollWrap(table) {
    const wrap = element('div', { className: 'table-scroll' });
    wrap.append(table);
    return watchOverflow(wrap);
  }

  // read_story: the desk retells the story page's story; this card points at
  // where each retold part sits on the page (the whole story when it told all of it)
  function renderStoryLinks(payload) {
    const parts = Array.isArray(payload.parts) ? payload.parts : [];
    if (!parts.length) return;
    const whole = parts.length > 4;
    const block = resultShell('ON THE STORY PAGE', whole ? "What's the most you can pay, and what has to be true?" : 'Where this sits on the page');
    const list = element('ul', { className: 'story-links' });
    (whole ? [{ title: 'Read the whole story', url: payload.url || '/' }] : parts).forEach((part) => {
      const item = element('li');
      item.append(element('a', { text: `${part.title} →`, attrs: { href: part.url, target: '_blank', rel: 'noopener' } }));
      list.append(item);
    });
    block.append(list);
  }

  function errorResult(message, title = 'Analysis could not complete', details = null) {
    $('#welcome').hidden = true;
    const turn = element('div', { className: 'turn' });
    const block = element('section', { className: 'error-block' });
    const errorName = details?.exception_class || details?.exception;
    block.append(
      element('h2', { text: title }),
      element('p', { text: errorName ? `${errorName}: ${message}` : message }),
    );
    const stack = Array.isArray(details?.stack)
      ? details.stack
      : (Array.isArray(details?.traceback) ? details.traceback : []);
    if (stack.length) {
      const disclosure = element('details', { className: 'error-details' });
      disclosure.append(
        element('summary', { text: 'Technical details' }),
        element('pre', { text: stack.slice(-3).join('\n') }),
      );
      block.append(disclosure);
    }
    turn.append(block);
    $('#transcript').append(landed(turn));
    announce(`${title}. ${message}`);
  }

  /* ---------- markdown narration (workstation port, textContent-only) ---------- */

  function appendInlineMarkdown(parent, text) {
    const source = String(text);
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (match.index > last) {
        parent.append(document.createTextNode(source.slice(last, match.index)));
      }
      const token = match[0];
      if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
        parent.append(element('strong', { text: token.slice(2, -2) }));
      } else if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
        parent.append(element('em', { text: token.slice(1, -1) }));
      } else if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
        parent.append(element('code', { text: token.slice(1, -1) }));
      } else {
        parent.append(document.createTextNode(token));
      }
      last = match.index + token.length;
    }
    if (last < source.length) {
      parent.append(document.createTextNode(source.slice(last)));
    }
  }

  function appendParagraphLines(parent, lines) {
    lines.forEach((line, index) => {
      if (index > 0) parent.append(element('br'));
      appendInlineMarkdown(parent, line);
    });
  }

  function isPipeRow(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|', 1);
  }

  function isTableSeparatorRow(line) {
    const cells = splitPipeCells(line);
    if (!cells.length) return false;
    return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
  }

  function splitPipeCells(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
    return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  }

  function peekPipeTable(lines, startIndex) {
    if (startIndex + 1 >= lines.length) return null;
    const headerLine = lines[startIndex];
    const separatorLine = lines[startIndex + 1];
    // Pipe-table gate: header row + |---| separator required before body rows.
    if (!isPipeRow(headerLine) || !isPipeRow(separatorLine) || !isTableSeparatorRow(separatorLine)) {
      return null;
    }
    const headers = splitPipeCells(headerLine);
    if (!headers.length) return null;
    const body = [];
    let index = startIndex + 2;
    while (index < lines.length && isPipeRow(lines[index]) && !isTableSeparatorRow(lines[index])) {
      const cells = splitPipeCells(lines[index]);
      if (cells.length !== headers.length) return null;
      body.push(cells);
      index += 1;
    }
    return { headers, body, nextIndex: index };
  }

  function buildPipeTable(parsed) {
    const table = element('table', { className: 'metrics-table' });
    const thead = element('thead');
    const headerRow = element('tr');
    parsed.headers.forEach((cell) => {
      const th = element('th');
      appendInlineMarkdown(th, cell);
      headerRow.append(th);
    });
    thead.append(headerRow);
    table.append(thead);
    const tbody = element('tbody');
    parsed.body.forEach((cells) => {
      const tr = element('tr');
      cells.forEach((cell) => {
        const td = element('td');
        appendInlineMarkdown(td, cell);
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(tbody);
    return table;
  }

  function isUnorderedListItem(line) {
    return /^[-*] /.test(line);
  }

  function renderNarrationMarkdown(text) {
    const root = element('div', { className: 'result-narrative result-narrative--md' });
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const heading = element(level === 2 ? 'h3' : 'h4', {
          className: level === 2 ? 'narrative-h3' : 'narrative-h4',
        });
        appendInlineMarkdown(heading, headingMatch[2]);
        root.append(heading);
        i += 1;
        continue;
      }

      const table = peekPipeTable(lines, i);
      if (table) {
        root.append(scrollWrap(buildPipeTable(table)));
        i = table.nextIndex;
        continue;
      }

      if (isUnorderedListItem(line)) {
        const list = element('ul', { className: 'narrative-list' });
        while (i < lines.length && isUnorderedListItem(lines[i])) {
          const item = element('li');
          appendInlineMarkdown(item, lines[i].slice(2));
          list.append(item);
          i += 1;
        }
        root.append(list);
        continue;
      }

      const paragraphLines = [];
      while (i < lines.length) {
        const current = lines[i];
        if (!current.trim()) break;
        if (/^(#{2,3})\s+/.test(current)) break;
        if (isUnorderedListItem(current)) break;
        if (peekPipeTable(lines, i)) break;
        paragraphLines.push(current);
        i += 1;
      }
      const paragraph = element('p');
      appendParagraphLines(paragraph, paragraphLines);
      root.append(paragraph);
    }
    return root;
  }

  // The narration reads as prose under the card, not as another boxed card:
  // no kicker, no heading, only its provenance line in small mono. It lands
  // whole (after the server's number guard), never word by word, and when
  // it follows a card within --dur-1 it rises one stagger after it.
  function renderNarration(text, ranTools = true) {
    if (!text) return;
    const follows = performance.now() - state.lastArrival < tokenMs('--dur-1');
    $('#welcome').hidden = true;
    const turn = element('div', { className: `turn narration-turn${follows ? ' follows' : ''}` });
    const prose = element('div', { className: 'demo-narration' });
    let body;
    try {
      body = renderNarrationMarkdown(text);
    } catch (_error) {
      body = element('div', { className: 'result-narrative', text });
    }
    prose.append(body, element('p', {
      className: 'demo-narration-meta',
      text: ranTools ? 'Written from the engine results above' : 'From earlier results in this conversation',
    }));
    turn.append(prose);
    $('#transcript').append(landed(turn));
    announce(body.textContent);
    state.conversation.push({ role: 'assistant', content: String(text) });
  }

  // Harness surface for markdown narration rendering.
  window.__renderNarrationMarkdown = renderNarrationMarkdown;
  window.__renderNarration = renderNarration;

  /* ---------- compact metrics card (evaluate → conversation card) ---------- */

  function metricMetadata(result) {
    const catalogMeta = new Map((state.catalog?.output_meta || []).map((item) => [item.id, item]));
    const preferred = state.catalog?.ui?.headline_output_ids || [];
    const keys = [...preferred, ...Object.keys(result || {})];
    const seen = new Set();
    return keys.flatMap((id) => {
      if (seen.has(id) || typeof result?.[id] !== 'number') return [];
      seen.add(id);
      const meta = catalogMeta.get(id) || {};
      return [{ id, label: meta.label || titleCase(id), unit: meta.unit || '' }];
    }).slice(0, 8);
  }

  // Result-card / instance-save labels. One source of truth: is_base and the
  // scenario's own name or overrides (e.g. "Occ −5 pts"), never column index.
  const SCENARIO_ASSUMPTION_KEYS = new Set([
    'name', 'assumptions', 'is_base', 'delta_vs_base', 'error', 'warnings',
    'invalid_outputs',
  ]);

  // Catalog rows with no unit still say what they are in their label
  // ("Exit capitalization rate assumption", "Total acquisition purchase
  // price"); format them as a percentage or dollars rather than a bare 0.065.
  const RATE_LABEL = /\b(rate|share|growth|escalation|occupancy|percent(age)?|cap|delta)\b/i;
  const MONEY_LABEL = /\b(price|cost|amount|loan|proceeds|budget|salary)\b/i;

  function inferUnit(label, unit) {
    if (unit) return unit;
    if (RATE_LABEL.test(label || '')) return 'decimal';
    if (MONEY_LABEL.test(label || '')) return 'currency';
    return '';
  }

  function inputUnit(id, label, unit) {
    const inferred = inferUnit(label, unit);
    const rate = String(inferred).toLowerCase();
    return isDeltaInput(id, label) && (rate === 'decimal' || rate.includes('percent')) ? 'pts' : inferred;
  }

  function inputCatalogEntry(id) {
    const common = (state.catalog?.common_inputs || []).find((item) => item.id === id);
    // A common input with no catalog unit ("Exit capitalization rate
    // assumption" = 0.075) still formats from its label.
    if (common) return { ...common, unit: inputUnit(id, common.label, common.unit) };
    // Labels/units the server attached to a card for less common inputs.
    const extra = state.inputMeta[id];
    if (!extra) return {};
    return { id, label: extra.label || '', unit: inputUnit(id, extra.label, extra.unit) };
  }

  function rememberInputMeta(payload) {
    const meta = payload?.input_meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) Object.assign(state.inputMeta, meta);
  }

  function scenarioAssumptions(item) {
    if (!item || typeof item !== 'object') return {};
    if (item.assumptions && typeof item.assumptions === 'object' && !Array.isArray(item.assumptions)) {
      return { ...item.assumptions };
    }
    const overrides = {};
    Object.entries(item).forEach(([key, value]) => {
      if (!SCENARIO_ASSUMPTION_KEYS.has(key)) overrides[key] = value;
    });
    return overrides;
  }

  function isGenericScenarioName(name) {
    return !name || /^(base|case\s*\d+)$/i.test(String(name).trim());
  }

  function isDeltaInput(id, label) {
    return /\b(delta|adjustment)\b/i.test(`${String(id).replace(/_/g, ' ')} ${label || ''}`);
  }

  function overrideStem(id, label) {
    const text = `${id} ${label || ''}`;
    if (/occupancy/i.test(text)) {
      // "AL stabilized occupancy" -> "AL occ"; scenario deltas stay "Occ".
      const segment = String(label || '').match(/^(IL|AL|MC)\b/);
      return segment && !isDeltaInput(id, label) ? `${segment[1]} occ` : 'Occ';
    }
    if (/exit.?cap/i.test(text)) return 'Exit cap';
    // Drop the "Base case"/"Base scenario" qualifier and a trailing
    // "delta"/"adjustment"/"assumption": "Base scenario resident rate
    // adjustment" -> "Resident rate", not "Base scenario".
    const core = String(label || titleCase(id))
      .replace(/^base[\s-]*(case|scenario)\s+/i, '')
      .replace(/\s+(delta|adjustment|assumption)$/i, '')
      .split(/\s+/)
      .filter(Boolean);
    const stem = core.slice(0, 4).join(' ') || titleCase(id);
    return stem.charAt(0).toUpperCase() + stem.slice(1);
  }

  // Display formatting of catalog golden vs the override. Not engine-output
  // arithmetic — those deltas stay on delta_vs_base.
  function formatOverridePts(delta, unit) {
    const normalized = String(unit || '').toLowerCase();
    if (!(normalized.includes('percent') || normalized === 'decimal' || normalized === 'pts')) return '';
    const pts = Math.round(delta * 1000) / 10;
    if (!Number.isFinite(pts) || pts === 0) return '';
    const mag = Math.abs(pts);
    const shown = Number.isInteger(mag) ? String(mag) : String(mag);
    return `${pts < 0 ? '−' : '+'}${shown} ${mag === 1 ? 'pt' : 'pts'}`;
  }

  function describeOverride(id, value, meta) {
    const entry = meta || inputCatalogEntry(id);
    const stem = overrideStem(id, entry.label);
    if (isScalarNumber(value) && isDeltaInput(id, entry.label)) {
      // A scenario delta is itself the shift: -0.025 reads "−2.5 pts".
      const pts = formatOverridePts(value, entry.unit);
      if (pts) return `${stem} ${pts}`;
    }
    if (isScalarNumber(value) && isScalarNumber(entry.golden_value) && !/occupancy/i.test(`${id} ${entry.label || ''}`)) {
      const pts = formatOverridePts(value - entry.golden_value, entry.unit);
      if (pts) return `${stem} ${pts}`;
    }
    return `${stem} ${formatNumber(value, entry.unit || '')}`;
  }

  function describeOverrides(assumptions) {
    const entries = Object.entries(assumptions || {});
    if (!entries.length) return '';
    const occupancy = [];
    const rest = [];
    entries.forEach(([id, value]) => {
      const meta = inputCatalogEntry(id);
      if (/occupancy/i.test(`${id} ${meta.label || ''}`)) occupancy.push({ id, value, meta });
      else rest.push({ id, value, meta });
    });
    const parts = [];
    if (occupancy.length) {
      const labels = occupancy.map((item) => describeOverride(item.id, item.value, item.meta));
      parts.push(...new Set(labels));
    }
    rest.forEach((item) => parts.push(describeOverride(item.id, item.value, item.meta)));
    const unique = [...new Set(parts)];
    // A row-written lever (22 staffing cells) would list every cell.
    if (unique.length > 3) return `${unique.slice(0, 2).join(', ')} +${unique.length - 2} more`;
    return unique.join(', ');
  }

  function scenarioColumnLabel(definition, result) {
    const assumptions = scenarioAssumptions(definition);
    const given = typeof definition?.name === 'string' ? definition.name.trim() : '';
    const echoed = typeof result?.name === 'string' ? result.name.trim() : '';
    const named = (!isGenericScenarioName(given) && given) || (!isGenericScenarioName(echoed) && echoed) || '';
    if (named) return named;
    const described = describeOverrides(assumptions);
    if (described) return described;
    if (result?.is_base) return 'Base';
    if (result?.delta_vs_base) return 'Case';
    return Object.keys(assumptions).length ? 'Case' : 'Base';
  }

  function resolveDefinitions(payload, options = {}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const normalizedScenarios = payload?.scenario_set?.scenarios;
    const source = (Array.isArray(normalizedScenarios) && normalizedScenarios.length)
      ? normalizedScenarios
      : (Array.isArray(payload?.scenarios) && payload.scenarios.length)
        ? payload.scenarios
        : (options.scenarios || state.lastScenarios || []);
    return source.map((item, index) => {
      const assumptions = scenarioAssumptions(item);
      const result = results[index] || {};
      return {
        name: scenarioColumnLabel({ ...item, assumptions }, result),
        assumptions,
      };
    });
  }

  function renderScenarioResults(payload, options = {}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const definitions = resolveDefinitions(payload, options);
    const valid = results.filter((item) => item && typeof item === 'object' && !item.error);
    const failed = results.find((item) => item?.error);
    if (failed) errorResult(failed.error, 'The model returned an execution error', failed);
    if (!valid.length) {
      if (!failed) errorResult('The engine returned no result rows.');
      return;
    }

    const scenarioCount = valid.length;
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    const cacheHits = runs.filter((run) => run.cache_hit).length;
    const meta = runs.length
      ? `${runs.length} run${runs.length === 1 ? '' : 's'} · ${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}`
      : `${scenarioCount} verified case${scenarioCount === 1 ? '' : 's'}`;
    const titleDefinition = definitions.find((definition, index) => valid[index] && !valid[index].is_base)
      || definitions.find((definition, index) => valid[index]?.is_base)
      || definitions[0];
    const changedCases = valid.filter((row) => row && !row.is_base).length;
    const title = changedCases > 1
      ? `${changedCases} cases vs base`
      : (titleDefinition?.name || scenarioColumnLabel(titleDefinition, null) || 'Scenario output');
    const block = resultShell('ENGINE RESULT', title, meta);
    const metrics = metricMetadata(valid[0]);
    // The Δ column consumes the server-side delta_vs_base enrichment of the
    // last non-base row; nothing is subtracted in the browser.
    const currentRow = [...valid].reverse().find((row) => !row.is_base) || null;
    const deltas = currentRow?.delta_vs_base && typeof currentRow.delta_vs_base === 'object'
      ? currentRow.delta_vs_base
      : null;
    if (!metrics.length) {
      block.append(element('div', { className: 'result-narrative', text: 'The run completed, but no scalar headline outputs were returned.' }));
    } else {
      const table = element('table', { className: 'metrics-table' });
      const head = element('thead');
      const headRow = element('tr');
      headRow.append(element('th', { text: 'Metric' }));
      valid.forEach((result, index) => {
        const name = definitions[index]?.name || scenarioColumnLabel(definitions[index], result);
        const th = element('th');
        th.append(document.createTextNode(name));
        if (result.is_base && !/^base$/i.test(name)) {
          th.append(element('span', { className: 'sensitivity-base-badge', text: 'BASE' }));
        }
        headRow.append(th);
      });
      if (deltas) headRow.append(element('th', { text: 'Δ vs base' }));
      head.append(headRow);
      const body = element('tbody');
      metrics.forEach((metric) => {
        const row = element('tr');
        row.append(element('td', { className: 'metric-label', text: metric.label }));
        valid.forEach((result) => {
          row.append(element('td', { className: 'metric-value', text: formatNumber(result[metric.id], metric.unit) }));
        });
        if (deltas) {
          const deltaValue = deltas[metric.id];
          const tone = isScalarNumber(deltaValue)
            ? (deltaValue > 0 ? 'delta-positive' : deltaValue < 0 ? 'delta-negative' : '')
            : '';
          row.append(element('td', {
            className: `metric-value ${tone}`,
            text: formatDeltaValue(deltaValue, metric.unit),
          }));
        }
        body.append(row);
      });
      table.append(head, body);
      block.append(scrollWrap(table));
    }

    appendInstanceSaveActions(block, definitions, valid, payload);

    const footer = element('footer', { className: 'result-footer' });
    footer.append(
      element('span', {
        text: engineFooterText(payload),
      }),
    );
    block.append(footer);
    updateDealState(payload, definitions, valid);
  }

  /* ---------- sensitivity card (workstation port) ---------- */

  function sensitivityScalarColumns(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const catalogMeta = new Map((state.catalog?.output_meta || []).map((item) => [item.id, item]));
    const payloadMeta = new Map(
      (Array.isArray(payload?.output_meta) ? payload.output_meta : [])
        .filter((item) => item && item.id)
        .map((item) => [item.id, item]),
    );
    const preferred = Array.isArray(payload?.output_ids) ? payload.output_ids : [];
    const discovered = rows.flatMap((row) => Object.keys(row?.outputs || {}));
    const seen = new Set();
    return [...preferred, ...discovered].flatMap((id) => {
      if (seen.has(id)) return [];
      const hasScalar = rows.some((row) => isScalarNumber(row?.outputs?.[id]));
      if (!hasScalar) return [];
      seen.add(id);
      const meta = payloadMeta.get(id) || catalogMeta.get(id) || {};
      return [{ id, label: meta.label || titleCase(id), unit: meta.unit || '' }];
    });
  }

  function renderSensitivityResults(payload) {
    const input = payload?.input && typeof payload.input === 'object' ? payload.input : {};
    const inputLabel = input.label || titleCase(input.id) || 'Input';
    const scanUnit = inputUnit(input.id, inputLabel, input.unit);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const target = payload?.target?.status === 'crossed' ? payload.target : null;
    const feasible = payload?.target?.feasible || null;
    const boundaries = feasible
      ? feasible.boundaries || []
      : (target ? [{ meets: target.meets, misses: target.misses }] : []);
    const clears = new Set(boundaries.map((item) => item?.meets?.input_value));
    const misses = new Set(boundaries.map((item) => item?.misses?.input_value));
    const columns = sensitivityScalarColumns(payload);
    const scanMeta = `${rows.length} scan point${rows.length === 1 ? '' : 's'}${payload?.mock ? ' · fixture' : ''}`;
    const block = resultShell('SENSITIVITY', inputLabel, scanMeta);

    if (!rows.length || !columns.length) {
      block.append(element('div', {
        className: 'result-narrative',
        text: !rows.length
          ? 'No sensitivity scan rows were returned.'
          : 'No scalar outputs were available to display in the sensitivity table.',
      }));
      return;
    }

    const primaryId = columns[0].id;
    const primaryValues = rows.map((row) => row?.outputs?.[primaryId]).filter(isScalarNumber);
    const primaryMin = primaryValues.length ? Math.min(...primaryValues) : 0;
    const primaryMax = primaryValues.length ? Math.max(...primaryValues) : 0;
    const primarySpan = primaryMax - primaryMin;

    const wrap = watchOverflow(element('div', { className: 'sensitivity-table-wrap' }));
    const table = element('table', { className: 'sensitivity-table' });
    const head = element('thead');
    const headRow = element('tr');
    // Values carry their own formatting ($, %), so the unit id stays off.
    headRow.append(element('th', { text: inputLabel }));
    columns.forEach((column) => headRow.append(element('th', { text: column.label })));
    head.append(headRow);

    const body = element('tbody');
    rows.forEach((row) => {
      const tr = element('tr');
      if (row?.is_golden) tr.className = 'sensitivity-row-golden';

      const inputCell = element('td', { className: 'sensitivity-input' });
      inputCell.append(element('span', {
        className: 'metric-value',
        text: formatNumber(row?.value, scanUnit),
      }));
      if (row?.is_golden) {
        inputCell.append(element('span', { className: 'sensitivity-base-badge', text: 'BASE' }));
      }
      if (clears.has(row?.value)) {
        inputCell.append(element('span', { className: 'sensitivity-base-badge', text: 'CLEARS' }));
      }
      if (misses.has(row?.value)) {
        inputCell.append(element('span', { className: 'sensitivity-base-badge', text: 'MISSES' }));
      }
      tr.append(inputCell);

      columns.forEach((column, columnIndex) => {
        const raw = row?.outputs?.[column.id];
        const cell = element('td', { className: 'metric-value sensitivity-output' });
        if (!isScalarNumber(raw)) {
          cell.textContent = '—';
        } else {
          cell.append(element('span', { text: formatNumber(raw, column.unit) }));
          if (columnIndex === 0) {
            const track = element('span', {
              className: 'sensitivity-bar-track',
              attrs: { 'aria-hidden': 'true' },
            });
            const widthPct = primarySpan > 0
              ? ((raw - primaryMin) / primarySpan) * 100
              : 100;
            const bar = element('span', { className: 'sensitivity-bar' });
            bar.style.width = `${widthPct}%`;
            track.append(bar);
            cell.append(track);
          }
        }
        tr.append(cell);
      });
      body.append(tr);
    });

    table.append(head, body);
    wrap.append(table);
    if (feasible) {
      const column = columns.find((item) => item.id === payload.target.output_id) || columns[0];
      renderFeasibleSet(block, payload.target, rows, inputLabel, scanUnit, column);
      const details = element('details', { className: 'feasible-points' });
      details.append(element('summary', { text: `All ${rows.length} scan points` }));
      details.append(wrap);
      block.append(details);
    } else {
      block.append(wrap);
    }

    const footer = element('footer', { className: 'result-footer' });
    footer.append(element('span', {
      text: engineFooterText(payload),
    }));
    block.append(footer);
  }

  const TARGET_OP_TEXT = { '>=': 'at least', '>': 'above', '<=': 'at most', '<': 'below', '==': 'equal to' };

  function feasibleSummary(target, inputLabel, scanUnit, column) {
    const feasible = target.feasible;
    const goal = `${column.label} ${TARGET_OP_TEXT[target.op] || target.op} ${formatNumber(target.value, column.unit)}`;
    const at = (value) => formatNumber(value, scanUnit);
    const range = `${at(feasible.domain.min)} to ${at(feasible.domain.max)}`;
    const intervals = feasible.intervals || [];
    if (!intervals.length) return `No ${inputLabel} from ${range} gives ${goal}.`;
    const parts = intervals.map((item) => {
      const from = item.from_is_range_end ? `${at(item.from.input_value)} (scan start)` : at(item.from.input_value);
      const to = item.to_is_range_end ? `${at(item.to.input_value)} (scan end)` : at(item.to.input_value);
      return item.from.input_value === item.to.input_value ? `at ${at(item.from.input_value)}` : `from ${from} to ${to}`;
    });
    return `${goal} when ${inputLabel} is ${parts.join(', or ')}.`;
  }

  function renderFeasibleSet(block, target, rows, inputLabel, scanUnit, column) {
    const feasible = target.feasible;
    const summary = element('div', { className: 'feasible-summary' });
    summary.append(element('p', {
      className: 'feasible-headline',
      text: feasibleSummary(target, inputLabel, scanUnit, column),
    }));
    (feasible.boundaries || []).forEach((item) => {
      const miss = item.misses.output_value === null || item.misses.output_value === undefined
        ? 'no valid result'
        : formatNumber(item.misses.output_value, column.unit);
      summary.append(element('p', {
        className: 'feasible-edge',
        text: `Edge between ${formatNumber(item.meets.input_value, scanUnit)} → ${formatNumber(item.meets.output_value, column.unit)}`
          + ` and ${formatNumber(item.misses.input_value, scanUnit)} → ${miss}`,
      }));
    });
    (feasible.error_ranges || []).forEach((item) => {
      summary.append(element('p', {
        className: 'feasible-edge',
        text: `The model gives no valid result from ${formatNumber(item.from, scanUnit)} to ${formatNumber(item.to, scanUnit)}.`,
      }));
    });
    block.append(summary);
    block.append(feasibleChart(target, rows, scanUnit, column));
  }

  function feasibleChart(target, rows, scanUnit, column) {
    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs) => {
      const node = document.createElementNS(NS, tag);
      Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
      return node;
    };
    const feasible = target.feasible;
    const points = rows
      .map((row) => [row?.value, row?.outputs?.[target.output_id]])
      .filter(([x, y]) => isScalarNumber(x) && isScalarNumber(y));
    const W = 640; const H = 200; const L = 64; const R = 16; const T = 14; const B = 30;
    const xMin = feasible.domain.min; const xMax = feasible.domain.max;
    const ys = points.map(([, y]) => y).concat([target.value]);
    let yMin = Math.min(...ys); let yMax = Math.max(...ys);
    if (yMax === yMin) { yMax += 1; yMin -= 1; }
    const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
    const sx = (x) => L + ((x - xMin) / ((xMax - xMin) || 1)) * (W - L - R);
    const sy = (y) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`, class: 'feasible-chart', role: 'img',
      'aria-label': `${column.label} across the scan, with the target line`,
    });
    (feasible.error_ranges || []).forEach((item) => {
      svg.append(svgEl('rect', {
        x: sx(item.from), y: T, width: Math.max(2, sx(item.to) - sx(item.from)), height: H - T - B,
        class: 'feasible-error-band',
      }));
    });
    (feasible.intervals || []).forEach((item) => {
      svg.append(svgEl('rect', {
        x: sx(item.from.input_value), y: T,
        width: Math.max(2, sx(item.to.input_value) - sx(item.from.input_value)), height: H - T - B,
        class: 'feasible-band',
      }));
    });
    const base = rows.find((row) => row?.is_golden);
    if (base && isScalarNumber(base.value)) {
      svg.append(svgEl('line', { x1: sx(base.value), x2: sx(base.value), y1: T, y2: H - B, class: 'feasible-base' }));
      const tag = svgEl('text', { x: sx(base.value), y: H - 10, class: 'feasible-axis-label', 'text-anchor': 'middle' });
      tag.textContent = 'base';
      svg.append(tag);
    }
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: sy(target.value), y2: sy(target.value), class: 'feasible-hurdle' }));
    const hurdle = svgEl('text', { x: L - 6, y: sy(target.value) + 4, class: 'feasible-axis-label', 'text-anchor': 'end' });
    hurdle.textContent = formatNumber(target.value, column.unit);
    svg.append(hurdle);
    if (points.length) {
      svg.append(svgEl('polyline', {
        points: points.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' '),
        class: 'feasible-line',
      }));
      points.forEach(([x, y]) => svg.append(svgEl('circle', { cx: sx(x), cy: sy(y), r: 2.2, class: 'feasible-dot' })));
    }
    [[xMin, 'start'], [xMax, 'end']].forEach(([x, anchor]) => {
      const label = svgEl('text', { x: sx(x), y: H - 10, class: 'feasible-axis-label', 'text-anchor': anchor });
      label.textContent = formatNumber(x, scanUnit);
      svg.append(label);
    });
    return svg;
  }

  /* ---------- solver cards (workstation port + prefill actions) ---------- */

  function formatConstraintOp(op) {
    const map = { '>=': '≥', '<=': '≤', '==': '=', '=': '=', '!=': '≠' };
    const text = String(op || '');
    return map[text] || text;
  }

  function solverFieldMeta(kind, id) {
    if (kind === 'output') {
      const meta = (state.catalog?.output_meta || []).find((item) => item.id === id) || {};
      return { label: meta.label || titleCase(id), unit: meta.unit || '' };
    }
    const meta = inputCatalogEntry(id);
    return { label: meta.label || titleCase(id), unit: meta.unit || '' };
  }

  function formatSolverBoundValue(value, unit) {
    if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, unit);
    return displayText(value);
  }

  function solverConstraintPhrase(item, kind) {
    if (!item || typeof item !== 'object') return '';
    const id = kind === 'target' ? item.output_id : item.input_id;
    const meta = solverFieldMeta(kind === 'target' ? 'output' : 'input', id);
    const label = item.label || meta.label || titleCase(id);
    const unit = item.unit || meta.unit || '';
    return `${label} ${formatConstraintOp(item.op)} ${formatSolverBoundValue(item.value, unit)}`;
  }

  function solverConstraintSummary(payload) {
    const parts = [];
    (Array.isArray(payload?.targets) ? payload.targets : []).forEach((item) => {
      const phrase = solverConstraintPhrase(item, 'target');
      if (phrase) parts.push(phrase);
    });
    (Array.isArray(payload?.input_constraints) ? payload.input_constraints : []).forEach((item) => {
      const phrase = solverConstraintPhrase(item, 'input');
      if (phrase) parts.push(phrase);
    });
    const matched = typeof payload?.matched === 'number' ? payload.matched : 0;
    const total = typeof payload?.total_cached === 'number' ? payload.total_cached : 0;
    const matchedText = `${new Intl.NumberFormat(NUMBER_LOCALE).format(matched)} / ${new Intl.NumberFormat(NUMBER_LOCALE).format(total)} matched`;
    parts.push(matchedText);
    return parts.join(' · ') || matchedText;
  }

  function solverOutputColumns(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const catalogMeta = new Map((state.catalog?.output_meta || []).map((item) => [item.id, item]));
    const targetIds = (Array.isArray(payload?.targets) ? payload.targets : [])
      .map((item) => item?.output_id)
      .filter(Boolean);
    const extras = ['gross_levered_multiple', 'total_equity'].filter((id) => !targetIds.includes(id));
    const ordered = [...targetIds, ...extras];
    const seen = new Set();
    return ordered.flatMap((id) => {
      if (seen.has(id)) return [];
      const present = rows.some((row) => row?.outputs && Object.prototype.hasOwnProperty.call(row.outputs, id));
      if (!present && !targetIds.includes(id)) return [];
      seen.add(id);
      const meta = catalogMeta.get(id) || {};
      return [{ id, label: meta.label || titleCase(id), unit: meta.unit || '', isTarget: targetIds.includes(id) }];
    });
  }

  function solverInputKeyCount(row) {
    if (!row || typeof row !== 'object' || !row.inputs || typeof row.inputs !== 'object') return 0;
    return Object.keys(row.inputs).length;
  }

  function solverDeviationCount(row) {
    if (!row || typeof row !== 'object') return 0;
    if (typeof row.deviation_count === 'number') return row.deviation_count;
    return Array.isArray(row.deviations) ? row.deviations.length : 0;
  }

  function dominantLever(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let leverId = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (solverDeviationCount(row) !== 1) return null;
      const inputId = row?.deviations?.[0]?.input_id;
      if (!inputId) return null;
      if (leverId === null) leverId = inputId;
      else if (leverId !== inputId) return null;
    }
    return leverId;
  }

  function solverFormatCount(value) {
    return new Intl.NumberFormat(NUMBER_LOCALE).format(typeof value === 'number' ? value : 0);
  }

  function solverMetaText(payload) {
    if (payload?.mock) return 'Fixture engine · not investment output';
    return payload?.model_id ? modelDisplayName(payload.model_id) : '';
  }

  function solverTargetPhrase(payload) {
    const targets = Array.isArray(payload?.targets) ? payload.targets : [];
    return targets.map((item) => solverConstraintPhrase(item, 'target')).filter(Boolean);
  }

  function solverInputConstraintPhrases(payload) {
    const items = Array.isArray(payload?.input_constraints) ? payload.input_constraints : [];
    return items.map((item) => solverConstraintPhrase(item, 'input')).filter(Boolean);
  }

  function solverCouplingStripPhrase(item) {
    if (!item || typeof item !== 'object') return '';
    const leftMeta = solverFieldMeta('input', item.left);
    const rightMeta = solverFieldMeta('input', item.right);
    const leftLabel = item.left_label || leftMeta.label || humanizeId(item.left);
    const rightLabel = item.right_label || rightMeta.label || humanizeId(item.right);
    const unit = leftMeta.unit || rightMeta.unit || '';
    return `${leftLabel} − ${rightLabel} ≤ ${formatSolverBoundValue(item.max_delta, unit)}`;
  }

  function solverCasesTitle(payload) {
    const targets = solverTargetPhrase(payload);
    const constraints = solverInputConstraintPhrases(payload);
    if (targets.length && constraints.length) {
      return `Cases clearing ${targets.join(', ')} with ${constraints.join(', ')}`;
    }
    if (targets.length) return `Cases clearing ${targets.join(', ')}`;
    return solverConstraintSummary(payload);
  }

  function solverConstraintProse(payload) {
    const bits = [];
    solverInputConstraintPhrases(payload).forEach((phrase) => bits.push(phrase));
    (Array.isArray(payload?.couplings) ? payload.couplings : []).forEach((item) => {
      const phrase = solverCouplingStripPhrase(item);
      if (phrase) bits.push(phrase);
    });
    if (!bits.length) return 'the stated constraints';
    if (bits.length === 1) return bits[0];
    return `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`;
  }

  function solverAskPrefill(payload) {
    const parts = [];
    solverTargetPhrase(payload).forEach((phrase) => parts.push(phrase));
    solverInputConstraintPhrases(payload).forEach((phrase) => parts.push(phrase));
    (Array.isArray(payload?.couplings) ? payload.couplings : []).forEach((item) => {
      const phrase = solverCouplingStripPhrase(item);
      if (phrase) parts.push(phrase);
    });
    if (!parts.length) return 'What do I have to believe to clear these constraints?';
    if (parts.length === 1) return `I need ${parts[0]}. What do I have to believe?`;
    return `I need ${parts[0]} with ${parts.slice(1).join(', ')}. What do I have to believe?`;
  }

  function solverEvidencePrefill(payload, leverId) {
    const leverMeta = solverFieldMeta('input', leverId);
    const targets = solverTargetPhrase(payload);
    const targetText = targets.join(', ') || 'the target';
    return `Show the formula evidence for how ${leverMeta.label || humanizeId(leverId)} drives ${targetText}.`;
  }

  function appendSolverConstraintStrip(block, payload) {
    const strip = element('div', { className: 'solver-constraint-strip' });
    const cells = [
      {
        label: 'Target',
        text: solverTargetPhrase(payload).join(' · ') || '—',
      },
      {
        label: 'Input constraint',
        text: solverInputConstraintPhrases(payload).join(' · ') || '—',
      },
      {
        label: 'Coupling',
        text: (Array.isArray(payload?.couplings) ? payload.couplings : [])
          .map((item) => solverCouplingStripPhrase(item))
          .filter(Boolean)
          .join(' · ') || '—',
      },
    ];
    cells.forEach((cell) => {
      const node = element('div', { className: 'solver-constraint-cell' });
      node.append(
        element('p', { className: 'solver-constraint-label', text: cell.label }),
        element('p', { className: 'solver-constraint-value', text: cell.text }),
      );
      strip.append(node);
    });
    block.append(strip);
  }

  function appendSolverCaveat(block, payload, note) {
    const totalCached = typeof payload?.total_cached === 'number' ? payload.total_cached : 0;
    const caveat = element('div', { className: 'solver-caveat' });
    caveat.append(
      element('span', {
        text: note || `Results are bounded by the ${solverFormatCount(totalCached)} scenarios precomputed for this model version — cases outside the cached grid are not evaluated.`,
      }),
      element('span', { className: 'solver-caveat-meta', text: engineFooterText(payload, 'Scenario index') }),
    );
    block.append(caveat);
  }

  function solverEvidenceColumns() {
    return [
      { id: 'gross_levered_irr', label: 'Levered IRR' },
      { id: 'gross_unlevered_irr', label: 'Unlevered IRR' },
      { id: 'lp_levered_irr', label: 'LP IRR' },
      { id: 'gross_levered_multiple', label: 'Equity multiple' },
      { id: 'entry_cap_rate', label: 'Entry cap' },
    ];
  }

  function renderSolverDeviationCell(row, options = {}) {
    const cell = element('td', { className: 'solver-deviations' });
    const count = solverDeviationCount(row);
    if (count === 0) {
      if (options.baseNote) {
        cell.append(element('span', {
          className: 'solver-base-note',
          text: options.baseNote,
        }));
      } else {
        cell.append(element('span', {
          className: 'sensitivity-base-badge',
          text: 'BASE',
        }));
      }
      return cell;
    }
    const chips = element('div', { className: 'solver-deviation-chips' });
    (Array.isArray(row.deviations) ? row.deviations : []).forEach((dev) => {
      if (!dev || typeof dev !== 'object') return;
      const meta = solverFieldMeta('input', dev.input_id);
      const label = dev.label || meta.label || humanizeId(dev.input_id);
      const valueText = formatSolverBoundValue(dev.value, meta.unit);
      const baseText = formatSolverBoundValue(dev.golden_value, meta.unit);
      chips.append(element('span', {
        className: 'solver-deviation-chip',
        text: `${label} ${valueText} (base ${baseText})`,
      }));
    });
    const keyCount = solverInputKeyCount(row);
    chips.append(element('span', {
      className: 'solver-dev-count',
      text: `${solverFormatCount(count)} of ${solverFormatCount(keyCount)} changed`,
    }));
    cell.append(chips);
    if (options.expandPanel) cell.append(options.expandPanel);
    return cell;
  }

  function buildUnchangedPanel(row) {
    const inputs = row?.inputs && typeof row.inputs === 'object' ? row.inputs : {};
    const changed = new Set(
      (Array.isArray(row?.deviations) ? row.deviations : [])
        .map((dev) => dev?.input_id)
        .filter(Boolean),
    );
    const unchangedIds = Object.keys(inputs).filter((id) => !changed.has(id));
    const panel = element('div', { className: 'solver-unchanged-panel', attrs: { hidden: 'hidden' } });
    panel.append(element('p', {
      className: 'solver-unchanged-kicker',
      text: `Unchanged from base · ${solverFormatCount(unchangedIds.length)} assumptions`,
    }));
    const grid = element('div', { className: 'solver-unchanged-grid' });
    unchangedIds.forEach((id) => {
      const meta = solverFieldMeta('input', id);
      const value = inputs[id];
      const formatted = typeof value === 'string'
        ? value
        : formatSolverBoundValue(value, meta.unit);
      const item = element('div', { className: 'solver-unchanged-item' });
      item.append(
        element('span', { className: 'solver-unchanged-label', text: meta.label || humanizeId(id) }),
        element('span', { className: 'solver-unchanged-value', text: formatted }),
      );
      grid.append(item);
    });
    panel.append(grid);
    return { panel, unchangedCount: unchangedIds.length };
  }

  function renderSolverEmpty(payload) {
    const matched = typeof payload?.matched === 'number' ? payload.matched : 0;
    const totalCached = typeof payload?.total_cached === 'number' ? payload.total_cached : 0;
    const block = resultShell(
      'SOLVER · EMPTY RESULT',
      'No cached scenario satisfies these constraints',
      solverMetaText(payload),
    );
    const constraintBits = [
      ...solverTargetPhrase(payload),
      ...solverInputConstraintPhrases(payload),
    ];
    (Array.isArray(payload?.couplings) ? payload.couplings : []).forEach((item) => {
      const phrase = solverCouplingStripPhrase(item);
      if (phrase) constraintBits.push(phrase);
    });
    const constraintText = constraintBits.length ? constraintBits.join(' with ') : 'these constraints';
    const body = element('div', { className: 'solver-empty-body' });
    body.append(element('p', {
      className: 'result-narrative solver-empty',
      text: `${solverFormatCount(matched)} of ${solverFormatCount(totalCached)} cached scenarios clear ${constraintText}. The constraint set is satisfiable only outside the precomputed grid, or not at all.`,
    }));
    const actions = element('div', { className: 'solver-empty-actions' });
    actions.append(prefillButton('Revise these constraints', solverAskPrefill(payload), 'solver-empty-action'));
    body.append(actions);
    block.append(body);
    appendSolverCaveat(block, payload);
  }

  function renderSolverBoundary(payload, leverId) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const matched = typeof payload?.matched === 'number' ? payload.matched : 0;
    const leverMeta = solverFieldMeta('input', leverId);
    const leverName = leverMeta.label || humanizeId(leverId);
    const firstDev = rows[0]?.deviations?.[0] || {};
    const leverValue = formatSolverBoundValue(firstDev.value, leverMeta.unit);
    const goldenValue = formatSolverBoundValue(firstDev.golden_value, leverMeta.unit);
    const targets = solverTargetPhrase(payload);
    const targetText = targets.join(', ') || 'the target';

    const block = resultShell(
      'SOLVER · BOUNDARY',
      `One lever bends: ${leverName}`,
      solverMetaText(payload),
    );

    const narrative = element('div', { className: 'solver-boundary-narrative' });
    const prose = element('p', { className: 'solver-boundary-prose' });
    prose.append('With ', solverConstraintProse(payload), ', the least-deviating cached case that clears ');
    const targetEmph = element('span', { className: 'solver-boundary-emph', text: targetText });
    prose.append(targetEmph, ' sets ', leverName, ' at ');
    const leverEmph = element('span', {
      className: 'solver-boundary-emph solver-boundary-emph-accent',
      text: leverValue,
    });
    prose.append(leverEmph, ', against a base of ');
    prose.append(element('span', { className: 'solver-boundary-emph', text: goldenValue }));
    prose.append('. Every other assumption stays at base.');
    narrative.append(prose);
    block.append(narrative);

    const stripSection = element('div', { className: 'solver-boundary-strip-section' });
    const stripHead = element('div', { className: 'solver-boundary-strip-head' });
    stripHead.append(
      element('p', {
        className: 'solver-boundary-strip-kicker',
        text: 'Cached grid points on the bending lever',
      }),
      element('p', {
        className: 'solver-boundary-strip-note',
        text: 'listed in cache order · spacing not to scale · no interpolation · click a point to draft a question',
      }),
    );
    stripSection.append(stripHead);

    const strip = element('div', { className: 'solver-boundary-strip' });
    const columnCount = rows.length + 1;
    strip.style.gridTemplateColumns = `repeat(${columnCount}, minmax(0, 1fr))`;

    const baseCell = element('button', {
      className: 'solver-boundary-point solver-boundary-point-base',
      attrs: { type: 'button' },
    });
    baseCell.append(
      element('p', { className: 'solver-boundary-point-tag', text: 'Base' }),
      element('p', { className: 'solver-boundary-point-value', text: goldenValue }),
      element('p', {
        className: 'solver-boundary-point-note',
        text: 'below target · not in matched set',
      }),
    );
    baseCell.addEventListener('click', () => {
      prefillComposer(`Evaluate the base case and show the headline metrics.`);
    });
    strip.append(baseCell);

    rows.forEach((row, index) => {
      const dev = row?.deviations?.[0] || {};
      const point = element('button', { className: 'solver-boundary-point', attrs: { type: 'button' } });
      const irrMeta = solverFieldMeta('output', 'gross_levered_irr');
      const irrRaw = row?.outputs?.gross_levered_irr;
      const irrText = isScalarNumber(irrRaw) ? formatNumber(irrRaw, irrMeta.unit || 'percent') : '—';
      const pointValue = formatSolverBoundValue(dev.value, leverMeta.unit);
      point.append(
        element('p', {
          className: 'solver-boundary-point-tag',
          text: index === 0 ? 'lowest matched' : 'next grid pt',
        }),
        element('p', {
          className: 'solver-boundary-point-value',
          text: pointValue,
        }),
        element('p', {
          className: 'solver-boundary-point-irr',
          text: `▲ ${irrText}`,
        }),
        element('p', {
          className: 'solver-boundary-point-note',
          text: 'levered IRR · clears',
        }),
      );
      point.addEventListener('click', () => {
        prefillComposer(`Evaluate a case with ${leverName} at ${pointValue} and show the headline metrics.`);
      });
      strip.append(point);
    });
    stripSection.append(strip);

    const showing = rows.length;
    stripSection.append(element('p', {
      className: 'solver-boundary-strip-caption',
      text: `These are the ${solverFormatCount(showing)} least-deviating of ${solverFormatCount(matched)} matched cases; all ${solverFormatCount(showing)} change the same single lever.`,
    }));
    block.append(stripSection);

    appendSolverConstraintStrip(block, payload);

    block.append(element('p', {
      className: 'solver-boundary-evidence-kicker',
      text: 'Evidence · matched cases behind the boundary',
    }));

    const evidenceCols = solverEvidenceColumns().filter((column) => (
      rows.some((row) => row?.outputs && Object.prototype.hasOwnProperty.call(row.outputs, column.id))
    ));
    const wrap = watchOverflow(element('div', { className: 'solver-table-wrap' }));
    const table = element('table', { className: 'solver-table solver-boundary-table' });
    const head = element('thead');
    const headRow = element('tr');
    headRow.append(element('th', { text: leverName }));
    evidenceCols.forEach((column) => headRow.append(element('th', { text: column.label })));
    headRow.append(element('th', { text: 'Changed' }));
    head.append(headRow);

    const body = element('tbody');
    rows.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const tr = element('tr');
      const keyCount = solverInputKeyCount(row);
      const count = solverDeviationCount(row);
      const leverDev = (Array.isArray(row.deviations) ? row.deviations : [])
        .find((dev) => dev?.input_id === leverId) || row.deviations?.[0] || {};
      tr.append(element('td', {
        className: 'metric-value',
        text: formatSolverBoundValue(leverDev.value, leverMeta.unit),
      }));
      evidenceCols.forEach((column) => {
        const meta = solverFieldMeta('output', column.id);
        const raw = row.outputs?.[column.id];
        const cell = element('td', { className: 'metric-value solver-output' });
        cell.textContent = isScalarNumber(raw) ? formatNumber(raw, meta.unit) : '—';
        tr.append(cell);
      });
      tr.append(element('td', {
        className: 'solver-changed-count',
        text: `${solverFormatCount(count)} of ${solverFormatCount(keyCount)} changed`,
      }));
      body.append(tr);
    });
    table.append(head, body);
    wrap.append(table);
    block.append(wrap);

    // Prefill-only actions: draft the follow-up, never auto-send it.
    const actionBar = element('div', { className: 'demo-card-actions' });
    actionBar.append(
      prefillButton('Check the evidence', solverEvidencePrefill(payload, leverId)),
      prefillButton('Change the target', solverAskPrefill(payload)),
    );
    block.append(actionBar);

    appendSolverCaveat(block, payload);
  }

  function renderSolverTable(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const matched = typeof payload?.matched === 'number' ? payload.matched : 0;
    const totalCached = typeof payload?.total_cached === 'number' ? payload.total_cached : 0;
    const block = resultShell(
      'SOLVER · SOLVE_SCENARIOS',
      solverCasesTitle(payload),
      solverMetaText(payload),
    );
    appendSolverConstraintStrip(block, payload);

    const keyCountSample = rows.reduce((max, row) => {
      const count = solverInputKeyCount(row);
      return count > max ? count : max;
    }, 0);
    const toolbar = element('div', { className: 'solver-toolbar' });
    toolbar.append(element('p', {
      className: 'solver-toolbar-summary',
      text: `${solverFormatCount(matched)} matched of ${solverFormatCount(totalCached)} cached · showing ${solverFormatCount(rows.length)} least-deviating`,
    }));
    const tabs = element('div', { className: 'solver-toolbar-tabs' });
    const tabDev = element('button', {
      className: 'solver-toolbar-tab is-active',
      text: 'Deviations only',
      attrs: { type: 'button' },
    });
    const tabAll = element('button', {
      className: 'solver-toolbar-tab',
      text: `All ${solverFormatCount(keyCountSample)} assumptions`,
      attrs: { type: 'button' },
    });
    tabs.append(tabDev, tabAll);
    toolbar.append(tabs);
    block.append(toolbar);

    const columns = solverOutputColumns(payload);
    const wrap = watchOverflow(element('div', { className: 'solver-table-wrap' }));
    const table = element('table', { className: 'solver-table' });
    const head = element('thead');
    const headRow = element('tr');
    headRow.append(
      element('th', { text: 'Case' }),
      element('th', { text: 'Assumptions changed from base' }),
    );
    columns.forEach((column) => headRow.append(element('th', { text: column.label })));
    headRow.append(element('th', { text: 'Inputs' }));
    head.append(headRow);

    const body = element('tbody');
    const rowViews = [];
    let ranked = 0;
    let mode = 'deviations';
    let openIndex = null;

    function syncRowViews() {
      const allOpen = mode === 'all';
      rowViews.forEach((view) => {
        const open = allOpen || openIndex === view.index;
        if (view.panel) view.panel.hidden = !open;
        if (view.toggle) {
          view.toggle.textContent = open
            ? `Hide ${solverFormatCount(view.unchangedCount)}`
            : `Show ${solverFormatCount(view.unchangedCount)}`;
        }
      });
      tabDev.classList.toggle('is-active', !allOpen);
      tabAll.classList.toggle('is-active', allOpen);
    }

    rows.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      if (!('inputs' in row) || !('outputs' in row) || !('deviations' in row)) return;
      const tr = element('tr');
      const count = solverDeviationCount(row);
      const keyCount = solverInputKeyCount(row);
      if (count === 0) {
        tr.className = 'solver-row-base';
        const caseCell = element('td', { className: 'solver-case' });
        caseCell.append(
          document.createTextNode('Base'),
          element('span', { className: 'sensitivity-base-badge', text: 'BASE' }),
        );
        tr.append(caseCell);
        tr.append(renderSolverDeviationCell(row, {
          baseNote: 'Golden assumption set — does not satisfy the target, shown for reference',
        }));
      } else {
        ranked += 1;
        const viewIndex = rowViews.length;
        tr.append(element('td', { className: 'solver-case', text: String(ranked) }));
        const { panel, unchangedCount } = buildUnchangedPanel(row);
        tr.append(renderSolverDeviationCell(row, { expandPanel: panel }));
        const toggle = element('button', {
          className: 'solver-expand-toggle',
          text: `Show ${solverFormatCount(unchangedCount)}`,
          attrs: { type: 'button' },
        });
        toggle.addEventListener('click', () => {
          mode = 'deviations';
          openIndex = openIndex === viewIndex ? null : viewIndex;
          syncRowViews();
        });
        rowViews.push({ panel, unchangedCount, toggle, index: viewIndex });
      }

      columns.forEach((column) => {
        const raw = row.outputs?.[column.id];
        const cell = element('td', { className: 'metric-value solver-output' });
        cell.textContent = isScalarNumber(raw) ? formatNumber(raw, column.unit) : '—';
        tr.append(cell);
      });

      const inputsCell = element('td', { className: 'solver-inputs-cell' });
      if (count === 0) {
        inputsCell.textContent = solverFormatCount(keyCount);
      } else {
        inputsCell.append(rowViews[rowViews.length - 1].toggle);
      }
      tr.append(inputsCell);
      body.append(tr);
    });

    table.append(head, body);
    wrap.append(table);
    block.append(wrap);

    tabDev.addEventListener('click', () => {
      mode = 'deviations';
      openIndex = null;
      syncRowViews();
    });
    tabAll.addEventListener('click', () => {
      mode = 'all';
      openIndex = null;
      syncRowViews();
    });
    syncRowViews();

    if (matched > rows.length) {
      block.append(element('div', {
        className: 'solver-truncation',
        text: `showing ${solverFormatCount(rows.length)} of ${solverFormatCount(matched)} matched · sorted by fewest assumptions changed · every figure read from the engine cache`,
      }));
    }

    const actionBar = element('div', { className: 'demo-card-actions' });
    actionBar.append(prefillButton('Change the target', solverAskPrefill(payload)));
    block.append(actionBar);

    appendSolverCaveat(block, payload);
  }

  function renderSolverResults(payload) {
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const matched = typeof payload?.matched === 'number' ? payload.matched : 0;
    if (matched === 0) {
      renderSolverEmpty(payload);
      return;
    }
    const leverId = dominantLever(rows);
    if (leverId) {
      renderSolverBoundary(payload, leverId);
      return;
    }
    renderSolverTable(payload);
  }

  // Harness / debug surface for solver_results rendering.
  window.__renderSolverResults = renderSolverResults;
  window.__dominantLever = dominantLever;

  /* ---------- deal-state rail ---------- */

  function headlineMetricIds(row) {
    const known = new Map((state.catalog?.output_meta || []).map((item) => [item.id, item]));
    const preferred = (state.catalog?.ui?.headline_output_ids || []).filter((id) => known.has(id));
    const fallback = (state.catalog?.output_meta || [])
      .filter((item) => item.shape === 'scalar')
      .map((item) => item.id);
    const candidates = (preferred.length ? preferred : fallback)
      .filter((id) => isScalarNumber(row?.[id]));
    // Pair IRRs with equity multiples: rate metric on the left of each rail
    // row, multiple on the right, so the pairs read together.
    const isMultiple = (id) => String(known.get(id)?.unit || '').toLowerCase().includes('multiple');
    const rates = candidates.filter((id) => !isMultiple(id));
    const multiples = candidates.filter(isMultiple);
    const ordered = [];
    while (ordered.length < 4 && (rates.length || multiples.length)) {
      if (rates.length) ordered.push(rates.shift());
      if (ordered.length < 4 && multiples.length) ordered.push(multiples.shift());
    }
    return ordered.slice(0, 4);
  }

  // One rail value. When a run lands (fresh) and the value changed, the new
  // text cross-fades in over the old under a brief accent underline; the old
  // text is the previous run's engine value, removed once it has faded.
  function railValue(tag, className, text, previous, fresh) {
    const node = element(tag, { className });
    const current = element('span', { className: 'rail-v', text });
    if (fresh && previous !== undefined && previous !== text) {
      node.classList.add('rail-swap');
      const old = element('span', { className: 'rail-v rail-v-old', text: previous, attrs: { 'aria-hidden': 'true' } });
      old.addEventListener('animationend', () => old.remove(), { once: true });
      node.append(old);
    } else if (fresh && previous === undefined) {
      node.classList.add('rail-fresh');
    }
    node.append(current);
    return node;
  }

  function renderDealState(fresh = false) {
    const model = state.catalog?.model || {};
    $('#deal-model').textContent = model.name || state.modelId;
    $('#deal-model-version').textContent = [
      titleCase(model.asset_class || ''),
      model.execution_status === 'available' ? 'engine ready' : (model.execution_status || ''),
    ].filter(Boolean).join(' · ');

    const shown = fresh ? (state.railShown || {}) : {};
    const nextShown = {};
    const run = state.lastRun;
    const countEl = $('#deal-override-count');
    const overridesEl = $('#deal-override-list');
    overridesEl.replaceChildren();
    if (!run) {
      countEl.textContent = '—';
    } else {
      const overrides = run.overrides || {};
      const labels = [...new Set(Object.entries(overrides).map(([id, value]) => describeOverride(id, value)))];
      nextShown.count = String(labels.length);
      countEl.replaceChildren(railValue('span', 'rail-count', nextShown.count, shown.count, fresh));
      const chipClass = fresh ? 'demo-override-chip rail-fresh' : 'demo-override-chip';
      labels.slice(0, 6).forEach((text) => {
        overridesEl.append(element('span', { className: chipClass, text }));
      });
      if (labels.length > 6) {
        overridesEl.append(element('span', { className: chipClass, text: `+${labels.length - 6} more` }));
      }
    }

    const metricsEl = $('#deal-metrics');
    metricsEl.replaceChildren();
    if (!run || !run.row) {
      metricsEl.append(element('p', {
        className: 'demo-deal-empty',
        text: 'No run yet. Results land here as the engine reports them.',
      }));
    } else {
      const known = new Map((state.catalog?.output_meta || []).map((item) => [item.id, item]));
      headlineMetricIds(run.row).forEach((id) => {
        const meta = known.get(id) || {};
        const cell = element('div', { className: 'demo-deal-metric' });
        const value = formatNumber(run.row[id], meta.unit || '');
        nextShown[`v:${id}`] = value;
        cell.append(
          element('span', { className: 'demo-deal-metric-label', text: meta.label || titleCase(id) }),
          railValue('span', 'demo-deal-metric-value', value, shown[`v:${id}`], fresh),
        );
        const delta = run.row?.delta_vs_base?.[id];
        if (isScalarNumber(delta)) {
          const deltaText = `${formatDeltaValue(delta, meta.unit || '')} vs base`;
          nextShown[`d:${id}`] = deltaText;
          cell.append(railValue(
            'span',
            `demo-deal-metric-delta ${delta > 0 ? 'delta-positive' : delta < 0 ? 'delta-negative' : ''}`,
            deltaText,
            shown[`d:${id}`],
            fresh,
          ));
        }
        metricsEl.append(cell);
      });
      if (!metricsEl.childElementCount) {
        metricsEl.append(element('p', {
          className: 'demo-deal-empty',
          text: 'The last run returned no scalar headline outputs.',
        }));
      }
    }

    const provenance = $('#deal-provenance');
    const hadProvenance = Boolean(provenance.textContent);
    provenance.textContent = !run
      ? ''
      : run.mock
        ? 'Fixture engine · not investment output'
        : 'Workbook engine';
    if (fresh && !hadProvenance && provenance.textContent) provenance.classList.add('rail-fresh');
    state.railShown = nextShown;
  }

  function updateDealState(payload, definitions, validRows) {
    const rows = Array.isArray(validRows) ? validRows : [];
    if (!rows.length) return;
    const currentIndex = rows.length - 1;
    const row = [...rows].reverse().find((item) => !item.is_base) || rows[currentIndex];
    const rowIndex = rows.indexOf(row);
    const definition = Array.isArray(definitions) ? definitions[rowIndex] : null;
    state.lastRun = {
      row,
      overrides: scenarioAssumptions(definition),
      mock: Boolean(payload?.mock),
    };
    renderDealState(true);
  }

  // The rail's width moves; its body keeps its width and fades (CSS), and
  // is inert while closed rather than [hidden], so nothing reflows. On a
  // phone the rail is a drawer under the site bar with a tap-to-close scrim.
  // Only a toggle moves the rail (CSS .moving), never a resize: the class
  // stays until the move ends, or goes at once if no move starts.
  let railMoveTimer = 0;
  const RAIL_MOVES = new Set(['width', 'transform']);
  function initRailMotion() {
    const rail = $('#deal-rail');
    rail.addEventListener('transitionrun', (event) => {
      if (event.target === rail && RAIL_MOVES.has(event.propertyName)) window.clearTimeout(railMoveTimer);
    });
    rail.addEventListener('transitionend', (event) => {
      if (event.target === rail && RAIL_MOVES.has(event.propertyName)) rail.classList.remove('moving');
    });
  }

  function setRailOpen(open) {
    state.railOpen = open;
    const rail = $('#deal-rail');
    if (document.documentElement.classList.contains('ready')) {
      rail.classList.add('moving');
      window.clearTimeout(railMoveTimer);
      railMoveTimer = window.setTimeout(() => rail.classList.remove('moving'), tokenMs('--dur-2'));
    }
    rail.dataset.collapsed = String(!open);
    $('#rail-collapse').setAttribute('aria-expanded', String(open));
    $('#rail-toggle').setAttribute('aria-expanded', String(open));
    $('#deal-rail-body').inert = !open;
  }

  function isPhoneRail() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  /* ---------- instance layer (docs/INSTANCE_LAYER.md) ----------
     Instances are data: a sparse override mapping plus a frozen output
     snapshot, pinned to template@fingerprint, stored in this browser via
     web/instances.js (IndexedDB). Save / open / rename / delete / export are
     local or HTTP actions — never asks: none of them touches the composer.
     Snapshot cards render stored engine payloads verbatim; nothing is
     recomputed here. */

  function instanceStore() {
    return window.uwInstances || null;
  }

  // Deal memory for the LLM: client-saved labels + input overrides only.
  // Output figures stay in IndexedDB for the snapshot card; they are not
  // posted, so the model cannot quote them as engine results.
  function instanceSummaries() {
    return (state.instances || []).slice(0, 8).map((instance) => ({
      name: instance.name,
      overrides: instance.overrides || {},
      model_fingerprint: instance.model_fingerprint ?? null,
      mock: Boolean(instance.mock),
    }));
  }

  // Display formatting only: relative wall-clock phrasing for stored
  // timestamps. Not an engine number.
  function relativeTime(iso) {
    const then = Date.parse(String(iso || ''));
    if (!Number.isFinite(then)) return '';
    // The page's own locale, as for numbers: a zh-CN browser wrote "now" in Chinese.
    const formatter = new Intl.RelativeTimeFormat(NUMBER_LOCALE, { numeric: 'auto' });
    let span = Math.round((then - Date.now()) / 1000);
    const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [5, 'week'], [12, 'month']];
    for (const [size, unit] of steps) {
      if (Math.abs(span) < size) return formatter.format(span, unit);
      span = Math.trunc(span / size);
    }
    return formatter.format(span, 'year');
  }

  // Instance JSON v1 (docs/INSTANCE_LAYER.md §2). Overrides are the sparse
  // mapping exactly as sent to the engine; outputs are the engine's result
  // row frozen verbatim, including delta_vs_base / is_base enrichment.
  function buildInstance(definition, row, payload) {
    const label = definition?.name || scenarioColumnLabel(definition, row);
    const now = new Date().toISOString();
    return {
      schema: 'uw-instance/1',
      id: crypto.randomUUID(),
      name: `${label} · ${new Date().toLocaleDateString()}`,
      entity: null,
      model_id: state.modelId,
      model_fingerprint: state.catalog?.model?.fingerprint ?? null,
      scenario_label: label,
      overrides: scenarioAssumptions(definition),
      outputs: row,
      mock: Boolean(payload?.mock),
      status: 'draft',
      created_at: now,
      updated_at: now,
    };
  }

  function appendInstanceSaveActions(block, definitions, valid, payload) {
    if (!valid.length) return;
    const bar = element('div', { className: 'demo-card-actions instance-save-bar' });
    valid.forEach((row, index) => {
      const name = definitions[index]?.name || scenarioColumnLabel(definitions[index], row);
      const button = element('button', {
        className: 'instance-save-button',
        text: valid.length === 1 ? 'Save instance' : `Save instance · ${name}`,
        attrs: { type: 'button', title: 'Keep this scenario in this browser' },
      });
      button.addEventListener('click', () => saveInstance(definitions[index], row, payload));
      bar.append(button);
    });
    block.append(bar);
  }

  async function saveInstance(definition, row, payload) {
    const store = instanceStore();
    if (!store) {
      showToast('Instance storage is unavailable in this browser.');
      return;
    }
    const instance = buildInstance(definition, row, payload);
    try {
      await store.save(instance);
    } catch (error) {
      showToast(error?.message || 'The instance could not be saved.');
      return;
    }
    showToast(`Saved “${instance.name}” to this browser.`);
    await refreshInstances();
    maybeRenderBoundaryCard();
  }

  async function refreshInstances() {
    const store = instanceStore();
    if (!store) {
      state.instances = [];
      renderInstanceList();
      return;
    }
    try {
      state.instances = await store.listByModel(state.modelId);
    } catch (_error) {
      state.instances = [];
    }
    renderInstanceList();
  }

  function renderInstanceList() {
    const container = $('#deal-instances');
    container.replaceChildren();
    if (!instanceStore()) {
      container.append(element('p', {
        className: 'demo-deal-empty',
        text: 'Instance storage is unavailable in this browser.',
      }));
      return;
    }
    if (!state.instances.length) {
      container.append(element('p', {
        className: 'demo-deal-empty',
        text: 'None saved yet. Use “Save instance” on a results card to keep a scenario in this browser.',
      }));
      return;
    }
    state.instances.forEach((instance) => {
      const item = element('div', { className: 'instance-item' });
      const open = element('button', {
        className: 'instance-open',
        attrs: { type: 'button', title: 'Open the frozen snapshot in the conversation' },
      });
      open.append(
        element('span', { className: 'instance-name', text: instance.name }),
        element('span', { className: 'instance-updated', text: relativeTime(instance.updated_at) }),
      );
      open.addEventListener('click', () => renderInstanceSnapshot(instance));
      const rename = element('button', {
        className: 'instance-action',
        text: '✎',
        attrs: { type: 'button', title: 'Rename', 'aria-label': `Rename ${instance.name}` },
      });
      rename.addEventListener('click', () => beginRename(item, instance));
      const remove = element('button', {
        className: 'instance-action instance-action-delete',
        text: '✕',
        attrs: { type: 'button', title: 'Delete', 'aria-label': `Delete ${instance.name}` },
      });
      remove.addEventListener('click', () => deleteInstance(instance));
      item.append(open, rename, remove);
      container.append(item);
    });
  }

  // Inline rename in the rail: the name swaps to a text input in place —
  // no modal. Enter or blur commits; Escape cancels.
  function beginRename(item, instance) {
    const input = element('input', {
      className: 'instance-rename-input',
      attrs: { type: 'text', 'aria-label': `New name for ${instance.name}` },
    });
    input.value = instance.name;
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      if (commit) {
        commitRename(instance, input.value);
      } else {
        renderInstanceList();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    item.replaceChildren(input);
    input.focus();
    input.select();
  }

  async function commitRename(instance, rawName) {
    const name = String(rawName || '').trim();
    if (!name || name === instance.name) {
      renderInstanceList();
      return;
    }
    const store = instanceStore();
    if (store) {
      try {
        await store.save({ ...instance, name, updated_at: new Date().toISOString() });
      } catch (error) {
        showToast(error?.message || 'The instance could not be renamed.');
      }
    }
    await refreshInstances();
  }

  async function deleteInstance(instance) {
    const store = instanceStore();
    if (store) {
      try {
        await store.remove(instance.id);
        showToast(`Deleted “${instance.name}”.`);
      } catch (error) {
        showToast(error?.message || 'The instance could not be deleted.');
      }
    }
    await refreshInstances();
  }

  // Frozen snapshot card: name, fingerprint pin, saved overrides, and the
  // stored engine outputs — rendered through the same textContent-only
  // primitives as live results. Values are shown exactly as saved.
  function renderInstanceSnapshot(instance) {
    const meta = [instance.scenario_label, `saved ${relativeTime(instance.updated_at)}`]
      .filter(Boolean).join(' · ');
    const block = resultShell('SAVED INSTANCE', instance.name || 'Instance', meta);

    const pinRow = element('div', { className: 'instance-pin-row' });
    if (instance.model_fingerprint) {
      const pin = element('span', {
        className: 'instance-pin',
        attrs: { title: instance.model_fingerprint },
      });
      pin.append(
        element('span', { className: 'instance-pin-kicker', text: 'template@' }),
        element('span', { className: 'instance-pin-value', text: instance.model_fingerprint }),
      );
      pinRow.append(pin);
    } else {
      pinRow.append(element('span', {
        className: 'instance-pin instance-pin-unpinned',
        text: 'unpinned — no engine fingerprint was recorded at save time',
      }));
    }
    block.append(pinRow);

    const overrides = instance.overrides && typeof instance.overrides === 'object'
      ? instance.overrides
      : {};
    const overrideIds = Object.keys(overrides);
    const overridesWrap = element('div', { className: 'instance-overrides' });
    overridesWrap.append(element('p', {
      className: 'instance-section-label',
      text: overrideIds.length ? 'Saved overrides' : 'Saved overrides · base case, none',
    }));
    if (overrideIds.length) {
      const chips = element('div', { className: 'demo-deal-overrides' });
      overrideIds.forEach((id) => {
        const inputMeta = inputCatalogEntry(id);
        chips.append(element('span', {
          className: 'demo-override-chip',
          text: `${inputMeta.label || titleCase(id)} → ${formatNumber(overrides[id], inputMeta.unit || '')}`,
        }));
      });
      overridesWrap.append(chips);
    }
    block.append(overridesWrap);

    const row = instance.outputs && typeof instance.outputs === 'object' ? instance.outputs : {};
    const metrics = metricMetadata(row);
    const deltas = row.delta_vs_base && typeof row.delta_vs_base === 'object'
      ? row.delta_vs_base
      : null;
    if (!metrics.length) {
      block.append(element('div', {
        className: 'result-narrative',
        text: 'This instance holds no scalar headline outputs.',
      }));
    } else {
      const table = element('table', { className: 'metrics-table' });
      const head = element('thead');
      const headRow = element('tr');
      headRow.append(element('th', { text: 'Metric' }));
      const valueHead = element('th');
      valueHead.append(document.createTextNode(instance.scenario_label || 'Saved value'));
      if (row.is_base) valueHead.append(element('span', { className: 'sensitivity-base-badge', text: 'BASE' }));
      headRow.append(valueHead);
      if (deltas) headRow.append(element('th', { text: 'Δ vs base' }));
      head.append(headRow);
      const body = element('tbody');
      metrics.forEach((metric) => {
        const tr = element('tr');
        tr.append(element('td', { className: 'metric-label', text: metric.label }));
        tr.append(element('td', { className: 'metric-value', text: formatNumber(row[metric.id], metric.unit) }));
        if (deltas) {
          const deltaValue = deltas[metric.id];
          const tone = isScalarNumber(deltaValue)
            ? (deltaValue > 0 ? 'delta-positive' : deltaValue < 0 ? 'delta-negative' : '')
            : '';
          tr.append(element('td', {
            className: `metric-value ${tone}`,
            text: formatDeltaValue(deltaValue, metric.unit),
          }));
        }
        body.append(tr);
      });
      table.append(head, body);
      block.append(scrollWrap(table));
    }

    const actions = element('div', { className: 'demo-card-actions' });
    const exportButton = element('button', {
      className: 'instance-export-button',
      text: 'Export workbook (.xlsx)',
      attrs: { type: 'button', title: 'Download this scenario as a live Excel workbook' },
    });
    exportButton.addEventListener('click', () => exportWorkbook(instance, exportButton));
    actions.append(exportButton);
    block.append(actions);

    const footer = element('footer', { className: 'result-footer' });
    footer.append(
      element('span', {
        text: instance.mock ? 'Fixture engine · not investment output' : 'Workbook engine',
      }),
      element('span', { className: 'instance-footer-note', text: 'Frozen snapshot · values as saved' }),
    );
    block.append(footer);
  }

  // Free-tier durability story: the exported workbook file. The request
  // carries only the overrides already sent for evaluation, nothing else.
  async function exportWorkbook(instance, button) {
    if (button) button.disabled = true;
    try {
      const response = await fetch('/api/export/workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario: instance.overrides || {},
          model_id: instance.model_id,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 503) {
          showToast('Workbook export needs the live engine — this desk is serving fixture numbers.');
        } else {
          showToast(payload.error || `Workbook export failed (${response.status}).`);
        }
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${modelFileStem(instance.model_id)}_scenario.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      maybeRenderBoundaryCard();
    } catch (error) {
      showToast(error?.message || 'Workbook export failed.');
    } finally {
      if (button) button.disabled = false;
    }
  }

  // Boundary moment (journey step 6): informational only — a gradient, not a
  // wall. Nothing free is gated, there is no sign-up prompt, and the copy is
  // digit-free by design (pinned in tests/test_demo.py).
  function maybeRenderBoundaryCard() {
    if (state.boundaryShown) return;
    state.boundaryShown = true;
    const turn = element('div', { className: 'turn' });
    const card = element('aside', { className: 'instance-boundary-card' });
    card.append(
      element('p', { className: 'result-kicker', text: 'WHERE THIS LIVES' }),
      element('p', {
        className: 'instance-boundary-copy',
        text: 'This instance is saved in this browser on this device. Nothing was uploaded — the desk keeps no account and holds no server copy of your work.',
      }),
    );
    turn.append(card);
    $('#transcript').append(landed(turn));
  }

  /* ---------- presets + composer ---------- */

  function renderPresets() {
    const presets = state.catalog?.presets || [];
    const list = $('#preset-list');
    list.replaceChildren();
    presets.forEach((preset) => {
      const button = element('button', {
        className: 'demo-preset-button',
        text: preset.label,
        attrs: { type: 'button' },
      });
      button.addEventListener('click', () => runPreset(preset));
      list.append(button);
    });
    $('#preset-panel').hidden = !presets.length;
  }

  /* Ghost suggestion: once the conversation has started the preset panel is
     gone (it lives in the welcome screen), so the next askable question shows
     as a grey hint at the composer. Tab (or click) drafts it into the input —
     it never sends. Sources, in priority order: LLM-provided follow-ups from
     a `suggestions` SSE event, then (preset mode only) the next verified
     question not yet asked this conversation. */

  function normalizedQuestion(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function markPresetAsked(text) {
    const query = normalizedQuestion(text);
    (state.catalog?.presets || []).forEach((preset) => {
      if (normalizedQuestion(preset.label) === query) state.askedPresetIds.add(preset.id);
    });
  }

  function currentSuggestion() {
    if (state.busy) return '';
    if (!$('#transcript').childElementCount) return '';
    if (state.suggestions.length) return state.suggestions[0];
    if (state.catalog?.llm_available) return '';
    const presets = state.catalog?.presets || [];
    const next = presets.find((preset) => !state.askedPresetIds.has(preset.id));
    return next ? next.label : '';
  }

  function modePlaceholder() {
    // The composer is one line tall; a phone gets the short form so the
    // placeholder is not cut mid-sentence (UAT QA 2026-10-12).
    const narrow = window.matchMedia('(max-width: 820px)').matches;
    if (!state.catalog) return narrow ? 'Ask about this deal…' : 'Ask about returns, assumptions, or model logic…';
    if (state.catalog.llm_available) {
      return narrow ? 'e.g. LP IRR if occupancy −5 pts?' : 'e.g. What happens to LP IRR if occupancy drops 5 points?';
    }
    if ((state.catalog.presets || []).length) {
      return narrow ? 'Ask, or pick a question above…' : 'Type a verified question, or pick one above…';
    }
    return 'Free-form analysis is not enabled for this model';
  }

  function updateSuggestion() {
    const input = $('#ask-input');
    const ghost = $('#composer-suggestion');
    const suggestion = currentSuggestion();
    const show = Boolean(suggestion) && !input.value.trim();
    $('#composer-suggestion-text').textContent = suggestion;
    if (show && ghost.hidden) {
      // The hint is the last thing to land after a run (--dur-4 after the
      // last card), and fades in; set only as it appears, so a hint already
      // showing never blinks.
      ghost.style.setProperty('--ghost-delay', `${Math.round(afterArrival(tokenMs('--dur-4')))}ms`);
    }
    ghost.hidden = !show;
    // The ghost sits inline where the placeholder would render; never both.
    // Mid-run the line stays empty, so the hint is the only thing to appear.
    input.placeholder = show || (state.busy && hasConversation()) ? '' : modePlaceholder();
  }

  // A link may carry a question (/desk.html?ask=...), e.g. the story page's
  // last button. It lands in the composer once the desk can take it, and is
  // never sent on its own: the reader stays in command of what is asked.
  let pendingAsk = (new URLSearchParams(window.location.search).get('ask') || '').trim().slice(0, 500);

  function updateComposer() {
    const llmAvailable = Boolean(state.catalog?.llm_available);
    const presetsAvailable = (state.catalog?.presets || []).length > 0;
    const available = (llmAvailable || presetsAvailable) && !state.busy;
    $('#ask-input').disabled = !available;
    $('#ask-button').disabled = !available;
    if (available && pendingAsk) {
      const text = pendingAsk;
      pendingAsk = '';
      prefillComposer(text);
    }
    const buttons = $('#preset-list').querySelectorAll('button');
    buttons.forEach((button) => { button.disabled = state.busy; });
    $('#teach-list').querySelectorAll('button').forEach((button) => { button.disabled = state.busy; });
    updateSuggestion();
  }

  /* ---------- catalog ---------- */

  // Demo runs on the economical narrator; premium narrators render as
  // locked so the picker communicates the LLM is swappable, not a secret.
  const LOCKED_LLMS = ['Claude Sonnet 5', 'GPT-5.2', 'Gemini 3 Pro'];

  function renderLlmSelect() {
    const select = $('#llm-select');
    if (!select) return;
    select.replaceChildren();
    const active = state.catalog?.llm_model || '';
    const label = state.catalog?.llm_available
      ? (active || 'LLM')
      : 'Preset mode (no LLM)';
    const current = element('option', { text: label, attrs: { value: 'active' } });
    current.selected = true;
    select.append(current);
    LOCKED_LLMS.forEach((name) => {
      const option = element('option', { text: `${name} · 🔒 locked`, attrs: { value: '' } });
      option.disabled = true;
      select.append(option);
    });
    select.disabled = state.busy;
  }

  function renderCatalog() {
    const model = state.catalog.model || {};
    const models = state.catalog.models || [model];
    const select = $('#model-select');
    select.replaceChildren();
    models.forEach((item) => {
      const option = element('option', { text: item.name || item.id, attrs: { value: item.id } });
      option.selected = item.id === state.modelId;
      select.append(option);
    });
    select.disabled = state.busy;
    // A prospect has nothing to choose between on a single-model deployment.
    select.hidden = models.length <= 1;
    renderLlmSelect();
    setStatusPill(
      model.execution_status === 'available' ? 'Ready' : (model.execution_status || 'Unavailable'),
      model.execution_status || 'unavailable',
    );
    $('#asset-class').textContent = titleCase(model.asset_class || model.id);
    $('#workspace-subtitle').textContent = model.execution_status === 'available'
      ? 'Start with a question below. Each one runs the model live.'
      : (model.status_detail || model.limitation || 'This model is available for catalog inspection only.');
    renderPresets();
    // The starter panels arrive together, once the catalog has: no panel
    // pushes another down after first paint.
    $('#teach-panel').hidden = false;
    updateComposer();
    renderDealState();
  }

  // The bar's status pill: its colour cross-fades (CSS transition) and the
  // new label fades in, so "Loading" never snaps to "Ready".
  function setStatusPill(text, status) {
    const pill = $('#model-status');
    pill.dataset.status = status;
    if (pill.textContent === text) return;
    pill.textContent = text;
    pill.classList.remove('swap');
    void pill.offsetWidth;
    pill.classList.add('swap');
    pill.addEventListener('animationend', () => pill.classList.remove('swap'), { once: true });
  }

  async function loadCatalog(modelId) {
    setBusy(true, 'Loading model contract…');
    try {
      const catalog = await fetchJson(`/api/catalog?model_id=${encodeURIComponent(modelId)}`);
      state.catalog = catalog;
      state.modelId = catalog.model?.id || modelId;
      const url = new URL(window.location.href);
      if (state.modelId === LANDING_MODEL_ID) url.searchParams.delete('model_id');
      else url.searchParams.set('model_id', state.modelId);
      window.history.replaceState({}, '', url);
      clearAnalysis();
      renderCatalog();
      refreshInstances();
    } catch (error) {
      setStatusPill('Error', 'error');
      errorResult(error.message, 'The demo desk could not load');
    } finally {
      setBusy(false);
    }
  }

  /* ---------- SSE chat loop (POST /api/chat) ---------- */

  function parseSseFrames(source, flush) {
    let buffer = source.replace(/\r\n/g, '\n');
    const events = [];
    for (;;) {
      let boundary = buffer.indexOf('\n\n');
      if (boundary === -1 && flush && buffer.trim()) boundary = buffer.length;
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = boundary === buffer.length ? '' : buffer.slice(boundary + 2);
      let eventName = 'message';
      const data = [];
      frame.split('\n').forEach((line) => {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      });
      if (!data.length) continue;
      try { events.push({ eventName, payload: JSON.parse(data.join('\n')) }); } catch (_) { /* Ignore malformed frames. */ }
    }
    return { events, buffer };
  }

  function handleSseEvent(eventName, payload, context) {
    const trace = context.trace || null;
    if (eventName === 'status') {
      setBusy(true, payload.text || 'Working…');
      if (trace) traceStatus(trace, payload.text || 'Working…');
    }
    if (eventName === 'tool_call') {
      context.ranTools = true;
      rememberInputMeta(payload);
      state.lastScenarios = Array.isArray(payload.scenarios) ? payload.scenarios : [];
      setBusy(true, payload.name ? `Executing ${titleCase(payload.name)}…` : 'Executing analysis tool…');
      if (trace && state.lastScenarios.length) {
        const labels = state.lastScenarios.map((scenario, index) => {
          const assumptions = scenarioAssumptions(scenario);
          if (!isGenericScenarioName(scenario?.name)) return `S${index + 1} / ${scenario.name}`;
          if (!Object.keys(assumptions).length) return 'Base';
          return `S${index + 1} / ${describeOverrides(assumptions)}`;
        });
        traceRow(
          trace,
          payload.name ? `execute ${payload.name}` : 'execute tool',
          `${labels.length} scenario${labels.length === 1 ? '' : 's'}`,
          labels,
        );
      }
    }
    if (eventName === 'progress' && trace) {
      const total = payload.total || 0;
      const resolved = payload.resolved || 0;
      const pendingCount = payload.pending || 0;
      const text = pendingCount
        ? `${resolved}/${total} resolved · ${pendingCount} in engine`
        : `${resolved}/${total} resolved`;
      if (!context.progressRow) {
        const item = traceRow(trace, 'engine run', text);
        if (item) {
          context.progressRow = {
            secondary: item.querySelector('.secondary'),
            tick: item.querySelector('.tick'),
          };
          context.progressRow.tick.textContent = '●';
          context.progressRow.tick.classList.add('live');
        }
      } else {
        context.progressRow.secondary.textContent = text;
      }
      if (context.progressRow && !pendingCount && total > 0 && resolved >= total) {
        context.progressRow.tick.textContent = '✓';
        context.progressRow.tick.classList.remove('live');
      }
    }
    if (eventName === 'catalog_results' && trace) {
      traceRow(
        trace,
        'catalog search',
        payload.query || '',
        (payload.results || []).slice(0, 8).map(itemLabel),
      );
    }
    if (eventName === 'reference_results' && trace) {
      const matches = payload.resolution?.matches || [];
      traceRow(
        trace,
        'resolve reference',
        `${matches.length} match${matches.length === 1 ? '' : 'es'}`,
        matches.slice(0, 8).map(itemLabel),
      );
    }
    if (eventName === 'knowledge_results' && trace) {
      const value = payload.results || {};
      const items = Array.isArray(value) ? value : (value.matches || value.definitions || []);
      traceRow(
        trace,
        'model knowledge',
        `${items.length} item${items.length === 1 ? '' : 's'}`,
        items.slice(0, 8).map(itemLabel),
      );
    }
    if (eventName === 'story') {
      const parts = Array.isArray(payload.parts) ? payload.parts : [];
      if (trace) traceRow(trace, 'the story', `${parts.length} part${parts.length === 1 ? '' : 's'}`, parts.map((part) => part.title));
      renderStoryLinks(payload);
    }
    if (['results', 'sensitivity_results', 'solver_results'].includes(eventName)) rememberInputMeta(payload);
    if (eventName === 'results') {
      if (trace) {
        const count = (payload.results || []).length;
        traceRow(trace, 'engine results', `${count} scenario${count === 1 ? '' : 's'}`);
      }
      renderScenarioResults(payload, { scenarios: state.lastScenarios });
    }
    if (eventName === 'sensitivity_results') {
      if (trace) {
        const count = (payload.rows || []).length;
        const label = payload.input?.label || payload.input?.id || 'input';
        traceRow(trace, 'sensitivity', `${label} · ${count} point${count === 1 ? '' : 's'}`);
      }
      renderSensitivityResults(payload);
    }
    if (eventName === 'solver_results') {
      if (trace) {
        const matched = typeof payload.matched === 'number' ? payload.matched : (payload.rows || []).length;
        const total = typeof payload.total_cached === 'number' ? payload.total_cached : 0;
        traceRow(
          trace,
          'solver',
          `${new Intl.NumberFormat(NUMBER_LOCALE).format(matched)} / ${new Intl.NumberFormat(NUMBER_LOCALE).format(total)} matched`,
        );
      }
      renderSolverResults(payload);
    }
    if (eventName === 'scenario_set' && trace) {
      traceRow(trace, 'scenario draft', payload.saved?.id ? 'saved snapshot' : 'unsaved draft');
    }
    if (eventName === 'teach_visual') {
      if (trace) traceRow(trace, 'teaching card', payload.visual || 'console');
      renderTeachVisual(payload);
    }
    if (eventName === 'narration') renderNarration(payload.text, Boolean(context.ranTools));
    if (eventName === 'error') {
      context.failed = true;
      settleTrace(trace, 'Analysis failed', { failed: true });
      errorResult(
        payload?.message || 'The analysis stream returned an error.',
        'Analysis could not complete',
        payload,
      );
    }
    if (eventName === 'suggestions') {
      // LLM-drafted follow-up questions (text only; never auto-sent). They
      // surface as the composer's grey Tab hint, not as conversation content.
      state.suggestions = (Array.isArray(payload.items) ? payload.items : [])
        .filter((item) => typeof item === 'string' && item.trim())
        .slice(0, 3);
    }
    if (eventName === 'done') {
      context.done = true;
      settleTrace(trace);
    }
  }

  async function streamChat({ text = '', preset = null, label = text }) {
    if (state.busy) return;
    state.busy = true;
    state.suggestions = [];
    markPresetAsked(label);
    // The request leaves now; the welcome fades out while it is in flight,
    // and the stream is read only once the turn and its trace are on the
    // page, so no event can land before them.
    const request = fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: conversationMessages(text || label),
        preset,
        model_id: state.modelId,
        instances: instanceSummaries(),
      }),
    });
    request.catch(() => {});
    await leaveWelcome();
    userTurn(label);
    const context = { failed: false, done: false, trace: createTrace() };
    setBusy(true, 'Dispatching analysis…');
    try {
      const response = await request;
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parsed = parseSseFrames(buffer, false);
        buffer = parsed.buffer;
        parsed.events.forEach((item) => handleSseEvent(item.eventName, item.payload, context));
      }
      buffer += decoder.decode();
      const parsed = parseSseFrames(buffer, true);
      parsed.events.forEach((item) => handleSseEvent(item.eventName, item.payload, context));
      if (!context.done && !context.failed) throw new Error('Analysis stream ended before completion.');
    } catch (error) {
      settleTrace(context.trace, 'Analysis failed', { failed: true });
      if (!context.failed) errorResult(error.message);
    } finally {
      settleTrace(context.trace);
      setBusy(false);
    }
  }

  function runPreset(preset) {
    return streamChat({ preset: preset.id, label: preset.label });
  }

  /* ---------- teaching cards (precomputed engine grids, from the how-it-works page) ----------
   * Every figure in these cards is a stored evaluate_scenarios result over
   * cleanroom_senior_living (web/teach/*.json); the front end only formats,
   * indexes, and counts — it never computes a financial number. */

  const teachData = {};
  async function fetchTeachData(kind) {
    if (!teachData[kind]) {
      const response = await fetch(`/static/teach/${kind}.json`);
      if (!response.ok) throw new Error(`Teaching data unavailable (${response.status})`);
      teachData[kind] = await response.json();
    }
    return teachData[kind];
  }

  const TEACH_VERDICTS = {
    0: 'Airborne. The promote is alive and the debt is cheaper than the building.',
    1: 'The waterfall collapsed — everyone gets pro-rata. The GP promote is gone.',
    2: 'Borrowing costs more than the building earns. Leverage is working against you.',
    3: 'Promote dead and the debt is eating the deal. This building is out of business.',
    4: 'The DSCR floor shrank the loan — more equity needed for the same building.',
    5: 'Loan re-sized and the promote is gone. The GP put in more and gets less.',
    6: 'Smaller loan, inverted leverage — every borrowed dollar subtracts.',
    7: 'Every light is on. Walk away.',
  };

  function teachConsoleIndex(dials, detents) {
    let index = 0;
    dials.forEach((dial, i) => { index = index * dial.detents.length + detents[i]; });
    return index;
  }

  function teachBps(value) { return value === null ? 'no IRR' : `${(value / 100).toFixed(2)}%`; }

  function renderTeachConsole(data, requested) {
    const detents = data.dials.map((dial, i) => {
      const value = Number.isInteger(requested?.[i]) ? requested[i] : dial.base;
      return Math.min(Math.max(value, 0), dial.detents.length - 1);
    });
    const block = resultShell(
      'Teaching grid',
      'Fly it yourself',
      `${data.rows.length.toLocaleString('en-US')} precomputed engine runs · ${modelDisplayName(data.model_id)}`,
    );
    const wrap = element('div', { className: 'teach-console' });
    const dialBox = element('div', { className: 'teach-dials' });
    const readout = element('div', { className: 'teach-readout' });
    wrap.append(dialBox, readout);
    block.append(wrap);

    const gpEl = element('div', { className: 'teach-gp' });
    const deltaEl = element('div', { className: 'teach-delta' });
    const subEl = element('div', { className: 'teach-sub' });
    const lampsEl = element('div', { className: 'teach-lamps' });
    const lampNames = ['PROMOTE LOST', 'LEVERAGE INVERTED', 'LOAN RE-SIZED'];
    const lamps = lampNames.map((name, i) => {
      const lamp = element('span', { className: i === 2 ? 'teach-lamp warn' : 'teach-lamp', text: name });
      lampsEl.append(lamp);
      return lamp;
    });
    const verdictEl = element('p', { className: 'teach-verdict' });
    const footEl = element('p', { className: 'teach-foot' });
    // Bridge to the live engine: drafts (never sends) a question describing
    // the current dial combination so the chat can recompute it fresh.
    const verifyButton = element('button', {
      className: 'demo-prefill-button',
      text: 'Verify this combination live',
      attrs: { type: 'button' },
    });
    verifyButton.addEventListener('click', () => {
      const setting = data.dials
        .map((dial, i) => `${dial.label} ${dial.detents[detents[i]]}`)
        .join(', ');
      prefillComposer(
        `Evaluate a scenario with ${setting} and report `
        + 'GP IRR, LP IRR, deal IRR, DSCR, and the loan size.',
      );
    });
    readout.append(gpEl, deltaEl, subEl, lampsEl, verdictEl, verifyButton, footEl);

    function paint() {
      const index = teachConsoleIndex(data.dials, detents);
      const row = data.rows[index];
      const [gp, lp, deal, unlev, loan, dscr, flags, dgp] = row;
      gpEl.textContent = teachBps(gp);
      gpEl.className = `teach-gp${dgp > 0 ? ' up' : dgp < 0 ? ' down' : ''}`;
      deltaEl.textContent = index === data.base_index
        ? 'as underwritten'
        : dgp === null ? 'GP never gets its money back'
          : `${dgp > 0 ? '+' : '−'}${Math.abs(dgp)} bps vs base GP`;
      subEl.replaceChildren(
        element('span', { text: `LP ${teachBps(lp)}` }),
        element('span', { text: `Deal ${teachBps(deal)}` }),
        element('span', { text: `Unlevered ${teachBps(unlev)}` }),
        element('span', { text: `DSCR ${(dscr / 100).toFixed(2)}×` }),
        element('span', { text: `Loan $${(loan / 1e6).toFixed(2)}M` }),
      );
      lamps.forEach((lamp, i) => lamp.classList.toggle('lit', Boolean(flags & (1 << i))));
      verdictEl.textContent = TEACH_VERDICTS[flags] || '';
      footEl.textContent = `engine run ${(index + 1).toLocaleString('en-US')} of `
        + `${data.rows.length.toLocaleString('en-US')} · full-factorial grid · nothing interpolated`;
    }

    data.dials.forEach((dial, dialIndex) => {
      const row = element('div', { className: 'teach-dial-row' });
      row.append(element('span', { className: 'teach-dial-label', text: dial.label }));
      const seg = element('div', { className: 'teach-seg', attrs: { role: 'group', 'aria-label': dial.label } });
      dial.detents.forEach((label, detentIndex) => {
        const button = element('button', { className: 'teach-seg-button', text: label, attrs: { type: 'button' } });
        button.addEventListener('click', () => {
          detents[dialIndex] = detentIndex;
          seg.querySelectorAll('.teach-seg-button').forEach((el, i) =>
            el.classList.toggle('on', i === detentIndex));
          paint();
        });
        if (detentIndex === detents[dialIndex]) button.classList.add('on');
        seg.append(button);
      });
      row.append(seg);
      dialBox.append(row);
    });
    paint();
  }

  function renderTeachCloud(data, args) {
    const hasBand = Number.isFinite(args?.irr_min) || Number.isFinite(args?.irr_max);
    const lo = Number.isFinite(args?.irr_min) ? args.irr_min : -Infinity;
    const hi = Number.isFinite(args?.irr_max) ? args.irr_max : Infinity;
    // Row layout (scripts/build_scenario_cloud.py): axis values, then GP IRR,
    // then the base-case flag named in row_fields. A null GP IRR (GP never
    // gets its money back) plots at the axis floor.
    const irrIndex = data.dims.length;
    const baseIndex = data.row_fields.indexOf('base');
    const irrMin = Math.max(data.irr.lo, -20);
    const gpOf = (row) => (row[irrIndex] === null ? irrMin : Math.max(irrMin, row[irrIndex]));
    const inBand = (row) => row[irrIndex] !== null && row[irrIndex] >= lo && row[irrIndex] <= hi;
    const bandCount = hasBand ? data.rows.filter(inBand).length : data.rows.length;
    const block = resultShell(
      'Teaching grid',
      'One deal, many scenarios',
      `${data.rows.length.toLocaleString('en-US')} precomputed engine runs · ${modelDisplayName(data.model_id)}`,
    );
    const canvas = element('canvas', { className: 'teach-cloud' });
    block.append(canvas);
    const note = hasBand
      ? `${bandCount.toLocaleString('en-US')} of ${data.rows.length.toLocaleString('en-US')} runs land `
        + `in the highlighted GP IRR band`
      : (data.showN >= data.rows.length
          ? `all ${data.rows.length.toLocaleString('en-US')} runs · `
          : `showing ${Math.min(data.showN, data.rows.length).toLocaleString('en-US')} of ${data.rows.length.toLocaleString('en-US')} runs · `)
        + 'the orange line is the golden base case';
    block.append(element('p', { className: 'teach-foot', text: note }));

    const dims = data.dims.concat([{ label: 'GP IRR', min: irrMin, max: data.irr.hi, unit: '%' }]);
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(block.clientWidth || 640, 760);
    const height = 260;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const padX = 40;
    const padTop = 26;
    const padBottom = 16;
    const axisX = (i) => padX + (i * (width - padX * 2)) / (dims.length - 1);
    const valY = (dim, value) =>
      padTop + (1 - (value - dim.min) / (dim.max - dim.min)) * (height - padTop - padBottom);
    // Red below the pref (promote gone), green above it.
    const ramp = (irr) => {
      const t = irr < data.irr.pref
        ? 0.5 * Math.min(Math.max((irr - irrMin) / (data.irr.pref - irrMin), 0), 1)
        : 0.5 + 0.5 * Math.min((irr - data.irr.pref) / (data.irr.hi - data.irr.pref), 1);
      return `rgb(${Math.round(190 - 140 * t)}, ${Math.round(70 + 80 * t)}, ${Math.round(60 + 30 * t)})`;
    };
    const drawRow = (row, stroke, widthPx, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      dims.forEach((dim, i) => {
        const x = axisX(i);
        const y = valY(dim, i === irrIndex ? gpOf(row) : row[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    const visible = data.rows.slice(0, Math.min(data.showN, data.rows.length));
    const baseAlpha = visible.length > 1000 ? 0.06 : 0.28;
    visible.forEach((row) => {
      if (row[baseIndex]) return; // base drawn last, on top
      const faded = hasBand && !inBand(row);
      drawRow(row, ramp(gpOf(row)), 0.7, faded ? 0.02 : baseAlpha);
    });
    if (hasBand) {
      data.rows.forEach((row) => {
        if (!row[baseIndex] && inBand(row)) drawRow(row, ramp(gpOf(row)), 0.7, 0.4);
      });
    }
    drawRow(data.rows[0], getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#c05b2e', 2.2, 1);
    ctx.globalAlpha = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const style = getComputedStyle(document.documentElement);
    ctx.fillStyle = style.getPropertyValue('--ink-muted') || '#777';
    ctx.strokeStyle = style.getPropertyValue('--line') || '#ccc';
    dims.forEach((dim, i) => {
      const x = axisX(i);
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, height - padBottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(dim.label, x, padTop - (i % 2 ? 16 : 6));
    });
  }

  function renderTeachVisual(payload) {
    const visual = payload.visual === 'cloud' ? 'cloud' : 'console';
    fetchTeachData(visual)
      .then((data) => {
        if (visual === 'cloud') renderTeachCloud(data, payload);
        else renderTeachConsole(data, payload.detents);
        // Ghost follow-ups: the card is precomputed; the natural next step is
        // asking the desk to compute something live.
        state.suggestions = visual === 'cloud'
          ? ['Which operating assumption moves GP IRR the most?',
             'Run the base case and show verified outputs.']
          : ['What happens to the waterfall when occupancy drops 7.5 points?',
             'Which dial kills the GP promote fastest?'];
        updateSuggestion();
      })
      .catch((error) => errorResult(error.message, 'Teaching card could not load'));
  }

  // Welcome-screen starter chips for the teaching cards. Client-side render:
  // no chat turn, no engine call — the grids are precomputed.
  const TEACH_CHIPS = [
    { label: 'Fly the deal console', payload: { visual: 'console' } },
    { label: 'One deal, 5,001 scenarios', payload: { visual: 'cloud' } },
  ];

  function renderTeachChips() {
    const list = $('#teach-list');
    TEACH_CHIPS.forEach(({ label, payload }) => {
      const button = element('button', {
        className: 'demo-preset-button',
        text: label,
        attrs: { type: 'button' },
      });
      button.addEventListener('click', async () => {
        if (state.busy || welcomeLeaving) return;
        await leaveWelcome();
        userTurn(label);
        renderTeachVisual(payload);
      });
      list.append(button);
    });
  }

  /* ---------- wiring ---------- */

  $('#model-select').addEventListener('change', (event) => {
    const nextModel = event.target.value;
    if (nextModel === state.modelId) return;
    loadCatalog(nextModel);
  });

  $('#composer').addEventListener('submit', (event) => {
    event.preventDefault();
    settleGhost();
    const text = $('#ask-input').value.trim();
    const canChat = Boolean(state.catalog?.llm_available) || (state.catalog?.presets || []).length;
    if (!text || state.busy || !canChat) return;
    $('#ask-input').value = '';
    streamChat({ text });
  });

  $('#ask-input').addEventListener('input', (event) => {
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
    updateSuggestion();
  });

  $('#ask-input').addEventListener('keydown', (event) => {
    // Enter that picks a character in an input method (Chinese, Japanese) is not a send
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#composer').requestSubmit();
    }
    if (event.key === 'Tab' && !event.shiftKey && !$('#composer-suggestion').hidden) {
      // Accept the grey hint: it warms to ink in place, then drafts into the
      // input. Never sends.
      event.preventDefault();
      warmGhost(prefillComposer);
    }
  });

  // Ghost text becomes your draft: the hint stays where it is, its colour
  // warms to ink over --dur-1 while the TAB key fades, and only then does the
  // same text enter the textarea, at the same place, as yours. Typing in the
  // meantime wins.
  let ghostPending = null;
  function warmGhost(draft) {
    const ghost = $('#composer-suggestion');
    if (ghostPending) return;
    const text = $('#composer-suggestion-text').textContent;
    ghost.classList.add('accepting');
    ghostPending = { draft, text, timer: window.setTimeout(settleGhost, tokenMs('--dur-1')) };
  }

  // Ends a warming ghost now (its timer, or an Enter pressed mid-warm, so a
  // quick Tab-Enter still sends the drafted question).
  function settleGhost() {
    if (!ghostPending) return;
    const { draft, text, timer } = ghostPending;
    ghostPending = null;
    window.clearTimeout(timer);
    $('#composer-suggestion').classList.remove('accepting');
    if (!$('#ask-input').value) draft(text);
  }

  $('#rail-toggle').addEventListener('click', () => setRailOpen(!state.railOpen));
  $('#rail-collapse').addEventListener('click', () => setRailOpen(!state.railOpen));
  $('#rail-scrim').addEventListener('click', () => setRailOpen(false));

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' && state.railOpen && isPhoneRail()) {
      setRailOpen(false);
      return;
    }
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
    if (typing) return;
    if (event.key.toLowerCase() === 'd') setRailOpen(!state.railOpen);
  });

  // A cross-document view transition into the desk that the browser aborts
  // rejects a promise of its own; that is the browser's business, never the
  // reader's. Everything else still reaches the toast.
  function isViewTransitionAbort(reason) {
    return reason instanceof DOMException
      && (reason.name === 'InvalidStateError' || reason.name === 'AbortError')
      && /Transition/.test(String(reason.message || ''));
  }

  window.addEventListener('unhandledrejection', (event) => {
    if (isViewTransitionAbort(event.reason)) return;
    showToast(event.reason?.message || 'An unexpected request failed.');
  });

  // WebMCP mirror: webmcp.js replays a visitor agent's tool call as the same
  // SSE-shaped events a chat turn emits, so it lands as inspectable cards.
  document.addEventListener('desk:agent-tool', async (event) => {
    const { label, events } = event.detail || {};
    if (!Array.isArray(events) || !events.length) return;
    await leaveWelcome();
    userTurn(label || 'Agent tool call');
    const context = { failed: false, done: false, trace: createTrace() };
    events.forEach((item) => handleSseEvent(item.eventName, item.payload, context));
    settleTrace(
      context.trace,
      context.failed ? 'Agent call failed' : 'Agent call complete',
      { failed: context.failed },
    );
    setBusy(false);
  });

  initScrollFollow();
  initRailMotion();
  setRailOpen(state.railOpen);
  renderTeachChips();
  loadCatalog(state.modelId);
  // Transitions switch on only after the first paint, so the page arrives
  // in its resting state (the phone rail never slides shut on load).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.add('ready');
  }));
}());
