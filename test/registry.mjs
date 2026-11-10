/* Which boards exist, as opposed to which are open (#101).

   Run with `node test/registry.mjs`. Its own process because the state
   directory is read once, at import, from HOME: these tests want a temp home.

   What is being protected is the difference between the two questions. The
   registry is a liveness map and a restart empties it, so for a while the
   answer to "which boards do I have" was "the one this server happens to
   hold" — thirteen logs on disk, one board listed, and the other twelve
   reported as not running. So: a log is a board, listing never costs a
   restore, asking for one by its url does restore it, and a name with no log
   is still gone. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-registry-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer, savedBoards, listBoards, registerBoard, boardFile, BOARDS_DIR, BOARDS_FILE } =
  await import('../src/board/server.js');

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
  return {
    app, root, U: `${root}/b/${name}`,
    async close() {
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

const listing = async root => (await (await fetch(root + '/boards')).json()).boards;
const registry = () => { try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8')); } catch { return {}; } };
const byName = (list, name) => list.find(b => b.name === name);

/* A board nobody has ever held: just its log, written the way a previous
   server would have left it. */
const logOnDisk = (name, ops, { written = null } = {}) => {
  const file = boardFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ops.map(op => JSON.stringify(op)).join('\n') + '\n');
  if (written != null) fs.utimesSync(file, written / 1000, written / 1000);
  return file;
};

const drawing = label => [
  { op: 'title', text: label },
  { op: 'node', id: 'a', label: 'A' },
  { op: 'node', id: 'b', label: 'B' },
  { op: 'edge', from: 'a', to: 'b', label: 'calls' },
  { op: 'say', text: `What ${label} was about.` },
];

/* ---------- the directory is the truth about which boards exist ---------- */

await test('a log on disk is a saved board, whether or not anything holds it', async () => {
  logOnDisk('on-disk', drawing('On disk'));
  const names = savedBoards().map(s => s.name);
  assert.ok(names.includes('on-disk'), `expected on-disk among ${JSON.stringify(names)}`);

  const a = await listen('held');
  try {
    const list = await listing(a.root);
    assert.equal(byName(list, 'held').open, true, 'the board this server holds is open');
    assert.equal(byName(list, 'on-disk').open, false, 'the one that is only a file is not');
    assert.ok(byName(list, 'on-disk').url.endsWith('/b/on-disk'), 'a saved board still has a url');
  } finally { await a.close(); }
});

await test('the lock and tmp files beside a log are not boards', async () => {
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  fs.writeFileSync(path.join(BOARDS_DIR, 'on-disk.jsonl.lock'), '424242');
  fs.writeFileSync(path.join(BOARDS_DIR, 'on-disk.jsonl.tmp-1-2'), '{}\n');
  const names = savedBoards().map(s => s.name);
  assert.deepEqual(names.filter(x => x.startsWith('on-disk')), ['on-disk']);
});

await test('saved boards come back newest-written first', async () => {
  const now = Date.now();
  logOnDisk('older', drawing('Older'), { written: now - 3 * 86400_000 });
  logOnDisk('newer', drawing('Newer'), { written: now - 60_000 });
  const names = savedBoards().map(s => s.name);
  assert.ok(names.indexOf('newer') < names.indexOf('older'),
    `newest first, got ${JSON.stringify(names)}`);
});

/* ---------- a restart loses the registry, not the boards ---------- */

await test('a board drawn before a restart is still listed after it', async () => {
  const a = await listen('survivor');
  assert.equal((await send(a.U, drawing('Survivor'))).ok, true);
  await a.app.flush();
  await a.close();

  /* A fresh process, started for some other board — which is exactly the
     restart that used to leave twelve boards invisible. */
  const b = await listen('something-else');
  try {
    const list = await listing(b.root);
    const row = byName(list, 'survivor');
    assert.ok(row, 'the board that was drawn before the restart is in the list');
    assert.equal(row.open, false, 'and it is listed as not open');
  } finally { await b.close(); }
});

await test('starting a server does not load every board on disk', async () => {
  for (let i = 0; i < 12; i++) logOnDisk(`crowd-${i}`, drawing(`Crowd ${i}`));
  const a = await listen('crowd-host');
  try {
    assert.deepEqual([...a.app.boards.keys()], ['crowd-host'],
      'a server holds the board it was started for and nothing else');
    // and reading the list is not a restore either
    const list = await listing(a.root);
    assert.ok(list.length > 12, 'all of them are listed');
    assert.deepEqual([...a.app.boards.keys()], ['crowd-host'], 'listing holds nothing');
  } finally { await a.close(); }
});

/* ---------- asking for one by name is asking for it ---------- */

await test('opening a saved board by its url brings the drawing back', async () => {
  logOnDisk('reopen-me', drawing('Reopen me'));
  const a = await listen('other');
  try {
    assert.equal((await fetch(a.root + '/b/reopen-me/')).status, 200, 'the page is served');
    assert.ok(a.app.boards.has('reopen-me'), 'and the board is now held');
    const st = await (await fetch(a.root + '/b/reopen-me/state')).json();
    assert.equal(st.title, 'Reopen me');
    assert.deepEqual(st.nodes.map(x => x.id), ['a', 'b']);
    assert.deepEqual(st.transcript.map(x => x.text), ['What Reopen me was about.']);
    // open now, so it is in the registry the way any other open board is
    assert.ok('reopen-me' in listBoards({ prune: false }));
  } finally { await a.close(); }
});

await test('a name with no log is still gone, on the page and on the api', async () => {
  const a = await listen('only-me');
  try {
    const page = await fetch(a.root + '/b/nothing-here/');
    assert.equal(page.status, 404);
    assert.match(await page.text(), /No board named/);
    assert.equal((await fetch(a.root + '/b/nothing-here/state')).status, 404);
    assert.ok(!a.app.boards.has('nothing-here'), 'and asking for it created nothing');
  } finally { await a.close(); }
});

await test('the api routes of a saved board stay 404 until something opens it', async () => {
  logOnDisk('closed-api', drawing('Closed api'));
  const a = await listen('api-host');
  try {
    /* A client polling a name reads 404 as "gone, go and start one". Holding
       a board on /state would make every poll a restore. */
    assert.equal((await fetch(a.root + '/b/closed-api/state')).status, 404);
    assert.ok(!a.app.boards.has('closed-api'));
  } finally { await a.close(); }
});

/* ---------- the index page ---------- */

await test('the index lists saved boards, marked as not open', async () => {
  logOnDisk('index-saved', drawing('Index saved'));
  const a = await listen('index-open');
  try {
    const r = await fetch(a.root + '/', { redirect: 'manual' });
    assert.equal(r.status, 200, 'one open board beside a saved one is a list, not a redirect');
    const html = await r.text();
    assert.match(html, /href="\/b\/index-open\/"/);
    assert.match(html, /href="\/b\/index-saved\/"/);
    assert.match(html, /index-saved<\/a> <span[^>]*>closed</);
  } finally { await a.close(); }
});

await test('one board and nothing else still redirects to it', async () => {
  // in memory, so there is nothing saved anywhere for this server to list
  const a = await listen('alone', { persist: false });
  try {
    const r = await fetch(a.root + '/', { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/b/alone/');
    const list = await listing(a.root);
    assert.deepEqual(list.map(b => b.name), ['alone'], 'and it lists only itself');
  } finally { await a.close(); }
});

/* ---------- the registry still prunes what is really gone ---------- */

await test('an entry whose process has gone is still pruned', async () => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(dead > 0, 'needed a pid that has certainly exited');
  const all = registry();
  all['ghost'] = { url: 'http://127.0.0.1:4777/b/ghost', pid: dead, started: Date.now(), owner: null, cwd: null };
  fs.mkdirSync(path.dirname(BOARDS_FILE), { recursive: true });
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(all, null, 2) + '\n');

  assert.ok('ghost' in listBoards({ prune: false }), 'there to begin with');
  assert.ok(!('ghost' in listBoards()), 'and pruned on read');
  assert.ok(!('ghost' in registry()), 'and out of the file');
});

await test('a pruned board with a log is still a saved board', async () => {
  logOnDisk('ghost', drawing('Ghost'));
  registerBoard('ghost', 'http://127.0.0.1:4777/b/ghost', null, null);
  const all = registry();
  all['ghost'].pid = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(all, null, 2) + '\n');

  assert.ok(!('ghost' in listBoards()), 'the entry goes');
  assert.ok(savedBoards().some(s => s.name === 'ghost'), 'the board does not');
});

for (const s of SERVERS) { s.close(); s.closeAllConnections?.(); }
console.log(`\n  ${n} checks on the board registry\n`);
