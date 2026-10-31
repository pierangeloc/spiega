/* Boards on disk, and the cost of keeping them there.

   Run with `node test/persist.mjs`. This file lives in its own process because
   the state directory is read once, at import, from HOME — the tests need a
   temp home, not the real ~/.spiega. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-persist-'));
const OLD_HOME = process.env.HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer, boardFile } = await import('../src/board/server.js');
const { emptyBoard, applyOps, boardOps, LOG_CAP } = await import('../src/board/state.js');
const { createLog, restoreBoard } = await import('../src/board/log.js');

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

const SERVERS = new Set();
const listen = async (name, opts = {}) => {
  const app = createServer({ name, persist: true, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  SERVERS.add(app.server);
  const root = `http://127.0.0.1:${app.server.address().port}`;
  const U = `${root}/b/${name}`;
  return {
    app, root, U,
    async close() {
      // shut down the way a graceful stop should: buffers first, then sockets
      await Promise.all([...app.boards.values()].map(e => e.log?.close().catch(() => {})));
      await new Promise(r => { app.server.close(r); app.server.closeAllConnections?.(); });
      SERVERS.delete(app.server);
    },
  };
};

const send = (url, ops) => fetch(url + '/op', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ops }),
}).then(r => r.json());

const state = url => fetch(url + '/state').then(r => r.json());

const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

/* ---------- the log survives a stop ---------- */

await test('ops survive a board being dropped and reopened, in their original order', async () => {
  const name = 'persist';
  const a = await listen(name);
  const ops = [
    { op: 'say', text: 'Before the drawing.' },
    { op: 'node', id: 'a', label: 'A' },
    { op: 'say', text: 'Now the second box.' },
    { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b', label: 'calls' },
    { op: 'step', edge: 'a>b', step: 'one hop' },
    { op: 'say', text: 'The hop itself.', step: 1 },
    { op: 'focus', step: 0 },
  ];
  const r = await send(a.U, ops);
  assert.equal(r.ok, true);
  await a.app.flush();

  const file = boardFile(name);
  assert.equal(lines(file).length, ops.length, 'one line per op');
  assert.deepEqual(JSON.parse(lines(file)[0]), ops[0], 'the file holds the ops themselves');

  // what `spiega stop` does to a shared board: a drop, not a kill
  assert.equal((await (await fetch(a.U + '/close', { method: 'POST' })).json()).ok, true);
  assert.equal((await fetch(a.U + '/state')).status, 404);

  // ...and the same board comes back, with the session's order intact
  const made = await (await fetch(a.root + '/boards', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })).json();
  assert.equal(made.ok, true);
  assert.ok(fs.existsSync(file), 'the file outlives the board entry');
  const st = await state(made.url);
  assert.deepEqual(st.nodes.map(x => x.id), ['a', 'b']);
  assert.equal(st.edges.length, 1);
  assert.equal(st.flow.length, 1);
  assert.deepEqual(st.transcript.map(x => x.text), ['Before the drawing.', 'Now the second box.', 'The hop itself.']);
  assert.equal(st.active, 0, 'the step that was lit is still lit');
  assert.deepEqual(st.log.map(({ at, ...op }) => op), ops, 'the ops replay in the order they were drawn and said');
  await a.close();

  // a fresh process is just another server: stop/start, not a re-draw
  const b = await listen(name);
  const again = await state(b.U);
  assert.deepEqual(again.nodes.map(x => x.id), ['a', 'b']);
  assert.deepEqual(again.log.map(({ at, ...op }) => op), ops);
  await b.close();
});

/* ---------- a half line is one lost op, not a lost board ---------- */

await test('a corrupt or half-written last line is skipped, and the next op still lands on its own line', async () => {
  const name = 'corrupt';
  const file = boardFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    JSON.stringify({ op: 'node', id: 'a', label: 'A' }) + '\n' +
    '{"op":"node","id":"half",'                          // the crash
  );

  const s = await listen(name);
  let st = await state(s.U);
  assert.deepEqual(st.nodes.map(x => x.id), ['a'], 'the good op before the half line still replayed');
  assert.equal(st.log.length, 1);

  await send(s.U, [{ op: 'node', id: 'c', label: 'C' }, { op: 'say', text: 'after the crash' }]);
  await s.app.flush();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'), 'the half line is sealed, not glued to the next op');
  const parsed = lines(file).map(l => { try { return JSON.parse(l); } catch { return null; } });
  assert.ok(parsed.some(op => op?.id === 'c'), 'the new op is readable');
  st = await state(s.U);
  assert.deepEqual(st.nodes.map(x => x.id), ['a', 'c']);
  await s.close();
});

/* ---------- one owner per file ---------- */

await test('two servers cannot interleave writes into one board file', async () => {
  const name = 'shared';
  const one = await listen(name);
  const two = await listen(name);
  assert.equal(one.app.boards.get(name).log.owner, true, 'the first server owns the file');
  assert.equal(two.app.boards.get(name).log.owner, false, 'the second must not write beside it');

  await send(one.U, [{ op: 'node', id: 'a', label: 'A' }, { op: 'say', text: 'from the owner' }]);
  await send(two.U, [{ op: 'node', id: 'b', label: 'B' }, { op: 'say', text: 'from the intruder' }]);
  await one.app.flush();
  await two.app.flush();

  const text = fs.readFileSync(boardFile(name), 'utf8');
  for (const line of text.split('\n').filter(Boolean)) JSON.parse(line); // no interleaved fragments
  assert.ok(text.includes('from the owner'));
  assert.ok(!text.includes('from the intruder'), 'the second server leaves the file alone');
  await one.close();
  await two.close();
});

/* ---------- compaction, and only past the cap ---------- */

await test('below LOG_CAP nothing is compacted: the said/drawn interleaving stays', async () => {
  const name = 'small';
  const s = await listen(name, { debounce: 60000 });
  const entry = s.app.boards.get(name);
  const ops = [];
  for (let i = 0; i < 60; i++) {
    ops.push(i % 2 ? { op: 'say', text: 'line ' + i } : { op: 'node', id: 'n' + (i % 5), label: 'N' + i });
  }
  const r = applyOps(entry.board, ops);
  entry.log.push(r.applied);
  await entry.log.flush();

  const onDisk = lines(boardFile(name)).map(l => JSON.parse(l));
  assert.equal(onDisk.length, ops.length, 'not a line was rewritten away');
  assert.deepEqual(onDisk, ops, 'and the order is the session, not a flat rebuild');
  await s.close();
});

await test('past LOG_CAP the file is rewritten from current state as a minimal op set', async () => {
  const name = 'big';
  const s = await listen(name, { debounce: 60000 });
  const entry = s.app.boards.get(name);
  for (let i = 0; i < LOG_CAP + 101; i++) {
    const r = applyOps(entry.board, [{ op: 'node', id: 'same', label: 'Same', sub: String(i) }]);
    entry.log.push(r.applied);
  }
  await entry.log.flush();

  const onDisk = lines(boardFile(name)).map(l => JSON.parse(l));
  assert.ok(onDisk.length < 10, `compaction should leave a handful of ops, left ${onDisk.length}`);
  assert.equal(onDisk[0].op, 'title');
  assert.ok(onDisk.some(op => op.op === 'node' && op.id === 'same'));
  const st = await state(s.U);
  assert.equal(st.nodes.length, 1);
  assert.equal(st.nodes[0].sub, String(LOG_CAP + 100), 'the state itself is intact');
  await s.close();
});

/* ---------- the request path is a buffer push, nothing else ---------- */

await test('POST /op does no file I/O and does not wait for the flush', async () => {
  const name = 'hot';
  // a flush timer long enough that only a write on the request path could fire
  const s = await listen(name, { debounce: 60000 });

  const asyncWrite = ['appendFile', 'writeFile', 'rename'];
  const syncWrite = ['appendFileSync', 'writeFileSync', 'openSync', 'writeSync', 'unlinkSync'];
  const saved = new Map();
  let writes = 0;
  for (const k of asyncWrite) {
    saved.set(k, fs.promises[k]);
    fs.promises[k] = (...args) => {
      writes++;
      return new Promise((resolve, reject) => setTimeout(
        () => saved.get(k).apply(fs.promises, args).then(resolve, reject), 250));
    };
  }
  for (const k of syncWrite) {
    saved.set(k, fs[k]);
    fs[k] = (...args) => { writes++; return saved.get(k).apply(fs, args); };
  }

  try {
    const before = writes;
    const r = await send(s.U, [{ op: 'say', text: 'said mid-sentence' }]);
    assert.equal(r.ok, true);
    assert.equal(writes, before, 'the request path wrote to the filesystem');
  } finally {
    for (const k of asyncWrite) fs.promises[k] = saved.get(k);
    for (const k of syncWrite) fs[k] = saved.get(k);
  }
  await s.app.flush();
  assert.ok(lines(boardFile(name)).some(l => l.includes('said mid-sentence')), 'the debounced flush still lands');
  await s.close();
});

/* The budget: added latency on POST /op < 0.2 ms p99.

   What that measures is the work the route does per op — applyOps and the
   buffer push. HTTP and the event loop are not part of it, and would make the
   number about localhost rather than about persistence. A write, an await, or
   the old findIndex scan put back into this path fails here. */
await test('the per-op work on POST /op stays under 0.2 ms p99', async () => {
  const board = emptyBoard();
  const file = path.join(HOME, 'bench.jsonl');
  const log = createLog(file, { debounce: 1e9, snapshot: () => boardOps(board) });
  const samples = [];
  for (let i = 0; i < 3000; i++) {
    const op = i % 3 === 0
      ? { op: 'say', text: 'a line of the explanation, number ' + i }
      : i % 3 === 1
        ? { op: 'node', id: 'n' + (i % 40), label: 'N' + (i % 40) }
        : { op: 'edge', from: 'n' + (i % 40), to: 'n' + ((i + 1) % 40) };
    const t0 = process.hrtime.bigint();
    const r = applyOps(board, [op]);
    log.push(r.applied);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  assert.ok(p99 < 0.2, `p99 was ${p99.toFixed(3)} ms, budget 0.2 ms`);
  await log.close();
});

/* Restore is the same applyOps over the lines just read. The id -> index map
   is what keeps it linear; the old findIndex per op made a capped board take
   ~108 ms. */
await test('restore of a typical session and of a capped one stay quick', async () => {
  const file = path.join(HOME, 'restore.jsonl');
  const b = emptyBoard();
  const ops = [];
  for (let i = 0; i < 45; i++) {
    ops.push(i % 4 === 0 ? { op: 'node', id: 'n' + i, label: 'N' + i }
      : i % 4 === 1 ? { op: 'edge', from: 'n' + (i - 1), to: 'n' + i }
        : { op: 'say', text: 'line ' + i });
  }
  fs.writeFileSync(file, ops.map(op => JSON.stringify(op)).join('\n') + '\n');
  const t0 = process.hrtime.bigint();
  const r = restoreBoard(file);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.board.nodes.length, 12);
  assert.ok(ms < 5, `a typical session restored in ${ms.toFixed(2)} ms, budget 5 ms`);

  // the cap: 4000 ops over 400 boxes, which is where O(n²) used to show
  const many = [];
  for (let i = 0; i < LOG_CAP; i++) many.push({ op: 'node', id: 'n' + (i % 400), label: 'N' + (i % 400), sub: String(i) });
  fs.writeFileSync(file, many.map(op => JSON.stringify(op)).join('\n') + '\n');
  const t1 = process.hrtime.bigint();
  restoreBoard(file);
  const capped = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(capped < 50, `a capped board restored in ${capped.toFixed(2)} ms; the id map should keep this linear`);
});

// a failed assertion can leave a server listening; close the stragglers so the
// file exits with its status instead of hanging on a socket
await test('a tidy shutdown leaves no lock behind', async () => {
  const file = boardFile('tidy');
  const log = createLog(file, {});
  assert.equal(log.owner, true, 'the first writer owns the board');
  assert.ok(fs.existsSync(file + '.lock'), 'and holds a lock while it does');
  log.push([{ op: 'node', id: 'a', kind: 'service', label: 'A' }]);
  await log.close();
  assert.ok(!fs.existsSync(file + '.lock'),
    'close must release the lock; flush alone left one holding a dead pid');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"a"'), 'and it still flushed');
});

await test('removes, then updates and additions, still land correctly', async () => {
  /* Plain behaviour, not a guard: `upsert` validates any slot the index hands
     it and falls back to a scan, so dropping the index on remove is a pure
     optimisation and cannot corrupt anything. This just holds the behaviour
     steady while that optimisation changes shape. */
  const board = emptyBoard();
  applyOps(board, Array.from({ length: 40 }, (_, i) =>
    ({ op: 'node', id: `n${i}`, kind: 'service', label: `N${i}` })));
  applyOps(board, Array.from({ length: 20 }, (_, i) => ({ op: 'remove', id: `n${i * 2}` })));

  applyOps(board, [{ op: 'node', id: 'n7', label: 'RENAMED' }]);
  assert.equal(board.nodes.filter(n => n.id === 'n7').length, 1, 'no duplicate');
  assert.equal(board.nodes.find(n => n.id === 'n7').label, 'RENAMED');
  assert.ok(!board.nodes.some(n => n.id !== 'n7' && n.label === 'RENAMED'),
    'the update must not land on a neighbour through a stale index');

  applyOps(board, [{ op: 'node', id: 'fresh', kind: 'service', label: 'Fresh' }]);
  assert.equal(board.nodes.filter(n => n.id === 'fresh').length, 1);
  assert.equal(board.nodes.length, 21, '20 survivors plus the new one');
});

await test('a batch of removes costs about what the batch is worth', async () => {
  /* A ratio, not a wall-clock budget: an absolute threshold only measures the
     machine. Four times the nodes should be about four times the work, not
     sixteen. The log is emptied before the timed run because past LOG_CAP
     every op also pays a splice of the log, which is a separate cost and
     would drown the one being measured. */
  const time = n => {
    const board = emptyBoard();
    applyOps(board, Array.from({ length: n }, (_, i) =>
      ({ op: 'node', id: `n${i}`, kind: 'service', label: `N${i}` })));
    applyOps(board, Array.from({ length: n - 1 }, (_, i) =>
      ({ op: 'edge', from: `n${i}`, to: `n${i + 1}` })));
    board.log = [];
    const t0 = process.hrtime.bigint();
    applyOps(board, Array.from({ length: n }, (_, i) => ({ op: 'remove', id: `n${i}` })));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(board.nodes.length, 0);
    assert.equal(board.edges.length, 0);
    return ms;
  };
  time(200);                                     // let the JIT see the shape once
  const small = Math.min(...[0, 1, 2].map(() => time(1000)));
  const large = Math.min(...[0, 1, 2].map(() => time(4000)));
  const ratio = large / small;
  assert.ok(ratio < 9, `4x the nodes cost ${ratio.toFixed(1)}x the time ` +
    `(${small.toFixed(2)}ms -> ${large.toFixed(2)}ms); a quadratic remove would be about 16x`);
});

for (const server of SERVERS) { server.close(); server.closeAllConnections?.(); }

process.env.HOME = OLD_HOME;
process.env.USERPROFILE = OLD_HOME;
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${n} passed`);
