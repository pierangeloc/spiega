#!/usr/bin/env node
/* ============================================================
   spiega compare — the model's answer and the board, in one picture.

   The README makes a claim that is hard to feel from a word count: the same
   explanation arrives either as several hundred words you read in order, or as
   a board you take in at once. Printing "452 words" under a drawing does not
   show that. Setting the words beside the drawing, at the size they are
   actually read, does.

   The words are not retyped here. They are lifted out of README.md between the
   markers that already wrap them, so the picture is made of the very paragraphs
   printed above it and the count underneath is a count of those paragraphs. The
   board is rendered by the renderer the board itself uses. Neither half can
   drift from what the reader was shown.

   Run: node tools/compare.js webhook
        node tools/compare.js clot
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAPER, PANEL, INK, MUTED, RULE, ACCENT, MONO } from '../src/render/theme.js';
import { esc } from '../src/render/ink.js';
import { measure } from '../src/spec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = MONO.replace(/"/g, "'");

const CASES = {
  webhook: { spec: 'examples/webhook-retry.json', marker: 'webhook',
             out: 'docs/examples/webhook-retry-compare.svg',
             says: 'what the model says', draws: 'what it draws' },
  kalman:  { spec: 'examples/kalman.json', marker: 'kalman',
             out: 'docs/examples/kalman-compare.svg',
             says: 'what the model says', draws: 'what it draws' },
};

/* The prose, as published. One source: the README block the reader just read.
   A mismatch here means the markers moved, and the right answer is to fail
   rather than to quietly draw an empty column. */
function proseFromReadme(marker) {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const open = `<!-- prose:${marker}:start -->`;
  const close = `<!-- prose:${marker}:end -->`;
  const a = md.indexOf(open);
  const b = md.indexOf(close);
  if (a < 0 || b < 0) throw new Error(`README.md has no ${open} … ${close} block`);
  /* The block is printed as a blockquote, so the reader can see where the
     model's answer starts and stops rather than reading it as this document's
     own voice. The quote marker is markdown for the page, not part of what the
     model said, so it comes off before anything is counted or drawn. */
  return md.slice(a + open.length, b)
    .split('\n').map(l => l.replace(/^>\s?/, '')).join('\n').trim();
}

/* Markdown emphasis is for the README's renderer, not for a drawing. Stripped
   so the column shows the sentences rather than the asterisks around them. */
const plain = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1')
  .replace(/`(.+?)`/g, '$1');

const words = s => plain(s).split(/\s+/).filter(Boolean).length;

/* A monospace column wraps by character count, which is exact rather than
   estimated — the whole reason this sets the words in a mono face. */
function wrap(para, cols) {
  const out = [];
  let line = '';
  for (const w of para.split(/\s+/)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= cols) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

function proseColumn(prose, { x, y, w, size, lead }) {
  const cols = Math.floor(w / (size * 0.6));
  const lines = [];
  for (const para of plain(prose).split(/\n\s*\n/)) {
    if (lines.length) lines.push('');
    for (const l of wrap(para.replace(/\s*\n\s*/g, ' ').trim(), cols)) lines.push(l);
  }
  const body = lines.map((l, i) => l &&
    `<text x="${x}" y="${(y + i * lead).toFixed(1)}" font-family="${FONT}" font-size="${size}" ` +
    `fill="${INK}" opacity="0.88" xml:space="preserve">${esc(l)}</text>`).join('');
  return { body, height: lines.length * lead, lines: lines.length };
}

/* The board, taken from the file the README links, scaled to the width it is
   given here. Reading the committed SVG rather than re-rendering keeps this
   tool honest: the picture in the comparison is byte-for-byte the picture the
   reader can open full size. */
function boardAt(file, x, y, w) {
  const svg = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = svg.match(/viewBox="([^"]+)"[^>]*width="(\d+)" height="(\d+)"/);
  if (!m) throw new Error(`${file} has no viewBox I can read`);
  const [, viewBox, bw, bh] = m;
  const h = (Number(bh) / Number(bw)) * w;
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return {
    body: `<svg x="${x}" y="${y.toFixed(1)}" width="${w}" height="${h.toFixed(1)}" ` +
          `viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`,
    height: h, natural: `${bw} × ${bh}`,
  };
}

function label(x, y, s, { size = 13, fill = MUTED, anchor = 'start', weight = 600 } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ` +
    `fill="${fill}" text-anchor="${anchor}" letter-spacing="0.08em">${esc(s)}</text>`;
}

function build(which) {
  const c = CASES[which];
  if (!c) throw new Error(`no such comparison: ${which}`);
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, c.spec), 'utf8'));
  const prose = proseFromReadme(c.marker);

  const PAD = 34, GAP = 38, COL = 560, BOARD = 980;
  const W = PAD + COL + GAP + BOARD + PAD;
  const headY = PAD + 16;
  const topY = headY + 30;

  const left = proseColumn(prose, { x: PAD, y: topY + 12, w: COL, size: 10.5, lead: 15 });
  const board = boardAt(c.spec.replace('examples/', 'docs/examples/').replace('.json', '.svg'),
    PAD + COL + GAP, topY, BOARD);

  const n = words(prose);
  const { ops } = measure(spec);

  /* The board is short and the words are long; centring it against them is
     what makes the two columns read as the same explanation twice rather than
     as a drawing with a footnote. */
  const boardY = topY + Math.max(0, (left.height - board.height) / 2);
  const centred = board.body.replace(/ y="[-\d.]+"/, ` y="${boardY.toFixed(1)}"`);

  /* Laid out from the bottom of whichever column ran longer, so the footing
     line never crosses the last paragraph. */
  const panelBottom = topY - 6 + left.height + 20;
  const foot = Math.max(panelBottom, boardY + board.height) + 44;
  const H = foot + 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H)}" ` +
    `viewBox="0 0 ${W} ${Math.round(H)}" font-family="${FONT}">` +
    `<rect width="${W}" height="${Math.round(H)}" fill="${PAPER}"/>` +
    `<rect x="${PAD - 14}" y="${topY - 6}" width="${COL + 28}" height="${(left.height + 20).toFixed(1)}" ` +
      `fill="${PANEL}" stroke="${RULE}" rx="8"/>` +
    label(PAD, headY, c.says.toUpperCase()) +
    label(PAD + COL + GAP, headY, c.draws.toUpperCase()) +
    left.body + centred +
    `<line x1="${PAD}" y1="${foot - 22}" x2="${W - PAD}" y2="${foot - 22}" stroke="${RULE}" stroke-width="1"/>` +
    label(PAD, foot, `${n} WORDS, READ IN ORDER`, { size: 12, fill: INK, weight: 700 }) +
    label(W - PAD, foot, `${ops} OPS, DRAWN AS IT TALKS`, { size: 12, fill: ACCENT, weight: 700, anchor: 'end' }) +
    `</svg>`;

  fs.mkdirSync(path.dirname(path.join(ROOT, c.out)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, c.out), svg);
  console.log(c.out);
  console.log(`  ${W} × ${Math.round(H)}`);
  console.log(`  ${n} words (${left.lines} lines) · board ${board.natural} · ${ops} ops`);
}

const args = process.argv.slice(2);
for (const which of (args.length ? args : Object.keys(CASES))) build(which);
