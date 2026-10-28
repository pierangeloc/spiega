/* ============================================================
   handwave install — put it where your agents will find it.

   Every target here is idempotent and backs up any file it rewrites, because
   these are config files you did not write for us and may have spent a long
   time on. Nothing is ever merged destructively: JSON targets get one key
   added, and a file we do not understand is left alone with a message.
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertBlock } from './agents-block.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MCP_ENTRY = path.join(ROOT, 'src', 'mcp', 'server.js');
const HOME = os.homedir();

const backup = file => {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak-handwave-${new Date().toISOString().slice(0, 10)}`;
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
const linkSkill = (dir, name = 'handwave') => {
  const src = path.join(ROOT, 'skills', 'handwave');
  const dest = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  const already = fs.existsSync(dest) || isLink(dest);
  if (already) {
    if (isLink(dest) && fs.readlinkSync(dest) === src) return [dest, 'already linked'];
    backupDir(dest);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(src, dest, 'dir');
    return [dest, already ? 'relinked — it tracks the repo now' : 'linked — it tracks the repo'];
  } catch (e) {
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(src, 'SKILL.md'), path.join(dest, 'SKILL.md'));
    return [dest, `copied (symlink refused: ${e.code}) — re-run install after changes`];
  }
};

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const backupDir = d => {
  if (isLink(d) || !fs.existsSync(d)) return null;
  const b = `${d}.bak-handwave-${new Date().toISOString().slice(0, 10)}`;
  if (!fs.existsSync(b)) fs.cpSync(d, b, { recursive: true });
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
  const before = JSON.stringify(node.handwave);
  node.handwave = value;
  if (before === JSON.stringify(value)) return [file, 'already registered'];
  const b = backup(file);
  writeJSON(file, cfg);
  return [file, b ? `backed up to ${path.basename(b)}` : 'created'];
};

const STDIO = { type: 'stdio', command: 'node', args: [MCP_ENTRY] };

/* The instruction file a harness reads every turn. */
const agentsFile = file => {
  const r = upsertBlock(fs, file);
  if (!r.changed) return [file, 'already there'];
  const b = backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, r.text);
  return [file, b ? `${r.how}, backed up to ${path.basename(b)}` : r.how];
};

/* ---------- targets ---------- */

export const TARGETS = {
  claude: {
    what: 'Claude Code — skill',
    detect: () => fs.existsSync(path.join(HOME, '.claude')),
    run: () => {
      const [where, note] = linkSkill(path.join(HOME, '.claude', 'skills'));
      return [where, `${note}; restart Claude Code to pick it up`];
    },
  },

  codex: {
    what: 'Codex — skill, MCP server and AGENTS.md',
    detect: () => fs.existsSync(path.join(HOME, '.codex')),
    run: () => {
      const [where] = linkSkill(path.join(HOME, '.codex', 'skills'));
      agentsFile(path.join(HOME, '.codex', 'AGENTS.md'));
      // Codex keeps its MCP servers in TOML; add the table only if absent,
      // since rewriting someone's TOML by hand is how comments get eaten.
      const file = path.join(HOME, '.codex', 'config.toml');
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      let note = 'skill, AGENTS.md';
      if (!/^\s*\[mcp_servers\.handwave\]/m.test(raw)) {
        backup(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const block = `\n[mcp_servers.handwave]\ncommand = "node"\nargs = ["${MCP_ENTRY}"]\n`;
        fs.writeFileSync(file, raw.replace(/\n*$/, '\n') + block);
        note += ', MCP server';
      } else note += ', MCP already registered';
      return [where, note];
    },
  },

  gemini: {
    what: 'Gemini CLI — skill, MCP server and GEMINI.md',
    detect: () => fs.existsSync(path.join(HOME, '.gemini')),
    run: () => {
      const [where] = linkSkill(path.join(HOME, '.gemini', 'skills'));
      mcpJSON(path.join(HOME, '.gemini', 'settings.json'), 'mcpServers', STDIO);
      agentsFile(path.join(HOME, '.gemini', 'GEMINI.md'));
      return [where, 'skill, MCP server, GEMINI.md'];
    },
  },

  opencode: {
    what: 'opencode — MCP server and AGENTS.md',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'opencode')),
    run: () => {
      const file = path.join(HOME, '.config', 'opencode', 'opencode.json');
      const cfg = readJSON(file);
      cfg.mcp ||= {};
      const want = { type: 'local', command: ['node', MCP_ENTRY], enabled: true };
      let note;
      if (JSON.stringify(cfg.mcp.handwave) === JSON.stringify(want)) note = 'MCP already registered';
      else { const b = backup(file); cfg.mcp.handwave = want; writeJSON(file, cfg); note = b ? 'MCP registered, config backed up' : 'MCP registered'; }
      // opencode reads no skill file, so the judgement has to ride in AGENTS.md
      const [, how] = agentsFile(path.join(HOME, '.config', 'opencode', 'AGENTS.md'));
      return [file, `${note}; AGENTS.md ${how}`];
    },
  },

  copilot: {
    what: 'GitHub Copilot CLI — MCP server',
    detect: () => fs.existsSync(path.join(HOME, '.copilot')),
    run: () => mcpJSON(path.join(HOME, '.copilot', 'mcp-config.json'), 'mcpServers', { ...STDIO, tools: ['*'] }),
  },

  cursor: {
    what: 'Cursor — MCP server and a rule',
    detect: () => fs.existsSync(path.join(HOME, '.cursor')),
    run: () => {
      const dir = path.join(HOME, '.cursor', 'rules');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'handwave.mdc');
      fs.copyFileSync(path.join(ROOT, 'integrations/cursor/handwave.mdc'), out);
      return mcpJSON(path.join(HOME, '.cursor', 'mcp.json'), 'mcpServers', STDIO);
    },
  },

  windsurf: {
    what: 'Windsurf — MCP server',
    detect: () => fs.existsSync(path.join(HOME, '.codeium', 'windsurf')),
    run: () => mcpJSON(path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', STDIO),
  },

  zed: {
    what: 'Zed — context server',
    detect: () => fs.existsSync(path.join(HOME, '.config', 'zed')),
    run: () => mcpJSON(path.join(HOME, '.config', 'zed', 'settings.json'), 'context_servers',
      { source: 'custom', command: 'node', args: [MCP_ENTRY] }),
  },

  vscode: {
    what: 'VS Code — MCP server',
    detect: () => fs.existsSync(vscodeUserDir()),
    run: () => mcpJSON(path.join(vscodeUserDir(), 'mcp.json'), 'servers', STDIO),
  },

  claude_desktop: {
    what: 'Claude Desktop — MCP server',
    detect: () => fs.existsSync(claudeDesktopDir()),
    run: () => mcpJSON(path.join(claudeDesktopDir(), 'claude_desktop_config.json'), 'mcpServers',
      { command: 'node', args: [MCP_ENTRY] }),
  },

  /* Anything else. AGENTS.md is the one instruction file the whole field has
     converged on, so a harness nobody has wired up yet still gets the
     guidance if it reads the repo it is working in. */
  project: {
    what: 'this repo — AGENTS.md, for any agent working here',
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

/* What is actually on this machine. `handwave install` with no arguments does
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
      const [where, note] = t.run();
      out.push({ name: n, ok: true, what: t.what, where, note });
    } catch (e) {
      out.push({ name: n, ok: false, what: t.what, note: e.message });
    }
  }
  return out;
}
