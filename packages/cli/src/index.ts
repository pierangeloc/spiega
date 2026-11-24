/* ============================================================
   @spiega/cli — serve and open, on effect/cli.

   src/cli.js stays the entry point and keeps owning the command table, the
   unknown-flag check and the --help text (see the comment above FLAGS
   there); a line reaches here only once that check has already passed, and
   `--help`/`-h` on `serve` or `open` never reach here at all, which is why
   nothing below renders help of its own and the `version` passed to
   `Command.runWith` is a placeholder — effect/cli's own `--help`/`--version`
   handling for these two commands is dead code from src/cli.js's point of
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
import { Command, Flag } from 'effect/cli';
import * as NodeServices from '@effect/platform-node/NodeServices';

/* Never shown: see the header comment. */
const VERSION = '0.0.0';

const run = <Name extends string, Input>(
  command: Command.Command<Name, Input, {}, never, never>,
): (args: ReadonlyArray<string>) => Promise<void> =>
  (args) => Effect.runPromise(Command.runWith(command, { version: VERSION })(args).pipe(
    Effect.provide(NodeServices.layer),
  ));

/* ---------- serve ---------- */

const serveConfig = {
  port: Flag.Int('port').pipe(Flag.optional),
  open: Flag.Boolean('open').pipe(Flag.withDefault(false)),
  solo: Flag.Boolean('solo').pipe(Flag.withDefault(false)),
  quiet: Flag.Boolean('quiet').pipe(Flag.withDefault(false)),
  tab: Flag.Boolean('tab').pipe(Flag.withDefault(false)),
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
  const { url, serving } = await startBoard({ name, port: Option.getOrElse(cfg.port, () => PORT), solo: cfg.solo });
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
  tab: Flag.Boolean('tab').pipe(Flag.withDefault(false)),
  size: Flag.String('size').pipe(Flag.optional),
  pos: Flag.String('pos').pipe(Flag.optional),
  browser: Flag.String('browser').pipe(Flag.optional),
  new: Flag.Boolean('new').pipe(Flag.withDefault(false)),
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
