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
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import { emptyBoard, applyOps } from '../src/board/state.js';
import {
  BoardStore,
  RequireJsonMiddleware,
  SecurityMiddleware,
  SpiegaConfig,
  SpiegaHome,
  createReadNodeServer,
  createReadWebHandler,
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
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
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

  await test('GET /b/:name redirects to /b/:name/ and serves board.html or 404 HTML', async () => {
    const redir = await req('/b/my%20board');
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), '/b/my%20board/');

    const page = await req('/b/alpha/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    assert.match(await page.text(), /renderSVG/);

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

  await test('static assets serve /icon.svg and /src/* and refuse traversal', async () => {
    const icon = await req('/icon.svg');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.match(await icon.text(), /<svg/);

    const js = await req('/src/render/render.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript');
    assert.match(await js.text(), /renderSVG/);

    const traversal = await req('/src/..%2fpackage.json');
    assert.equal(traversal.status, 404);

    const missing = await req('/src/does-not-exist.js');
    assert.equal(missing.status, 404);
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

  await new Promise(r => nodeServer.close(r));
  await web.dispose();
  assert.equal(process.env.HOME, envHomeBefore, 'process.env.HOME remained untouched');
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

console.log(`\n${n} passed`);
