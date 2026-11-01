#!/usr/bin/env node
/* ============================================================
   spiega walk — the board being walked, as a GIF.

   Everything else in the docs is a still, and a still cannot show the one
   thing this tool is for: the flow is walked a hop at a time, and the lines
   that explain that hop light up with it while the rest recede. A reader
   looking at a finished board sees a diagram and reasonably concludes they
   have been shown a diagram tool.

   Each frame is a real snapshot at one step, rendered by the same code the
   board uses, so the GIF cannot show a highlight the board would not. ffmpeg
   stitches them; a two-pass palette keeps the paper from dithering into mush.

   Run: node tools/walk.js [spec.json] [out.gif]
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
const [input = 'examples/kalman.json', output = 'docs/examples/kalman-walk.gif'] = process.argv.slice(2);

const SHOT = { w: 1280, h: 1300 };
const WIDE = 1000;      // what the GIF is scaled to
const HOLD = 1.9;       // seconds per step

const BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const browser = BROWSERS.find(b => fs.existsSync(b));
const have = c => { try { cp.execFileSync('which', [c], { stdio: 'pipe' }); return true; } catch { return false; } };

if (!browser) { console.error('no Chromium found; a frame is a web page, so one is needed'); process.exit(1); }
if (!have('ffmpeg')) { console.error('ffmpeg not found; it is what stitches the frames'); process.exit(1); }

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, input), 'utf8'));
const board = emptyBoard();
const { errors } = applyOps(board, specToOps(spec));
if (errors.length) throw new Error(errors.join('; '));

const steps = (board.flow || []).length;
if (!steps) throw new Error(`${input} has no flow, so there is nothing to walk`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-walk-'));
try {
  /* null first: the whole board, nothing lit. Without it the GIF opens
     mid-explanation and the reader never sees the board whole. */
  const frames = [null, ...Array.from({ length: steps }, (_, i) => i)];
  frames.forEach((active, i) => {
    const page = path.join(tmp, `f${i}.html`);
    fs.writeFileSync(page, snapshotHTML(board, { active }));
    cp.execFileSync(browser, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      `--window-size=${SHOT.w},${SHOT.h}`,
      `--screenshot=${path.join(tmp, `f${String(i).padStart(2, '0')}.png`)}`,
      '--virtual-time-budget=3000', `file://${page}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  });

  const out = path.join(ROOT, output);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const pattern = path.join(tmp, 'f%02d.png');
  const filters = `fps=1/${HOLD},scale=${WIDE}:-1:flags=lanczos`;
  const palette = path.join(tmp, 'palette.png');

  cp.execFileSync('ffmpeg', ['-y', '-framerate', `1/${HOLD}`, '-i', pattern,
    '-vf', `${filters},palettegen=stats_mode=diff`, palette], { stdio: 'pipe' });
  cp.execFileSync('ffmpeg', ['-y', '-framerate', `1/${HOLD}`, '-i', pattern, '-i', palette,
    '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
    '-loop', '0', out], { stdio: 'pipe' });

  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
  console.log(`${output}\n  ${frames.length} frames (whole board, then ${steps} steps) · ${WIDE}px wide · ${HOLD}s each · ${mb} MB`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
