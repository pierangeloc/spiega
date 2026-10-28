#!/usr/bin/env node
/* ============================================================
   handwave MCP server — the board as tools, for any MCP client.

   Newline-delimited JSON-RPC over stdio, no dependencies. Every tool is a thin
   wrapper over the same HTTP board the CLI drives, so an agent on MCP and a
   human in a terminal can draw on one board at the same time.
   ============================================================ */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBoard } from '../board/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.js');

const KINDS = 'client, gateway, service, compute, datastore, cache, queue, external, note';

const alive = async url => {
  try { return (await fetch(url + '/state', { signal: AbortSignal.timeout(900) })).ok; }
  catch { return false; }
};

async function url() {
  let u = findBoard();
  if (u && await alive(u)) return u;
  const child = spawn(process.execPath, [CLI, 'serve', '--quiet'], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    u = findBoard();
    if (u && await alive(u)) return u;
  }
  throw new Error('could not start a board');
}

async function send(ops) {
  const u = await url();
  const r = await fetch(u + '/op', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: [].concat(ops) }),
  });
  const b = await r.json();
  if (b.errors?.length) throw new Error(b.errors.join('; '));
  return `${u} — ${b.nodes} boxes, ${b.edges} lines, ${b.steps} steps`;
}

/* ---------- tools ---------- */

const TOOLS = [
  {
    name: 'board_say',
    description:
      'Put a line of your explanation on the board\'s transcript, beside the drawing. ' +
      'Use it the way you would talk while drawing: one short sentence at a time, as you draw the thing it is about. ' +
      'Supports **bold** and `code`.',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: { text: { type: 'string', description: 'One sentence. Keep it short.' } },
    },
  },
  {
    name: 'board_draw',
    description:
      'Add things to the board. Pass one op or several. Ops:\n' +
      `  {"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}   kinds: ${KINDS}\n` +
      '  {"op":"edge","from":"gw","to":"orders","label":"gRPC","async":false}\n' +
      '  {"op":"note","label":"retries are capped at 3"}\n' +
      '  {"op":"boundary","label":"our VPC","members":["gw","orders"]}\n' +
      '  {"op":"step","edge":"gw>orders","step":"The gateway forwards the call"}\n' +
      '  {"op":"title","text":"Placing an order"}\n' +
      'Columns are derived from the edges, so draw a node and then the edge into it and it lands in the right place. ' +
      'Draw a few things at a time as you explain them — not the whole diagram in one call.',
    inputSchema: {
      type: 'object', required: ['ops'],
      properties: {
        ops: {
          description: 'One op object, or an array of them.',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
    },
  },
  {
    name: 'board_step',
    description:
      'Light up one step of the flow on the board: its line turns orange, both ends get a halo, ' +
      'everything else dims. Walk these in time with what you are saying. Omit `step` to clear the highlight.',
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'integer', description: 'Step number, counting from 1.' } },
    },
  },
  {
    name: 'board_clear',
    description: 'Wipe the board and start a new explanation.',
    inputSchema: {
      type: 'object',
      properties: { keepTitle: { type: 'boolean', description: 'Keep the current title.' } },
    },
  },
  {
    name: 'board_snapshot',
    description:
      'Save the board as one standalone HTML file — the drawing, the transcript and the numbered steps, ' +
      'no server needed. Use it when the explanation is finished and worth keeping.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Where to write it. Default ./board.html' } },
    },
  },
  {
    name: 'board_open',
    description:
      'Give the board a window of its own — chromeless, no tabs — and return its URL. ' +
      'Call this once, early, so the person can see what you are drawing. Starts a board if none is running.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'boolean', description: 'An ordinary browser tab instead of its own window.' },
        size: { type: 'string', description: 'Window size, e.g. "1200x900".' },
      },
    },
  },
  {
    name: 'board_url',
    description: 'The URL of the running board, without opening anything. Starts one if none is running.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function call(name, args = {}) {
  switch (name) {
    case 'board_say':
      return send([{ op: 'say', text: String(args.text ?? '') }]);

    case 'board_draw': {
      const ops = Array.isArray(args.ops) ? args.ops : [args.ops];
      return send(ops);
    }

    case 'board_step':
      return send([{ op: 'focus', step: args.step == null ? null : Number(args.step) - 1 }]);

    case 'board_clear':
      return send([{ op: 'clear', keepTitle: !!args.keepTitle }]);

    case 'board_snapshot': {
      const u = await url();
      const html = await (await fetch(u + '/snapshot')).text();
      const out = path.resolve(args.path || 'board.html');
      const fs = await import('node:fs');
      fs.writeFileSync(out, html);
      return `saved ${out}`;
    }

    case 'board_open': {
      const u = await url();
      const { openBoard } = await import('../board/open.js');
      const r = openBoard(u, { app: !args.tab, size: args.size });
      return `${u} — opened in ${r.how}`;
    }

    case 'board_url':
      return await url();

    default:
      throw new Error(`no such tool "${name}"`);
  }
}

/* ---------- JSON-RPC over stdio ---------- */

const write = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32000, message } });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'handwave', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || id == null) return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await call(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: 'handwave: ' + e.message }], isError: true });
    }
  }
  if (method === 'ping') return ok(id, {});
  fail(id, `unknown method "${method}"`);
}
