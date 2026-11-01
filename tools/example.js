#!/usr/bin/env node
/* ============================================================
   spiega example — a worked example, rendered to a picture.

   The why is the same as tools/shapes.js: an example in a document has to be
   the renderer's output, not a screenshot of it. A hand-drawn board that was
   photographed goes stale the first time a glyph moves, and nobody notices
   because nothing fails. This runs the same renderSVG the board runs, so
   running it again after a change to the drawing *is* the update.

   Run: node tools/example.js examples/blood-clot.json docs/examples/blood-clot.svg
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { specToOps, measure } from '../src/spec.js';
import { renderSVG } from '../src/render/render.js';
import { boundaryBox } from '../src/render/layout.js';
import { PAPER, MONO } from '../src/render/theme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The board page paints its own paper; a file does not, and a transparent SVG
   dropped into a dark-mode README is ink on ink. Cropped to what was actually
   drawn, with one margin's worth of air around it, so the picture is the board
   rather than a board-shaped field of paper. */
function crop(spec, r, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const b of Object.values(r.boxes)) { take(b.x, b.y); take(b.x + b.w, b.y + b.h); }
  for (const e of r.planned) for (const [x, y] of e.pts || []) take(x, y);
  for (const c of r.callouts) { take(c.box.x, c.box.y); take(c.box.x + c.box.w, c.box.y + c.box.h); }
  /* A boundary's name rides a tab that stands 11px above its dashed wall, and
     the wall itself stands 26px outside its members — further out than the
     boxes this crop started from. Without the tab the enclosure is cropped
     mid-label, and an unnamed dashed box is worse than no enclosure at all. */
  for (const b of spec.boundaries || []) {
    const bb = boundaryBox(b.members || [], r.boxes);
    if (!bb) continue;
    take(bb.x, bb.y - 11); take(bb.x + bb.w, bb.y + bb.h);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: r.width, h: r.height };
  return {
    x: x0 + r.offset.x - pad, y: y0 + r.offset.y - pad,
    w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2,
  };
}

function sheet(spec) {
  const board = emptyBoard();
  const { errors } = applyOps(board, specToOps(spec));
  if (errors.length) throw new Error(errors.join('; '));
  const r = renderSVG(board, { margin: 16, hand: true });
  /* Generous padding: a boundary's dashed wall and its label sit outside its
     members, and the loop that closes a cycle is routed below every box. */
  const v = crop(spec, r, 30);
  /* The renderer leaves the font to the page, because on a live board the page
     supplies it. A file does not have a page: an SVG embedded with <img> is an
     isolated document that inherits nothing, so without this the whole drawing
     falls back to the browser's default serif and stops looking hand-written.
     tools/gallery.js has always set it; this did not, and both worked examples
     shipped in Times. */
  return r.svg
    .replace(/viewBox="[^"]*" width="[^"]*" height="[^"]*"/,
      `viewBox="${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}" ` +
      `width="${Math.round(v.w)}" height="${Math.round(v.h)}" ` +
      `font-family="${MONO.replace(/"/g, "'")}"`)
    .replace(/(<svg[^>]*>)/, `$1<rect x="${v.x.toFixed(1)}" y="${v.y.toFixed(1)}" ` +
      `width="${v.w.toFixed(1)}" height="${v.h.toFixed(1)}" fill="${PAPER}" rx="6"/>`);
}

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/example.js <spec.json> [out.svg]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(input, 'utf8'));
const out = output || path.join('docs', 'examples', path.basename(input).replace(/\.json$/, '.svg'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const svg = sheet(spec);
fs.writeFileSync(out, svg);

/* How wide the picture came out is not a detail: a board is usually read at
   whatever width its container gives it, so a board that is 6:1 has labels
   nobody can read however good the drawing is. Print it, and the shape of the
   problem is visible without opening the file. */
const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
const { parts, ops, asFile } = measure(spec);
const tally = Object.entries(parts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ');
console.log(path.relative(ROOT, out));
console.log(`  ${w} × ${h}  (${(Number(w) / Number(h)).toFixed(2)}:1)`);
console.log(`  ${tally}\n  ${ops} ops drawn one at a time · ${asFile} ops as this one file`);
