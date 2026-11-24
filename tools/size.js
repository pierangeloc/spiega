#!/usr/bin/env node
/* ============================================================
   spiega size — what an exported board weighs.

   An export is a file people mail each other: the board page with the board's
   state in front of its bundle. The page is React and little else — no
   dagre, no Effect, nothing that decodes a schema in the browser — and what
   keeps it that way is a number somebody can see go up. Nothing throws when
   the page gets heavier; a module that pulled in half a library would build,
   pass the suite and quietly double what lands in an inbox.

   Run: pnpm run size   (builds first; reads dist/)
   In CI the same table is appended to the job summary, and the run fails if
   the page is over PAGE_BUDGET.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { exportHTML } from '../src/board/export.js';
import { specToOps } from '../src/spec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The page today is ~331 KB. The ceiling is a tripwire, not a target: raise it
   in the commit that adds weight on purpose, and say why. */
export const PAGE_BUDGET = 400 * 1024;

const sized = html => ({ bytes: Buffer.byteLength(html), gzip: zlib.gzipSync(html).length });

/** The built page, and an export of a real board (examples/kalman.json). */
export function measure() {
  const page = fs.readFileSync(path.join(ROOT, 'src/board/index.html'), 'utf8');
  const board = emptyBoard();
  const { errors } = applyOps(board, specToOps(JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/kalman.json'), 'utf8'))));
  if (errors.length) throw new Error('examples/kalman.json does not apply: ' + errors.join('; '));
  return { page: sized(page), export: sized(exportHTML(board)) };
}

const kb = bytes => (bytes / 1024).toFixed(1) + ' KB';

export function report({ page, export: file }) {
  const row = (name, s) => `| ${name} | ${kb(s.bytes)} | ${kb(s.gzip)} |`;
  return [
    '| | raw | gzip |',
    '|---|---|---|',
    row('board page (no state)', page),
    row('export of examples/kalman.json', file),
  ].join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sizes = measure();
  const table = report(sizes);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Export size\n\n${table}\n`);
  }
  if (sizes.page.bytes > PAGE_BUDGET) {
    console.error(`\nthe board page is ${kb(sizes.page.bytes)}, over the ${kb(PAGE_BUDGET)} ceiling in tools/size.js`);
    process.exit(1);
  }
}
