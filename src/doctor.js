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
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { START, END, BLOCK } from './agents-block.js';
import { c, sym, pad, heading } from './term.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = os.homedir();
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
const SKILL_SRC = path.join(ROOT, 'skills', 'spiega');

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch { return null; }
};

const ok = (what, detail) => ({ level: 'ok', what, detail });
const warn = (what, detail, fix) => ({ level: 'warn', what, detail, fix });
const bad = (what, detail, fix) => ({ level: 'bad', what, detail, fix });

const tilde = p => String(p).replace(HOME, '~');

/* ---------- the checkout ---------- */

function checkout(rows) {
  const head = sh('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']);
  if (!head) { rows.push(warn('checkout', 'not a git checkout, so there is nothing to compare against')); return 0; }

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

/* ---------- the CLI on PATH ---------- */

function cli(rows) {
  const which = sh('sh', ['-c', 'command -v spiega']);
  if (!which) {
    return rows.push(bad('spiega on PATH', 'not found', `cd ${tilde(ROOT)} && npm link`));
  }
  let real = which;
  try { real = fs.realpathSync(which); } catch { /* leave as-is */ }
  const mine = path.resolve(ROOT, 'src', 'cli.js');
  rows.push(real === mine
    ? ok('spiega on PATH', `${tilde(which)} → this checkout`)
    : bad('spiega on PATH', `${tilde(which)} → ${tilde(real)}, which is NOT this checkout`,
        `cd ${tilde(ROOT)} && npm link`));
}

/* ---------- skills ---------- */

const SKILL_DIRS = {
  claude: path.join(HOME, '.claude', 'skills', 'spiega'),
  codex: path.join(HOME, '.codex', 'skills', 'spiega'),
  gemini: path.join(HOME, '.gemini', 'skills', 'spiega'),
};

function skills(rows) {
  for (const [name, dest] of Object.entries(SKILL_DIRS)) {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) continue;                 // that harness is not here
    let st = null;
    try { st = fs.lstatSync(dest); } catch { /* absent */ }
    if (!st) { rows.push(warn(`${name} skill`, 'not installed', `spiega install ${name}`)); continue; }

    if (st.isSymbolicLink()) {
      const to = fs.readlinkSync(dest);
      rows.push(to === SKILL_SRC
        ? ok(`${name} skill`, 'linked — tracks the checkout')
        : bad(`${name} skill`, `linked to ${tilde(to)}, not this checkout`, `spiega install ${name}`));
      continue;
    }
    // a copy: current only until the source changes, so compare it
    const a = fs.readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8');
    let b = null;
    try { b = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'); } catch { /* unreadable */ }
    rows.push(a === b
      ? warn(`${name} skill`, 'a copy, currently identical', 'it will go stale on the next change; re-link with `spiega install`')
      : bad(`${name} skill`, 'a copy, and out of date', `spiega install ${name}`));
  }
}

/* ---------- instruction blocks ---------- */

const AGENT_FILES = {
  opencode: path.join(HOME, '.config', 'opencode', 'AGENTS.md'),
  codex: path.join(HOME, '.codex', 'AGENTS.md'),
  gemini: path.join(HOME, '.gemini', 'GEMINI.md'),
};

function blocks(rows) {
  for (const [name, file] of Object.entries(AGENT_FILES)) {
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

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const MCP_FILES = [
  ['claude', path.join(HOME, '.claude.json'), c => c?.mcpServers?.spiega?.args?.[0]],
  ['opencode', path.join(HOME, '.config', 'opencode', 'opencode.json'), c => c?.mcp?.spiega?.command?.[1]],
  ['gemini', path.join(HOME, '.gemini', 'settings.json'), c => c?.mcpServers?.spiega?.args?.[0]],
  ['copilot', path.join(HOME, '.copilot', 'mcp-config.json'), c => c?.mcpServers?.spiega?.args?.[0]],
  ['cursor', path.join(HOME, '.cursor', 'mcp.json'), c => c?.mcpServers?.spiega?.args?.[0]],
  ['windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), c => c?.mcpServers?.spiega?.args?.[0]],
];

function registrations(rows) {
  for (const [name, file, pick] of MCP_FILES) {
    if (!fs.existsSync(file)) continue;
    const entry = pick(readJSON(file));
    if (!entry) { rows.push(warn(`${name} MCP`, 'not registered', `spiega install ${name}`)); continue; }
    rows.push(entry === MCP_ENTRY
      ? ok(`${name} MCP`, 'points at this checkout')
      : bad(`${name} MCP`, `points at ${tilde(entry)}`, `spiega install ${name}`));
  }
  // Codex keeps its servers in TOML
  const toml = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(toml)) {
    const raw = fs.readFileSync(toml, 'utf8');
    const has = /^\s*\[mcp_servers\.spiega\]/m.test(raw);
    rows.push(has && raw.includes(MCP_ENTRY)
      ? ok('codex MCP', 'points at this checkout')
      : warn('codex MCP', has ? 'registered, but not at this checkout' : 'not registered', 'spiega install codex'));
  }
}

/* ---------- processes, which is the one that actually bites ---------- */

/* When did a process start? `ps -o lstart=` is the portable-enough answer and
   is absolute, where elapsed time has to be parsed out of [[dd-]hh:]mm:ss. */
function startedAt(pid) {
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

   Exported, and taking the listing as an argument, so the cases that matter
   can be tested without starting anything. */
export function scanProcesses(psOutput, root) {
  const out = { boards: [], mcp: [] };
  for (const line of String(psOutput || '').split('\n')) {
    if (line.includes('ps -Ao')) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid) continue;
    const isMcp = /\/src\/mcp\/server\.js(?:\s|$)/.test(line);
    // `cli.js serve`, and not some other subcommand that mentions the word
    const isBoard = /\/src\/cli\.js\s/.test(line) && /\bserve\b/.test(line);
    if (!isMcp && !isBoard) continue;
    (isMcp ? out.mcp : out.boards).push({ pid, here: line.includes(`${root}/`) });
  }
  return out;
}

function processes(rows, headTime) {
  const ps = sh('ps', ['-Ao', 'pid=,command=']) || '';
  const { boards, mcp } = scanProcesses(ps, ROOT);

  /* Stale means either of two things, and both leave an agent talking to code
     that is not the code on disk: started before the current commit, or
     started from somewhere that is no longer this checkout. */
  const stale = list => list.filter(p => {
    if (!p.here) return true;
    const t = startedAt(p.pid);
    return t != null && headTime && t < headTime;
  });

  const why = list => {
    const moved = list.filter(p => !p.here).length;
    const old = list.length - moved;
    return [moved && `${moved} from a previous location`, old && `${old} older than the current commit`]
      .filter(Boolean).join(', ');
  };

  /* Naming the stale boards matters, because restarting one loses its drawing
     — boards are in memory only — so this is a decision, not a chore, and it
     should not be made by a blanket `stop --all`. */
  const oldBoards = stale(boards);
  if (!oldBoards.length) {
    rows.push(ok('board server', boards.length ? `${boards.length} running, all current` : 'none running'));
  } else {
    let names = [];
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(HOME, '.spiega', 'boards.json'), 'utf8'));
      const pids = new Set(oldBoards.map(p => p.pid));
      names = Object.entries(reg).filter(([, b]) => pids.has(b.pid)).map(([n]) => n);
    } catch { /* a board from before the registry */ }
    rows.push(bad('board server',
      `${why(oldBoards)}${names.length ? `: ${names.join(', ')}` : ''}`,
      'spiega stop --board <name>, then draw again \u2014 note the drawing is lost (no persistence yet)'));
  }

  const oldMcp = stale(mcp);
  rows.push(oldMcp.length
    ? bad('agent MCP server', `${mcp.length} running, ${why(oldMcp)}`,
        'start a fresh agent session \u2014 a running one keeps the server it launched')
    : ok('agent MCP server', mcp.length ? `${mcp.length} running, all current` : 'none running'));
}

/* ---------- the report ---------- */

/* Anything the old name left behind. A rename that is half-done is worse than
   one not started: two skills, two MCP registrations, two instruction blocks,
   and an agent reading whichever it finds first. */
function legacy(rows) {
  const OLD = 'handwave';
  const seen = [];
  const oldDir = path.join(HOME, `.${OLD}`);
  /* A link forward to the new directory is a deliberate bridge for processes
     that started before the rename, not debris. It is reported so it does not
     become permanent, but it is not a fault. */
  const bridged = (() => {
    try {
      return fs.lstatSync(oldDir).isSymbolicLink()
        && fs.realpathSync(oldDir) === fs.realpathSync(path.join(HOME, '.spiega'));
    } catch { return false; }
  })();
  if (bridged) {
    rows.push(warn('old path', `~/.${OLD} still points at ~/.spiega for processes started before the rename`,
      'spiega migrate removes it once none are left'));
  } else if (fs.existsSync(oldDir)) {
    seen.push(`~/.${OLD}`);
  }
  for (const [name, dir] of Object.entries(SKILL_DIRS)) {
    const old = path.join(path.dirname(dir), OLD);
    try { if (fs.lstatSync(old)) seen.push(`${name} skill`); } catch { /* absent */ }
  }
  for (const [name, file] of Object.entries(AGENT_FILES)) {
    try {
      if (fs.readFileSync(file, 'utf8').includes(`<!-- ${OLD.toUpperCase()}_START -->`)) {
        seen.push(`${name} block`);
      }
    } catch { /* absent */ }
  }
  for (const [name, file, ] of MCP_FILES) {
    const cfg = readJSON(file);
    const flat = cfg ? JSON.stringify(cfg) : '';
    if (flat.includes(`"${OLD}"`)) seen.push(`${name} MCP`);
  }
  if (seen.length) rows.push(bad('left by the old name', seen.join(', '), 'spiega migrate'));
}

export function doctor() {
  const rows = [];
  const headTime = checkout(rows);
  cli(rows);
  skills(rows);
  blocks(rows);
  registrations(rows);
  legacy(rows);
  processes(rows, headTime);
  return rows;
}

export function format(rows) {
  const g = sym();
  const mark = { ok: c.good(g.ok), warn: c.warn(g.warn), bad: c.accent(g.bad) };
  const tint = { ok: c.dim, warn: c.plain, bad: c.plain };
  const w = Math.max(...rows.map(r => r.what.length)) + 2;

  const out = [heading('spiega doctor')];
  for (const r of rows) out.push(`  ${mark[r.level]} ${c.bold(pad(r.what, w))}${tint[r.level](r.detail)}`);

  const fixes = [...new Set(rows.filter(r => r.fix).map(r => r.fix))];
  if (fixes.length) {
    out.push('', `  ${c.bold('To fix')}`);
    for (const f of fixes) out.push(`    ${c.dim(g.arrow)} ${f}`);
  } else {
    out.push('', `  ${c.good(g.ok)} ${c.dim('Everything an agent reads is current.')}`);
  }
  out.push('');
  return out.join('\n');
}
