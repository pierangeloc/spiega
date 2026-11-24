/* The Effect HTTP server: read routes, security middleware, and service-injected
   configuration and home directory.

   Unlike test/origin.mjs and test/persist.mjs, nothing here mutates
   process.env.HOME — the temp home is provided through the SpiegaHome layer.
   Run with `node dist/test/server.mjs` (or via vitest through server.spec.mjs). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Deferred, Effect, Fiber, Layer, Pull, Stream } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { createServer } from '../src/board/server.js';
import {
  BoardStore,
  RequireJsonMiddleware,
  SecurityMiddleware,
  SpiegaConfig,
  SpiegaHome,
  createBoardEvents,
  createReadNodeServer,
  createReadWebHandler,
  isReadRoute,
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

const envHomeBefore = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-effect-server-'));

try {
  /* ---------- service-injected SpiegaHome and SpiegaConfig ---------- */

  await test('SpiegaHome.fromPath injects a temp home without mutating process.env', async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SpiegaHome;
      }).pipe(Effect.provide(SpiegaHome.fromPath(tmpHome))),
    );
    assert.equal(resolved.home, tmpHome);
    assert.equal(resolved.sessionDir, path.join(tmpHome, '.spiega'));
    assert.equal(resolved.boardsDir, path.join(tmpHome, '.spiega', 'boards'));
    assert.equal(resolved.boardsFile, path.join(tmpHome, '.spiega', 'boards.json'));
    assert.equal(resolved.serverFile, path.join(tmpHome, '.spiega', 'server.json'));
    assert.equal(resolved.sessionFile, path.join(tmpHome, '.spiega', 'session.json'));
    assert.equal(resolved.boardFile('my board'), path.join(tmpHome, '.spiega', 'boards', 'my-board.jsonl'));
    assert.equal(process.env.HOME, envHomeBefore, 'process.env.HOME must not be mutated');
  });

  await test('SpiegaConfig.make injects config values cleanly through a layer', async () => {
    const cfg = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SpiegaConfig;
      }).pipe(Effect.provide(SpiegaConfig.make({ rootDir: ROOT, port: 4999, persist: true }))),
    );
    assert.equal(cfg.rootDir, ROOT);
    assert.equal(cfg.port, 4999);
    assert.equal(cfg.persist, true);
    assert.equal(cfg.defaultBoard, 'default');
  });

  /* ---------- read routes with persisted home injected via layer ---------- */

  const boardsDir = path.join(tmpHome, '.spiega', 'boards');
  fs.mkdirSync(boardsDir, { recursive: true });
  fs.writeFileSync(
    path.join(boardsDir, 'archived.jsonl'),
    JSON.stringify({ op: 'node', id: 'old', label: 'Archived' }) + '\n',
  );

  const alpha = emptyBoard();
  applyOps(alpha, [{ op: 'node', id: 'gw', label: 'API Gateway', kind: 'gateway' }]);

  const homeLayer = SpiegaHome.fromPath(tmpHome);
  const configLayer = SpiegaConfig.make({ rootDir: ROOT, port: 4777, persist: true });
  const storeLayer = BoardStore.memory({ alpha, 'my board': emptyBoard() }).pipe(
    Layer.provide(Layer.mergeAll(homeLayer, configLayer)),
  );
  const services = Layer.mergeAll(configLayer, storeLayer);
  const web = createReadWebHandler(services);

  const req = (p, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('host')) headers.set('host', '127.0.0.1:4777');
    return web.handler(new Request('http://127.0.0.1:4777' + p, { ...init, headers }));
  };

  await test('GET /boards lists open boards and saved boards from the injected SpiegaHome', async () => {
    const r = await req('/boards');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.pid, process.pid);
    assert.equal(body.url, 'http://127.0.0.1:4777');
    const byName = new Map(body.boards.map(b => [b.name, b]));
    assert.equal(byName.get('alpha').open, true);
    assert.equal(byName.get('alpha').nodes, 1);
    assert.equal(byName.get('archived').open, false);
    assert.equal(typeof byName.get('archived').written, 'number');
  });

  await test('GET /b/:name/state returns board state JSON or 404 JSON', async () => {
    const ok = await req('/b/alpha/state');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    const st = await ok.json();
    assert.equal(st.nodes.length, 1);
    assert.equal(st.nodes[0].id, 'gw');

    const encoded = await req('/b/my%20board/state');
    assert.equal(encoded.status, 200);
    assert.deepEqual((await encoded.json()).nodes, []);

    const missing = await req('/b/nope/state');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { ok: false, error: 'no board named "nope"' });
  });

  await test('GET /b/:name/whoami reports identity and injected saving path', async () => {
    const r = await req('/b/alpha/whoami');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.name, 'alpha');
    assert.equal(body.pid, process.pid);
    assert.equal(body.saving, true);
    assert.equal(body.file, path.join(boardsDir, 'alpha.jsonl'));

    const missing = await req('/b/nope/whoami');
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { ok: false, error: 'no board named "nope"' });
  });

  await test('GET /b/:name redirects to /b/:name/ and serves the built board page or 404 HTML', async () => {
    const redir = await req('/b/my%20board');
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), '/b/my%20board/');

    const page = await req('/b/alpha/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    const html = await page.text();
    assert.match(html, /<div id="root"><\/div>/, 'the React board mounts here');
    assert.match(html, /<script type="module">/, 'with its bundle inline');
    assert.doesNotMatch(html.slice(0, html.indexOf('<script type="module">')), /\bsrc="|from ['"]\/src\//, 'and nothing to fetch off the server');

    const missing = await req('/b/nope/');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /^text\/html/);
    assert.match(await missing.text(), /No board named <b>nope<\/b>/);
  });

  await test('GET / lists open and closed boards, and redirects when only one open board exists', async () => {
    const list = await req('/');
    assert.equal(list.status, 200);
    const html = await list.text();
    assert.match(html, /\/b\/alpha\//);
    assert.match(html, /\/b\/archived\/.*closed/);

    // Single live board with persist=false -> 302 redirect
    const soloCfg = SpiegaConfig.make({ rootDir: ROOT, port: 4777, persist: false });
    const soloStore = BoardStore.memory({ solo: emptyBoard() }).pipe(
      Layer.provide(Layer.mergeAll(homeLayer, soloCfg)),
    );
    const soloWeb = createReadWebHandler(Layer.mergeAll(soloCfg, soloStore));
    try {
      const r = await soloWeb.handler(
        new Request('http://127.0.0.1:4777/', { headers: { host: '127.0.0.1:4777' } }),
      );
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/b/solo/');
    } finally {
      await soloWeb.dispose();
    }
  });

  await test('the icon is served, and the source tree is not', async () => {
    const icon = await req('/icon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.match(await icon.text(), /<svg/);

    /* The board page used to import the renderer off disk through /src/*. It
       is one built file now, so nothing needs that route, and a route nobody
       needs that reads files off disk is only a way in. */
    for (const p of ['/src/render/render.js', '/src/board/index.html', '/src/..%2fpackage.json']) {
      assert.equal((await req(p)).status, 404, p);
    }
    assert.equal(isReadRoute('GET', '/src/render/render.js'), false);
  });

  /* ---------- security middleware over real Node HTTP ---------- */

  const nodeServer = createReadNodeServer(services);
  await new Promise(r => nodeServer.listen(0, '127.0.0.1', r));
  const PORT = nodeServer.address().port;
  const U = `http://127.0.0.1:${PORT}`;

  const rawRequest = (method, p, headers) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: PORT, path: p, method, headers, setHost: false },
        res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', c => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      r.on('error', reject);
      r.end();
    });

  await test('non-loopback Host headers are refused with 403 and no CORS headers', async () => {
    for (const host of ['evil.test', `attacker.example:${PORT}`, `192.168.1.5:${PORT}`]) {
      const r = await rawRequest('GET', '/b/alpha/state', { host });
      assert.equal(r.status, 403, host);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      const r = await rawRequest('GET', '/b/alpha/state', { host });
      assert.equal(r.status, 200, host);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    }
  });

  await test('foreign Origin is refused and OPTIONS never emits CORS headers', async () => {
    const evilGet = await fetch(`${U}/b/alpha/state`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evilGet.status, 403);
    assert.equal(evilGet.headers.get('access-control-allow-origin'), null);

    const otherPort = await fetch(`${U}/b/alpha/state`, { headers: { origin: 'http://127.0.0.1:3000' } });
    assert.equal(otherPort.status, 403);

    const sameOrigin = await fetch(`${U}/b/alpha/state`, { headers: { origin: U } });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);

    const evilOpt = await fetch(`${U}/b/alpha/state`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(evilOpt.status, 403);
    assert.equal(evilOpt.headers.get('access-control-allow-methods'), null);

    const okOpt = await fetch(`${U}/b/alpha/state`, { method: 'OPTIONS', headers: { origin: U } });
    assert.equal(okOpt.status, 204);
    assert.equal(okOpt.headers.get('access-control-allow-origin'), null);
    assert.equal(okOpt.headers.get('access-control-allow-methods'), null);
  });

  await test('RequireJsonMiddleware rejects text/plain with 415 and allows application/json', async () => {
    const PostRoute = HttpRouter.add(
      'POST',
      '/body',
      HttpServerResponse.jsonUnsafe({ ok: true }),
    ).pipe(Layer.provide(RequireJsonMiddleware.layer));
    const app = HttpRouter.toWebHandler(Layer.mergeAll(SecurityMiddleware, PostRoute), {
      disableLogger: true,
    });
    try {
      const plain = await app.handler(
        new Request('http://127.0.0.1:4777/body', {
          method: 'POST',
          headers: { host: '127.0.0.1:4777', 'content-type': 'text/plain' },
          body: '{}',
        }),
      );
      assert.equal(plain.status, 415);
      assert.deepEqual(await plain.json(), {
        ok: false,
        error: 'expected content-type: application/json',
      });

      const ok = await app.handler(
        new Request('http://127.0.0.1:4777/body', {
          method: 'POST',
          headers: { host: '127.0.0.1:4777', 'content-type': 'application/json; charset=utf-8' },
          body: '{}',
        }),
      );
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true });
    } finally {
      await app.dispose();
    }
  });

  /* ---------- SSE on the same HTTP server that accepts ops ---------- */

  const live = createServer({ name: 'live' });
  await new Promise(r => live.server.listen(0, '127.0.0.1', r));
  const liveRoot = `http://127.0.0.1:${live.server.address().port}`;
  const liveUrl = `${liveRoot}/b/live`;
  const post = (ops) => fetch(liveUrl + '/op', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
  }).then(r => r.json());
  const viewers = async (count) => {
    const identity = await fetch(liveUrl + '/whoami').then(r => r.json());
    const { boards } = await fetch(liveRoot + '/boards').then(r => r.json());
    assert.equal(identity.viewers, count);
    assert.equal(boards.find(b => b.name === 'live').viewers, count);
  };
  const connect = async () => {
    const abort = new AbortController();
    const response = await fetch(liveUrl + '/events', {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const nextFrame = async () => {
      while (!buffer.includes('\n\n')) {
        const { done, value } = await reader.read();
        if (done) {
          assert.equal(buffer, '', 'no partial frame at EOF');
          return null;
        }
        buffer += value;
      }
      const end = buffer.indexOf('\n\n') + 2;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end);
      return frame;
    };
    return { response, nextFrame, close: () => abort.abort() };
  };
  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const quiet = async () => {
    const events = live.boards.get('live').events;
    const deadline = Date.now() + 1000;
    while (events.viewers !== 0 && Date.now() < deadline) await sleep(5);
    assert.equal(events.viewers, 0, 'the stream scope must finish after the socket closes');
    assert.equal(events.pending, 0, 'no retained PubSub frames');
    await viewers(0);
  };

  try {
    await test('two live subscribers receive the same patch and replay, in order', async () => {
      const a = await connect();
      const b = await connect();
      try {
        for (const tab of [a, b]) {
          assert.equal(tab.response.status, 200);
          for (const [key, value] of Object.entries({
            'content-type': 'text/event-stream', 'cache-control': 'no-cache',
            connection: 'keep-alive', 'x-accel-buffering': 'no',
          })) assert.equal(tab.response.headers.get(key), value);
          assert.equal(tab.response.headers.get('access-control-allow-origin'), null);
          assert.equal(await tab.nextFrame(), frame('state', live.board));
          assert.equal(await tab.nextFrame(), frame('saving', { saving: false, why: 'memory' }));
        }
        await viewers(2);
        const drawn = await post([{ op: 'node', id: 'gw', label: 'Gateway' }]);
        assert.equal(drawn.viewers, 2);
        const firstPatch = await a.nextFrame();
        const patch = JSON.parse(firstPatch.split('\ndata: ')[1]);
        assert.deepEqual(patch.board.nodes.map(n => n.id), ['gw']);
        assert.deepEqual(patch.amended, []);
        assert.ok(patch.fresh);
        assert.equal(firstPatch, frame('patch', patch));
        assert.equal(await b.nextFrame(), firstPatch);

        assert.equal((await fetch(liveUrl + '/replay').then(r => r.json())).viewers, 2);
        const settledPatch = await a.nextFrame();
        assert.match(settledPatch, /^event: patch\n/);
        assert.equal(await b.nextFrame(), settledPatch);
        for (const tab of [a, b]) {
          assert.equal(await tab.nextFrame(), frame('replay', { rev: live.board.rev }));
        }
      } finally {
        a.close();
        b.close();
      }
      await quiet();
    });

    await test('repeated disconnects release the stream; reconnect gets the full board', async () => {
      for (let i = 0; i < 12; i++) {
        const tab = await connect();
        try {
          assert.equal(await tab.nextFrame(), frame('state', live.board));
          assert.match(await tab.nextFrame(), /^event: saving\n/);
          await viewers(1);
          assert.equal((await post([{ op: 'say', text: `connected ${i}` }])).ok, true);
        } finally {
          tab.close();
        }
        await quiet();
      }
      assert.equal((await post([
        { op: 'node', id: 'store', label: 'Store' },
        { op: 'edge', from: 'gw', to: 'store' },
      ])).viewers, 0);
      const reconnected = await connect();
      try {
        const full = await fetch(liveUrl + '/state').then(r => r.json());
        assert.deepEqual(full.nodes.map(n => n.id), ['gw', 'store']);
        assert.equal(full.edges.length, 1);
        assert.equal(full.transcript.length, 12);
        assert.equal(await reconnected.nextFrame(), frame('state', full));
        assert.match(await reconnected.nextFrame(), /^event: saving\n/);
        assert.equal((await post([{ op: 'say', text: 'after reconnect' }])).ok, true);
        assert.match(await reconnected.nextFrame(), /^event: patch\n/);

        const events = live.boards.get('live').events;
        assert.equal(await live.drop('live'), true);
        assert.equal(await reconnected.nextFrame(), null, 'dropping the board ends its live stream');
        assert.equal(events.viewers, 0);
        assert.equal(events.pending, 0);
      } finally {
        reconnected.close();
      }
      const missing = await fetch(liveUrl + '/events');
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { ok: false, error: 'no board named "live"' });
    });
  } finally {
    await new Promise(r => { live.server.close(r); live.server.closeAllConnections(); });
  }

  await test('a stalled subscriber has bounded backlog, released with its scope', async () => {
    const events = createBoardEvents();
    const stream = events.stream(emptyBoard, () => ({ saving: false, why: 'memory' }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pull = yield* Stream.toPull(stream);
      yield* pull;
      assert.equal(events.viewers, 1);
      for (let rev = 0; rev < 64; rev++) events.publish('replay', { rev });
      assert.equal(events.pending, 16);
    })));
    assert.equal(events.viewers, 0);
    assert.equal(events.pending, 0, 'closing the scope unsubscribes before draining the backlog');
  });

  await test('an overrun stream ends rather than sending a partial sequence of updates', async () => {
    const events = createBoardEvents();
    const stream = events.stream(emptyBoard, () => ({ saving: false, why: 'memory' }));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const pull = yield* Stream.toPull(stream);
      yield* pull;
      for (let rev = 0; rev < 64; rev++) events.publish('replay', { rev });
      const end = yield* Effect.exit(pull);
      assert.equal(end._tag, 'Failure', 'the stream must end on the gap');
      assert.ok(end.cause.reasons.every(Pull.isDoneFailure));
    })).pipe(Effect.timeout('1 second')));
    assert.equal(events.viewers, 0);
    assert.equal(events.pending, 0);
  });

  await test('an idle event stream sends its first ping after 25 seconds', async () => {
    const events = createBoardEvents();
    const stream = events.stream(emptyBoard, () => ({ saving: false, why: 'memory' }));
    const decoder = new TextDecoder();
    const seen = [];
    await Effect.runPromise(Effect.gen(function* () {
      const ready = yield* Deferred.make();
      const reader = yield* Effect.forkChild(stream.pipe(Stream.runForEach(bytes => {
        const text = decoder.decode(bytes);
        seen.push(text);
        return text.startsWith('event: saving\n') ? Deferred.succeed(ready, undefined) : Effect.void;
      })));
      yield* Deferred.await(ready);
      yield* TestClock.adjust('24999 millis');
      assert.equal(seen.length, 2, 'only the initial state and saving frames');
      yield* TestClock.adjust('1 millis');
      assert.equal(seen[2], ': ping\n\n');
      yield* Fiber.interrupt(reader);
    }).pipe(Effect.provide(TestClock.layer())));
    assert.equal(events.viewers, 0, 'interrupting the reader also stops the heartbeat');
  });

  await new Promise(r => nodeServer.close(r));
  await web.dispose();
  assert.equal(process.env.HOME, envHomeBefore, 'process.env.HOME remained untouched');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${n} passed`);
