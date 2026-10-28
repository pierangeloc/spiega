/* ============================================================
   handwave layout — where things land on the board.

   The constraint that shapes all of this: the board is drawn while someone is
   talking. A node that appears must not shove the four already on the board
   somewhere else, or the viewer loses the thread. So assignment is *order
   stable*: nodes are resolved in the order they were added, and each takes the
   next free row in its column, which means a newcomer lands in the gap rather
   than displacing anyone.

   It is recomputed from scratch on every render rather than frozen, so drawing
   an edge into a node that was floating does relayer that node — which is the
   behaviour you want, since the edge is new information about where it belongs.

   Columns come from the flow: a node sits one column right of whatever points
   at it. That is a topological layering, which for architecture is also the
   way people read — client on the left, storage on the right.
   ============================================================ */

const COL_GAP = 132;
const ROW_GAP = 54;
const PAD = 64;

import { wrapText } from './ink.js';

const SIZES = {
  service:   (n, tw) => ({ w: Math.max(156, tw + 52), h: 70 }),
  gateway:   (n, tw) => ({ w: Math.max(166, tw + 72), h: 70 }),
  compute:   (n, tw) => ({ w: Math.max(156, tw + 52), h: 78 }),
  cache:     (n, tw) => ({ w: Math.max(150, tw + 52), h: 70 }),
  datastore: (n, tw) => ({ w: Math.max(146, tw + 48), h: 96 }),
  queue:     (n, tw) => ({ w: Math.max(176, tw + 60), h: 48, labelBelow: 34 }),
  client:    (n, tw) => ({ w: Math.max(146, tw + 48), h: 92 }),
  external:  (n, tw) => ({ w: Math.max(182, tw + 96), h: 96 }),
  note: n => {
    const lines = n.lines || wrapText(n.label, 24);
    const widest = Math.max(1, ...lines.map(l => l.length));
    return { w: Math.max(132, widest * 7.9 + 30), h: 30 + 15 * lines.length };
  },
};

const textWidth = (s, size = 13.5) => String(s || '').length * size * 0.66;

export function sizeOf(n) {
  const fn = SIZES[n.kind] || SIZES.service;
  const tw = Math.max(textWidth(n.label), textWidth(n.sub, 10));
  const s = fn(n, tw);
  return { w: n.w || s.w, h: n.h || s.h, labelBelow: s.labelBelow || 0 };
}

/* Assign a column and row to every node that does not have one yet.

   `placed` is MUTATED, and anything already in it is returned untouched. So
   passing the same map across renders freezes the layout: a node drawn before
   the edge that explains where it belongs stays in column 0 for good, because
   the edge arrives after the node has been pinned. Callers that render a board
   repeatedly pass nothing and let this recompute — it is cheap, and resolving
   in insertion order is already stable. The parameter is for pinning a layout
   deliberately, which is not what rendering wants. */
export function assign(spec, placed = {}) {
  const byId = Object.fromEntries(spec.nodes.map(n => [n.id, n]));
  const incoming = {};
  for (const e of spec.edges || []) (incoming[e.to] ||= []).push(e.from);

  // Explicit placement wins, then "right of X" / "below X", then the flow.
  const resolve = (n, guard = new Set()) => {
    if (placed[n.id]) return placed[n.id];
    if (guard.has(n.id)) return (placed[n.id] = { col: 0, row: nextRow(0) });
    guard.add(n.id);

    if (n.col != null) return (placed[n.id] = { col: n.col, row: n.row != null ? n.row : nextRow(n.col) });

    // A note has no edges, so the flow has nothing to say about where it goes.
    // Left to the default it lands in column 0 among the real nodes; instead it
    // goes in a margin column of its own, to the left of everything.
    if (n.kind === 'note') return (placed[n.id] = { col: -1, row: nextRow(-1) });

    if (typeof n.place === 'string') {
      const [rel, ref] = n.place.split(':');
      const target = byId[ref] && resolve(byId[ref], guard);
      if (target) {
        const col = rel === 'right-of' ? target.col + 1 : rel === 'left-of' ? Math.max(0, target.col - 1) : target.col;
        const row = rel === 'below' ? target.row + 1 : rel === 'above' ? target.row - 1 : nextRow(col);
        return (placed[n.id] = { col, row });
      }
    }

    const srcs = (incoming[n.id] || []).map(id => byId[id]).filter(Boolean)
      .map(s => resolve(s, guard)).filter(Boolean);
    const col = srcs.length ? Math.max(...srcs.map(s => s.col)) + 1 : 0;
    return (placed[n.id] = { col, row: nextRow(col) });
  };

  const used = {};
  for (const p of Object.values(placed)) (used[p.col] ||= new Set()).add(p.row);
  function nextRow(col) {
    const set = (used[col] ||= new Set());
    let r = 0;
    while (set.has(r)) r++;
    set.add(r);
    return r;
  }
  // keep `used` honest for explicitly placed nodes too
  const claim = p => (used[p.col] ||= new Set()).add(p.row);

  for (const n of spec.nodes) claim(resolve(n));
  return placed;
}

/* Turn column/row assignments into pixel boxes. */
export function layout(spec, placed) {
  const cols = {};
  for (const n of spec.nodes) {
    const p = placed[n.id];
    if (!p) continue;
    const s = sizeOf(n);
    (cols[p.col] ||= []).push({ n, p, s });
  }

  const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const colW = {}, colH = {};
  for (const c of colKeys) {
    colW[c] = Math.max(...cols[c].map(e => e.s.w));
    cols[c].sort((a, b) => a.p.row - b.p.row);
    colH[c] = cols[c].reduce((t, e) => t + e.s.h + e.s.labelBelow, 0) + ROW_GAP * (cols[c].length - 1);
  }
  const tallest = Math.max(0, ...Object.values(colH));

  const boxes = {};
  let x = PAD;
  for (const c of colKeys) {
    let y = PAD + (tallest - colH[c]) / 2;
    for (const e of cols[c]) {
      boxes[e.n.id] = {
        x: Math.round(x + (colW[c] - e.s.w) / 2),
        y: Math.round(y),
        w: e.s.w, h: e.s.h, labelBelow: e.s.labelBelow, col: c, row: e.p.row,
      };
      y += e.s.h + e.s.labelBelow + ROW_GAP;
    }
    x += colW[c] + COL_GAP;
  }

  const width = Math.round(x - COL_GAP + PAD);
  const height = Math.round(PAD * 2 + tallest);
  return { boxes, width, height };
}

/* A boundary is the bounding box of its members, loosened. */
export function boundaryBox(members, boxes, pad = 26) {
  const bs = members.map(id => boxes[id]).filter(Boolean);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map(b => b.x)) - pad;
  const y0 = Math.min(...bs.map(b => b.y)) - pad;
  const x1 = Math.max(...bs.map(b => b.x + b.w)) + pad;
  const y1 = Math.max(...bs.map(b => b.y + b.h + (b.labelBelow || 0))) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export { COL_GAP, ROW_GAP, PAD };
