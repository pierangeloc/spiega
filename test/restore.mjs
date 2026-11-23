/* Old op logs still restore (#140).

   Run with `node dist/test/restore.mjs`, or `pnpm test`.

   The oracle is real boards: test/fixtures/logs holds anonymised copies of
   logs from disk, and beside each the picture the board drew when restore was
   a plain replay through the reducer — before the Schema read logs at all. A
   board whose log stops restoring has lost the explanation, so the picture
   must come out byte for byte, and a log nothing can read must say so in
   words rather than draw a board with a hole in it. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyBoard, applyOps, boardOps } from '../src/board/state.js';
import { restoreBoard, readBoardLog } from '../src/board/log.js';
import { renderSVG } from '../src/render/render.js';
import { decodeLog, LogError, MIGRATIONS, LOG_VERSION } from '../packages/core/src/schema/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.join(HERE, 'fixtures', 'logs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-restore-'));

let n = 0;
const test = (name, fn) => {
  try { fn(); n++; console.log('  ok  ' + name); }
  catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

const fixtures = fs.readdirSync(LOGS).filter(f => f.endsWith('.jsonl')).sort();
assert.ok(fixtures.length >= 4, 'the four real logs are here');

for (const f of fixtures) {
  const file = path.join(LOGS, f);
  const golden = fs.readFileSync(file.replace(/\.jsonl$/, '.svg'), 'utf8');

  test(`${f}: restores to the picture it always drew`, () => {
    const { board, lines } = restoreBoard(file);
    assert.equal(renderSVG(board).svg, golden);
    assert.equal(lines, readBoardLog(file).ops.length, 'every line was read');
  });

  test(`${f}: the restored board writes a log that restores to the same picture`, () => {
    const { board } = restoreBoard(file);
    const again = path.join(TMP, f);
    fs.writeFileSync(again, boardOps(board).map(op => JSON.stringify(op)).join('\n') + '\n');
    assert.equal(renderSVG(restoreBoard(again).board).svg, golden);
  });

  test(`${f}: the raw replay still draws the same picture, so the oracle is sound`, () => {
    const { ops } = readBoardLog(file);
    const plain = emptyBoard();
    applyOps(plain, ops);
    assert.equal(renderSVG(plain).svg, golden);
  });
}

test('a null sub is upgraded, and an op already current is left as it was', () => {
  const old = { op: 'node', id: 'a', label: 'A', sub: null };
  const [fixed] = decodeLog('t', [old]);
  assert.ok(!('sub' in fixed));
  assert.equal(old.sub, null, 'the input is not mutated');
  const now = { op: 'node', id: 'a', label: 'A', sub: 'b', extra: 1 };
  assert.equal(decodeLog('t', [now])[0], now, 'the same object, extra fields and all');
  const [amended] = decodeLog('t', [{ op: 'amend', chapter: 1, ops: [old] }]);
  assert.ok(!('sub' in amended.ops[0]), 'amendments are upgraded too');
});

test('the migrations are numbered in order, and the log version is the last', () => {
  MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1));
  assert.equal(LOG_VERSION, MIGRATIONS.length);
});

test('a log that cannot be read names the board and the reason, not a stack', () => {
  const file = path.join(TMP, 'from-the-future.jsonl');
  fs.writeFileSync(file, [
    { op: 'node', id: 'a', label: 'A' },
    { op: 'hologram', id: 'a' },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  assert.throws(() => restoreBoard(file), e => {
    assert.ok(e instanceof LogError);
    assert.equal(e.board, 'from-the-future');
    assert.match(e.message, /board "from-the-future"/);
    assert.match(e.message, /op 2 of 2/);
    assert.match(e.message, /unknown op "hologram"/);
    assert.match(e.message, /newer spiega/);
    assert.doesNotMatch(e.message, /\n\s+at /);
    return true;
  });
});

test('an entry that is not an op at all is refused, whatever it is', () => {
  for (const bad of [{ version: 2 }, { type: 'node' }, { op: 3 }, null, 'text', 7, ['node']]) {
    assert.throws(() => decodeLog('b', [{ op: 'node', id: 'a' }, bad]), e => {
      assert.ok(e instanceof LogError, `${JSON.stringify(bad)} raised a LogError`);
      assert.match(e.message, /board "b"/);
      assert.match(e.message, /op 2 of 2/);
      return true;
    });
  }
});

test('a log line with no string "op" names the board and what is missing', () => {
  for (const bad of [{ version: 2 }, { op: 123 }]) {
    assert.throws(() => decodeLog('b', [bad]), /board "b".*missing a string "op" field/);
  }
});

test('a field of the wrong shape is refused with its path', () => {
  assert.throws(() => decodeLog('b', [{ op: 'edge', from: 'a' }]), /board "b".*edge:/);
});

test('a half line and a blank line are still forgiven', () => {
  const file = path.join(TMP, 'torn.jsonl');
  fs.writeFileSync(file, '{"op":"node","id":"a"}\n\n{"op":"nod');
  const r = restoreBoard(file);
  assert.equal(r.board.nodes.length, 1);
  assert.equal(r.tail, false);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${n} passed`);
