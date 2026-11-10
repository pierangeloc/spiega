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

import { KINDS } from '../render/glyphs.js';
import { scriptSteps } from './script.js';

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
 * @property {'left'|'right'} [notch]
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
 * @property {import('../render/layout.js').Placement[]} [via]
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
 * A step may name the phase of the explanation it belongs to. The step names
 * its group and never the other way round: the log is append-only and step
 * indices renumber the moment one is inserted, while a key does not.
 *
 * @typedef {Object} FlowStep
 * @property {string} [edge]
 * @property {string[]} [lights]
 * @property {string} [label]
 * @property {string} [group]
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
 * One drawing surface: everything a board held before chapters existed. A
 * finished chapter is exactly this, set aside whole, which is why the renderer
 * and the rail take one without knowing chapters are a thing.
 *
 * @typedef {Object} Chapter
 * @property {string} title
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {Boundary[]} boundaries
 * @property {FlowStep[]} flow
 * @property {Callout[]} callouts
 * @property {TranscriptLine[]} transcript
 * @property {Record<string, string>} groups
 * @property {number|null} active
 * @property {Placed} placed
 * @property {boolean} settled
 */

/**
 * The board is one explanation. Its current chapter lives directly on it —
 * `nodes`, `edges` and the rest, where they have always been — and the
 * chapters it has finished sit beside it in `chapters`, in the order they were
 * taught. One title names the explanation; `chapter` names the surface being
 * drawn on now.
 *
 * @typedef {Object} Board
 * @property {string} title
 * @property {string} chapter
 * @property {Chapter[]} chapters
 * @property {Node[]} nodes
 * @property {Edge[]} edges
 * @property {Boundary[]} boundaries
 * @property {FlowStep[]} flow
 * @property {Callout[]} callouts
 * @property {TranscriptLine[]} transcript
 * @property {Record<string, string>} groups
 * @property {number|null} active
 * @property {Placed} placed
 * @property {LogEntry[]} log
 * @property {number} rev
 * @property {boolean} settled
 */

/* The wire format: one object per line in the log and one POST body per op. */

/** @typedef {{op: 'clear', keepTitle?: boolean}} ClearOp */
/** @typedef {{op: 'chapter', title?: string}} ChapterOp */
/** @typedef {{op: 'amend', chapter: number|string, ops?: Op|Op[]}} AmendOp */
/** @typedef {{op: 'title', text?: string}} TitleOp */
/** @typedef {{op: 'say', text?: string, step?: number|string|null, edge?: string}} SayOp */
/** @typedef {{op: 'tag', match?: string, line?: number|string, step?: number|string|null|false, edge?: string}} TagOp */
/** @typedef {{op: 'node'|'note'} & Partial<Node>} NodeOp */
/** @typedef {{op: 'edge'} & Partial<Edge>} EdgeOp */
/** @typedef {{op: 'callout'} & Partial<Callout>} CalloutOp */
/** @typedef {{op: 'boundary'} & Partial<Boundary>} BoundaryOp */
/** @typedef {{op: 'step'} & FlowStep} StepOp */
/** @typedef {{op: 'group', id?: string, label?: string}} GroupOp */
/** @typedef {{op: 'flow', steps?: FlowStep[]}} FlowOp */
/** @typedef {{op: 'focus', step?: number|string|null}} FocusOp */
/** @typedef {{op: 'remove', id: string}} RemoveOp */
/** @typedef {{op: 'settle', positions: Placed, routes?: Record<string, import('../render/layout.js').Placement[]>}} SettleOp */
/**
 * @typedef {ClearOp | ChapterOp | AmendOp | TitleOp | SayOp | TagOp | NodeOp
 *   | EdgeOp | CalloutOp | BoundaryOp | StepOp | GroupOp | FlowOp | FocusOp
 *   | RemoveOp | SettleOp} Op
 */

/** @typedef {{nodes: string[], edges: string[], boundaries: string[]}} Fresh */
/** @typedef {{ok: true, fresh: Fresh, op: Op} | {ok: false, error: string, fresh: Fresh}} ApplyResult */
/** @typedef {{fresh: Fresh, errors: string[], warnings: string[], applied: Op[]}} ApplyOpsResult */

/* The fields a chapter owns. A chapter break puts these aside and starts them
   again; everything else on the board — its title, its log, its revision — is
   the explanation's and outlives any one chapter. */
/** @returns {Omit<Chapter, 'title'>} */
export const emptySurface = () => ({
  nodes: [],
  edges: [],
  boundaries: [],
  flow: [],
  callouts: [],
  transcript: [],
  groups: {},
  active: null,
  placed: {},
  settled: false,
});

/** @returns {Board} */
export const emptyBoard = () => ({
  title: '',
  chapter: '',
  chapters: [],
  nodes: [],
  edges: [],
  boundaries: [],
  flow: [],
  callouts: [],
  transcript: [],
  // group id -> the name to show for it. A phase of the explanation is named
  // by its own op, which may land before or after the steps that join it, so
  // the names live beside the flow rather than inside it.
  groups: {},
  active: null,
  placed: {},        // sticky column/row assignments — see render/layout.js
  // Every op, in the order it arrived. A board is a session, not a diagram, so
  // the order the explanation went in is part of what it holds — without this
  // the board can only ever show its final state, and the thinking that got
  // there is lost the moment it is drawn.
  log: [],
  rev: 0,
  settled: false,
});

export const LOG_CAP = 4000;

/* Nothing drawn and nothing said. A `chapter` op here is naming the surface
   rather than ending it.

   The names of phases are not counted. An agent that declares its groups and
   then names its first chapter means to use them in that chapter, and
   counting them would file a chapter with nothing in it but a dictionary —
   and take the names away from the steps that were about to use them. */
/** @param {Board} b */
const blankSurface = b => !b.nodes.length && !b.edges.length && !b.boundaries.length &&
  !b.callouts.length && !b.flow.length && !b.transcript.length;

/* A chapter as it is set aside, with its script already attributed.

   Which line belongs to which step is partly worked out by walking the log and
   counting `say` ops positionally (board/script.js). That walk can only line
   up with the transcript of the chapter being drawn now — the log holds every
   chapter's lines, the transcript holds one chapter's — so a finished chapter
   has to carry its own answer, resolved here while the walk still applies to
   it. The arrays themselves are handed over rather than copied: the live
   fields are replaced wholesale a line later, so nothing is shared. */
/** @param {Board} board @returns {Chapter} */
function closeChapter(board) {
  const at = scriptSteps(board);
  return {
    title: board.chapter,
    nodes: board.nodes,
    edges: board.edges,
    boundaries: board.boundaries,
    flow: board.flow,
    callouts: board.callouts,
    transcript: board.transcript.map((line, i) =>
      (line.step != null || at[i] == null ? line : { ...line, step: at[i] })),
    groups: board.groups,
    active: board.active,
    placed: board.placed,
    settled: board.settled,
  };
}

/* Put a surface on the board and take back whatever was there. Called twice,
   it is a swap: the second call returns the surface the first lent out, with
   whatever has been drawn on it in between. */
/** @param {Board} board @param {Chapter} to @returns {Chapter} */
function swapSurface(board, to) {
  const was = {
    title: board.chapter,
    nodes: board.nodes, edges: board.edges, boundaries: board.boundaries,
    flow: board.flow, callouts: board.callouts, transcript: board.transcript,
    groups: board.groups,
    active: board.active, placed: board.placed, settled: board.settled,
  };
  board.chapter = to.title;
  board.nodes = to.nodes; board.edges = to.edges; board.boundaries = to.boundaries;
  board.flow = to.flow; board.callouts = to.callouts; board.transcript = to.transcript;
  board.groups = to.groups || {};
  board.active = to.active; board.placed = to.placed; board.settled = to.settled;
  return was;
}

/* Every chapter in the order it was taught, the live one last. Numbered from
   one, as the strip numbers them, because that is the number a person reads
   off the board and says out loud. */
/** @param {Board} board @returns {{title: string, live?: boolean}[]} */
const everyChapter = board =>
  [...board.chapters.map(c => ({ title: c.title })), { title: board.chapter, live: true }];

/* Which chapter an amendment is aimed at: the number on the strip, or the
   name on the tab. Returns an index into `everyChapter`, or a sentence saying
   why not — an agent that has the number wrong is told what the numbers are,
   because it cannot look at the board to find out. */
/** @param {Board} board @param {number|string} want @returns {number|string} */
function chapterWanted(board, want) {
  const all = everyChapter(board);
  const list = all.map((c, i) => `${i + 1} ${c.title || 'untitled'}${c.live ? ' (being drawn)' : ''}`).join(', ');
  if (typeof want === 'number' || /^\d+$/.test(String(want))) {
    const i = Number(want) - 1;
    if (i >= 0 && i < all.length) return i;
    return `there is no chapter ${want}. The chapters are: ${list}.`;
  }
  const name = String(want).trim().toLowerCase();
  const hits = all
    .map((c, i) => ({ name: (c.title || '').trim().toLowerCase(), i }))
    .filter(c => c.name === name);
  if (hits.length === 1) return hits[0].i;
  if (!hits.length) return `no chapter is called "${want}". The chapters are: ${list}.`;
  return `"${want}" names ${hits.length} chapters, so say which by number. The chapters are: ${list}.`;
}

/* What an amendment may not carry. Each of these is about the explanation as a
   whole, not about one chapter, and inside an amendment each would do
   something nobody could mean: `clear` would wipe the board from within an
   edit to one chapter of it. */
const NOT_AMENDABLE = new Set(['amend', 'chapter', 'clear', 'title']);

/* Draw into a chapter that is no longer the one being drawn on.

   The surface is lent to the board for the length of the amendment: its lists
   are swapped in, the ops run through exactly the same `applyOps` as anything
   else, and the surface takes its lists back. That is the whole reason this is
   small — `node`, `edge`, `remove`, `say`, `step` and `settle` all work on a
   chapter because none of them can tell the difference.

   The log is lent a scratch array meanwhile: the amendment is one entry in the
   board's log, carrying the ops it applied, rather than a handful of ops that
   would replay into the wrong chapter. */
/** @param {Board} board @param {number} i @param {Op[]} ops @returns {ApplyOpsResult} */
function amendChapter(board, i, ops) {
  const live = swapSurface(board, board.chapters[i]);
  const log = board.log;
  board.log = [];
  dropIndexes(board);
  try {
    return applyOps(board, ops);
  } finally {
    // the second swap hands the amended chapter back and takes the live one
    board.chapters[i] = swapSurface(board, live);
    board.log = log;
    dropIndexes(board);
  }
}

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
const TOUCHES_LISTS = new Set(['node', 'note', 'edge', 'callout', 'boundary', 'settle']);

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

/* The array-valued fields a model writes by hand.

   `"members": "[\"a\",\"b\"]"` is not a fuzz case. The op body is JSON inside a
   tool argument, so an agent hand-writing an op has every reason to encode the
   list twice, and there is no parser on the far side to undo it. Nothing
   downstream recovers either: the renderer calls `.map` on whatever it is
   given, and a throw there happens inside a request handler, which takes the
   process — and every other board in it — down. So the door refuses it, the
   way an unknown op is refused. `flow.steps` already survives a non-array; a
   string where the elements are read is the inconsistency this closes. */
/** @param {unknown} value */
const stringIds = value => Array.isArray(value) && value.every(v => typeof v === 'string');

/* The group a step says it belongs to, tidied in place.

   Unlike `lights`, a group that arrives as something other than a string is
   not worth refusing the step over: the step still draws, still lights and
   still reads, it simply joins no phase. So the group is dropped and the
   agent is told, the way a kind with no glyph is — a header missing from the
   rail is a smaller loss than a hop missing from the flow. */
/** @param {FlowStep} step @param {string[]} warnings */
const phase = (step, warnings) => {
  const id = typeof step.group === 'string' ? step.group.trim() : '';
  if (!id) {
    if (step.group !== '' && typeof step.group !== 'string') {
      warnings.push(`step: "group" must be the id of a group, got ${typeof step.group}; drawn without one.`);
    }
    delete step.group;
    return;
  }
  step.group = id;
};

/** @param {unknown} value */
const waypoints = value => Array.isArray(value) && value.every(p => p && Number.isFinite(p.col) && Number.isFinite(p.row));

/* An op is an object with a string `op` naming the operation. Anything else is
   refused rather than read: `[null]` in an ops array — the other thing a client
   can post by hand — used to throw on `op.op` inside the request handler, which
   is the same dead process as a boundary whose members is a string. Rejecting
   it where it arrives is what lets `applyOps` keep its promise never to throw
   on input.

   Returns the reason, or null when the value is an op. */
/** @param {unknown} op @returns {string|null} */
const notAnOp = op => {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    const what = op === null ? 'null' : Array.isArray(op) ? 'an array' : typeof op;
    return `not an op: expected an object with a string "op", got ${what}`;
  }
  const name = /** @type {{op?: unknown}} */ (op).op;
  return typeof name === 'string' ? null
    : `not an op: "op" must be a string naming the operation, got ${name === undefined ? 'nothing' : typeof name}`;
};

/* Applying an op returns the keys of whatever is new, so the client knows what
   to animate on and what was already on the board. It also returns the ops it
   accepted, which is exactly what the log writer buffers. */
/**
 * @param {Board} board
 * @param {Op} op
 * @param {Sweep} sweep
 * @param {string[]} [warnings] where applyOne says what it drew but could not draw right
 * @returns {ApplyResult}
 */
function applyOne(board, op, sweep, warnings = []) {
  /** @type {Fresh} */
  const fresh = { nodes: [], edges: [], boundaries: [] };
  // `applyOp` reaches here directly, so the check cannot live only in applyOps
  const bad = notAnOp(op);
  if (bad) return { ok: false, error: bad, fresh };
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
    /* A chapter break. The surface being drawn on is set aside whole and a new
       one started, so the explanation keeps everything it has taught so far
       instead of `clear` destroying it on screen — which is the only chapter
       break there used to be, and is why four chapters of one explanation
       ended up as four orphan files in ~/Downloads (#51).

       Naming an empty surface rather than setting it aside: `chapter` at the
       start of an explanation is how the first chapter gets its name, and
       pushing a blank one there would put an empty tab in front of everything
       that follows. */
    case 'chapter': {
      const title = String(op.title || '');
      if (!blankSurface(board)) {
        board.chapters.push(closeChapter(board));
        Object.assign(board, emptySurface());
        dropIndexes(board);
        sweep.ids.length = 0;
      }
      board.chapter = title;
      break;
    }

    /* Something to add to a chapter already taught, or a correction to it.

       Aimed rather than entered: an agent that could *move* to chapter one
       would have to remember to come back, and the turn it forgot would put
       the rest of the explanation in the wrong chapter with nothing to say so.
       An op that names its chapter cannot be left switched on.

       It lands where it is aimed and nowhere else: what is being drawn now is
       untouched, and so is whoever is reading it. */
    case 'amend': {
      const inner = /** @type {Op[]} */ (op.ops == null ? [] : [].concat(/** @type {never} */ (op.ops)));
      const refused = inner.find(o => o && NOT_AMENDABLE.has(o.op));
      if (refused) {
        return { ok: false, fresh, error:
          `amend: "${refused.op}" is about the whole explanation, not about one chapter of it, ` +
          `so it cannot go inside an amendment.` };
      }
      const where = chapterWanted(board, op.chapter);
      if (typeof where === 'string') return { ok: false, fresh, error: `amend: ${where}` };
      /* The live chapter is not an amendment at all: the ops are simply drawn,
         and they log and replay as the drawing they are. */
      if (where === board.chapters.length) {
        const r = applyOps(board, inner);
        warnings.push(...r.warnings);
        if (r.errors.length) return { ok: false, fresh: r.fresh, error: r.errors.join('; ') };
        return { ok: true, fresh: r.fresh, op: { op: 'amend', chapter: where + 1, ops: r.applied } };
      }
      const r = amendChapter(board, where, inner);
      warnings.push(...r.warnings);
      if (r.errors.length) return { ok: false, fresh: r.fresh, error: r.errors.join('; ') };
      // logged as one entry, carrying what actually landed
      board.log.push({ op: 'amend', chapter: where + 1, ops: r.applied, at: Date.now() });
      if (board.log.length > LOG_CAP) board.log.splice(0, board.log.length - LOG_CAP);
      board.rev++;
      return { ok: true, fresh: r.fresh, op: { op: 'amend', chapter: where + 1, ops: r.applied } };
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
      // `lines` is text, not ids, but the same two callers read it as a list
      if (fields.lines !== undefined && !stringIds(fields.lines)) {
        return { ok: false, error: `${op.op}: "lines" must be an array of strings`, fresh };
      }
      const id = fields.id || (fields.label || 'n').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      /* A kind nobody has a glyph for falls back to a service box, so the board
         says something confidently wrong rather than nothing — a datastore the
         agent asked for, drawn as a plain box, and no way for it to find out.
         The op still lands: a wrong outline mid-sentence beats a missing box,
         and the agent can redraw the node once it has been told. */
      if (op.op === 'node' && fields.kind && !KINDS.includes(fields.kind)) {
        warnings.push(`node "${id}": no glyph for kind "${fields.kind}", drawn as a service. Kinds: ${KINDS.join(', ')}.`);
      }
      /** @type {Node} */
      const n = { ...fields, id, kind: op.op === 'note' ? 'note' : (fields.kind || 'service') };
      if (upsert(board.nodes, n, x => x.id, indexesFor(board).nodes)) fresh.nodes.push(n.id);
      // Keep frozen slots current without pinning feedback nodes, or mutating
      // the coordinates held by an earlier settle op in the log.
      if (board.placed[id]) {
        board.placed[id] = {
          col: fields.col ?? board.placed[id].col,
          row: fields.row ?? board.placed[id].row,
        };
      }
      break;
    }

    case 'edge': {
      const { op: _op, ...fields } = op;
      if (!fields.from || !fields.to) break;
      if (fields.via !== undefined && !waypoints(fields.via)) {
        return { ok: false, error: 'edge: via must be an array of finite col and row pairs', fresh };
      }
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
      if (fields.members !== undefined && !stringIds(fields.members)) {
        return { ok: false, error: 'boundary: "members" must be an array of string ids', fresh };
      }
      const id = fields.id || (fields.label || 'b').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      /** @type {Boundary} */
      const b = { ...fields, id };
      if (upsert(board.boundaries, b, x => x.id, indexesFor(board).boundaries)) fresh.boundaries.push(b.id);
      break;
    }

    case 'step': {
      const { op: _op, ...step } = op;
      /* A string here would not throw — `new Set('ab')` is the two characters —
         it would light nothing and say nothing, which is the harder failure to
         notice. Refused for the same reason as members. */
      if (step.lights !== undefined && !stringIds(step.lights)) {
        return { ok: false, error: 'step: "lights" must be an array of string ids', fresh };
      }
      if (step.group !== undefined) phase(step, warnings);
      board.flow.push(step);
      break;
    }

    /* The display name of a phase of the explanation.

       Only a name: a group never lists its steps, each step names its group,
       so this op may arrive before the steps that join it or long after them
       and neither order is special. A step naming a group nobody declared is
       not an error either — it groups under that id and is shown as the id,
       because the alternative is an op refused in the middle of somebody
       talking over nothing worse than a missing label. */
    case 'group': {
      const id = String(op.id || '').trim();
      if (!id) return { ok: false, error: 'group: "id" must name the group', fresh };
      board.groups[id] = op.label == null ? id : String(op.label);
      break;
    }

    case 'flow': {
      const steps = Array.isArray(op.steps) ? op.steps : [];
      // a whole flow arrives through this op, so it carries the same field
      const bad = steps.findIndex(s => s && s.lights !== undefined && !stringIds(s.lights));
      if (bad >= 0) {
        return { ok: false, error: `flow: steps[${bad}].lights must be an array of string ids`, fresh };
      }
      board.flow = steps.map(s => {
        const step = { ...s };
        if (step.group !== undefined) phase(step, warnings);
        return step;
      });
      break;
    }

    case 'focus':
      board.active = op.step == null ? null
        : Math.max(0, Math.min(board.flow.length - 1, Number(op.step)));
      break;

    case 'settle': {
      const positions = op.positions;
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)
        || Object.values(positions).some(p => !p || !Number.isFinite(p.col) || !Number.isFinite(p.row))) {
        return { ok: false, error: 'settle: positions must be an object of finite col and row pairs', fresh };
      }
      if (op.routes !== undefined && (!op.routes || typeof op.routes !== 'object' || Array.isArray(op.routes)
        || Object.values(op.routes).some(v => !waypoints(v)))) {
        return { ok: false, error: 'settle: routes must be an object of waypoint arrays', fresh };
      }
      // The log carries the answer, not just a request to run today's dagre.
      // Restores and browser replay therefore show exactly the same handover.
      // Compaction copies only the frozen subset. Feedback drawn since then
      // stays unpinned instead of gaining a new layout just because we saved.
      const frozen = Object.fromEntries(board.nodes.filter(n => positions[n.id]).map(n => [n.id, {
        col: positions[n.id].col, row: positions[n.id].row,
      }]));
      /** @type {NonNullable<SettleOp['routes']>} */
      const routes = {};
      for (const e of board.edges) {
        const via = op.routes?.[edgeId(e)];
        if (via?.length) {
          routes[edgeId(e)] = via.map(p => ({ col: p.col, row: p.row }));
          e.via = routes[edgeId(e)].map(p => ({ ...p }));
        } else delete e.via;
      }
      op = { op: 'settle', positions: frozen, ...(op.routes ? { routes } : {}) };
      for (const n of board.nodes) {
        if (!frozen[n.id]) continue;
        n.col = frozen[n.id].col;
        n.row = frozen[n.id].row;
      }
      board.placed = { ...frozen };
      board.settled = true;
      break;
    }

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
  return { ok: true, fresh, op };
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
  /** @type {string[]} */
  const warnings = [];
  /** @type {Op[]} */
  const applied = [];
  const list = Array.isArray(ops) ? ops : [ops];
  const sweep = newSweep();
  for (const op of list) {
    /* Checked here as well as in applyOne because the sweep below reads `op.op`
       before it gets there, and a value that is not an op cannot see the lists
       — it must not end the run early and flush a sweep nobody asked for. */
    const bad = notAnOp(op);
    if (bad) { errors.push(bad); continue; }
    // End the run of removes before anything that can see the lists, so the
    // op is applied to the board as if each remove had landed on its own.
    if (sweep.ids.length && TOUCHES_LISTS.has(op.op)) sweepRemoved(board, sweep);
    const r = applyOne(board, op, sweep, warnings);
    if (!r.ok) errors.push(r.error);
    else applied.push(r.op);
    for (const k of /** @type {(keyof Fresh)[]} */ (Object.keys(all))) all[k].push(...r.fresh[k]);
  }
  sweepRemoved(board, sweep);
  return { fresh: all, errors, warnings, applied };
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
  /* Each chapter rebuilt in the order it was taught, each opened by the op
     that starts it. The first `chapter` lands on an empty surface and so only
     names it, which is exactly what it did the first time round. */
  for (const c of board.chapters) {
    ops.push({ op: 'chapter', title: c.title || '' });
    ops.push(...surfaceOps(c));
  }
  if (board.chapters.length || board.chapter) ops.push({ op: 'chapter', title: board.chapter || '' });
  /* The chapter being drawn on has not had its script attributed yet — a
     finished one froze it on the way out (closeChapter), and this one is still
     relying on the log walk that compaction is about to throw away. Resolve it
     here or every line that was attributed by having been said while a step
     was lit comes back tied to nothing, and the rail stops highlighting on a
     board long enough to have been compacted at all. */
  ops.push(...surfaceOps(board, scriptSteps(board)));
  return ops;
}

/* One surface as the ops that rebuild it. `at` is the resolved step of each
   line, for a surface whose attribution is not yet on its lines. */
/** @param {Chapter|Board} s @param {(number|null)[]} [at] @returns {Op[]} */
function surfaceOps(s, at = []) {
  /** @type {Op[]} */
  const ops = [];
  for (const n of s.nodes) ops.push({ op: 'node', ...n });
  for (const b of s.boundaries) ops.push({ op: 'boundary', ...b });
  for (const e of s.edges) ops.push({ op: 'edge', ...e });
  for (const c of s.callouts) ops.push({ op: 'callout', ...c });
  /* Before the flow, though a group op is happy either side of its steps:
     rebuilt ops read as the board being drawn again, and a phase is named
     before the steps that belong to it. */
  for (const [id, label] of Object.entries(s.groups || {})) ops.push({ op: 'group', id, label });
  if (s.flow.length) ops.push({ op: 'flow', steps: s.flow.slice() });
  for (const [i, line] of s.transcript.entries()) {
    /** @type {SayOp} */
    const say = { op: 'say', text: line.text };
    const step = line.step ?? at[i];
    if (step != null) say.step = step + 1;
    if (line.edge) say.edge = line.edge;
    ops.push(say);
  }
  if (s.settled) ops.push({ op: 'settle', positions: { ...s.placed },
    routes: Object.fromEntries(s.edges.filter(e => e.via?.length).map(e => [edgeId(e), (e.via || []).map(p => ({ ...p }))])),
  });
  if (s.active != null) ops.push({ op: 'focus', step: s.active });
  return ops;
}


export { edgeId };
