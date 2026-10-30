#!/usr/bin/env node
/* ============================================================
   spiega shapes — the drawn catalogue, regenerated from the renderer.

   `docs/vocabulary.md` says in words what each kind is drawn as ("a cylinder,
   lighter", "a row of slots"). Words are the wrong medium for that: the whole
   point of a kind is what it looks like, and a reader choosing between
   `cache` and `datastore` wants to see the difference, not read about it.

   So the gallery is generated, never drawn by hand and never screenshotted.
   A screenshot would be a second copy of the truth, stale the first time
   anyone changes a glyph; these come out of the same renderSVG the board
   uses, so `npm run shapes` after a change to the drawing *is* the update.

   Run `node tools/shapes.js`. It writes docs/shapes/*.svg and prints what it
   wrote. The gallery page docs/shapes.md embeds them.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import { PAPER } from '../src/render/theme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'shapes');

/* One sample per thing worth seeing. Each is the op list an agent would send,
   so the page doubles as a set of worked examples — the picture and the JSON
   that produced it are the same source. */
const SAMPLES = [
  // the kinds
  ['client', [{ op: 'node', id: 'c', kind: 'client', label: 'Browser' }]],
  ['gateway', [{ op: 'node', id: 'g', kind: 'gateway', label: 'API Gateway', sub: 'authn' }]],
  ['service', [{ op: 'node', id: 's', kind: 'service', label: 'Orders', sub: 'Kotlin' }]],
  ['compute', [{ op: 'node', id: 'w', kind: 'compute', label: 'Workers', replicas: 3 }]],
  ['datastore', [{ op: 'node', id: 'd', kind: 'datastore', label: 'Postgres' }]],
  ['cache', [{ op: 'node', id: 'k', kind: 'cache', label: 'Redis' }]],
  ['queue', [{ op: 'node', id: 'q', kind: 'queue', label: 'orders.created', depth: 3 }]],
  ['external', [{ op: 'node', id: 'x', kind: 'external', label: 'Stripe' }]],
  ['note', [{ op: 'node', id: 'n', kind: 'note', label: 'at most once\nper tenant' }]],
  ['formula', [{ op: 'node', id: 'f', kind: 'formula', label: '\\nabla \\times E = -\\frac{\\partial B}{\\partial t}' }]],

  // the neutral kinds, shown on a figure that is not about software at all
  ['blob', [{ op: 'node', id: 'b', kind: 'blob', label: 'Chloroplast', sub: 'organelle' }]],
  ['vessel', [{ op: 'node', id: 'v', kind: 'vessel', label: 'Water', sub: 'H2O' }]],
  ['particle', [{ op: 'node', id: 'p', kind: 'particle', label: 'CO2', sub: 'gas' }]],
  ['source', [{ op: 'node', id: 's', kind: 'source', label: 'Sun', sub: 'light' }]],

  // the things between and around them
  ['edge', [
    { op: 'node', id: 'orders', label: 'Orders' },
    { op: 'node', id: 'postgres', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'orders', to: 'postgres', label: 'SQL' },
  ]],
  ['edge-async', [
    { op: 'node', id: 'orders', label: 'Orders' },
    { op: 'node', id: 'events', kind: 'queue', label: 'events' },
    { op: 'edge', from: 'orders', to: 'events', label: 'publish', async: true },
  ]],
  ['loop', [
    { op: 'node', id: 'sampler', label: 'Sampler' },
    { op: 'node', id: 'filter', label: 'Filter' },
    { op: 'edge', from: 'sampler', to: 'filter', label: 'x[n]' },
    { op: 'edge', from: 'filter', to: 'sampler', label: 'feedback' },
  ]],
  ['boundary', [
    { op: 'node', id: 'orders', label: 'Orders' },
    { op: 'node', id: 'postgres', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'orders', to: 'postgres' },
    { op: 'boundary', id: 'vpc', label: 'private subnet', members: ['orders', 'postgres'] },
  ]],
  ['callout', [
    { op: 'node', id: 'orders', label: 'Orders' },
    { op: 'node', id: 'stripe', kind: 'external', label: 'Stripe' },
    { op: 'edge', from: 'orders', to: 'stripe', label: 'charge' },
    { op: 'callout', id: 'c1', at: 'orders>stripe', label: 'retried 3×, then dead-lettered' },
  ]],
  // what a step does: one hop lit, the rest dimmed
  ['step', [
    { op: 'node', id: 'browser', kind: 'client', label: 'Browser' },
    { op: 'node', id: 'gateway', kind: 'gateway', label: 'Gateway' },
    { op: 'node', id: 'postgres', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'browser', to: 'gateway', label: 'HTTP' },
    { op: 'edge', from: 'gateway', to: 'postgres', label: 'SQL' },
    { op: 'flow', steps: [{ edge: 'browser>gateway' }, { edge: 'gateway>postgres' }] },
    { op: 'focus', step: 1 },
  ]],
];

/* The board page paints its own paper; a file does not, and a transparent SVG
   dropped into a dark-mode README is ink on ink. So each sample carries its
   background with it. */
/* The board sizes its canvas for a board — room to breathe around a system.
   A sample of one box on that canvas is mostly paper, so each sheet is
   cropped to what it actually drew: the boxes, the routes between them, and
   any callout, with one margin's worth of air around the lot. */
function crop(r, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const b of Object.values(r.boxes)) { take(b.x, b.y); take(b.x + b.w, b.y + b.h); }
  for (const e of r.planned) for (const [x, y] of e.pts || []) take(x, y);
  for (const c of r.callouts) { take(c.box.x, c.box.y); take(c.box.x + c.box.w, c.box.y + c.box.h); }
  if (x0 === Infinity) return { x: 0, y: 0, w: r.width, h: r.height };
  return {
    x: x0 + r.offset.x - pad, y: y0 + r.offset.y - pad,
    w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2,
  };
}

function sheet(ops) {
  const board = emptyBoard();
  const { errors } = applyOps(board, ops);
  if (errors.length) throw new Error(errors.join('; '));
  const r = renderSVG(board, { margin: 14, hand: false });
  /* Generous padding, because some ink is not in any box the renderer hands
     back: a boundary's dashed wall and its label sit outside its members, and
     a lit step draws a halo around each box it lights. */
  const v = crop(r, 36);
  return r.svg
    .replace(/viewBox="[^"]*" width="[^"]*" height="[^"]*"/,
      `viewBox="${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}" ` +
      `width="${Math.round(v.w)}" height="${Math.round(v.h)}"`)
    /* The board page paints its own paper; a file does not, and a transparent
       SVG dropped into a dark-mode README is ink on ink. */
    .replace(/(<svg[^>]*>)/, `$1<rect x="${v.x.toFixed(1)}" y="${v.y.toFixed(1)}" ` +
      `width="${v.w.toFixed(1)}" height="${v.h.toFixed(1)}" fill="${PAPER}" rx="6"/>`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, ops] of SAMPLES) {
  const file = path.join(OUT, `${name}.svg`);
  fs.writeFileSync(file, sheet(ops));
  console.log(`  ${path.relative(ROOT, file)}`);
}
console.log(`\n${SAMPLES.length} shapes`);
