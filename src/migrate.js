/* ============================================================
   handwave → spiega.

   A rename is not a string replacement in a repository. The old name is also
   written into the machine: a state directory, environment variables, blocks
   pasted into instruction files, symlinks in three skills directories, keys in
   six MCP configs, and a plugin registered with a terminal multiplexer. Miss
   one and it fails later, quietly, in front of whoever is using it.

   This repository has already proved that. The previous rename, archboard →
   handwave, moved a Cursor rule file and left `install.js` copying the old
   path, so `install cursor` was broken for weeks before a test found it.

   So: every surface the old name reached is listed here, and each is either
   migrated or reported. Nothing is deleted that holds content — a board
   registry is moved, not dropped — and anything this cannot do itself is
   printed as an instruction, because a silent half-migration is the failure
   mode worth engineering against.
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const OLD = 'handwave';
const NEW = 'spiega';

const OLD_DIR = path.join(HOME, `.${OLD}`);
const NEW_DIR = path.join(HOME, `.${NEW}`);

const done = (what, detail) => ({ level: 'done', what, detail });
const skip = (what, detail) => ({ level: 'skip', what, detail });
const todo = (what, detail) => ({ level: 'todo', what, detail });

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/* The state directory, boards registry and all. Moved rather than recreated,
   because it holds the registry of running boards and losing it orphans them:
   the servers keep listening and nothing can find them again. */
function stateDir(rows) {
  if (!fs.existsSync(OLD_DIR)) return rows.push(skip('state directory', 'nothing to move'));
  if (fs.existsSync(NEW_DIR)) {
    return rows.push(todo('state directory',
      `both ~/.${OLD} and ~/.${NEW} exist — merge them by hand, then remove ~/.${OLD}`));
  }
  fs.renameSync(OLD_DIR, NEW_DIR);
  rows.push(done('state directory', `~/.${OLD} ${'→'} ~/.${NEW}`));
}

/* Skills are symlinked, so the old link points at a path that no longer
   exists. Remove it: a dangling skill directory is loaded by some harnesses
   and read as a second, broken skill. */
function skills(rows) {
  const dirs = {
    claude: path.join(HOME, '.claude', 'skills'),
    codex: path.join(HOME, '.codex', 'skills'),
    gemini: path.join(HOME, '.gemini', 'skills'),
  };
  for (const [name, dir] of Object.entries(dirs)) {
    const old = path.join(dir, OLD);
    if (!fs.existsSync(old) && !isLink(old)) continue;
    if (isLink(old)) {
      fs.rmSync(old, { force: true });
      rows.push(done(`${name} skill`, `removed the old ${OLD} link`));
    } else {
      rows.push(todo(`${name} skill`, `${old} is a real directory, not a link — remove it by hand`));
    }
  }
}

/* An MCP registration keyed by the old name. Dropped, since `install` adds the
   new one; leaving both would start two servers and give the agent every tool
   twice. */
function registrations(rows) {
  const targets = [
    ['opencode', path.join(HOME, '.config', 'opencode', 'opencode.json'), c => c.mcp],
    ['gemini', path.join(HOME, '.gemini', 'settings.json'), c => c.mcpServers],
    ['copilot', path.join(HOME, '.copilot', 'mcp-config.json'), c => c.mcpServers],
    ['cursor', path.join(HOME, '.cursor', 'mcp.json'), c => c.mcpServers],
    ['windsurf', path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), c => c.mcpServers],
    ['vscode', vscodeMcp(), c => c.servers],
    ['claude_desktop', claudeDesktopCfg(), c => c.mcpServers],
    ['zed', path.join(HOME, '.config', 'zed', 'settings.json'), c => c.context_servers],
  ];
  for (const [name, file, pick] of targets) {
    if (!file || !fs.existsSync(file)) continue;
    const cfg = readJSON(file);
    const node = cfg && pick(cfg);
    if (!node || !(OLD in node)) continue;
    delete node[OLD];
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    rows.push(done(`${name} MCP`, `dropped the old ${OLD} entry`));
  }

  // Codex keeps its servers in TOML, where a table has to be cut out by hand
  const toml = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(toml)) {
    const raw = fs.readFileSync(toml, 'utf8');
    if (new RegExp(`^\\s*\\[mcp_servers\\.${OLD}\\]`, 'm').test(raw)) {
      const cut = raw.replace(new RegExp(`\\n?\\[mcp_servers\\.${OLD}\\][^\\[]*`, 'm'), '\n');
      fs.writeFileSync(toml, cut.replace(/\n{3,}/g, '\n\n'));
      rows.push(done('codex MCP', `dropped the old [mcp_servers.${OLD}] table`));
    }
  }
}

function vscodeMcp() {
  const dir = process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User')
    : path.join(HOME, '.config', 'Code', 'User');
  return path.join(dir, 'mcp.json');
}

function claudeDesktopCfg() {
  const dir = process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Claude')
    : path.join(HOME, '.config', 'Claude');
  return path.join(dir, 'claude_desktop_config.json');
}

/* The instruction block, pasted into files people wrote themselves. Cut the
   old one out whole; `install` then writes the new one. Leaving both would
   give the agent two sets of instructions under two different names, one of
   which no longer exists. */
function blocks(rows) {
  const files = [
    ['opencode', path.join(HOME, '.config', 'opencode', 'AGENTS.md')],
    ['codex', path.join(HOME, '.codex', 'AGENTS.md')],
    ['gemini', path.join(HOME, '.gemini', 'GEMINI.md')],
  ];
  const start = `<!-- ${OLD.toUpperCase()}_START -->`;
  const end = `<!-- ${OLD.toUpperCase()}_END -->`;
  for (const [name, file] of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const i = text.indexOf(start), j = text.indexOf(end);
    if (i < 0 || j < i) continue;
    const out = (text.slice(0, i) + text.slice(j + end.length)).replace(/\n{3,}/g, '\n\n');
    fs.writeFileSync(file, out.replace(/^\n+/, ''));
    rows.push(done(`${name} instructions`, `removed the old ${OLD} block`));
  }
}

/* The herdr plugin is registered by id, and the id changed. Unlink the old
   one — but a keybinding lives in the person's own config.toml and naming a
   plugin action that no longer exists just fails silently when they press it,
   so that one is reported, never edited. */
function herdr(rows) {
  let listed = '';
  try {
    listed = execFileSync('herdr', ['plugin', 'list'],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return; }
  if (!listed.includes(`${OLD}.board`)) return;
  try {
    execFileSync('herdr', ['plugin', 'unlink', `${OLD}.board`],
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    rows.push(done('herdr plugin', `unlinked ${OLD}.board`));
  } catch (e) {
    rows.push(todo('herdr plugin', `run: herdr plugin unlink ${OLD}.board`));
  }
  const cfg = path.join(HOME, '.config', 'herdr', 'config.toml');
  if (fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').includes(`${OLD}.board`)) {
    rows.push(todo('herdr keybinding',
      `your config.toml binds "${OLD}.board.focus" — change it to "${NEW}.board.focus"`));
  }
}

/* The old command, left on PATH by `npm link` under the old package name. */
function binary(rows) {
  let which = null;
  try {
    which = execFileSync('sh', ['-c', `command -v ${OLD}`],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { /* not there, which is the good case */ }
  if (which) rows.push(todo('old command', `${which} still exists — \`npm unlink -g ${OLD}\``));
}

export function migrate() {
  const rows = [];
  stateDir(rows);
  skills(rows);
  registrations(rows);
  blocks(rows);
  herdr(rows);
  binary(rows);
  if (!rows.length) rows.push(skip('everything', `no trace of ${OLD} on this machine`));
  return rows;
}

/* Whether there is anything to do, cheaply enough to check on every run. */
export function needed() {
  if (fs.existsSync(OLD_DIR)) return true;
  for (const d of ['.claude/skills', '.codex/skills', '.gemini/skills']) {
    if (isLink(path.join(HOME, d, OLD))) return true;
  }
  return false;
}
