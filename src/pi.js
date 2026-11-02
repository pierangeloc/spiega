/* ============================================================
   Where pi keeps what spiega writes, shared by install and doctor so the
   two cannot drift apart — the way doctor and install already duplicate
   every other harness's paths by hand.
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Honoured rather than assumed, for the same reason as XDG_CONFIG_HOME in
   install.js: a second pi profile is a second agent directory, and an install
   that wrote to the default would register spiega where that profile never
   looks. */
export const piDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

/* pi reads one instruction file from its directory, the first of these that
   exists. A block written into AGENTS.md beside an AGENTS.override.md would be
   installed, reported, and never read. */
const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

export function piInstructionsFile() {
  const dir = piDir();
  /* readdirSync, not existsSync: on a case-insensitive filesystem AGENTS.MD
     "exists" whenever AGENTS.md does, and the name written back has to be the
     one actually on disk. */
  let present = [];
  try { present = fs.readdirSync(dir); } catch { /* no directory yet */ }
  const found = INSTRUCTION_FILES.find(f => present.includes(f)) || 'AGENTS.md';
  return path.join(dir, found);
}

/* `direct`, because pi's default exposure is `codemode`: the tools would be
   reachable only from a script and never declared to the model, so an agent
   about to explain something would not see that a board exists. Ten tools is
   the small, frequently used set `direct` is meant for.

   The description is what pi lists in the system prompt before the server has
   connected, so it carries the same trigger the skill does. */
export const piMcpEntry = (entry) => ({
  type: 'stdio',
  command: 'node',
  args: [entry],
  exposure: 'direct',
  description: 'A live hand-drawn board to draw on while explaining architecture: services, '
    + 'queues, datastores and a numbered request flow, beside the words.',
});
