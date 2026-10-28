#!/usr/bin/env node
/* ============================================================
   handwave CLI — what the agent actually calls.

   The commands are shaped for an agent mid-sentence, not for a build script:
   one short call adds one thing to the board and returns immediately. If no
   board is running, `draw` starts one, so an agent never has to check first.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];

/* Accepts both `--out x` and the short `-o x`, since the help advertises both. */
const flag = (name, def = null) => {
  let i = argv.indexOf('--' + name);
  if (i < 0) i = argv.indexOf('-' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('-') ? v : true;
};
const positional = () => argv.slice(1).filter((a, i, all) =>
  !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && !all[i - 1].includes('=')));

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

/* ---------- talking to a running board ---------- */

async function boardURL({ autostart = false } = {}) {
  const { findBoard } = await import('./board/server.js');
  let url = findBoard();
  if (url && await alive(url)) return url;
  if (!autostart) return null;
  return startDetached();
}

async function alive(url) {
  try {
    const c = AbortSignal.timeout(900);
    const r = await fetch(url + '/state', { signal: c });
    return r.ok;
  } catch { return false; }
}

/* Start a board in the background and wait for it to answer. An agent that
   draws as its first action should not have to run a server command first. */
async function startDetached() {
  const out = fs.openSync(path.join(process.env.TMPDIR || '/tmp', 'handwave.log'), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'cli.js'), 'serve', '--quiet'], {
    detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    const { findBoard } = await import('./board/server.js');
    const url = findBoard();
    if (url && await alive(url)) return url;
  }
  die('handwave: could not start a board (see $TMPDIR/handwave.log)');
}

async function send(ops, { quiet = false } = {}) {
  const url = await boardURL({ autostart: true });
  const res = await fetch(url + '/op', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops }),
  });
  const body = await res.json().catch(() => ({}));
  if (!quiet) {
    if (body.errors?.length) console.error(body.errors.join('\n'));
    console.log(`${url}  ${body.nodes ?? 0} boxes, ${body.edges ?? 0} lines, ${body.steps ?? 0} steps`);
  }
  return body;
}

/* Ops may arrive as one object, an array, JSON on stdin, or a file path. */
async function readOps(arg) {
  let raw = arg;
  if (!raw || raw === '-') raw = fs.readFileSync(0, 'utf8');
  else if (!raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('[') && fs.existsSync(raw)) {
    raw = fs.readFileSync(raw, 'utf8');
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { die(`handwave: that is not valid JSON (${e.message})`); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed.ops) return parsed.ops;
  // A whole spec, not an op list: turn it into the ops that would build it.
  if (parsed.nodes || parsed.edges) return specToOps(parsed);
  return [parsed];
}

export function specToOps(spec) {
  const ops = [];
  if (spec.title) ops.push({ op: 'title', text: spec.title });
  for (const n of spec.nodes || []) ops.push({ op: 'node', ...n });
  for (const e of spec.edges || []) ops.push({ op: 'edge', ...e });
  for (const b of spec.boundaries || []) ops.push({ op: 'boundary', ...b });
  if (spec.flow?.length) ops.push({ op: 'flow', steps: spec.flow });
  for (const t of spec.transcript || []) ops.push({ op: 'say', text: t.text ?? t });
  return ops;
}

/* ---------- commands ---------- */

const HELP = `handwave — a hand-drawn board an agent draws on while it explains

  serve [--port N] [--open]     start the board and keep it running
  open [--tab] [--size WxH]     open the board in its own browser window
  draw <json|file|->            add to the board (one op, or a list, or a whole spec)
  say  <text>                   put a line in the transcript beside the drawing
  step [N|next|prev|off]        light up one step of the flow
  clear [--keep-title]          wipe the board
  render <spec.json> -o F.html  render a spec to a standalone file, no server
  snapshot [-o F.html]          save the live board as a standalone file
  url                           print the running board's URL
  stop                          stop the running board

Ops are small JSON objects:
  {"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}
  {"op":"edge","from":"gw","to":"orders","label":"gRPC","async":false}
  {"op":"note","label":"idempotency key\\nlives 24h"}
  {"op":"boundary","label":"our VPC","members":["gw","orders"]}
  {"op":"step","edge":"gw>orders","step":"Gateway forwards the call"}

kinds: client gateway service compute datastore cache queue external note

"open" gives the board a chromeless window of its own (Chrome/Brave/Edge app mode),
which is the right place to pan and zoom. A terminal pane has to push every frame
through the TTY, so it is good for glancing and for stepping a flow, not for roaming.
  --tab          an ordinary browser tab instead of its own window
  --size 1100x900 --pos 60,60
  --browser brave`;

const main = async () => {
  switch (cmd) {
    case 'serve': {
      const { createServer, listen } = await import('./board/server.js');
      const app = createServer();
      const url = await listen(app, Number(flag('port', 4777)));
      if (!flag('quiet')) console.log(`handwave listening on ${url}`);
      if (flag('open')) {
        const { openBoard } = await import('./board/open.js');
        openBoard(url, { app: !flag('tab'), size: flag('size'), browser: flag('browser') });
      }
      return;
    }

    case 'open': {
      const u = await boardURL({ autostart: true });
      const { openBoard } = await import('./board/open.js');
      const r = openBoard(u, {
        app: !flag('tab'), size: flag('size'), pos: flag('pos'), browser: flag('browser'),
      });
      console.log(`${u}  (${r.how})`);
      return;
    }

    case 'draw': case 'op':
      return void (await send(await readOps(argv[1])));

    case 'say': {
      const text = argv.slice(1).filter(a => !a.startsWith('--')).join(' ');
      if (!text) die('handwave say: nothing to say');
      return void (await send([{ op: 'say', text }]));
    }

    case 'step': {
      const a = argv[1];
      const url = await boardURL({ autostart: true });
      const state = await (await fetch(url + '/state')).json();
      let step;
      if (a === 'off' || a === 'none') step = null;
      else if (a === 'next') step = state.active == null ? 0 : state.active + 1;
      else if (a === 'prev') step = Math.max(0, (state.active ?? 0) - 1);
      else if (a == null) step = 0;
      else step = Number(a) - 1;                   // humans count from 1
      return void (await send([{ op: 'focus', step }]));
    }

    case 'clear':
      return void (await send([{ op: 'clear', keepTitle: !!flag('keep-title') }]));

    case 'render': {
      const file = argv[1];
      if (!file) die('handwave render: give me a spec file');
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { emptyBoard, applyOps } = await import('./board/state.js');
      const { snapshotHTML } = await import('./board/snapshot.js');
      const board = emptyBoard();
      applyOps(board, specToOps(spec));
      const html = snapshotHTML(board, { active: flag('step') ? Number(flag('step')) - 1 : null });
      const out = flag('o') || flag('out') || file.replace(/\.json$/, '') + '.html';
      fs.writeFileSync(out, html);
      console.log(out);
      return;
    }

    case 'snapshot': {
      const url = await boardURL();
      if (!url) die('handwave: no board is running');
      const html = await (await fetch(url + '/snapshot')).text();
      const out = flag('o') || flag('out') || 'board.html';
      fs.writeFileSync(out, html);
      console.log(path.resolve(out));
      return;
    }

    case 'url': {
      const url = await boardURL();
      if (!url) die('handwave: no board is running', 2);
      console.log(url);
      return;
    }

    case 'stop': {
      const { SESSION_FILE } = await import('./board/server.js');
      try {
        const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        process.kill(s.pid);
        fs.unlinkSync(SESSION_FILE);
        console.log('stopped');
      } catch { die('handwave: nothing to stop'); }
      return;
    }

    case 'help': case '--help': case '-h': case undefined:
      return void console.log(HELP);

    default:
      die(`handwave: no such command "${cmd}"\n\n${HELP}`);
  }
};

main().catch(e => die('handwave: ' + (e.stack || e.message)));
