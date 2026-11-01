#!/usr/bin/env node
/* ============================================================
   spiega hero — the board at the top of the README.

   Every other picture in the docs is generated from a spec by a tool, so a
   change to a glyph cannot leave the documentation showing something the
   renderer no longer draws. This one was a screenshot somebody took by hand,
   and it survived two renames: it sat at the top of the README, and on the
   npm page, saying "drawn with archboard" — a name the project had not used
   for two versions. Nothing failed, because nothing was checking.

   So it is generated too. The board is examples/order-flow.json plus the two
   things a live session adds and a spec file does not carry: a note in the
   margin and the lines the agent said while drawing.

   Needs a Chromium to rasterise, because the snapshot is a web page. That is
   the one part that cannot be done from Node alone, and it is why this is a
   tool rather than a test.

   Run: node tools/hero.js
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { emptyBoard, applyOps } from '../src/board/state.js';
import { snapshotHTML } from '../src/board/snapshot.js';
import { specToOps } from '../src/spec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'board.png');

/* 1280x980 at 1.5x. The width is what GitHub gives a README image times two,
   near enough; the height is cropped to the content, because a hero with a
   field of empty paper under it reads as a mistake. */
const SHOT = { w: 1280, h: 980, scale: 1.5, step: 3 };

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'order-flow.json'), 'utf8'));

/* What a live session has that a spec file does not. The note is there to show
   that a board can carry a remark which belongs to no single box, and the two
   lines are there because "what was said" is half of what this thing is. */
spec.nodes.push({ id: 'note-retry', kind: 'note', label: 'retry safe only\nif SETNX comes first' });
spec.transcript = [
  { text: "Let's walk through what happens when someone places an order." },
  { text: 'Note the ordering: we claim the idempotency key **before** charging, so a retry can never double-charge.' },
];

const board = emptyBoard();
const { errors } = applyOps(board, specToOps(spec));
if (errors.length) throw new Error(errors.join('; '));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-hero-'));
const page = path.join(tmp, 'board.html');
fs.writeFileSync(page, snapshotHTML(board, { active: SHOT.step - 1 }));

const browser = BROWSERS.find(b => fs.existsSync(b));
if (!browser) {
  console.error(`no Chromium found, so the page is as far as this goes:\n  ${page}\n` +
    'Open it, screenshot it yourself, and save it over docs/board.png.');
  process.exit(1);
}

cp.execFileSync(browser, [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  `--force-device-scale-factor=${SHOT.scale}`,
  `--window-size=${SHOT.w},${SHOT.h}`,
  `--screenshot=${OUT}`,
  '--virtual-time-budget=4000',
  `file://${page}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });

fs.rmSync(tmp, { recursive: true, force: true });
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`docs/board.png\n  ${SHOT.w * SHOT.scale} × ${SHOT.h * SHOT.scale}  ${kb} kB  step ${SHOT.step} lit`);
