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
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { emptyBoard, boardOps, type Board, type Chapter } from './state.js';
import { restoreBoard, openLogFile, boardLogFile } from './log.js';
import { home } from '../home.js';
import type { Audited, BoardEntry, BoardEvents, OpLog, SavingStatus } from '../../packages/server/src/index.js';

/* The Effect server: the routes, the op log's writer and the op Schema that
   screens what an agent posts.
 *
 * Reached by path rather than by package name because this artefact has no
 * resolution of its own — every module in it finds its neighbours by walking
 * up from its own file — and loaded here, in the server, rather than in
 * state.js, because the board page loads state.js off disk and could not fetch
 * `effect`. See eslint.config.js.
 *
 * On first use, and by `require`, which reads an ES module synchronously: a
 * board is held the moment it is asked for, and holding one opens its log,
 * which is made here. Lazily, because of who else imports this file. The MCP
 * server wants `resolveBoard` and `claimSession` from it and never listens on
 * a socket: loading Effect eagerly put 70 ms into the start-up of a process
 * that posts its ops over HTTP to somebody else's board and never decodes one.
 */
type ServerPkg = typeof import('../../packages/server/src/index.js');
const require = createRequire(import.meta.url);
let serverPkg: ServerPkg | null = null;
const loadServerPkg = (): ServerPkg =>
  (serverPkg ??= require('../../packages/server/src/index.js') as ServerPkg);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const SESSION_DIR = path.join(home(), '.spiega');

/* The old name's variables still work.

   An MCP registration written before the rename carries HANDWAVE_BOARD, and so
   does any shell alias or script someone wrote. Honouring both for a while
   costs one function and means a half-updated machine keeps working, which is
   the state every machine is in during a rename. */
const envVar = (name: string): string | undefined => process.env[`SPIEGA_${name}`] ?? process.env[`HANDWAVE_${name}`];
/* Read, never written any more. It held the url of the one board there used to
   be, back when that board answered /state and /op at its root. A board is now
   at /b/<name>, so writing this file would record a url that nothing here
   serves; reading it still finds a board started before any of that, which is
   the only reason it existed. */
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json');
/* The boards themselves: one append-only JSONL op log each. */
export const BOARDS_DIR = path.join(SESSION_DIR, 'boards');
export const boardFile = (name: string): string => boardLogFile(BOARDS_DIR, name);

/* The canonical port, and the lock on being the server — see `listen`. */
export const PORT = Number(envVar('PORT')) || 4777;

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/* A throw while settling must cost the request, not the process — one process
   holds every board. Its callers parse the answer, so a failed batch answers in
   the shape they expect rather than as plain text they would choke on. */
const failedOp = (res: http.ServerResponse, e: unknown): void => {
  const message = e && typeof e === 'object' && 'message' in e && e.message ? String(e.message) : String(e);
  return json(res, 500, { ok: false, error: `spiega could not apply these ops: ${message}` });
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 4e6) reject(new Error('body too large')); });
  req.on('end', () => resolve(b));
  req.on('error', reject);
});

/* A board this process is holding. `events` is made the first time somebody
   watches, and `log` is null for a board that is not being saved. */
export interface HeldBoard {
  readonly name: string;
  board: Board;
  events: BoardEvents | null;
  readonly started: number;
  log: OpLog | null;
}

/* What a restore hands `hold`: the board, and enough about the file to append
   to it. `unreadable` is a log this build could not read at all. */
interface Loaded {
  readonly board: Board;
  readonly lines: number;
  readonly tail: boolean;
  readonly unreadable?: boolean;
}

export interface BoardServer {
  readonly server: http.Server;
  readonly boards: Map<string, HeldBoard>;
  readonly hold: (name: string, board?: Board | null) => HeldBoard;
  readonly drop: (name: string) => Promise<boolean>;
  readonly broadcast: (entry: HeldBoard, event: 'patch' | 'replay' | 'saving', data: unknown) => void;
  readonly name: string;
  url: string | null;
  readonly board: Board;
  readonly flush: () => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

export interface ServerOptions {
  board?: Board | null;
  name?: string;
  persist?: boolean;
  debounce?: number;
}

export function createServer({ board = null, name = DEFAULT_BOARD, persist = false, debounce = 100 }: ServerOptions = {}): BoardServer {
  const pkg = loadServerPkg();

  /* name -> { name, board, events, log }. Nothing else in the process is per
     board: the renderer, the port and the HTTP server are shared. Tests and
     one-off renders stay in memory; `startBoard` turns persistence on. */
  const boards = new Map<string, HeldBoard>();

  const load = (nm: string): Loaded => {
    if (!persist) return { board: emptyBoard(), lines: 0, tail: true };
    try {
      const loaded = restoreBoard(boardFile(nm));
      /* Lines this build could not draw are left out rather than taken as the
         whole log's failure (see packages/core/src/schema/log.ts), so this is
         the only place anyone is told. One sentence with the first reason in
         it: the rest are almost always the same mistake repeated, and a board
         opening is not the moment for a list. */
      if (loaded.refused?.length) {
        const [first] = loaded.refused;
        console.error(
          `spiega: board "${nm}" opened without ${loaded.refused.length} ` +
          `line${loaded.refused.length === 1 ? '' : 's'} of its log that this spiega cannot draw ` +
          `(op ${first.index + 1} — ${first.why}). The rest of the board is intact and is still being saved.`,
        );
      }
      return loaded;
    }
    catch (e) {
      /* Said once, in words, and the board is held without a log: appending
         to a file this version cannot read would put its ops after the ones
         it could not, and compacting it would overwrite them. */
      const err = e as Error;
      console.error(`spiega: ${err.name === 'LogError' ? err.message : `could not restore "${nm}": ${err.message}`}`);
      return { board: emptyBoard(), lines: 0, tail: true, unreadable: true };
    }
  };

  const hold = (nm: string, b: Board | null = null): HeldBoard => {
    const held = boards.get(nm);
    if (held) return held;
    const loaded: Loaded = b ? { board: b, lines: 0, tail: true } : load(nm);
    const entry: HeldBoard = { name: nm, board: loaded.board, events: null, started: Date.now(), log: null };
    boards.set(nm, entry);
    if (persist && !loaded.unreadable) {
      try {
        entry.log = pkg.createOpLog(openLogFile(boardFile(nm), {
          lines: loaded.lines, tail: loaded.tail,
          snapshot: () => boardOps(entry.board),
        }), {
          debounce,
          /* A write that stops working says so on the board, not only here: the
             log's own warning goes to a terminal nobody is reading. */
          onStatus: () => broadcast(entry, 'saving', saving(entry)),
        });
      } catch (e) {
        // An unwritable state directory must not stop the board being drawn on.
        console.error(`spiega: could not open the log for "${nm}": ${(e as Error).message}`);
      }
    }
    return entry;
  };

  /* Somebody typing the url of a board they drew yesterday.

     The log on disk is the board, so asking for one by its address is asking
     for it to be held: answering "no board named that" about a file that is
     right there is the whole of #101, and the person has no way to tell it
     from the drawing having been destroyed.

     Only the page does this. /state, /op and the rest keep answering 404 for
     a board nobody is holding, because their callers read that as "gone, go
     and start one" — and a client that polls a name must not quietly stand a
     board back up on every poll. Listing never holds anything either: it is
     asking for one board, by name, that means this. */
  const reopen = (nm: string, url: string): HeldBoard | null => {
    if (!persist || !fs.existsSync(boardFile(nm))) return null;
    const entry = hold(nm);
    /* Now open, so it belongs in the registry — owned by nobody, since a url
       in a browser says which board was wanted and nothing about whose
       session it is. */
    try { registerBoard(nm, url, null, null); } catch { /* unwritable state dir */ }
    return entry;
  };

  /* Whether what is drawn here is reaching the file, and if not, why.

     A board that is not being saved still draws perfectly, which is the whole
     problem: it looks exactly like one that is. The lock is taken when the
     board is first held, so this does not change under us — a second server
     never becomes the owner while the first is alive. `memory` is not a
     warning: tests and one-off renders are meant to be in memory.

     `write-failed` is the one that can start part-way through: the file was
     ours and the lock held, and then a write stopped working. The log keeps
     the ops and tries again, so it clears itself when the disk does. */
  const saving = (entry: HeldBoard): SavingStatus => {
    if (!persist) return { saving: false, why: 'memory' };
    if (!entry.log) return { saving: false, why: 'unwritable', file: boardFile(entry.name) };
    if (!entry.log.owner) return { saving: false, why: 'other-server', file: entry.log.file };
    if (entry.log.failure !== null) {
      return { saving: false, why: 'write-failed', file: entry.log.file, error: entry.log.failure };
    }
    return { saving: true, file: entry.log.file };
  };

  const drop = async (nm: string): Promise<boolean> => {
    const entry = boards.get(nm);
    if (!entry) return false;
    boards.delete(nm);
    entry.events?.close();
    await entry.log?.close();
    return true;
  };

  const broadcast: BoardServer['broadcast'] = (entry, event, data) => entry.events?.publish(event, data);
  const viewers = (entry: HeldBoard): number => entry.events?.viewers ?? 0;

  /* The same settle as POST /settle, for /replay, which still needs a settled
     board before it plays one back. */
  const settle = (entry: HeldBoard): void => pkg.settle(readEntry(entry));

  const readEntry = (entry: HeldBoard): BoardEntry => ({
    name: entry.name, board: entry.board, viewers: viewers(entry),
    get events() { return entry.events ??= pkg.createBoardEvents(); },
    get log() { return entry.log; },
  });

  const first = hold(name, board);

  /* Where this server is, as the client that is talking to us sees it. Taken
     from the request rather than from what `listen` recorded, so a server
     bound to an ephemeral port (every test in this repo) still hands out urls
     that work. */
  const baseOf = (req: http.IncomingMessage): string => app.url || `http://${req.headers.host || `127.0.0.1:${PORT}`}`;

  /* The Effect HTTP router handles all security checks (loopback host,
     same-origin-or-absent origin, silent OPTIONS, no CORS headers), every read
     route (/icon.svg, /, /index.html, /boards GET, /b/:name,
     /b/:name/, /b/:name/state, /b/:name/whoami, /b/:name/events), the routes
     that change a board (POST /b/:name/op, /settle and /close) and the ones
     that draw it into a file (GET /b/:name/export, /snapshot, /snapshot.svg).
     What it declines is answered below. */
  const { isJsonContentType } = pkg;
  const bridge = pkg.createBoardReadBridge(
    { rootDir: ROOT, port: PORT, defaultBoard: DEFAULT_BOARD, persist, baseUrl: () => app.url },
    {
      get: nm => {
        const e = boards.get(nm);
        return e ? readEntry(e) : undefined;
      },
      reopen: (nm, boardUrl) => {
        const e = reopen(nm, boardUrl);
        return e ? readEntry(e) : undefined;
      },
      listOpen: () => [...boards.values()].map(readEntry),
      listSaved: () => persist ? savedBoards().filter(s => !boards.has(s.name)) : [],
      saving: nm => {
        const e = boards.get(nm);
        return e ? saving(e) : { saving: false, why: 'memory' };
      },
      close: async nm => {
        await drop(nm);
        unregisterBoard(nm);
        return boards.size;
      },
      audit: auditBoard,
    },
  );

  const server = http.createServer(async (req, res) => {
    if (await bridge.handle(req, res)) return;

    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    /* Creating a board — the write half of /boards (GET is on the Effect router). */
    if (p === '/boards' && req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'])) {
        return json(res, 415, { ok: false, error: 'expected content-type: application/json' });
      }
      let want: { name?: unknown, owner?: string | null, cwd?: string | null };
      try { want = JSON.parse(await readBody(req)); }
      catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON: ' + (e as Error).message }); }
      /* The name is decided here, not by the client that asked.

         Each client used to work its own name out of the registry and then
         simply use it, and the claim was only ever written on the create
         path — so a board whose owner had exited was handed, unclaimed, to
         every session that asked next. Reported twice: two agents in one
         directory, one board, each clearing the other's drawing. Both read
         an owner that was gone, both read it as free, and nothing ever made
         it look taken. One process holds every board, so the arithmetic
         belongs here, where it happens once and in order.

         A client that names a board itself (`--board notes`) sends no owner:
         it is asking for that board, not for one of its own, and gets
         exactly the name it asked for. */
      const asked = slug(want.name || DEFAULT_BOARD);
      const nm = want.owner ? freeName(asked, want.owner) : asked;
      const created = !boards.has(nm);
      hold(nm);
      const boardUrl = `${baseOf(req)}/b/${nm}`;
      /* Record the claim. assignName has already guaranteed this board is
         ours or free, so writing the owner cannot take one from a session
         that is still going — and it must be written, or the next session
         finds the board abandoned all over again. */
      const known = listBoards({ prune: false })[nm];
      if (want.owner ? known?.owner !== want.owner
                     : (created || !known)) {
        registerBoard(nm, boardUrl, want.owner ?? null, want.cwd || null);
      }
      return json(res, 200, { ok: true, name: nm, url: boardUrl, created });
    }

    const m = /^\/b\/([^/]+)(\/.*)?$/.exec(p);
    if (!m || m[2] == null) { res.writeHead(404); return res.end('not found'); }
    const nm = decodeURIComponent(m[1] ?? '');
    const rest = m[2];

    const entry = boards.get(nm);
    if (!entry) {
      // A client holding a registry entry we no longer honour needs to hear
      // "gone", not "broken": that is what sends it off to start a board.
      return json(res, 404, { ok: false, error: `no board named "${nm}"` });
    }
    const board = entry.board;

    /* Play the session back, on request from the CLI or the agent. The log is
       already here, so re-running an explanation costs nothing and the model
       never has to think the drawing out a second time. */
    if (rest === '/replay') {
      try { settle(entry); } catch (e) { return failedOp(res, e); }
      const drawable = board.log.filter(e => e.op !== 'focus' && e.op !== 'clear').length;
      if (drawable) broadcast(entry, 'replay', { rev: board.rev });
      return json(res, 200, { ok: !!drawable, ops: drawable, viewers: viewers(entry) });
    }

    res.writeHead(404); res.end('not found');
  });

  server.on('close', () => {
    for (const e of boards.values()) {
      e.events?.close();
      e.log?.close();
    }
    void bridge.dispose().catch(() => {});
  });

  const app: BoardServer = {
    server, boards, hold, drop, broadcast, name, url: null, board: first.board,
    // lets a test (or a shutdown path) wait for the buffer to reach the file
    flush: () => Promise.all([...boards.values()].map(e => e.log?.flush())),
    /* Flush and let go of the lock files. `flush` alone leaves them behind
       holding a pid that is gone, so every tidy shutdown left a stale lock. */
    close: () => Promise.all([...boards.values()].map(e => e.log?.close())),
  };
  return app;
}

/* What the drawing came out like, for the agent that cannot see it (#56).

   Asked for by name — `{"ops": [...], "audit": true}` — because it costs a
   render and most ops do not want one: a line of transcript cannot change
   where an arrow runs. It is computed after the broadcast, so the pane has
   already moved and the millisecond is spent on the caller's own reply rather
   than on the drawing appearing.

   A board that cannot be rendered says nothing here. The ops landed, the
   status says so, and an explanation does not stop because the measurement
   of it failed. */
async function auditBoard(board: Board | Chapter): Promise<Audited | null> {
  try {
    const { renderSVG } = await import('../render/render.js');
    const { audit, report, measuredWarnings } = await import('../render/audit.js');
    // The renderer takes a whole board; a chapter is handed over as one,
    // carrying the board-level fields it never reads (as in the board view's
    // drawing.ts).
    const whole: Board = 'log' in board ? board : { ...board, chapter: '', chapters: [], log: [], rev: 0 };
    const found = audit(board, renderSVG(whole, { margin: 16, active: board.active }));
    return { ...found, lines: report(found), warnings: measuredWarnings(found) };
  } catch {
    return null;
  }
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

/* One line of boards.json: where a board is, which process holds it, and the
   session that claimed it, if one did. */
export interface Registered {
  readonly url: string;
  readonly pid: number;
  readonly started: number;
  readonly owner: string | null;
  readonly cwd: string | null;
}

const readBoards = (): Record<string, Registered> => {
  try { return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8')); } catch { return {}; }
};

const writeBoards = (all: Record<string, Registered>): void => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(all, null, 2) + '\n');
};

const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/* Every board we still believe in. `prune` drops the ones whose process is
   gone — cheap, since it is a signal-0, not a request. */
export function listBoards({ prune = true }: { prune?: boolean } = {}): Record<string, Registered> {
  const all = readBoards();
  if (!prune) return all;
  const live: Record<string, Registered> = {};
  let changed = false;
  for (const [name, b] of Object.entries(all)) {
    if (b && b.pid && !running(b.pid)) { changed = true; continue; }
    live[name] = b;
  }
  if (changed) writeBoards(live);
  return live;
}

/* Every board there is, which is a different question.

   The registry is a liveness map: `listBoards` prunes anything whose process
   has gone, and a restart takes every entry with it, so after one the registry
   knows about whatever the new server happens to hold and nothing else. The
   directory does know — one log per board, sitting there with the drawing in
   it — and that makes it the answer to "which boards exist", with the registry
   answering only "which are open".

   Reading it is a readdir and a stat each. Deliberately not a restore: `hold`
   does that on first touch, which is the moment somebody has asked for one
   board, rather than spending a startup rebuilding fifty nobody wanted.

   Newest log first: with dozens of them, when it was last drawn on is the only
   ordering anybody can use. */
export function savedBoards(): { name: string, file: string, written: number }[] {
  let files: string[];
  try { files = fs.readdirSync(BOARDS_DIR); } catch { return []; }
  const saved: { name: string, file: string, written: number }[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;         // .lock and half-written .tmp files are not boards
    const file = path.join(BOARDS_DIR, f);
    let written = 0;
    try { written = fs.statSync(file).mtimeMs; } catch { continue; }
    saved.push({ name: f.slice(0, -'.jsonl'.length), file, written });
  }
  return saved.sort((a, b) => b.written - a.written);
}

/* Who a board belongs to — or nobody.

   A board asked for by name belongs to the asking, not to the session that did
   the asking. Recording the session as its owner means one `--board notes` call
   silently rebinds that session's default board to "notes" for good, because
   the owner match comes first when resolving a name. Measured: three
   `--board` calls from one shell left all three boards claiming it. */
export function ownerOfThisProcess(): string | null {
  return envVar('BOARD') ? null : sessionKey();
}

export function registerBoard(name: string, url: string, owner: string | null = ownerOfThisProcess(), cwd: string | null = process.cwd()): void {
  const all = readBoards();
  all[name] = { url, pid: process.pid, started: Date.now(), owner, cwd };
  writeBoards(all);
}

export function unregisterBoard(name: string): boolean {
  const all = readBoards();
  if (!(name in all)) return false;
  delete all[name];
  writeBoards(all);
  return true;
}

/* ---------- the one server ----------

   Where it is, written by whoever won the port. Clients read it to decide
   between asking for a board and starting a process. */
export function readServer(): { url: string, pid: number, started: number } | null {
  try {
    const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    if (s && s.url && s.pid && running(s.pid)) return s;
  } catch { /* none, or unreadable */ }
  return null;
}

export const findServer = (): string | null => readServer()?.url ?? null;

const writeServer = (url: string): void => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ url, pid: process.pid, started: Date.now() }, null, 2) + '\n');
};

/* Is a board answering at this url? */
export async function alive(url: string): Promise<boolean> {
  try { return (await fetch(url + '/state', { signal: AbortSignal.timeout(900) })).ok; }
  catch { return false; }
}

/* Is the thing holding this port one of ours? Something else on 4777 must not
   be mistaken for a server with no boards on it. */
export async function spiegaAt(url: string): Promise<boolean> {
  try {
    const r = await fetch(url + '/boards', { signal: AbortSignal.timeout(900) });
    if (!r.ok) return false;
    return Array.isArray((await r.json()).boards);
  } catch { return false; }
}

/* Ask the running server for a board, creating it if it has none by that name.
   A board is a map entry, so this is cheaper than anything that forks. */
export async function createBoardOn(
  serverUrl: string, name: string,
  { owner = ownerOfThisProcess(), cwd = process.cwd() }: { owner?: string | null, cwd?: string } = {},
): Promise<string | null> {
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
/* Is `target` us, or something that started us?

   The only honest way to tell a conversation id that belongs to this process
   from one it merely inherited. `ps` is enough: the chain from here up is a
   handful of hops, read once per process.

   Windows has no `ps`, and a walk that cannot be done must not come out as
   "not ours" — that would split one Claude Code session across two boards on
   the platform we cannot check. Unknown means trust. */
export function hasAncestor(target: number, from = process.pid, hops = 24): boolean {
  if (process.platform === 'win32') return true;
  let pid = from;
  for (let i = 0; i < hops && pid > 1; i++) {
    if (pid === target) return true;
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
      pid = Number(out.trim());
    } catch { return true; }              // cannot read the chain: unknown, so trust
    if (!Number.isInteger(pid)) return true;
  }
  return pid === target;
}

/* The conversation id Claude Code sets — when it is really this conversation's.

   CLAUDE_CODE_SESSION_ID was trusted outright, on the grounds that a harness
   naming its own conversation knows best. It does; the trouble is that the
   process reading it is often not in that conversation. opencode's
   `serve --service` daemon is reparented to launchd and outlives the Claude
   Code session that started it, then hands that session's id to the MCP server
   of every opencode session it ever starts. Reported: two models benchmarked
   side by side, both handed the board named after the repo, drawing over each
   other — boardName()'s owner match fires on the shared id before the
   directory is ever consulted, so even separate worktrees would have collided.

   CLAUDE_PID is the conversation's own process, and it settles it. Gone means
   the id is an heirloom. Alive but no relation to us means the same. Only an
   id whose process is still there, with us underneath it, is ours — and that
   case has to keep working, because a `spiega` run from Claude Code's own
   shell must land on the same board as its MCP server.

   No CLAUDE_PID at all is not Claude Code CLI, which always sets it: that is
   somebody pinning the variable by hand, and they are taken at their word. */
let claudeOwn: string | null | undefined;              // one process, one answer; the walk is a few ps calls
export function claudeSession(env: NodeJS.ProcessEnv = process.env, self = process.pid): string | null {
  const here = env === process.env && self === process.pid;
  if (here && claudeOwn !== undefined) return claudeOwn;

  const id = env.CLAUDE_CODE_SESSION_ID;
  const claude = Number(env.CLAUDE_PID);
  const answer = !id ? null
    : !claude ? id
    : running(claude) && hasAncestor(claude, self) ? id
    : null;

  if (here) claudeOwn = answer;
  return answer;
}

export function sessionKey(): string {
  return envVar('SESSION')
    || claudeSession()                      // the conversation itself, where a harness says so
    || process.env.HERDR_PANE_ID            // one pane is one task
    || process.env.HERDR_TAB_ID
    || process.cwd();
}

/* Claim this process as the session, for a client that is one conversation by
   construction.

   The environment a client inherits is not always its own. An opencode MCP
   server is a child of one long-lived `opencode serve --service` daemon and
   inherits the environment that daemon started with: four conversations, four
   MCP servers, one HERDR_PANE_ID between all of them. sessionKey() then gave
   every one of them the board the first had claimed, and a session explaining
   something else entirely added its chapters to a board somebody was reading.

   A stdio MCP server is started one per session and ends when its pipe closes,
   so the process is the identity, and saying so here beats reading it off an
   environment that cannot be trusted. Not the pid alone: boards.json outlives
   a reboot, and a recycled pid would adopt a stranger's board. The pid stays
   in front, where ownerGone can read it.

   SPIEGA_SESSION, SPIEGA_BOARD and SPIEGA_URL are somebody saying which board
   they want, and a CLAUDE_CODE_SESSION_ID that really is this process's is a
   harness naming its own conversation — all four are left exactly as they are.
   An inherited one is not a conversation we are in; see claudeSession. */
export function claimSession(env: NodeJS.ProcessEnv = process.env, pid = process.pid): string | null {
  const given = (n: string): string | undefined => env[`SPIEGA_${n}`] ?? env[`HANDWAVE_${n}`];
  if (given('SESSION') || given('BOARD') || given('URL') || claudeSession(env, pid)) return null;
  env.SPIEGA_SESSION = `mcp:${pid}:${randomUUID().slice(0, 8)}`;
  return env.SPIEGA_SESSION;
}

/* An owner that is not there any more.

   A key of the `mcp:<pid>:<run>` shape carries the process that claimed it, so
   a board whose claimant has exited can be handed to the next session in that
   directory — otherwise a day of sessions in one repo climbs to `-7` while six
   finished boards sit there owned by nobody. Any other key — a conversation
   id, a pane, a directory — says nothing about whether its session is still
   going, and an owner we cannot check is an owner we keep. */
export function ownerGone(owner: string | null | undefined): boolean {
  const m = /^mcp:(\d+):/.exec(owner || '');
  return !!m && !running(Number(m[1]));
}

const slug = (s: unknown): string => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/* A board name a person can recognise in a list of eight.

   The working directory's own name — which for a worktree is the task someone
   named themselves, like "domain-modeling-for-rights". Far better than a uuid,
   and it is already the word they would use out loud.

   A session that already has a board keeps it, matched on the session key, so
   the name is stable for as long as the work is. Only a genuine collision —
   two sessions, same directory name, different sessions — gets a suffix. */
/* This name, or the next one along if somebody else is holding it.

   Collision only: "the board I already own" is a question about the asking
   session and is answered by boardName, below. The server runs this and
   nothing else, so a client asking for a board by name gets the board it
   named — while two clients asking for the same one get two boards. */
export function freeName(base: string, key: string | null): string {
  const all = listBoards();
  const held = all[base];
  if (!held || held.owner === key || ownerGone(held.owner)) return base;
  // Taken by another session in the same directory. Count: "croissant-calc-2"
  // is a name someone can say out loud, which a hash of a session id is not,
  // and the board is found by owner afterwards so the number never moves.
  for (let i = 2; i < 100; i++) if (!all[`${base}-${i}`]) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

export function boardName(): string {
  const named = envVar('BOARD');
  if (named) return slug(named);

  const key = sessionKey();
  for (const [name, b] of Object.entries(listBoards())) {
    if (b.owner && b.owner === key) return name;       // this session's own board
  }
  // nothing claimed: fall through to naming one after the task
  return freeName(slug(path.basename(process.cwd())) || DEFAULT_BOARD, key);
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
export async function listen(
  app: BoardServer,
  { port = PORT, solo = false, tries = 20 }: { port?: number, solo?: boolean, tries?: number } = {},
): Promise<{ url: string, mine: boolean }> {
  const bind = (n: number) => new Promise<boolean>((resolve, reject) => {
    const s = app.server;
    const onErr = (e: NodeJS.ErrnoException) => {
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
export async function startBoard(
  { name = boardName(), port = PORT, solo = false }: { name?: string, port?: number, solo?: boolean } = {},
): Promise<{ url: string, serving: false } | { url: string, serving: true, app: BoardServer }> {
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
  /* `spiega stop --server` is a signal, not a request. Close on the way out:
     that flushes the last tick of ops, so the common shutdown is not the hard
     crash the budget allows us to lose, and it releases the lock, so the next
     start does not have to reclaim one left by a pid that is gone. */
  const goodbye = () => { app.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', goodbye);
  process.once('SIGINT', goodbye);
  return { url: `${r.url}/b/${name}`, serving: true, app };
}

/* Where is the board this client should talk to?

   SPIEGA_URL is absolute and wins — it names a board directly, which is what
   a test or a script wants. Otherwise the name decides: SPIEGA_BOARD, which
   each harness's MCP registration can set, so a Claude session and an opencode
   session reach different boards without either knowing the other exists. */
export function findBoard(name = boardName()): string | null {
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
export async function resolveBoard(name = boardName(), { start = true }: { start?: boolean } = {}): Promise<string | null> {
  const direct = envVar('URL');
  if (direct) return direct;

  /* The registry is a cache of a decision the server makes, so it is only
     worth reading when it says this board is already ours. Anything else —
     a board whose owner has exited, above all — has to be asked for, because
     asking is what records the claim. Returning it from here is how two
     sessions ended up drawing on one board: both found it alive under the
     name they had worked out, both used it, neither ever claimed it. */
  const owner = ownerOfThisProcess();
  const known = findBoard(name);
  if (known && (!owner || listBoards()[name]?.owner === owner) && await alive(known)) return known;

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
function spawnServer(): Promise<string | null> {
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
