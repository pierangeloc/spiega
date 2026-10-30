/* A board that is not being saved has to say so.

   Run with `node test/saving.mjs`. Its own process and its own HOME, for the
   same reason test/persist.mjs needs one: the state directory is read at
   import. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-saving-'));
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

const SERVERS = new Set();
const listen = async (name, opts = {}) => {
  const app = createServer({ name, persist: true, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  SERVERS.add(app.server);
  return { app, U: `http://127.0.0.1:${app.server.address().port}/b/${name}` };
};
const whoami = async U => (await fetch(U + '/whoami')).json();

/* The first line of the stream, without waiting for an op: a board is already
   not being saved by the time a browser opens it. */
const firstSaving = async U => {
  const res = await fetch(U + '/events', { headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  let buf = '';
  try {
    for (let i = 0; i < 20; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      const m = buf.match(/event: saving\ndata: (.*)\n/);
      if (m) return JSON.parse(m[1]);
    }
  } finally { try { await reader.cancel(); } catch {} }
  throw new Error('no saving event on the stream');
};

await test('the server that owns the file says it is saving', async () => {
  const { U } = await listen('owned');
  assert.equal((await whoami(U)).saving, true);
  assert.equal((await firstSaving(U)).saving, true);
});

await test('a second server on the same board says it is not, and why', async () => {
  const a = await listen('contended');
  const b = await listen('contended');
  assert.equal((await whoami(a.U)).saving, true);

  const s = await whoami(b.U);
  assert.equal(s.saving, false);
  assert.equal(s.why, 'other-server');
  // the stream and /whoami must agree; /whoami carries the board's name and pid too
  const onStream = await firstSaving(b.U);
  assert.deepEqual(onStream, { saving: s.saving, why: s.why, file: s.file });
});

await test('the warning is on the stream before anything is drawn', async () => {
  const a = await listen('earlyword');
  const b = await listen('earlyword');
  const s = await firstSaving(b.U);
  assert.equal(s.saving, false, 'a board must say it is unsaved on connect, not after the first op');
  await a.app.flush();
});

await test('the losing server really does not write, so the warning is true', async () => {
  const a = await listen('truthful');
  const b = await listen('truthful');
  const post = (U, ops) => fetch(U + '/op', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ops),
  });
  await post(b.U, [{ op: 'node', id: 'ghost', kind: 'service', label: 'Ghost' }]);
  await post(a.U, [{ op: 'node', id: 'real', kind: 'service', label: 'Real' }]);
  await a.app.flush(); await b.app.flush();

  const file = path.join(HOME, '.spiega', 'boards', 'truthful.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('real'), 'the owner writes');
  assert.ok(!text.includes('ghost'), 'the second server must not write, which is what it is warning about');
});

await test('an in-memory board is not a warning', async () => {
  const { U } = await listen('inmemory', { persist: false });
  const s = await whoami(U);
  assert.equal(s.saving, false);
  assert.equal(s.why, 'memory', 'tests and one-off renders are meant to be in memory');
});

/* The board's own half. There is no browser here, so the real function is
   lifted out of the real file and run against a stub: it checks the thing that
   actually breaks — which payloads raise the banner and what it says — rather
   than how it looks. */
await test('the board raises the banner for exactly the boards that are not saved', async () => {
  const html = fs.readFileSync(new URL('../src/board/board.html', import.meta.url), 'utf8');
  const src = html.match(/function setSaving\(s\) \{[\s\S]*?\n\}/);
  assert.ok(src, 'setSaving must exist in board.html');

  const els = { unsaved: { hidden: true }, unsavedwhy: { textContent: '' } };
  const setSaving = new Function('$', src[0] + '; return setSaving;')(id => els[id]);
  const shown = payload => {
    els.unsaved.hidden = true; els.unsavedwhy.textContent = '';
    setSaving(payload);
    return els.unsaved.hidden ? null : els.unsavedwhy.textContent;
  };

  assert.equal(shown({ saving: true, file: '/x' }), null, 'a saved board says nothing');
  assert.equal(shown({ saving: false, why: 'memory' }), null, 'in memory by design is not a warning');
  assert.match(shown({ saving: false, why: 'other-server', file: '/x' }), /another spiega/);
  assert.match(shown({ saving: false, why: 'other-server', file: '/x' }), /will not survive|survive a restart/);
  assert.match(shown({ saving: false, why: 'unwritable', file: '/x' }), /could not be opened/);

  assert.match(html, /addEventListener\('saving'/,
    'the banner is useless if nothing listens for the event the server sends');
});

for (const s of SERVERS) s.close();
console.log(`\n${n} passed`);
