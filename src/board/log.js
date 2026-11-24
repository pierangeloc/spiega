/* ============================================================
   The board's op log on disk.

   Split from state.js rather than living in it because state.js is imported by
   the browser — it is bundled into the board page — and `node:fs` does not
   resolve there. Keeping the two apart is what lets the board page and
   the CLI go on sharing one definition of what an op means.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { emptyBoard, applyOps, LOG_CAP } from './state.js';

/* ---------- the log on disk ----------

   One JSON op per line, appended. Reading is forgiving on purpose: a crash can
   leave half a line, and a half line is one lost op, not a lost board. */

export const boardLogFile = (dir, name) =>
  path.join(dir, `${String(name).replace(/[^a-z0-9._-]+/gi, '-')}.jsonl`);

export const readBoardLog = file => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ops: [], tail: true }; }
  const ops = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const op = JSON.parse(s);
      if (op && typeof op === 'object' && !Array.isArray(op)) ops.push(op);
    } catch { /* a corrupt line is skipped, not fatal */ }
  }
  return { ops, tail: text === '' || text.endsWith('\n') };
};

/* Restore reads the log back through the Schema (packages/core/src/schema/log.ts),
   which is what upgrades the shapes older versions wrote and refuses the ones
   nothing here can read. The Schema is effect, and effect is ~70 ms that the MCP
   server — which imports this module for `resolveBoard` and never restores —
   must not pay at start-up. Restore is synchronous because a board is held the
   moment it is asked for, so it is loaded on first use, by `require`, which
   reads an ES module synchronously. */
let logSchema = null;
const schema = () => (logSchema ??= createRequire(import.meta.url)('../../packages/core/src/schema/log.js'));

export const boardOfLog = file => path.basename(file).replace(/\.jsonl$/, '');

export const restoreBoard = file => {
  const { ops: raw, tail } = readBoardLog(file);
  const { ops, refused } = schema().decodeLog(boardOfLog(file), raw);
  const board = emptyBoard();
  applyOps(board, ops);
  /* `lines` counts what is on the board, not what is in the file: it is what
     compaction weighs against LOG_CAP. `refused` is the difference, and the
     caller says it out loud — a board short of a few of its own lines looks
     exactly like one that was always this short. */
  return { board, lines: ops.length, tail, refused };
};

/* One process owns one board file. The lock is a file next to it holding the
   pid; a pid that is gone makes the lock stale and reclaimable. A second
   server holds its board in memory but does not append, because two writers
   interleaving lines would corrupt both sessions. */
const ownerAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
};

const acquireLock = lockFile => {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try { pid = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch { /* unreadable: stale */ }
      if (pid === process.pid) {
        // The same process, holding the same board twice: the first writer is
        // the owner. Do not steal its lock.
        return false;
      }
      if (ownerAlive(pid)) return false;
      try { fs.unlinkSync(lockFile); } catch { /* someone else cleared it */ }
    }
  }
  return false;
};

const releaseLock = lockFile => {
  try {
    if (Number(fs.readFileSync(lockFile, 'utf8').trim()) !== process.pid) return;
    fs.unlinkSync(lockFile);
  } catch { /* not ours, or already gone */ }
};

/* The file half of the append-only log: the lock, the append, the compaction.

   Nothing here buffers or keeps time. What to write, and when, belongs to the
   queue and the flush fiber in packages/server/src/oplog.ts, because the route
   that feeds it is on the critical path of somebody talking and must be able to
   hand ops over without ever touching this. Every method returns a promise, or
   nothing, and none is called from a request. No fsync, no rewriting: a hard
   crash may lose the last tick of ops, which is the trade this is allowed to
   make. */
export function openLogFile(file, { lines = 0, tail = true, snapshot = null } = {}) {
  const lockFile = file + '.lock';
  const owned = acquireLock(lockFile);
  let lineCount = lines;
  let needsNewline = !tail;
  let released = false;

  return {
    get file() { return file; },
    get owner() { return owned; },
    get lines() { return lineCount; },
    async append(ops) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const data = ops.map(op => JSON.stringify(op)).join('\n') + '\n';
      await fs.promises.appendFile(file, (needsNewline ? '\n' : '') + data, 'utf8');
      needsNewline = false;
      lineCount += ops.length;
    },
    async compact() {
      if (!snapshot) return;
      const ops = snapshot();
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, ops.map(op => JSON.stringify(op)).join('\n') + '\n', 'utf8');
      await fs.promises.rename(tmp, file);
      lineCount = ops.length;
      needsNewline = false;
    },
    release() {
      if (released) return;
      released = true;
      if (owned) releaseLock(lockFile);
    },
  };
}
