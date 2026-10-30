/* ============================================================
   spiega state — the board as a list of operations.

   The agent never sends a whole board. It sends one small op at a time, in the
   order it is talking, and the board grows. That keeps the agent's turn cheap
   (a node is four fields, not a re-serialised diagram) and it is what makes the
   board feel drawn rather than published.

   The ops are also what a board is made of on disk: one JSON line per op,
   appended to ~/.spiega/boards/<id>.jsonl. Restore is this same applyOps over
   the lines read back, so there is no second representation to keep in step.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

export const emptyBoard = () => ({
  title: '',
  nodes: [],
  edges: [],
  boundaries: [],
  flow: [],
  callouts: [],
  transcript: [],
  active: null,
  placed: {},        // sticky column/row assignments — see render/layout.js
  // Every op, in the order it arrived. A board is a session, not a diagram, so
  // the order the explanation went in is part of what it holds — without this
  // the board can only ever show its final state, and the thinking that got
  // there is lost the moment it is drawn.
  log: [],
  rev: 0,
});

export const LOG_CAP = 4000;

/* An id -> index map per board and per upserted list.

   `upsert` used to scan the list for every op, which made restore O(n²) in the
   number of boxes: 4000 logged ops spent ~108 ms finding things it already
   knew. A board can hold any object, so the map lives beside it in a WeakMap
   rather than on it — the board is serialised to the browser and to snapshots,
   and an index has no business travelling with it. */
const INDEXES = new WeakMap();

const indexesFor = board => {
  let ix = INDEXES.get(board);
  if (ix) return ix;
  ix = {
    nodes: new Map(),
    edges: new Map(),
    boundaries: new Map(),
    callouts: new Map(),
  };
  const fill = (map, list, key) => list.forEach((x, i) => map.set(key(x), i));
  fill(ix.nodes, board.nodes || [], x => x.id);
  fill(ix.edges, board.edges || [], edgeId);
  fill(ix.boundaries, board.boundaries || [], x => x.id);
  fill(ix.callouts, board.callouts || [], x => x.id);
  INDEXES.set(board, ix);
  return ix;
};

const rebuildIndexes = board => {
  const ix = indexesFor(board);
  for (const k of Object.keys(ix)) ix[k].clear();
  const fill = (map, list, key) => list.forEach((x, i) => map.set(key(x), i));
  fill(ix.nodes, board.nodes || [], x => x.id);
  fill(ix.edges, board.edges || [], edgeId);
  fill(ix.boundaries, board.boundaries || [], x => x.id);
  fill(ix.callouts, board.callouts || [], x => x.id);
};

const upsert = (list, item, keyOf = x => x.id, index = null) => {
  const id = keyOf(item);
  const known = index ? index.get(id) : undefined;
  const i = known != null && list[known] && keyOf(list[known]) === id
    ? known
    : list.findIndex(x => keyOf(x) === id);
  if (i >= 0) { list[i] = { ...list[i], ...item }; if (index) index.set(id, i); return false; }
  if (index) index.set(id, list.length);
  list.push(item); return true;
};

const edgeId = e => `${e.from}>${e.to}`;

/* Applying an op returns the keys of whatever is new, so the client knows what
   to animate on and what was already on the board. It also returns the ops it
   accepted, which is exactly what the log writer buffers. */
export function applyOp(board, op) {
  const fresh = { nodes: [], edges: [], boundaries: [] };
  const ix = indexesFor(board);
  // recorded before the switch, so a `clear` wipes the log with everything else
  const record = () => {
    board.log.push({ ...op, at: Date.now() });
    if (board.log.length > LOG_CAP) board.log.splice(0, board.log.length - LOG_CAP);
  };
  switch (op.op) {
    case 'clear': {
      const t = op.keepTitle ? board.title : '';
      Object.assign(board, emptyBoard(), { title: t });
      rebuildIndexes(board);
      break;
    }
    case 'title':
      board.title = op.text || '';
      break;

    /* A line may name the step it explains, so the rail can light the part of
       the script the current step is about — `step` is the number as it shows
       on the board (1-based), `edge` survives steps being reordered. Neither
       is required: see board/script.js for what happens without them. */
    case 'say': {
      const line = { text: String(op.text || ''), at: Date.now() };
      if (op.step != null && Number.isFinite(Number(op.step))) line.step = Math.max(0, Number(op.step) - 1);
      if (op.edge) line.edge = String(op.edge);
      board.transcript.push(line);
      break;
    }

    /* Tie a line already on the board to a step — or untie it. Lines are said
       as the explanation goes, and which step they turn out to be about is
       often only clear afterwards; without this the only way to fix a tag is
       to run the whole explanation again, which is exactly what the board
       exists to avoid. `line` counts from 1, as the rail shows them; `match`
       finds the line by its words, which is what an agent actually has. */
    case 'tag': {
      const t = board.transcript;
      let i = -1;
      if (op.match != null) {
        const needle = String(op.match).toLowerCase();
        i = t.findIndex(e => e.text.toLowerCase().includes(needle));
        if (i < 0) return { ok: false, error: `tag: no line matching "${op.match}"`, fresh };
      } else {
        i = Number(op.line) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= t.length) {
          return { ok: false, error: `tag: there is no line ${op.line} (the board has ${t.length})`, fresh };
        }
      }
      const line = t[i];
      // `step: null` or `off` clears, so a wrong tag can be taken back
      const off = op.step === null || op.step === 'off' || op.step === false;
      delete line.step; delete line.edge;
      if (!off && op.step != null && Number.isFinite(Number(op.step))) line.step = Math.max(0, Number(op.step) - 1);
      if (!off && op.edge) line.edge = String(op.edge);
      break;
    }

    case 'note':
    case 'node': {
      const n = { ...op };
      delete n.op;
      n.kind = op.op === 'note' ? 'note' : (n.kind || 'service');
      n.id = n.id || (n.label || 'n').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (upsert(board.nodes, n, x => x.id, ix.nodes)) fresh.nodes.push(n.id);
      break;
    }

    case 'edge': {
      const e = { ...op }; delete e.op;
      if (!e.from || !e.to) break;
      if (upsert(board.edges, e, edgeId, ix.edges)) fresh.edges.push(edgeId(e));
      break;
    }

    /* A label joined to a point by a leader line — "this edge, here, is the
       retried one". Every other label on the board is attached to the thing it
       names, which leaves no way to say something *about* a thing without
       crowding it. */
    case 'callout': {
      const c = { ...op }; delete c.op;
      c.id = c.id || `callout-${(c.at || '').replace(/[^a-z0-9]+/gi, '-')}-${board.callouts.length}`;
      if (upsert(board.callouts, c, x => x.id, ix.callouts)) fresh.boundaries.push(c.id);
      break;
    }

    case 'boundary': {
      const b = { ...op }; delete b.op;
      b.id = b.id || (b.label || 'b').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (upsert(board.boundaries, b, x => x.id, ix.boundaries)) fresh.boundaries.push(b.id);
      break;
    }

    case 'step': {
      const s = { ...op }; delete s.op;
      board.flow.push(s);
      break;
    }

    case 'flow':
      board.flow = Array.isArray(op.steps) ? op.steps.slice() : [];
      break;

    case 'focus':
      board.active = op.step == null ? null
        : Math.max(0, Math.min(board.flow.length - 1, Number(op.step)));
      break;

    case 'remove': {
      const id = op.id;
      board.nodes = board.nodes.filter(n => n.id !== id);
      board.edges = board.edges.filter(e => e.from !== id && e.to !== id && edgeId(e) !== id);
      board.boundaries = board.boundaries.filter(b => b.id !== id);
      // a callout pointing at something that is gone has nothing to say
      board.callouts = board.callouts.filter(c => c.id !== id && c.at !== id
        && !String(c.at || '').split('>').includes(id));
      delete board.placed[id];
      rebuildIndexes(board);
      break;
    }

    default:
      return { ok: false, error: `unknown op "${op.op}"`, fresh };
  }
  if (op.op !== 'clear') record();
  board.rev++;
  return { ok: true, fresh };
}

export function applyOps(board, ops) {
  const all = { nodes: [], edges: [], boundaries: [] };
  const errors = [];
  const applied = [];
  for (const op of [].concat(ops)) {
    const r = applyOp(board, op);
    if (!r.ok) errors.push(r.error);
    else applied.push(op);
    for (const k of Object.keys(all)) all[k].push(...r.fresh[k]);
  }
  return { fresh: all, errors, applied };
}

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

/* The smallest op set that rebuilds the current board.

   Compaction costs the interleaving between what was said and what was drawn:
   a compacted board replays as a flat rebuild rather than as the session. That
   is acceptable only past LOG_CAP, where the in-memory log has already dropped
   its head; below it, never compact. */
export function boardOps(board) {
  const ops = [{ op: 'title', text: board.title || '' }];
  for (const n of board.nodes) ops.push({ op: 'node', ...n });
  for (const b of board.boundaries) ops.push({ op: 'boundary', ...b });
  for (const e of board.edges) ops.push({ op: 'edge', ...e });
  for (const c of board.callouts) ops.push({ op: 'callout', ...c });
  if (board.flow.length) ops.push({ op: 'flow', steps: board.flow.slice() });
  for (const line of board.transcript) {
    const s = { op: 'say', text: line.text };
    if (line.step != null) s.step = line.step + 1;
    if (line.edge) s.edge = line.edge;
    ops.push(s);
  }
  if (board.active != null) ops.push({ op: 'focus', step: board.active });
  return ops;
}

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

export { edgeId };
