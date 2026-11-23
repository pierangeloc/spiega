/* The write routes on Effect — draw, settle and close — and the op log's
   writer behind them.

   Nothing here binds a socket or touches the real disk: the routes are driven
   through `createBoardWebHandler` over a store of in-memory boards, and the log
   is a fake file whose every call is counted, so "no I/O on the request path"
   is an assertion about calls rather than about timing. The flush timer runs
   on Effect's TestClock, which is what lets "a hundred milliseconds later" be
   a line of the test instead of a sleep.

   The same behaviours over a real server, a real file and a real stream are in
   persist.mjs and saving.mjs; the p99 budget is in persist.mjs.
   Run with `node dist/test/write.mjs` (or via vitest through write.spec.mjs). */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { emptyBoard } from '../src/board/state.js';
import { LOG_CAP } from '../src/board/state.js';
import {
  BoardStore,
  SpiegaConfig,
  createBoardEvents,
  createBoardWebHandler,
  isWriteRoute,
  makeOpLog,
} from '../packages/server/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e?.stack || String(e)).split('\n').join('\n        '));
  }
};

/* A log file that counts what it is asked to do, and can be made to fail. */
const fakeFile = (over = {}) => {
  const f = {
    file: '/fake/board.jsonl',
    owner: true,
    lines: 0,
    appended: [],
    attempts: 0,
    compactions: 0,
    released: false,
    failing: null,
    async append(ops) {
      f.attempts++;
      if (f.failing) throw new Error(f.failing);
      f.appended.push([...ops]);
      f.lines += ops.length;
    },
    async compact() { f.compactions++; },
    release() { f.released = true; },
    ...over,
  };
  return f;
};

/* Lets promises the fake file returned settle: the fiber is on a TestClock, but
   the file's promises are real. */
const settled = Effect.promise(() => new Promise(r => setImmediate(r)));
const beat = ms => TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(settled));
const run = effect => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

const say = text => ({ op: 'say', text });

/* console.error is where the log has always warned; capture it so a test can say
   what was warned and a passing run does not print it. */
const capturing = effect => Effect.gen(function* () {
  const saved = console.error;
  const seen = [];
  console.error = (...a) => { seen.push(a.join(' ')); };
  try { yield* effect; } finally { console.error = saved; }
  return seen;
});

/* ---------- the writer ---------- */

await test('push hands ops to the queue and returns; one write lands after the debounce', () => run(Effect.gen(function* () {
  const file = fakeFile();
  const log = yield* makeOpLog(file, { debounce: 100 });
  log.push([say('a')]);
  log.push([say('b'), say('c')]);
  yield* settled;
  assert.equal(file.attempts, 0, 'the request path wrote');
  yield* beat(99);
  assert.equal(file.attempts, 0, 'the timer has not run out yet');
  yield* beat(1);
  assert.equal(file.attempts, 1, 'a burst is one write');
  assert.deepEqual(file.appended[0], [say('a'), say('b'), say('c')], 'in the order they were drawn');
  yield* log.close;
})));

await test('an idle log writes nothing, however long it waits', () => run(Effect.gen(function* () {
  const file = fakeFile();
  const log = yield* makeOpLog(file, { debounce: 100 });
  yield* beat(10_000);
  assert.equal(file.attempts, 0);
  log.push([say('late')]);
  yield* beat(100);
  assert.equal(file.attempts, 1, 'the first op after a long silence is still flushed on the beat');
  yield* log.close;
})));

await test('a write that fails keeps the ops, says so once, and retries on the next beat', () => run(Effect.gen(function* () {
  const file = fakeFile({ failing: 'disk full' });
  const states = [];
  let log;
  const seen = yield* capturing(Effect.gen(function* () {
    log = yield* makeOpLog(file, { debounce: 100, onStatus: () => states.push(log.failure) });
    log.push([say('a')]);
    yield* beat(100);
    assert.equal(file.attempts, 1);
    assert.equal(log.failure, 'disk full', 'the failure is on the log, for the board to read');
    log.push([say('b')]);
    yield* beat(100);
    assert.equal(file.attempts, 2, 'retried on the next beat');
    yield* beat(100);
    assert.equal(file.attempts, 3);
    assert.deepEqual(states, ['disk full'], 'said once, not once per retry');
    file.failing = null;
    yield* beat(100);
    assert.deepEqual(file.appended, [[say('a'), say('b')]], 'nothing lost, nothing doubled, still in order');
    assert.equal(log.failure, null);
    assert.deepEqual(states, ['disk full', null], 'and said again when it recovers');
  }));
  assert.equal(seen.filter(l => /could not write \/fake\/board\.jsonl: disk full/.test(l)).length, 1,
    `warned once on the console too: ${JSON.stringify(seen)}`);
  yield* log.close;
})));

await test('a failing status callback does not take the writer down', () => run(Effect.gen(function* () {
  const file = fakeFile({ failing: 'nope' });
  let log;
  yield* capturing(Effect.gen(function* () {
    log = yield* makeOpLog(file, { debounce: 100, onStatus: () => { throw new Error('nobody is listening'); } });
    log.push([say('a')]);
    yield* beat(100);
    file.failing = null;
    yield* beat(100);
    assert.deepEqual(file.appended, [[say('a')]], 'the fiber kept going');
  }));
  yield* log.close;
})));

await test('flush writes now; close flushes, stops the fiber and lets go of the lock', () => run(Effect.gen(function* () {
  const file = fakeFile();
  const log = yield* makeOpLog(file, { debounce: 60_000 });
  log.push([say('a')]);
  yield* log.flush;
  assert.deepEqual(file.appended, [[say('a')]], 'flush does not wait for the timer');
  log.push([say('b')]);
  yield* log.close;
  assert.deepEqual(file.appended, [[say('a')], [say('b')]], 'close flushes what is queued');
  assert.equal(file.released, true);
  log.push([say('too late')]);
  yield* beat(120_000);
  assert.equal(file.attempts, 2, 'a closed log takes nothing more');
  yield* log.close;
})));

await test('a log this process does not own never queues, so it never writes', () => run(Effect.gen(function* () {
  const file = fakeFile({ owner: false });
  const log = yield* makeOpLog(file, { debounce: 100 });
  log.push([say('a')]);
  yield* beat(1000);
  assert.equal(file.attempts, 0, 'two writers interleaving lines would corrupt both sessions');
  yield* log.close;
})));

await test('past the cap the file is compacted, and only once nothing is waiting', () => run(Effect.gen(function* () {
  let log;
  const file = fakeFile({ lines: LOG_CAP });
  const write = file.append;
  // an op drawn while the batch is being written: a snapshot now would write it twice
  file.append = async ops => { await write(ops); if (file.attempts === 1) log.push([say('mid-write')]); };
  log = yield* makeOpLog(file, { debounce: 100 });
  log.push([say('a')]);
  yield* beat(100);
  assert.equal(file.compactions, 0, 'an op was waiting, so the snapshot would have doubled it');
  yield* beat(100);
  assert.deepEqual(file.appended.flat(), [say('a'), say('mid-write')]);
  assert.equal(file.compactions, 1, 'and with nothing waiting, it compacts');
  yield* log.close;
})));

/* ---------- the routes ---------- */

const makeApp = () => {
  const boards = new Map();
  const closed = [];
  const audited = [];
  const hold = (name, log = null) => {
    const events = createBoardEvents();
    const board = emptyBoard();
    const entry = { name, board, events, log, get viewers() { return events.viewers; } };
    boards.set(name, entry);
    return entry;
  };
  const store = BoardStore.make({
    get: name => boards.get(name),
    reopen: () => undefined,
    listOpen: () => [...boards.values()],
    listSaved: () => [],
    saving: () => ({ saving: false, why: 'memory' }),
    close: async name => { closed.push(name); boards.delete(name); return boards.size; },
    audit: async surface => { audited.push(surface); return { lines: ['audited'] }; },
  });
  const web = createBoardWebHandler(Layer.mergeAll(SpiegaConfig.make({ rootDir: ROOT }), store));
  const post = (url, body, headers = { 'content-type': 'application/json' }) => web.handler(new Request(
    'http://127.0.0.1:4777' + url,
    { method: 'POST', headers: { host: '127.0.0.1:4777', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) },
  ));
  return { boards, closed, audited, hold, web, post };
};

await test('POST /b/:name/op applies, queues and answers; the file is not touched until the beat', () => run(Effect.gen(function* () {
  const app = makeApp();
  const file = fakeFile();
  const log = yield* makeOpLog(file, { debounce: 100 });
  const entry = app.hold('a', log);

  const r = yield* Effect.promise(() => app.post('/b/a/op', { ops: [{ op: 'node', id: 'x', label: 'X' }, say('hello')] }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual(yield* Effect.promise(() => r.json()), {
    ok: true, errors: [], warnings: [], rev: 2, nodes: 1, edges: 0, steps: 0, viewers: 0,
  });
  assert.deepEqual(entry.board.nodes.map(x => x.id), ['x']);
  yield* settled;
  assert.equal(file.attempts, 0, 'the request wrote to the file, or waited for a write');
  yield* beat(100);
  assert.deepEqual(file.appended.flat().map(o => o.op), ['node', 'say']);
  yield* log.close;
  yield* Effect.promise(() => app.web.dispose());
})));

await test('a bare array and a single op are accepted as the old route accepted them', () => run(Effect.gen(function* () {
  const app = makeApp();
  const entry = app.hold('a');
  const bare = yield* Effect.promise(() => app.post('/b/a/op', [{ op: 'node', id: 'x', label: 'X' }]));
  assert.equal(bare.status, 200);
  const single = yield* Effect.promise(() => app.post('/b/a/op', { op: 'node', id: 'y', label: 'Y' }));
  assert.equal(single.status, 200);
  assert.deepEqual(entry.board.nodes.map(x => x.id), ['x', 'y']);
  yield* Effect.promise(() => app.web.dispose());
})));

await test('an op the Schema refuses comes back named, beside the ones that landed (207)', () => run(Effect.gen(function* () {
  const app = makeApp();
  const entry = app.hold('a');
  const r = yield* Effect.promise(() => app.post('/b/a/op', { ops: [
    { op: 'node', id: 'a', label: 'A' },
    { op: 'edge', from: 'a' },
    { op: 'frobnicate' },
    null,
    say('still said'),
  ] }));
  assert.equal(r.status, 207);
  const body = yield* Effect.promise(() => r.json());
  assert.equal(body.ok, false);
  assert.equal(body.errors.length, 3);
  assert.match(body.errors[0], /^edge: .*Missing key at \["to"\]/, 'the field is named, not just "not an op"');
  assert.match(body.errors[1], /^unknown op "frobnicate": the vocabulary has /);
  assert.match(body.errors[2], /not an op/);
  assert.equal(body.nodes, 1, 'the good op beside them is not lost');
  assert.deepEqual(entry.board.transcript.map(x => x.text), ['still said']);
  yield* Effect.promise(() => app.web.dispose());
})));

await test('the answers a client already knows: 404 before 415 before 400, each as before', () => run(Effect.gen(function* () {
  const app = makeApp();
  app.hold('a');

  const gone = yield* Effect.promise(() => app.post('/b/nope/op', 'not json', { 'content-type': 'text/plain' }));
  assert.equal(gone.status, 404, 'a board that is gone hears "gone" whatever it was carrying');
  assert.deepEqual(yield* Effect.promise(() => gone.json()), { ok: false, error: 'no board named "nope"' });

  const plain = yield* Effect.promise(() => app.post('/b/a/op', '[]', { 'content-type': 'text/plain' }));
  assert.equal(plain.status, 415);
  assert.deepEqual(yield* Effect.promise(() => plain.json()), { ok: false, error: 'expected content-type: application/json' });

  const bad = yield* Effect.promise(() => app.post('/b/a/op', '{"ops": ['));
  assert.equal(bad.status, 400);
  const want = (() => { try { JSON.parse('{"ops": ['); } catch (e) { return e.message; } })();
  assert.deepEqual(yield* Effect.promise(() => bad.json()), { ok: false, error: 'invalid JSON: ' + want });

  const nullBody = yield* Effect.promise(() => app.post('/b/a/op', 'null'));
  assert.equal(nullBody.status, 207, 'a null body is one refused op, not a dead server');

  const big = yield* Effect.promise(() => app.post('/b/a/op', ' '.repeat(4_000_001)));
  assert.equal(big.status, 400);
  assert.deepEqual(yield* Effect.promise(() => big.json()), { ok: false, error: 'invalid JSON: body too large' });
  yield* Effect.promise(() => app.web.dispose());
})));

await test('a throw out of the reducer is a 500 in the shape clients parse, and the server carries on', () => run(Effect.gen(function* () {
  const app = makeApp();
  const entry = app.hold('a');
  entry.board.log.push = () => { throw new Error('the log is not taking lines'); };
  const r = yield* Effect.promise(() => app.post('/b/a/op', { ops: [say('into a broken log')] }));
  assert.equal(r.status, 500);
  assert.deepEqual(yield* Effect.promise(() => r.json()), {
    ok: false, error: 'spiega could not apply these ops: the log is not taking lines',
  });
  delete entry.board.log.push;
  const again = yield* Effect.promise(() => app.post('/b/a/op', { ops: [say('fine now')] }));
  assert.equal(again.status, 200);
  yield* Effect.promise(() => app.web.dispose());
})));

await test('audit rides back on the reply, after the ops landed', () => run(Effect.gen(function* () {
  const app = makeApp();
  app.hold('a');
  const r = yield* Effect.promise(() => app.post('/b/a/op', { ops: [{ op: 'node', id: 'x', label: 'X' }], audit: true }));
  assert.deepEqual(Object.keys(yield* Effect.promise(() => r.json())).slice(-2), ['viewers', 'audit']);
  assert.equal(app.audited.length, 1);
  yield* Effect.promise(() => app.web.dispose());
})));

await test('POST /b/:name/settle settles once, queues the settle, and answers with the board', () => run(Effect.gen(function* () {
  const app = makeApp();
  const file = fakeFile();
  const log = yield* makeOpLog(file, { debounce: 100 });
  const entry = app.hold('a', log);
  yield* Effect.promise(() => app.post('/b/a/op', { ops: [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' }, { op: 'edge', from: 'a', to: 'b' },
  ] }));

  const text = yield* Effect.promise(() => app.post('/b/a/settle', '{}', { 'content-type': 'text/plain' }));
  assert.equal(text.status, 415);

  const r = yield* Effect.promise(() => app.post('/b/a/settle', '{}'));
  assert.equal(r.status, 200);
  const body = yield* Effect.promise(() => r.json());
  assert.equal(body.ok, true);
  assert.equal(body.board.settled, true);
  assert.equal(entry.board.settled, true);
  yield* settled;
  assert.equal(file.attempts, 0, 'settling did not write either');
  yield* beat(100);
  assert.ok(file.appended.flat().some(o => o.op === 'settle'), 'the settle is in the log');

  const again = yield* Effect.promise(() => app.post('/b/a/settle', '{}'));
  assert.equal(again.status, 200, 'settling a settled board is not an error');
  yield* beat(100);
  assert.equal(file.appended.flat().filter(o => o.op === 'settle').length, 1, 'and is not logged twice');

  const gone = yield* Effect.promise(() => app.post('/b/nope/settle', '{}'));
  assert.equal(gone.status, 404);
  yield* log.close;
  yield* Effect.promise(() => app.web.dispose());
})));

await test('POST /b/:name/close lets the board go and says how many are left', () => run(Effect.gen(function* () {
  const app = makeApp();
  app.hold('a');
  app.hold('b');
  // close takes no body, and has never asked for a content type
  const r = yield* Effect.promise(() => app.post('/b/a/close', '', {}));
  assert.equal(r.status, 200);
  assert.deepEqual(yield* Effect.promise(() => r.json()), { ok: true, name: 'a', left: 1 });
  assert.deepEqual(app.closed, ['a']);
  const gone = yield* Effect.promise(() => app.post('/b/a/close', '', {}));
  assert.equal(gone.status, 404);
  assert.deepEqual(yield* Effect.promise(() => gone.json()), { ok: false, error: 'no board named "a"' });
  yield* Effect.promise(() => app.web.dispose());
})));

await test('the foreign-origin and non-loopback refusals cover the write routes too', () => run(Effect.gen(function* () {
  const app = makeApp();
  const entry = app.hold('a');
  const foreign = yield* Effect.promise(() => app.post('/b/a/op', { ops: [say('x')] },
    { 'content-type': 'application/json', origin: 'http://evil.example' }));
  assert.equal(foreign.status, 403);
  const rebound = yield* Effect.promise(() => app.web.handler(new Request('http://evil.example:4777/b/a/close',
    { method: 'POST', headers: { host: 'evil.example:4777' } })));
  assert.equal(rebound.status, 403);
  assert.equal(entry.board.transcript.length, 0, 'nothing was drawn');
  assert.deepEqual(app.closed, [], 'and nothing was closed');
  yield* Effect.promise(() => app.web.dispose());
})));

await test('isWriteRoute claims draw, settle and close, POST only, and nothing near them', () => {
  for (const rest of ['op', 'settle', 'close']) {
    assert.equal(isWriteRoute('POST', `/b/x/${rest}`), true, rest);
    assert.equal(isWriteRoute('GET', `/b/x/${rest}`), false, `GET ${rest}`);
    assert.equal(isWriteRoute('POST', `/b/x/${rest}/`), false, `${rest}/`);
  }
  for (const p of ['/boards', '/b/x', '/b/x/', '/b/x/replay', '/b/x/export', '/b/x/snapshot', '/op']) {
    assert.equal(isWriteRoute('POST', p), false, p);
  }
});

console.log(`\n${n} passed`);
