/* ============================================================
   spiega doctor — is what is running the thing that is on disk?

   spiega reaches an agent through four different kinds of thing, and they go
   stale in different ways:

     a symlink   always current, by construction
     a copy      current only until the source changes
     a process   holds the code it was launched with, for as long as it lives
     a block     text pasted into someone else's file, current until reworded

   The trap is the process. A skill symlink updates the instant you `git pull`,
   and the agent reading it does not, because it loaded the file when the
   session started and the MCP server it talks to has been running since
   before the change. Twice in one afternoon that looked exactly like a feature
   that had not shipped.

   So this checks what is actually true right now, and says what to do about
   anything that is not.

   The work is Effect, with home and the XDG config root provided by the
   SpiegaHome service (packages/cli/src/config.ts) rather than read once at
   import — so a test can point a doctor at a temp directory with a Layer.
   The plain `doctor` below is the door the CLI and the suite walk through.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Effect } from 'effect';
import { SpiegaHome } from '../packages/cli/src/config.js';
import { isCheckout, ROOT } from './checkout.js';
import { START, END, BLOCK } from './agents-block.js';
import { c, sym, pad, heading } from './term.js';
import { piDir, piInstructionsFile, piMcpEntry } from './pi.js';

const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
const SKILL_SRC = path.join(ROOT, 'skills', 'spiega');

/* ---------- types ---------- */

type Level = 'ok' | 'warn' | 'bad';

interface Row {
  level: Level;
  what: string;
  detail: string;
  fix?: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;

const sh = (cmd: string, args: string[], opts: Record<string, unknown> = {}): string | null => {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    });
    return String(out).trim();
  } catch { return null; }
};

const ok = (what: string, detail: string): Row => ({ level: 'ok', what, detail });
const warn = (what: string, detail: string, fix?: string): Row => ({ level: 'warn', what, detail, fix });
const bad = (what: string, detail: string, fix?: string): Row => ({ level: 'bad', what, detail, fix });

const tilde = (home: string, p: string): string => String(p).replace(home, '~');

/* Most people meet spiega through `npm install -g`, where there is no
   checkout and the word is simply wrong. Developers run it from a clone,
   where "install" would be equally wrong. One word, decided once. */
const THIS = (): string => (isCheckout() ? 'this checkout' : 'this install');

/* ---------- the checkout ---------- */

function checkout(rows: Row[]): number {
  /* `git -C <dir>` walks UP until it finds a repository, so asking it about a
     directory that is not one answers about whatever encloses it. Installed
     from npm under nvm — which is itself a git clone — that is nvm: doctor
     reported nvm's HEAD as "this checkout", nvm's dirty file as uncommitted
     work, and then measured every skill and MCP entry against it. A page of
     red crosses, all meaningless, on the most ordinary install there is.

     So the repository has to BE this directory, not merely contain it. */
  const head = isCheckout() ? sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']) : null;
  if (!head) {
    rows.push(warn('checkout', sh('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'])
      ? 'installed from npm, not a checkout — nothing to compare against'
      : 'not a git checkout, so there is nothing to compare against'));
    return 0;
  }

  const when = Number(sh('git', ['-C', ROOT, 'log', '-1', '--format=%ct']) || 0) * 1000;
  const subject = sh('git', ['-C', ROOT, 'log', '-1', '--format=%s']) || '';
  const dirty = sh('git', ['-C', ROOT, 'status', '--porcelain']);
  rows.push(ok('checkout', `${head} — ${subject}`));
  if (dirty) {
    // not something to fix — just worth knowing that agents read the working
    // tree, not the last commit
    rows.push(warn('uncommitted changes',
      `${dirty.split('\n').length} file(s) modified — agents read these, committed or not`));
  }

  // Only what is already fetched; nobody wants a network call in a status command.
  const behind = sh('git', ['-C', ROOT, 'rev-list', '--count', 'HEAD..@{u}']);
  if (behind && behind !== '0') {
    rows.push(bad('behind the remote', `${behind} commit(s) not pulled`, 'git pull'));
  }
  return when;
}

/* ---------- can an agent actually invoke me? ---------- */

/* A terminal that finds spiega proves nothing. An agent's tool call is a
   non-interactive shell with its own environment; on a machine with nvm that
   shell never sources nvm's init, so the bin npm installed is invisible. That
   is the failure this whole check exists for, and it is why these probes run
   under `env -i` rather than inheriting the PATH of whoever typed `doctor`. */
const AGENT_SHELL = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/bin/sh']
  .find(f => fs.existsSync(f)) || '/bin/sh';

const agentShell = (home: string, script: string): string | null => {
  try {
    return execFileSync('env', ['-i', `HOME=${home}`, AGENT_SHELL, '-c', script],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

const nodeFloor = (): number => {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const engines = isObject(pkg) && isObject(pkg.engines) ? pkg.engines : {};
    return Number(String(engines.node || '').match(/\d+/)?.[0]) || 20;
  } catch { return 20; }
};

/* Which rung of the launcher's ladder produced the node, in words. The path
   alone says where the node is, not why it was picked — and the difference
   between "the one install recorded" and "whatever nvm had" is exactly what
   the record is for, so a fallback has to read as one. */
const VIA: Record<string, string> = {
  override: 'SPIEGA_NODE in the environment',
  recorded: 'the node `spiega install` recorded',
  'nvm-default': "nvm's default alias",
  'nvm-any': 'an installed nvm version',
  path: 'the node on PATH',
  known: 'a well-known install location',
};

interface NodeProbe {
  node?: string;
  version: string;
  via: string;
  record: { path: string; ok: boolean } | null;
  launcher: boolean;
}

/* Which node would run it? The launcher answers this itself, because the node
   on PATH and the node nvm calls default are not the same thing and only the
   second one actually runs spiega. An install that predates the launcher has
   `#!/usr/bin/env node`, so fall back to whatever node the clean shell finds. */
const nodeFor = (home: string, which: string): NodeProbe | null => {
  try {
    const out = execFileSync(which, [], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SPIEGA_NODE_VERSION: '1' },
    }).trim();
    const [first, ...rest] = out.split('\n');
    // the third field is newer than this check; an old launcher prints two
    const m = first.match(/^(.*) (\d+\.\d+\.\d+)(?: ([a-z-]+))?$/);
    if (m) {
      /* The recorded node is a second answer to a second question, and the
         launcher reports it on its own line because it can be stale while the
         run is fine. No such line at all means there is no record — which is
         not the same state as a record that has gone bad. */
      const rec = rest.map(l => l.match(/^recorded (.+) (ok|stale)$/)).find(Boolean);
      return {
        node: m[1],
        version: m[2],
        via: m[3] ? (VIA[m[3]] || m[3]) : 'the launcher',
        record: rec ? { path: rec[1], ok: rec[2] === 'ok' } : null,
        launcher: true,
      };
    }
  } catch { /* not the launcher, or it could not run */ }
  const v = agentShell(home, 'node -p "process.versions.node"');
  if (/^\d+\.\d+\.\d+$/.test(v || '')) {
    return { version: v as string, via: 'the node on PATH, with no launcher', record: null, launcher: false };
  }
  return null;
};

function invocation(home: string, rows: Row[]): void {
  const shell = path.basename(AGENT_SHELL);
  const which = agentShell(home, 'command -v spiega');
  if (!which) {
    rows.push(bad('agent can run spiega',
      `not found from a non-interactive ${shell} \u2014 an agent's tool call gets no nvm init`,
      'spiega install'));
    return;
  }

  let real = which;
  try { real = fs.realpathSync(which); } catch { /* leave as-is */ }
  rows.push(ok('agent can run spiega', `${tilde(home, which)} from a non-interactive ${shell}`));

  const mine = [path.resolve(ROOT, 'bin', 'spiega'), path.resolve(ROOT, 'src', 'cli.js')];
  rows.push(mine.includes(real)
    ? ok(`spiega is ${THIS()}`, `${tilde(home, which)} → ${tilde(home, real)}`)
    : bad(`spiega is ${THIS()}`, `${tilde(home, which)} → ${tilde(home, real)}, which is NOT ${THIS()}`,
        'spiega install'));

  const floor = nodeFloor();
  const probe = nodeFor(home, which);
  if (!probe) {
    rows.push(warn('node for spiega', 'could not work out which node it would use'));
  } else if (Number(probe.version.split('.')[0]) < floor) {
    rows.push(bad('node for spiega',
      `v${probe.version} (${probe.via}) is below the engines floor of ${floor}`,
      `install Node ${floor} or newer, or let the launcher pick one with \`spiega install\``));
  } else {
    const at = probe.node ? ` at ${tilde(home, probe.node)}` : '';
    rows.push(ok('node for spiega', `v${probe.version} via ${probe.via}${at}`));
  }

  /* The record is worth its own line: a stale one does not stop spiega (the
     launcher falls back), so nothing else here would ever mention it, and
     nobody re-runs install after upgrading node without being told to. */
  if (probe?.launcher) {
    if (!probe.record) {
      rows.push(warn('node recorded', 'none — the launcher has to guess at a node on every run',
        'run `spiega install` under the node you want it to use'));
    } else if (probe.record.ok) {
      rows.push(ok('node recorded', `${tilde(home, probe.record.path)} — tried before it starts guessing, and it still runs`));
    } else {
      rows.push(warn('node recorded',
        `${tilde(home, probe.record.path)} is gone or below the floor — the launcher is falling back to discovery`,
        'run `spiega install` under the node you want it to use'));
    }
  }
}

/* ---------- where install linked the command ---------- */

/* install records the one link it made and removes any other link to the
   launcher it finds on the agent's PATH. A second one is a link from before
   that record existed, or from a machine whose PATH has changed since, and
   it answers `which -a` in an order that depends on whose shell is asking. */
const LAUNCHER = path.join(ROOT, 'bin', 'spiega');
const LINK_FILE = (home: string): string => path.join(home, '.spiega', 'link');

function links(home: string, rows: Row[]): void {
  let recorded: string | null = null;
  try { recorded = fs.readFileSync(LINK_FILE(home), 'utf8').trim(); } catch { /* none */ }
  const dirs = (agentShell(home, 'printf %s "$PATH"') || '').split(':').filter(Boolean);
  const ours = (f: string): boolean => { try { return fs.readlinkSync(f) === LAUNCHER; } catch { return false; } };
  const extra = [...new Set(dirs.map(d => path.join(d, 'spiega')))].filter(f => f !== recorded && ours(f));
  if (extra.length) {
    rows.push(warn('command link', `also linked from ${extra.map(f => tilde(home, path.dirname(f))).join(', ')}`,
      '`spiega install` moves it to one place'));
  } else if (recorded && ours(recorded)) {
    rows.push(ok('command link', tilde(home, recorded)));
  }
}

/* ---------- skills ---------- */

const skillDirs = (home: string): Record<string, string> => ({
  claude: path.join(home, '.claude', 'skills', 'spiega'),
  codex: path.join(home, '.codex', 'skills', 'spiega'),
  gemini: path.join(home, '.gemini', 'skills', 'spiega'),
  pi: path.join(piDir(), 'skills', 'spiega'),
});

function skills(home: string, rows: Row[]): void {
  for (const [name, dest] of Object.entries(skillDirs(home))) {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) continue;                 // that harness is not here
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(dest); } catch { /* absent */ }
    if (!st) { rows.push(warn(`${name} skill`, 'not installed', `spiega install ${name}`)); continue; }

    if (st.isSymbolicLink()) {
      const to = fs.readlinkSync(dest);
      rows.push(to === SKILL_SRC
        ? ok(`${name} skill`, isCheckout() ? 'linked — tracks the checkout' : 'linked')
        : bad(`${name} skill`, `linked to ${tilde(home, to)}, not ${THIS()}`, `spiega install ${name}`));
      continue;
    }
    // a copy: current only until the source changes, so compare it
    const a = fs.readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8');
    let b: string | null = null;
    try { b = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'); } catch { /* unreadable */ }
    rows.push(a === b
      ? warn(`${name} skill`, 'a copy, currently identical', 'it will go stale on the next change; re-link with `spiega install`')
      : bad(`${name} skill`, 'a copy, and out of date', `spiega install ${name}`));
  }
}

/* ---------- instruction blocks ---------- */

const agentFiles = (home: string, config: string): Record<string, string> => ({
  opencode: path.join(config, 'opencode', 'AGENTS.md'),
  codex: path.join(home, '.codex', 'AGENTS.md'),
  gemini: path.join(home, '.gemini', 'GEMINI.md'),
  pi: piInstructionsFile(),
});

function blocks(home: string, config: string, rows: Row[]): void {
  for (const [name, file] of Object.entries(agentFiles(home, config))) {
    if (!fs.existsSync(path.dirname(file))) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    const i = text.indexOf(START), j = text.indexOf(END);
    if (i < 0) { rows.push(warn(`${name} AGENTS.md`, 'no spiega block', `spiega install ${name}`)); continue; }
    const current = text.slice(i + START.length, j).trim() === BLOCK.trim();
    rows.push(current
      ? ok(`${name} AGENTS.md`, 'block is current')
      : bad(`${name} AGENTS.md`, 'block is an older wording', `spiega install ${name}`));
  }
}

/* ---------- MCP registrations ---------- */

const readJSON = (f: string): Json | null => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch { return null; }
};

/* name, file, where our entry's path is, and where the servers live.

   The last one exists because the old name has to be looked for inside the
   server list and nowhere else. These are not all small dedicated files:
   ~/.claude.json is 130KB of projects, history and usage counters, and a
   whole-file search for the string found `"handwave": { "usageCount": 1 }`
   in a telemetry block and reported a registration that was never there.
   Unfixable, too — `spiega migrate` had nothing to remove, so the warning
   would have stood forever, which is how a checker teaches people to ignore
   it. */
type McpFile = [string, string, (c: Json) => unknown, (c: Json) => unknown];

/* Walk a parsed JSON object by a path of keys and array indices, returning
   undefined the moment any step is not the shape the path expects. The old
   code wrote `c?.mcpServers?.spiega?.args?.[0]`; this is the same walk, typed,
   so a config that is not the shape we expect answers "not registered" rather
   than throwing. */
const get = (v: unknown, path: Array<string | number>): unknown => {
  let cur: unknown = v;
  for (const k of path) {
    if (typeof k === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[k];
    } else {
      if (!isObject(cur)) return undefined;
      cur = cur[k];
    }
  }
  return cur;
};

const mcpFiles = (home: string, config: string): McpFile[] => [
  ['claude', path.join(home, '.claude.json'), c => get(c, ['mcpServers', 'spiega', 'args', 0]), c => get(c, ['mcpServers'])],
  ['opencode', path.join(config, 'opencode', 'opencode.json'), c => get(c, ['mcp', 'spiega', 'command', 1]), c => get(c, ['mcp'])],
  ['gemini', path.join(home, '.gemini', 'settings.json'), c => get(c, ['mcpServers', 'spiega', 'args', 0]), c => get(c, ['mcpServers'])],
  ['copilot', path.join(home, '.copilot', 'mcp-config.json'), c => get(c, ['mcpServers', 'spiega', 'args', 0]), c => get(c, ['mcpServers'])],
  ['cursor', path.join(home, '.cursor', 'mcp.json'), c => get(c, ['mcpServers', 'spiega', 'args', 0]), c => get(c, ['mcpServers'])],
  ['windsurf', path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), c => get(c, ['mcpServers', 'spiega', 'args', 0]), c => get(c, ['mcpServers'])],
];

/* Is there a server registered under the old name? Only a key in the server
   list counts — the name appearing anywhere else in the file is somebody's
   history, not something to clean up. */
export const registeredAs = (cfg: Json | null, servers: (c: Json) => unknown, name: string): boolean => {
  if (!cfg) return false;
  const list = servers(cfg);
  return isObject(list) && Object.hasOwn(list, name);
};

function registrations(home: string, config: string, rows: Row[]): void {
  for (const [name, file, pick] of mcpFiles(home, config)) {
    if (!fs.existsSync(file)) continue;
    const entry = pick(readJSON(file) ?? {});
    if (!entry) { rows.push(warn(`${name} MCP`, 'not registered', `spiega install ${name}`)); continue; }
    rows.push(entry === MCP_ENTRY
      ? ok(`${name} MCP`, `points at ${THIS()}`)
      : bad(`${name} MCP`, `points at ${tilde(home, String(entry))}`, `spiega install ${name}`));
  }
  /* pi registers a server whose tools the model never sees unless it is
     `direct`, so a right path with the wrong exposure is still no board.

     Gated on pi being here rather than on mcp.json, because a pi with no
     mcp.json at all is just a pi nobody has installed into — the one state
     worth a row. Gating on the file is how `install --detect` comes to offer
     a target doctor never mentions. */
  const piMcp = path.join(piDir(), 'mcp.json');
  if (fs.existsSync(piDir())) {
    const entry = fs.existsSync(piMcp) ? get(readJSON(piMcp), ['mcpServers', 'spiega']) : null;
    const want = piMcpEntry(MCP_ENTRY);
    if (!isObject(entry)) {
      rows.push(warn('pi MCP', 'not registered', 'spiega install pi'));
    } else {
      const args = entry.args;
      const exposure = entry.exposure;
      const arg0 = Array.isArray(args) ? args[0] : undefined;
      if (arg0 !== MCP_ENTRY) {
        rows.push(bad('pi MCP', `points at ${tilde(home, String(arg0 || '?'))}`, 'spiega install pi'));
      } else if (exposure !== want.exposure) {
        rows.push(bad('pi MCP', `exposure is ${String(exposure || 'codemode')}, so the model never sees the tools`, 'spiega install pi'));
      } else {
        rows.push(ok('pi MCP', `points at ${THIS()}`));
      }
    }
  }
  // Codex keeps its servers in TOML
  const toml = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(toml)) {
    const raw = fs.readFileSync(toml, 'utf8');
    const has = /^\s*\[mcp_servers\.spiega\]/m.test(raw);
    rows.push(has && raw.includes(MCP_ENTRY)
      ? ok('codex MCP', `points at ${THIS()}`)
      : warn('codex MCP', has ? `registered, but not at ${THIS()}` : 'not registered', 'spiega install codex'));
  }
}

/* ---------- processes, which is the one that actually bites ---------- */

/* When did a process start? `ps -o lstart=` is the portable-enough answer and
   is absolute, where elapsed time has to be parsed out of [[dd-]hh:]mm:ss. */
function startedAt(pid: number): number | null {
  const s = sh('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
}

/* Our own processes in a `ps` listing, and whether each is running from this
   checkout.

   Matching on the checkout's full path was the first attempt, and it goes
   blind the moment the directory is renamed: a board server started from the
   old location stops matching and is reported as "none running on older
   code" — a clean bill of health for the exact situation it exists to catch.
   Match on the file, then say where it came from.

   The parent matters as much as the pid. An MCP server cannot be stopped from
   a terminal — it belongs to the session that spawned it — so the only useful
   thing to say about a stale one is which session to end, and that is the
   ppid. The listing is asked for `pid=,ppid=,command=` for this reason.

   The path may also be relative, because `node src/cli.js serve` from the
   checkout is a documented way to run this thing and the one a person types.
   Requiring a leading slash missed those entirely, which is the same blindness
   as above wearing different clothes: a server started by hand reported as
   "none running" while it served every board on the machine. A relative path
   does say less, though — a `ps` listing carries no cwd, so there is no way to
   tell which checkout it was typed in. That is `here: null`, judged on its
   start time alone, rather than a guess in either direction.

   Exported, and taking the listing as an argument, so the cases that matter
   can be tested without starting anything. */
export interface ScannedProcess {
  pid: number;
  ppid: number | null;
  here: boolean | null;
}

export function scanProcesses(psOutput: string | null, root: string): { boards: ScannedProcess[]; mcp: ScannedProcess[] } {
  const out = { boards: [] as ScannedProcess[], mcp: [] as ScannedProcess[] };
  for (const line of String(psOutput || '').split('\n')) {
    if (line.includes('ps -Ao')) continue;
    const [pid, ppid] = line.trim().split(/\s+/, 2).map(Number);
    if (!pid) continue;
    /* One of our files, as an argument: `/somewhere/src/cli.js` or the bare
       `src/cli.js` of a hand start. Anything in between — `tools/src/cli.js`
       — belongs to whoever owns that tools directory, not to us. */
    const arg = (f: string): boolean => new RegExp(String.raw`\s(?:/\S*/)?src/${f}(?:\s|$)`).test(line);
    const isMcp = arg(String.raw`mcp/server\.js`);
    // `cli.js serve`, and not some other subcommand that mentions the word
    const isBoard = arg(String.raw`cli\.js`) && /\bserve\b/.test(line);
    if (!isMcp && !isBoard) continue;
    const absolute = /\s\/\S*\/src\/(?:cli|mcp\/server)\.js(?:\s|$)/.test(line);
    (isMcp ? out.mcp : out.boards).push({
      pid,
      ppid: Number.isFinite(ppid) ? ppid : null,
      here: absolute ? line.includes(`${root}/`) : null,
    });
  }
  return out;
}

/* The command behind a ppid, short enough to put on one line: `opencode` from
   `/opt/homebrew/Cellar/opencode-v2/2.2.2/bin/opencode serve --service`, and
   `Claude` from the .app bundle. `comm=` gives the executable path with no
   arguments, which is what makes it short; the basename of that is what a
   person recognises in a Dock or a window title.

   A parent that has exited answers nothing. That is worth printing as the
   pid alone rather than hiding the row: an orphaned server whose session is
   already gone is the one case where there is nothing left to close. */
function ownerName(ppid: number | null): string | null {
  if (!ppid) return null;
  const cmd = sh('ps', ['-o', 'comm=', '-p', String(ppid)]);
  if (!cmd) return null;
  return path.basename(cmd.trim().split(' ')[0]) || null;
}

/* What to do about a board process running old code.

   `--board x` is wrong for the shared server: it holds every board, so
   dropping one of them leaves the stale process serving the other seven. The
   warning has to name the thing that actually has to go, and say what that
   costs.

   What it costs changed, and this line went on saying otherwise long after it
   was false. Boards were memory only once, so a restart threw every drawing
   away and the advice was a decision rather than a chore; they are rebuilt
   from their op logs now (`restoreBoard`), so it is a chore. The exception is
   a board the banner already calls unsaved — no persist, an unwritable file,
   or one another server owns — which is the board that really does lose its
   ink, and is why this promises no more than the banner does. */
export const staleBoardFix = (shared: boolean): string => shared
  ? 'spiega stop --server, then draw again \u2014 the boards come back from their logs, bar any the banner calls unsaved'
  : 'spiega stop --board <name>, then draw again \u2014 it comes back from its log unless the banner calls it unsaved';

function processes(home: string, rows: Row[], headTime: number): void {
  const ps = sh('ps', ['-Ao', 'pid=,ppid=,command=']) || '';
  const { boards, mcp } = scanProcesses(ps, ROOT);

  /* Stale means either of two things, and both leave an agent talking to code
     that is not the code on disk: started before the current commit, or
     started from somewhere that is no longer this checkout. A process whose
     location cannot be read at all (`here: null`, a relative path) is held to
     the first test only — unplaceable is not the same as elsewhere. */
  const stale = (list: ScannedProcess[]): ScannedProcess[] => list.filter(p => {
    if (p.here === false) return true;
    const t = startedAt(p.pid);
    return t != null && headTime && t < headTime;
  });

  const why = (list: ScannedProcess[]): string => {
    const moved = list.filter(p => p.here === false).length;
    const old = list.length - moved;
    return [moved && `${moved} from a previous location`, old && `${old} older than the current commit`]
      .filter(Boolean).join(', ');
  };

  /* Naming the stale boards matters even though a restart now rebuilds them
     from their logs: an unsaved one does lose its ink, and the person reading
     this is the only one who knows which boards are mid-explanation.

     Which boards a process holds is the registry's business, and since one
     server holds many, a single stale process can be several stale boards. */
  const reg = readJSON(path.join(home, '.spiega', 'boards.json')) || {};
  const server = readJSON(path.join(home, '.spiega', 'server.json'));
  const boardsOn = (pids: Set<number>): string[] =>
    Object.entries(reg).filter(([, b]) => isObject(b) && pids.has(Number(b.pid))).map(([n]) => n);

  const oldBoards = stale(boards);
  if (!oldBoards.length) {
    const held = boardsOn(new Set(boards.map(p => p.pid))).length;
    rows.push(ok('board server', boards.length
      ? `${boards.length} running, all current${held ? ` \u2014 ${held} board(s)` : ''}`
      : 'none running'));
  } else {
    const pids = new Set(oldBoards.map(p => p.pid));
    const names = boardsOn(pids);
    rows.push(bad('board server',
      `${why(oldBoards)}${names.length ? `: ${names.join(', ')}` : ''}`,
      staleBoardFix(Boolean(server && pids.has(Number(server.pid))))));
  }

  /* Plural, and the fix names whose these are, because the row directly above
     ends in a `spiega stop` command and this one cannot.

     From a real session: doctor said "11 running, 2 from a previous location",
     the obvious next move was `spiega stop --all`, and that answered "nothing
     to stop" \u2014 correct, and useless. `stop` works on the board registry, and
     an MCP server is not in it: it is a child of the agent harness, talking
     stdio to the session that spawned it, holding no port and no board.
     Nothing typed at a terminal reaches one. "Start a fresh agent session"
     was already the only fix there is, but it left that to be inferred from a
     count of processes the reader had just been told were running. */
  /* Which sessions to end, since the fix line can only say "end them".

     Two things make this less obvious than reading ppids off a listing.

     A parent can be one of our own processes. Claude.app runs each server
     behind a `disclaimer` helper — `disclaimer --pgroup -- node .../server.js`
     — and the helper's command line names server.js too, so it is matched as a
     server itself and is the parent of the real one. Reported literally that
     is a wrapper owning its own child, twice, and the session that owns both
     goes unnamed. So the walk goes up until it leaves our own pids.

     And they are grouped, because "opencode x4" is the fact that changes what
     you do: that daemon accumulates a server per session and holds them until
     it restarts, so ending a session clears the others and not those.

     Only the stale ones — a current server has nothing for the reader to do. */
  const mcpPids = new Set(mcp.map(p => p.pid));
  const byPid = new Map(mcp.map(p => [p.pid, p]));

  const session = (p: ScannedProcess): number | null => {
    let up = p.ppid, hops = 0;
    while (up && mcpPids.has(up) && hops++ < 8) up = byPid.get(up)?.ppid ?? null;
    return up;
  };

  const owners = (list: ScannedProcess[]): string => {
    const by = new Map<number, { ppid: number | null; n: number }>();
    for (const p of list) {
      const key = session(p) ?? 0;
      if (!by.has(key)) by.set(key, { ppid: key || null, n: 0 });
      by.get(key)!.n++;
    }
    const all = [...by.values()].sort((a, b) => b.n - a.n || (a.ppid ?? 0) - (b.ppid ?? 0));
    /* Four is what fits on a line next to the label. The rest are counted
       rather than dropped: the number is the reason to go and look. */
    const shown = all.slice(0, 4).map(({ ppid, n }) => {
      const name = ownerName(ppid);
      const who = name ? `${name} ${ppid}` : (ppid ? `pid ${ppid}, gone` : 'unknown');
      return n > 1 ? `${who} \u00d7${n}` : who;
    });
    const rest = all.length - shown.length;
    return shown.join(' \u00b7 ') + (rest ? ` \u00b7 +${rest} more` : '');
  };

  const oldMcp = stale(mcp);
  rows.push(oldMcp.length
    ? bad('agent MCP servers', `${mcp.length} running, ${why(oldMcp)}`,
        'start a fresh agent session \u2014 these belong to the agent, not to spiega; stop cannot reach them')
    : ok('agent MCP servers', mcp.length
      ? `${mcp.length} running, all current \u2014 one per agent session`
      : 'none running'));
  if (oldMcp.length) rows.push(warn('\u21b3 end these', owners(oldMcp)));
}

/* ---------- the report ---------- */

/* Anything the old name left behind. A rename that is half-done is worse than
   one not started: two skills, two MCP registrations, two instruction blocks,
   and an agent reading whichever it finds first. */
function legacy(home: string, config: string, rows: Row[]): void {
  const OLD = 'handwave';
  const seen: string[] = [];
  const oldDir = path.join(home, `.${OLD}`);
  /* A link forward to the new directory is a deliberate bridge for processes
     that started before the rename, not debris. It is reported so it does not
     become permanent, but it is not a fault. */
  const bridged = (() => {
    try {
      return fs.lstatSync(oldDir).isSymbolicLink()
        && fs.realpathSync(oldDir) === fs.realpathSync(path.join(home, '.spiega'));
    } catch { return false; }
  })();
  if (bridged) {
    rows.push(warn('old path', `~/.${OLD} still points at ~/.spiega for processes started before the rename`,
      'spiega migrate removes it once none are left'));
  } else if (fs.existsSync(oldDir)) {
    seen.push(`~/.${OLD}`);
  }
  for (const [name, dir] of Object.entries(skillDirs(home))) {
    const old = path.join(path.dirname(dir), OLD);
    try { if (fs.lstatSync(old)) seen.push(`${name} skill`); } catch { /* absent */ }
  }
  for (const [name, file] of Object.entries(agentFiles(home, config))) {
    try {
      if (fs.readFileSync(file, 'utf8').includes(`<!-- ${OLD.toUpperCase()}_START -->`)) {
        seen.push(`${name} block`);
      }
    } catch { /* absent */ }
  }
  for (const [name, file, , servers] of mcpFiles(home, config)) {
    if (registeredAs(readJSON(file), servers, OLD)) seen.push(`${name} MCP`);
  }
  if (seen.length) rows.push(bad('left by the old name', seen.join(', '), 'spiega migrate'));
}

/* ---------- the Effect program, and the door ---------- */

export const doctorEffect = (): Effect.Effect<Row[], never, SpiegaHome> => Effect.gen(function* () {
  const home = yield* SpiegaHome;
  const rows: Row[] = [];
  const headTime = checkout(rows);
  invocation(home.home, rows);
  links(home.home, rows);
  skills(home.home, rows);
  blocks(home.home, home.config, rows);
  registrations(home.home, home.config, rows);
  legacy(home.home, home.config, rows);
  processes(home.home, rows, headTime);
  return rows;
});

export function doctor(): Row[] {
  return Effect.runSync(doctorEffect().pipe(Effect.provide(SpiegaHome.layer)));
}

export function format(rows: Row[]): string {
  const g = sym();
  const mark: Record<Level, string> = { ok: c.good(g.ok), warn: c.warn(g.warn), bad: c.accent(g.bad) };
  const tint: Record<Level, (s: string) => string> = { ok: c.dim, warn: c.plain, bad: c.plain };
  const w = Math.max(...rows.map(r => r.what.length)) + 2;

  const out = [heading('spiega doctor')];
  for (const r of rows) out.push(`  ${mark[r.level]} ${c.bold(pad(r.what, w))}${tint[r.level](r.detail)}`);

  const fixes = [...new Set(rows.filter(r => r.fix).map(r => r.fix as string))];
  if (fixes.length) {
    out.push('', `  ${c.bold('To fix')}`);
    for (const f of fixes) out.push(`    ${c.dim(g.arrow)} ${f}`);
  } else {
    out.push('', `  ${c.good(g.ok)} ${c.dim('Everything an agent reads is current.')}`);
  }
  out.push('');
  return out.join('\n');
}
