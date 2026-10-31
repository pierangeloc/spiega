// @ts-check
/* ============================================================
   spiega state — the board as a list of operations.

   The agent never sends a whole board. It sends one small op at a time, in the
   order it is talking, and the board grows. That keeps the agent's turn cheap
   (a node is four fields, not a re-serialised diagram) and it is what makes the
   board feel drawn rather than published.

   The ops are also what a board is made of on disk: one JSON line per op,
   appended to ~/.spiega/boards/<id>.jsonl. Restore is this same applyOps over
   the lines read back, so there is no second representation to keep in step.
   That half lives in ./log.js, because THIS FILE IS LOADED BY THE BROWSER —
   board.html imports it straight off disk — and a browser cannot resolve
   `node:fs`. Importing one here takes the whole page down with it.
   ============================================================ */

/** @typedef {import('../render/layout.js').Placed} Placed */

/**
 * A thing drawn on the board. Only `id` is always there; the rest are either
 * layout instructions or drawing hints, and an op that carries none of them is
 * still a valid node.
 *
 * @typedef {Object} Node
 * @property {string} id
 * @property {string} [label]
 * @property {string} [sub]
 * @property {string} [kind]
 * @property {string} [body]
 * @property {number} [col]
 * @property {number} [row]
 * @property {string} [place]
 * @property {number} [w]
 * @property {number} [h]
 * @property {string[]} [lines]
 * @property {number} [slots]
 * @property {number} [depth]
 * @property {number} [replicas]
 * @property {string[]} [members]
 * @property {string} [tint]
 */

/**
 * @typedef {Object} Edge
 * @property {string} from
 * @property {string} to
 * @property {string} [label]
 * @property {number} [step]
 * @property {boolean} [async]
 * @property {string} [style]
 * @property {string} [bend]
 */

/**
 * @typedef {Object} Boundary
 * @property {string} id
 * @property {string} [label]
 * @property {string[]} [members]
 * @property {string} [tint]
 */

/**
 * @typedef {Object} Callout
 * @property {string} id
 * @property {string} [at]
 * @property {string} [label]
 * @property {string} [side]
 * @property {number} [wrap]
 */

/**
 * @typedef {Object} FlowStep
 * @property {string} [edge]
 * @property {string[]} [lights]
 * @property {string} [label]
 * @property {number|null} [_n]
 * @property {number} [_i]
 */

/**
 * A line of the script. `step` counts from 0 here; the op vocabulary counts
 * from 1, because that is the number shown on the board.
 *
 * @typedef {Object} TranscriptLine
 * @property {string} text
 * @property {number} at
 * @property {number} [step]
 * @property {string} [edge]
 */

/**
 * The log is the ops themselves, plus the moment they arrived. Kept loose on
 * purpose: anything an op carries has to survive a replay back to the board.
 *
 * @typedef {Record<string, unknown> & {
 *   op: string,
 *   at?: number,
 *   step?: number|string|null|boolean,
 *   edge?: string
 * }} LogEntry
 */

/**
 * @typedef {Object} Board
 * @property {string} title
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {Boundary[]} boundaries
 * @property {FlowStep[]} flow
 * @property {Callout[]} callouts
 * @property {TranscriptLine[]} transcript
 * @property {number|null} active
 * @property {Placed} placed
 * @property {LogEntry[]} log
 * @property {number} rev
 */

/* The wire format: one object per line in the log and one POST body per op. */

/** @typedef {{op: 'clear', keepTitle?: boolean}} ClearOp */
/** @typedef {{op: 'title', text?: string}} TitleOp */
/** @typedef {{op: 'say', text?: string, step?: number|string|null, edge?: string}} SayOp */
/** @typedef {{op: 'tag', match?: string, line?: number|string, step?: number|string|null|false, edge?: string}} TagOp */
/** @typedef {{op: 'node'|'note'} & Partial<Node>} NodeOp */
/** @typedef {{op: 'edge'} & Partial<Edge>} EdgeOp */
/** @typedef {{op: 'callout'} & Partial<Callout>} CalloutOp */
/** @typedef {{op: 'boundary'} & Partial<Boundary>} BoundaryOp */
/** @typedef {{op: 'step'} & FlowStep} StepOp */
/** @typedef {{op: 'flow', steps?: FlowStep[]}} FlowOp */
/** @typedef {{op: 'focus', step?: number|string|null}} FocusOp */
/** @typedef {{op: 'remove', id: string}} RemoveOp */
/**
 * @typedef {ClearOp | TitleOp | SayOp | TagOp | NodeOp | EdgeOp | CalloutOp
 *   | BoundaryOp | StepOp | FlowOp | FocusOp | RemoveOp} Op
 */

/** @typedef {{nodes: string[], edges: string[], boundaries: string[]}} Fresh */
/** @typedef {{ok: true, fresh: Fresh} | {ok: false, error: string, fresh: Fresh}} ApplyResult */
/** @typedef {{fresh: Fresh, errors: string[], applied: Op[]}} ApplyOpsResult */

/** @returns {Board} */
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

/**
 * @typedef {Object} Indexes
 * @property {Map<string, number>} nodes
 * @property {Map<string, number>} edges
 * @property {Map<string, number>} boundaries
 * @property {Map<string, number>} callouts
 */

/** @type {WeakMap<Board, Indexes>} */
const INDEXES = new WeakMap();

/** @param {Board} board @returns {Indexes} */
const indexesFor = board => {
  let ix = INDEXES.get(board);
  if (ix) return ix;
  ix = /** @type {Indexes} */ ({
    nodes: new Map(),
    edges: new Map(),
    boundaries: new Map(),
    callouts: new Map(),
  });
  /**
   * @template T
   * @param {Map<string, number>} map
   * @param {T[]} list
   * @param {(x: T) => string} key
   */
  const fill = (map, list, key) => list.forEach((x, i) => map.set(key(x), i));
  fill(ix.nodes, board.nodes || [], x => x.id);
  fill(ix.edges, board.edges || [], edgeId);
  fill(ix.boundaries, board.boundaries || [], x => x.id);
  fill(ix.callouts, board.callouts || [], x => x.id);
  INDEXES.set(board, ix);
  return ix;
};

/* Throw the index away rather than rebuild it here.

   A sweep removes entries from the middle of every list, so every index above
   a removed slot is wrong. Rebuilding on the spot is O(n), which would put the
   cost back on the remove; dropping it is O(1), and the next op that actually
   needs an index pays for one rebuild. A run of removes now costs one rebuild
   in total instead of one per op, and only if something is drawn afterwards. */
/** @param {Board} board */
const dropIndexes = board => { INDEXES.delete(board); };

/* Removes are collected and swept, not applied one at a time.

   Filtering four lists per remove made a run of n removes O(n²): every remove
   walked every list whether or not it touched anything. The ids of a run are
   collected instead, and the lists are swept once when the run ends.

   A run ends as soon as an op that can see those lists arrives. Anything else
   — a line said, a step lit, a title — commutes with removal and can stay
   behind it. That is what keeps the interleaving exact: a node drawn after
   its own removal is a new node, not a survivor of the sweep, and a callout
   added after the removal is not swept away with the thing it points at. */
/** @typedef {{ids: (string|undefined)[]}} Sweep */
/** @returns {Sweep} */
const newSweep = () => ({ ids: [] });

/** @param {Board} board @param {Sweep} sweep */
const sweepRemoved = (board, sweep) => {
  const ids = sweep.ids;
  if (!ids.length) return;
  if (ids.length === 1) {
    /* One remove per POST is the common shape, and a Set lookup per entry is
       three hash lookups per edge where a comparison used to do. Four lists of
       a few thousand entries is enough for that to show, so a single id keeps
       the direct comparisons. */
    const id = ids[0];
    board.nodes = board.nodes.filter(n => n.id !== id);
    board.edges = board.edges.filter(e => e.from !== id && e.to !== id && edgeId(e) !== id);
    board.boundaries = board.boundaries.filter(b => b.id !== id);
    // a callout pointing at something that is gone has nothing to say
    board.callouts = board.callouts.filter(c => c.id !== id && c.at !== id
      && !String(c.at || '').split('>').includes(/** @type {string} */ (id)));
  } else {
    const gone = new Set(ids);
    board.nodes = board.nodes.filter(n => !gone.has(n.id));
    board.edges = board.edges.filter(e => !gone.has(e.from) && !gone.has(e.to) && !gone.has(edgeId(e)));
    board.boundaries = board.boundaries.filter(b => !gone.has(b.id));
    board.callouts = board.callouts.filter(c => !gone.has(c.id) && !gone.has(c.at)
      && !String(c.at || '').split('>').some(seg => gone.has(seg)));
  }
  dropIndexes(board);
  ids.length = 0;
};

/* The ops that read or write the four lists a sweep touches. `clear` is not
   here because it replaces the lists wholesale — it resets the sweep instead
   of paying for a sweep nobody will see. */
const TOUCHES_LISTS = new Set(['node', 'note', 'edge', 'callout', 'boundary']);

/**
 * @template T
 * @param {T[]} list
 * @param {T} item
 * @param {(x: T) => string} keyOf
 * @param {Map<string, number>|null} [index]
 * @returns {boolean}
 */
const upsert = (list, item, keyOf, index = null) => {
  const id = keyOf(item);
  const known = index ? index.get(id) : undefined;
  const i = known != null && list[known] && keyOf(list[known]) === id
    ? known
    : list.findIndex(x => keyOf(x) === id);
  if (i >= 0) { list[i] = { ...list[i], ...item }; if (index) index.set(id, i); return false; }
  if (index) index.set(id, list.length);
  list.push(item); return true;
};

/** @param {Edge} e @returns {string} */
const edgeId = e => `${e.from}>${e.to}`;

/* Applying an op returns the keys of whatever is new, so the client knows what
   to animate on and what was already on the board. It also returns the ops it
   accepted, which is exactly what the log writer buffers. */
/**
 * @param {Board} board
 * @param {Op} op
 * @param {Sweep} sweep
 * @returns {ApplyResult}
 */
function applyOne(board, op, sweep) {
  /** @type {Fresh} */
  const fresh = { nodes: [], edges: [], boundaries: [] };
  // recorded before the switch, so a `clear` wipes the log with everything else
  const record = () => {
    board.log.push({ ...op, at: Date.now() });
    if (board.log.length > LOG_CAP) board.log.splice(0, board.log.length - LOG_CAP);
  };
  switch (op.op) {
    case 'clear': {
      const t = op.keepTitle ? board.title : '';
      Object.assign(board, emptyBoard(), { title: t });
      dropIndexes(board);
      sweep.ids.length = 0;
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
      /** @type {TranscriptLine} */
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
      const { op: _op, ...fields } = op;
      const id = fields.id || (fields.label || 'n').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      /** @type {Node} */
      const n = { ...fields, id, kind: op.op === 'note' ? 'note' : (fields.kind || 'service') };
      if (upsert(board.nodes, n, x => x.id, indexesFor(board).nodes)) fresh.nodes.push(n.id);
      break;
    }

    case 'edge': {
      const { op: _op, ...fields } = op;
      if (!fields.from || !fields.to) break;
      /** @type {Edge} */
      const e = { ...fields, from: fields.from, to: fields.to };
      if (upsert(board.edges, e, edgeId, indexesFor(board).edges)) fresh.edges.push(edgeId(e));
      break;
    }

    /* A label joined to a point by a leader line — "this edge, here, is the
       retried one". Every other label on the board is attached to the thing it
       names, which leaves no way to say something *about* a thing without
       crowding it. */
    case 'callout': {
      const { op: _op, ...fields } = op;
      const id = fields.id || `callout-${(fields.at || '').replace(/[^a-z0-9]+/gi, '-')}-${board.callouts.length}`;
      /** @type {Callout} */
      const c = { ...fields, id };
      if (upsert(board.callouts, c, x => x.id, indexesFor(board).callouts)) fresh.boundaries.push(c.id);
      break;
    }

    case 'boundary': {
      const { op: _op, ...fields } = op;
      const id = fields.id || (fields.label || 'b').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      /** @type {Boundary} */
      const b = { ...fields, id };
      if (upsert(board.boundaries, b, x => x.id, indexesFor(board).boundaries)) fresh.boundaries.push(b.id);
      break;
    }

    case 'step': {
      const { op: _op, ...step } = op;
      board.flow.push(step);
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
      // Collected, not filtered: see sweepRemoved. The placement goes now, so
      // a node re-drawn later in the same run still starts unplaced.
      sweep.ids.push(op.id);
      delete board.placed[op.id];
      break;
    }

    default: {
      // The union covers every op above; this is the branch a line of JSON takes
      // when it names something the vocabulary does not know.
      const unknown = /** @type {{op?: unknown}} */ (op);
      return { ok: false, error: `unknown op "${String(unknown.op)}"`, fresh };
    }
  }
  if (op.op !== 'clear') record();
  board.rev++;
  return { ok: true, fresh };
}

/**
 * @param {Board} board
 * @param {Op} op
 * @returns {ApplyResult}
 */
export function applyOp(board, op) {
  const sweep = newSweep();
  const result = applyOne(board, op, sweep);
  sweepRemoved(board, sweep);
  return result;
}

/**
 * @param {Board} board
 * @param {Op|Op[]} ops
 * @returns {ApplyOpsResult}
 */
export function applyOps(board, ops) {
  /** @type {Fresh} */
  const all = { nodes: [], edges: [], boundaries: [] };
  /** @type {string[]} */
  const errors = [];
  /** @type {Op[]} */
  const applied = [];
  const list = Array.isArray(ops) ? ops : [ops];
  const sweep = newSweep();
  for (const op of list) {
    // End the run of removes before anything that can see the lists, so the
    // op is applied to the board as if each remove had landed on its own.
    if (sweep.ids.length && TOUCHES_LISTS.has(op.op)) sweepRemoved(board, sweep);
    const r = applyOne(board, op, sweep);
    if (!r.ok) errors.push(r.error);
    else applied.push(op);
    for (const k of /** @type {(keyof Fresh)[]} */ (Object.keys(all))) all[k].push(...r.fresh[k]);
  }
  sweepRemoved(board, sweep);
  return { fresh: all, errors, applied };
}

/* The smallest op set that rebuilds the current board.

   Compaction costs the interleaving between what was said and what was drawn:
   a compacted board replays as a flat rebuild rather than as the session. That
   is acceptable only past LOG_CAP, where the in-memory log has already dropped
   its head; below it, never compact. */
/** @param {Board} board @returns {Op[]} */
export function boardOps(board) {
  /** @type {Op[]} */
  const ops = [{ op: 'title', text: board.title || '' }];
  for (const n of board.nodes) ops.push({ op: 'node', ...n });
  for (const b of board.boundaries) ops.push({ op: 'boundary', ...b });
  for (const e of board.edges) ops.push({ op: 'edge', ...e });
  for (const c of board.callouts) ops.push({ op: 'callout', ...c });
  if (board.flow.length) ops.push({ op: 'flow', steps: board.flow.slice() });
  for (const line of board.transcript) {
    /** @type {SayOp} */
    const s = { op: 'say', text: line.text };
    if (line.step != null) s.step = line.step + 1;
    if (line.edge) s.edge = line.edge;
    ops.push(s);
  }
  if (board.active != null) ops.push({ op: 'focus', step: board.active });
  return ops;
}


export { edgeId };
