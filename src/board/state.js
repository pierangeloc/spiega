/* ============================================================
   spiega state — the board as a list of operations.

   The agent never sends a whole board. It sends one small op at a time, in the
   order it is talking, and the board grows. That keeps the agent's turn cheap
   (a node is four fields, not a re-serialised diagram) and it is what makes the
   board feel drawn rather than published.
   ============================================================ */

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

const LOG_CAP = 4000;

const upsert = (list, item, key = 'id') => {
  const i = list.findIndex(x => x[key] === item[key]);
  if (i >= 0) { list[i] = { ...list[i], ...item }; return false; }
  list.push(item); return true;
};

const edgeId = e => `${e.from}>${e.to}`;

/* Applying an op returns the keys of whatever is new, so the client knows what
   to animate on and what was already on the board. */
export function applyOp(board, op) {
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
      if (upsert(board.nodes, n)) fresh.nodes.push(n.id);
      break;
    }

    case 'edge': {
      const e = { ...op }; delete e.op;
      if (!e.from || !e.to) break;
      const i = board.edges.findIndex(x => edgeId(x) === edgeId(e));
      if (i >= 0) board.edges[i] = { ...board.edges[i], ...e };
      else { board.edges.push(e); fresh.edges.push(edgeId(e)); }
      break;
    }

    /* A label joined to a point by a leader line — "this edge, here, is the
       retried one". Every other label on the board is attached to the thing it
       names, which leaves no way to say something *about* a thing without
       crowding it. */
    case 'callout': {
      const c = { ...op }; delete c.op;
      c.id = c.id || `callout-${(c.at || '').replace(/[^a-z0-9]+/gi, '-')}-${board.callouts.length}`;
      if (upsert(board.callouts, c)) fresh.boundaries.push(c.id);
      break;
    }

    case 'boundary': {
      const b = { ...op }; delete b.op;
      b.id = b.id || (b.label || 'b').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (upsert(board.boundaries, b)) fresh.boundaries.push(b.id);
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
  for (const op of [].concat(ops)) {
    const r = applyOp(board, op);
    if (!r.ok) errors.push(r.error);
    for (const k of Object.keys(all)) all[k].push(...r.fresh[k]);
  }
  return { fresh: all, errors };
}

export { edgeId };
