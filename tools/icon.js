#!/usr/bin/env node
/* ============================================================
   spiega icon — a preview harness for the mark. UNFINISHED; see issue #2.

   Run `node tools/icon.js` and open the file it prints: the draft rendered at
   16, 24, 32, 48, 64 and 160px side by side. Legibility at 16px is the whole
   problem, so judging a mark at one size is how you end up with a logo that
   dissolves in a browser tab.

   The intended mark is the pinched-fingers gesture — the hand Italians explain
   with, which is also what this project is named after: a wave of the hand
   that leaves a diagram behind.

   WHAT IS SETTLED, from several rejected attempts:

   - The fingers must be SEPARATE shapes with background visible between them
     near the tips. A single closed outline with bumps along the top cannot
     produce that gap, and without it the mark reads as a leaf, a flame or a
     mitten, depending on how smooth the bumps are. All three were tried.
   - The tips must gather into roughly eight units of a hundred while the bases
     fan wide. That cone is what says "pinch"; parallel fingers read as a
     raised hand.
   - A thumb coming up underneath, and a wrist narrower than the hand running
     off the bottom edge, are needed for it to read as a hand at all.

   WHAT IS NOT SOLVED: the draft below has the right structure and still reads
   as a brush or a bundle. A hand is a shape where being a few percent off
   becomes a different object, and these coordinates were invented rather than
   traced. The next attempt should start from a real outline — Noto Emoji
   (Apache-2.0) or Twemoji (CC-BY-4.0) — simplified and then restyled with the
   wobble and the flat three-band fill, rather than guessing again.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { roughPoly, stroke, fill } from '../src/render/ink.js';
import { PAPER, MUTED, MONO, BODIES } from '../src/render/theme.js';

/* A finger: wide at the knuckle, narrow at the tip. */
function finger(bx, by, tx, ty, bw, tw) {
  const a = Math.atan2(ty - by, tx - bx) + Math.PI / 2;
  const nx = Math.cos(a), ny = Math.sin(a);
  return [[bx - nx * bw, by - ny * bw], [tx - nx * tw, ty - ny * tw],
          [tx + nx * tw, ty + ny * tw], [bx + nx * bw, by + ny * bw]];
}

export function draft(m = BODIES.mustard, seed = 7) {
  const palm = roughPoly([[38, 62], [62, 62], [64, 80], [61, 100], [39, 100], [36, 80]],
    { seed: seed + 1, amp: 0.8, step: 15 });
  let out = fill(palm, m.m) + stroke(palm, { w: 3.2 });

  const tips = [[52, 17], [49, 13], [46, 13], [43, 17]];
  const bases = [[63, 64], [55, 66], [45, 66], [37, 64]];
  tips.forEach(([tx, ty], i) => {
    const [bx, by] = bases[i];
    const d = roughPoly(finger(bx, by, tx, ty, 4.4, 2.3), { seed: seed + 20 + i, amp: 0.55, step: 12 });
    out += fill(d, m.l) + stroke(d, { w: 2.9 });
  });
  const th = roughPoly(finger(28, 84, 41, 26, 5.6, 2.8), { seed: seed + 30, amp: 0.6, step: 12 });
  return out + fill(th, m.l) + stroke(th, { w: 2.9 });
}

export const svg = (inner, size = 100) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
  `<rect width="100" height="100" fill="${PAPER}"/>${inner}</svg>`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const inner = draft();
  const sizes = [16, 24, 32, 48, 64, 160];
  const out = path.join(os.tmpdir(), 'spiega-icon.html');
  fs.writeFileSync(out, `<!doctype html><meta charset=utf-8>` +
    `<style>body{margin:0;background:${PAPER};font:12px ${MONO};padding:26px}` +
    `td{text-align:center;vertical-align:bottom;padding:0 14px}.s{color:${MUTED};font-size:10px;margin-top:6px}</style>` +
    `<table><tr>` + sizes.map(s =>
      `<td><div style="width:${s}px;height:${s}px;display:inline-block">${svg(inner, s)}</div><div class=s>${s}px</div></td>`
    ).join('') + `</tr></table>`);
  console.log(out);
}
