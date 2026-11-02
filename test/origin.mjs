/* Who is allowed to talk to the board server.

   Loopback is not a security boundary in a browser. The server answered
   `access-control-allow-origin: *` to everything, so any page the person had
   open could read every board — node labels, file paths, the whole script of
   the explanation — and write to it. These tests are the boundary, and they
   exist because the hole is invisible from the outside: nothing fails, the
   board just belongs to the internet.

   Run with `node test/origin.mjs`. Its own process and its own HOME, like
   test/saving.mjs: the state directory is read at import. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-origin-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer } = await import('../src/board/server.js');

let n = 0;
const test = async (name, fn) => {
  try { await fn(); n++; console.log('  ok  ' + name); }
  catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

const app = createServer({ name: 'secrets' });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const PORT = app.server.address().port;
const U = `http://127.0.0.1:${PORT}`;
const OURS = `http://127.0.0.1:${PORT}`;
const EVIL = 'https://evil.example';

const JSON_CT = { 'content-type': 'application/json' };
const OPS = JSON.stringify({ ops: [{ op: 'node', id: 'x', label: 'Internal Billing' }] });

/* `fetch` refuses to set Host — it is a forbidden header name — so the
   rebinding case has to go out over raw http with setHost off. */
const rawGet = (hostHeader, p = '/b/secrets/state') => new Promise(resolve => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers: { host: hostHeader }, setHost: false },
    r => { r.resume(); resolve(r.statusCode); });
  req.end();
});

await test('the CLI, the MCP server and curl send no Origin, and still draw', async () => {
  const r = await fetch(U + '/b/secrets/op', { method: 'POST', headers: JSON_CT, body: OPS });
  assert.equal(r.status, 200);
});

await test('the board page, on this origin, still draws', async () => {
  const r = await fetch(U + '/b/secrets/op',
    { method: 'POST', headers: { ...JSON_CT, origin: OURS }, body: OPS });
  assert.equal(r.status, 200);
});

await test('a page on the web cannot read a board', async () => {
  for (const p of ['/b/secrets/state', '/b/secrets/snapshot', '/b/secrets/snapshot.svg', '/boards']) {
    const r = await fetch(U + p, { headers: { origin: EVIL } });
    assert.equal(r.status, 403, `${p} should refuse a foreign origin`);
  }
});

await test('a page on the web cannot write to, or close, a board', async () => {
  const draw = await fetch(U + '/b/secrets/op',
    { method: 'POST', headers: { ...JSON_CT, origin: EVIL }, body: OPS });
  assert.equal(draw.status, 403);
  const close = await fetch(U + '/b/secrets/close', { method: 'POST', headers: { origin: EVIL } });
  assert.equal(close.status, 403);
  // and the board is still here, with only the two nodes the allowed calls drew
  const state = await (await fetch(U + '/b/secrets/state')).json();
  assert.equal(state.nodes.length, 1);
});

await test('another server on loopback is a different origin, not a friend', async () => {
  const r = await fetch(U + '/b/secrets/state', { headers: { origin: 'http://127.0.0.1:3000' } });
  assert.equal(r.status, 403);
});

await test('no response carries a CORS header for anyone to lean on', async () => {
  for (const p of ['/b/secrets/', '/b/secrets/state', '/boards']) {
    const r = await fetch(U + p);
    assert.equal(r.headers.get('access-control-allow-origin'), null, p);
  }
});

await test('a preflight is told nothing, rather than which methods exist', async () => {
  const r = await fetch(U + '/b/secrets/op', { method: 'OPTIONS', headers: { origin: EVIL } });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-methods'), null);
});

await test('a name rebound to 127.0.0.1 is refused on the Host header', async () => {
  assert.equal(await rawGet('evil.test'), 403);
  assert.equal(await rawGet('attacker.example:' + PORT), 403);
  // the two spellings a real page actually arrives with
  assert.equal(await rawGet('127.0.0.1:' + PORT), 200);
  assert.equal(await rawGet('localhost:' + PORT), 200);
});

await test('a simple cross-origin POST cannot slip past as text/plain', async () => {
  // no preflight is sent for text/plain, so this is the one that must not work
  const r = await fetch(U + '/b/secrets/op', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: OPS });
  assert.equal(r.status, 415);
  const mk = await fetch(U + '/boards', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"name":"sneaky"}' });
  assert.equal(mk.status, 415);
});

app.server.close();
console.log(`\n${n} passed`);
