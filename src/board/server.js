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

/* Listen, trying the next port if one is taken, and leave a session file so the
   CLI and the MCP server can find a board that is already running. */
export function listen(app, port = 4777, tries = 20) {
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
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ url, pid: process.pid, started: Date.now() }, null, 2));
        resolve(url);
      });
    };
    attempt(0);
  });
}

/* Where is the running board? Env wins, then the session file. */
export function findBoard() {
  if (process.env.HANDWAVE_URL) return process.env.HANDWAVE_URL;
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return s.url;
  } catch { return null; }
}
