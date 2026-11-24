/* The board as a file: the export, the snapshot and the bare SVG, on the
   Effect router — and what each file still is once the server has gone.

   The routes are driven through `createBoardWebHandler` over boards held in
   memory, as write.mjs does. The files are then taken off a real server,
   written to disk, and read back only after that server has closed and
   refuses connections, because "it opens with no server behind it" is a
   property of the file and not of the request that fetched it. A snapshot
   that opens empty, or one that quietly links back to /icon.svg, passes every
   other test in this repository.
   Run with `node dist/test/snapshot.mjs` (or via vitest through snapshot.spec.mjs). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Layer } from 'effect';
import { applyOps, emptyBoard } from '../src/board/state.js';
import {
  BoardStore,
  SpiegaConfig,
  createBoardEvents,
  createBoardWebHandler,
  isReadRoute,
  isRenderRoute,
  isWriteRoute,
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

/* An explanation with everything a still has to carry: a title, boxes, two
   numbered hops, a line said before any step, a line tagged to each, and the
   second hop lit. */
const OPS = [
  { op: 'title', text: 'Orders <&> flow' },
  { op: 'node', id: 'gw', kind: 'gateway', label: 'Gateway' },
  { op: 'node', id: 'svc', kind: 'service', label: 'Orders' },
  { op: 'node', id: 'db', kind: 'datastore', label: 'Ledger' },
  { op: 'edge', from: 'gw', to: 'svc', label: 'gRPC' },
  { op: 'edge', from: 'svc', to: 'db', label: 'SQL' },
  { op: 'step', edge: 'gw>svc', step: 'the gateway calls orders' },
  { op: 'step', edge: 'svc>db', step: 'orders writes the row' },
  { op: 'say', text: 'Opening line, about the whole board.' },
  { op: 'say', text: 'The gateway speaks gRPC to orders.', step: 1 },
  { op: 'say', text: 'Then a row lands in the ledger.', step: 2 },
  { op: 'focus', step: 1 },
];

const makeApp = () => {
  const boards = new Map();
  const hold = (name, ops = []) => {
    const events = createBoardEvents();
    const board = emptyBoard();
    applyOps(board, ops);
    const entry = { name, board, events, log: null, get viewers() { return events.viewers; } };
    boards.set(name, entry);
    return entry;
  };
  const store = BoardStore.make({
    get: name => boards.get(name),
    reopen: () => undefined,
    listOpen: () => [...boards.values()],
    listSaved: () => [],
    saving: () => ({ saving: false, why: 'memory' }),
    close: async name => { boards.delete(name); return boards.size; },
    audit: async () => null,
  });
  const web = createBoardWebHandler(Layer.mergeAll(SpiegaConfig.make({ rootDir: ROOT }), store));
  const get = url => web.handler(new Request('http://127.0.0.1:4777' + url, { headers: { host: '127.0.0.1:4777' } }));
  return { hold, web, get };
};

/* Everything in a page that would make a browser ask for something: an
   attribute that names a resource, a CSS url(), an @import, or one of the
   elements that load a document. A `data:` URL is the file itself, and a
   fragment — `#hand`, or `%23g` inside an inlined SVG — points into it. */
const outsideReferences = html => {
  const found = [];
  for (const m of html.matchAll(/\s(?:href|src|xlink:href|srcset|action|formaction|poster|background)\s*=\s*(['"])(.*?)\1/gis)) {
    found.push(m[2]);
  }
  for (const m of html.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) found.push(m[2]);
  for (const m of html.matchAll(/@import\s+(['"]?)([^'";\s]*)/gi)) found.push(m[2] || '@import');
  for (const m of html.matchAll(/<(iframe|object|embed|base|frame)\b/gi)) found.push(`<${m[1]}>`);
  if (/http-equiv\s*=\s*['"]?refresh/i.test(html)) found.push('meta refresh');
  return found.filter(ref => !/^(data:|#|%23)/i.test(ref.trim()));
};

/* Each specifier a module names, static or dynamic. */
const specifiers = code => [
  ...[...code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)].map(m => m[2]),
  ...[...code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map(m => m[2]),
  ...[...code.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gm)].map(m => m[2]),
];

/* The checks below pass on an empty list, so first make sure the list is not
   empty for the thing they are there to catch. */
await test('the reference check sees a link back to the server', () => {
  assert.deepEqual(outsideReferences('<link rel="icon" type="image/svg+xml" href="/icon.svg">'), ['/icon.svg']);
  assert.deepEqual(outsideReferences(`<img src='http://127.0.0.1:4777/x.png'>`), ['http://127.0.0.1:4777/x.png']);
  assert.deepEqual(outsideReferences('<style>body{background:url(/paper.png)}</style>'), ['/paper.png']);
  assert.deepEqual(outsideReferences('<style>@import "/b.css";</style>'), ['/b.css']);
  assert.deepEqual(outsideReferences('<use href="#hand"/><rect filter="url(#g)"/><img src="data:image/png;base64,AA">'), []);
});

await test('GET /b/:name/snapshot is a still of the board, on the Effect router', async () => {
  const app = makeApp();
  app.hold('a', OPS);
  const r = await app.get('/b/a/snapshot');
  assert.equal(r.status, 200, 'the Effect router did not answer the snapshot');
  assert.equal(r.headers.get('content-type'), 'text/html');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const html = await r.text();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<title>Orders &lt;&amp;&gt; flow<\/title>/);
  for (const id of ['gw', 'svc', 'db']) assert.match(html, new RegExp(`data-node="${id}"`), `the drawing lost ${id}`);
  assert.match(html, /<span class="n">1<\/span>the gateway calls orders/);
  assert.match(html, /<li class="on"><span class="n">2<\/span>orders writes the row/, 'the lit hop is the board\'s own');
  assert.match(html, /<li class="on"><span class="tag">step 2<\/span>Then a row lands in the ledger\./);

  // `step` counts from 0, and an empty one is the board's own
  const first = await (await app.get('/b/a/snapshot?step=0')).text();
  assert.match(first, /<li class="on"><span class="n">1<\/span>the gateway calls orders/);
  assert.equal(await (await app.get('/b/a/snapshot?step=')).text(), html);
  await app.web.dispose();
});

await test('GET /b/:name/snapshot.svg is the drawing alone, lit as the board is', async () => {
  const app = makeApp();
  app.hold('a', OPS);
  const r = await app.get('/b/a/snapshot.svg');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  const svg = await r.text();
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /data-node="gw"/);
  await app.web.dispose();
});

await test('GET /b/:name/export is an attachment, and takes its scope off the query', async () => {
  const app = makeApp();
  app.hold('a', [...OPS, { op: 'chapter', title: 'Later' }, { op: 'node', id: 'late', label: 'Afterwards' }]);
  const all = await app.get('/b/a/export?scope=all&viewing=0');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(all.headers.get('content-disposition'), 'attachment; filename="spiega-board.html"');
  const whole = await all.text();
  assert.match(whole, /"viewing":0/);
  assert.match(whole, /"Afterwards"/);

  const one = await (await app.get('/b/a/export?scope=chapter&chapter=0&step=1')).text();
  assert.match(one, /"chapterOnly":true/);
  assert.match(one, /"Gateway"/);
  assert.doesNotMatch(one, /"Afterwards"/);
  assert.match(one, /"active":1/);

  // the tabs the page has, by name, and a missing chapter number is chapter 0
  assert.match(await (await app.get('/b/a/export?scope=all&viewing=map')).text(), /"viewing":"map"/);
  assert.match(await (await app.get('/b/a/export?scope=chapter')).text(), /"chapterOnly":true/);
  await app.web.dispose();
});

await test('a chapter the board does not have is a 400 in JSON; a board it does not hold, a 404', async () => {
  const app = makeApp();
  app.hold('a', OPS);
  for (const q of ['chapter=2', 'chapter=-1', 'chapter=x', 'chapter=0.5']) {
    const r = await app.get(`/b/a/export?scope=chapter&${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(await r.json(), { ok: false, error: 'no such chapter' });
  }
  for (const route of ['export', 'snapshot', 'snapshot.svg']) {
    const r = await app.get(`/b/nobody/${route}`);
    assert.equal(r.status, 404, route);
    assert.deepEqual(await r.json(), { ok: false, error: 'no board named "nobody"' });
  }
  await app.web.dispose();
});

/* A log written before the door refused it can still carry this, and the
   render is the last place it lands. */
await test('a board that cannot be drawn costs its own render, as a 500 in words', async () => {
  const app = makeApp();
  const broken = app.hold('broken', [{ op: 'node', id: 'a', label: 'A' }, { op: 'boundary', id: 'ok', label: 'ok', members: ['a'] }]);
  broken.board.boundaries.push({ id: 'bad', label: 'bad', members: '["a"]' });
  app.hold('fine', OPS);
  for (const route of ['snapshot', 'snapshot.svg']) {
    const r = await app.get(`/b/broken/${route}`);
    assert.equal(r.status, 500, route);
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(await r.text(), /^spiega could not draw this board: .+\n$/);
  }
  assert.equal((await app.get('/b/fine/snapshot')).status, 200, 'and the next board draws');
  await app.web.dispose();
});

await test('the still is of the settled board: drawing it settles it, as the old route did', async () => {
  const app = makeApp();
  const entry = app.hold('a', OPS);
  const patches = [];
  const events = entry.events;
  const publish = events.publish.bind(events);
  events.publish = (event, data) => { patches.push(event); return publish(event, data); };
  assert.equal(entry.board.settled, false);
  assert.equal((await app.get('/b/a/snapshot.svg')).status, 200);
  assert.equal(entry.board.settled, true, 'a still of an unsettled board is not what a reader sees');
  assert.deepEqual(patches, ['patch'], 'and the windows watching it hear about it');
  await app.web.dispose();
});

await test('isRenderRoute claims the three files, GET only, and nothing else does', () => {
  for (const rest of ['export', 'snapshot', 'snapshot.svg']) {
    assert.equal(isRenderRoute('GET', `/b/x/${rest}`), true, rest);
    assert.equal(isRenderRoute('POST', `/b/x/${rest}`), false, `POST ${rest}`);
    assert.equal(isRenderRoute('GET', `/b/x/${rest}/`), false, `${rest}/`);
    assert.equal(isReadRoute('GET', `/b/x/${rest}`), false, `read claims ${rest}`);
    assert.equal(isWriteRoute('POST', `/b/x/${rest}`), false, `write claims ${rest}`);
  }
  for (const p of ['/boards', '/b/x', '/b/x/', '/b/x/replay', '/b/x/state', '/b/x/snapshot.png', '/snapshot']) {
    assert.equal(isRenderRoute('GET', p), false, p);
  }
});

/* ---------- the files, once the server has gone ---------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-snapshot-'));
const files = {};
let gone = '';

await test('a snapshot and an export are fetched from a real server, which then stops', async () => {
  const { createServer } = await import('../src/board/server.js');
  const { server } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  gone = base;
  try {
    const draw = await fetch(base + '/b/default/op', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: OPS }),
    });
    assert.equal(draw.status, 200);
    for (const [name, route] of [['snapshot.html', '/snapshot'], ['export.html', '/export'], ['board.svg', '/snapshot.svg']]) {
      const r = await fetch(base + '/b/default' + route);
      assert.equal(r.status, 200, route);
      files[name] = path.join(dir, name);
      fs.writeFileSync(files[name], await r.text());
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
  await assert.rejects(fetch(base + '/boards', { signal: AbortSignal.timeout(2000) }),
    'the server is still answering; nothing below would prove anything');
});

await test('the snapshot, read off disk with no server running, keeps the drawing, the words and the steps', () => {
  const html = fs.readFileSync(files['snapshot.html'], 'utf8');
  assert.ok(!/<script/i.test(html), 'a snapshot must carry no scripts');
  assert.deepEqual(outsideReferences(html), [], 'a snapshot must ask for nothing outside itself');
  assert.ok(!html.includes(gone), 'a snapshot must not name the server it came from');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/, 'the icon is inlined');

  const svg = html.slice(html.indexOf('<div class="card">'), html.indexOf('<div class="cols">'));
  for (const id of ['gw', 'svc', 'db']) assert.match(svg, new RegExp(`data-node="${id}"`), `the drawing lost ${id}`);
  // lettered in capitals, as the board draws them
  for (const label of ['GATEWAY', 'ORDERS', 'LEDGER']) assert.ok(svg.includes(`>${label}<`), `the drawing lost "${label}"`);

  const flow = html.slice(html.indexOf('<h2>The flow</h2>'), html.indexOf('<h2>What was said</h2>'));
  assert.match(flow, /<span class="n">1<\/span>the gateway calls orders/);
  assert.match(flow, /<li class="on"><span class="n">2<\/span>orders writes the row/);

  const said = html.slice(html.indexOf('<h2>What was said</h2>'));
  assert.match(said, /<li>Opening line, about the whole board\.<\/li>/);
  assert.match(said, /<span class="tag">step 1<\/span>The gateway speaks gRPC to orders\./);
  assert.match(said, /<li class="on"><span class="tag">step 2<\/span>Then a row lands in the ledger\./);
});

await test('the bare SVG, off disk, asks for nothing either', () => {
  const svg = fs.readFileSync(files['board.svg'], 'utf8');
  assert.ok(!/<script/i.test(svg));
  assert.deepEqual(outsideReferences(svg), []);
  assert.match(svg, /data-node="gw"/);
});

/* The export is the live page, so it does carry scripts — every one of them
   inlined. What it must not do is reach for a module, or anything else, that
   was only ever on the server. */
await test('the export, off disk with no server running, resolves every module inside itself', () => {
  const html = fs.readFileSync(files['export.html'], 'utf8');
  assert.deepEqual(outsideReferences(html), [], 'an export must ask for nothing outside itself');
  assert.ok(!html.includes(gone), 'an export must not name the server it came from');
  assert.doesNotMatch(html, /from '\/src\//, 'a module left pointing at the server');

  const config = html.match(/<script>window\.__SPIEGA_EXPORT__=(.*?)<\/script>/)?.[1];
  assert.ok(config, 'the board state is inlined');
  const state = JSON.parse(config);
  assert.deepEqual(state.board.nodes.map(x => x.id), ['gw', 'svc', 'db']);
  assert.equal(state.board.transcript.length, 3);
  assert.equal(state.board.flow.length, 2);

  /* The bundle is the whole page: one inline module that imports nothing, so
     there is no specifier left for a file:// URL to fail to resolve. */
  const modules = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(modules.length, 1, 'one inline bundle');
  assert.deepEqual(specifiers(modules[0]), [], 'the bundle imports nothing');
  assert.ok(html.indexOf('__SPIEGA_EXPORT__') < html.indexOf('<script type="module">'),
    'the state is there before the bundle that reads it');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} passed`);
