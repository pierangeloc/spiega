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

/* ---------- targets ---------- */

const TARGETS = {
  claude: {
    what: 'Claude Code — global skill',
    run() {
      const dir = path.join(HOME, '.claude', 'skills', 'handwave');
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'integrations/claude-skill/SKILL.md'), path.join(dir, 'SKILL.md'));
      return [`${dir}/SKILL.md`, 'restart Claude Code to pick it up'];
    },
  },

  cursor: {
    what: 'Cursor — global rule',
    run() {
      const dir = path.join(HOME, '.cursor', 'rules');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, 'handwave.mdc');
      fs.copyFileSync(path.join(ROOT, 'integrations/cursor/handwave.mdc'), out);
      return [out, null];
    },
  },

  opencode: {
    what: 'opencode — MCP server',
    run() {
      const file = path.join(HOME, '.config', 'opencode', 'opencode.json');
      const cfg = readJSON(file);
      cfg.mcp ||= {};
      const before = JSON.stringify(cfg.mcp.handwave);
      cfg.mcp.handwave = { type: 'local', command: ['node', MCP_ENTRY], enabled: true };
      if (before === JSON.stringify(cfg.mcp.handwave)) return [file, 'already registered'];
      const b = backup(file);
      writeJSON(file, cfg);
      return [file, b ? `backed up to ${path.basename(b)}` : 'created'];
    },
  },

  vscode: {
    what: 'VS Code / Copilot — MCP server',
    run() {
      const file = process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : path.join(HOME, '.config', 'Code', 'User', 'mcp.json');
      const cfg = readJSON(file);
      cfg.servers ||= {};
      const before = JSON.stringify(cfg.servers.handwave);
      cfg.servers.handwave = { type: 'stdio', command: 'node', args: [MCP_ENTRY] };
      if (before === JSON.stringify(cfg.servers.handwave)) return [file, 'already registered'];
      const b = backup(file);
      writeJSON(file, cfg);
      return [file, b ? `backed up to ${path.basename(b)}` : 'created'];
    },
  },

  claude_desktop: {
    what: 'Claude Desktop — MCP server',
    run() {
      const file = process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
      const cfg = readJSON(file);
      cfg.mcpServers ||= {};
      const before = JSON.stringify(cfg.mcpServers.handwave);
      cfg.mcpServers.handwave = { command: 'node', args: [MCP_ENTRY] };
      if (before === JSON.stringify(cfg.mcpServers.handwave)) return [file, 'already registered'];
      const b = backup(file);
      writeJSON(file, cfg);
      return [file, b ? `backed up to ${path.basename(b)}` : 'created'];
    },
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export function install(names) {
  const want = names?.length ? names : TARGET_NAMES;
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
