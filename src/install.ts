/* ============================================================
   spiega install — put it where your agents will find it.

   Every target here is idempotent and backs up any file it rewrites, because
   these are config files you did not write for us and may have spent a long
   time on. Nothing is ever merged destructively: JSON targets get one key
   added, and a file we do not understand is left alone with a message.

   The work is Effect, with home and the XDG config root provided by the
   SpiegaHome service (packages/cli/src/config.ts) rather than read once at
   import — so a test can point an install at a temp directory with a Layer
   instead of mutating process.env. The plain `install` and `ensureBin` below
   are the doors the CLI and the suite still walk through: they run the Effect
   against this machine, exactly as src/board/open.ts runs the window Effects.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Effect } from 'effect';
import { SpiegaHome, resolveHomeDir, resolveConfigDir } from '../packages/cli/src/config.js';
import { upsertBlock } from './agents-block.js';
import { upsertTable } from './toml.js';
import { piDir, piInstructionsFile, piMcpEntry } from './pi.js';
import { c, sym, pad, shortPath } from './term.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
/* The sh launcher, not cli.js: it resolves a node that clears the engines
   floor instead of trusting whatever `env node` happens to be. */
const LAUNCHER = path.join(ROOT, 'bin', 'spiega');

/* ---------- types ---------- */

type State = 'written' | 'unchanged' | 'failed';

interface Target {
  what: string;
  app: string;
  gets: string;
  detect: () => boolean;
  run: () => [string, string, string];
}

interface InstallResult {
  name: string;
  ok: boolean;
  what: string;
  app: string;
  gets: string;
  where?: string;
  note: string;
  state: State;
}

interface BinInfo {
  dir: string;
  link: string;
  onPath: boolean;
  addedToRc: boolean;
  rcDeclined: boolean;
  rcAsked: boolean;
  changed: boolean;
  removed: string[];
  stuck: string[];
}

interface NodeRecord {
  node: string;
  file: string;
  changed: boolean;
}

type TouchShell = 'ask' | boolean;

interface EnsureBinOptions {
  touchShell?: TouchShell;
  confirm?: (file: string, dir: string) => boolean;
  requestedDir?: string | null;
}

interface InstallOptions {
  touchShell?: TouchShell;
  binDir?: string | null;
}

/* ---------- small helpers ---------- */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const backup = (file: string): string | null => {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-spiega-${new Date().toISOString().slice(0, 10)}`;
  if (!fs.existsSync(b)) fs.copyFileSync(file, b);
  return b;
};

/* Read a config file, or {} when it is not there or empty. Malformed JSON
   throws, and a valid-but-unexpected shape (null, an array, a bare value) is
   the caller's to refuse: returning {} here would silently replace somebody's
   file, which is exactly what "leave a file we do not understand alone" exists
   to prevent. */
const readJSON = (file: string): unknown => {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);   // throws on malformed; caller reports it
};

/* The root of a config, or a named container inside one, has to be a JSON
   object. Anything else is a file we do not understand, so it is refused
   rather than rewritten — the caller turns the throw into a failed install
   result and leaves the original bytes alone. */
const expectObject = (v: unknown, what: string): Record<string, unknown> => {
  if (!isObject(v)) throw new Error(`${what} is not a JSON object \u2014 not touching it`);
  return v;
};

/* The container our MCP entry lives in (e.g. `mcpServers`, `mcp`). Missing or
   null means "not registered yet" and gets a fresh object; a value that is
   already there has to be an object, or the file is refused. */
const container = (node: Record<string, unknown>, key: string, what: string): Record<string, unknown> => {
  const existing = node[key];
  if (existing === undefined || existing === null) {
    const fresh: Record<string, unknown> = {};
    node[key] = fresh;
    return fresh;
  }
  return expectObject(existing, `${what}: ${key}`);
};

const writeJSON = (file: string, obj: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
};

const isLink = (p: string): boolean => {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
};

/* Never beside the thing being replaced. A skills directory is scanned by the
   harness, so `spiega.bak-…` sitting next to `spiega` is not a backup — it
   is a second skill, loaded every session, with the same description and
   older contents. Backups go somewhere nothing reads. */
const backupDir = (home: string, d: string): string | null => {
  if (isLink(d) || !fs.existsSync(d)) return null;
  const b = path.join(home, '.spiega', 'backups',
    `${path.basename(d)}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.cpSync(d, b, { recursive: true });
  return b;
};

/* A skill is linked, not copied. A copy goes stale the moment the source
   changes, which is exactly what bit us: an agent kept reading a SKILL.md from
   hours earlier and knew nothing about features that had shipped. terminal-browser
   already symlinks its skill into ~/.codex/skills and ~/.gemini/skills on this
   machine; same idea. If the filesystem refuses a link, fall back to a copy and
   say so, because a stale skill beats no skill. */
const linkSkill = (home: string, dir: string, name = 'spiega'): [string, string, string] => {
  const src = path.join(ROOT, 'skills', 'spiega');
  const dest = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const already = fs.existsSync(dest) || isLink(dest);
  if (already) {
    if (isLink(dest) && fs.readlinkSync(dest) === src) return [dest, 'already linked', 'unchanged'];
    backupDir(home, dest);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(src, dest, 'dir');
    return [dest, already ? 'relinked — it tracks the repo now' : 'linked — it tracks the repo', 'written'];
  } catch (e) {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'));
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    return [dest, `copied (symlink refused: ${code}) — re-run install after changes`, 'written'];
  }
};

/* Which node installed this, remembered for the launcher.

   install only reaches this line on a node the guard at the top of cli.js has
   already checked against the engines floor, so `process.execPath` is a node
   known to be good. Without the record the launcher has to re-derive one on
   every run, and its guesses are nvm-shaped: a node from brew, asdf, volta,
   mise or a system package installed cleanly and then could not run.

   A file, not a line in bin/spiega. That launcher is tracked, so an install
   that wrote into it would dirty the checkout and the next `git pull` would
   either revert the record or refuse to move. This file is also per HOME, so
   one checkout shared between two machines keeps one answer each, which is
   the only version of the path that is true on both. */
const recordNode = (home: string): NodeRecord => {
  const node = process.execPath;
  const file = path.join(home, '.spiega', 'node');
  let before = '';
  try { before = fs.readFileSync(file, 'utf8').trim(); } catch { /* first install */ }
  if (before === node) return { node, file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, node + '\n');
  return { node, file, changed: true };
};

/* ---------- the command itself ---------- */

/* npm puts `spiega` in the active node version's bin, which joins PATH only
   when nvm's init runs in an interactive shell. An agent's tool call does not
   get that shell, so it cannot find the command at all — and falls back to
   prose without saying so. The MCP server does not care, but the binary is the
   fallback when MCP is unavailable, so the fallback has to exist.

   This puts a link to the sh launcher in a directory every shell sees, chosen
   from a short list rather than from whatever on PATH happens to be writable.
   That rule once put the link in ~/Library/Android/sdk/platform-tools, first on
   someone's PATH and owned by them: a directory the SDK manager replaces
   wholesale on update, so the link would have vanished without a word. See
   binDir() for the list. */
const AGENT_SHELL = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/bin/sh']
  .find(f => fs.existsSync(f)) || '/bin/sh';

/* The PATH an agent's tool call gets, not this shell's. `env -i` is the point:
   nvm is not sourced, so a bin that only an interactive shell knows about is
   correctly reported as missing. */
const agentPath = (home: string): string => {
  try {
    return execFileSync('env', ['-i', `HOME=${home}`, AGENT_SHELL, '-c', 'printf %s "$PATH"'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return process.env.PATH || ''; }
};

const writableDir = (d: string): boolean => {
  try { return fs.statSync(d).isDirectory() && (fs.accessSync(d, fs.constants.W_OK), true); }
  catch { return false; }
};

const DOT_LOCAL = (home: string): string => path.join(home, '.local', 'bin');
/* The conventional place for something installed by hand, and the one that
   makes CI work: a runner's agent shell is bash, which no ~/.zshenv line
   reaches, while /usr/local/bin is on its PATH and writable. */
const USR_LOCAL = '/usr/local/bin';
/* Where the link went, so the next install can move it rather than leave a
   second one behind, and so doctor and an uninstall know which one is ours. */
const LINK_FILE = (home: string): string => path.join(home, '.spiega', 'link');

/* ~/.local/bin when an agent's shell can see it; /usr/local/bin when that one
   can be seen and written instead; otherwise ~/.local/bin anyway, with the
   question about ~/.zshenv. Never any other directory on PATH: those belong to
   a toolchain — an SDK, cargo, Homebrew, nvm — which may replace or prune them,
   and nobody looks there for a tool they installed. `--bin-dir` is the way to
   choose one of those on purpose. */
export const binDir = (requested: string | null, pathDirs: string[], home: string = resolveHomeDir()): string => {
  if (requested) return path.resolve(requested);
  const local = DOT_LOCAL(home);
  if (pathDirs.includes(local)) return local;
  if (pathDirs.includes(USR_LOCAL) && writableDir(USR_LOCAL)) return USR_LOCAL;
  return local;
};

/* A link this file made: it names the launcher exactly. npm's own link is
   relative and a person's is whatever they typed, so neither ever matches,
   and only ours is moved or removed. */
const isOurLink = (file: string): boolean => {
  try { return fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === LAUNCHER; }
  catch { return false; }
};

/* Links a previous install left somewhere other than `keep`: the one it
   recorded, and any on the agent's PATH, which is how links made before there
   was a record are found. Removing them costs nothing, a symlink to our own
   launcher holds no content, and leaving them means `which -a spiega` answers
   twice, in an order that depends on whose shell is asking. */
const strayLinks = (home: string, keep: string, pathDirs: string[]): string[] => {
  let recorded: string | null = null;
  try { recorded = fs.readFileSync(LINK_FILE(home), 'utf8').trim(); } catch { /* none */ }
  const candidates = [recorded, ...pathDirs.map(d => path.join(d, 'spiega'))].filter(Boolean) as string[];
  return [...new Set(candidates)].filter(f => f !== keep && isOurLink(f));
};

const RC_MARKER = '# spiega: the launcher, for the non-interactive shells agents get';
const RC_FILE = (home: string): string => path.join(home, '.zshenv');
const RC_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/* Ask, and mean it: anything that is not a yes is a no.

   `process.stdin.isTTY` is the test for whether there is a person there at
   all. An agent's tool call, a CI step, a `curl | sh` and a pipe all fail it,
   and all of them must get "no" rather than a prompt nobody will answer. */
const askYesNo = (file: string, dir: string): boolean => {
  const g = sym();
  console.log(`\n  ${c.bold('spiega needs to be where an agent can find it.')}`);
  console.log(`  ${c.dim(`${shortPath(dir, 46)} is not on the PATH a non-interactive shell gets.`)}`);
  console.log(`\n  ${c.dim('This would add one line to')} ${c.bold(shortPath(file, 46))}${c.dim(', after backing it up:')}`);
  console.log(`      ${c.dim(RC_LINE)}`);
  if (!process.stdin.isTTY) {
    console.log(`\n  ${c.dim('Nothing here to ask, so: not done.')} ${c.dim(`${g.arrow} spiega install --path`)}\n`);
    return false;
  }
  let answer = '';
  try {
    const buf = Buffer.alloc(8);
    process.stdout.write(`\n  ${c.bold('Add it?')} ${c.dim('[y/N] ')}`);
    const n = fs.readSync(0, buf, 0, 8, null);
    answer = buf.slice(0, n).toString('utf8').trim().toLowerCase();
  } catch { answer = ''; }   // no readable stdin is also a no
  console.log('');
  return answer === 'y' || answer === 'yes';
};

/* zsh sources ~/.zshenv for every invocation, so one guarded line there is
   enough to put ~/.local/bin on an agent's PATH, and it does nothing if the
   person already put it there themselves. */
const addToZshEnv = (home: string): boolean => {
  const rc = RC_FILE(home);
  let text = '';
  try { text = fs.readFileSync(rc, 'utf8'); } catch { /* absent */ }
  if (text.includes(RC_MARKER)) return false;
  backup(rc);
  const block = `${RC_MARKER}\n`
    + 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac\n';
  fs.appendFileSync(rc, (text && !text.endsWith('\n') ? '\n' : '\n') + block);
  return true;
};

/* Say what it is about to do to your shell, and wait to be told yes.

   Editing somebody's ~/.zshenv is the most invasive thing install does, and
   the only write that lands outside a config file this tool owns. Doing it
   silently is the kind of thing a stranger finds out about afterwards, so:
   explain it and ask. Where there is nobody to ask — a script, CI, an agent's
   tool call, a pipe — the answer is no, and the line to add is printed
   instead. Never editing it without a yes is the whole point; forgetting to
   say what to do instead is how that becomes issue #9 again.

   `touchShell`: 'ask' (default), true to go ahead, false to leave it alone.
   `--path` and `--no-path` are the two overrides. `requestedDir` is
   `--bin-dir`, or null to choose. */
const ensureBinAt = (home: string, { touchShell = 'ask', confirm = askYesNo, requestedDir }: EnsureBinOptions): BinInfo => {
  const pathDirs = agentPath(home).split(':').filter(Boolean);
  const dir = binDir(requestedDir ?? null, pathDirs, home);
  fs.mkdirSync(dir, { recursive: true });

  const link = path.join(dir, 'spiega');
  let changed = false;
  let same = false;
  try { same = fs.existsSync(link) && fs.realpathSync(link) === fs.realpathSync(LAUNCHER); } catch { /* broken link */ }
  if (!same) {
    // a symlink has no contents to lose; a real file might, so it is backed up
    try {
      const st = fs.lstatSync(link);
      if (st.isFile() && !st.isSymbolicLink()) backup(link);
    } catch { /* absent */ }
    fs.rmSync(link, { force: true });
    fs.symlinkSync(LAUNCHER, link);
    changed = true;
  }
  const removed: string[] = [], stuck: string[] = [];
  for (const f of strayLinks(home, link, pathDirs)) {
    try { fs.rmSync(f, { force: true }); removed.push(f); }
    catch { stuck.push(f); }   // a root-owned directory: said, not forced
  }
  fs.mkdirSync(path.dirname(LINK_FILE(home)), { recursive: true });
  fs.writeFileSync(LINK_FILE(home), link + '\n');

  let onPath = agentPath(home).split(':').includes(dir);
  let addedToRc = false;
  let rcDeclined = false;
  let rcAsked = false;
  if (!onPath && dir === DOT_LOCAL(home)) {
    let go = touchShell === true;
    if (touchShell === 'ask') {
      rcAsked = true;
      go = confirm(RC_FILE(home), dir);
    }
    if (go) {
      addedToRc = addToZshEnv(home);
      onPath = agentPath(home).split(':').includes(dir);
    } else {
      rcDeclined = true;
    }
  }

  return { dir, link, onPath, addedToRc, rcDeclined, rcAsked, changed, removed, stuck };
};

/* The install list is a table of harness targets, and the command itself is not
   one of them; but where it landed is the thing this issue is about, so it is
   said first and in the same shape. */
const reportBin = (home: string, info: BinInfo, rec: NodeRecord | null): void => {
  const g = sym();
  const where = shortPath(info.link, 46);
  // the same column the target rows below use, so the command lines up with them
  const width = Math.max(...TARGET_NAMES.map(n => n.length)) + 2;
  if (info.rcDeclined) {
    /* Asked not to touch the shell, so this is a statement rather than a
       failure — but the line to add has to be here, or --no-path just means
       the agent silently cannot find spiega. */
    /* Declining is allowed and nothing else is withheld for it: the skills
       and the MCP entries below still install, and MCP reaches spiega by
       absolute path, so the thing works. What is missing is the fallback for
       when a harness loses its MCP child — exactly the failure in #9, which
       is silent. So say what it costs rather than only that nothing was
       written, and say it in the bad colour: this is unfinished, not fine. */
    console.log(`  ${c.warn(g.warn)} ${c.bold(pad('bin', width))}${c.dim(where)}  `
      + c.accent('linked, but NOT on the PATH an agent gets'));
    console.log(`    ${c.dim('MCP still works \u2014 it runs spiega by its full path. What is missing is')}`);
    console.log(`    ${c.dim('the fallback: an agent whose MCP server dies cannot find the command,')}`);
    console.log(`    ${c.dim('and writes prose instead of drawing, with nothing on screen to say so.')}`);
    console.log(`    ${c.dim(`To fix it later, add this to ${shortPath(RC_FILE(home), 30)}:`)}`);
    console.log(`      ${c.dim(RC_LINE)}`);
    console.log(`    ${c.dim('or re-run')} ${c.dim('spiega install --path')}`);
  } else if (!info.onPath) {
    console.log(`  ${c.accent(g.bad)} ${c.bold(pad('bin', width))}${c.dim(where)}  `
      + c.accent(`NOT on the PATH a non-interactive ${path.basename(AGENT_SHELL)} gets`));
  } else {
    const made = info.addedToRc ? ' \u2014 added ~/.local/bin to ~/.zshenv, so open a new shell' : '';
    console.log(`  ${c.good(g.ok)} ${c.bold(pad('bin', width))}${c.dim(where)}  `
      + c.dim('on the PATH a non-interactive shell gets') + c.dim(made));
  }
  /* A link moved is a change to somebody's PATH, so it is said, and one that
     could not be removed has to be, or `which -a` keeps answering twice. */
  for (const f of info.removed) {
    console.log(`    ${c.dim(`removed the link an earlier install left in ${shortPath(path.dirname(f), 46)}`)}`);
  }
  for (const f of info.stuck) {
    console.log(`    ${c.accent(`could not remove the earlier link ${shortPath(f, 46)} \u2014 remove it by hand`)}`);
  }
  /* The link being findable is only half of "it runs": the launcher still
     needs a node, and on a machine whose node is not nvm's this recording is
     what makes the command work at all. Saying which one it is means nobody
     has to run doctor to find out why an agent got further than the terminal. */
  if (rec) {
    console.log(`  ${c.good(g.ok)} ${c.bold(pad('node', width))}${c.dim(shortPath(rec.node, 46))}  `
      + c.dim(rec.changed ? 'recorded for the launcher' : 'already recorded for the launcher'));
  }
};

/* One MCP registration, written into whatever shape a harness expects. The
   three shapes below are not guesses: each was read off a working codegraph
   entry in that harness's own config on a real machine. */
const mcpJSON = (file: string, key: string, value: unknown): [string, string, string] => {
  const name = path.basename(file);
  const cfg = expectObject(readJSON(file), name);
  const parts = key.split('.');
  let node: Record<string, unknown> = cfg;
  for (const k of parts) node = container(node, k, name);
  const before = JSON.stringify(node.spiega);
  node.spiega = value;
  if (before === JSON.stringify(value)) return [file, 'already registered', 'unchanged'];
  const b = backup(file);
  writeJSON(file, cfg);
  return [file, b ? `backed up to ${path.basename(b)}` : 'created', 'written'];
};

/* No board name is pinned here, deliberately.

   A board per harness looked right until the real usage turned up: four
   opencode tasks and four Claude Code tasks at once, each its own problem.
   Pinning `SPIEGA_BOARD=opencode` would have forced all four onto one board
   and overridden the per-task naming that makes them separate. The name is
   worked out per session instead — see boardName() in board/server.js.

   It would not have worked anyway: an opencode MCP server is a child of one
   long-lived daemon and inherits the environment that daemon started with, so
   every session would have read the same value. */
const STDIO = (): Record<string, unknown> => ({ type: 'stdio', command: 'node', args: [MCP_ENTRY] });

/* A target that does three things changed if any one of them did. Saying
   "installed" when nothing moved trains people to ignore the output. */
const combine = (parts: Array<readonly [unknown, unknown, string]>): string =>
  (parts.some(p => p[2] === 'written') ? 'written' : 'unchanged');

/* The instruction file a harness reads every turn. */
const agentsFile = (file: string): [string, string, string] => {
  const r = upsertBlock(fs, file);
  if (!r.changed || r.text === undefined) return [file, 'already there', 'unchanged'];
  const b = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  return [file, b ? `${r.how}, backed up to ${path.basename(b)}` : r.how, 'written'];
};

/* ---------- targets ---------- */

const makeTargets = (home: string, config: string): Record<string, Target> => ({
  /* The MCP server is not a nicety here, it is the only reliable route.
     Claude Code had the skill alone for a while, which meant the only way to
     actually draw was to shell out to `spiega` — and the CLI lives wherever
     npm put it, which with nvm is a directory that exists on PATH only in
     shells that source nvm's init. An agent's tool shell is not one. The
     observed failure is worse than it sounds: the skill loads, the agent
     decides to draw, `command -v spiega` fails, and it falls back to prose
     without saying anything, which is indistinguishable from never having
     considered the board at all. MCP is launched by the harness with its own
     environment and an absolute entry path, so it does not care. */
  claude: {
    what: 'Claude Code — skill and MCP server',
    app: 'Claude Code',
    gets: 'skill, MCP',
    detect: () => fs.existsSync(path.join(home, '.claude')),
    run: () => {
      const parts = [
        linkSkill(home, path.join(home, '.claude', 'skills')),
        mcpJSON(path.join(home, '.claude.json'), 'mcpServers', STDIO()),
      ];
      return [parts[0][0], `skill, MCP server; restart Claude Code to pick it up`, combine(parts)];
    },
  },

  codex: {
    what: 'Codex — skill, MCP server and AGENTS.md',
    app: 'Codex',
    gets: 'skill, MCP, AGENTS.md',
    detect: () => fs.existsSync(path.join(home, '.codex')),
    run: () => {
      const skill = linkSkill(home, path.join(home, '.codex', 'skills'));
      const block = agentsFile(path.join(home, '.codex', 'AGENTS.md'));
      const where = skill[0];
      // Codex keeps its MCP servers in TOML; add the table only if absent,
      // since rewriting someone's TOML by hand is how comments get eaten.
      const file = path.join(home, '.codex', 'config.toml');
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      let note = 'skill, AGENTS.md';
      let wroteMcp = false;
      /* Add our table, or repoint it. Add-only was the first version, on the
         grounds that rewriting someone's TOML eats their comments — but it
         also left a table pointing at a checkout that had since moved, while
         install reported success. See toml.js for why this is not a regex
         written inline. */
      const body = `[mcp_servers.spiega]\ncommand = "node"\nargs = ["${MCP_ENTRY}"]\n`;
      const up = upsertTable(raw, 'spiega', body);
      if (up.how !== 'unchanged') {
        backup(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, up.text);
        note += up.how === 'added' ? ', MCP server' : ', MCP repointed';
        wroteMcp = true;
      } else note += ', MCP already registered';
      return [where, note, combine([skill, block, [null, null, wroteMcp ? 'written' : 'unchanged']])];
    },
  },

  gemini: {
    what: 'Gemini CLI — skill, MCP server and GEMINI.md',
    app: 'Gemini CLI',
    gets: 'skill, MCP, GEMINI.md',
    detect: () => fs.existsSync(path.join(home, '.gemini')),
    run: () => {
      const parts = [
        linkSkill(home, path.join(home, '.gemini', 'skills')),
        mcpJSON(path.join(home, '.gemini', 'settings.json'), 'mcpServers', STDIO()),
        agentsFile(path.join(home, '.gemini', 'GEMINI.md')),
      ];
      return [parts[0][0], 'skill, MCP server, GEMINI.md', combine(parts)];
    },
  },

  opencode: {
    what: 'opencode — MCP server and AGENTS.md',
    app: 'opencode',
    gets: 'MCP, AGENTS.md',
    detect: () => fs.existsSync(path.join(config, 'opencode')),
    run: () => {
      const file = path.join(config, 'opencode', 'opencode.json');
      const cfg = expectObject(readJSON(file), path.basename(file));
      const mcp = container(cfg, 'mcp', path.basename(file));
      const want = { type: 'local', command: ['node', MCP_ENTRY], enabled: true };
      let note: string, wrote = false;
      if (JSON.stringify(mcp.spiega) === JSON.stringify(want)) note = 'MCP already registered';
      else { const b = backup(file); mcp.spiega = want; writeJSON(file, cfg); note = b ? 'MCP registered, config backed up' : 'MCP registered'; wrote = true; }
      // opencode reads no skill file, so the judgement has to ride in AGENTS.md
      const block = agentsFile(path.join(config, 'opencode', 'AGENTS.md'));
      return [file, `${note}; AGENTS.md ${block[1]}`,
        combine([block, [null, null, wrote ? 'written' : 'unchanged']])];
    },
  },

  /* pi reads skills, but a skill only loads when the model thinks to look,
     which is the failure the AGENTS.md block was written against; so pi gets
     all three, like Codex and Gemini. */
  pi: {
    what: 'pi — skill, MCP server and AGENTS.md',
    app: 'pi',
    gets: 'skill, MCP, AGENTS.md',
    detect: () => fs.existsSync(piDir()),
    run: () => {
      const parts = [
        linkSkill(home, path.join(piDir(), 'skills')),
        mcpJSON(path.join(piDir(), 'mcp.json'), 'mcpServers', piMcpEntry(MCP_ENTRY)),
        agentsFile(piInstructionsFile()),
      ];
      return [parts[0][0], `skill, MCP server, ${path.basename(piInstructionsFile())}; /reload or start a new pi session to pick it up`,
        combine(parts)];
    },
  },

  copilot: {
    what: 'GitHub Copilot CLI — MCP server',
    app: 'Copilot CLI',
    gets: 'MCP',
    detect: () => fs.existsSync(path.join(home, '.copilot')),
    run: () => mcpJSON(path.join(home, '.copilot', 'mcp-config.json'), 'mcpServers', { ...STDIO(), tools: ['*'] }),
  },

  cursor: {
    what: 'Cursor — MCP server and a rule',
    app: 'Cursor',
    gets: 'MCP, rule',
    detect: () => fs.existsSync(path.join(home, '.cursor')),
    run: () => {
      const dir = path.join(home, '.cursor', 'rules');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'spiega.mdc');
      const before = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
      const src = fs.readFileSync(path.join(ROOT, 'integrations/cursor/spiega.mdc'), 'utf8');
      if (before !== src) fs.writeFileSync(out, src);
      const mcp = mcpJSON(path.join(home, '.cursor', 'mcp.json'), 'mcpServers', STDIO());
      return [mcp[0], mcp[1], combine([mcp, [null, null, before === src ? 'unchanged' : 'written']])];
    },
  },

  windsurf: {
    what: 'Windsurf — MCP server',
    app: 'Windsurf',
    gets: 'MCP',
    detect: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')),
    run: () => mcpJSON(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', STDIO()),
  },

  zed: {
    what: 'Zed — context server',
    app: 'Zed',
    gets: 'context server',
    detect: () => fs.existsSync(path.join(config, 'zed')),
    run: () => mcpJSON(path.join(config, 'zed', 'settings.json'), 'context_servers',
      { source: 'custom', command: 'node', args: [MCP_ENTRY] }),
  },

  vscode: {
    what: 'VS Code — MCP server',
    app: 'VS Code',
    gets: 'MCP',
    detect: () => fs.existsSync(vscodeUserDir(home)),
    run: () => mcpJSON(path.join(vscodeUserDir(home), 'mcp.json'), 'servers', STDIO()),
  },

  claude_desktop: {
    what: 'Claude Desktop — MCP server',
    app: 'Claude Desktop',
    gets: 'MCP',
    detect: () => fs.existsSync(claudeDesktopDir(home)),
    run: () => mcpJSON(path.join(claudeDesktopDir(home), 'claude_desktop_config.json'), 'mcpServers',
      { command: 'node', args: [MCP_ENTRY] }),
  },

  /* herdr runs the panes these sessions live in, and it has a plugin system,
     so the board can be reached from the pane without knowing its name. */
  herdr: {
    what: 'herdr — a plugin: reach this task\'s board from its pane',
    app: 'herdr',
    gets: 'plugin',
    detect: () => fs.existsSync(path.join(config, 'herdr')),
    run: () => {
      const dir = path.join(ROOT, 'integrations', 'herdr');
      // linking twice is harmless but reporting it as work is not: ask first
      let listed = '';
      try {
        listed = execFileSync('herdr', ['plugin', 'list'],
          { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { /* herdr may not be running; link anyway */ }
      if (listed.includes('spiega.board') && listed.includes(dir)) {
        return [dir, 'already linked', 'unchanged'];
      }
      try {
        execFileSync('herdr', ['plugin', 'link', dir],
          { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        const msg = e instanceof Error ? String((e as { stderr?: string }).stderr || e.message).split('\n')[0] : String(e);
        throw new Error(`herdr plugin link failed (${msg})`);
      }
      return [dir, 'linked — bind a key to "spiega: show this task\'s board"', 'written'];
    },
  },

  /* Anything else. AGENTS.md is the one instruction file the whole field has
     converged on, so a harness nobody has wired up yet still gets the
     guidance if it reads the repo it is working in. */
  project: {
    what: 'this repo — AGENTS.md, for any agent working here',
    app: 'this repo',
    gets: 'AGENTS.md',
    detect: () => true,
    run: () => agentsFile(path.resolve('AGENTS.md')),
  },
});

function vscodeUserDir(home: string): string {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || home, 'Code', 'User')
      : path.join(home, '.config', 'Code', 'User');
}

function claudeDesktopDir(home: string): string {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Claude')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || home, 'Claude')
      : path.join(home, '.config', 'Claude');
}

/* The targets for this machine, read from the environment. The Effect program
   below builds the same map from the SpiegaHome service; this is the door the
   suite and the CLI walk through, and the two must agree. */
export const TARGETS: Record<string, Target> = makeTargets(resolveHomeDir(), resolveConfigDir(resolveHomeDir()));
export const TARGET_NAMES: string[] = Object.keys(TARGETS);

/* What is actually on this machine. `spiega install` with no arguments does
   only these, because writing a config for a harness someone does not use is
   how you end up with a file they never asked for. `project` is excluded: it
   writes into the working directory and should always be asked for by name. */
const detectAt = (targets: Record<string, Target>): string[] =>
  Object.entries(targets)
    .filter(([n, t]) => n !== 'project' && t.detect())
    .map(([n]) => n);

export function detect(): string[] {
  return detectAt(TARGETS);
}

/* ---------- the Effect program, and the door ---------- */

export const installEffect = (
  names: string[] | undefined,
  { touchShell = 'ask', binDir: requestedDir = null }: InstallOptions,
): Effect.Effect<InstallResult[], never, SpiegaHome> => Effect.gen(function* () {
  const home = yield* SpiegaHome;
  const targets = makeTargets(home.home, home.config);

  let rec: NodeRecord | null = null;
  try { rec = recordNode(home.home); }
  catch (e) {
    const g = sym();
    console.log(`  ${c.accent(g.bad)} ${c.bold(pad('node', 12))}${c.accent(`could not record the node for the launcher: ${(e as Error).message}`)}`);
  }
  try { reportBin(home.home, ensureBinAt(home.home, { touchShell, requestedDir }), rec); }
  catch (e) {
    const g = sym();
    console.log(`  ${c.accent(g.bad)} ${c.bold(pad('bin', 12))}${c.accent(`could not link the command: ${(e as Error).message}`)}`);
  }
  const want = names?.length ? names : detectAt(targets);
  const out: InstallResult[] = [];
  for (const n of want) {
    const t = targets[n];
    if (!t) { out.push({ name: n, ok: false, what: '', app: '', gets: '', note: 'no such target', state: 'failed' }); continue; }
    try {
      const [where, note, declared] = t.run();
      // "already there" and "written" look different in a list and should
      // read differently; the targets say so in their note, so classify once
      // here rather than making every caller parse English
      // the target says so when it knows; the wording is only a fallback
      const state: State = declared === 'written' || declared === 'unchanged'
        ? declared
        : (/\balready\b/i.test(note || '') ? 'unchanged' : 'written');
      out.push({ name: n, ok: true, what: t.what, app: t.app, gets: t.gets, where, note, state });
    } catch (e) {
      out.push({ name: n, ok: false, what: t.what, app: t.app, gets: t.gets, note: (e as Error).message, state: 'failed' });
    }
  }
  return out;
});

/* The door: run the Effect against this machine, reading home and config from
   the environment exactly as the old module did. */
export function install(names: string[] | undefined, opts: InstallOptions = {}): InstallResult[] {
  return Effect.runSync(installEffect(names, opts).pipe(Effect.provide(SpiegaHome.layer)));
}

/* The door for the bin half alone, which the suite drives directly. */
export function ensureBin(opts: EnsureBinOptions = {}): BinInfo {
  return ensureBinAt(resolveHomeDir(), opts);
}
