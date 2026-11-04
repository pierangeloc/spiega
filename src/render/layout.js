// @ts-check
/* ============================================================
   spiega layout — where things land on the board.

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

/* A node's slot on the board. `placed` is this map, keyed by node id, and
   assign() mutates it in place — passing the same one across renders pins the
   layout, which is exactly the trap the comment below assign() warns about. */
/** @typedef {{col: number, row: number}} Placement */
/** @typedef {Record<string, Placement>} Placed */

/* The fields layout actually reads. A Board's Node carries more (drawing hints),
   and structural typing lets it through without layout knowing about them. */
/**
 * @typedef {Object} LayoutNode
 * @property {string} id
 * @property {string} [label]
 * @property {string} [sub]
 * @property {string} [kind]
 * @property {number} [col]
 * @property {number} [row]
 * @property {string} [place]
 * @property {number} [w]
 * @property {number} [h]
 * @property {string[]} [lines]
 */

/** @typedef {{from: string, to: string, label?: string, step?: number|null}} LayoutEdge */

/** @typedef {{members?: string[]}} LayoutBoundary */

/** @typedef {{w: number, h: number, labelBelow?: number}} Size */

/** @typedef {{
 *   x: number, y: number, w: number, h: number,
 *   labelBelow?: number, col?: number, row?: number
 * }} Box */

/* COL_GAP is the least a gutter is ever given. What a gutter actually gets is
   decided per boundary by gutterFor(), from the tags that have to sit in it. */
const COL_GAP = 132;
const ROW_GAP = 54;
const PAD = 64;

/* Where an edge runs in a gutter, which is what decides how much gutter a tag
   needs. A line leaves its box EDGE_GAP clear of it, and drops KNEE of the way
   across. edges.js draws with the same two numbers. */
const EDGE_GAP = 8;
const KNEE = 0.42;
const TAG_AIR = 10;

/* A boundary's wall stands BOUNDARY_PAD outside its members and its name rides
   a tab TAB_RISE above that. A box that is not a member has to clear the wall,
   and above the boundary the tab as well, or it is drawn inside the enclosure
   or under its name — which says the same false thing. */
const BOUNDARY_PAD = 26;
const TAB_RISE = 11;
const WALL_AIR = 16;

import { wrapText, NOTE_LINES, nodeText, tagLines, pillSize } from './ink.js';
import { measureMath } from './math.js';

/** @type {Record<string, (n: LayoutNode, tw: number) => Size>} */
const SIZES = {
  service:   (n, tw) => ({ w: Math.max(156, tw + 52), h: 70 }),
  gateway:   (n, tw) => ({ w: Math.max(166, tw + 72), h: 70 }),
  compute:   (n, tw) => ({ w: Math.max(156, tw + 52), h: 78 }),
  cache:     (n, tw) => ({ w: Math.max(150, tw + 52), h: 70 }),
  datastore: (n, tw) => ({ w: Math.max(146, tw + 48), h: 96 }),
  queue:     (n, tw) => ({ w: Math.max(176, tw + 60), h: 48, labelBelow: 34 }),
  /* A field is a card with a label on it, not a component: flatter than a
     service, and about as wide, because what it holds is a name and not a
     box of its own. Tall enough to clear both the notch above the title and
     the thickness band below the sub — at 58 the sub's baseline was touching
     the band and the wobble of the band's top edge was crossing the bottom
     of the sub's letters. */
  field:     (n, tw) => ({ w: Math.max(150, tw + 52), h: 64 }),
  client:    (n, tw) => ({ w: Math.max(146, tw + 48), h: 92 }),
  external:  (n, tw) => ({ w: Math.max(182, tw + 96), h: 96 }),
  /* Measured, not estimated. Every other kind guesses its width from a
     character count, which is fine for a label and wrong for a formula: a
     fraction is one line in the source and two on the board. */
  formula: n => {
    const m = measureMath(n.label || '', 17);
    return { w: Math.max(120, m.w + 44), h: Math.max(62, m.h + 42) };
  },
  note: n => {
    const lines = n.lines || wrapText(n.label, 24, NOTE_LINES);
    const widest = Math.max(1, ...lines.map(l => l.length));
    return { w: Math.max(132, widest * 7.9 + 30), h: 30 + 15 * lines.length };
  },
};

/**
 * @param {string} [s]
 * @param {number} [size]
 * @returns {number}
 */
const textWidth = (s, size = 13.5) => String(s || '').length * size * 0.66;

/* These three set their own text, so the wrap that keeps a box the width of the
   thing it names does not apply to them. */
const OWN_TEXT = new Set(['note', 'formula', 'blob']);

/**
 * @param {LayoutNode} n
 * @returns {{w: number, h: number, labelBelow: number}}
 */
export function sizeOf(n) {
  const fn = SIZES[n.kind || ''] || SIZES.service;
  if (OWN_TEXT.has(n.kind || '')) {
    const s = fn(n, Math.max(textWidth(n.label), textWidth(n.sub, 10)));
    return { w: n.w || s.w, h: n.h || s.h, labelBelow: s.labelBelow || 0 };
  }
  /* The box is as wide as the wrapped text, not the typed text, and as much
     taller as the wrapping added. A queue keeps its text underneath the slots,
     so there it is the strip below that grows. */
  const t = nodeText(n.label, n.sub);
  const tw = Math.max(0, ...t.title.map(l => textWidth(l)), ...t.sub.map(l => textWidth(l, 10)));
  const s = fn(n, tw);
  const below = s.labelBelow ? s.labelBelow + t.extra : 0;
  return { w: n.w || s.w, h: n.h || (s.labelBelow ? s.h : s.h + t.extra), labelBelow: below };
}

/* How wide the gutter must be for a tag that wide to sit in it.

   A tag hangs on the middle of the longest stretch of its line, which for a
   route that drops through the gutter is the run into the target, a little
   over two thirds of the way across. That is the side with the least room
   behind it: the pill reaches half its width past that point, towards the next
   column, and the line itself stopped EDGE_GAP short of the box. So the gutter
   is sized for that side, and the other falls out, with a little air so the
   pill does not touch the box it stops short of. Sizing it to the tag's own
   width instead leaves the pill's far end under the next column's boxes. */
/**
 * @param {number} tagW
 * @returns {number}
 */
export function gutterFor(tagW) {
  const hang = KNEE + (1 - KNEE) / 2;
  const span = (tagW / 2 + TAG_AIR - EDGE_GAP) / (1 - hang);
  return Math.max(COL_GAP, Math.ceil(span + EDGE_GAP * 2));
}

/* Assign a column and row to every node that does not have one yet.

   `placed` is MUTATED, and anything already in it is returned untouched. So
   passing the same map across renders freezes the layout: a node drawn before
   the edge that explains where it belongs stays in column 0 for good, because
   the edge arrives after the node has been pinned. Callers that render a board
   repeatedly pass nothing and let this recompute — it is cheap, and resolving
   in insertion order is already stable. The parameter is for pinning a layout
   deliberately, which is not what rendering wants. */
/* The edges that close a loop.

   A column here means "downstream of": a node sits one to the right of
   whatever points at it. A cycle has no such order, so one edge in it has to
   be set aside before the rest can be laid out — the back edge, found the
   standard way, by depth-first search marking any edge that reaches a node
   still on the stack.

   Without this a feedback loop lays out backwards. Resolving the summing
   junction recursed around the loop, hit the cycle guard, placed the junction
   provisionally at column 0, and then the outer call overwrote that with a
   column computed *from the feedback edge* — so the junction landed after the
   sensor, at the far right, and the loop read as a straight line with a long
   arrow home. */
/**
 * @param {LayoutNode[]} [nodes]
 * @param {LayoutEdge[]} [edges]
 * @returns {Set<string>}
 */
export function backEdges(nodes, edges) {
  /** @type {Record<string, LayoutEdge[]>} */
  const out = {};
  for (const e of edges || []) (out[e.from] ||= []).push(e);
  /** @type {Record<string, number|undefined>} */
  const state = {};                       // undefined | 1 visiting | 2 done
  /** @type {Set<string>} */
  const back = new Set();

  /** @param {string} id */
  const visit = id => {
    state[id] = 1;
    for (const e of out[id] || []) {
      if (state[e.to] === 1) back.add(`${e.from}>${e.to}`);   // reaches the stack
      else if (state[e.to] === undefined) visit(e.to);
    }
    state[id] = 2;
  };
  for (const n of nodes || []) if (state[n.id] === undefined) visit(n.id);
  return back;
}

/**
 * @param {{nodes: LayoutNode[], edges?: LayoutEdge[]}} spec
 * @param {Placed} [placed]
 * @returns {Placed}
 */
export function assign(spec, placed = {}) {
  const byId = Object.fromEntries(spec.nodes.map(n => [n.id, n]));
  const back = backEdges(spec.nodes, spec.edges);
  /** @type {Record<string, string[]>} */
  const incoming = {};
  // a back edge says nothing about which column its target belongs in
  for (const e of spec.edges || []) {
    if (back.has(`${e.from}>${e.to}`)) continue;
    (incoming[e.to] ||= []).push(e.from);
  }

  // Explicit placement wins, then "right of X" / "below X", then the flow.
  /**
   * @param {LayoutNode} n
   * @param {Set<string>} [guard]
   * @returns {Placement}
   */
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

  /** @type {Record<string, Set<number>>} */
  const used = {};
  for (const p of Object.values(placed)) (used[p.col] ||= new Set()).add(p.row);
  /** @param {number} col @returns {number} */
  function nextRow(col) {
    const set = (used[col] ||= new Set());
    let r = 0;
    while (set.has(r)) r++;
    set.add(r);
    return r;
  }
  // keep `used` honest for explicitly placed nodes too
  /** @param {Placement} p */
  const claim = p => (used[p.col] ||= new Set()).add(p.row);

  for (const n of spec.nodes) claim(resolve(n));
  return placed;
}

/* Turn column/row assignments into pixel boxes. */
/* `stepFor` says which step number rides on an edge's tag, since the tag is as
   wide as the number and the words together. Layout has no flow of its own. */
/**
 * @param {{nodes: LayoutNode[], edges?: LayoutEdge[], boundaries?: LayoutBoundary[]}} spec
 * @param {Placed} placed
 * @param {(e: LayoutEdge) => number|null|undefined} [stepFor]
 * @returns {{boxes: Record<string, Box>, width: number, height: number}}
 */
export function layout(spec, placed, stepFor = e => e.step) {
  /** @type {Record<string, {n: LayoutNode, p: Placement, s: {w: number, h: number, labelBelow: number}}[]>} */
  const cols = {};
  for (const n of spec.nodes) {
    const p = placed[n.id];
    if (!p) continue;
    const s = sizeOf(n);
    (cols[p.col] ||= []).push({ n, p, s });
  }

  const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  /** @type {Record<string, number>} */
  const colW = {};
  /** @type {Record<string, number>} */
  const colH = {};
  for (const c of colKeys) {
    colW[c] = Math.max(...cols[c].map(e => e.s.w));
    cols[c].sort((a, b) => a.p.row - b.p.row);
    colH[c] = cols[c].reduce((t, e) => t + e.s.h + e.s.labelBelow, 0) + ROW_GAP * (cols[c].length - 1);
  }
  const tallest = Math.max(0, ...Object.values(colH));

  /* The gutter after each column is as wide as the widest tag that has to cross
     it — per boundary, so one long tag does not push the far side of the board
     out. Done after columns are assigned and before anything is placed: there
     is no placing a tag into a gap it cannot fit. A loop's return runs along
     the floor and never enters a gutter, so it asks for nothing. */
  const back = backEdges(spec.nodes, spec.edges);
  /** @type {number[]} */
  const crossing = colKeys.map(() => 0);
  for (const e of spec.edges || []) {
    if (back.has(`${e.from}>${e.to}`)) continue;
    const a = placed[e.from], b = placed[e.to];
    if (!a || !b || a.col === b.col) continue;
    const step = stepFor(e);
    if (!e.label && step == null) continue;
    const { w } = pillSize(tagLines(e.label, step));
    const lo = Math.min(a.col, b.col), hi = Math.max(a.col, b.col);
    colKeys.forEach((c, i) => {
      if (i + 1 < colKeys.length && lo <= c && hi >= colKeys[i + 1]) crossing[i] = Math.max(crossing[i], w);
    });
  }
  const gap = crossing.map(w => (w ? gutterFor(w) : COL_GAP));

  /** @type {Record<string, Box>} */
  const boxes = {};
  let x = PAD;
  colKeys.forEach((c, i) => {
    let y = PAD + (tallest - colH[c]) / 2;
    for (const e of cols[c]) {
      boxes[e.n.id] = {
        x: Math.round(x + (colW[c] - e.s.w) / 2),
        y: Math.round(y),
        w: e.s.w, h: e.s.h, labelBelow: e.s.labelBelow, col: c, row: e.p.row,
      };
      y += e.s.h + e.s.labelBelow + ROW_GAP;
    }
    x += colW[c] + (gap[i] ?? COL_GAP);
  });

  const width = Math.round(x - (gap[colKeys.length - 1] ?? COL_GAP) + PAD);
  let height = Math.round(PAD * 2 + tallest);

  /* Columns come from the flow and are left alone; what a boundary may still
     ask for is height. Only when some enclosure would take in a box that is
     not its member, so a board whose boundaries were already honest is drawn
     exactly as it always was. */
  const groups = (spec.boundaries || []).map(b => b.members || []);
  if (groups.some(m => intruders(m, boxes).length)) {
    const ys = separate(groups, boxes);
    if (ys) {
      let bottom = 0;
      for (const [id, y] of Object.entries(ys)) {
        boxes[id].y = Math.round(y);
        bottom = Math.max(bottom, boxes[id].y + boxes[id].h + (boxes[id].labelBelow || 0));
      }
      height = Math.round(bottom + PAD);
    }
  }
  return { boxes, width, height };
}

/* A boundary is the bounding box of its members, loosened. */
/**
 * @param {string[]} members
 * @param {Record<string, Box>} boxes
 * @param {number} [pad]
 * @returns {Box|null}
 */
export function boundaryBox(members, boxes, pad = BOUNDARY_PAD) {
  const bs = members.map(id => boxes[id]).filter(Boolean);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map(b => b.x)) - pad;
  const y0 = Math.min(...bs.map(b => b.y)) - pad;
  const x1 = Math.max(...bs.map(b => b.x + b.w)) + pad;
  const y1 = Math.max(...bs.map(b => b.y + b.h + (b.labelBelow || 0))) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* The boxes that fall inside the enclosure of `members` without belonging to
   it. A dashed enclosure is an assertion — everything in here is one thing —
   so a box in there that was never named is the board saying something false,
   and clearly. The tab is part of the enclosure, and is checked with it. */
/**
 * @param {string[]} members
 * @param {Record<string, Box>} boxes
 * @returns {string[]}
 */
export function intruders(members, boxes) {
  const r = boundaryBox(members, boxes);
  if (!r) return [];
  const mine = new Set(members);
  return Object.keys(boxes).filter(id => {
    if (mine.has(id)) return false;
    const b = boxes[id];
    return b.x < r.x + r.w && b.x + b.w > r.x &&
      b.y < r.y + r.h && b.y + b.h + (b.labelBelow || 0) > r.y - TAB_RISE;
  });
}

/* What to draw for a boundary: one enclosure when one tells the truth, and
   otherwise the fewest that do.

   Separating members from their neighbours is done by layout() and mostly
   succeeds, but two boundaries can ask for opposite things of the same box,
   and then no placement makes both rectangles honest. A boundary that cannot
   be one true rectangle is drawn as several: every member starts alone, and
   two pieces merge only while the box around both still holds nothing else. A
   member that is left alone is drawn alone — the board says less rather than
   something it does not mean. */
/**
 * @param {string[]} members
 * @param {Record<string, Box>} boxes
 * @returns {Box[]}
 */
export function boundaryShapes(members, boxes) {
  const whole = boundaryBox(members, boxes);
  if (!whole) return [];
  if (!intruders(members, boxes).length) return [whole];

  /** @type {string[][]} */
  let pieces = members.filter(id => boxes[id]).map(id => [id]);
  const clean = (/** @type {string[]} */ ids) => !intruders(ids, boxes).length;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < pieces.length && !merged; i++)
      for (let j = i + 1; j < pieces.length && !merged; j++) {
        const both = [...pieces[i], ...pieces[j]];
        if (!clean(both)) continue;
        pieces = pieces.filter((_, k) => k !== i && k !== j).concat([both]);
        merged = true;
      }
  }
  return pieces.map(ids => /** @type {Box} */ (boundaryBox(ids, boxes)));
}

/* What each piece of a boundary calls itself on its card.

   Two dashed rectangles under one name read as two boundaries that happen to
   share a name, not as one boundary that could not be drawn as one. So when a
   boundary is drawn as several pieces, each card says which piece it is:
   `B D (1/2)` and `B D (2/2)`, numbered the way the board is read, top to
   bottom and then left to right. A link between the pieces was the other way
   to say it, and it cannot be drawn honestly: the pieces are apart because
   something that is not a member stands between them, so the line would have
   to run through or around exactly the boxes the split is keeping out, and
   would read as an edge. A boundary that is one rectangle keeps its name as
   written. */
/**
 * @param {string|undefined} label
 * @param {Box[]} shapes what boundaryShapes returned
 * @returns {(string|undefined)[]} one name per shape, in the same order
 */
export function pieceNames(label, shapes) {
  if (shapes.length < 2) return shapes.map(() => label);
  const reading = shapes.map((_, i) => i)
    .sort((i, j) => (shapes[i].y - shapes[j].y) || (shapes[i].x - shapes[j].x) || (i - j));
  return shapes.map((_, i) => {
    const part = `(${reading.indexOf(i) + 1}/${shapes.length})`;
    return label ? `${label} ${part}` : part;
  });
}

/* Where each box must stand for every group's enclosure to hold only its own.

   Each box that an enclosure would otherwise swallow has to go wholly above it
   or wholly below it. That is a set of "this one is at least so far below that
   one" constraints, which is the same shape as the order of boxes within a
   column, so both go into one graph and the smallest y that satisfies all of it
   is a longest path. Nothing here changes a column: the flow decided those, and
   a box that sits between two members in the flow is not moved next to them,
   it is stood clear of the band they share.

   Which side is decided box by box, preferring where it already is, and a
   choice is kept only if it leaves the graph without a cycle — a cycle being
   exactly two enclosures that want opposite things. A group that cannot be
   satisfied is given up whole (boundaryShapes draws it as pieces); returning
   null means nothing could be placed at all. */
/**
 * @param {string[][]} groups
 * @param {Record<string, Box>} boxes
 * @returns {Record<string, number>|null}
 */
function separate(groups, boxes) {
  const ids = Object.keys(boxes);
  /** @param {string} id */
  const span = id => boxes[id].h + (boxes[id].labelBelow || 0);

  /** @typedef {Map<string, Map<string, number>>} Graph */
  /** @type {Graph} */
  const graph = new Map(ids.map(id => [id, new Map()]));
  /** @param {string} from @param {string} to @returns {boolean} */
  const reaches = (from, to) => {
    const seen = new Set([from]);
    const todo = [from];
    while (todo.length) {
      const at = /** @type {string} */ (todo.pop());
      if (at === to) return true;
      for (const next of graph.get(at)?.keys() || [])
        if (!seen.has(next)) { seen.add(next); todo.push(next); }
    }
    return false;
  };
  /** @param {string} above @param {string} below @param {number} by @returns {() => void} */
  const stack = (above, below, by) => {
    const edges = /** @type {Map<string, number>} */ (graph.get(above));
    const before = edges.get(below);
    edges.set(below, Math.max(by, before ?? 0));
    return () => { if (before === undefined) edges.delete(below); else edges.set(below, before); };
  };

  /* Every (group, box) pair that needs a side, with the side it would rather
     have: where it already is. Inside the rectangle, a box in a member's own
     column keeps its order against that member, and any other goes to whichever
     half it is nearer, below if it cannot tell. */
  /** @type {{g: number, id: string, mine: string[], prefer: boolean}[]} */
  const asks = [];
  groups.forEach((members, g) => {
    const mine = members.filter(id => boxes[id]);
    if (!mine.length) return;
    const rect = /** @type {Box} */ (boundaryBox(mine, boxes));
    for (const id of ids) {
      const b = boxes[id];
      if (mine.includes(id) || !(b.x < rect.x + rect.w && b.x + b.w > rect.x)) continue;
      const top = b.y, bottom = b.y + span(id);
      const beside = mine.filter(m => boxes[m].col === b.col);
      const prefer = bottom <= rect.y ? true
        : top >= rect.y + rect.h ? false
        : beside.length ? (b.row ?? 0) < Math.min(...beside.map(m => boxes[m].row ?? 0))
        : (top + bottom) / 2 < rect.y + rect.h / 2;
      asks.push({ g, id, mine, prefer });
    }
  });

  /* Choose a side for each ask, backing up when a choice strands a later one:
     two groups can each be satisfiable alone and only one of the four ways to
     combine them works, and taking the first that fits and moving on misses it.
     The search is capped, because a board with a dozen overlapping groups could
     otherwise be asked to try every combination; running out is just failure,
     and failure is what gives a group up. */
  /** @type {Set<number>} */
  let given = new Set();
  let budget = 0;
  /** @param {number} k @returns {boolean} */
  const settle = k => {
    if (k === asks.length) return true;
    const { g, id, mine, prefer } = asks[k];
    if (given.has(g)) return settle(k + 1);
    if (--budget < 0) return false;
    for (const above of [prefer, !prefer]) {
      if (!mine.every(m => above ? !reaches(m, id) : !reaches(id, m))) continue;
      const undo = mine.map(m => above
        ? stack(id, m, span(id) + BOUNDARY_PAD + TAB_RISE + WALL_AIR)
        : stack(m, id, span(m) + BOUNDARY_PAD + WALL_AIR));
      if (settle(k + 1)) return true;
      undo.reverse().forEach(u => u());
    }
    return false;
  };
  /* Everything if it can be had, else give up the last group and try again. */
  for (let drop = groups.length; drop >= 0; drop--) {
    given = new Set(groups.map((_, g) => g).slice(drop));
    budget = 4000;
    if (settle(0)) break;
  }

  /* Order within each column: the plain row order, except where a constraint
     above says otherwise. A box is taken as soon as nothing still waiting must
     come before it, lowest row first. */
  /** @type {Record<number, string[]>} */
  const byCol = {};
  for (const id of ids) (byCol[boxes[id].col ?? 0] ||= []).push(id);
  for (const col of Object.values(byCol)) {
    const waiting = col.sort((p, q) => (boxes[p].row ?? 0) - (boxes[q].row ?? 0));
    const order = [];
    while (waiting.length) {
      const k = waiting.findIndex(id => !waiting.some(other => other !== id && reaches(other, id)));
      order.push(...waiting.splice(Math.max(k, 0), 1));
    }
    for (let i = 1; i < order.length; i++) stack(order[i - 1], order[i], span(order[i - 1]) + ROW_GAP);
  }

  /* Longest path, in topological order. A cycle here is two columns ordered
     against each other by constraints that were each fine alone. */
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const tos of graph.values()) for (const to of tos.keys()) indegree.set(to, (indegree.get(to) || 0) + 1);
  /** @type {Record<string, number>} */
  const y = Object.fromEntries(ids.map(id => [id, PAD]));
  const ready = ids.filter(id => !indegree.get(id));
  /** @type {string[]} */
  const order = [];
  let done = 0;
  while (ready.length) {
    const id = /** @type {string} */ (ready.shift());
    done++;
    order.push(id);
    for (const [to, by] of graph.get(id) || []) {
      y[to] = Math.max(y[to], y[id] + by);
      indegree.set(to, (indegree.get(to) || 0) - 1);
      if (!indegree.get(to)) ready.push(to);
    }
  }

  /* The longest path gives every box its earliest position, which packs the
     whole board to the top. layout() centres every column against the tallest
     one, and that centring is lost the moment separation runs. Running the same
     graph backwards from the board's height gives each box its latest position
     — how far it can fall before an edge that needs it above another, or the
     bottom, stops it. `slack = latest - earliest` is that box's own room to
     move, and standing it in the middle of its slack puts a box that shares a
     column with one a boundary pinned back where it sat before separation,
     instead of deciding per column and dragging the pinned neighbour along or
     leaving a whole column packed to the top.

     The midpoint is safe because both ends are a valid placement of the same
     difference constraints: taking the average of two placements that each
     satisfy "this one is at least so far below that one" satisfies it too. So a
     box a boundary stood clear of a member stays clear of it, and the board
     never grows — the reverse pass anchors every box above the bottom its
     earliest position already reached. */

  if (done !== ids.length) return null;

  let bottom = PAD;
  for (const id of ids) bottom = Math.max(bottom, y[id] + span(id));

  /** @type {Record<string, number>} */
  const latest = Object.fromEntries(ids.map(id => [id, bottom - span(id)]));
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    for (const [to, by] of graph.get(id) || [])
      latest[id] = Math.min(latest[id], latest[to] - by);
  }
  for (const id of ids) y[id] += (latest[id] - y[id]) / 2;

  return y;
}

export { COL_GAP, ROW_GAP, PAD, EDGE_GAP, KNEE };
