/* ============================================================
   spiega install — put it where your agents will find it.

   Every target here is idempotent and backs up any file it rewrites, because
   these are config files you did not write for us and may have spent a long
   time on. Nothing is ever merged destructively: JSON targets get one key
   added, and a file we do not understand is left alone with a message.
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { upsertBlock } from './agents-block.js';
import { upsertTable } from './toml.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
const HOME = os.homedir();

const backup = file => {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-spiega-${new Date().toISOString().slice(0, 10)}`;
  if (!fs.existsSync(b)) fs.copyFileSync(file, b);
  return b;
};

const readJSON = file => {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);   // throws on a file we should not touch; caller reports it
};

const writeJSON = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
};

/* A skill is linked, not copied. A copy goes stale the moment the source
   changes, which is exactly what bit us: an agent kept reading a SKILL.md from
   hours earlier and knew nothing about features that had shipped. terminal-browser
   already symlinks its skill into ~/.codex/skills and ~/.gemini/skills on this
   machine; same idea. If the filesystem refuses a link, fall back to a copy and
   say so, because a stale skill beats no skill. */
const linkSkill = (dir, name = 'spiega') => {
  const src = path.join(ROOT, 'skills', 'spiega');
  const dest = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const already = fs.existsSync(dest) || isLink(dest);
  if (already) {
    if (isLink(dest) && fs.readlinkSync(dest) === src) return [dest, 'already linked', 'unchanged'];
    backupDir(dest);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(src, dest, 'dir');
    return [dest, already ? 'relinked — it tracks the repo now' : 'linked — it tracks the repo', 'written'];
  } catch (e) {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'));
    return [dest, `copied (symlink refused: ${e.code}) — re-run install after changes`, 'written'];
  }
};

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
/* Never beside the thing being replaced. A skills directory is scanned by the
   harness, so `spiega.bak-…` sitting next to `spiega` is not a backup — it
   is a second skill, loaded every session, with the same description and
   older contents. Backups go somewhere nothing reads. */
const backupDir = d => {
  if (isLink(d) || !fs.existsSync(d)) return null;
  const b = path.join(HOME, '.spiega', 'backups',
    `${path.basename(d)}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(b), { recursive: true });
  fs.cpSync(d, b, { recursive: true });
  return b;
};

/* One MCP registration, written into whatever shape a harness expects. The
   three shapes below are not guesses: each was read off a working codegraph
   entry in that harness's own config on a real machine. */
const mcpJSON = (file, key, value) => {
  const cfg = readJSON(file);
  const parts = key.split('.');
  let node = cfg;
  for (const k of parts) node = (node[k] ||= {});
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
const STDIO = () => ({ type: 'stdio', command: 'node', args: [MCP_ENTRY] });

/* A target that does three things changed if any one of them did. Saying
   "installed" when nothing moved trains people to ignore the output. */
const combine = parts => (parts.some(p => p[2] === 'written') ? 'written' : 'unchanged');

/* The instruction file a harness reads every turn. */
const agentsFile = file => {
  const r = upsertBlock(fs, file);
  if (!r.changed) return [file, 'already there', 'unchanged'];
  const b = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  return [file, b ? `${r.how}, backed up to ${path.basename(b)}` : r.how, 'written'];
};

/* ---------- targets ---------- */

export const TARGETS = {
  claude: {
    what: 'Claude Code — skill',
    app: 'Claude Code',
    gets: 'skill',
    detect: () => fs.existsSync(path.join(HOME, '.claude')),
    run: () => {
      const [where, note] = linkSkill(path.join(HOME, '.claude', 'skills'));
      return [where, `${note}; restart Claude Code to pick it up`];
    },
  },

  codex: {
    what: 'Codex — skill, MCP server and AGENTS.md',
    app: 'Codex',
    gets: 'skill, MCP, AGENTS.md',
    detect: () => fs.existsSync(path.join(HOME, '.codex')),
    run: () => {
      const skill = linkSkill(path.join(HOME, '.codex', 'skills'));
      const block = agentsFile(path.join(HOME, '.codex', 'AGENTS.md'));
      const where = skill[0];
      // Codex keeps its MCP servers in TOML; add the table only if absent,
      // since rewriting someone's TOML by hand is how comments get eaten.
      const file = path.join(HOME, '.codex', 'config.toml');
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
    detect: () => fs.existsSync(path.join(HOME, '.gemini')),
    run: () => {
      const parts = [
        linkSkill(path.join(HOME, '.gemini', 'skills')),
        mcpJSON(path.join(HOME, '.gemini', 'settings.json'), 'mcpServers', STDIO()),
        agentsFile(path.join(HOME, '.gemini', 'GEMINI.md')),
      ];
      return [parts[0][0], 'skill, MCP server, GEMINI.md', combine(parts)];
    },
  },

  opencode: {
    what: 'opencode — MCP server and AGENTS.md',
    app: 'opencode',
    gets: 'MCP, AGENTS.md',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'opencode')),
    run: () => {
      const file = path.join(HOME, '.config', 'opencode', 'opencode.json');
      const cfg = readJSON(file);
      cfg.mcp ||= {};
      const want = { type: 'local', command: ['node', MCP_ENTRY], enabled: true };
      let note, wrote = false;
      if (JSON.stringify(cfg.mcp.spiega) === JSON.stringify(want)) note = 'MCP already registered';
      else { const b = backup(file); cfg.mcp.spiega = want; writeJSON(file, cfg); note = b ? 'MCP registered, config backed up' : 'MCP registered'; wrote = true; }
      // opencode reads no skill file, so the judgement has to ride in AGENTS.md
      const block = agentsFile(path.join(HOME, '.config', 'opencode', 'AGENTS.md'));
      return [file, `${note}; AGENTS.md ${block[1]}`,
        combine([block, [null, null, wrote ? 'written' : 'unchanged']])];
    },
  },

  copilot: {
    what: 'GitHub Copilot CLI — MCP server',
    app: 'Copilot CLI',
    gets: 'MCP',
    detect: () => fs.existsSync(path.join(HOME, '.copilot')),
    run: () => mcpJSON(path.join(HOME, '.copilot', 'mcp-config.json'), 'mcpServers', { ...STDIO(), tools: ['*'] }),
  },

  cursor: {
    what: 'Cursor — MCP server and a rule',
    app: 'Cursor',
    gets: 'MCP, rule',
    detect: () => fs.existsSync(path.join(HOME, '.cursor')),
    run: () => {
      const dir = path.join(HOME, '.cursor', 'rules');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'spiega.mdc');
      const before = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
      const src = fs.readFileSync(path.join(ROOT, 'integrations/cursor/spiega.mdc'), 'utf8');
      if (before !== src) fs.writeFileSync(out, src);
      const mcp = mcpJSON(path.join(HOME, '.cursor', 'mcp.json'), 'mcpServers', STDIO());
      return [mcp[0], mcp[1], combine([mcp, [null, null, before === src ? 'unchanged' : 'written']])];
    },
  },

  windsurf: {
    what: 'Windsurf — MCP server',
    app: 'Windsurf',
    gets: 'MCP',
    detect: () => fs.existsSync(path.join(HOME, '.codeium', 'windsurf')),
    run: () => mcpJSON(path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', STDIO()),
  },

  zed: {
    what: 'Zed — context server',
    app: 'Zed',
    gets: 'context server',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'zed')),
    run: () => mcpJSON(path.join(HOME, '.config', 'zed', 'settings.json'), 'context_servers',
      { source: 'custom', command: 'node', args: [MCP_ENTRY] }),
  },

  vscode: {
    what: 'VS Code — MCP server',
    app: 'VS Code',
    gets: 'MCP',
    detect: () => fs.existsSync(vscodeUserDir()),
    run: () => mcpJSON(path.join(vscodeUserDir(), 'mcp.json'), 'servers', STDIO()),
  },

  claude_desktop: {
    what: 'Claude Desktop — MCP server',
    app: 'Claude Desktop',
    gets: 'MCP',
    detect: () => fs.existsSync(claudeDesktopDir()),
    run: () => mcpJSON(path.join(claudeDesktopDir(), 'claude_desktop_config.json'), 'mcpServers',
      { command: 'node', args: [MCP_ENTRY] }),
  },

  /* herdr runs the panes these sessions live in, and it has a plugin system,
     so the board can be reached from the pane without knowing its name. */
  herdr: {
    what: 'herdr — a plugin: reach this task\'s board from its pane',
    app: 'herdr',
    gets: 'plugin',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'herdr')),
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
        throw new Error(`herdr plugin link failed (${String(e.stderr || e.message).split('\n')[0]})`);
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
};

function vscodeUserDir() {
  return process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || HOME, 'Code', 'User')
      : path.join(HOME, '.config', 'Code', 'User');
}

function claudeDesktopDir() {
  return process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Claude')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || HOME, 'Claude')
      : path.join(HOME, '.config', 'Claude');
}

/* What is actually on this machine. `spiega install` with no arguments does
   only these, because writing a config for a harness someone does not use is
   how you end up with a file they never asked for. `project` is excluded: it
   writes into the working directory and should always be asked for by name. */
export function detect() {
  return Object.entries(TARGETS)
    .filter(([n, t]) => n !== 'project' && t.detect())
    .map(([n]) => n);
}

export const TARGET_NAMES = Object.keys(TARGETS);

export function install(names) {
  const want = names?.length ? names : detect();
  const out = [];
  for (const n of want) {
    const t = TARGETS[n];
    if (!t) { out.push({ name: n, ok: false, note: 'no such target' }); continue; }
    try {
      const [where, note, declared] = t.run();
      // "already there" and "written" look different in a list and should
      // read differently; the targets say so in their note, so classify once
      // here rather than making every caller parse English
      // the target says so when it knows; the wording is only a fallback
      const state = declared || (/\balready\b/i.test(note || '') ? 'unchanged' : 'written');
      out.push({ name: n, ok: true, what: t.what, app: t.app, gets: t.gets, where, note, state });
    } catch (e) {
      out.push({ name: n, ok: false, what: t.what, app: t.app, gets: t.gets, note: e.message, state: 'failed' });
    }
  }
  return out;
}
