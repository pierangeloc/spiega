/* What the drawing came out like, and who is told (#56).

   Run with `node test/audit.mjs`. Its own process because the state directory
   is read once, at import, from HOME: these tests want a temp home.

   The thing being protected here is not the arithmetic, which is crude on
   purpose. It is the shape of the answer. An agent reads one string after it
   draws, and that string has to stay useful: counts first, nothing added when
   the board is clean, and no sentence that tells the agent what to do about
   it. A report that fired on every batch would be skipped, and a report that
   said "this board is unreadable" would be claiming something nobody can
   compute from a drawing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-audit-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer } = await import('../src/board/server.js');
const { emptyBoard, applyOps } = await import('../src/board/state.js');
const { renderSVG } = await import('../src/render/render.js');
const { specToOps } = await import('../src/spec.js');
const { audit, report, CROSSINGS_FLOOR } = await import('../src/render/audit.js');

let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

const specs = dir => fs.readdirSync(path.join(ROOT, dir))
  .filter(f => f.endsWith('.json') && f !== 'manifest.json')
  .map(f => [`${dir}/${f}`, JSON.parse(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))]);

const drawn = spec => {
  const b = emptyBoard();
  const { errors } = applyOps(b, specToOps(spec));
  if (errors.length) throw new Error(errors.join('; '));
  return b;
};
const auditOf = spec => audit(spec, renderSVG(drawn(spec), { margin: 16 }));

/* The board the audit was built to be able to describe. Nothing on it prints
   over anything — which is why three counts could be returned for it in good
   faith — and one of its arrows still runs underneath two boxes it has nothing
   to do with. */
await test('the board in test/boards says exactly which arrows run under a box', async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8'));
  const found = auditOf(spec);
  assert.deepEqual(found.over, [], 'no label on this board prints over anything, and that was the problem');
  assert.deepEqual(found.buried.map(b => `${b.edge} through ${b.box}`),
    ['r7>ext through risk', 'r7>ext through n2'],
    'the arrow from rule 7 passes under the risk budget and under the note');
  assert.deepEqual(report(found),
    ['2 arrows cross a box that is not an end of it: r7>ext through risk, r7>ext through n2'],
    'and that is the whole of what the agent is told: the condition, the count, no advice');
});

/* Every other committed board is clean on this axis, which is what makes the
   measurement worth reporting at all: a number that is never zero says
   nothing. If a change to edge routing buries an arrow on one of these, this
   is where it is noticed. */
await test('no other committed board or example runs an arrow under a box', async () => {
  const dirty = [];
  for (const [name, spec] of [...specs('test/boards'), ...specs('examples')]) {
    if (name.includes('issue-56-arrow-under-box')) continue;
    const found = auditOf(spec);
    for (const b of found.buried) dirty.push(`${name}: ${b.edge} through ${b.box}`);
    assert.ok(found.crossings <= CROSSINGS_FLOOR,
      `${name} crosses ${found.crossings} pairs of lines, at or under the floor of ${CROSSINGS_FLOOR} is expected`);
  }
  assert.deepEqual(dirty, []);
});

/* A clean board must not grow a wall of "0 problems" under its counts. The
   floor is here for the same reason: every committed board sits at two
   crossings or fewer, and a line that fires on every batch is a line that
   stops being read. */
await test('a clean board adds nothing, and one crossing is not worth saying', async () => {
  const clean = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/order-flow.json'), 'utf8'));
  const found = auditOf(clean);
  assert.deepEqual(found.buried, []);
  assert.deepEqual(report(found), []);
  assert.deepEqual(report({ crossings: CROSSINGS_FLOOR }), [], 'at the floor, still silence');
  assert.deepEqual(report({ crossings: CROSSINGS_FLOOR + 1 }), [`${CROSSINGS_FLOOR + 1} pairs of lines cross`]);
});

/* Four named, then a count. The board that provokes this is the one with
   fifteen of them, and a report longer than the sentence it interrupts does
   not get read. */
await test('a tangle names a few and counts the rest', async () => {
  const buried = Array.from({ length: 7 }, (_, i) => ({ edge: `a>b${i}`, box: `n${i}` }));
  const [line] = report({ buried });
  assert.match(line, /^7 arrows cross a box that is not an end of it: /);
  assert.equal((line.match(/through/g) || []).length, 4);
  assert.match(line, /, and 3 more$/);
  assert.match(report({ buried: buried.slice(0, 1) })[0], /^1 arrow crosses a box that is not an end of it: a>b0 through n0$/);
});

/* ---------- who is told ---------- */

const listen = async name => {
  const app = createServer({ name, persist: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${app.server.address().port}/b/${name}`;
  return { app, U, close: () => new Promise(r => { app.server.close(r); app.server.closeAllConnections?.(); }) };
};
const post = (url, body) => fetch(url + '/op', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json());

/* Asked for by name. POST /op is on the critical path of somebody talking,
   and most ops cannot change where an arrow runs: a line of transcript has no
   geometry. So the render happens for the callers that draw and for nobody
   else, and never before the pane has been told. */
await test('POST /op renders nothing unless the caller asks for the audit', async () => {
  const s = await listen('ask');
  try {
    const ops = specToOps(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8')));
    const quiet = await post(s.U, { ops });
    assert.equal(quiet.ok, true);
    assert.equal(quiet.audit, undefined, 'nothing was measured, and nothing is claimed');
    assert.equal(quiet.nodes, 14, 'the counts are unchanged either way');

    const asked = await post(s.U, { ops: [{ op: 'say', text: 'and that is the fan' }], audit: true });
    assert.deepEqual(asked.audit.lines,
      ['2 arrows cross a box that is not an end of it: r7>ext through risk, r7>ext through n2']);
    assert.equal(asked.audit.crossings, 2, 'the numbers come back too, for a caller that wants them');
  } finally { await s.close(); }
});

/* An explanation does not stop because the measurement of it failed, and an
   empty board is not a complaint. */
await test('an empty board is audited in silence', async () => {
  const s = await listen('empty');
  try {
    const r = await post(s.U, { ops: [{ op: 'title', text: 'nothing yet' }], audit: true });
    assert.deepEqual(r.audit.lines, []);
    assert.deepEqual(r.audit.buried, []);
  } finally { await s.close(); }
});

/* It runs on every batch an agent draws, after the broadcast rather than
   before it, so the budget is the agent's own reply and not the drawing
   appearing. Loose on purpose: this fails when something quadratic goes in,
   not when a laptop is busy. */
await test('auditing a board of real size costs a millisecond or two', async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8'));
  const board = drawn(spec);
  audit(spec, renderSVG(board, { margin: 16 }));   // warm
  const ms = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const r = renderSVG(board, { margin: 16 });
    audit(spec, r);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ms.sort((a, b) => a - b);
  assert.ok(ms[10] < 25, `the median render-and-audit took ${ms[10].toFixed(1)} ms`);
});

console.log(`  ${n} audit checks passed`);
fs.rmSync(HOME, { recursive: true, force: true });
