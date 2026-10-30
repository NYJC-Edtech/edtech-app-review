/* spa-code-review v0.6.0 — cr.js
 *
 * Design: annotations live on SCREENSHOTS of the app, not on the live
 * DOM. The wrapper renders the app in an iframe (nothing injected into it),
 * a passive capture (Ctrl+Shift+F / camera button) serializes the iframe's
 * current DOM — open modals, toggled classes and all — strips scripts, and
 * stores the markup inside the annotation block. Review tabs show
 * each capture with the drawing tools on top; annotations are pure image
 * coordinates, so transient UI state can never "lose" them.
 *
 * Annotation block format inside the app file (unchanged markers):
 *   <script type="application/json" id="cr-annotations"><!--cr+
 *   { ...pure JSON, pretty-printed... }
 *   +cr--></script>
 *
 * This file now runs in ONE context only: the wrapper (index.html).
 */

'use strict';

var CR_BLOCK_OPEN = '<script type="application/json" id="cr-annotations"><!--cr+\n';
var CR_BLOCK_CLOSE = '\n+cr--><\/script>';
var CR_BLOCK_RE = /<script type="application\/json" id="cr-annotations"><!--cr\+[\s\S]*?\+cr--><\/script>/;
// global variant: a file can end up with stacked blocks if it was ever saved
// by a stale wrapper instance — always rewrite to exactly one canonical block
var CR_BLOCK_RE_G = /<script type="application\/json" id="cr-annotations"><!--cr\+[\s\S]*?\+cr--><\/script>\n?/g;
var CR_SCHEMA = 2;
var CR_DEFAULT_COLOR = '#dc2626';

// 16-color annotation palette (Tailwind-600 family: high contrast on light
// app UIs, mutually distinguishable hues). JSON may carry any hex; this is
// what the picker offers.
var CR_PALETTE = [
  ['#dc2626', 'red'], ['#ea580c', 'orange'], ['#d97706', 'amber'], ['#ca8a04', 'yellow'],
  ['#65a30d', 'lime'], ['#16a34a', 'green'], ['#059669', 'emerald'], ['#0d9488', 'teal'],
  ['#0891b2', 'cyan'], ['#2563eb', 'blue'], ['#4f46e5', 'indigo'], ['#7c3aed', 'violet'],
  ['#c026d3', 'fuchsia'], ['#db2777', 'pink'], ['#92400e', 'brown'], ['#1e293b', 'slate']
];

// Severity classification: the four fixed levels dictate the annotation
// colour (their palette hex); "other" frees the full 16-colour palette.
// Legacy annotations without a severity field derive one from their colour.
var CR_SEVERITIES = [
  ['green',  '#16a34a', 'enhancement, no impact if not addressed'],
  ['yellow', '#ca8a04', 'minor nitpicks/annoyances, leads to more coherent and consistent experience if addressed'],
  ['orange', '#ea580c', 'potential sources of confusion that can hamper student learning'],
  ['red',    '#dc2626', 'severe bugs']
];

function crSeverityHex(name) {
  for (var i = 0; i < CR_SEVERITIES.length; i++) if (CR_SEVERITIES[i][0] === name) return CR_SEVERITIES[i][1];
  return null;
}

function crSeverityFor(color) {
  for (var i = 0; i < CR_SEVERITIES.length; i++) if (CR_SEVERITIES[i][1] === color) return CR_SEVERITIES[i][0];
  return 'other';
}

// stored severity wins ('other' included — a palette hex picked under
// "others" must not re-derive to a fixed level); fall back to colour
// (covers pre-severity annotations)
function crSeverityOf(a) {
  return a.severity === 'other' || crSeverityHex(a.severity)
    ? a.severity
    : crSeverityFor(a.color || CR_DEFAULT_COLOR);
}

function crParseBlock(text) {
  var m = text.match(CR_BLOCK_RE);
  if (!m) return null;
  var json = m[0]
    .replace(/^<script[^>]*><!--cr\+/, '')
    .replace(/\+cr--><\/script>$/, '');
  var out;
  try { out = JSON.parse(json); }
  catch (e) { out = null; }
  if (!out || typeof out !== 'object') return { json: null, raw: m[0], stripped: text.replace(m[0], '') };
  // strip the block plus the newline the writer inserted after it, so
  // splice→strip is byte-exact and the recorded app hash stays meaningful
  var withNl = m[0] + '\n';
  var stripped = text.indexOf(withNl) >= 0 ? text.replace(withNl, '') : text.replace(m[0], '');
  return { json: out, raw: m[0], stripped: stripped };
}

async function crSha256(s) {
  if (!window.crypto || !crypto.subtle) return null;
  var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
}

/* tiny IndexedDB kv (persists the FileSystemFileHandle across sessions) */
function crIdb() {
  return new Promise(function (res, rej) {
    var rq = indexedDB.open('spa-code-review', 1);
    rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
}
async function crIdbGet(key) {
  var db = await crIdb();
  return new Promise(function (res, rej) {
    var t = db.transaction('kv').objectStore('kv').get(key);
    t.onsuccess = function () { res(t.result); };
    t.onerror = function () { rej(t.error); };
  });
}
async function crIdbSet(key, val) {
  var db = await crIdb();
  return new Promise(function (res, rej) {
    var t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    t.onsuccess = function () { res(); };
    t.onerror = function () { rej(t.error); };
  });
}

/* =============================================================== REVIEW
 * Drawing engine over a frozen capture. A capture is a serialized snapshot
 * of the app DOM (scripts stripped), re-rendered in a sandboxed script-free
 * iframe at its natural viewport size; annotations are image-pixel
 * coordinates on top, and the whole canvas scales with a CSS transform.
 */

var Review = {

  init: function (frameEl, scaleEl, svgEl, canvasEl, onChange) {
    var r = this;
    r.frame = frameEl; r.scaleEl = scaleEl; r.svg = svgEl; r.canvas = canvasEl;
    r.onChange = onChange || function () {};
    r.S = {
      capture: null,           // active capture object (null = live tab)
      tool: 'select',
      selected: null,
      draw: null, drag: null,
      meta: { author: '?', color: CR_DEFAULT_COLOR },
      bbox: {},
      scale: 1
    };
    r.bind();
  },

  show: function (capture) {
    var r = this;
    r.S.capture = capture;
    r.S.selected = null; r.S.draw = null; r.S.drag = null;
    r.svg.textContent = '';
    if (!capture) { r.frame.srcdoc = ''; return; }
    r.frame.srcdoc = capture.dom;
    var natW = capture.viewport.w, natH = capture.viewport.h;
    r.frame.style.width = natW + 'px';
    r.frame.style.height = natH + 'px';
    r.scaleEl.style.width = natW + 'px';
    r.scaleEl.style.height = natH + 'px';
    r.svg.setAttribute('viewBox', '0 0 ' + natW + ' ' + natH);
    r.fitWidth();
  },

  fitWidth: function () {
    var r = this;
    if (!r.S.capture) return;
    var natW = r.S.capture.viewport.w, natH = r.S.capture.viewport.h;
    var avail = r.canvas.parentElement.clientWidth - 24;
    var dispW = Math.min(natW, Math.max(200, avail));
    this.setScale(dispW / natW, dispW, Math.round(natH * dispW / natW));
  },

  naturalSize: function () {
    var r = this;
    if (!r.S.capture) return;
    this.setScale(1, r.S.capture.viewport.w, r.S.capture.viewport.h);
  },

  setScale: function (scale, dispW, dispH) {
    var r = this;
    r.S.scale = scale;
    r.canvas.style.width = dispW + 'px';
    r.canvas.style.height = dispH + 'px';
    r.scaleEl.style.transform = 'scale(' + scale + ')';
    r.svg.setAttribute('width', dispW);
    r.svg.setAttribute('height', dispH);
    r.render();
  },

  toImg: function (e) {
    var rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / this.S.scale,
      y: (e.clientY - rect.top) / this.S.scale
    };
  },

  bind: function () {
    var r = this;
    r.svg.addEventListener('pointerdown', function (e) { r.onDown(e); });
    window.addEventListener('pointermove', function (e) { r.onMove(e); });
    window.addEventListener('pointerup', function (e) { r.onUp(e); });
    window.addEventListener('keydown', function (e) {
      if (!r.S.capture) return;
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
      if (e.key === 'Escape') {
        if (r.S.draw) { r.S.draw = null; r.render(); }
        else if (r.S.selected) { r.S.selected = null; r.render(); r.onChange('select'); }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && r.S.selected) {
        e.preventDefault();
        r.deleteAnnotation(r.S.selected);
      }
    });
  },

  setTool: function (tool, meta) {
    this.S.tool = tool;
    if (meta) this.S.meta = Object.assign(this.S.meta, meta);
    this.svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    this.render();
  },

  anns: function () { return this.S.capture ? this.S.capture.annotations : []; },

  byId: function (id) {
    var l = this.anns();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  },

  deleteAnnotation: function (id) {
    var c = this.S.capture;
    if (!c) return;
    c.annotations = c.annotations.filter(function (a) { return a.id !== id; });
    if (this.S.selected === id) this.S.selected = null;
    this.render();
    this.onChange('data');
  },

  patch: function (id, p) {
    var a = this.byId(id);
    if (!a) return;
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) a[k] = p[k];
    this.render();
    this.onChange('data');
  },

  select: function (id) {
    this.S.selected = id;
    this.render();
    this.ensureVisible(id);
    this.onChange('select');
  },

  // scroll the review canvas so the selected annotation is in view
  ensureVisible: function (id) {
    var r = this, S = r.S;
    if (!S.capture || !id) return;
    var b = S.bbox[id];
    if (!b) return;
    var cb = r.canvas.getBoundingClientRect();
    var viewEl = r.canvas.closest('#review-view');
    if (!viewEl) return;
    var vb = viewEl.getBoundingClientRect();
    var top = cb.top + b.y * S.scale, left = cb.left + b.x * S.scale;
    var bot = top + b.h * S.scale, right = left + b.w * S.scale;
    if (top < vb.top || bot > vb.bottom || left < vb.left || right > vb.right) {
      viewEl.scrollBy({
        top: (top + bot) / 2 - (vb.top + vb.bottom) / 2,
        left: (left + right) / 2 - (vb.left + vb.right) / 2,
        behavior: 'smooth'
      });
    }
  },

  onDown: function (e) {
    var r = this, S = r.S;
    if (!S.capture) return;
    var p = r.toImg(e);
    if (S.tool === 'select') { r.selectDown(p); return; }
    S.draw = { kind: S.tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    r.render();
  },

  selectDown: function (p) {
    var r = this, S = r.S;
    if (S.selected) {
      var hs = r.handlesFor(r.byId(S.selected));
      for (var i = 0; i < hs.length; i++) {
        if (Math.abs(p.x - hs[i].x) <= 9 / S.scale && Math.abs(p.y - hs[i].y) <= 9 / S.scale) {
          S.drag = { type: 'handle', which: hs[i].which, id: S.selected };
          return;
        }
      }
    }
    var anns = r.anns();
    for (var j = anns.length - 1; j >= 0; j--) {
      var b = S.bbox[anns[j].id];
      if (!b) continue;
      var pad = 7 / S.scale;
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        S.selected = anns[j].id;
        S.drag = { type: 'move', id: anns[j].id, dx: p.x - b.x, dy: p.y - b.y };
        r.render();
        r.onChange('select');
        return;
      }
    }
    if (S.selected) { S.selected = null; r.render(); r.onChange('select'); }
  },

  onMove: function (e) {
    var r = this, S = r.S;
    if (!S.capture) return;
    var p = r.toImg(e);
    if (S.draw) {
      S.draw.x1 = p.x; S.draw.y1 = p.y;
      r.render();
      return;
    }
    if (!S.drag) return;
    var a = r.byId(S.drag.id);
    if (!a) { S.drag = null; return; }
    if (S.drag.type === 'move') {
      var nx = p.x - S.drag.dx, ny = p.y - S.drag.dy;
      if (a.kind === 'line' || a.kind === 'arrow') {
        var ox = a.x, oy = a.y;
        a.x = nx; a.y = ny;
        a.x2 += nx - ox; a.y2 += ny - oy;
      } else { a.x = nx; a.y = ny; }
    } else if (S.drag.type === 'handle') {
      if (S.drag.which === 'end' && (a.kind === 'line' || a.kind === 'arrow')) { a.x2 = p.x; a.y2 = p.y; }
      else if (S.drag.which === 'start' && (a.kind === 'line' || a.kind === 'arrow')) { a.x = p.x; a.y = p.y; }
      else if (S.drag.which === 'corner') { a.w = Math.max(6, p.x - a.x); a.h = Math.max(6, p.y - a.y); }
    }
    r.render();
  },

  onUp: function () {
    var r = this, S = r.S;
    if (S.drag) { S.drag = null; r.onChange('data'); return; }
    if (!S.draw) return;
    var d = S.draw; S.draw = null;

    if (d.kind === 'text') { r.create('text', d.x0, d.y0, d.x0, d.y0); return; }
    if (d.kind === 'line' || d.kind === 'arrow') {
      if (Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) < 6) { r.render(); return; }
      r.create(d.kind, d.x0, d.y0, d.x1, d.y1);
      return;
    }
    var x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    var w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w < 5 && h < 5) { r.render(); return; }
    r.create(d.kind, x, y, x + w, y + h);
  },

  create: function (kind, x, y, x2, y2) {
    var r = this, S = r.S, c = S.capture;
    if (!c) return;
    var a = {
      id: 'a' + (Host.data.seq++),
      kind: kind,
      x: Math.round(x), y: Math.round(y),
      w: null, h: null, x2: null, y2: null,
      color: S.meta.color,
      severity: crSeverityFor(S.meta.color),
      note: '',
      author: S.meta.author || '?',
      ts: new Date().toISOString(),
      status: 'open'
    };
    if (kind === 'line' || kind === 'arrow') { a.x2 = Math.round(x2); a.y2 = Math.round(y2); }
    else if (kind === 'rect' || kind === 'ellipse') { a.w = Math.round(x2 - x); a.h = Math.round(y2 - y); }
    c.annotations.push(a);
    S.selected = a.id;
    r.render();
    r.onChange('data');
  },

  handlesFor: function (a) {
    if (!a) return [];
    if (a.kind === 'line' || a.kind === 'arrow') return [{ which: 'start', x: a.x, y: a.y }, { which: 'end', x: a.x2, y: a.y2 }];
    if ((a.kind === 'rect' || a.kind === 'ellipse') && a.w != null) return [{ which: 'corner', x: a.x + a.w, y: a.y + a.h }];
    return [];
  },

  strokeColor: function (a) {
    if (a.status === 'resolved') return '#16a34a';
    if (a.status === 'wontfix') return '#64748b';
    return a.color || '#dc2626';
  },

  render: function () {
    var r = this, S = r.S, NS = 'http://www.w3.org/2000/svg';
    var svg = r.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    S.bbox = {};
    if (!S.capture) return;

    var sw = 2.5; // stroke width in image px
    var anns = r.anns();
    for (var i = 0; i < anns.length; i++) {
      var a = anns[i];
      var color = r.strokeColor(a);
      var dash = a.status === 'resolved' ? '4 3' : (a.status === 'wontfix' ? '6 4' : null);
      var fillOp = a.status === 'open' ? 0.08 : 0.04;

      if (a.kind === 'text') r.drawText(svg, NS, a, color);
      else r.drawShape(svg, NS, a, color, dash, fillOp, sw);
      r.drawBadge(svg, NS, a.x, a.y, a.id, color, sw);
    }

    if (S.draw && S.draw.kind !== 'text') {
      var d = S.draw;
      var prev = { kind: d.kind, x: d.x0, y: d.y0, status: 'open', color: S.meta.color };
      if (d.kind === 'line' || d.kind === 'arrow') { prev.x2 = d.x1; prev.y2 = d.y1; }
      else { prev.x = Math.min(d.x0, d.x1); prev.y = Math.min(d.y0, d.y1); prev.w = Math.abs(d.x1 - d.x0); prev.h = Math.abs(d.y1 - d.y0); }
      if ((d.kind === 'line' || d.kind === 'arrow') || (prev.w > 3 && prev.h > 3)) {
        r.drawShape(svg, NS, prev, S.meta.color, '3 3', 0.05, sw);
      }
    }

    if (S.selected) {
      var sa = r.byId(S.selected);
      var hs = r.handlesFor(sa);
      var b = S.bbox[S.selected];
      if (b) {
        var halo = document.createElementNS(NS, 'rect');
        halo.setAttribute('x', b.x - 12); halo.setAttribute('y', b.y - 12);
        halo.setAttribute('width', b.w + 24); halo.setAttribute('height', b.h + 24);
        halo.setAttribute('rx', 10);
        halo.setAttribute('fill', '#2563eb');
        halo.setAttribute('class', 'cr-halo');
        svg.insertBefore(halo, svg.firstChild);
        var so = document.createElementNS(NS, 'rect');
        so.setAttribute('x', b.x - 4); so.setAttribute('y', b.y - 4);
        so.setAttribute('width', b.w + 8); so.setAttribute('height', b.h + 8);
        so.setAttribute('fill', 'none'); so.setAttribute('stroke', '#2563eb');
        so.setAttribute('stroke-width', 1.5); so.setAttribute('stroke-dasharray', '4 3');
        so.setAttribute('class', 'cr-selring');
        svg.appendChild(so);
      }
      var hsSize = 10;
      for (var k = 0; k < hs.length; k++) {
        var hr = document.createElementNS(NS, 'rect');
        hr.setAttribute('x', hs[k].x - hsSize / 2); hr.setAttribute('y', hs[k].y - hsSize / 2);
        hr.setAttribute('width', hsSize); hr.setAttribute('height', hsSize);
        hr.setAttribute('fill', '#fff'); hr.setAttribute('stroke', '#2563eb');
        hr.setAttribute('stroke-width', 1.5);
        svg.appendChild(hr);
      }
    }
  },

  drawShape: function (svg, NS, a, color, dash, fillOp, sw) {
    var el;
    if (a.kind === 'ellipse' && a.w != null) {
      el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', a.x + a.w / 2); el.setAttribute('cy', a.y + a.h / 2);
      el.setAttribute('rx', a.w / 2); el.setAttribute('ry', a.h / 2);
      this.S.bbox[a.id] = { x: a.x, y: a.y, w: a.w, h: a.h };
    } else if ((a.kind === 'line' || a.kind === 'arrow') && a.x2 != null) {
      el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', a.x); el.setAttribute('y1', a.y);
      el.setAttribute('x2', a.x2); el.setAttribute('y2', a.y2);
      el.setAttribute('stroke-linecap', 'round');
      var bx = Math.min(a.x, a.x2), by = Math.min(a.y, a.y2);
      if (a.id) this.S.bbox[a.id] = { x: bx, y: by, w: Math.abs(a.x2 - a.x), h: Math.abs(a.y2 - a.y) };
    } else {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', a.x); el.setAttribute('y', a.y);
      el.setAttribute('width', a.w || 40); el.setAttribute('height', a.h || 24);
      el.setAttribute('rx', 3);
      if (a.id) this.S.bbox[a.id] = { x: a.x, y: a.y, w: a.w || 40, h: a.h || 24 };
    }
    el.setAttribute('fill', color); el.setAttribute('fill-opacity', fillOp);
    el.setAttribute('stroke', color); el.setAttribute('stroke-width', sw);
    if (dash) el.setAttribute('stroke-dasharray', dash);
    svg.appendChild(el);

    if (a.kind === 'arrow' && a.x2 != null) {
      var ang = Math.atan2(a.y2 - a.y, a.x2 - a.x), L = 13, W = 5.5;
      var head = document.createElementNS(NS, 'polygon');
      var pts = [
        [a.x2, a.y2],
        [a.x2 - L * Math.cos(ang) - W * Math.sin(ang), a.y2 - L * Math.sin(ang) + W * Math.cos(ang)],
        [a.x2 - L * Math.cos(ang) + W * Math.sin(ang), a.y2 - L * Math.sin(ang) - W * Math.cos(ang)]
      ].map(function (pt) { return pt[0].toFixed(1) + ',' + pt[1].toFixed(1); }).join(' ');
      head.setAttribute('points', pts);
      head.setAttribute('fill', color);
      svg.appendChild(head);
    }
  },

  drawText: function (svg, NS, a, color) {
    var fo = document.createElementNS(NS, 'foreignObject');
    fo.setAttribute('x', a.x); fo.setAttribute('y', a.y);
    fo.setAttribute('width', '260');   // give the div room to lay out before measuring
    var div = document.createElement('div');
    div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    div.style.cssText = 'max-width:240px;padding:7px 10px;border-radius:8px;' +
      'background:rgba(255,255,255,0.94);border:2px solid ' + color + ';' +
      'font:12px/1.45 system-ui,sans-serif;color:#1e293b;white-space:pre-wrap;word-break:break-word;';
    if (a.note) div.textContent = a.note;
    else { div.textContent = '(no note)'; div.style.color = '#94a3b8'; div.style.fontStyle = 'italic'; }
    fo.appendChild(div);
    svg.appendChild(fo);
    var w = Math.ceil(div.getBoundingClientRect().width / this.S.scale) + 4;
    var h = Math.ceil(div.getBoundingClientRect().height / this.S.scale) + 4;
    fo.setAttribute('width', w); fo.setAttribute('height', h);
    if (a.w == null || a.h == null) { a.w = w; a.h = h; }
    this.S.bbox[a.id] = { x: a.x, y: a.y, w: w, h: h };
  },

  drawBadge: function (svg, NS, x, y, id, color, sw) {
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x - 2); c.setAttribute('cy', y - 2);
    c.setAttribute('r', 12); c.setAttribute('fill', color);
    c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', 2);
    svg.appendChild(c);
    var t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x - 2); t.setAttribute('y', y + 2.5);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'ui-monospace,Consolas,monospace');
    t.setAttribute('font-size', 11); t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#fff');
    t.textContent = id;
    svg.appendChild(t);
  }
};

/* ================================================================= HOST */

var Host = {

  boot: function () {
    var h = this;
    h.data = null; h.handle = null;
    h.rawApp = null; h.baseHash = null; h.appName = '(none)';
    h.tab = 'live'; h.activeTool = 'select';
    h._shownTab = null;
    h._dirty = false; h._lastSavedAt = null; h._saving = false;
    h._changeCount = 0;
    h._handleSha = null; h._handleNeedsPerm = false;

    var $ = function (id) { return document.getElementById(id); };
    h.el = {
      open: $('btn-open'), save: $('btn-save'), copy: $('btn-copy'), reload: $('btn-reload'),
      capture: $('btn-capture'), clearBtn: $('btn-clear'), exportBtn: $('btn-export'),
      fileChip: $('file-chip'), hashChip: $('hash-chip'), countChip: $('count-chip'),
      author: $('author-input'),
      frame: $('app-frame'), stage: $('stage'), hint: $('drop-hint'),
      caps: $('caps'), capsList: $('caps-list'),
      liveView: $('live-view'), reviewView: $('review-view'),
      reviewFrame: $('review-frame'), reviewScale: $('review-scale'),
      reviewSvg: $('review-svg'), reviewCanvas: $('review-canvas'),
      toolbarLive: $('toolbar-live'), toolbarReview: $('toolbar-review'),
      fitBtn: $('btn-fit'), naturalBtn: $('btn-natural'),
      panel: $('panel'), list: $('panel-list'), editor: $('panel-editor'),
      captureLabel: $('capture-label'),
      toast: $('toast')
    };

    Review.init(h.el.reviewFrame, h.el.reviewScale, h.el.reviewSvg, h.el.reviewCanvas,
      function (reason) {
        if (reason !== 'select') h.markDirty();
        h.refreshUI();
      });

    // keyboard navigation: Up/Down inside a focused column walks its list
    // keyboard navigation: Up/Down walks the list of the last-focused column.
    // Delegated at document level because every selection change REBUILDS the
    // lists, destroying the focused item (container-level listeners miss the
    // next keypress).
    document.addEventListener('mousedown', function (e) {
      var t = e.target;
      h._focusCol = t.closest && t.closest('#caps-list') ? 'caps'
        : (t.closest && t.closest('#panel-list')) ? 'panel' : null;
    }, true);
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (!t.closest) return;
      if (t.closest('#caps-list')) h._focusCol = 'caps';
      else if (t.closest('#panel-list')) h._focusCol = 'panel';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
      var col = null;
      if (ae && ae.closest) {
        if (ae.closest('#caps-list')) col = 'caps';
        else if (ae.closest('#panel-list')) col = 'panel';
      }
      if (!col) col = h._focusCol;
      if (!col) return;
      e.preventDefault();
      if (col === 'caps') h.capsKeyNav(e); else h.panelKeyNav(e);
    });

    h.el.open.addEventListener('click', function () { h.pick(); });
    h.el.save.addEventListener('click', function () { h.save(); });
    h.el.copy.addEventListener('click', function () { h.copyJSON(); });
    h.el.reload.addEventListener('click', function () { h.reload(); });
    h.el.capture.addEventListener('click', function () { h.capture(); });
    h.el.clearBtn.addEventListener('click', function () { h.clearAll(); });
    h.el.exportBtn.addEventListener('click', function () { h.exportReview(); });

    h.el.author.value = localStorage.getItem('cr-author') || '';
    Review.S.meta.author = h.el.author.value.trim() || 'anonymous';
    h.el.author.addEventListener('change', function () {
      localStorage.setItem('cr-author', h.el.author.value.trim());
      Review.S.meta.author = h.el.author.value.trim() || 'anonymous';
    });

    var tbtns = h.el.toolbarReview.querySelectorAll('[data-tool]');
    Array.prototype.forEach.call(tbtns, function (b) {
      b.addEventListener('click', function () {
        h.activeTool = b.getAttribute('data-tool');
        Review.setTool(h.activeTool, {
          author: h.el.author.value.trim() || 'anonymous',
          color: (Review.byId(Review.S.selected) || {}).color || Review.S.meta.color || CR_DEFAULT_COLOR
        });
        Array.prototype.forEach.call(tbtns, function (x) { x.classList.toggle('active', x === b); });
      });
    });

    h.el.fitBtn.addEventListener('click', function () { Review.fitWidth(); });
    h.el.naturalBtn.addEventListener('click', function () { Review.naturalSize(); });

    h.el.captureLabel.addEventListener('change', function () {
      var c = h.captureById(h.tab);
      if (c) { c.label = h.el.captureLabel.value; h.markDirty(); h.refreshUI(); }
    });

    // capture hotkey works in the wrapper AND while the app iframe has focus;
    // the iframe-side listener is capture-phase + stopPropagation so the app
    // never sees the key. Ctrl+Shift+S is Edge Web Capture, Ctrl+Shift+X is a
    // common password-manager autofill binding.
    var hotkey = function (e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.code === 'KeyF')) {
        e.preventDefault(); e.stopPropagation();
        h.capture();
      }
    };
    window.addEventListener('keydown', hotkey, true);
    h.el.frame.addEventListener('load', function () {
      try { h.el.frame.contentDocument.addEventListener('keydown', hotkey, true); }
      catch (err) { /* cross-origin: hotkey only from wrapper */ }
    });

    var stage = h.el.stage;
    stage.addEventListener('dragover', function (e) { e.preventDefault(); stage.classList.add('drag'); });
    stage.addEventListener('dragleave', function () { stage.classList.remove('drag'); });
    stage.addEventListener('drop', function (e) {
      e.preventDefault(); stage.classList.remove('drag');
      var item = e.dataTransfer.items && e.dataTransfer.items[0];
      if (item && item.getAsFileSystemHandle) {
        item.getAsFileSystemHandle().then(function (hd) { h.openHandle(hd); }, function () { h.dropFileFallback(e); });
      } else h.dropFileFallback(e);
    });

    var app = new URLSearchParams(location.search).get('app');
    if (app) h.fetchApp(app);
    else h.showHint('Drop the app\u2019s .html file here, or click Open.');

    // restore a previously granted file handle so saving keeps working
    // across sessions (file:// included)
    if (window.showOpenFilePicker) {
      crIdbGet('fs-handle').then(async function (rec) {
        if (!rec || !rec.handle || h.handle) return;
        h.handle = rec.handle;
        h._handleSha = rec.sha;
        try {
          var st = await rec.handle.queryPermission({ mode: 'readwrite' });
          h._handleNeedsPerm = st !== 'granted';
        } catch (e) { h._handleNeedsPerm = true; }
        h.toast('Re-attached to ' + (rec.name || 'your app file') +
          (h._handleNeedsPerm ? ' \u2014 allow access when saving' : ' for direct saving'));
      }).catch(function () { });
    }

    window.CR = h; // debug / agent hook
    h.updateSaveState(); // dim file-dependent buttons before anything is open
  },

  /* ---- opening apps ---- */

  showHint: function (msg) {
    this.el.hint.hidden = false;
    this.el.hint.textContent = msg || 'Drop the app\u2019s .html file here, or click Open.';
  },

  pick: async function () {
    if (!window.showOpenFilePicker) {
      this.toast('File picker unavailable here \u2014 drag-drop the file, or serve over http://localhost');
      return;
    }
    try {
      var handles = await showOpenFilePicker({
        types: [{ description: 'HTML app', accept: { 'text/html': ['.html', '.htm'] } }]
      });
      await this.openHandle(handles[0]);
    } catch (e) {
      if (e && e.name !== 'AbortError') this.toast('Open failed: ' + e);
    }
  },

  dropFileFallback: function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    var h = this, rd = new FileReader();
    rd.onload = function () { h.handle = null; h.loadText(rd.result, f.name); };
    rd.readAsText(f);
  },

  openHandle: async function (hd) {
    if (!hd || hd.kind !== 'file') { this.toast('Not a file handle'); return; }
    var h = this;
    try {
      var file = await hd.getFile();
      var text = await file.text();
      h.handle = hd;
      // fresh pick: not verified yet — clear the previous file's sha so
      // loadText's stale-connection guard can't detach this handle
      h._handleSha = null;
      await h.loadText(text, file.name);
      await h.bindHandle();
    } catch (e) {
      h.toast('Could not read file: ' + e);
    }
  },

  // bind the picked handle to the loaded file (sha identity) and persist it
  bindHandle: async function () {
    var h = this;
    if (!h.handle || h.baseHash == null) return;
    h._handleSha = h.baseHash;
    h._handleNeedsPerm = false;
    try {
      var st = await h.handle.queryPermission({ mode: 'readwrite' });
      h._handleNeedsPerm = st !== 'granted';
    } catch (e) { h._handleNeedsPerm = true; }
    try { await crIdbSet('fs-handle', { handle: h.handle, sha: h._handleSha, name: h.appName }); } catch (e) { }
  },

  fetchApp: async function (app) {
    var h = this;
    // resolve ?app= against this file's URL: absolute and root-relative paths
    // keep their meaning, bare paths are relative to index.html — which also
    // works on GitHub Pages project sites, where the site root is /<repo>/
    var url = app;
    try { url = new URL(app, location.href).href; } catch (e) { }
    try {
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var text = await r.text();
      h.handle = null;
      h.loadText(text, url.split('/').pop().split('?')[0]);
    } catch (e) {
      h.showHint('Could not fetch ?app=' + app + ' (' + e + '). Serve this folder over http, or open a file directly.');
    }
  },

  loadText: async function (text, name) {
    var h = this;
    h.rawApp = text;
    h.appName = name || 'app.html';
    var pb = crParseBlock(text);
    if (pb && pb.json === null) {
      h.toast('Annotation block has a JSON error \u2014 starting empty (original block kept in file)');
      pb = null;
    }
    if (pb && pb.json.schema !== CR_SCHEMA) {
      h.toast('Block schema ' + pb.json.schema + ' \u2260 ' + CR_SCHEMA + ' (v0.1 live-anchored format) \u2014 starting empty; extract the old block manually if needed');
      pb = null;
    }
    h.data = pb ? pb.json : {
      schema: CR_SCHEMA, tool: 'spa-code-review 0.6.0', seq: 1,
      app: null, captures: []
    };
    if (!Array.isArray(h.data.captures)) h.data.captures = [];
    if (typeof h.data.seq !== 'number') h.data.seq = 1;

    // localStorage stash: keyed per app filename (all file:// pages share one
    // storage origin, so the filename is the only per-file identity we have).
    // The stash is the *unsaved working set*; a successful Save removes it, so
    // the block in the app file is always the record of truth on next open.
    var stash = h.readStash();
    h._stashSuppressed = false;
    h._dirty = false;   // fresh file state; the stash-win branch sets this back
    h._changeCount = 0;
    if (stash) {
      var fileSeq = pb && pb.json && typeof pb.json.seq === 'number' ? pb.json.seq : -1;
      var stashSeq = stash.data && typeof stash.data.seq === 'number' ? stash.data.seq : -1;
      var wins = stashSeq > fileSeq;
      if (stashSeq === fileSeq && stashSeq >= 0) {
        // same seq: stash wins only if annotations actually differ (unsaved edits)
        var fa = JSON.stringify((pb.json.captures || []).map(function (c) { return c.annotations; }));
        var sa = JSON.stringify(((stash.data && stash.data.captures) || []).map(function (c) { return c.annotations; }));
        wins = fa !== sa;
      }
      if (!wins) {
        // stash is older than (or identical to) the file — file wins
        try { localStorage.removeItem(h.stashKey()); } catch (e) { }
        h._stashSuppressed = true;
        if (stashSeq >= 0) h.toast('Local stash was not newer than the file\u2019s annotations \u2014 using the file');
      } else {
        h.data = stash.data;
        if (!Array.isArray(h.data.captures)) h.data.captures = [];
        h._dirty = true;   // stash holds unsaved work, differs from the file
        h.toast('Restored unsaved annotations for ' + h.appName + ' from local stash (' +
          stash.data.captures.length + ' captures)');
      }
    }
    h._dirty = h._dirty === true;
    h._lastSavedAt = (h.data && h.data.savedTs) || null;

    var stripped = pb ? pb.stripped : text;
    h.baseHash = await crSha256(stripped);
    // a restored file connection only survives if it still points at this
    // exact file version; otherwise drop it so Save can't write elsewhere
    if (h.handle && h._handleSha != null && h._handleSha !== h.baseHash) {
      h.handle = null;
      h._handleSha = null;
      try { await crIdbSet('fs-handle', null); } catch (e) { }
      h.toast('The saved file connection no longer matches this file \u2014 use Open app HTML\u2026 to re-attach for direct saving', 6000);
    }
    h.updateHashChip();
    h.el.hint.hidden = true;
    h.el.panel.hidden = false;
    h.el.caps.hidden = false;
    h.el.fileChip.textContent = h.appName;
    h.tab = 'live';
    h._shownTab = null;
    Review.show(null);
    // srcdoc = the app file, untouched (annotation block stays inert inside)
    h.el.frame.srcdoc = text;
    h.refreshUI();
  },

  /* ---- save state (dirty flag / last saved / spinner) ---- */

  markDirty: function () {
    this._dirty = true;
    this._changeCount++;
    this._stashSuppressed = false; // work diverged from the file again
    this.updateSaveState();
  },

  updateSaveState: function () {
    var h = this;
    // buttons that need a loaded file are dimmed while none is open
    var noFile = !h.data;
    ['reload', 'clearBtn', 'copy', 'exportBtn', 'capture'].forEach(function (id) {
      if (h.el[id]) h.el[id].disabled = noFile;
    });
    h.el.save.disabled = noFile || h._saving || !h._dirty;
    if (h._saving) {
      h.el.save.textContent = 'Saving\u2026';
    } else if (h._dirty) {
      h.el.save.textContent = h._changeCount > 0
        ? 'Save ' + h._changeCount + (h._changeCount === 1 ? ' change' : ' changes')
        : 'Save changes';
    } else if (h._lastSavedAt) {
      var d = new Date(h._lastSavedAt);
      var t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      h.el.save.textContent = d.toDateString() === new Date().toDateString()
        ? 'Saved ' + t
        : 'Saved ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + t;
    } else {
      h.el.save.textContent = 'Save annotations';
    }
  },

  updateHashChip: function () {
    var h = this, chip = h.el.hashChip;
    chip.classList.remove('ok', 'warn');
    if (!h.data || !h.data.app || !h.data.app.sha256) { chip.textContent = 'no baseline hash'; return; }
    if (!h.baseHash) { chip.textContent = 'hash n/a (insecure context)'; return; }
    if (h.data.app.sha256 === h.baseHash) { chip.textContent = 'hash \u2713 matches annotated build'; chip.classList.add('ok'); }
    else { chip.textContent = '\u26a0 app changed since last annotation save'; chip.classList.add('warn'); }
  },

  /* ---- local stash (per-filename working set in localStorage) ---- */

  stashKey: function () { return 'cr-stash:' + (this.appName || 'app'); },

  writeStash: function () {
    var h = this;
    if (!h.data || !h.appName || h.appName === '(none)') return;
    if (h._stashSuppressed) return; // saved/cleared state must not re-stash
    clearTimeout(h._stashT);
    h._stashT = setTimeout(function () {
      var key = h.stashKey();
      var prev = null;
      try { prev = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { prev = null; }
      // snapshot into history only when this write would LOSE captures or
      // annotations (deletions, clears) — growth/edits just replace current
      var pc = prev && prev.data && Array.isArray(prev.data.captures)
        ? prev.data.captures.reduce(function (n, c) { return n + 1 + c.annotations.length; }, 0) : 0;
      var nc = h.data.captures.reduce(function (n, c) { return n + 1 + c.annotations.length; }, 0);
      if (prev && prev.data && pc > nc) h.pushStashHistory(prev);
      try {
        localStorage.setItem(key, JSON.stringify({ ts: Date.now(), name: h.appName, data: h.data }));
      } catch (e) {
        try { localStorage.removeItem(key); } catch (_) {}
        h.toast('Local stash write failed (' + e + ') \u2014 use Save to file to keep work');
      }
    }, h._stashDelayMs != null ? h._stashDelayMs : 400);
  },

  pushStashHistory: function (rec) {
    if (!rec || !rec.data || !Array.isArray(rec.data.captures)) return;
    var key = 'cr-stash-hist:' + (this.appName || 'app');
    var list;
    try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push({ ts: rec.ts || Date.now(), data: rec.data });
    list = list.slice(-5);
    var s = JSON.stringify(list);
    while (true) {
      try { localStorage.setItem(key, s); return; }
      catch (e) {
        if (list.length > 1) { list = list.slice(1); s = JSON.stringify(list); }
        else { try { localStorage.removeItem(key); } catch (_) {} return; }
      }
    }
  },

  listStashHistory: function () {
    try {
      var list = JSON.parse(localStorage.getItem('cr-stash-hist:' + (this.appName || 'app')) || '[]');
      return (Array.isArray(list) ? list : []).map(function (r, i) {
        return {
          index: i,
          ts: r.ts ? new Date(r.ts).toISOString() : null,
          captures: (r.data && r.data.captures || []).length,
          annotations: (r.data && r.data.captures || []).reduce(function (n, c) { return n + c.annotations.length; }, 0)
        };
      });
    } catch (e) { return []; }
  },

  restoreStashHistory: function (i) {
    var h = this;
    try {
      var list = JSON.parse(localStorage.getItem('cr-stash-hist:' + (h.appName || 'app')) || '[]');
      if (!Array.isArray(list) || !list[i] || !list[i].data) return false;
      // the restore itself shrinks nothing if the current set is smaller —
      // but snapshot current anyway so restoring is itself undoable
      h.pushStashHistory({ ts: Date.now(), data: h.data });
      h.data = list[i].data;
      if (!Array.isArray(h.data.captures)) h.data.captures = [];
      h.tab = 'live';
      h._shownTab = null;
      h.refreshUI();
      h.toast('Restored history entry ' + i + ' (' + h.data.captures.length + ' captures) \u2014 Save to file to persist');
      return true;
    } catch (e) { return false; }
  },

  readStash: function () {
    try {
      var raw = localStorage.getItem(this.stashKey());
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || !rec.data || rec.data.schema !== CR_SCHEMA || !Array.isArray(rec.data.captures)) return null;
      return rec;
    } catch (e) { return null; }
  },

  clearAll: function () {
    var h = this;
    if (!h.data) { h.toast('Open an app first'); return; }
    var annCount = h.data.captures.reduce(function (n, c) { return n + c.annotations.length; }, 0);
    if (!h.data.captures.length) { h.toast('Nothing to clear'); return; }
    if (!confirm('Clear ' + h.data.captures.length + ' captures / ' + annCount +
      ' annotations for ' + h.appName + '?\n\nThis wipes the working set and the local stash ' +
      '(the last versions are kept in local history and can be restored). ' +
      'Save to file afterwards to strip annotations from the app file.')) return;
    try { localStorage.removeItem(h.stashKey()); } catch (e) { }
    h._stashSuppressed = true;
    h.data.captures = [];
    // seq is deliberately NOT reset — ids are never reused
    h.tab = 'live';
    h._shownTab = null;
    h.markDirty();
    h._changeCount = 0; // a clear is one action, not N lost items
    h.refreshUI();
    h.toast('Cleared \u2014 Save to file to strip the annotation block from the app file');
  },

  /* ---- capture: freeze the current app state as a script-free DOM snapshot ---- */

  capture: async function () {
    var h = this;
    if (!h.data) { h.toast('Open an app first'); return; }
    if (h.tab !== 'live') { h.toast('Switch to the Live tab to capture'); return; }
    var doc = h.el.frame.contentDocument;
    if (!doc || !doc.body) { h.toast('App not loaded yet'); return; }

    h.el.capture.disabled = true;
    try {
      var W = Math.round(h.el.frame.clientWidth);
      var H = Math.round(h.el.frame.clientHeight);
      var clone = doc.documentElement.cloneNode(true);
      h.syncFormState(doc, clone);
      var junk = clone.querySelectorAll('script, noscript');
      Array.prototype.forEach.call(junk, function (n) { n.remove(); });

      // HTML serializer (not XMLSerializer): XML-style self-closed tags
      // (<i/>) would be re-parsed as unclosed open tags and wreck the layout
      var dom = '<!DOCTYPE html>\n' + clone.outerHTML;
      // neutralize anything that could terminate the JSON block's <script>
      // element or the sed markers; rendering impact is nil outside text
      // nodes that literally contain these sequences
      var guarded = false;
      if (/<\/script/i.test(dom)) { dom = dom.replace(/<\/script/gi, '<\\/script'); guarded = true; }
      if (/<!--cr\+/.test(dom)) { dom = dom.replace(/<!--cr\+/g, '<\\!--cr+'); guarded = true; }
      if (/\+cr-->/.test(dom)) { dom = dom.replace(/\+cr-->/g, '+\\cr-->'); guarded = true; }
      var sha = await crSha256(dom);

      var id = 's' + (h.data.seq++);
      h.data.captures.push({
        id: id, ts: new Date().toISOString(), label: '',
        dom: dom, dom_sha256: sha,
        viewport: { w: W, h: H },
        annotations: []
      });
      h.openTab(id);
      h.markDirty();
      h.toast('Captured ' + id + ' \u2014 ' + Math.round(dom.length / 1024) + ' KB' +
        (guarded ? ' (rare marker sequence sanitized)' : ''));
      h.refreshUI();
    } catch (e) {
      h.toast('Capture failed: ' + e);
    } finally {
      h.el.capture.disabled = false;
    }
  },

  // Copy live form state into the clone's MARKUP. cloneNode copies only
  // attributes, so the user's current select choice / typed text / checkbox
  // toggles would otherwise re-render as the page defaults.
  syncFormState: function (doc, clone) {
    var pairs = function (sel) {
      var o = doc.querySelectorAll(sel), c = clone.querySelectorAll(sel);
      return o.length === c.length ? { o: o, c: c } : null;
    };
    var p = pairs('input');
    if (p) for (var i = 0; i < p.o.length; i++) {
      var o = p.o[i], cl = p.c[i];
      var t = (o.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') {
        if (o.checked) cl.setAttribute('checked', ''); else cl.removeAttribute('checked');
      } else if (o.value != null) {
        cl.setAttribute('value', o.value);
      }
    }
    p = pairs('textarea');
    if (p) for (var j = 0; j < p.o.length; j++) p.c[j].textContent = p.o[j].value;
    p = pairs('select');
    if (p) for (var k = 0; k < p.o.length; k++) {
      var opts = p.o[k].options, copts = p.c[k].options;
      if (opts.length !== copts.length) continue;
      for (var m = 0; m < opts.length; m++) {
        if (opts[m].selected) copts[m].setAttribute('selected', '');
        else copts[m].removeAttribute('selected');
      }
    }
    p = pairs('progress');
    if (p) for (var n = 0; n < p.o.length; n++) {
      if (p.o[n].value != null) p.c[n].setAttribute('value', p.o[n].value);
    }
  },

  /* ---- tabs / views ---- */

  captureById: function (id) {
    if (!this.data) return null;
    var hit = null;
    this.data.captures.forEach(function (c) { if (c.id === id) hit = c; });
    return hit;
  },

  openTab: function (id) {
    this.tab = id;
    this.refreshUI();
  },

  deleteCapture: function (id) {
    var h = this;
    if (!confirm('Delete capture ' + id + ' and its annotations?')) return;
    h.data.captures = h.data.captures.filter(function (c) { return c.id !== id; });
    if (h.tab === id) h.tab = 'live';
    h.markDirty();
    h.refreshUI();
  },

  refreshUI: function () {
    var h = this;
    var isLive = h.tab === 'live';
    h.el.liveView.hidden = !isLive;
    h.el.reviewView.hidden = isLive;
    h.el.toolbarLive.hidden = !isLive;
    h.el.toolbarReview.hidden = isLive;

    h.renderCapsList();

    var caps = h.data ? h.data.captures : [];
    var anns = 0, open = 0;
    caps.forEach(function (c) {
      anns += c.annotations.length;
      c.annotations.forEach(function (a) { if (a.status === 'open') open++; });
    });
    h.el.countChip.textContent = caps.length + ' captures \u00b7 ' + anns + ' annotations \u00b7 ' + open + ' open';

    var c = isLive ? null : h.captureById(h.tab);
    h.el.captureLabel.parentElement.hidden = !c;
    if (c) {
      if (document.activeElement !== h.el.captureLabel) h.el.captureLabel.value = c.label || '';
      h.el.captureLabel.placeholder = 'label for ' + c.id;
    }
    // re-mount the review canvas only when the tab actually changes;
    // Review.show() resets selection, and re-fitting would undo 1:1 zoom
    if (h._shownTab !== h.tab) {
      h._shownTab = h.tab;
      Review.show(isLive ? null : c);
    } else if (!isLive) {
      Review.render();
    }
    h.renderList(c);
    h.renderEditor(c);
    h.writeStash();
    h.updateSaveState();
  },

  /* ---- keyboard navigation: Up/Down within a focused column ---- */

  keyNav: function (e, listEl, itemSel, getStart, pick) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var items = Array.prototype.slice.call(listEl.querySelectorAll(itemSel));
    if (!items.length) return;
    var idx = items.indexOf(document.activeElement);
    var dir = e.key === 'ArrowDown' ? 1 : -1;
    var t;
    if (idx >= 0) t = idx + dir;
    else t = Math.max(0, Math.min(items.length - 1, getStart(items) + dir));
    if (t < 0 || t >= items.length) { e.preventDefault(); return; }
    e.preventDefault();
    pick(items[t]);
    var ni = listEl.querySelectorAll(itemSel)[t];
    if (ni) ni.focus();
  },

  capsKeyNav: function (e) {
    var h = this;
    h.keyNav(e, h.el.capsList, '.cap-item',
      function (items) {
        var cur = 0;
        items.forEach(function (n, k) { if (n.classList.contains('active')) cur = k; });
        return cur;
      },
      function (el) {
        if (el.classList.contains('cap-live')) h.openTab('live');
        else h.openTab(el.getAttribute('data-cap-id'));
      });
  },

  panelKeyNav: function (e) {
    var h = this;
    h.keyNav(e, h.el.list, '.item',
      function (items) {
        var cur = 0;
        items.forEach(function (n, k) { if (n.classList.contains('sel')) cur = k; });
        return cur;
      },
      function (el) {
        var annId = el.getAttribute('data-ann-id');
        if (annId) Review.select(annId);
        else if (el.getAttribute('data-cap-id')) h.openTab(el.getAttribute('data-cap-id'));
      });
  },

  /* ---- captures sidebar (ordered; drag to reorder) ---- */

  // capture order == data.captures array order == order in the saved JSON
  moveCapture: function (id, delta) {
    var arr = this.data.captures;
    var i = -1;
    arr.forEach(function (c, k) { if (c.id === id) i = k; });
    var j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    this.markDirty();
    this.refreshUI();
  },

  reorderCapture: function (dragId, targetId, after) {
    var h = this, arr = h.data.captures;
    var from = -1, to = -1;
    arr.forEach(function (c, k) {
      if (c.id === dragId) from = k;
      if (c.id === targetId) to = k;
    });
    if (from < 0 || to < 0 || from === to) return;
    var moved = arr.splice(from, 1)[0];
    var t2 = -1;
    arr.forEach(function (c, k) { if (c.id === targetId) t2 = k; });
    arr.splice(t2 + (after ? 1 : 0), 0, moved);
    h.markDirty();
    h.refreshUI();
  },

  renderCapsList: function () {
    var h = this, list = h.el.capsList;
    list.textContent = '';
    if (!h.data) return;

    var live = document.createElement('div');
    live.className = 'cap-item cap-live' + (h.tab === 'live' ? ' active' : '');
    live.innerHTML = '&#9654; Live app';
    live.tabIndex = 0;
    live.setAttribute('data-cap-id', 'live');
    live.addEventListener('click', function () { h.openTab('live'); });
    list.appendChild(live);

    h.data.captures.forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'cap-item' + (h.tab === c.id ? ' active' : '');
      item.draggable = true;
      item.tabIndex = 0;
      item.setAttribute('data-cap-id', c.id);
      var fmt = new Date(c.ts);
      var when = isNaN(fmt) ? '' :
        fmt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        fmt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

      var l1 = document.createElement('div');
      l1.className = 'cap-l1';
      var idSpan = document.createElement('span');
      idSpan.className = 'cap-id';
      idSpan.textContent = c.id;
      var open = c.annotations.filter(function (a) { return a.status === 'open'; }).length;
      var cnt = document.createElement('span');
      cnt.className = 'cap-open';
      cnt.textContent = c.annotations.length + (open !== c.annotations.length ? ' (' + open + ')' : '');
      l1.appendChild(idSpan); l1.appendChild(cnt);

      var moves = document.createElement('span');
      moves.className = 'cap-move';
      var up = document.createElement('button');
      up.textContent = '\u25b2'; up.title = 'move up';
      up.addEventListener('click', function (e) { e.stopPropagation(); h.moveCapture(c.id, -1); });
      var dn = document.createElement('button');
      dn.textContent = '\u25bc'; dn.title = 'move down';
      dn.addEventListener('click', function (e) { e.stopPropagation(); h.moveCapture(c.id, 1); });
      moves.appendChild(up); moves.appendChild(dn);

      var del = document.createElement('button');
      del.className = 'cap-del';
      del.textContent = '\u00d7'; del.title = 'delete capture';
      del.addEventListener('click', function (e) { e.stopPropagation(); h.deleteCapture(c.id); });

      l1.appendChild(moves); l1.appendChild(del);

      var l2 = document.createElement('div');
      l2.className = 'cap-l2';
      l2.textContent = c.label || when;
      l2.title = (c.label ? c.label + ' \u2014 ' : '') + new Date(c.ts).toLocaleString();

      item.appendChild(l1); item.appendChild(l2);
      item.addEventListener('click', function () { h.openTab(c.id); });

      item.addEventListener('dragstart', function (e) {
        h._dragCap = c.id;
        item.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', c.id); } catch (err) { }
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', function () {
        h._dragCap = null;
        item.classList.remove('dragging');
        h.clearDropHints();
      });
      item.addEventListener('dragover', function (e) {
        if (!h._dragCap || h._dragCap === c.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var after = e.clientY > item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
        h.clearDropHints();
        item.classList.add(after ? 'drop-after' : 'drop-before');
      });
      item.addEventListener('drop', function (e) {
        e.preventDefault();
        if (!h._dragCap || h._dragCap === c.id) return;
        var after = e.clientY > item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2;
        h.reorderCapture(h._dragCap, c.id, after);
        h._dragCap = null;
      });
      list.appendChild(item);
    });
  },

  clearDropHints: function () {
    var h = this;
    Array.prototype.forEach.call(h.el.capsList.querySelectorAll('.drop-before, .drop-after'), function (n) {
      n.classList.remove('drop-before'); n.classList.remove('drop-after');
    });
  },

  renderList: function (c) {
    var h = this, list = h.el.list;
    list.textContent = '';
    if (!h.data) return;
    if (!c) {
      if (h.data.captures.length) {
        h.data.captures.forEach(function (cap) {
          var item = document.createElement('div');
          item.className = 'item';
          item.tabIndex = 0;
          item.setAttribute('data-cap-id', cap.id);
          var open = cap.annotations.filter(function (a) { return a.status === 'open'; }).length;
          item.textContent = cap.id + (cap.label ? ' \u00b7 ' + cap.label : '') +
            ' \u2014 ' + cap.annotations.length + ' annotations, ' + open + ' open';
          item.addEventListener('click', function () { h.openTab(cap.id); });
          list.appendChild(item);
        });
      } else {
        var e0 = document.createElement('div');
        e0.className = 'empty';
        e0.textContent = 'No captures yet. Press Ctrl+Shift+F (or the camera button) while using the app.';
        list.appendChild(e0);
      }
      return;
    }
    if (!c.annotations.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No annotations on ' + c.id + ' yet. Pick a tool below and draw on the screenshot.';
      list.appendChild(e);
      return;
    }
    c.annotations.forEach(function (a) {
      var item = document.createElement('div');
      item.className = 'item' + (a.id === Review.S.selected ? ' sel' : '') + (a.status !== 'open' ? ' done' : '');
      item.tabIndex = 0;
      item.setAttribute('data-ann-id', a.id);
      var b = document.createElement('span');
      b.className = 'badge';
      b.style.background = a.status === 'resolved' ? '#16a34a' : a.status === 'wontfix' ? '#64748b' : (a.color || CR_DEFAULT_COLOR);
      b.textContent = a.id;
      var note = document.createElement('span');
      note.className = 'note';
      note.textContent = a.note ? a.note : '(no note)';
      item.appendChild(b); item.appendChild(note);
      if (a.comments && a.comments.length) {
        var cc = document.createElement('span');
        cc.className = 'ccount';
        cc.textContent = '\ud83d\udcac' + a.comments.length;
        item.appendChild(cc);
      }
      item.addEventListener('click', function () { Review.select(a.id); });
      list.appendChild(item);
    });
  },

  renderEditor: function (c) {
    var h = this, ed = h.el.editor;
    var a = null;
    if (c && Review.S.selected) {
      c.annotations.forEach(function (x) { if (x.id === Review.S.selected) a = x; });
    }
    // while the user is typing in a text field for this same annotation,
    // don't rebuild the editor out from under them (button clicks don't count)
    var ae = document.activeElement;
    var editingText = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && ed.contains(ae);
    if (a && ed.getAttribute('data-edit-id') === a.id && editingText) return;

    ed.textContent = '';
    ed.setAttribute('data-edit-id', a ? a.id : '');
    if (!a) {
      if (c && c.annotations.length) {
        var e = document.createElement('div');
        e.className = 'empty';
        e.textContent = 'Select an annotation.';
        ed.appendChild(e);
      }
      return;
    }
    var head = document.createElement('div');
    head.className = 'ed-head';
    var title = document.createElement('div');
    title.className = 'ed-title';
    title.textContent = a.id + ' \u00b7 on ' + c.id + ' \u00b7 by ' + (a.author || '?');
    head.appendChild(title);
    var del = document.createElement('button');
    del.className = 'ed-del';
    del.title = 'Delete ' + a.id;
    del.setAttribute('aria-label', 'Delete ' + a.id);
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
    del.addEventListener('click', function () { Review.deleteAnnotation(a.id); });
    head.appendChild(del);
    ed.appendChild(head);

    // comment thread: lead note first, then other reviewers' comments
    var fmt = function (ts) {
      var d = new Date(ts);
      return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    };
    var thread = document.createElement('div');
    thread.className = 'thread';
    var mkEntry = function (author, ts, text, isLead) {
      var e = document.createElement('div');
      e.className = 'comment' + (isLead ? ' lead' : '');
      var meta = document.createElement('div');
      meta.className = 'c-meta';
      meta.textContent = (author || '?') + ' \u00b7 ' + fmt(ts);
      var body = document.createElement('div');
      body.className = 'c-body';
      if (text) body.textContent = text;
      else { body.textContent = '(no note)'; body.classList.add('muted'); }
      if (isLead) {
        body.title = 'click to edit';
        body.addEventListener('click', function () {
          if (ed.querySelector('textarea.edit-lead')) return;
          var t = document.createElement('textarea');
          t.className = 'edit-lead';
          t.value = a.note || '';
          body.replaceWith(t);
          var fit = function () {
            t.style.height = 'auto';
            // +2 for the 1px top/bottom borders (border-box height)
            t.style.height = Math.max(40, t.scrollHeight + 2) + 'px';
          };
          fit();
          t.focus();
          t.setSelectionRange(t.value.length, t.value.length);
          t.addEventListener('input', fit);
          var done = false;
          var commit = function (ev) {
            if (done) return;
            // clicks inside the textarea just move the caret — not a commit
            if (ev && ev.target && (ev.target === t || t.contains(ev.target))) return;
            done = true;
            document.removeEventListener('mousedown', commit, true);
            Review.patch(a.id, { note: t.value });
            // rebuild so the box is replaced by the display text; without this
            // the mounted textarea swallows all FURTHER edits (done-flag)
            ed.setAttribute('data-edit-id', '');
            h.refreshUI();
          };
          // click-away commits (works even when focus events are suppressed)
          document.addEventListener('mousedown', commit, true);
          t.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
              done = true;
              document.removeEventListener('mousedown', commit, true);
              h.refreshUI();
            }
          });
          t.addEventListener('blur', commit);
        });
      }
      e.appendChild(meta); e.appendChild(body);
      return e;
    };
    thread.appendChild(mkEntry(a.author, a.ts, a.note, true));
    (a.comments || []).forEach(function (cm) {
      thread.appendChild(mkEntry(cm.author, cm.ts, cm.text, false));
    });
    if (!a.note && !(a.comments || []).length) {
      var none = document.createElement('div');
      none.className = 'c-meta';
      none.textContent = 'no comments yet \u2014 add one below';
      thread.appendChild(none);
    }
    ed.appendChild(thread);

    // status + severity, above the comment input
    var row = document.createElement('div');
    row.className = 'ed-row';
    var st = document.createElement('select');
    ['open', 'resolved', 'wontfix'].forEach(function (s) {
      var o = document.createElement('option');
      o.value = s; o.textContent = s; if (a.status === s) o.selected = true;
      st.appendChild(o);
    });
    st.addEventListener('change', function () { Review.patch(a.id, { status: st.value }); });
    var curSev = crSeverityOf(a);
    var sev = document.createElement('select');
    sev.className = 'sev';
    sev.title = 'Severity classification';
    CR_SEVERITIES.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s[0]; o.textContent = s[0] + ' \u2014 ' + s[2];
      if (curSev === s[0]) o.selected = true;
      sev.appendChild(o);
    });
    var oth = document.createElement('option');
    oth.value = 'other'; oth.textContent = 'others \u2014 pick any other colour';
    if (curSev === 'other') oth.selected = true;
    sev.appendChild(oth);
    sev.addEventListener('change', function () {
      var hex = crSeverityHex(sev.value);
      if (hex) {
        Review.patch(a.id, { severity: sev.value, color: hex });
        Review.S.meta.color = hex; // continue drawing in this color
      } else {
        Review.patch(a.id, { severity: 'other' }); // palette appears below
      }
    });
    row.appendChild(st); row.appendChild(sev);
    ed.appendChild(row);

    // full severity text — the closed select clips long labels
    var sevDesc = document.createElement('div');
    sevDesc.className = 'sev-desc';
    CR_SEVERITIES.forEach(function (s) {
      if (curSev === s[0]) sevDesc.textContent = s[0] + ' \u2014 ' + s[2];
    });
    if (curSev === 'other') sevDesc.textContent = 'others \u2014 pick any other colour below';
    ed.appendChild(sevDesc);

    // free colour palette, only under "others"
    if (curSev === 'other') {
      var sw = document.createElement('div');
      sw.className = 'swatches';
      CR_PALETTE.forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'swatch' + ((a.color || CR_DEFAULT_COLOR) === p[0] ? ' active' : '');
        b.style.background = p[0];
        b.title = p[1];
        b.addEventListener('click', function () {
          Review.patch(a.id, { color: p[0], severity: 'other' });
          Review.S.meta.color = p[0]; // continue drawing in this color
        });
        sw.appendChild(b);
      });
      ed.appendChild(sw);
    }

    // add-comment input (bottom)
    var addRow = document.createElement('div');
    addRow.className = 'add-row';
    var ta = document.createElement('textarea');
    ta.rows = 3;
    var who = h.el.author.value.trim() || 'anonymous';
    ta.placeholder = 'add comment as ' + who + '\u2026 (Ctrl+Enter)';
    var add = document.createElement('button');
    add.className = 'add-cmt';
    add.textContent = 'Add';
    var submit = function () {
      var v = ta.value.trim();
      if (!v) return;
      var cmAuthor = h.el.author.value.trim() || 'anonymous';
      if (!a.note) Review.patch(a.id, { note: v });
      else {
        if (!Array.isArray(a.comments)) a.comments = [];
        a.comments.push({ author: cmAuthor, ts: new Date().toISOString(), text: v });
        h.markDirty();
        Review.render();
      }
      if (document.activeElement) document.activeElement.blur();
      h.refreshUI();
    };
    add.addEventListener('click', submit);
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); }
    });
    addRow.appendChild(ta); addRow.appendChild(add);
    ed.appendChild(addRow);
  },

  /* ---- saving ---- */

  buildSpliced: async function () {
    var h = this;
    var base = h.rawApp || '';
    // strip every existing block (not just the first) so stacked legacy
    // blocks are collapsed, and hash the truly block-free app text
    var stripped = base.replace(CR_BLOCK_RE_G, '');
    var hash = await crSha256(stripped);
    if (!h.data.app || typeof h.data.app !== 'object') h.data.app = {};
    h.data.app = { sha256: hash, bytes: stripped.length };
    var jsonText = JSON.stringify(h.data, null, 2);
    if (jsonText.indexOf('+cr-->') >= 0 || jsonText.indexOf('<!--cr+') >= 0) {
      throw new Error('an annotation note contains the sentinel string \u2014 refusing to write a corrupt block');
    }
    var block = CR_BLOCK_OPEN + jsonText + CR_BLOCK_CLOSE;
    var out;
    var i = stripped.toLowerCase().lastIndexOf('</body>');
    if (i >= 0) out = stripped.slice(0, i) + block + '\n' + stripped.slice(i);
    else out = stripped + '\n' + block + '\n';
    return out;
  },

  save: async function () {
    var h = this;
    if (!h.data) { h.toast('Open an app first'); return; }
    if (h._saving) return;
    h._saving = true;
    h.el.save.classList.add('saving');
    h.updateSaveState();
    h.data.savedTs = Date.now(); // persisted so the button can show it after reloads
    var ok = false;
    try {
      if (h.handle && h._handleNeedsPerm) {
        // must run inside the click's user activation
        try {
          var pst = await h.handle.queryPermission({ mode: 'readwrite' });
          if (pst !== 'granted') pst = await h.handle.requestPermission({ mode: 'readwrite' });
          h._handleNeedsPerm = pst !== 'granted';
          if (pst !== 'granted') h.toast('File access was not granted \u2014 downloading a copy instead');
        } catch (e) { h._handleNeedsPerm = true; }
      }
      if (!h.handle || h._handleNeedsPerm) {
        ok = await h.downloadFallback();
      } else if (h._handleSha != null && h._handleSha !== h.baseHash) {
        h.handle = null;
        h._handleSha = null;
        h.toast('File connection was stale \u2014 use Open app HTML\u2026 to re-attach for direct saving', 6000);
        ok = await h.downloadFallback();
      } else {
        var file = await h.handle.getFile();
        var fresh = await file.text();
        if (fresh !== h.rawApp) h.toast('File changed on disk since load \u2014 splicing onto the fresh copy');
        h.rawApp = fresh;
        var out = await h.buildSpliced();
        var w = await h.handle.createWritable();
        await w.write(new Blob([out], { type: 'text/html' }));
        await w.close();
        h.rawApp = out;
        var pb2 = crParseBlock(out);
        h.baseHash = await crSha256(pb2 ? pb2.stripped : out);
        h._handleSha = h.baseHash;
        h.updateHashChip();
        ok = true;
        try { await crIdbSet('fs-handle', { handle: h.handle, sha: h._handleSha, name: h.appName }); } catch (e) { }
        h.toast('Saved ' + h.data.captures.length + ' captures / ' +
          h.data.captures.reduce(function (n, c) { return n + c.annotations.length; }, 0) +
          ' annotations \u2192 ' + h.handle.name);
      }
    } catch (e) {
      h.toast('Save failed: ' + e);
    } finally {
      if (ok) {
        h._dirty = false; h._lastSavedAt = Date.now();
        h._changeCount = 0;
        h._stashSuppressed = true; // keep the post-save refreshUI from re-stashing
        try { localStorage.removeItem(h.stashKey()); } catch (e) { } // file/export is now the record
      }
      h._saving = false;
      h.el.save.classList.remove('saving');
      h.refreshUI();
    }
  },

  downloadFallback: async function () {
    var h = this;
    try {
      var out = await h.buildSpliced();
      var aEl = document.createElement('a');
      aEl.href = URL.createObjectURL(new Blob([out], { type: 'text/html' }));
      aEl.download = h.appName || 'annotated.html';
      aEl.click();
      h.toast('No file handle \u2014 downloaded spliced file instead');
      return true;
    } catch (e) { h.toast('Export failed: ' + e); return false; }
  },

  copyJSON: async function () {
    var h = this;
    if (!h.data) { h.toast('Open an app first'); return; }
    var jsonText = JSON.stringify(h.data, null, 2);
    try {
      await navigator.clipboard.writeText(jsonText);
      h.toast('Annotation JSON copied');
    } catch (e) {
      h.toast('Clipboard blocked \u2014 use Save or download instead');
    }
  },

  reload: async function () {
    var h = this;
    if (h.handle) await h.openHandle(h.handle);
    else {
      var app = new URLSearchParams(location.search).get('app');
      if (app) h.fetchApp(app);
      else h.toast('Nothing to reload');
    }
  },

  toast: function (msg, ms) {
    var h = this;
    h.el.toast.textContent = msg;
    h.el.toast.hidden = false;
    clearTimeout(h._toastT);
    h._toastT = setTimeout(function () { h.el.toast.hidden = true; }, ms || 3500);
  },

  debugSpliced: function () { return this.buildSpliced(); },

  /* ---- export: self-contained code-review HTML ---- */

  exportReview: async function () {
    var h = this;
    if (!h.data) { h.toast('Open an app first'); return; }
    try {
      var html = h.buildExport();
      var aEl = document.createElement('a');
      aEl.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      aEl.download = (h.appName || 'app').replace(/\.html?$/i, '') + '-code-review.html';
      aEl.click();
      h.toast('Exported code review \u2014 ' + Math.round(html.length / 1024) + ' KB, ' +
        h.data.captures.length + ' captures / ' +
        h.data.captures.reduce(function (n, c) { return n + c.annotations.length; }, 0) + ' annotations');
    } catch (e) {
      h.toast('Export failed: ' + e);
    }
  },

  buildExport: function () {
    var h = this;
    var b64 = function (s) {
      var bytes = new TextEncoder().encode(s), bin = '';
      for (var i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    };
    var data = {
      tool: 'spa-code-review export 0.6.0', exportedTs: new Date().toISOString(),
      appName: h.appName, seq: h.data.seq, captures: h.data.captures,
      appB64: b64(h.rawApp || '')
    };
    // script-data safety: escape every '<' as \u003c in the JSON text —
    // valid JSON (parses identically) and leaves no <, </script, <!-- or
    // <script sequences for the HTML parser to act on
    var dataJson = JSON.stringify(data, null, 1).replace(/</g, '\\u003c');
    var E = CR_EXPORT_ENGINE_SRC;
    return '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="utf-8">\n' +
'<title>Code review \u2014 ' + h.appName.replace(/</g, '&lt;') + '</title>\n' +
'<style>\n' + CR_EXPORT_CSS + '\n</style>\n' +
'</head>\n' +
'<body>\n' +
'<header>\n' +
'  <span class="title">Code review \u2014 ' + h.appName.replace(/</g, '&lt;') + '</span>\n' +
'  <span id="meta-chip" class="chip"></span>\n' +
'  <span class="spacer"></span>\n' +
'  <label class="author-wrap">your name <input id="author-input" placeholder="reviewer" maxlength="32"></label>\n' +
'  <button id="x-save-app" class="primary" title="Splice your comments and status updates into the embedded app file and download it">Save comments</button>\n' +
'  <button id="x-save-review" class="primary" title="Download a copy of this review file including your comments and status updates">Export a copy</button>\n' +
'</header>\n' +
'<main>\n' +
'  <aside id="caps"><h2>Captures</h2><div id="caps-list"></div></aside>\n' +
'  <aside id="panel"><h2>Annotations</h2><div id="panel-list"></div><div id="panel-editor"></div></aside>\n' +
'  <div id="stage"><div id="snap-wrap"><div id="snap-scale">\n' +
'    <iframe id="snap-frame" title="app snapshot" sandbox="allow-same-origin"></iframe>\n' +
'  </div><svg id="snap-svg" xmlns="http://www.w3.org/2000/svg"></svg></div>\n' +
'  <div id="no-snap">This review has no captures yet.</div></div>\n' +
'</main>\n' +
'<div id="toast" hidden></div>\n' +
'<div id="who-modal" hidden><div class="who-card"><div class="who-title">Who is reviewing?</div>' +
'<div class="c-meta">Your name is attached to the comments you add.</div>' +
'<input id="who-input" placeholder="your name" maxlength="32">' +
'<button id="who-go" class="primary">Start reviewing</button></div></div>\n' +
'<script id="cr-export-data" type="application/json">' + dataJson + '<\/script>\n' +
'<script>\n' + E + '\n<\/script>\n' +
'</body>\n</html>\n';
  }
};

/* Export viewer: a compact read-mostly review client (comments + status only,
 * no drawing tools). Runs from file:// with zero external dependencies. */
var CR_EXPORT_CSS = [
  ':root { --bg:#0f172a; --bg2:#1e293b; --fg:#e2e8f0; --muted:#94a3b8; --accent:#2563eb; }',
  '* { box-sizing: border-box; } [hidden] { display: none !important; }',
  'html, body { height: 100%; margin: 0; }',
  'body { display: flex; flex-direction: column; background: var(--bg); color: var(--fg);',
  '       font: 13px/1.4 system-ui, "Segoe UI", sans-serif; }',
  'header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg2);',
  '         border-bottom: 1px solid #334155; flex: none; }',
  'header .title { font-weight: 700; margin-right: 4px; }',
  'button { background: #334155; color: var(--fg); border: 1px solid #475569; border-radius: 6px;',
  '         padding: 5px 10px; font: inherit; cursor: pointer; }',
  'button:hover { background: #475569; }',
  'button.primary { background: var(--accent); border-color: var(--accent); font-weight: 600; }',
  '.chip { background: #0b1220; border: 1px solid #334155; border-radius: 999px; padding: 3px 10px;',
  '        font-size: 12px; color: var(--muted); white-space: nowrap; }',
  '.spacer { flex: 1; }',
  '.author-wrap { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }',
  '.author-wrap input { width: 32ch; background: #0b1220; color: var(--fg); border: 1px solid #475569;',
  '                     border-radius: 6px; padding: 4px 6px; font: inherit; }',
  'main { flex: 1; display: flex; min-height: 0; }',
  '#caps { width: 210px; flex: none; background: var(--bg2); border-right: 1px solid #334155;',
  '        display: flex; flex-direction: column; min-height: 0; }',
  '#caps h2, #panel h2 { margin: 0; padding: 10px 12px 6px; font-size: 12px; text-transform: uppercase;',
  '                      letter-spacing: .06em; color: var(--muted); }',
  '#caps-list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }',
  '.cap-item { padding: 6px 8px; border-radius: 7px; margin-bottom: 2px; cursor: pointer;',
  '            border: 1px solid transparent; }',
  '.cap-item:hover { background: #334155; }',
  '.cap-item.active { background: #1d3160; border-color: var(--accent); }',
  '.cap-l1 { display: flex; align-items: center; gap: 6px; }',
  '.cap-id { color: #fff; font: 700 10px/1 ui-monospace, monospace; background: #475569;',
  '          border-radius: 999px; padding: 3px 6px; }',
  '.cap-item.active .cap-id { background: var(--accent); }',
  '.cap-open { font-size: 11px; color: var(--muted); }',
  '.cap-l2 { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis;',
  '          white-space: nowrap; margin-top: 2px; }',
  '#stage { flex: 1; min-width: 0; min-height: 0; overflow: auto; background: #e2e8f0; padding: 12px; }',
  '#snap-wrap { position: relative; margin: 0 auto; width: max-content; box-shadow: 0 2px 10px rgba(0,0,0,.25);',
  '             background: #fff; }',
  '#snap-scale { transform-origin: 0 0; }',
  '#snap-frame { border: 0; display: block; background: #fff; }',
  '#snap-svg { position: absolute; inset: 0; pointer-events: none; }',
  '@keyframes cr-shrink { from { opacity: 0; transform: scale(1.18); } to { opacity: .35; transform: scale(1); } }',
  '#snap-svg .cr-halo { opacity: .35; transform-box: fill-box; transform-origin: center;',
  '                     animation: cr-shrink .2s ease-out; }',
  '  #caps-list .cap-item:focus-visible, #panel-list .item:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }',
  '#no-snap { color: var(--muted); text-align: center; padding: 40px; }',
  '#panel { width: 320px; flex: none; background: var(--bg2); border-right: 1px solid #334155;',
  '         display: flex; flex-direction: column; min-height: 0; }',
  '#panel-list { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 8px; min-height: 80px; }',
  '.item { display: flex; align-items: flex-start; gap: 6px; padding: 8px; border-radius: 7px;',
  '        cursor: pointer; border: 1px solid transparent; font-size: 12px; }',
  '.item:hover { background: #334155; }',
  '.item.sel { background: #1d3160; border-color: var(--accent); }',
  '.item.done .note { text-decoration: line-through; color: var(--muted); }',
  '.badge { flex: none; color: #fff; font: 700 10px/1 ui-monospace, monospace; border-radius: 999px;',
  '         padding: 3px 6px; }',
  '.note { color: #cbd5e1; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.ccount { margin-left: auto; flex: none; font-size: 11px; color: var(--muted); }',
  '#panel-editor { flex: 0 0 auto; max-height: 58%; border-top: 1px solid #334155; padding: 10px 12px;',
  '                 overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }',
  '.empty { color: var(--muted); font-size: 12px; }',
  '.ed-title { font-weight: 700; }',
  '.thread { display: flex; flex-direction: column; gap: 6px; }',
  '.comment { background: #0b1220; border: 1px solid #334155; border-radius: 7px; padding: 6px 8px; }',
  '.comment.lead { border-color: #475569; }',
  '.c-meta { font-size: 10px; color: var(--muted); margin-bottom: 2px; }',
  '.c-body { font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.c-body.muted { color: var(--muted); font-style: italic; }',
  '.ed-row { display: flex; gap: 8px; align-items: center; }',
  '#panel-editor select { background: #0b1220; color: var(--fg); border: 1px solid #475569;',
  '                       border-radius: 6px; padding: 4px; font: inherit; }',
  '.swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; flex: 1; }',
  '.swatch { height: 20px; border-radius: 4px; border: 2px solid #334155; cursor: pointer; padding: 0; }',
  '.swatch:hover { border-color: #94a3b8; }',
  '.swatch.active { border-color: #fff; box-shadow: 0 0 0 1.5px var(--accent); }',
  '.add-row { display: flex; gap: 6px; align-items: flex-end; }',
  '.add-row textarea { flex: 1; background: #0b1220; color: var(--fg); border: 1px solid #475569;',
  '                    border-radius: 7px; padding: 6px 8px; font: inherit; resize: vertical; }',
  '.add-cmt { background: var(--accent); border-color: var(--accent); font-weight: 600; flex: none; }',
'  #toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #0b1220;',
'         color: var(--fg); border: 1px solid #475569; border-radius: 8px; padding: 8px 14px;',
'         max-width: 70vw; z-index: 10; }',
'  #who-modal { position: fixed; inset: 0; background: rgba(2, 6, 23, .8); z-index: 20;',
'              display: flex; align-items: center; justify-content: center; }',
'  .who-card { background: var(--bg2); border: 1px solid #475569; border-radius: 10px; padding: 20px;',
'             width: 300px; display: flex; flex-direction: column; gap: 10px; }',
'  .who-title { font-weight: 700; font-size: 15px; }',
'  .who-card input { background: #0b1220; color: var(--fg); border: 1px solid #475569;',
'                   border-radius: 6px; padding: 6px 8px; font: inherit; }',
'  .who-card button { margin-top: 2px; }'
].join('\n');

var CR_EXPORT_ENGINE_SRC = [
"'use strict';",
'var D = JSON.parse(document.getElementById("cr-export-data").textContent);',
'var CAP_OPEN = \'<script type="application/json" id="cr-annotations"><!--cr+\\n\';',
'var CAP_CLOSE = \'\\n+cr--><\\\\/script>\';',
'var CAP_RE = /<script type="application\\/json" id="cr-annotations"><!--cr\\+[\\s\\S]*?\\+cr--><\\/script>/;',
'var appText = null;',
'try {',
'  var bin = atob(D.appB64), u8 = new Uint8Array(bin.length);',
'  for (var i0 = 0; i0 < bin.length; i0++) u8[i0] = bin.charCodeAt(i0);',
'  appText = new TextDecoder().decode(u8);',
'} catch (e0) { }',
'var INITIAL_HTML = "<!DOCTYPE html>\\n" + document.documentElement.outerHTML;',
'var sel = null, tab = null, scale = 1, draft = "";',
'function $(id) { return document.getElementById(id); }',
'function toast(m) { var t = $("toast"); t.textContent = m; t.hidden = false;',
'  setTimeout(function () { t.hidden = true; }, 3500); }',
'function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }',
'function fmt(ts) { var d = new Date(ts); return isNaN(d) ? "" :',
'  d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +',
'  d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }',
'function authorNow() { return $("author-input").value.trim() || "reviewer"; }',
'function capById(id) { for (var i = 0; i < D.captures.length; i++) if (D.captures[i].id === id) return D.captures[i]; return null; }',
'function annById(c, id) { for (var i = 0; i < c.annotations.length; i++) if (c.annotations[i].id === id) return c.annotations[i]; return null; }',
'function strokeColor(a) { return a.status === "resolved" ? "#16a34a" : a.status === "wontfix" ? "#64748b" : (a.color || "#dc2626"); }',
'var SEV_HEX = { green: "#16a34a", yellow: "#ca8a04", orange: "#ea580c", red: "#dc2626" };',
'var SEV_TXT = { green: "enhancement, no impact if not addressed",',
'  yellow: "minor nitpicks/annoyances, leads to more coherent and consistent experience if addressed",',
'  orange: "potential sources of confusion that can hamper student learning",',
'  red: "severe bugs", other: "custom colour" };',
'function severityOf(a) {',
'  if (a.severity === "other" || SEV_HEX[a.severity]) return a.severity;',
'  for (var k in SEV_HEX) if (SEV_HEX[k] === (a.color || "#dc2626")) return k;',
'  return "other";',
'}',
'function jsonData() { return JSON.stringify(D, null, 1).replace(/</g, "\\\\u003c"); }',
'function download(name, text) {',
'  var a = document.createElement("a");',
'  a.href = URL.createObjectURL(new Blob([text], { type: "text/html" }));',
'  a.download = name; a.click();',
'}',
'function splicedApp(hash) {',
'  var base = appText || "";',
'  var stripped = base.replace(CAP_RE, "");',
'  var block = CAP_OPEN + JSON.stringify({ schema: 2, tool: "spa-code-review 0.6.0", seq: D.seq,',
'    app: { sha256: hash || null, bytes: stripped.length }, captures: D.captures }, null, 2) + CAP_CLOSE;',
'  var m = stripped.toLowerCase().lastIndexOf("</body>");',
'  return m >= 0 ? stripped.slice(0, m) + block + "\\n" + stripped.slice(m) : stripped + "\\n" + block + "\\n";',
'}',
'function renderCaps() {',
'  var list = $("caps-list"); list.textContent = "";',
'  D.captures.forEach(function (c) {',
'    var it = document.createElement("div");',
'    it.className = "cap-item" + (tab === c.id ? " active" : "");',
'    it.tabIndex = 0;',
'    it.setAttribute("data-cap-id", c.id);',
'    var l1 = document.createElement("div"); l1.className = "cap-l1";',
'    var id = document.createElement("span"); id.className = "cap-id"; id.textContent = c.id;',
'    var openCount = c.annotations.filter(function (a) { return a.status === "open"; }).length;',
'    var ct = document.createElement("span"); ct.className = "cap-open";',
'    ct.textContent = c.annotations.length + (openCount !== c.annotations.length ? " (" + openCount + ")" : "");',
'    l1.appendChild(id); l1.appendChild(ct);',
'    var l2 = document.createElement("div"); l2.className = "cap-l2";',
'    l2.textContent = c.label || fmt(c.ts); l2.title = (c.label ? c.label + " \\u2014 " : "") + new Date(c.ts).toLocaleString();',
'    it.appendChild(l1); it.appendChild(l2);',
'    it.addEventListener("click", function () { open(c.id); });',
'    list.appendChild(it);',
'  });',
'  $("meta-chip").textContent = D.captures.length + " captures \\u00b7 " +',
'    D.captures.reduce(function (n, c) { return n + c.annotations.length; }, 0) + " annotations \\u00b7 exported " + fmt(D.exportedTs);',
'}',
'function drawShapeNS(NS, svg, a, color, selRing) {',
'  var el;',
'  if (a.kind === "ellipse" && a.w != null) {',
'    el = document.createElementNS(NS, "ellipse");',
'    el.setAttribute("cx", a.x + a.w / 2); el.setAttribute("cy", a.y + a.h / 2);',
'    el.setAttribute("rx", a.w / 2); el.setAttribute("ry", a.h / 2);',
'  } else if ((a.kind === "line" || a.kind === "arrow") && a.x2 != null) {',
'    el = document.createElementNS(NS, "line");',
'    el.setAttribute("x1", a.x); el.setAttribute("y1", a.y);',
'    el.setAttribute("x2", a.x2); el.setAttribute("y2", a.y2);',
'    el.setAttribute("stroke-linecap", "round");',
'  } else {',
'    el = document.createElementNS(NS, "rect");',
'    el.setAttribute("x", a.x); el.setAttribute("y", a.y);',
'    el.setAttribute("width", a.w || 40); el.setAttribute("height", a.h || 24);',
'    el.setAttribute("rx", 3);',
'  }',
'  el.setAttribute("fill", color); el.setAttribute("fill-opacity", a.status === "open" ? 0.08 : 0.04);',
'  el.setAttribute("stroke", color); el.setAttribute("stroke-width", 2.5);',
'  if (a.status === "resolved" || a.status === "wontfix") el.setAttribute("stroke-dasharray", "4 3");',
'  svg.appendChild(el);',
'  if (a.kind === "arrow" && a.x2 != null) {',
'    var ang = Math.atan2(a.y2 - a.y, a.x2 - a.x), L = 13, W = 5.5;',
'    var head = document.createElementNS(NS, "polygon");',
'    var pts = [[a.x2, a.y2],',
'      [a.x2 - L * Math.cos(ang) - W * Math.sin(ang), a.y2 - L * Math.sin(ang) + W * Math.cos(ang)],',
'      [a.x2 - L * Math.cos(ang) + W * Math.sin(ang), a.y2 - L * Math.sin(ang) - W * Math.cos(ang)]];',
'    head.setAttribute("points", pts.map(function (p) { return p[0].toFixed(1) + "," + p[1].toFixed(1); }).join(" "));',
'    head.setAttribute("fill", color); svg.appendChild(head);',
'  }',
'  var c = document.createElementNS(NS, "circle");',
'  c.setAttribute("cx", a.x - 2); c.setAttribute("cy", a.y - 2); c.setAttribute("r", 12);',
'  c.setAttribute("fill", color); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", 2);',
'  svg.appendChild(c);',
'  var t = document.createElementNS(NS, "text");',
'  t.setAttribute("x", a.x - 2); t.setAttribute("y", a.y + 2.5); t.setAttribute("text-anchor", "middle");',
'  t.setAttribute("font-family", "ui-monospace,Consolas,monospace"); t.setAttribute("font-size", 11);',
'  t.setAttribute("font-weight", "700"); t.setAttribute("fill", "#fff"); t.textContent = a.id;',
'  svg.appendChild(t);',
'  if (selRing) {',
'    var w = a.w || 60, h = a.h || 30, x = a.x, y = a.y;',
'    if (a.kind === "line" || a.kind === "arrow") { x = Math.min(a.x, a.x2); y = Math.min(a.y, a.y2); w = Math.abs(a.x2 - a.x) || 60; h = Math.abs(a.y2 - a.y) || 30; }',
'    var r = document.createElementNS(NS, "rect");',
'    r.setAttribute("x", x - 5); r.setAttribute("y", y - 5);',
'    r.setAttribute("width", w + 10); r.setAttribute("height", h + 10);',
'    r.setAttribute("fill", "none"); r.setAttribute("stroke", "#2563eb");',
'    r.setAttribute("stroke-width", 1.5); r.setAttribute("stroke-dasharray", "4 3");',
'    svg.appendChild(r);',
'  }',
'}',
'function drawTextNote(NS, svg, a, color) {',
'  var fo = document.createElementNS(NS, "foreignObject");',
'  fo.setAttribute("x", a.x); fo.setAttribute("y", a.y); fo.setAttribute("width", 260);',
'  var div = document.createElement("div");',
'  div.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");',
'  div.style.cssText = "max-width:240px;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,0.94);border:2px solid " + color + ";font:12px/1.45 system-ui,sans-serif;color:#1e293b;white-space:pre-wrap;word-break:break-word;";',
'  div.textContent = a.note || "(no note)";',
'  fo.appendChild(div); svg.appendChild(fo);',
'  var w = Math.ceil(div.getBoundingClientRect().width / scale) + 4;',
'  var h = Math.ceil(div.getBoundingClientRect().height / scale) + 4;',
'  fo.setAttribute("width", Math.min(w, 260)); fo.setAttribute("height", h);',
'  var c = document.createElementNS(NS, "circle");',
'  c.setAttribute("cx", a.x - 2); c.setAttribute("cy", a.y - 2); c.setAttribute("r", 12);',
'  c.setAttribute("fill", color); c.setAttribute("stroke", "#fff"); c.setAttribute("stroke-width", 2);',
'  svg.appendChild(c);',
'  var t = document.createElementNS(NS, "text");',
'  t.setAttribute("x", a.x - 2); t.setAttribute("y", a.y + 2.5); t.setAttribute("text-anchor", "middle");',
'  t.setAttribute("font-family", "ui-monospace,Consolas,monospace"); t.setAttribute("font-size", 11);',
'  t.setAttribute("font-weight", "700"); t.setAttribute("fill", "#fff"); t.textContent = a.id;',
'  svg.appendChild(t);',
'}',
'function renderOverlay() {',
'  var NS = "http://www.w3.org/2000/svg";',
'  var svg = $("snap-svg"); svg.textContent = "";',
'  var c = capById(tab); if (!c) return;',
'  c.annotations.forEach(function (a) {',
'    var col = strokeColor(a);',
'    if (a.kind === "text") drawTextNote(NS, svg, a, col);',
'    else drawShapeNS(NS, svg, a, col, sel === a.id);',
'  });',
'  if (sel) {',
'    var sa = annById(c, sel);',
'    if (sa) {',
'      var bx = annBox(sa);',
'      var halo = document.createElementNS(NS, "rect");',
'      halo.setAttribute("x", bx.x - 12); halo.setAttribute("y", bx.y - 12);',
'      halo.setAttribute("width", bx.w + 24); halo.setAttribute("height", bx.h + 24);',
'      halo.setAttribute("rx", 10); halo.setAttribute("fill", "#2563eb");',
'      halo.setAttribute("class", "cr-halo");',
'      svg.insertBefore(halo, svg.firstChild);',
'    }',
'  }',
'}',
'function annBox(a) {',
'  var w = a.w || 60, h = a.h || 30, x = a.x, y = a.y;',
'  if ((a.kind === "line" || a.kind === "arrow") && a.x2 != null) {',
'    x = Math.min(a.x, a.x2); y = Math.min(a.y, a.y2);',
'    w = Math.abs(a.x2 - a.x) || 60; h = Math.abs(a.y2 - a.y) || 30;',
'  }',
'  return { x: x, y: y, w: w, h: h };',
'}',
'function ensureVisible(id) {',
'  var c = capById(tab);',
'  var a = c && id ? annById(c, id) : null;',
'  if (!a) return;',
'  var b = annBox(a);',
'  var cb = $("snap-wrap").getBoundingClientRect();',
'  var vb = $("stage").getBoundingClientRect();',
'  var top = cb.top + b.y * scale, left = cb.left + b.x * scale;',
'  var bot = top + b.h * scale, right = left + b.w * scale;',
'  if (top < vb.top || bot > vb.bottom || left < vb.left || right > vb.right) {',
'    $("stage").scrollBy({ top: (top + bot) / 2 - (vb.top + vb.bottom) / 2,',
'      left: (left + right) / 2 - (vb.left + vb.right) / 2, behavior: "smooth" });',
'  }',
'}',
'function renderList() {',
'  var c = capById(tab), list = $("panel-list"); list.textContent = "";',
'  if (!c || !c.annotations.length) {',
'    var e = document.createElement("div"); e.className = "empty";',
'    e.textContent = c ? "No annotations on this capture." : "Open a capture.";',
'    list.appendChild(e); return;',
'  }',
'  c.annotations.forEach(function (a) {',
'    var it = document.createElement("div");',
'    it.className = "item" + (sel === a.id ? " sel" : "") + (a.status !== "open" ? " done" : "");',
'    it.tabIndex = 0;',
'    it.setAttribute("data-ann-id", a.id);',
'    var b = document.createElement("span"); b.className = "badge";',
'    b.style.background = strokeColor(a); b.textContent = a.id;',
'    var n = document.createElement("span"); n.className = "note";',
'    n.textContent = a.note || "(no note)";',
'    it.appendChild(b); it.appendChild(n);',
'    if (a.comments && a.comments.length) {',
'      var cc = document.createElement("span"); cc.className = "ccount";',
'      cc.textContent = "\\ud83d\\udcac" + a.comments.length; it.appendChild(cc);',
'    }',
'    it.addEventListener("click", function () { select(a.id); });',
'    list.appendChild(it);',
'  });',
'}',
'function renderEditor() {',
'  var ed = $("panel-editor"); ed.textContent = "";',
'  var c = capById(tab);',
'  var a = c && sel ? annById(c, sel) : null;',
'  if (!a) return;',
'  var title = document.createElement("div"); title.className = "ed-title";',
'  title.textContent = a.id + " \\u00b7 on " + c.id + " \\u00b7 by " + (a.author || "?");',
'  ed.appendChild(title);',
'  var svKey = severityOf(a);',
'  var sevLine = document.createElement("div"); sevLine.className = "c-meta";',
'  sevLine.textContent = "severity: " + svKey + (SEV_TXT[svKey] ? " \\u00b7 " + SEV_TXT[svKey] : "");',
'  ed.appendChild(sevLine);',
'  var thread = document.createElement("div"); thread.className = "thread";',
'  var mkEntry = function (author, ts, text, isLead) {',
'    var e = document.createElement("div"); e.className = "comment" + (isLead ? " lead" : "");',
'    var m = document.createElement("div"); m.className = "c-meta";',
'    m.textContent = (author || "?") + " \\u00b7 " + fmt(ts);',
'    var b = document.createElement("div"); b.className = "c-body";',
'    if (text) b.textContent = text; else { b.textContent = "(no note)"; b.className += " muted"; }',
'    e.appendChild(m); e.appendChild(b); return e;',
'  };',
'  thread.appendChild(mkEntry(a.author, a.ts, a.note, true));',
'  (a.comments || []).forEach(function (cm) { thread.appendChild(mkEntry(cm.author, cm.ts, cm.text, false)); });',
'  ed.appendChild(thread);',
'  var row = document.createElement("div"); row.className = "ed-row";',
'  var stLabel = document.createElement("span"); stLabel.className = "c-meta"; stLabel.textContent = "status";',
'  var st = document.createElement("select");',
'  ["open", "resolved", "wontfix"].forEach(function (s) {',
'    var o = document.createElement("option"); o.value = s; o.textContent = s;',
'    if (a.status === s) o.selected = true; st.appendChild(o);',
'  });',
'  st.addEventListener("change", function () { a.status = st.value; renderAll(); });',
'  row.appendChild(stLabel); row.appendChild(st); ed.appendChild(row);',
'  var addRow = document.createElement("div"); addRow.className = "add-row";',
'  var ta = document.createElement("textarea"); ta.rows = 3; ta.value = draft;',
'  ta.addEventListener("input", function () { draft = ta.value; });',
'  ta.placeholder = "add comment as " + authorNow() + "\\u2026 (Ctrl+Enter)";',
'  var add = document.createElement("button"); add.className = "add-cmt"; add.textContent = "Add";',
'  var submit = function () {',
'    var v = ta.value.trim(); if (!v) return;',
'    draft = "";',
'    if (!a.note) { a.note = v; a.author = authorNow(); a.ts = a.ts || new Date().toISOString(); }',
'    else {',
'      if (!Array.isArray(a.comments)) a.comments = [];',
'      a.comments.push({ author: authorNow(), ts: new Date().toISOString(), text: v });',
'    }',
'    renderAll();',
'  };',
'  add.addEventListener("click", submit);',
'  ta.addEventListener("keydown", function (ev) {',
'    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(); }',
'  });',
'  addRow.appendChild(ta); addRow.appendChild(add); ed.appendChild(addRow);',
'}',
'function renderAll() { renderList(); renderEditor(); renderOverlay(); renderCaps(); }',
'function select(id) { sel = id; renderAll(); ensureVisible(id); }',
'function open(id) {',
'  tab = id; sel = null;',
'  var c = capById(id);',
'  $("no-snap").hidden = !!c;',
'  $("snap-wrap").hidden = !c;',
'  if (!c) { renderAll(); return; }',
'  $("snap-frame").srcdoc = c.dom;',
'  var natW = c.viewport.w, natH = c.viewport.h;',
'  $("snap-frame").style.width = natW + "px"; $("snap-frame").style.height = natH + "px";',
'  $("snap-scale").style.width = natW + "px"; $("snap-scale").style.height = natH + "px";',
'  $("snap-svg").setAttribute("viewBox", "0 0 " + natW + " " + natH);',
'  var avail = $("stage").clientWidth - 24;',
'  var dispW = Math.min(natW, Math.max(200, avail));',
'  scale = dispW / natW;',
'  $("snap-scale").style.transform = "scale(" + scale + ")";',
'  $("snap-wrap").style.width = dispW + "px";',
'  $("snap-wrap").style.height = Math.round(natH * scale) + "px";',
'  $("snap-svg").setAttribute("width", dispW);',
'  $("snap-svg").setAttribute("height", Math.round(natH * scale));',
'  renderAll();',
'}',
'$("x-save-app").addEventListener("click", function () {',
'  if (!appText) { toast("App file was not embedded in this export."); return; }',
'  var base = appText.replace(CAP_RE, "");',
'  var go = function (hash) {',
'    download(D.appName, splicedApp(hash));',
'    toast("Downloaded " + D.appName + " with your comments and status updates.");',
'  };',
'  if (window.crypto && crypto.subtle) {',
'    crypto.subtle.digest("SHA-256", new TextEncoder().encode(base)).then(',
'      function (buf) {',
'        var u8 = new Uint8Array(buf), hex = "";',
'        for (var i = 0; i < u8.length; i++) hex += ("0" + u8[i].toString(16)).slice(-2);',
'        go(hex);',
'      },',
'      function () { go(null); });',
'  } else go(null);',
'});',
'$("x-save-review").addEventListener("click", function () {',
'  D.seq = D.seq;',
'  var html = INITIAL_HTML.replace(',
'    /<script id="cr-export-data" type="application\\/json">[\\s\\S]*?<\\/script>/,',
'    \'<script id="cr-export-data" type="application/json">\' + jsonData() + \'<\\/script>\');',
'  download(D.appName.replace(/\\.html?$/i, "") + "-code-review.html", html);',
'  toast("Downloaded an updated copy of this review file.");',
'});',
'function installKeyNav() {',
'  var lastCol = null;',
'  document.addEventListener("focusin", function (e) {',
'    if (!e.target.closest) return;',
'    if (e.target.closest("#caps-list")) lastCol = "caps";',
'    else if (e.target.closest("#panel-list")) lastCol = "panel";',
'  });',
'  document.addEventListener("mousedown", function (e) {',
'    if (!e.target.closest) { lastCol = null; return; }',
'    if (e.target.closest("#caps-list")) lastCol = "caps";',
'    else if (e.target.closest("#panel-list")) lastCol = "panel";',
'    else lastCol = null;',
'  }, true);',
'  document.addEventListener("keydown", function (e) {',
'    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;',
'    var ae = document.activeElement;',
'    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;',
'    var lastCol = null;',
'    if (ae && ae.closest) {',
'      if (ae.closest("#caps-list")) lastCol = "caps";',
'      else if (ae.closest("#panel-list")) lastCol = "panel";',
'    }',
'    if (!lastCol) return;',
'    var list = $(lastCol === "caps" ? "caps-list" : "panel-list");',
'    var sel = lastCol === "caps" ? ".cap-item" : ".item";',
'    var items = Array.prototype.slice.call(list.querySelectorAll(sel));',
'    if (!items.length) return;',
'    var idx = items.indexOf(ae);',
'    var dir = e.key === "ArrowDown" ? 1 : -1;',
'    var t;',
'    if (idx >= 0) t = idx + dir;',
'    else {',
'      var cur = 0;',
'      items.forEach(function (n, k) { if (n.classList.contains(lastCol === "caps" ? "active" : "sel")) cur = k; });',
'      t = cur + dir;',
'    }',
'    if (t < 0 || t >= items.length) { e.preventDefault(); return; }',
'    e.preventDefault();',
'    var el = items[t];',
'    if (lastCol === "caps") open(el.getAttribute("data-cap-id"));',
'    else select(el.getAttribute("data-ann-id"));',
'    var ni = list.querySelectorAll(sel)[t];',
'    if (ni) ni.focus();',
'  });',
'}',
'if (D.captures.length) { installKeyNav(); open(D.captures[0].id); } else { $("no-snap").hidden = false; renderCaps(); }',
'var savedWho = "";',
'try { savedWho = localStorage.getItem("cr-export-reviewer") || ""; } catch (e5) { }',
'if (savedWho) { $("author-input").value = savedWho; }',
'else {',
'  $("who-modal").hidden = false;',
'  $("who-input").focus();',
'  var saveWho = function () {',
'    var v = $("who-input").value.trim() || "reviewer";',
'    try { localStorage.setItem("cr-export-reviewer", v); } catch (e6) { }',
'    $("author-input").value = v;',
'    $("who-modal").hidden = true;',
'  };',
'  $("who-go").addEventListener("click", saveWho);',
'  $("who-input").addEventListener("keydown", function (e7) { if (e7.key === "Enter") saveWho(); });',
'}',
'$("author-input").addEventListener("change", function () {',
'  try { localStorage.setItem("cr-export-reviewer", $("author-input").value.trim()); } catch (e8) { }',
'});'
].join('\n');

/* ================================================================ BOOT */

if (window.__CR_HOST__) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { Host.boot(); });
  else Host.boot();
}
