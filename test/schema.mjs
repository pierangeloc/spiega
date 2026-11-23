/* The op Schema (#135).

   Run with `node dist/test/schema.mjs`, or `pnpm test`.

   What is being protected, in the order it matters:

   1. **Every board that draws today still draws.** The Schema sits in front of
      the reducer at POST /op, so an op it refuses is an op nobody can draw any
      more. The corpus is the oracle: every spec in examples/ and test/boards/,
      every op those specs turn into, and — the part that catches the subtler
      mistake — every op the *board itself* emits when it is asked to rebuild
      itself. That last one is what a restore and a compaction read back, so a
      shape the reducer produces and the Schema refuses would lose somebody's
      explanation rather than refuse somebody's typo.

   2. **A refusal says which field.** That is the whole point of the change:
      the agent is mid-sentence, it gets one reply, and `not an op` tells it
      nothing it can act on.

   3. **The three deliberate tightenings stay tightenings.** An edge with one
      end, a remove naming nothing, a flow whose steps are not a list: all
      three used to answer `ok` and draw nothing at all. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emptyBoard, applyOps, boardOps } from '../src/board/state.js';
import { specToOps } from '../src/spec.js';
import { reasonFor, OP_NAMES, Op } from '../packages/core/src/schema/op.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const specs = () => [
  ...fs.readdirSync(path.join(ROOT, 'examples')).filter(f => f.endsWith('.json'))
    .map(f => [`examples/${f}`, JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8'))]),
  ...fs.readdirSync(path.join(ROOT, 'test/boards')).filter(f => f.endsWith('.json') && f !== 'manifest.json')
    .map(f => [`test/boards/${f}`, JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards', f), 'utf8'))]),
];

/* The vocabulary and the Schema are the same document said twice. A kind the
   docs name and the Schema has never heard of is the drift this catches. */
{
  const table = fs.readFileSync(path.join(ROOT, 'docs/vocabulary.md'), 'utf8')
    .split('\n').filter(l => /^\| `[a-z]+` \|/.test(l))
    .map(l => l.match(/^\| `([a-z]+)` \|/)[1]);
  const documented = OP_NAMES.filter(op => table.includes(op));
  assert.equal(documented.length, OP_NAMES.length,
    `in the Schema and not in the ops table of docs/vocabulary.md: ` +
    OP_NAMES.filter(op => !table.includes(op)).join(', '));
}

/* Every op the corpus draws with, and every op the corpus can be rebuilt
   from. A single refusal here means a board that used to draw and now does
   not — which is the one thing this change was not allowed to do. */
{
  const refused = [];
  let counted = 0;
  const check = (where, ops) => {
    for (const [i, op] of ops.entries()) {
      counted++;
      const why = reasonFor(op);
      if (why) refused.push(`${where}[${i}]: ${why} — ${JSON.stringify(op).slice(0, 160)}`);
    }
  };

  for (const [name, spec] of specs()) {
    const ops = specToOps(spec);
    check(`${name} via specToOps`, ops);

    /* Applied, then asked to rebuild itself: `boardOps` is what compaction
       writes and what a restore replays, and it emits shapes no agent ever
       sends — a whole `flow` carrying the renderer's own `_n`, a `settle` with
       frozen positions, a `chapter` per surface. */
    const board = emptyBoard();
    const { errors } = applyOps(board, ops);
    assert.deepEqual(errors, [], `${name}: the reducer itself refused these`);
    check(`${name} via boardOps`, boardOps(board));
  }

  assert.ok(counted > 500, `the corpus should be thousands of ops, not ${counted}`);
  assert.deepEqual(refused, [],
    `the Schema refuses ops the board draws today:\n  ${refused.join('\n  ')}`);
}

/* A board drawn the way an agent draws one: the ops in docs/vocabulary.md's
   own examples, including the ones no spec file produces — tag, remove,
   chapter, amend, clear, focus. */
{
  const hand = [
    { op: 'title', text: 'Why a paid order never updates' },
    { op: 'node', id: 'gw', kind: 'gateway', label: 'API Gateway', sub: 'authn' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'note', label: 'retries\nare the point' },
    { op: 'edge', from: 'gw', to: 'orders', label: 'gRPC', async: true },
    { op: 'edge', from: 'gw', to: 'orders', style: 'async', bend: 'straight', step: 2 },
    { op: 'boundary', id: 'vpc', label: 'our VPC', members: ['gw', 'orders'] },
    { op: 'callout', at: 'gw>orders', label: 'the retried one', side: 'ne', wrap: 18 },
    { op: 'group', id: 'intake', label: 'Taking the order' },
    { op: 'step', edge: 'gw>orders', step: 'the gateway forwards it', lights: ['orders'], group: 'intake' },
    { op: 'flow', steps: [{ edge: 'gw>orders', step: 1, lights: ['gw'] }] },
    { op: 'say', text: 'The gateway authenticates first.', step: 1 },
    { op: 'say', text: 'Then it forwards.', edge: 'gw>orders' },
    { op: 'tag', match: 'authenticates', step: 1 },
    { op: 'tag', line: 1, step: null },
    { op: 'tag', line: 1, step: 'off' },
    { op: 'tag', line: 1, step: false },
    { op: 'focus', step: 0 },
    { op: 'focus', step: null },
    { op: 'settle' },
    { op: 'settle', positions: { gw: { col: 0, row: 0 } }, routes: { 'gw>orders': [{ col: 1, row: 1 }] } },
    { op: 'chapter', title: 'What we changed' },
    { op: 'amend', chapter: 1, ops: { op: 'node', id: 'gw', sub: 'authn, mTLS' } },
    { op: 'amend', chapter: 'What we changed', ops: [{ op: 'say', text: 'and here is why' }] },
    { op: 'remove', id: 'orders' },
    { op: 'clear', keepTitle: true },
    // The spellings the reducer coerces, which must not become refusals: an
    // agent that sent a numeric string yesterday is mid-sentence today.
    { op: 'say', text: 'a numeric string', step: '3' },
    { op: 'tag', line: '1', step: '2' },
    { op: 'focus', step: '0' },
    { op: 'amend', chapter: '1', ops: [] },
  ];
  const refused = hand.map(op => [op, reasonFor(op)]).filter(([, why]) => why);
  assert.deepEqual(refused, [], 'hand-written vocabulary ops must all pass');
  assert.ok(Op !== undefined, 'the union is exported, for the tool schemas and the types');
}

/* What an agent is told. Each of these used to be `not an op`, nothing at all,
   or a wall of JSON. */
{
  const named = (op, pattern) => {
    const why = reasonFor(op);
    assert.ok(why, `should be refused: ${JSON.stringify(op)}`);
    assert.match(why, pattern);
  };

  named({ op: 'node', label: 'x', lines: 'one line' }, /^node: .*\["lines"\]/);
  named({ op: 'node', label: 'x', col: {} }, /^node: .*\["col"\]/);
  named({ op: 'edge', from: 'a' }, /^edge: .*\["to"\]/);
  named({ op: 'edge', from: 'a', to: 'b', via: [{ col: 1 }] }, /^edge: .*\["via"\]/);
  named({ op: 'boundary', members: 'a,b' }, /^boundary: .*\["members"\]/);
  named({ op: 'step', lights: 'a' }, /^step: .*\["lights"\]/);
  named({ op: 'flow', steps: 'nope' }, /^flow: .*\["steps"\]/);
  named({ op: 'settle', positions: { a: { col: 'x', row: 1 } } }, /^settle: .*\["positions"\]\["a"\]\["col"\]/);
  named({ op: 'remove' }, /^remove: .*\["id"\]/);
  named({ op: 'group' }, /^group: .*\["id"\]/);
  named({ op: 'say', text: 42 }, /^say: .*\["text"\]/);

  // The vocabulary, listed, because a model that got the name wrong is one
  // word away from the right one.
  const unknown = reasonFor({ op: 'nodes' });
  assert.match(unknown, /^unknown op "nodes"/);
  for (const name of OP_NAMES) assert.ok(unknown.includes(name), `the list should name ${name}`);

  // An op inside an amendment, answered as itself rather than as the union it
  // failed to be.
  const inner = reasonFor({ op: 'amend', chapter: 1, ops: [{ op: 'node', label: 'ok' }, { op: 'edge', to: 'b' }] });
  assert.match(inner, /^amend: ops\[1\] — edge: .*\["from"\]/);
  assert.ok(!inner.includes('readonly'), 'never the wall of members');

  // Not an op at all stays the reducer's sentence, not a second opinion.
  for (const value of [null, 'nope', 42, [], {}, { op: 7 }]) {
    assert.equal(reasonFor(value), null, `${JSON.stringify(value)} is the reducer's to refuse`);
  }
  assert.match(applyOps(emptyBoard(), null).errors[0], /^not an op: expected an object/);
  assert.match(applyOps(emptyBoard(), { op: 7 }).errors[0], /^not an op: "op" must be a string/);
}

/* An unknown kind is a warning and a service box, not a refusal. The whole
   reason `kind` is a string here and not a literal union: a wrong outline
   mid-sentence beats a missing box. */
{
  assert.equal(reasonFor({ op: 'node', kind: 'wormhole', label: 'x' }), null);
  const board = emptyBoard();
  const { errors, warnings } = applyOps(board, { op: 'node', kind: 'wormhole', label: 'x' });
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /no glyph for kind "wormhole"/);
  assert.equal(board.nodes[0].kind, 'wormhole', 'the op lands as asked');
}

/* The guard is on the critical path of somebody talking: POST /op's whole
   budget is 0.2 ms of added latency (test/persist.mjs), and this runs once per
   op in the batch. It is here as its own number so a change that makes the
   Schema expensive fails next to the reason it must not be. */
{
  const op = { op: 'node', id: 'orders', kind: 'service', label: 'Orders', sub: 'Kotlin' };
  for (let i = 0; i < 20000; i++) reasonFor(op);
  const t = Date.now();
  const n = 100000;
  for (let i = 0; i < n; i++) reasonFor(op);
  const per = (Date.now() - t) / n;
  assert.ok(per < 0.01, `screening an op costs ${(per * 1000).toFixed(2)} µs, which is too much of 200 µs`);
}

/* And through the route an agent actually posts to, because everything above
   tests the Schema rather than the board. A batch with one bad op in it must
   draw the rest, answer 207, and name the field — that combination is the
   whole change seen from where the agent stands. */
{
  const os = await import('node:os');
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-schema-'));
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  const { createServer } = await import('../src/board/server.js');

  const app = createServer({ name: 'schema', persist: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}/b/schema/op`;
  const post = ops => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops),
  });

  const res = await post([
    { op: 'node', id: 'gw', kind: 'gateway', label: 'API Gateway' },
    { op: 'edge', from: 'gw' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'remove' },
  ]);
  const body = await res.json();
  assert.equal(res.status, 207, 'a batch with a refusal in it is a partial success, as it always was');
  assert.equal(body.ok, false);
  assert.equal(body.nodes, 2, 'the ops either side of the bad one are on the board');
  assert.equal(body.errors.length, 2);
  assert.match(body.errors[0], /^edge: .*\["to"\]/);
  assert.match(body.errors[1], /^remove: .*\["id"\]/);

  const good = await (await post({ op: 'edge', from: 'gw', to: 'orders', label: 'gRPC' })).json();
  assert.equal(good.ok, true);
  assert.equal(good.edges, 1);

  // The one thing the Schema must not answer: a body that is not an op at all
  // is still the reducer's sentence, and it is still one error, not two.
  const notOps = await (await post([null])).json();
  assert.deepEqual(notOps.errors.length, 1, notOps.errors.join(' | '));
  assert.match(notOps.errors[0], /^not an op: expected an object/);

  app.server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log('ok — schema.mjs');
