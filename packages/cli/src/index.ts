/* ============================================================
   @spiega/cli — serve, open, install and doctor, on effect/cli.

   src/cli.js stays the entry point and keeps owning the command table, the
   unknown-flag check and the --help text (see the comment above FLAGS
   there); a line reaches here only once that check has already passed, and
   `--help`/`-h` on these commands never reach here at all, which is why
   nothing below renders help of its own and the `version` passed to
   `Command.runWith` is a placeholder — effect/cli's own `--help`/`--version`
   handling for these commands is dead code from src/cli.js's point of
   view, present only because the type signature asks for a version string.

   `serve` and `open` are the two commands #150 already moved onto Effect
   underneath (packages/server/src/window.ts, src/board/server.ts): this
   layer only replaces how their flags are read, not what they do. Each
   handler below is today's handler body, unchanged, with `flag('x')` calls
   replaced by the config effect/cli parsed.

   #186 — a browser that vanishes between the check and the launch — is
   fixed underneath, in `Desktop.live.launch` (window.ts) and in the plain
   wrapper's reporting (src/board/open.ts): both `openBoard` and `showBoard`
   answer `{ ok: false, how }` instead of throwing. What is here is that
   boundary's half of the fix: check `ok`, say which browser and why, and
   exit non-zero rather than letting the handler return as if nothing had
   gone wrong.
   ============================================================ */

import process from 'node:process';
import { Effect, Option } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import * as NodeServices from '@effect/platform-node/NodeServices';

/* Never shown: see the header comment. */
const VERSION = '0.0.0';

const run = <Name extends string, Input>(
  command: Command.Command<Name, Input, {}, never, never>,
): (args: ReadonlyArray<string>) => Promise<void> =>
  (args) => Effect.runPromise(Command.runWith(command, { version: VERSION })(args).pipe(
    Effect.provide(NodeServices.layer),
  ));

/* A boolean switch, read the way src/cli.js's `flag()` read one: present in
   argv is true, whatever follows the `=`. `flag('tab')` returned the non-empty
   string `"false"` for `--tab=false`, which is truthy, so `--tab=false`
   selected tab mode; effect/cli's Flag.Boolean parses a real false there, so
   read it as optional and treat "was mentioned at all" as true. `--tab=false`,
   `--tab=true` and `--tab` are all the same switch, exactly as they were. */
const Switch = (name: string) =>
  Flag.Boolean(name).pipe(Flag.optional, Flag.map(Option.isSome));

/* ---------- serve ---------- */

const serveConfig = {
  port: Flag.String('port').pipe(Flag.optional),
  open: Switch('open'),
  solo: Switch('solo'),
  quiet: Switch('quiet'),
  tab: Switch('tab'),
  size: Flag.String('size').pipe(Flag.optional),
  browser: Flag.String('browser').pipe(Flag.optional),
  // Global flags (src/cli.js's GLOBAL_FLAGS): already consumed upstream, into
  // SPIEGA_BOARD, before this module is even imported. Declared here only so
  // effect/cli's parser does not refuse them as unknown.
  board: Flag.String('board').pipe(Flag.optional),
  name: Flag.String('name').pipe(Flag.optional),
} satisfies Command.Command.Config;

type ServeConfig = Command.Command.Config.Infer<typeof serveConfig>;

async function serveHandler(cfg: ServeConfig): Promise<void> {
  const { startBoard, boardName, findBoard, alive: up, PORT } = await import('../../../src/board/server.js');
  const name = boardName();
  // Refuse to start a second board under one name: the first would keep
  // running, unreachable, and the ops would go to whichever won the race.
  const existing = findBoard(name);
  if (existing && await up(existing)) {
    if (!cfg.quiet) console.log(`spiega: "${name}" is already running on ${existing}`);
    return;
  }
  // `--port` is read as a string and coerced with Number, exactly as the old
  // `Number(flag('port', PORT))` did: "0x10" is 16, "5000.5" is 5000.5, "abc"
  // is NaN, and whatever startBoard then does with it is what the old CLI
  // handed it too. effect/cli's Int flag would reject those, which is not
  // this migration's business to change.
  const port = Option.getOrElse(Option.map(cfg.port, (s) => Number(s)), () => PORT);
  const { url, serving } = await startBoard({ name, port, solo: cfg.solo });
  if (!cfg.quiet) {
    console.log(serving
      ? `spiega serving ${url}${cfg.solo ? '  (its own process)' : ''}`
      : `spiega: board "${name}" is on the server already running — ${url}`);
  }
  if (cfg.open) {
    const { openBoard } = await import('../../../src/board/open.js');
    const r = await openBoard(url, { app: !cfg.tab, size: Option.getOrNull(cfg.size), browser: Option.getOrNull(cfg.browser) });
    // #186: the browser openBoard tried is gone. The board is up regardless
    // — `serving` already said so — so this is reported, not a reason to
    // fail the whole command, but it is still worth a non-zero exit: the
    // one thing `--open` was asked to do did not happen.
    if (!r.ok) {
      console.error(`spiega serve: ${r.how}`);
      process.exitCode = 1;
    }
  }
  // On `serving` the http server holds the loop open; otherwise there is
  // nothing left to do and this process is done.
}

const serveCommand = Command.make('serve', serveConfig, (cfg) => Effect.promise(() => serveHandler(cfg)));

export const runServe = run(serveCommand);

/* ---------- open ---------- */

const openConfig = {
  tab: Switch('tab'),
  size: Flag.String('size').pipe(Flag.optional),
  pos: Flag.String('pos').pipe(Flag.optional),
  browser: Flag.String('browser').pipe(Flag.optional),
  new: Switch('new'),
  board: Flag.String('board').pipe(Flag.optional),
  name: Flag.String('name').pipe(Flag.optional),
} satisfies Command.Command.Config;

type OpenConfig = Command.Command.Config.Infer<typeof openConfig>;

async function openHandler(cfg: OpenConfig): Promise<void> {
  // src/cli.js already refused a positional board name before calling here
  // (`spiega open: board names require --board NAME …`) — see its own
  // `case 'open'`, unchanged by this move.
  const { resolveBoard } = await import('../../../src/board/server.js');
  const u = await resolveBoard(undefined, { start: true });
  if (!u) {
    console.error('spiega: could not start a board (see $TMPDIR/spiega.log)');
    process.exitCode = 1;
    return;
  }
  const { showBoard, openBoard } = await import('../../../src/board/open.js');
  /* Raise the window this board is already in, rather than adding another.
     "Open the board" from anyone — a person at a prompt, an agent shelling
     out — means put it where I can see it, and three windows of one board
     all draw in lockstep, which reads as three boards. Reported that way
     twice. `--new` is there for the rare second view, side by side. */
  const name = u.split('/b/')[1]?.replace(/\/$/, '') || '';
  const opts = {
    app: !cfg.tab,
    size: Option.getOrNull(cfg.size),
    pos: Option.getOrNull(cfg.pos),
    browser: Option.getOrNull(cfg.browser),
  };
  const r = cfg.new ? { ...(await openBoard(u, opts)), raised: false as const } : await showBoard(u, name, opts);
  // #186: the browser it tried to launch is gone. Named, not thrown, and
  // non-zero — the one thing `open` was asked to do did not happen.
  if (!r.ok) {
    console.error(`spiega open: ${r.how}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${u}  (${r.raised ? `already open, ${r.how}` : r.how})`);
}

const openCommand = Command.make('open', openConfig, (cfg) => Effect.promise(() => openHandler(cfg)));

export const runOpen = run(openCommand);

/* ---------- install and doctor ---------- */

const doctorCommand = Command.make('doctor', {
  board: Flag.String('board').pipe(Flag.optional),
  name: Flag.String('name').pipe(Flag.optional),
}, () => Effect.promise(async () => {
  const { doctor, format } = await import('../../../src/doctor.js');
  const rows = doctor();
  console.log(format(rows));
  if (rows.some((row) => row.level === 'bad')) process.exitCode = 1;
}));

export const runDoctor = run(doctorCommand);

const installConfig = {
  targets: Argument.String('targets').pipe(Argument.variadic),
  detect: Switch('detect'),
  list: Switch('list'),
  path: Switch('path'),
  noPath: Switch('no-path'),
  binDir: Flag.String('bin-dir').pipe(Flag.optional),
  board: Flag.String('board').pipe(Flag.optional),
  name: Flag.String('name').pipe(Flag.optional),
} satisfies Command.Command.Config;

type InstallConfig = Command.Command.Config.Infer<typeof installConfig>;

async function installHandler(cfg: InstallConfig): Promise<void> {
  const { install, TARGET_NAMES, TARGETS, detect } = await import('../../../src/install.js');
  const { c, sym, pad, shortPath, heading } = await import('../../../src/term.js');
  const g = sym();
  const want = [...cfg.targets].map((t) => String(t));
  const nameW = Math.max(...TARGET_NAMES.map((n) => n.length)) + 2;
  const getsW = Math.max(...Object.values(TARGETS).map((t) => t.gets.length)) + 2;

  if (want[0] === 'list' || cfg.list) {
    console.log(heading('spiega install — targets'));
    for (const n of Object.keys(TARGETS) as Array<keyof typeof TARGETS>) {
      const t = TARGETS[n];
      console.log(`  ${c.bold(pad(n, nameW))}${pad(c.muted(t.gets), getsW + 10)}${c.dim(t.app)}`);
    }
    console.log(`\n  ${c.dim('spiega install')} with no arguments does whatever is on this machine.\n`);
    return;
  }

  if (cfg.detect) {
    const here = detect();
    console.log(heading('spiega install — what would happen'));
    for (const n of Object.keys(TARGETS) as Array<keyof typeof TARGETS>) {
      const t = TARGETS[n], found = here.includes(n);
      const mark = found ? c.good(g.ok) : c.dim(g.idle);
      const row = `  ${mark} ${c.bold(pad(n, nameW))}${pad(c.muted(t.gets), getsW + 10)}`;
      // `project` is opt-in: it writes into the current directory.
      const why = n === 'project' ? 'ask for it by name' : 'not on this machine';
      console.log(row + c.dim(found ? t.app : `${t.app} — ${why}`));
    }
    console.log(`\n  ${c.good(g.ok)} ${c.dim('would be installed')}   ${c.dim(g.idle)} ${c.dim('skipped — name it to install anyway')}\n`);
    return;
  }

  console.log(heading('spiega install'));
  // Without either PATH flag, let the existing interactive prompt decide.
  const touchShell = cfg.noPath ? false : cfg.path ? true : 'ask';
  const results = install(want, { touchShell, binDir: Option.getOrElse(cfg.binDir, () => null) });
  for (const r of results) {
    const mark = !r.ok ? c.accent(g.bad) : r.state === 'unchanged' ? c.dim(g.idle) : c.good(g.ok);
    const gets = r.gets ? pad(c.muted(r.gets), getsW + 10) : pad('', getsW + 10);
    const tail = r.ok
      ? c.dim(r.state === 'unchanged' ? 'already there' : shortPath(r.where, 46))
      : c.accent(r.note);
    console.log(`  ${mark} ${c.bold(pad(r.name, nameW))}${gets}${tail}`);
  }

  const wrote = results.filter((r) => r.ok && r.state === 'written').length;
  const same = results.filter((r) => r.ok && r.state === 'unchanged').length;
  const failed = results.filter((r) => !r.ok);
  const parts = [];
  if (wrote) parts.push(`${wrote} installed`);
  if (same) parts.push(`${same} already current`);
  if (failed.length) parts.push(c.accent(`${failed.length} failed`));
  console.log(`\n  ${parts.join(c.dim(` ${g.dot} `)) || 'nothing to do'}`);
  if (wrote) console.log(`  ${c.dim('Start a fresh agent session — a running one keeps the server it launched.')}`);
  console.log(`  ${c.dim(`Check it any time with ${c.plain('spiega doctor')}.`)}\n`);
  if (failed.length) process.exitCode = 1;
}

const installCommand = Command.make('install', installConfig, (cfg) => Effect.promise(() => installHandler(cfg)));

export const runInstall = run(installCommand);
