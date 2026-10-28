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
let argv = process.argv.slice(2);

/* Flags may come before the command. `handwave --board api draw ...` and
   `handwave draw --board api ...` are the same thing, and a person who types
   the first and is told there is no such command "--board" has been failed by
   the parser, not by themselves. The command is rotated to the front; flag()
   and positional() see the array they expect. */
{
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) {
    const takesValue = argv[i + 1] != null && !argv[i + 1].startsWith('-');
    i += takesValue ? 2 : 1;
  }
  if (i > 0 && i < argv.length) argv = [argv[i], ...argv.slice(0, i), ...argv.slice(i + 1)];
}
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

/* `--board NAME` picks which board this command talks to. It is set into the
   environment rather than threaded through every call site, because that is
   also how a harness selects one: the MCP registration sets HANDWAVE_BOARD,
   and a Claude session and an opencode session then draw on different boards
   without either knowing the other exists. */
const boardFlag = flag('board');
if (boardFlag && boardFlag !== true) process.env.HANDWAVE_BOARD = String(boardFlag);

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
  // the child inherits HANDWAVE_BOARD, so an autostarted board registers under
  // the name the caller was already asking for
  const child = spawn(process.execPath, [path.join(HERE, 'cli.js'), 'serve', '--quiet'], {
    detached: true, stdio: ['ignore', out, out], env: process.env,
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
  // A rejected op must not leave a zero exit behind the summary line: scripts
  // and agents read the status, and "it printed something" is not success.
  if (body.errors?.length) process.exitCode = 1;
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
  install [targets...]          wire it into your agents (--detect to see what it would do)
  mcp-config [--shape S]        print the MCP entry to paste into any other harness
  bench <prompt> --models a,b   draw the same explanation with several models
  draw <json|file|->            add to the board (one op, or a list, or a whole spec)
  say  <text> [--step N]        put a line in the transcript beside the drawing
  step [N|next|prev|off]        light up one step of the flow
  script                        list the lines, numbered, with the step each is tied to
  tag <N> --step M              tie line N to step M (--match TEXT, --step off)
  replay                        play the board back from its own log, as a movie
  clear [--keep-title]          wipe the board
  render <spec.json> -o F.html  render a spec to a standalone file, no server
  snapshot [-o F.html]          save the live board as a standalone file
  boards                        every board running, and which one this shell uses
  focus                         bring this session's board window to the front
  url                           print the running board's URL
  stop [--all]                  stop this shell's board, or every one of them

Every command takes --board NAME (or the HANDWAVE_BOARD environment variable)
and talks to that board, starting it if it is not running. One board per
conversation: a Claude session and an opencode session drawing on the same
board interleave two explanations into one picture. "handwave install" gives
each harness its own name, so this happens without anyone thinking about it.

Ops are small JSON objects:
  {"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}
  {"op":"edge","from":"gw","to":"orders","label":"gRPC","async":false}
  {"op":"note","label":"idempotency key\\nlives 24h"}
  {"op":"boundary","label":"our VPC","members":["gw","orders"]}
  {"op":"step","edge":"gw>orders","step":"Gateway forwards the call"}
  {"op":"say","text":"The gateway checks the token first.","step":2}
  {"op":"tag","match":"Flyway V25","step":6}   (or {"line":7}; "step":null unties)

A "say" with a step lights that line in the script while that step is walked;
a line about the whole board carries no step and never dims.

kinds: client gateway service compute datastore cache queue external note

install targets: claude codex gemini opencode copilot cursor windsurf zed
                 vscode claude_desktop project
  handwave install                 whatever is on this machine
  handwave install --detect        what that would be, without doing it
  handwave install --list          every target and what it writes
  handwave install project         an AGENTS.md block in the current repo
  handwave install codex gemini    just those

Skills are symlinked, not copied, so they track the repo. MCP entries point at
this checkout, so a new agent session always starts on the current code.

"open" gives the board a chromeless window of its own (Chrome/Brave/Edge app mode),
which is the right place to pan and zoom. A terminal pane has to push every frame
through the TTY, so it is good for glancing and for stepping a flow, not for roaming.
  --tab          an ordinary browser tab instead of its own window
  --size 1100x900 --pos 60,60
  --browser brave`;

const main = async () => {
  switch (cmd) {
    case 'serve': {
      const { createServer, listen, boardName, findBoard } = await import('./board/server.js');
      const name = boardName();
      // Refuse to start a second board under one name: the first would keep
      // running, unreachable, and the ops would go to whichever won the race.
      const existing = findBoard(name);
      if (existing && await alive(existing)) {
        if (!flag('quiet')) console.log(`handwave: "${name}" is already running on ${existing}`);
        return;
      }
      const app = createServer();
      const url = await listen(app, Number(flag('port', 4777)), 20, name);
      if (!flag('quiet')) console.log(`handwave listening on ${url}${name === 'default' ? '' : `  (board "${name}")`}`);
      if (flag('open')) {
        const { openBoard } = await import('./board/open.js');
        openBoard(url, { app: !flag('tab'), size: flag('size'), browser: flag('browser') });
      }
      return;
    }

    case 'install': {
      const { install, TARGET_NAMES, TARGETS, detect } = await import('./install.js');
      const want = positional().filter(a => a !== 'install');
      if (want[0] === 'list') {
        for (const n of TARGET_NAMES) console.log(`  ${n.padEnd(16)}${TARGETS[n].what}`);
        return;
      }
      // what it would do, before it does anything
      if (flag('detect')) {
        const here = detect();
        for (const n of TARGET_NAMES) {
          const mark = n === 'project' ? '  ·' : here.includes(n) ? ' \u2713' : '  ·';
          console.log(`${mark} ${n.padEnd(16)}${TARGETS[n].what}`);
        }
        console.log(`\n\u2713 = found on this machine; \`handwave install\` does those.`);
        console.log('Name any target to install it anyway, e.g. `handwave install project`.');
        return;
      }
      for (const r of install(want)) {
        if (r.ok) console.log(`  ok    ${r.what}\n        ${r.where}${r.note ? `  (${r.note})` : ''}`);
        else console.error(`  FAIL  ${r.what || r.name}: ${r.note}`);
      }
      return;
    }

    /* Every harness worth the name speaks MCP, but they keep their config in
       different files and shapes. For the ones `install` knows, it writes them.
       For anything else — a harness that did not exist last week — print the
       entry so it can be pasted, rather than leaving the person to guess. */
    case 'mcp-config': {
      const entry = path.join(HERE, 'mcp', 'server.js');
      const shape = String(flag('shape') || 'stdio');
      const shapes = {
        stdio: { mcpServers: { handwave: { type: 'stdio', command: 'node', args: [entry] } } },
        servers: { servers: { handwave: { type: 'stdio', command: 'node', args: [entry] } } },
        opencode: { mcp: { handwave: { type: 'local', command: ['node', entry], enabled: true } } },
        zed: { context_servers: { handwave: { source: 'custom', command: 'node', args: [entry] } } },
        toml: null,
      };
      if (shape === 'toml') return void console.log(`[mcp_servers.handwave]\ncommand = "node"\nargs = ["${entry}"]`);
      if (!shapes[shape]) die(`handwave mcp-config: unknown shape "${shape}" (stdio, servers, opencode, zed, toml)`);
      console.log(JSON.stringify(shapes[shape], null, 2));
      return;
    }

    case 'bench': {
      const { bench, listModels } = await import('./bench.js');
      if (flag('list')) return void console.log((await listModels()).join('\n'));
      const prompt = argv.slice(1).find(a => !a.startsWith('-')
        && argv[argv.indexOf(a) - 1] !== '--models' && argv[argv.indexOf(a) - 1] !== '--out');
      if (!prompt) die('handwave bench: give me something to explain');
      await bench(prompt, {
        models: String(flag('models') || '').split(',').map(s => s.trim()).filter(Boolean),
        out: flag('out') || 'bench',
        timeout: Number(flag('timeout', 180)),
      });
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
      return void (await send(await readOps(positional()[0])));

    case 'say': {
      const step = flag('step'), edge = flag('edge');
      const text = positional().join(' ');      // positional() already drops `--flag value` pairs
      if (!text) die('handwave say: nothing to say');
      // tying the line to a step lets the rail light it when that step is lit
      const op = { op: 'say', text };
      if (step) op.step = Number(step);
      if (edge) op.edge = edge;
      return void (await send([op]));
    }

    /* The board already holds every op in order, so playing the explanation
       again is a request, not a redraw: nothing is re-thought and nothing is
       re-sent. Useful straight after a long answer — "watch that again" — and
       cheap enough for the agent to offer it itself. */
    case 'replay': {
      const url = await boardURL({ autostart: false });
      if (!url) die('handwave replay: no board is running');
      const res = await fetch(url + '/replay');
      // A board started before this command existed answers 404; say so, since
      // the fix is to restart it and that is not guessable from a stack trace.
      if (!res.ok) die('handwave replay: the running board is older than this command \u2014 `handwave stop`, then start it again');
      const r = await res.json();
      if (!r.ops) die('handwave replay: nothing has been drawn yet');
      if (!r.viewers) console.error('handwave: no window is watching — run `handwave open` to see it');
      return void console.log(`replaying ${r.ops} ops for ${r.viewers} viewer${r.viewers === 1 ? '' : 's'}`);
    }

    /* Tie a line that is already on the board to a step, or untie it. The
       explanation does not have to be run again to fix a tag. */
    case 'tag': {
      const step = flag('step'), edge = flag('edge'), match = flag('match');
      const line = positional()[0];
      if (!line && !match) die('handwave tag: which line? `handwave script` lists them, or use --match');
      if (!step && !edge) die('handwave tag: --step N, --edge a>b, or --step off to untie it');
      const op = { op: 'tag' };
      if (match) op.match = match; else op.line = Number(line);
      if (edge) op.edge = edge;
      if (step) op.step = step === 'off' || step === true ? null : Number(step);
      return void (await send([op]));
    }

    /* The script as the board holds it, numbered, with what each line is tied
       to. The numbers are what `handwave tag` takes. */
    case 'script': {
      const url = await boardURL({ autostart: false });
      if (!url) die('handwave script: no board is running');
      const b = await (await fetch(url + '/state')).json();
      const { scriptSteps } = await import('./board/script.js');
      const at = scriptSteps(b);
      if (!b.transcript.length) return void console.log('nothing said yet');
      b.transcript.forEach((t, i) => {
        const tag = at[i] == null ? '  \u2014  ' : ` ${String(at[i] + 1).padStart(2)}  `;
        console.log(`${String(i + 1).padStart(3)}${tag}${t.text.replace(/\n/g, ' ').slice(0, 92)}`);
      });
      const loose = at.filter(x => x == null).length;
      console.log(`\n${b.transcript.length} lines, ${b.transcript.length - loose} tied to a step, ${b.flow.length} steps`);
      return;
    }

    case 'step': {
      const a = positional()[0];
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
      const file = positional()[0];
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
      const { SESSION_FILE, listBoards, unregisterBoard, boardName, DEFAULT_BOARD } =
        await import('./board/server.js');
      const all = listBoards();
      const names = flag('all') ? Object.keys(all) : [boardName()];
      let n = 0;
      for (const name of names) {
        const b = all[name];
        if (b?.pid) { try { process.kill(b.pid); } catch { /* already gone */ } }
        if (unregisterBoard(name)) n++;
        if (name === DEFAULT_BOARD) { try { fs.unlinkSync(SESSION_FILE); } catch { /* none */ } }
        if (b) console.log(`stopped ${name === DEFAULT_BOARD ? 'the board' : `"${name}"`}`);
      }
      // a board from before the registry existed
      if (!n && !flag('all')) {
        try {
          const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
          process.kill(sess.pid); fs.unlinkSync(SESSION_FILE);
          return void console.log('stopped');
        } catch { die('handwave: nothing to stop'); }
      }
      if (!n) die('handwave: nothing to stop');
      return;
    }

    /* Bring this session's board to the front. With eight tasks in flight the
       window you want is behind seven others, and hunting for it is exactly
       the friction the board was meant to remove. */
    case 'focus': {
      const { boardName } = await import('./board/server.js');
      const name = boardName();
      const url = await boardURL({ autostart: false });
      if (!url) die(`handwave focus: no board for "${name}" \u2014 \`handwave open\` starts one`);
      const { focusBoard } = await import('./board/open.js');
      const r = focusBoard(name, url);
      if (!r.ok) die(`handwave focus: ${r.how}`);
      return void console.log(`${name}  ${url}`);
    }

    /* Which boards exist, and who is watching them. */
    case 'boards': {
      const { listBoards, boardName, DEFAULT_BOARD, SESSION_FILE } = await import('./board/server.js');
      const all = listBoards();
      /* A board started before the registry existed is in session.json and
         nowhere else. Saying "no boards running" while one is plainly open on
         screen is worse than saying nothing. */
      if (!all[DEFAULT_BOARD]) {
        try {
          const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
          if (sess.url && await alive(sess.url)) all[DEFAULT_BOARD] = { url: sess.url, legacy: true };
        } catch { /* none */ }
      }
      const names = Object.keys(all);
      if (!names.length) return void console.log('no boards running');
      const here = boardName();
      const w = Math.max(...names.map(n => n.length)) + 2;   // a name is a task name, so it can be long
      for (const name of names) {
        const { url } = all[name];
        let note = 'not answering';
        try {
          const st = await (await fetch(url + '/state', { signal: AbortSignal.timeout(900) })).json();
          note = `${st.nodes.length} boxes, ${st.edges.length} lines` + (st.title ? ` \u2014 ${st.title}` : '');
        } catch { /* left as not answering */ }
        // the directory tells two same-named boards apart, which happens when
        // two conversations are about one repo
        const where = all[name].cwd ? `  ${all[name].cwd.replace(process.env.HOME, '~')}` : '';
        const tail = all[name].legacy ? '  (started before boards had names)' : where;
        console.log(`${name === here ? '\u2192' : ' '} ${name.padEnd(w)}${url.padEnd(24)}${note}${tail}`);
      }
      if (names.length > 1 || here !== DEFAULT_BOARD) {
        console.log(`\n\u2192 is this shell's board (HANDWAVE_BOARD, or --board NAME).`);
      }
      return;
    }

    case 'help': case '--help': case '-h': case undefined:
      return void console.log(HELP);

    default:
      die(`handwave: no such command "${cmd}"\n\n${HELP}`);
  }
};

main().catch(e => die('handwave: ' + (e.stack || e.message)));
