/* The export as a file people mail each other: how much it weighs, and whether
   a file written before the page was React still opens.

   Neither is visible from a green suite. A page that gained a library builds,
   passes everything else and arrives in an inbox twice the size; a page that
   stopped understanding the state older files carry opens blank in somebody's
   downloads folder, long after anyone remembers which release wrote it.
   Whether a file opens off disk, with no server, is checked where it matters —
   in a browser, on a file:// URL — and recorded on the pull request; what is
   asserted here is what node can see.
   Run with `node dist/test/export.mjs` (or via vitest through export.spec.mjs). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBoard } from '../support/board-view.js';
import { exportHTML } from '../src/board/export.js';
import { createFixtureStore } from '../packages/board/src/index.js';
import { measure, report, PAGE_BUDGET } from '../tools/size.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
const test = (name, fn) => {
  try {
    fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

/* What `window.__SPIEGA_EXPORT__` held in a file written before #157, taken
   from a real one: the import-map export of the commit before the cutover,
   `{ board, viewing, active, chapterOnly }`. Two chapters, two numbered hops,
   three lines of transcript. */
const old = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/export-before-157.json'), 'utf8'));

test('the page stays under its size ceiling, and an export is that page plus state', () => {
  const { page, export: file } = measure();
  assert.ok(page.bytes <= PAGE_BUDGET, `the page is ${page.bytes} bytes, over the ${PAGE_BUDGET} ceiling in tools/size.js`);
  assert.ok(file.bytes > page.bytes, 'an export carries the board on top of the page');
  assert.ok(file.bytes - page.bytes < 64 * 1024, 'the state a board adds is small beside the page it rides in');
  assert.ok(file.gzip < file.bytes / 2, 'a file people mail compresses');
});

test('the size report names the page and an export, in raw and gzipped bytes', () => {
  const table = report(measure());
  assert.match(table, /board page/);
  assert.match(table, /export of examples\/kalman\.json/);
  assert.equal(table.split('\n').filter(line => /\d+\.\d KB \| \d+\.\d KB/.test(line)).length, 2);
});

test('a file exported before the migration still opens: the state it carries draws on today\'s page', () => {
  // The page opens where its exporter was looking: `viewing: 0` is chapter 1.
  const store = createFixtureStore({ board: old.board, hash: `#${old.viewing + 1}`, init: { exported: true, chapterOnly: old.chapterOnly } });
  const html = renderBoard(store);
  for (const id of ['gw', 'svc', 'db']) assert.ok(html.includes(`data-node="${id}"`), `${id} is drawn`);
  for (const label of ['GATEWAY', 'ORDERS', 'LEDGER']) assert.ok(html.includes(`>${label}<`), `${label} is lettered`);
  for (const line of ['Opening line, about the whole board.', 'The gateway speaks gRPC to orders.', 'Then a row lands in the ledger.']) {
    assert.ok(html.includes(line), `the transcript keeps "${line}"`);
  }
  assert.ok(html.includes('Second'), 'its chapters are still tabs');
  assert.equal(store.getSnapshot().board.chapters[0].flow.length, 2, 'both numbered hops survive');
  assert.ok(html.includes('>1 gRPC<'), 'and are numbered on the drawing');
});

test('exporting an old file\'s board again writes the same one file, with nothing fetched', () => {
  const html = exportHTML(old.board, { viewing: old.viewing });
  const config = JSON.parse(html.match(/<script>window\.__SPIEGA_EXPORT__=(.*?)<\/script>/)[1]);
  assert.deepEqual(config.board, old.board, 'the state goes through untouched');
  assert.doesNotMatch(html, /<script type="importmap">|data:text\/javascript/, 'no import map of data-URL modules');
  assert.deepEqual([...html.matchAll(/\s(?:src|href)="(?!data:)([^"]+)"/g)].map(m => m[1]), [], 'nothing is fetched');
});

console.log(`\n${n} passed`);
