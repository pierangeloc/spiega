#!/usr/bin/env node
/* ============================================================
   spiega CLI — what the agent actually calls.

   The commands are shaped for an agent mid-sentence, not for a build script:
   one short call adds one thing to the board and returns immediately. If no
   board is running, `draw` starts one, so an agent never has to check first.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The first thing that runs, before any of the modules below are imported.

   Those modules use syntax a Node older than the engines floor will refuse to
   parse, so without this check an old node fails several modules deep with a
   SyntaxError that names a file nobody typed and never mentions the version.
   The floor is read from package.json rather than repeated, so there is one
   place to change it. */
{
  let floor = 20;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const found = String((pkg.engines && pkg.engines.node) || '').match(/\d+/);
    floor = Number(found && found[0]) || floor;
  } catch { /* a checkout without package.json keeps the known floor */ }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < floor) {
    console.error(`spiega needs Node ${floor} or newer, but the node running it is ${process.versions.node} (${process.execPath}), so run it with a newer node or reinstall spiega under one.`);
    process.exit(1);
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
let argv = process.argv.slice(2);

/* Flags may come before the command. `spiega --board api draw ...` and
   `spiega draw --board api ...` are the same thing, and a person who types
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

/* `--board NAME` picks which board this command talks to. `--name NAME` means
   the same thing, because that is what people type at `spiega serve` when they
   want a board called beta. Ignoring it there registered the board under the
   session's name instead, so the `stop --board beta` that followed was asked
   to stop something that had never been created. It is set into the
   environment rather than threaded through every call site, because that is
   also how a harness selects one: the MCP registration sets SPIEGA_BOARD,
   and a Claude session and an opencode session then draw on different boards
   without either knowing the other exists. */
const boardFlag = flag('board') ?? flag('name');
if (boardFlag && boardFlag !== true) process.env.SPIEGA_BOARD = String(boardFlag);

/* ---------- talking to a running board ---------- */

/* The board this command is for, started if it is not up yet. One server holds
   every board, so "starting" one is usually a map entry on a process that is
   already running — see resolveBoard. */
async function boardURL({ autostart = false } = {}) {
  const { resolveBoard } = await import('./board/server.js');
  const url = await resolveBoard(undefined, { start: autostart });
  if (!url && autostart) die('spiega: could not start a board (see $TMPDIR/spiega.log)');
  return url;
}

const alive = async url => (await import('./board/server.js')).alive(url);

/* What a person needs to see before a command changes a board: the name it
   resolved to, the title on it, and the url. Two boards can have the same
   name-shaped answer to "which one?", and only the title tells them apart. */
async function boardIdentity(url) {
  const read = async p => {
    try {
      return await (await fetch(url + p, { signal: AbortSignal.timeout(900) })).json();
    } catch { return {}; }
  };
  const [who, state] = await Promise.all([read('/whoami'), read('/state')]);
  const fromUrl = (String(url).match(/\/b\/([^/]+)\/?$/) || [])[1];
  return {
    name: who.name || (fromUrl ? decodeURIComponent(fromUrl) : 'board'),
    title: state.title || null,
    url,
  };
}

const describeBoard = b =>
  `"${b.name}"${b.title ? ` \u2014 "${b.title}"` : ' \u2014 untitled'}  ${b.url}`;

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
  catch (e) { die(`spiega: that is not valid JSON (${e.message})`); }
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

const HELP = `spiega — a hand-drawn board an agent draws on while it explains

  serve [--port N] [--open]     start the board and keep it running (--solo: own process)
  open [--tab] [--size WxH]     open the board in its own browser window
  doctor                        check that agents are reading the current version
  migrate                       move everything over from the old handwave name
  install [targets...]          wire it into your agents (--detect to see what it would do)
                                asks before touching your shell startup files
                                (--path / --no-path to answer in advance)
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
  focus                         bring this session's board to the front (opens one if needed)
  url                           print the running board's URL
  stop [--all|--server]         stop this shell's board, every one, or the server

Every command takes --board NAME (or --name, or SPIEGA_BOARD) and talks to
that board, starting it if it is not running. One board per conversation: a
Claude session and an opencode session drawing on the same board interleave
two explanations into one picture. "spiega install" gives each harness its own
name, so this happens without anyone thinking about it.

One process serves them all, on port 4777, each board under /b/<name>. Eight
boards cost one Node runtime rather than eight, and all of them run the code
that is on disk. "serve --solo" gives a board a process of its own if you ever
need one isolated from the rest.

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
  spiega install                 whatever is on this machine
  spiega install --detect        what that would be, without doing it
  spiega install --list          every target and what it writes
  spiega install project         an AGENTS.md block in the current repo
  spiega install codex gemini    just those

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
      const { startBoard, boardName, findBoard, alive: up, PORT } = await import('./board/server.js');
      const name = boardName();
      // Refuse to start a second board under one name: the first would keep
      // running, unreachable, and the ops would go to whichever won the race.
      const existing = findBoard(name);
      if (existing && await up(existing)) {
        if (!flag('quiet')) console.log(`spiega: "${name}" is already running on ${existing}`);
        return;
      }
      const solo = !!flag('solo');
      const { url, serving } = await startBoard({ name, port: Number(flag('port', PORT)), solo });
      if (!flag('quiet')) {
        console.log(serving
          ? `spiega serving ${url}${solo ? '  (its own process)' : ''}`
          : `spiega: board "${name}" is on the server already running \u2014 ${url}`);
      }
      if (flag('open')) {
        const { openBoard } = await import('./board/open.js');
        openBoard(url, { app: !flag('tab'), size: flag('size'), browser: flag('browser') });
      }
      // On `serving` the http server holds the loop open; otherwise there is
      // nothing left to do and this process is done.
      return;
    }

    /* Is what is running the thing that is on disk? Four different kinds of
       thing go stale in four different ways, and the one that bites is the
       process that has been alive since before the change. */
    case 'doctor': {
      const { doctor, format } = await import('./doctor.js');
      const rows = doctor();
      console.log(format(rows));
      if (rows.some(r => r.level === 'bad')) process.exitCode = 1;
      return;
    }

    /* The move from the old name. Safe to run twice and reports what it
       could not do itself, because a silent half-migration is the failure
       this exists to prevent. */
    case 'migrate': {
      const { migrate } = await import('./migrate.js');
      const { c, sym, pad, heading } = await import('./term.js');
      const g = sym();
      const rows = migrate();
      const mark = { done: c.good(g.ok), skip: c.dim(g.idle), todo: c.warn(g.warn) };
      const w = Math.max(...rows.map(r => r.what.length)) + 2;
      console.log(heading('spiega migrate \u2014 from handwave'));
      for (const r of rows) console.log(`  ${mark[r.level]} ${c.bold(pad(r.what, w))}${c.dim(r.detail)}`);
      const left = rows.filter(r => r.level === 'todo');
      console.log(left.length
        ? `\n  ${c.warn(g.warn)} ${left.length} thing(s) need you \u2014 then run ${c.plain('spiega install')}\n`
        : `\n  ${c.dim(`Now run ${c.plain('spiega install')} to register under the new name.`)}\n`);
      return;
    }

    case 'install': {
      const { install, TARGET_NAMES, TARGETS, detect } = await import('./install.js');
      const { c, sym, pad, shortPath, heading } = await import('./term.js');
      const g = sym();
      const want = positional().filter(a => a !== 'install');

      const nameW = Math.max(...TARGET_NAMES.map(n => n.length)) + 2;
      const getsW = Math.max(...Object.values(TARGETS).map(t => t.gets.length)) + 2;

      if (want[0] === 'list' || flag('list')) {
        console.log(heading('spiega install \u2014 targets'));
        for (const n of TARGET_NAMES) {
          const t = TARGETS[n];
          console.log(`  ${c.bold(pad(n, nameW))}${pad(c.muted(t.gets), getsW + 10)}${c.dim(t.app)}`);
        }
        console.log(`\n  ${c.dim('spiega install')} with no arguments does whatever is on this machine.\n`);
        return;
      }

      if (flag('detect')) {
        const here = detect();
        console.log(heading('spiega install \u2014 what would happen'));
        for (const n of TARGET_NAMES) {
          const t = TARGETS[n], found = here.includes(n);
          const mark = found ? c.good(g.ok) : c.dim(g.idle);
          const row = `  ${mark} ${c.bold(pad(n, nameW))}${pad(c.muted(t.gets), getsW + 10)}`;
          // `project` is not missing, it is opt-in: it writes into the
          // directory you happen to be standing in, so it is never automatic
          const why = n === 'project' ? 'ask for it by name' : 'not on this machine';
          console.log(row + c.dim(found ? t.app : `${t.app} \u2014 ${why}`));
        }
        console.log(`\n  ${c.good(g.ok)} ${c.dim('would be installed')}   ${c.dim(g.idle)} ${c.dim('skipped \u2014 name it to install anyway')}\n`);
        return;
      }

      console.log(heading('spiega install'));
      /* Neither flag: ask. The prompt refuses itself when there is nobody
         to answer, so a scripted install never hangs and never writes. */
      const touchShell = flag('no-path') ? false : flag('path') ? true : 'ask';
      const results = install(want, { touchShell });
      for (const r of results) {
        const mark = !r.ok ? c.accent(g.bad) : r.state === 'unchanged' ? c.dim(g.idle) : c.good(g.ok);
        const gets = r.gets ? pad(c.muted(r.gets), getsW + 10) : pad('', getsW + 10);
        const tail = r.ok
          ? c.dim(r.state === 'unchanged' ? 'already there' : shortPath(r.where, 46))
          : c.accent(r.note);
        console.log(`  ${mark} ${c.bold(pad(r.name, nameW))}${gets}${tail}`);
      }

      const wrote = results.filter(r => r.ok && r.state === 'written').length;
      const same = results.filter(r => r.ok && r.state === 'unchanged').length;
      const failed = results.filter(r => !r.ok);
      const parts = [];
      if (wrote) parts.push(`${wrote} installed`);
      if (same) parts.push(`${same} already current`);
      if (failed.length) parts.push(c.accent(`${failed.length} failed`));
      console.log(`\n  ${parts.join(c.dim(` ${g.dot} `)) || 'nothing to do'}`);
      // the step people skip, and then conclude the feature was never built
      if (wrote) console.log(`  ${c.dim('Start a fresh agent session \u2014 a running one keeps the server it launched.')}`);
      console.log(`  ${c.dim(`Check it any time with ${c.plain('spiega doctor')}.`)}\n`);
      if (failed.length) process.exitCode = 1;
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
        stdio: { mcpServers: { spiega: { type: 'stdio', command: 'node', args: [entry] } } },
        servers: { servers: { spiega: { type: 'stdio', command: 'node', args: [entry] } } },
        opencode: { mcp: { spiega: { type: 'local', command: ['node', entry], enabled: true } } },
        zed: { context_servers: { spiega: { source: 'custom', command: 'node', args: [entry] } } },
        toml: null,
      };
      if (shape === 'toml') return void console.log(`[mcp_servers.spiega]\ncommand = "node"\nargs = ["${entry}"]`);
      if (!shapes[shape]) die(`spiega mcp-config: unknown shape "${shape}" (stdio, servers, opencode, zed, toml)`);
      console.log(JSON.stringify(shapes[shape], null, 2));
      return;
    }

    case 'bench': {
      const { bench, listModels } = await import('./bench.js');
      if (flag('list')) return void console.log((await listModels()).join('\n'));
      const prompt = argv.slice(1).find(a => !a.startsWith('-')
        && argv[argv.indexOf(a) - 1] !== '--models' && argv[argv.indexOf(a) - 1] !== '--out');
      if (!prompt) die('spiega bench: give me something to explain');
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
      if (!text) die('spiega say: nothing to say');
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
      if (!url) die('spiega replay: no board is running');
      const res = await fetch(url + '/replay');
      // A board started before this command existed answers 404; say so, since
      // the fix is to restart it and that is not guessable from a stack trace.
      if (!res.ok) die('spiega replay: the running board is older than this command \u2014 `spiega stop`, then start it again');
      const r = await res.json();
      if (!r.ops) die('spiega replay: nothing has been drawn yet');
      if (!r.viewers) console.error('spiega: no window is watching — run `spiega open` to see it');
      return void console.log(`replaying ${r.ops} ops for ${r.viewers} viewer${r.viewers === 1 ? '' : 's'}`);
    }

    /* Tie a line that is already on the board to a step, or untie it. The
       explanation does not have to be run again to fix a tag. */
    case 'tag': {
      const step = flag('step'), edge = flag('edge'), match = flag('match');
      const line = positional()[0];
      if (!line && !match) die('spiega tag: which line? `spiega script` lists them, or use --match');
      if (!step && !edge) die('spiega tag: --step N, --edge a>b, or --step off to untie it');
      const op = { op: 'tag' };
      if (match) op.match = match; else op.line = Number(line);
      if (edge) op.edge = edge;
      if (step) op.step = step === 'off' || step === true ? null : Number(step);
      return void (await send([op]));
    }

    /* The script as the board holds it, numbered, with what each line is tied
       to. The numbers are what `spiega tag` takes. */
    case 'script': {
      const url = await boardURL({ autostart: false });
      if (!url) die('spiega script: no board is running');
      const b = await (await fetch(url + '/state')).json();
      const { scriptSteps, tagReport } = await import('./board/script.js');
      const { c, sym, pad, heading } = await import('./term.js');
      const g = sym();
      const at = scriptSteps(b);
      if (!b.transcript.length) return void console.log('nothing said yet');

      console.log(heading('spiega script'));
      at.forEach((step, i) => {
        const tag = step == null ? c.dim(` ${g.dot} `) : c.accent(` ${String(step + 1).padStart(2)}`);
        const text = b.transcript[i].text.replace(/\n/g, ' ');
        console.log(`  ${c.dim(String(i + 1).padStart(3))}${tag}  ${text.slice(0, 88)}`);
      });

      const r = tagReport(b);
      console.log(`\n  ${r.lines} lines ${c.dim(g.dot)} ${r.tagged} tied to a step ${c.dim(g.dot)} ${r.steps} steps`);
      if (r.steps && r.tagged < r.lines && !r.tagged) {
        console.log(`  ${c.dim('Nothing is tagged, so the rail highlights nothing. Tag the lines that explain one hop.')}`);
      }
      /* The rail shows what was said, in order. Tags that run backwards are
         not a rendering fault, they are the narration order — worth saying,
         because from the board it looks like a sort gone wrong. */
      if (!r.ordered) {
        const where = r.backwards.map(x => `line ${x.line} (step ${x.step} after step ${x.after})`).join(', ');
        console.log(`  ${c.warn(g.warn)} ${c.plain('the tags run backwards:')} ${c.dim(where)}`);
        console.log(`  ${c.dim('The rail shows what was said, in order, so the numbers will look jumbled.')}`);
        console.log(`  ${c.dim('If the flow is the spine of this explanation, say the lines in step order;')}`);
        console.log(`  ${c.dim(`otherwise untag the ones that are not about a single hop (${c.plain('spiega tag N --step off')}).`)}`);
      }
      console.log('');
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

    /* clear is the one command that undoes work rather than adding to it. A
       board picked by the session pointer is not the same as one the person
       named, and the difference is invisible until the drawing is gone. So it
       says which board it resolved to, and refuses to wipe one nobody asked
       for by name unless --force says they meant it. */
    case 'clear': {
      const forced = !!flag('force');
      const named = !!(boardFlag && boardFlag !== true)
        || !!(process.env.SPIEGA_URL || process.env.HANDWAVE_URL);
      // Do not start a board just to clear it. If none is running there is
      // nothing to wipe, and creating one would be a surprising side effect.
      const url = await boardURL({ autostart: named });
      if (!url) die('spiega clear: no board is running');
      const who = await boardIdentity(url);
      if (!named && !forced) {
        console.error(`spiega clear: ${describeBoard(who)}`);
        die(`spiega clear: that board was not named explicitly, so nothing was cleared.\n`
          + `  Name it \u2014 spiega clear --board ${who.name} \u2014 or pass --force.\n`
          + `  Setting SPIEGA_URL to its url also counts as naming it.`);
      }
      console.log(`clearing ${describeBoard(who)}${!named ? '  (--force)' : ''}`);
      return void (await send([{ op: 'clear', keepTitle: !!flag('keep-title') }]));
    }

    case 'render': {
      const file = positional()[0];
      if (!file) die('spiega render: give me a spec file');
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
      if (!url) die('spiega: no board is running');
      const html = await (await fetch(url + '/snapshot')).text();
      const out = flag('o') || flag('out') || 'board.html';
      fs.writeFileSync(out, html);
      console.log(path.resolve(out));
      return;
    }

    case 'url': {
      const url = await boardURL();
      if (!url) die('spiega: no board is running', 2);
      console.log(url);
      return;
    }

    case 'stop': {
      const { SESSION_FILE, SERVER_FILE, listBoards, unregisterBoard, boardName, readServer, DEFAULT_BOARD, alive: up } =
        await import('./board/server.js');
      const all = listBoards();
      const srv = readServer();
      /* One process holds every board, so stopping one is a request to drop it
         and stopping the server is a kill. Telling them apart by pid keeps a
         `--solo` board, and a board from before all this, working the old way:
         if nothing else is on that pid, the kill is the drop. */
      const shared = b => srv && b?.pid === srv.pid;
      const killServer = !!(flag('all') || flag('server'));
      const names = flag('server') ? [] : flag('all') ? Object.keys(all) : [boardName()];

      /* A close and a signal both take a moment to land. Give a board that
         still answers a short grace period before declaring it stopped, so a
         tidy shutdown is not mistaken for a failure and kept in the registry. */
      const gone = async url => {
        for (let i = 0; i < 8; i++) {
          if (!(await up(url))) return true;
          await new Promise(r => setTimeout(r, 50));
        }
        return false;
      };

      const stopped = new Set();      // urls we actually took down
      let n = 0;
      for (const name of names) {
        const b = all[name];
        if (!b) continue;
        // Say which board before touching it: a stop is not undoable either.
        const who = { ...(await boardIdentity(b.url)), name };
        console.log(`stopping ${describeBoard(who)}`);

        // --all is about to end the process anyway; no point asking it politely
        if (shared(b) && !killServer) {
          try { await fetch(b.url + '/close', { method: 'POST' }); } catch { /* gone */ }
        } else if (!shared(b) && b.pid) {
          try { process.kill(b.pid); } catch { /* already gone */ }
        }

        /* A failed close, or a signal a solo server ignored, must not leave a
           board running with no registry entry: then nothing in the CLI can
           name it again. Keep the entry and say it did not stop. */
        if (!killServer && !(await gone(b.url))) {
          console.error(`spiega: "${name}" is still running at ${b.url}; keeping it in the board list`);
          continue;
        }

        unregisterBoard(name);
        stopped.add(b.url);
        console.log(`stopped ${name === DEFAULT_BOARD ? 'the board' : `"${name}"`}`);
        n++;
      }

      if (killServer && srv) {
        try { process.kill(srv.pid); } catch { /* already gone */ }
        try { fs.unlinkSync(SERVER_FILE); } catch { /* none */ }
        console.log('stopped the server');
        n++;
      }

      // a board from before the registry existed
      if (!n && !killServer) {
        try {
          const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
          const who = await boardIdentity(sess.url);
          console.log(`stopping "default"${who.title ? ` \u2014 "${who.title}"` : ''}  ${sess.url}`);
          process.kill(sess.pid);
          stopped.add(sess.url);
          n++;
          console.log('stopped');
        } catch { die('spiega: nothing to stop'); }
      }
      if (!n) die('spiega: nothing to stop');

      /* session.json is the old single pointer. Deleting it while it still
         names a board that is answering is how a stop used to strand the
         other one: the board kept drawing, and the CLI had no name for it.
         Only remove the pointer when the board it names is gone. */
      try {
        const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        const stillThere = sess.url && !stopped.has(sess.url)
          && (killServer ? !(await gone(sess.url)) : await up(sess.url));
        if (!stillThere) {
          try { fs.unlinkSync(SESSION_FILE); } catch { /* none */ }
        }
      } catch { /* no pointer, or already gone */ }
      return;
    }

    /* Bring this session's board to the front. With eight tasks in flight the
       window you want is behind seven others, and hunting for it is exactly
       the friction the board was meant to remove. */
    case 'focus': {
      /* "I have lost my board" has three shapes and one intent, so this
         handles all three: the window is buried (raise it), the window was
         closed but the board is still serving (make a window — the drawing is
         untouched, a board is a server), or there is no board yet (start one).
         Being told `spiega open` by a command you ran to see your board is
         a refusal dressed as help. */
      const { boardName } = await import('./board/server.js');
      const { focusBoard, openBoard } = await import('./board/open.js');
      const name = boardName();

      let url = await boardURL({ autostart: false });
      const started = !url;
      if (!url) url = await boardURL({ autostart: true });

      if (!started) {
        const r = focusBoard(name, url);
        if (r.ok) return void console.log(`${name}  ${url}  (${r.how})`);
      }
      // no window to raise: give it one
      const o = openBoard(url, { app: !flag('tab'), size: flag('size'), browser: flag('browser') });
      return void console.log(`${name}  ${url}  (new ${o.how})`);
    }

    /* Which boards exist, and who is watching them. */
    case 'boards': {
      const { listBoards, boardName, readServer, DEFAULT_BOARD, SESSION_FILE, alive: up } =
        await import('./board/server.js');
      const { c, sym, pad, shortPath, heading } = await import('./term.js');
      const g = sym();
      const all = listBoards();
      /* A board started before the registry existed is in session.json and
         nowhere else. Saying "no boards running" while one is plainly open on
         screen is worse than saying nothing. */
      if (!all[DEFAULT_BOARD]) {
        try {
          const sess = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
          if (sess.url && await up(sess.url)) all[DEFAULT_BOARD] = { url: sess.url, legacy: true };
        } catch { /* none */ }
      }
      const names = Object.keys(all);
      if (!names.length) {
        return void console.log(`\n  ${c.dim('No boards running.')} ${c.dim(`${g.arrow} spiega open`)}\n`);
      }

      const here = boardName();
      const srv = readServer();
      const w = Math.max(...names.map(n => n.length)) + 2;   // a name is a task name, so it can be long
      console.log(heading('spiega boards'));
      for (const name of names) {
        const { url } = all[name];
        let note = c.accent('not answering'), size = '';
        try {
          const st = await (await fetch(url + '/state', { signal: AbortSignal.timeout(900) })).json();
          size = `${st.nodes.length} ${g.dot} ${st.edges.length}`;
          note = st.title ? c.plain(st.title) : c.dim('untitled');
        } catch { /* left as not answering */ }
        const mine = name === here;
        /* The port, not the path: with one server the url is the same for
           every row apart from the name that is already in the first column.
           A board on its own port is the only one worth pointing out. */
        const where = (url.match(/:(\d+)/) || [, '?'])[1];
        const tail = all[name].legacy
          ? c.dim('  (started before boards had names)')
          : c.dim(`  ${shortPath(all[name].cwd || '', 34)}`);
        console.log(`  ${mine ? c.accent(g.arrow) : ' '} ${c.bold(pad(name, w))}` +
          `${c.dim(pad(':' + where, 8))}${pad(c.dim(size), 10)}${note}${tail}`);
      }
      const own = names.filter(n => !all[n].legacy && srv && all[n].pid !== srv.pid).length;
      console.log(`\n  ${c.accent(g.arrow)} ${c.dim("this shell's board")}   ` +
        `${c.dim(`boxes ${g.dot} lines   \u2014 switch with --board NAME`)}`);
      if (srv) {
        console.log(`  ${c.dim(`One server on :${(srv.url.match(/:(\d+)/) || [, '?'])[1]} holds ` +
          `${names.length - own} of them${own ? `; ${own} on ${own === 1 ? 'its' : 'their'} own` : ''}.`)}`);
      }
      console.log('');
      return;
    }

    case 'help': case '--help': case '-h': case undefined:
      return void console.log(HELP);

    default:
      die(`spiega: no such command "${cmd}"\n\n${HELP}`);
  }
};

main().catch(e => die('spiega: ' + (e.stack || e.message)));
