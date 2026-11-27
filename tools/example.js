#!/usr/bin/env node
/* ============================================================
   spiega example — a worked example, rendered to a picture.

   The why is the same as tools/shapes.js: an example in a document has to be
   the renderer's output, not a screenshot of it. A hand-drawn board that was
   photographed goes stale the first time a glyph moves, and nobody notices
   because nothing fails. This runs the same renderSVG the board runs, so
   running it again after a change to the drawing *is* the update.

   Run: node tools/example.js examples/kalman.json docs/examples/kalman.svg
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { specToOps, measure } from '../src/spec.js';
import { renderSVG } from '../src/render/render.js';
import { boardMap, linkLabel } from '../src/board/map.js';
import { linkInk, placeMapLabels, sameRow } from '../src/board/map-links.js';
import { roughRect, stroke, text } from '../src/render/ink.js';
import { boundaryBox } from '../src/render/layout.js';
import { PAPER, PANEL, INK, MUTED, RULE, MONO } from '../src/render/theme.js';

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
  /* An arrow's hops stacked off its line (#213) stand a staircase clear of
     the route, where nothing above has reached, and would be cropped away. */
  for (const t of r.tags.values()) if (t.tick) { take(t.at[0] - t.w / 2, t.at[1] - t.h / 2); take(t.at[0] + t.w / 2, t.at[1] + t.h / 2); }
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

/* The map is laid out by the page, from the cards' own boxes, so there is no
   board to render: a spec with a `map` key is a strip of chapters, wrapped at
   `width` the way the page wraps it, and each link is inked by the same
   `linkInk` the page calls. A card is drawn as a titled box only; its
   thumbnail is not what the links are about. */
function mapSheet(spec) {
  const { width, card: [cw, ch], gap: [gx, gy], chapters } = spec.map;
  const board = emptyBoard();
  const ops = chapters.flatMap(c => [
    { op: 'chapter', title: c.title },
    ...c.nodes.map(label => ({ op: 'node', id: label, label })),
  ]);
  const { errors } = applyOps(board, ops);
  if (errors.length) throw new Error(errors.join('; '));
  const perRow = Math.max(1, Math.floor((width + gx) / (cw + gx)));
  const rows = Math.ceil(chapters.length / perRow);
  const rect = chapters.map((c, i) => ({
    x: (i % perRow) * (cw + gx), y: Math.floor(i / perRow) * (ch + gy) + 60, w: cw, h: c.h ?? ch,
  }));
  const pad = 30, height = rows * (ch + gy) + 60;
  let body = '';
  rect.forEach((r, i) => {
    body += stroke(roughRect(r.x, r.y, r.w, r.h, 8, { seed: i + 1 }), { w: 1.4 }) +
      text(r.x + 12, r.y + 24, `${i + 1}  ${chapters[i].title}`, { size: 13, anchor: 'start' }) +
      text(r.x + 12, r.y + 46, chapters[i].nodes.join(', '), { size: 11, weight: 400, anchor: 'start' });
  });
  const labels = [];
  for (const link of boardMap(board).links) {
    const a = rect[link.from - 1], b = rect[link.to - 1];
    const ink = linkInk(a, b, link);
    body += ink.d;
    const next = link.to === link.from + 1;
    const limit = next && sameRow(a, b) ? Math.max(24, Math.min(84, b.x - a.x - a.w - 4)) : next ? 84 : 200;
    const narrow = limit < 60, padding = narrow ? 7 : 14, charWidth = narrow ? 5.4 : 5.6;
    const max = Math.max(1, Math.floor((limit - padding) / charWidth));
    // A word wider than a same-row gutter keeps its spelling and moves out of
    // the gutter, just as the page's min-content pill does.
    let lines;
    if (next && sameRow(a, b)) {
      lines = [];
      for (const word of linkLabel(link).match(/\S+/g) || []) {
        const last = lines.length - 1;
        if (!narrow && last >= 0 && lines[last].length + 1 + word.length <= max) lines[last] += ` ${word}`;
        else lines.push(word);
      }
    } else {
      lines = (linkLabel(link).match(new RegExp(`.{1,${max}}(?:\\s|$)|.{1,${max}}`, 'g')) || [''])
        .map(s => s.trim()).filter(Boolean);
    }
    if (!lines.length) lines.push('');
    const w = Math.max(...lines.map(s => s.length)) * charWidth + padding, h = lines.length * 11.7 + 6;
    const mid = narrow ? [ink.mid[0], ink.mid[1] - h / 2 - 5] : ink.mid;
    labels.push({ mid, w, h, lines, narrow, shared: link.shared.length > 0 });
  }
  const positions = placeMapLabels(labels, rect);
  labels.forEach((label, i) => {
    const r = positions[i], color = label.shared ? INK : MUTED;
    body += `<rect class="maplabel" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="9" ` +
      `fill="${label.shared ? PANEL : PAPER}" stroke="${label.shared ? INK : RULE}" stroke-width="1.25"` +
      `${label.shared ? '' : ' stroke-dasharray="3 3"'}/>`;
    label.lines.forEach((line, j) => {
      body += text(r.x + r.w / 2, r.y + 12 + j * 11.7, line, { size: 9, color, weight: 400, spacing: label.narrow ? 0 : 0.02 });
    });
  });
  const w = Math.max(width + pad + 110, ...positions.map(r => r.x + r.w + pad)) + pad;
  const h = Math.max(height + pad, ...positions.map(r => r.y + r.h + pad)) + pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="${MONO.replace(/"/g, "'")}"><rect x="${-pad}" y="${-pad}" width="${w}" height="${h}" fill="${PAPER}" rx="6"/>${body}</svg>`;
}

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/example.js <spec.json> [out.svg]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(input, 'utf8'));
const out = output || path.join('docs', 'examples', path.basename(input).replace(/\.json$/, '.svg'));
fs.mkdirSync(path.dirname(out), { recursive: true });
const svg = spec.map ? mapSheet(spec) : sheet(spec);
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
