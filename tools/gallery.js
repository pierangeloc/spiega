#!/usr/bin/env node
/* ============================================================
   spiega gallery — the drawing vocabulary, for someone who has not
   installed anything yet.

   docs/shapes.md is the reference: one picture per kind, generated from the
   renderer so it cannot drift. The gallery is the same idea for a reader who
   is still deciding whether to read the reference. It is smaller and more
   opinionated — a handful of shapes rather than a catalogue, a line with a
   label rather than a table of fields.

   Every drawing here comes out of renderSVG, the same function the board calls.
   Nothing is screenshotted and nothing is traced by hand, so `node
   tools/gallery.js` after a change to a glyph is the update. The frames around
   the drawings (the rail, the title bar) are drawn here because they are board
   chrome, not renderer output — but their contents and their lit state come
   from the board's own state, not from a copy.

   Run `node tools/gallery.js`. It writes docs/gallery/*.svg and prints what it
   wrote.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import {
  PAPER, PANEL, INK, MUTED, RULE, SOFT, ACCENT, MONO,
} from '../src/render/theme.js';
import { text, wrapText } from '../src/render/ink.js';
import { boundaryBox } from '../src/render/layout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'gallery');
const FONT = MONO.replace(/"/g, "'");

/* One board, drawn by the renderer, cropped to what it actually inked. The
   renderer sizes a canvas for a live board, with room to breathe around it; a
   sheet of one shape on that canvas is mostly paper. The crop keeps the boxes,
   the routes between them, and any callout or boundary wall that reached past
   the boxes. */
function crop(r, pad, spec) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const b of Object.values(r.boxes)) { take(b.x, b.y); take(b.x + b.w, b.y + b.h + (b.labelBelow || 0)); }
  for (const e of r.planned) for (const [x, y] of e.pts || []) take(x, y);
  for (const c of r.callouts) { take(c.box.x, c.box.y); take(c.box.x + c.box.w, c.box.y + c.box.h); }
  // A boundary's wall and its tab sit outside the boxes it encloses.
  for (const b of spec.boundaries || []) {
    const bb = boundaryBox(b.members || [], r.boxes);
    if (bb) { take(bb.x, bb.y - 14); take(bb.x + bb.w, bb.y + bb.h); }
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: r.width, h: r.height };
  return {
    x: x0 + r.offset.x - pad, y: y0 + r.offset.y - pad,
    w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2,
  };
}

/* An op list becomes the inner markup of an SVG, plus the rectangle it
   occupies. The inner markup is reused when several boards are composed into
   one sheet. */
function render(ops, { active = undefined, margin = 14, pad = 40 } = {}) {
  const board = emptyBoard();
  const { errors } = applyOps(board, ops);
  if (errors.length) throw new Error(errors.join('; '));
  const r = renderSVG(board, { margin, active, hand: false });
  const inner = r.svg.slice(r.svg.indexOf('>') + 1, r.svg.lastIndexOf('</svg>'));
  return { board, r, inner, v: crop(r, pad, board) };
}

/* Place a rendered board inside a larger sheet. `v` is in the board's own
   coordinates, not the sheet's, so the translation has to subtract it too. */
function place(tile, x, y, scale = 1) {
  return `<g transform="translate(${(x - tile.v.x * scale).toFixed(2)} ${(y - tile.v.y * scale).toFixed(2)}) ` +
    `scale(${scale})">${tile.inner}</g>`;
}

function doc(w, h, body) {
  const W = Math.round(w), H = Math.round(h);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ` +
    `font-family="${FONT}">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${PAPER}" rx="6"/>` +
    body + `</svg>`;
}

/* A grid of tiles with the kind's name underneath. The captions are outside
   the drawing on purpose: the glyph carries its own label, and a second label
   inside the box would be the gallery explaining itself twice.

   Column widths come from the widest tile in that column, not from the widest
   on the sheet. A cloud is broader than a queue; making every cell the width of
   the cloud wastes a lane of paper on every row. */
function sheet(tiles, { cols = 4, gap = 24, scale = 1, captionH = 28, padX = 24, padY = 20 } = {}) {
  const rows = Math.ceil(tiles.length / cols);
  const colW = Array.from({ length: cols }, (_, c) =>
    Math.max(0, ...tiles.filter((_, i) => i % cols === c).map(t => t.v.w * scale)));
  const rowH = Array.from({ length: rows }, (_, r) =>
    Math.max(...tiles.slice(r * cols, (r + 1) * cols).map(t => t.v.h * scale)));
  const sum = a => a.reduce((t, v) => t + v, 0);
  const W = padX * 2 + sum(colW) + (cols - 1) * gap;
  const H = padY * 2 + sum(rowH) + rows * captionH + (rows - 1) * gap;

  let body = '';
  tiles.forEach((t, i) => {
    const c = i % cols, row = Math.floor(i / cols);
    const x = padX + sum(colW.slice(0, c)) + c * gap;
    const y = padY + sum(rowH.slice(0, row)) + row * (gap + captionH);
    const tw = t.v.w * scale, th = t.v.h * scale;
    body += place(t, x + (colW[c] - tw) / 2, y + (rowH[row] - th) / 2, scale);
    if (t.caption) {
      body += text(x + colW[c] / 2, y + rowH[row] + 18, t.caption, {
        size: 11.5, color: MUTED, weight: 700, anchor: 'middle', spacing: 0.08, family: FONT,
      });
    }
  });
  return doc(W, H, body);
}

/* ---------- the pieces ---------- */

const KIND_GROUPS = [
  {
    cols: 3,
    kinds: [
      ['client', 'Browser'],
      ['gateway', 'API Gateway', { sub: 'authn' }],
      ['service', 'Orders', { sub: 'Kotlin' }],
      ['compute', 'Workers', { replicas: 3 }],
      ['datastore', 'Postgres'],
      ['cache', 'Redis'],
      ['queue', 'orders.created', { depth: 3 }],
      ['external', 'Stripe'],
    ],
  },
  {
    cols: 2,
    kinds: [
      ['note', 'at most once\nper tenant'],
      ['formula', '\\nabla \\times \\vec{E} = -\\frac{\\partial \\vec{B}}{\\partial t}'],
    ],
  },
  {
    cols: 2,
    kinds: [
      ['blob', 'Chloroplast', { sub: 'organelle' }],
      ['vessel', 'Water', { sub: 'H2O' }],
      ['particle', 'CO2', { sub: 'gas' }],
      ['source', 'Sun', { sub: 'light' }],
    ],
  },
];

function kindsSheet(group) {
  const tiles = group.kinds.map(([kind, label, extra = {}]) => ({
    ...render([{ op: 'node', id: kind, kind, label, ...extra }]),
    caption: kind,
  }));
  return sheet(tiles, { cols: group.cols });
}

/* Four ways for an arrow to say something, each on its own pair of boxes. They
   are split across two sheets because four pairs side by side is a wide, thin
   strip: at README width the labels would be the smallest thing on the page.
   The last one is a flow step — the number and the label travel as one tag, and
   the lit hop is the accent colour. */
function edgesBasic() {
  const pair = (extra = {}) => [
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'node', id: 'postgres', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'orders', to: 'postgres', ...extra },
  ];
  const tiles = [
    { ...render(pair()), caption: 'plain' },
    { ...render(pair({ label: 'SQL' })), caption: 'labelled' },
  ];
  return sheet(tiles, { cols: 1, gap: 26, padX: 24, padY: 22 });
}

function edgesAsync() {
  const tiles = [
    { ...render([
      { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
      { op: 'node', id: 'events', kind: 'queue', label: 'events' },
      { op: 'edge', from: 'orders', to: 'events', label: 'publish', async: true },
    ]), caption: 'async' },
    { ...render([
      { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
      { op: 'node', id: 'postgres', kind: 'datastore', label: 'Postgres' },
      { op: 'edge', from: 'orders', to: 'postgres', label: 'SQL' },
      { op: 'flow', steps: [{ edge: 'orders>postgres', step: 'Write the order row' }] },
      { op: 'focus', step: 0 },
    ], { active: 0 }), caption: 'numbered step' },
  ];
  return sheet(tiles, { cols: 1, gap: 26, padX: 24, padY: 22 });
}

function boundarySheet() {
  const t = render([
    { op: 'node', id: 'gateway', kind: 'gateway', label: 'API Gateway' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'node', id: 'db', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'gateway', to: 'orders', label: 'gRPC' },
    { op: 'edge', from: 'orders', to: 'db', label: 'INSERT' },
    { op: 'boundary', id: 'vpc', label: 'private subnet', members: ['orders', 'db'] },
  ]);
  return doc(t.v.w, t.v.h, place(t, 0, 0));
}

function calloutSheet() {
  const t = render([
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'node', id: 'stripe', kind: 'external', label: 'Stripe' },
    { op: 'edge', from: 'orders', to: 'stripe', label: 'charge' },
    { op: 'callout', id: 'retry', at: 'orders>stripe', label: 'retried 3 times, then dead-lettered' },
  ]);
  return doc(t.v.w, t.v.h, place(t, 0, 0));
}

/* A note is not a box in the flow: it goes in a margin column of its own.
   Showing it beside the path is the point — it is an aside, and it never dims
   when a step is walked. */
function noteSheet() {
  const t = render([
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'node', id: 'db', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'orders', to: 'db', label: 'INSERT' },
    { op: 'note', id: 'once', label: 'at most once\nper tenant' },
  ]);
  return doc(t.v.w, t.v.h, place(t, 0, 0));
}

/* The title is board chrome: `title` sets the name in the bar above the
   drawing, and the bar is not part of renderSVG. So the drawing is real and the
   strip is drawn to match board.html — the one place the gallery mimics rather
   than renders. */
function titleSheet() {
  const t = render([
    { op: 'title', text: 'Placing an order' },
    { op: 'node', id: 'gw', kind: 'gateway', label: 'API Gateway' },
    { op: 'node', id: 'db', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'gw', to: 'db', label: 'SQL' },
  ]);
  const bar = 52;
  const W = Math.max(t.v.w + 40, 500);
  const H = bar + 18 + t.v.h + 22;
  let body = `<line x1="0" y1="${bar}" x2="${W}" y2="${bar}" stroke="${RULE}" stroke-width="1"/>`;
  body += `<circle cx="22" cy="${bar / 2}" r="4.5" fill="${ACCENT}"/>`;
  body += text(40, bar / 2 + 5, t.board.title, {
    size: 14, color: INK, weight: 700, anchor: 'start', spacing: 0.04, upper: true, family: FONT,
  });
  body += text(W - 20, bar / 2 + 4,
    `${t.board.nodes.length} box${t.board.nodes.length === 1 ? '' : 'es'} · ` +
    `${t.board.edges.length} line${t.board.edges.length === 1 ? '' : 's'}`, {
      size: 11, color: MUTED, weight: 400, anchor: 'end', spacing: 0.06, family: FONT,
    });
  body += place(t, (W - t.v.w) / 2, bar + 18);
  return doc(W, H, body);
}

/* The flow, with its rail. The board half is the renderer's own lit step —
   accent line, halos, numbered tags on every hop. The rail half is the same
   numbered steps as a list, because reading down them is how you decide which
   one to press. Both are built from the board's flow, so the numbers agree. */
function flowSheet() {
  const ops = [
    { op: 'node', id: 'gateway', kind: 'gateway', label: 'API Gateway', sub: 'authn' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'node', id: 'cache', kind: 'cache', label: 'Redis' },
    { op: 'node', id: 'db', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'gateway', to: 'orders', label: 'gRPC' },
    { op: 'edge', from: 'orders', to: 'cache', label: 'SETNX' },
    { op: 'edge', from: 'orders', to: 'db', label: 'INSERT' },
    { op: 'flow', steps: [
      { edge: 'gateway>orders', step: 'Authenticate, then forward' },
      { edge: 'orders>cache', step: 'Claim the idempotency key' },
      { edge: 'orders>db', step: 'Write the order row' },
    ] },
  ];
  const active = 0;                       // the first hop, so the lit line is the plain one
  const t = render(ops, { active, margin: 18, pad: 40 });

  const railW = 260, gap = 30, pad = 24;
  const stepH = 48, stepGap = 9, headH = 26, railPadY = 8;
  const railH = headH + railPadY * 2 + t.board.flow.length * stepH +
    (t.board.flow.length - 1) * stepGap;

  const maxDrawW = 600, maxDrawH = 330;
  const scale = Math.min(1, maxDrawW / t.v.w, maxDrawH / t.v.h);
  const drawW = t.v.w * scale, drawH = t.v.h * scale;

  const W = pad * 2 + railW + gap + drawW;
  const H = pad * 2 + Math.max(railH, drawH);

  let body = '';
  // the rail is a column of cards; the rule is the live board's own divider
  body += `<line x1="${pad + railW + gap / 2}" y1="${pad}" x2="${pad + railW + gap / 2}" ` +
    `y2="${H - pad}" stroke="${RULE}" stroke-width="1"/>`;
  body += text(pad, pad + 12, 'THE FLOW', {
    size: 10, color: MUTED, weight: 700, anchor: 'start', spacing: 0.14, family: FONT,
  });
  body += text(pad + railW, pad + 12, `${active + 1}/${t.board.flow.length}`, {
    size: 10, color: MUTED, weight: 700, anchor: 'end', spacing: 0.1, family: FONT,
  });

  t.board.flow.forEach((s, i) => {
    const y = pad + headH + railPadY + i * (stepH + stepGap);
    const on = i === active;
    const border = on ? ACCENT : INK;
    body += `<rect x="${pad + 3}" y="${y + 3}" width="${railW - 6}" height="${stepH}" rx="12" ` +
      `fill="${on ? ACCENT : SOFT}"/>`;
    body += `<rect x="${pad}" y="${y}" width="${railW - 6}" height="${stepH}" rx="12" ` +
      `fill="${PANEL}" stroke="${border}" stroke-width="1.5"/>`;
    body += `<circle cx="${pad + 22}" cy="${y + stepH / 2}" r="9.5" ` +
      `fill="${on ? ACCENT : PANEL}" stroke="${border}" stroke-width="1.4"/>`;
    body += text(pad + 22, y + stepH / 2 + 3.5, String(i + 1), {
      size: 11, color: on ? PAPER : INK, weight: 700, anchor: 'middle', spacing: 0.02, family: FONT,
    });
    const lines = wrapText(s.step || s.edge || '', 27, 2);
    const lh = 16;
    const top = y + stepH / 2 - (lines.length - 1) * lh / 2 + 4.5;
    lines.forEach((ln, k) => {
      body += text(pad + 40, top + k * lh, ln, {
        size: 13, color: INK, weight: 600, anchor: 'start', spacing: 0.01, family: FONT,
      });
    });
  });

  body += place(t, W - pad - drawW, pad + (Math.max(railH, drawH) - drawH) / 2, scale);
  return doc(W, H, body);
}

/* ---------- write them out ---------- */

const SHEETS = [
  ['kinds-software', () => kindsSheet(KIND_GROUPS[0])],
  ['kinds-writing', () => kindsSheet(KIND_GROUPS[1])],
  ['kinds-neutral', () => kindsSheet(KIND_GROUPS[2])],
  ['edges', edgesBasic],
  ['edges-async', edgesAsync],
  ['flow', flowSheet],
  ['boundary', boundarySheet],
  ['callout', calloutSheet],
  ['note', noteSheet],
  ['title', titleSheet],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, build] of SHEETS) {
  const file = path.join(OUT, `${name}.svg`);
  fs.writeFileSync(file, build());
  console.log(`  ${path.relative(ROOT, file)}`);
}
console.log(`\n${SHEETS.length} gallery sheets`);
