/* ============================================================
   handwave state — the board as a list of operations.

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
  transcript: [],
  active: null,
  placed: {},        // sticky column/row assignments — see render/layout.js
  rev: 0,
});

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
  switch (op.op) {
    case 'clear': {
      const t = op.keepTitle ? board.title : '';
      Object.assign(board, emptyBoard(), { title: t });
      break;
    }
    case 'title':
      board.title = op.text || '';
      break;

    case 'say':
      board.transcript.push({ text: String(op.text || ''), at: Date.now() });
      break;

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
      delete board.placed[id];
      break;
    }

    default:
      return { ok: false, error: `unknown op "${op.op}"`, fresh };
  }
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
