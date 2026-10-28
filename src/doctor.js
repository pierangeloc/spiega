/* ============================================================
   handwave doctor — is what is running the thing that is on disk?

   handwave reaches an agent through four different kinds of thing, and they go
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOME = os.homedir();
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
const SKILL_SRC = path.join(ROOT, 'skills', 'handwave');

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
  const which = sh('sh', ['-c', 'command -v handwave']);
  if (!which) {
    return rows.push(bad('handwave on PATH', 'not found', `cd ${tilde(ROOT)} && npm link`));
  }
  let real = which;
  try { real = fs.realpathSync(which); } catch { /* leave as-is */ }
  const mine = path.resolve(ROOT, 'src', 'cli.js');
  rows.push(real === mine
    ? ok('handwave on PATH', `${tilde(which)} → this checkout`)
    : bad('handwave on PATH', `${tilde(which)} → ${tilde(real)}, which is NOT this checkout`,
        `cd ${tilde(ROOT)} && npm link`));
}

/* ---------- skills ---------- */

const SKILL_DIRS = {
  claude: path.join(HOME, '.claude', 'skills', 'handwave'),
  codex: path.join(HOME, '.codex', 'skills', 'handwave'),
  gemini: path.join(HOME, '.gemini', 'skills', 'handwave'),
};

function skills(rows) {
  for (const [name, dest] of Object.entries(SKILL_DIRS)) {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) continue;                 // that harness is not here
    let st = null;
    try { st = fs.lstatSync(dest); } catch { /* absent */ }
    if (!st) { rows.push(warn(`${name} skill`, 'not installed', `handwave install ${name}`)); continue; }

    if (st.isSymbolicLink()) {
      const to = fs.readlinkSync(dest);
      rows.push(to === SKILL_SRC
        ? ok(`${name} skill`, 'linked — tracks the checkout')
        : bad(`${name} skill`, `linked to ${tilde(to)}, not this checkout`, `handwave install ${name}`));
      continue;
    }
    // a copy: current only until the source changes, so compare it
    const a = fs.readFileSync(path.join(SKILL_SRC, 'SKILL.md'), 'utf8');
    let b = null;
    try { b = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'); } catch { /* unreadable */ }
    rows.push(a === b
      ? warn(`${name} skill`, 'a copy, currently identical', 'it will go stale on the next change; re-link with `handwave install`')
      : bad(`${name} skill`, 'a copy, and out of date', `handwave install ${name}`));
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
    if (i < 0) { rows.push(warn(`${name} AGENTS.md`, 'no handwave block', `handwave install ${name}`)); continue; }
    const current = text.slice(i + START.length, j).trim() === BLOCK.trim();
    rows.push(current
      ? ok(`${name} AGENTS.md`, 'block is current')
      : bad(`${name} AGENTS.md`, 'block is an older wording', `handwave install ${name}`));
  }
}

/* ---------- MCP registrations ---------- */

const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const MCP_FILES = [
  ['opencode', path.join(HOME, '.config', 'opencode', 'opencode.json'), c => c?.mcp?.handwave?.command?.[1]],
  ['gemini', path.join(HOME, '.gemini', 'settings.json'), c => c?.mcpServers?.handwave?.args?.[0]],
  ['copilot', path.join(HOME, '.copilot', 'mcp-config.json'), c => c?.mcpServers?.handwave?.args?.[0]],
  ['cursor', path.join(HOME, '.cursor', 'mcp.json'), c => c?.mcpServers?.handwave?.args?.[0]],
  ['windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), c => c?.mcpServers?.handwave?.args?.[0]],
];

function registrations(rows) {
  for (const [name, file, pick] of MCP_FILES) {
    if (!fs.existsSync(file)) continue;
    const entry = pick(readJSON(file));
    if (!entry) { rows.push(warn(`${name} MCP`, 'not registered', `handwave install ${name}`)); continue; }
    rows.push(entry === MCP_ENTRY
      ? ok(`${name} MCP`, 'points at this checkout')
      : bad(`${name} MCP`, `points at ${tilde(entry)}`, `handwave install ${name}`));
  }
  // Codex keeps its servers in TOML
  const toml = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(toml)) {
    const raw = fs.readFileSync(toml, 'utf8');
    const has = /^\s*\[mcp_servers\.handwave\]/m.test(raw);
    rows.push(has && raw.includes(MCP_ENTRY)
      ? ok('codex MCP', 'points at this checkout')
      : warn('codex MCP', has ? 'registered, but not at this checkout' : 'not registered', 'handwave install codex'));
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

function processes(rows, headTime) {
  const ps = sh('ps', ['-Ao', 'pid=,command=']) || '';
  const lines = ps.split('\n');
  const find = needle => lines
    .filter(l => l.includes(needle) && !l.includes('ps -Ao'))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(Boolean);

  const older = pids => pids.filter(p => {
    const t = startedAt(p);
    return t != null && headTime && t < headTime;
  });

  /* Board servers. Naming the stale ones matters, because restarting one loses
     its drawing — boards are in memory only — so this is a decision, not a
     chore, and it should not be made by a blanket `stop --all`. */
  const boards = older(find(path.join(ROOT, 'src', 'cli.js')).filter(() => ps.includes('serve')));
  if (!boards.length) {
    rows.push(ok('board server', 'none running on older code'));
  } else {
    let names = [];
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(HOME, '.handwave', 'boards.json'), 'utf8'));
      names = Object.entries(reg).filter(([, b]) => boards.includes(b.pid)).map(([n]) => n);
    } catch { /* a board from before the registry */ }
    rows.push(bad('board server',
      `${boards.length} started before the current commit${names.length ? `: ${names.join(', ')}` : ''}`,
      'handwave stop --board <name>, then draw again — note the drawing is lost (no persistence yet)'));
  }

  const mcp = find(MCP_ENTRY);
  const staleMcp = older(mcp);
  rows.push(staleMcp.length
    ? bad('agent MCP server', `${mcp.length} running, ${staleMcp.length} started before the current commit`,
        'start a fresh agent session — a running one keeps the server it launched')
    : ok('agent MCP server', mcp.length ? `${mcp.length} running, all current` : 'none running'));
}

/* ---------- the report ---------- */

export function doctor() {
  const rows = [];
  const headTime = checkout(rows);
  cli(rows);
  skills(rows);
  blocks(rows);
  registrations(rows);
  processes(rows, headTime);
  return rows;
}

export function format(rows) {
  const mark = { ok: ' ✓', warn: ' !', bad: ' ✗' };
  const w = Math.max(...rows.map(r => r.what.length)) + 2;
  const out = rows.map(r => `${mark[r.level]} ${r.what.padEnd(w)}${r.detail}`);

  const fixes = [...new Set(rows.filter(r => r.fix).map(r => r.fix))];
  if (fixes.length) {
    out.push('', 'To fix:');
    for (const f of fixes) out.push(`  ${f}`);
  } else {
    out.push('', 'Everything an agent reads is current.');
  }
  return out.join('\n');
}
