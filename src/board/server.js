/* ============================================================
   spiega server — holds every board on this machine, streams each to whoever
   is watching it.

   One process, many boards, because the arithmetic was indefensible the other
   way round: the Node runtime is 55-70 MB and a board with nine boxes is a few
   KB of state, so eight parallel tasks spent ~600 MB holding a few hundred KB
   of drawing. A board lives at /b/<name>/; the renderer under /src/ is served
   once and shared by all of them.

   The other reason is staleness. A server per board meant a board started
   before an update kept serving the old page for as long as it lived, which
   has already produced a board that 404'd on a route the code had — where the
   isolation a server per board bought us had never once been needed.

   No dependencies and no build step: the browser imports the same renderer
   modules the CLI does, straight off disk as ES modules. A board you can run
   with `node src/cli.js serve` and nothing else is the point of the thing.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps, boardOps } from './state.js';
import { restoreBoard, createLog, boardLogFile } from './log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SESSION_DIR = path.join(os.homedir(), '.spiega');

/* The old name's variables still work.

   An MCP registration written before the rename carries HANDWAVE_BOARD, and so
   does any shell alias or script someone wrote. Honouring both for a while
   costs one function and means a half-updated machine keeps working, which is
   the state every machine is in during a rename. */
const envVar = name => process.env[`SPIEGA_${name}`] ?? process.env[`HANDWAVE_${name}`];
/* Read, never written any more. It held the url of the one board there used to
   be, back when that board answered /state and /op at its root. A board is now
   at /b/<name>, so writing this file would record a url that nothing here
   serves; reading it still finds a board started before any of that, which is
   the only reason it existed. */
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json');
/* The boards themselves: one append-only JSONL op log each. */
export const BOARDS_DIR = path.join(SESSION_DIR, 'boards');
export const boardFile = name => boardLogFile(BOARDS_DIR, name);

/* The canonical port, and the lock on being the server — see `listen`. */
export const PORT = Number(envVar('PORT')) || 4777;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.css': 'text/css' };

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 4e6) reject(new Error('body too large')); });
  req.on('end', () => resolve(b));
  req.on('error', reject);
});

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function createServer({ board = null, name = DEFAULT_BOARD, persist = false, debounce = 100 } = {}) {
  /* name -> { name, board, clients, log }. Nothing else in the process is per
     board: the renderer, the port and the HTTP server are shared. Tests and
     one-off renders stay in memory; `startBoard` turns persistence on. */
  const boards = new Map();

  const load = nm => {
    if (!persist) return { board: emptyBoard(), lines: 0, tail: true };
    try { return restoreBoard(boardFile(nm)); }
    catch { return { board: emptyBoard(), lines: 0, tail: true }; }
  };

  const hold = (nm, b = null) => {
    const held = boards.get(nm);
    if (held) return held;
    const loaded = b ? { board: b, lines: 0, tail: true } : load(nm);
    const entry = { name: nm, board: loaded.board, clients: new Set(), started: Date.now(), log: null };
    boards.set(nm, entry);
    if (persist) {
      try {
        entry.log = createLog(boardFile(nm), {
          lines: loaded.lines, tail: loaded.tail, debounce,
          snapshot: () => boardOps(entry.board),
        });
      } catch (e) {
        // An unwritable state directory must not stop the board being drawn on.
        console.error(`spiega: could not open the log for "${nm}": ${e.message}`);
      }
    }
    return entry;
  };

  /* Whether what is drawn here is reaching the file, and if not, why.

     A board that is not being saved still draws perfectly, which is the whole
     problem: it looks exactly like one that is. The lock is taken when the
     board is first held, so this does not change under us — a second server
     never becomes the owner while the first is alive. `memory` is not a
     warning: tests and one-off renders are meant to be in memory. */
  const saving = entry => {
    if (!persist) return { saving: false, why: 'memory' };
    if (!entry.log) return { saving: false, why: 'unwritable', file: boardFile(entry.name) };
    if (!entry.log.owner) return { saving: false, why: 'other-server', file: entry.log.file };
    return { saving: true, file: entry.log.file };
  };

  const drop = async nm => {
    const entry = boards.get(nm);
    if (!entry) return false;
    boards.delete(nm);
    for (const c of entry.clients) { try { c.end(); } catch { /* already gone */ } }
    await entry.log?.close();
    return true;
  };

  const broadcast = (entry, event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of entry.clients) { try { c.write(frame); } catch { entry.clients.delete(c); } }
  };

  const first = hold(name, board);

  /* Where this server is, as the client that is talking to us sees it. Taken
     from the request rather than from what `listen` recorded, so a server
     bound to an ephemeral port (every test in this repo) still hands out urls
     that work. */
  const baseOf = req => app.url || `http://${req.headers.host || `127.0.0.1:${PORT}`}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
      return res.end();
    }
    res.setHeader('access-control-allow-origin', '*');

    // the renderer, served as plain modules for the browser — one copy, every board
    /* The mark, for the tab. It lives in docs/ with the rest of the brand and
       is served from one place rather than copied into src/. */
    if (p === '/icon.svg') return serveFile(res, path.join(ROOT, 'docs', 'logo', 'spiega-mark.svg'));

    if (p.startsWith('/src/') && !p.includes('..')) {
      return serveFile(res, path.join(ROOT, p.slice(1)));
    }

    /* The board list, which is also how a client tells a spiega server from
       whatever else might be holding the port. */
    if (p === '/boards') {
      if (req.method === 'POST') {
        let want;
        try { want = JSON.parse(await readBody(req)); }
        catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON: ' + e.message }); }
        const nm = slug(want.name || DEFAULT_BOARD);
        const created = !boards.has(nm);
        hold(nm);
        const boardUrl = `${baseOf(req)}/b/${nm}`;
        /* Register on the asking client's behalf, since it is the one whose
           session owns the board. Only when there is no entry: re-registering
           an existing board would overwrite the owner that the session which
           first asked for it recorded, and the owner match is how that session
           keeps finding the same board. */
        if (created || !(nm in listBoards({ prune: false }))) {
          registerBoard(nm, boardUrl, want.owner ?? null, want.cwd || null);
        }
        return json(res, 200, { ok: true, name: nm, url: boardUrl, created });
      }
      return json(res, 200, {
        ok: true, pid: process.pid, url: baseOf(req),
        boards: [...boards.values()].map(e => ({
          name: e.name, url: `${baseOf(req)}/b/${e.name}`,
          rev: e.board.rev, nodes: e.board.nodes.length, viewers: e.clients.size,
        })),
      });
    }

    if (p === '/' || p === '/index.html') return index(res, boards);

    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) { res.writeHead(404); return res.end('not found'); }
    const nm = decodeURIComponent(m[1]);

    /* /b/<name> is the board; the page lives at /b/<name>/ because it resolves
       its own api off its own path, and without the slash that path is /b/. */
    if (m[2] == null) {
      res.writeHead(302, { location: `/b/${encodeURIComponent(nm)}/` });
      return res.end();
    }
    const rest = m[2];

    const entry = boards.get(nm);
    if (!entry) {
      // A client holding a registry entry we no longer honour needs to hear
      // "gone", not "broken": that is what sends it off to start a board.
      if (rest === '/') {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><meta charset=utf-8><title>no board</title>` +
          `<body style="font:14px system-ui;padding:3rem">No board named <b>${esc(nm)}</b> here. ` +
          `<a href="/">The ones there are</a>.`);
      }
      return json(res, 404, { ok: false, error: `no board named "${nm}"` });
    }
    const board = entry.board;

    if (rest === '/') return serveFile(res, path.join(HERE, 'board.html'));
    if (rest === '/state') return json(res, 200, board);
    // who this board is, for the window title and for `spiega boards`
    if (rest === '/whoami') return json(res, 200, { name: entry.name, pid: process.pid, ...saving(entry) });

    if (rest === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: state\ndata: ${JSON.stringify(board)}\n\n`);
      /* Said on connect rather than only when it goes wrong: the board is
         already not being saved by the time anyone opens it. */
      res.write(`event: saving\ndata: ${JSON.stringify(saving(entry))}\n\n`);
      entry.clients.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ka); entry.clients.delete(res); });
      return;
    }

    if (rest === '/op' && req.method === 'POST') {
      let ops;
      try { ops = JSON.parse(await readBody(req)); }
      catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON: ' + e.message }); }
      const { fresh, errors, applied } = applyOps(board, ops.ops || ops);
      /* No file I/O and no await here: the ops go into the log writer's buffer
         and the flush happens on its own timer. This route is on the critical
         path of somebody talking. */
      if (applied.length) entry.log?.push(applied);
      broadcast(entry, 'patch', { board, fresh });
      return json(res, errors.length ? 207 : 200, {
        ok: !errors.length, errors, rev: board.rev,
        nodes: board.nodes.length, edges: board.edges.length, steps: board.flow.length,
        viewers: entry.clients.size,
      });
    }

    /* Play the session back, on request from the CLI or the agent. The log is
       already here, so re-running an explanation costs nothing and the model
       never has to think the drawing out a second time. */
    if (rest === '/replay') {
      const drawable = board.log.filter(e => e.op !== 'focus' && e.op !== 'clear').length;
      if (drawable) broadcast(entry, 'replay', { rev: board.rev });
      return json(res, 200, { ok: !!drawable, ops: drawable, viewers: entry.clients.size });
    }

    /* Let this board go, and leave the other seven drawing. One process holds
       all of them, so stopping one is a map deletion, not a kill. */
    if (rest === '/close' && req.method === 'POST') {
      await drop(nm);
      unregisterBoard(nm);
      return json(res, 200, { ok: true, name: nm, left: boards.size });
    }

    // The board as one standalone file, for pasting into a PR or a doc.
    if (rest === '/snapshot') {
      const { snapshotHTML } = await import('./snapshot.js');
      const html = snapshotHTML(board, { active: url.searchParams.get('step') });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (rest === '/snapshot.svg') {
      const { renderSVG } = await import('../render/render.js');
      const { svg } = renderSVG(board, { margin: 16, active: board.active });
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(svg);
    }

    res.writeHead(404); res.end('not found');
  });

  server.on('close', () => {
    for (const e of boards.values()) {
      for (const c of e.clients) { try { c.end(); } catch {} }
      e.log?.close();
    }
  });

  const app = {
    server, boards, hold, drop, broadcast, name, url: null, board: first.board,
    // lets a test (or a shutdown path) wait for the buffer to reach the file
    flush: () => Promise.all([...boards.values()].map(e => e.log?.flush())),
  };
  return app;
}

/* The bare port, for someone who typed it without a board name. One board is
   almost certainly the one they wanted. */
function index(res, boards) {
  const names = [...boards.keys()];
  if (names.length === 1) {
    res.writeHead(302, { location: `/b/${encodeURIComponent(names[0])}/` });
    return res.end();
  }
  const rows = names.map(n => `<li><a href="/b/${encodeURIComponent(n)}/">${esc(n)}</a></li>`).join('');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><meta charset=utf-8><title>spiega boards</title>` +
    `<body style="font:14px system-ui;padding:3rem"><h1 style="font-weight:600">spiega</h1>` +
    (rows ? `<ul>${rows}</ul>` : `<p>No boards yet.`));
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ---------- the board registry ----------

   One machine, several boards. A board belongs to a conversation, and people
   hold more than one at a time: a Claude Code session on one problem, an
   opencode session on another. Sharing a single board between them interleaves
   two explanations into one drawing, which is worse than having no board.

   So boards have names, and a name is all a client needs. The registry maps
   name to url; a board whose server has gone is pruned on read, because a
   stale entry sends ops into a socket nobody is listening on.

   Since one process serves them all, every entry carries the same pid — the
   registry is a name-to-path map now rather than a list of live processes. */
export const BOARDS_FILE = path.join(SESSION_DIR, 'boards.json');
export const SERVER_FILE = path.join(SESSION_DIR, 'server.json');
export const DEFAULT_BOARD = 'default';

const readBoards = () => {
  try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8')); } catch { return {}; }
};

const writeBoards = all => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(all, null, 2) + '\n');
};

const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/* Every board we still believe in. `prune` drops the ones whose process is
   gone — cheap, since it is a signal-0, not a request. */
export function listBoards({ prune = true } = {}) {
  const all = readBoards();
  if (!prune) return all;
  const live = {};
  let changed = false;
  for (const [name, b] of Object.entries(all)) {
    if (b && b.pid && !running(b.pid)) { changed = true; continue; }
    live[name] = b;
  }
  if (changed) writeBoards(live);
  return live;
}

/* Who a board belongs to — or nobody.

   A board asked for by name belongs to the asking, not to the session that did
   the asking. Recording the session as its owner means one `--board notes` call
   silently rebinds that session's default board to "notes" for good, because
   the owner match comes first when resolving a name. Measured: three
   `--board` calls from one shell left all three boards claiming it. */
export function ownerOfThisProcess() {
  return envVar('BOARD') ? null : sessionKey();
}

export function registerBoard(name, url, owner = ownerOfThisProcess(), cwd = process.cwd()) {
  const all = readBoards();
  all[name] = { url, pid: process.pid, started: Date.now(), owner, cwd };
  writeBoards(all);
}

export function unregisterBoard(name) {
  const all = readBoards();
  if (!(name in all)) return false;
  delete all[name];
  writeBoards(all);
  return true;
}

/* ---------- the one server ----------

   Where it is, written by whoever won the port. Clients read it to decide
   between asking for a board and starting a process. */
export function readServer() {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    if (s && s.url && s.pid && running(s.pid)) return s;
  } catch { /* none, or unreadable */ }
  return null;
}

export const findServer = () => readServer()?.url ?? null;

const writeServer = url => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ url, pid: process.pid, started: Date.now() }, null, 2) + '\n');
};

/* Is a board answering at this url? */
export async function alive(url) {
  try { return (await fetch(url + '/state', { signal: AbortSignal.timeout(900) })).ok; }
  catch { return false; }
}

/* Is the thing holding this port one of ours? Something else on 4777 must not
   be mistaken for a server with no boards on it. */
export async function spiegaAt(url) {
  try {
    const r = await fetch(url + '/boards', { signal: AbortSignal.timeout(900) });
    if (!r.ok) return false;
    return Array.isArray((await r.json()).boards);
  } catch { return false; }
}

/* Ask the running server for a board, creating it if it has none by that name.
   A board is a map entry, so this is cheaper than anything that forks. */
export async function createBoardOn(serverUrl, name, { owner = ownerOfThisProcess(), cwd = process.cwd() } = {}) {
  try {
    const r = await fetch(serverUrl + '/boards', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, owner, cwd }), signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    return (await r.json()).url || null;
  } catch { return null; }
}

/* ---------- names ----------

   What counts as "this session".

   Not the harness. Someone runs four opencode tasks and four Claude Code tasks
   at once, so a board per harness is barely better than a board for everyone.
   It has to be a board per task.

   Most precise first. A harness that names its own conversation wins, then the
   terminal pane, which is exactly one task. The directory is last but it is the
   one that always exists, and it carries further than the others: an opencode
   MCP server is a child of one long-lived `opencode serve --service` daemon and
   inherits the environment that daemon started with — sixteen of them on this
   machine shared a single HERDR_PANE_ID — so env is reliable from the CLI in
   the pane, and stale from MCP.

   The tab is deliberately below the pane: one tab here holds a Claude session,
   an opencode session, a board window and a shell. Tabs are not tasks.

   Two sessions do sometimes share a directory — two Claude conversations about
   the same repo — and then the names collide and the second is suffixed. If
   that reads badly, `--board NAME` settles it, and `spiega boards` prints the
   directory of each so they can be told apart. */
export function sessionKey() {
  return envVar('SESSION')
    || process.env.CLAUDE_CODE_SESSION_ID   // the conversation itself, where a harness says so
    || process.env.HERDR_PANE_ID            // one pane is one task
    || process.env.HERDR_TAB_ID
    || process.cwd();
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* A board name a person can recognise in a list of eight.

   The working directory's own name — which for a worktree is the task someone
   named themselves, like "domain-modeling-for-rights". Far better than a uuid,
   and it is already the word they would use out loud.

   A session that already has a board keeps it, matched on the session key, so
   the name is stable for as long as the work is. Only a genuine collision —
   two sessions, same directory name, different sessions — gets a suffix. */
export function boardName() {
  const named = envVar('BOARD');
  if (named) return slug(named);

  const key = sessionKey();
  const all = listBoards();

  for (const [name, b] of Object.entries(all)) {
    if (b.owner && b.owner === key) return name;       // this session's own board
  }
  // nothing claimed: fall through to naming one after the task

  const base = slug(path.basename(process.cwd())) || DEFAULT_BOARD;
  if (!all[base] || all[base].owner === key) return base;
  // Taken by another session in the same directory. Count: "croissant-calc-2"
  // is a name someone can say out loud, which a hash of a session id is not,
  // and the board is found by owner afterwards so the number never moves.
  for (let i = 2; i < 100; i++) if (!all[`${base}-${i}`]) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

/* ---------- starting and finding ----------

   Listen, and record what we now hold.

   The port is the lock on being the server. Two agents that draw at the same
   moment both find nothing running and both spawn one; whoever binds 4777 is
   the server, and the other is told where it is instead of standing a second
   one up beside it — which is the whole cost this is here to remove.

   `solo` is the way out if an isolation case ever turns up: a board on its own
   port, in its own process, reachable by exactly the same url shape, so no
   client has to know which it is talking to. */
export async function listen(app, { port = PORT, solo = false, tries = 20 } = {}) {
  const bind = n => new Promise((resolve, reject) => {
    const s = app.server;
    const onErr = e => {
      s.removeListener('error', onErr);
      if (e.code === 'EADDRINUSE') return resolve(false);
      reject(e);
    };
    s.once('error', onErr);
    s.listen(n, '127.0.0.1', () => { s.removeListener('error', onErr); resolve(true); });
  });

  for (let n = 0; n < tries; n++) {
    const at = `http://127.0.0.1:${port + n}`;
    if (await bind(port + n)) {
      app.url = at;
      if (!solo) writeServer(at);
      for (const name of app.boards.keys()) registerBoard(name, `${at}/b/${name}`);
      return { url: at, mine: true };
    }
    /* Held. If one of ours is there, that is the server: hand the board over
       rather than stand a second one up on the next port along. Anything else
       — someone else's service, a board from before all this — we walk past.

       Every rung is probed, not just the first. Checking only 4777 left the
       lock undone whenever something else held it: four agents starting at
       once each walked up to a different free port and each became a server,
       which is the exact outcome this is here to prevent. */
    if (!solo && await spiegaAt(at)) return { url: at, mine: false };
  }
  throw new Error(`no free port in ${port}..${port + tries - 1}`);
}

/* Serve a board: join the server that is running, or become it.

   `serving` tells the caller whether this process is now the one holding the
   board — `spiega serve` stays alive on true and exits on false, having done
   its job by asking the running server for one more map entry. */
export async function startBoard({ name = boardName(), port = PORT, solo = false } = {}) {
  if (!solo) {
    const server = findServer();
    if (server) {
      const url = await createBoardOn(server, name);
      if (url) return { url, serving: false };
    }
  }
  const app = createServer({ name, persist: true });
  const r = await listen(app, { port, solo });
  if (!r.mine) {
    await Promise.all([...app.boards.values()].map(e => e.log?.close()));
    const url = await createBoardOn(r.url, name);
    if (url) return { url, serving: false };
    throw new Error(`a spiega server answered on ${r.url} but would not take a board`);
  }
  /* `spiega stop --server` is a signal, not a request. Flush the last tick of
     ops on the way out so the common shutdown is not the hard crash that the
     budget allows us to lose. */
  const goodbye = () => { app.flush().finally(() => process.exit(0)); };
  process.once('SIGTERM', goodbye);
  process.once('SIGINT', goodbye);
  return { url: `${r.url}/b/${name}`, serving: true, app };
}

/* Where is the board this client should talk to?

   SPIEGA_URL is absolute and wins — it names a board directly, which is what
   a test or a script wants. Otherwise the name decides: SPIEGA_BOARD, which
   each harness's MCP registration can set, so a Claude session and an opencode
   session reach different boards without either knowing the other exists. */
export function findBoard(name = boardName()) {
  const direct = envVar('URL');
  if (direct) return direct;
  const all = listBoards();
  if (all[name]) return all[name].url;
  // a board from before the registry existed
  if (name === DEFAULT_BOARD) {
    try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).url; } catch { /* none */ }
  }
  return null;
}

/* The board this client should talk to, brought into existence if need be.

   Three rungs, cheapest first: the registry entry, which is a file read; one
   more board on the server that is already up, which is an http call and a map
   entry; and only then a process. An agent that draws as its first action
   should not have to run a server command first, and eight of them drawing at
   once should not cost eight processes. */
export async function resolveBoard(name = boardName(), { start = true } = {}) {
  const direct = envVar('URL');
  if (direct) return direct;

  const known = findBoard(name);
  if (known && await alive(known)) return known;

  if (!start) return null;

  const server = findServer();
  if (server && await spiegaAt(server)) {
    const url = await createBoardOn(server, name);
    if (url) return url;
  }
  return spawnServer();
}

/* No server anywhere: start one detached and wait for it to answer.

   The name is recomputed from the registry on each poll rather than asked for
   here, because the child decides it — `boardName()` matches a session to the
   board it owns, and the child is the one that registers the ownership. */
function spawnServer() {
  const out = fs.openSync(path.join(process.env.TMPDIR || '/tmp', 'spiega.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'serve', '--quiet'], {
    detached: true, stdio: ['ignore', out, out], env: process.env,
  });
  child.unref();
  return (async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      const url = findBoard();
      if (url && await alive(url)) return url;
    }
    return null;
  })();
}
