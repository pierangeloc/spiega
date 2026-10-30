/* ============================================================
   The board's op log on disk.

   Split from state.js rather than living in it because state.js is imported by
   the browser — board.html loads it off disk as an ES module — and `node:fs`
   does not resolve there. Keeping the two apart is what lets the board page and
   the CLI go on sharing one definition of what an op means.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

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

export const restoreBoard = file => {
  const { ops, tail } = readBoardLog(file);
  const board = emptyBoard();
  applyOps(board, ops);
  return { board, lines: ops.length, tail };
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

/* A buffered append-only log.

   `push` is the request path and does nothing but put op objects in an array.
   The first push arms a short timer; the timer stringifies and appends the
   batch in one write. No fsync, no rewriting: a hard crash may lose the last
   tick of ops, which is the trade this is allowed to make. */
export function createLog(file, { lines = 0, tail = true, debounce = 100, snapshot = null } = {}) {
  const lockFile = file + '.lock';
  let owned = acquireLock(lockFile);
  let pending = [];
  let timer = null;
  let chain = Promise.resolve();
  let closed = false;
  let lineCount = lines;
  let needsNewline = !tail;

  const arm = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounce);
    timer.unref?.();
  };

  const append = async data => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, (needsNewline ? '\n' : '') + data, 'utf8');
    needsNewline = false;
  };

  const compact = async () => {
    if (!snapshot) return;
    const ops = snapshot();
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, ops.map(op => JSON.stringify(op)).join('\n') + '\n', 'utf8');
    await fs.promises.rename(tmp, file);
    lineCount = ops.length;
    needsNewline = false;
  };

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!owned) return chain;
    const batch = pending;
    pending = [];
    if (!batch.length) return chain;
    chain = chain.then(async () => {
      try {
        await append(batch.map(op => JSON.stringify(op)).join('\n') + '\n');
      } catch (e) {
        // The board keeps working; losing the write is better than taking the
        // server down mid-sentence. Put the ops back so the next flush retries.
        pending = batch.concat(pending);
        arm();
        if (!flush.warned) { flush.warned = true; console.error(`spiega: could not write ${file}: ${e.message}`); }
        return;
      }
      lineCount += batch.length;
      // Compact only when the file has passed the cap and nothing is waiting:
      // a snapshot taken while ops are still buffered would write them twice.
      if (lineCount > LOG_CAP && pending.length === 0) {
        try { await compact(); }
        catch (e) {
          if (!flush.warned) { flush.warned = true; console.error(`spiega: could not compact ${file}: ${e.message}`); }
        }
      }
    });
    return chain;
  };

  return {
    get file() { return file; },
    get owner() { return owned; },
    get lines() { return lineCount; },
    push(ops) {
      if (closed || !owned) return;
      for (const op of [].concat(ops)) pending.push(op);
      arm();
    },
    flush,
    compact,
    async close() {
      if (closed) return chain;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await flush();
      if (owned) releaseLock(lockFile);
      return chain;
    },
  };
}
