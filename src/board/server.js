/* ============================================================
   handwave server — holds one board, streams it to whoever is watching.

   No dependencies and no build step: the browser imports the same renderer
   modules the CLI does, straight off disk as ES modules. A board you can run
   with `node src/cli.js serve` and nothing else is the point of the thing.
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from './state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SESSION_DIR = path.join(os.homedir(), '.handwave');
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

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

export function createServer({ board = emptyBoard() } = {}) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(frame); } catch { clients.delete(c); } }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' });
      return res.end();
    }
    res.setHeader('access-control-allow-origin', '*');

    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(HERE, 'board.html'));
    }
    // the renderer, served as plain modules for the browser
    if (p.startsWith('/src/') && !p.includes('..')) {
      return serveFile(res, path.join(ROOT, p.slice(1)));
    }
    if (p === '/state') return json(res, 200, board);

    if (p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: state\ndata: ${JSON.stringify(board)}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (p === '/op' && req.method === 'POST') {
      let ops;
      try { ops = JSON.parse(await readBody(req)); }
      catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON: ' + e.message }); }
      const { fresh, errors } = applyOps(board, ops.ops || ops);
      broadcast('patch', { board, fresh });
      return json(res, errors.length ? 207 : 200, {
        ok: !errors.length, errors, rev: board.rev,
        nodes: board.nodes.length, edges: board.edges.length, steps: board.flow.length,
        viewers: clients.size,
      });
    }

    /* Play the session back, on request from the CLI or the agent. The log is
       already here, so re-running an explanation costs nothing and the model
       never has to think the drawing out a second time. */
    if (p === '/replay') {
      const drawable = board.log.filter(e => e.op !== 'focus' && e.op !== 'clear').length;
      if (drawable) broadcast('replay', { rev: board.rev });
      return json(res, 200, { ok: !!drawable, ops: drawable, viewers: clients.size });
    }

    // The board as one standalone file, for pasting into a PR or a doc.
    if (p === '/snapshot') {
      const { snapshotHTML } = await import('./snapshot.js');
      const html = snapshotHTML(board, { active: url.searchParams.get('step') });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (p === '/snapshot.svg') {
      const { renderSVG } = await import('../render/render.js');
      const { svg } = renderSVG(board, { margin: 16, active: board.active });
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(svg);
    }

    res.writeHead(404); res.end('not found');
  });

  server.on('close', () => { for (const c of clients) { try { c.end(); } catch {} } });
  return { server, board, broadcast, clients };
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
   stale entry sends ops into a socket nobody is listening on. */
export const BOARDS_FILE = path.join(SESSION_DIR, 'boards.json');
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

export function registerBoard(name, url) {
  const all = readBoards();
  all[name] = { url, pid: process.pid, started: Date.now() };
  writeBoards(all);
}

export function unregisterBoard(name) {
  const all = readBoards();
  if (!(name in all)) return false;
  delete all[name];
  writeBoards(all);
  return true;
}

/* The name this process should use, when nothing says otherwise. */
export const boardName = () => process.env.HANDWAVE_BOARD || DEFAULT_BOARD;

/* Listen, trying the next port if one is taken, and register the board under
   its name so the CLI and the MCP server can find it again. */
export function listen(app, port = 4777, tries = 20, name = boardName()) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const s = app.server;
      const onErr = e => {
        s.removeListener('error', onErr);
        if (e.code === 'EADDRINUSE' && n < tries) return attempt(n + 1);
        reject(e);
      };
      s.once('error', onErr);
      s.listen(port + n, '127.0.0.1', () => {
        s.removeListener('error', onErr);
        const url = `http://127.0.0.1:${port + n}`;
        registerBoard(name, url);
        // session.json stays for the default board only, so anything older
        // than the registry keeps working
        if (name === DEFAULT_BOARD) {
          fs.mkdirSync(SESSION_DIR, { recursive: true });
          fs.writeFileSync(SESSION_FILE, JSON.stringify({ url, pid: process.pid, started: Date.now(), name }, null, 2));
        }
        resolve(url);
      });
    };
    attempt(0);
  });
}

/* Where is the board this client should talk to?

   HANDWAVE_URL is absolute and wins — it names a board directly, which is what
   a test or a script wants. Otherwise the name decides: HANDWAVE_BOARD, which
   each harness's MCP registration can set, so a Claude session and an opencode
   session reach different boards without either knowing the other exists. */
export function findBoard(name = boardName()) {
  if (process.env.HANDWAVE_URL) return process.env.HANDWAVE_URL;
  const all = listBoards();
  if (all[name]) return all[name].url;
  // a board from before the registry existed
  if (name === DEFAULT_BOARD) {
    try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).url; } catch { /* none */ }
  }
  return null;
}
