/* The reducer, asked questions nobody wrote down (#137).

   Run with `node dist/test/reducer.mjs`, or `pnpm test`.

   The other suites ask the reducer about boards somebody thought of. This one
   generates ops from the Schema — the same definition POST /op decodes against
   — and asks the three things that have to hold for every one of them:

   1. **It does not throw.** `applyOps` promises that, because a throw inside a
      request handler takes the process and every other board in it down with
      the one bad op. Nothing downstream is defensive enough to survive it, so
      the promise is the whole contract of the door.

   2. **The board is still a board.** Checked against the Board Schema rather
      than against a list of fields written out here, so a board that drifts
      from its own shape cannot pass by having been described twice. Ops land
      on one accumulating board, which is harsher than a fresh one per op:
      a `remove` has something to sweep and an `amend` has chapters to aim at.

   3. **A log replays into the board it came from.** Restore and compaction are
      both this: `boardOps` out, `applyOps` back in. It is asserted over the
      corpus as well as over the generated run, because the ops the corpus
      produces are the shapes an explanation actually has.

   The seed is fixed, so a failure here is a failure anyone can reproduce; it
   is printed with the count in case it ever needs raising. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Arbitrary, Effect } from 'effect';

import { Op } from '../packages/core/src/schema/op.js';
import { isBoard } from '../packages/core/src/schema/board.js';
import { emptyBoard, applyOp, applyOps, boardOps } from '../src/board/state.js';
import { specToOps } from '../src/spec.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SEED = 137;
const COUNT = 600;

const ops = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(Op), { count: COUNT, seed: SEED }));
assert.ok(ops.length > 100, `expected a run of generated ops, got ${ops.length}`);

/* What a replay has to reproduce: everything drawn and everything said. Not
   the log, which is the thing being replayed, nor `rev`, which counts ops and
   not content, nor the moment a line was said — a replay happens later by
   definition. */
const said = s => ({
  nodes: s.nodes, edges: s.edges, boundaries: s.boundaries, callouts: s.callouts,
  flow: s.flow, groups: s.groups, placed: s.placed, settled: s.settled, active: s.active,
  transcript: s.transcript.map(({ at: _at, ...line }) => line),
});
const drawn = b => ({
  title: b.title, chapter: b.chapter, chapters: b.chapters.map(said), ...said(b),
});

/* One at a time, onto a board that keeps everything: if any of the 600 throws
   it is named, because 'one of them threw' is not a bug report. */
{
  const board = emptyBoard();
  for (const [i, op] of ops.entries()) {
    let result;
    try {
      result = applyOp(board, op);
    } catch (e) {
      assert.fail(`op ${i} threw ${e?.message}: ${JSON.stringify(op)}`);
    }
    assert.equal(typeof result.ok, 'boolean', `op ${i} answered neither yes nor no`);
    if (result.ok) assert.ok(result.op, `op ${i} was accepted without saying what landed`);
    else assert.equal(typeof result.error, 'string', `op ${i} was refused without a reason`);
    assert.ok(isBoard(board), `op ${i} left something that is not a board: ${JSON.stringify(op)}`);
  }
  console.log(`ok ${COUNT} generated ops applied, seed ${SEED}, and the board stayed a board`);
}

/* The same ops as one batch. applyOps is not a loop over applyOp — it holds a
   sweep open across the run — so it is a second door and gets the same
   questions. */
{
  const board = emptyBoard();
  const r = applyOps(board, ops);
  assert.ok(Array.isArray(r.errors) && Array.isArray(r.applied) && Array.isArray(r.warnings),
    'applyOps answered with something other than its own shape');
  assert.ok(isBoard(board), 'a batch of generated ops left something that is not a board');
  assert.ok(r.applied.length, 'nothing at all was accepted, so this proves nothing');
  console.log(`ok the same ops as one batch: ${r.applied.length} applied, ${r.errors.length} refused`);
}

/* Nothing an agent can send is a throw, including the things that are not ops
   at all. These used to reach `op.op` inside the request handler. */
{
  /* `[]` is not in here: a batch of no ops is a batch of no ops, and draws
     and refuses nothing. */
  for (const bad of [null, undefined, 42, 'node', [null], {}, { op: 7 }, { op: 'nope' },
    { op: 'node', lines: '["a"]' }, { op: 'boundary', members: 'a,b' },
    { op: 'step', lights: 'ab' }, { op: 'flow', steps: 'later' },
    { op: 'settle' }, { op: 'remove' }, { op: 'tag', line: 99 }]) {
    const board = emptyBoard();
    const r = applyOps(board, bad);
    assert.ok(isBoard(board), `${JSON.stringify(bad)} left something that is not a board`);
    assert.equal(r.applied.length + r.errors.length > 0, true,
      `${JSON.stringify(bad)} was neither drawn nor refused`);
  }
  console.log('ok the things that are not ops are refused, not thrown');
}

/* Out through boardOps and back in. A board long enough to have been compacted
   is replayed from exactly these ops, and so is every board read back off
   disk. */
const replays = (name, board) => {
  const again = emptyBoard();
  const r = applyOps(again, boardOps(board));
  assert.ok(!r.errors.length, `${name}: its own rebuild was refused — ${r.errors.join('; ')}`);
  assert.deepEqual(drawn(again), drawn(board), `${name}: the rebuild is not the board it came from`);
};

{
  const board = emptyBoard();
  applyOps(board, ops);
  replays('the generated run', board);
  console.log('ok a generated board replays into itself');
}

{
  const specs = [
    ...fs.readdirSync(path.join(ROOT, 'examples')).filter(f => f.endsWith('.json'))
      .map(f => [`examples/${f}`, path.join(ROOT, 'examples', f)]),
    ...fs.readdirSync(path.join(ROOT, 'test/boards')).filter(f => f.endsWith('.json') && f !== 'manifest.json')
      .map(f => [`test/boards/${f}`, path.join(ROOT, 'test/boards', f)]),
  ];
  assert.ok(specs.length >= 5, `expected the corpus, found ${specs.length} specs`);
  for (const [name, file] of specs) {
    const board = emptyBoard();
    applyOps(board, specToOps(JSON.parse(fs.readFileSync(file, 'utf8'))));
    assert.ok(isBoard(board), `${name} does not satisfy the Board schema`);
    replays(name, board);
  }
  console.log(`ok ${specs.length} boards from the corpus are boards, and replay into themselves`);
}

console.log('reducer.mjs: ok');
