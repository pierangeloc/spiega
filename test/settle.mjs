import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { emptyBoard, applyOps as applyStateOps, boardOps } from '../src/board/state.js';
import { applySettlingOps as applyOps } from '../src/board/settle.js';
import { assign } from '../src/render/layout.js';
import { specToOps } from '../src/spec.js';

const spec = JSON.parse(fs.readFileSync(new URL('./boards/issue-96-long-span.json', import.meta.url)));
assert.match(applyStateOps(emptyBoard(), { op: 'settle' }).errors[0], /positions must be an object/,
  'state requires recorded coordinates and never computes dagre');
const board = emptyBoard();
applyOps(board, specToOps({ ...spec, settle: false }));
const before = assign(board);
const result = applyOps(board, { op: 'settle' });
assert.deepEqual(result.errors, [], 'settle is an accepted op');
assert.ok(result.applied[0].positions, 'the accepted op carries the frozen coordinates to disk');
assert.equal(board.settled, true);
assert.notDeepEqual(assign(board), before, 'dagre changes the insertion-order layout');
for (const node of board.nodes) {
  assert.equal(typeof node.col, 'number');
  assert.equal(typeof node.row, 'number');
}
const restored = emptyBoard();
applyOps(restored, board.log);
assert.deepEqual(assign(restored), assign(board), 'replay reaches exactly the frozen result');
const compact = emptyBoard();
applyOps(compact, boardOps(board));
assert.deepEqual(assign(compact), assign(board));
assert.equal(compact.settled, true);
console.log('  ok  settle reorders the long-span board and logs replayable positions');

const branches = JSON.parse(fs.readFileSync(new URL('./boards/issue-96-interleaved-branches.json', import.meta.url)));
const branched = emptyBoard();
applyStateOps(branched, specToOps({ ...branches, settle: false }));
const crossings = placed => branches.edges.reduce((total, a, i) => total + branches.edges.slice(i + 1).filter(b =>
  placed[a.from].col === placed[b.from].col && placed[a.to].col === placed[b.to].col
  && (placed[a.from].row - placed[b.from].row) * (placed[a.to].row - placed[b.to].row) < 0).length, 0);
assert.equal(crossings(assign(branched)), 4);
applyOps(branched, { op: 'settle' });
assert.equal(crossings(assign(branched)), 0);
console.log('  ok  settle removes all four between-rank crossings from interleaved branches');

// A stored result is authoritative, not a request to run the current dagre.
const frozen = emptyBoard();
applyOps(frozen, [
  { op: 'node', id: 'a' }, { op: 'node', id: 'b' },
  { op: 'settle', positions: { a: { col: 4, row: 2 }, b: { col: 4, row: 0 } } },
]);
const base = assign(frozen);
applyOps(frozen, { op: 'settle', positions: {
  a: { ...base.a, id: 'not-a', label: 'not a coordinate' }, b: base.b,
} });
assert.equal(frozen.nodes[0].id, 'a', 'stored positions only supply coordinates');
assert.equal(frozen.nodes[0].label, undefined);
applyOps(frozen, [{ op: 'node', id: 'c' }, { op: 'edge', from: 'a', to: 'c' }]);
assert.deepEqual(assign(frozen).a, base.a);
assert.deepEqual(assign(frozen).b, base.b);
applyOps(frozen, { op: 'node', id: 'gap', col: 4 });
assert.deepEqual(assign(frozen).gap, { col: 4, row: 1 }, 'feedback fills a free slot');
const feedbackRestore = emptyBoard();
applyStateOps(feedbackRestore, boardOps(frozen));
assert.deepEqual(assign(feedbackRestore), assign(frozen), 'compaction keeps frozen slots and unpinned feedback');
assert.equal(feedbackRestore.nodes.find(n => n.id === 'c').col, undefined,
  'compaction must not pin feedback that has not been settled');
applyOps(frozen, { op: 'node', id: 'a', col: 6, row: 3 });
assert.deepEqual(frozen.log.find(op => op.op === 'settle').positions.a, base.a,
  'updating a frozen node must not rewrite the old settle moment');
const movedRestore = emptyBoard();
applyStateOps(movedRestore, boardOps(frozen));
assert.deepEqual(assign(movedRestore).a, { col: 6, row: 3 });
assert.deepEqual(applyOps(frozen, { op: 'settle', positions: { a: { col: 0, row: NaN } } }).errors,
  ['settle: positions must be an object of finite col and row pairs']);
assert.deepEqual(assign(frozen).a, { col: 6, row: 3 }, 'bad positions do not half-apply');
applyOps(frozen, { op: 'clear' });
assert.equal(frozen.settled, false);
console.log('  ok  frozen positions are authoritative, feedback fills gaps, and clear unfreezes');

const hinted = emptyBoard();
applyOps(hinted, [
  { op: 'node', id: 'below', place: 'below:anchor' },
  { op: 'node', id: 'right', place: 'right-of:anchor' },
  { op: 'node', id: 'above', place: 'above:anchor' },
  { op: 'node', id: 'left', place: 'left-of:anchor' },
  { op: 'node', id: 'anchor', col: 3, row: 2 },
  { op: 'node', id: 'row-only', row: 7 },
  { op: 'node', id: 'col-only', col: 9 },
  { op: 'note', id: 'margin', label: 'aside' },
  { op: 'edge', from: 'anchor', to: 'row-only' },
  { op: 'settle' },
]);
const h = assign(hinted);
assert.deepEqual(h.anchor, { col: 3, row: 2 });
assert.deepEqual(h.below, { col: 3, row: 3 });
assert.deepEqual(h.above, { col: 3, row: 1 });
assert.equal(h.left.col, 2);
assert.equal(h.right.col, 4);
assert.equal(h['row-only'].row, 7);
assert.equal(h['col-only'].col, 9);
assert.equal(h.margin.col, -1);
assert.equal(hinted.nodes[0].place, 'below:anchor', 'the declared hint is not erased');
const block = emptyBoard();
applyOps(block, [
  { op: 'node', id: 'a', col: 0 },
  { op: 'node', id: 'b', place: 'below:a' },
  { op: 'node', id: 'pin', col: 0, row: 1 },
  { op: 'settle' },
]);
assert.deepEqual(assign(block), { pin: { col: 0, row: 1 }, a: { col: 0, row: 2 }, b: { col: 0, row: 3 } });
console.log('  ok  absolute and relative hints constrain settle without overwriting pinned slots');

const cyclic = emptyBoard();
assert.deepEqual(applyOps(cyclic, [
  { op: 'node', id: 'a' }, { op: 'node', id: 'b' }, { op: 'node', id: 'orphan' },
  { op: 'edge', from: 'a', to: 'b' }, { op: 'edge', from: 'b', to: 'a' },
  { op: 'edge', from: 'a', to: 'missing' }, { op: 'settle' },
]).errors, []);
assert.equal(cyclic.nodes.length, 3, 'missing ends never become phantom nodes');
const removed = emptyBoard();
applyOps(removed, [{ op: 'node', id: 'a' }, { op: 'remove', id: 'a' }, { op: 'settle' }]);
assert.deepEqual(removed.log.at(-1).positions, {}, 'settle sees pending removes');
console.log('  ok  cycles, disconnected nodes, dangling edges and pending removes settle safely');

const page = fs.readFileSync(new URL('../src/board/board.html', import.meta.url), 'utf8');
for (const failure of [async () => ({ ok: false }), async () => { throw new Error('offline'); },
  async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } })]) {
  let actions = 0, requests = 0;
  const captions = [], button = {};
  const b = { nodes: [{}], settled: false };
  const handlers = new vm.Script([
    page.match(/async function finish\(\) \{[\s\S]*?\n}/)[0],
    page.match(/async function narrate\([\s\S]*?\n\$\('narrate'\)\.onclick = [^\n]*/)[0],
    page.match(/async function replay\(\) \{[\s\S]*?\n}/)[0],
    '({ click: () => $("narrate").onclick(), next: () => narrate(() => narrator.next()),',
    'prev: () => narrate(() => narrator.prev()), replay })',
  ].join('\n')).runInNewContext({
    board: b, replaying: false, API: '/', Error,
    fetch: async () => { requests++; return failure(); },
    $: () => button, say: text => captions.push(text),
    narrator: { available: true, toggle: () => actions++, next: () => actions++, prev: () => actions++ },
  });
  await handlers.click();
  await handlers.next();
  await handlers.prev();
  await handlers.replay();
  assert.equal(actions, 0, 'failed settle does not start a transport action');
  assert.equal(captions.length, 4);
  assert.match(captions[0], /could not tidy this board/);
  b.settled = true;
  await handlers.next();
  assert.equal(requests, 4, 'settled transport keys make no network request');
  assert.equal(actions, 1);
}
console.log('  ok  narration and replay handle HTTP, network and JSON settle failures without rejection');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-settle-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { createServer, boardFile } = await import('../src/board/server.js');
const { restoreBoard } = await import('../src/board/log.js');
const app = createServer({ name: 'settle', persist: true });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const root = `http://127.0.0.1:${app.server.address().port}`;
const url = root + '/b/settle';
const send = ops => fetch(url + '/op', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
}).then(r => r.json());
try {
  const vendor = await fetch(root + '/vendor/dagre.esm.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get('content-type'), /javascript/);
  assert.equal(await vendor.text(), fs.readFileSync(new URL('../vendor/dagre.esm.js', import.meta.url), 'utf8'));
  for (const route of ['snapshot', 'snapshot.svg', 'replay', 'settle']) {
    await send([{ op: 'clear' }, ...specToOps({ ...spec, settle: false })]);
    assert.equal(app.board.settled, false);
    const finish = () => fetch(url + '/' + route, route === 'settle'
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {});
    assert.equal((await finish()).status, 200);
    assert.equal(app.board.settled, true, route);
    const finishRev = app.board.rev;
    assert.ok(app.board.log.at(-1).positions.cmd);
    await app.flush();
    const onDisk = fs.readFileSync(boardFile('settle'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(onDisk.at(-1).op, 'settle');
    assert.deepEqual(onDisk.at(-1).positions, app.board.log.at(-1).positions);
    assert.deepEqual(assign(restoreBoard(boardFile('settle')).board), assign(app.board));
    const nodes = structuredClone(app.board.nodes);
    await send({ op: 'node', id: 'feedback' });
    await finish();
    assert.equal(app.board.rev, finishRev + 1, route + ' does not settle again after feedback');
    assert.deepEqual(app.board.nodes.slice(0, nodes.length), nodes);
  }
  await send([{ op: 'clear' }, ...specToOps({ ...spec, settle: false })]);
  const { stdout } = await promisify(execFile)(process.execPath, [
    new URL('../src/cli.js', import.meta.url).pathname, 'settle',
  ], { env: { ...process.env, SPIEGA_URL: url } });
  assert.match(stdout, /9 boxes, 9 lines/);
  assert.equal(app.board.settled, true);
  await app.flush();
  assert.equal(restoreBoard(boardFile('settle')).board.settled, true);
  console.log('  ok  CLI, vendor route and implicit finishes persist settle exactly once');
} finally {
  await app.close();
  await new Promise(r => { app.server.close(r); app.server.closeAllConnections(); });
  fs.rmSync(home, { recursive: true, force: true });
}
