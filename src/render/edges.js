/* ============================================================
   spiega edges — the lines between things, and what rides on them.

   Routing runs in the gutters between columns, never across them. A node that
   fans out to four others sends four lines out of four distinct points on its
   right edge, which then drop through the gutter to their targets. That is both
   what a person draws and the only arrangement where the lines do not pile up
   on one exit point and bury each other's labels.
   ============================================================ */

import { INK, MUTED, ACCENT, PANEL, PAPER } from './theme.js';
import { roughLine, roughPoly, roughRect, roughEllipse, stroke, fill, text, arrowHead, hashSeed, lettering, tagLines, pillSize } from './ink.js';
import { backEdges, KNEE, EDGE_GAP } from './layout.js';

const GAP = EDGE_GAP;      // breathing room between a box edge and its line
const FAN = 0.52;          // how much of a side's length the fan may spread over

export const center = b => [b.x + b.w / 2, b.y + b.h / 2];
export const edgeKey = e => `${e.from}>${e.to}`;

/* Which side of its box does this edge leave from / arrive at? */
function sides(a, b) {
  const ca = center(a), cb = center(b);
  const colA = a.col ?? 0, colB = b.col ?? 0;
  if (colB > colA) return ['right', 'left'];
  if (colB < colA) return ['left', 'right'];
  return cb[1] >= ca[1] ? ['bottom', 'top'] : ['top', 'bottom'];
}

/* A queue keeps its name in a strip under the glyph rather than inside it, so
   the bottom of the box is not the bottom of the node. A line that left at
   box.y + box.h ran down through its own label: the closing edge of a cycle
   left the DLQ and struck its name through, which read as `D|Q`. Every other
   side clears the drawing by GAP, and this one has to clear the words too. */
const bottomOf = box => box.y + box.h + (box.labelBelow || 0);

/* A point on one side of a box, `t` from -1 (top/left) to 1 (bottom/right).

   The line stops GAP short of the ink, not of the box. A rectangle's ink is
   the box, so it answers nothing and a board without a convex glyph does not
   move. A convex outline curves away from its box everywhere but the points
   where it touches, and the glyph says how far, at this station along the
   side. `along` is the fraction of the half-extent from the centre — the same
   spread the fan uses — so the glyph does not have to know FAN. The inset is
   added toward the glyph: the other sign pushes an arrow that already stops
   short even further into the background.

   A station whose ray misses the ink entirely — a particle's circle lives in
   the top of its box, so the lower half of a fan points at nothing — slides
   along the side to the nearest ink. Staying put would leave that arrow at
   the box while its neighbour lands on the circle. A fan that would then
   collapse onto one point is spread back across the ink, as a fan: each
   station solved on its own picks the same nearest point of a small disc,
   and two arrows become one. */
function sidePoint(box, side, t = 0) {
  const [cx, cy] = center(box);
  const hx = box.w / 2, hy = box.h / 2;
  const along = FAN * t;
  const span = side === 'left' || side === 'right' ? box.w : box.h;
  const adj = box.inkAt ? box.inkAt(side, along) : null;
  const inset = Math.max(0, Math.min(span, adj?.inset || 0));
  const slide = adj?.slide || 0;
  switch (side) {
    case 'right': return [box.x + box.w + GAP - inset, cy + hy * along + slide];
    case 'left':  return [box.x - GAP + inset,         cy + hy * along + slide];
    case 'top':   return [cx + hx * along + slide, box.y - GAP + inset];
    default:      return [cx + hx * along + slide, bottomOf(box) + GAP - inset];
  }
}

/* Two arrowheads closer than this read as one. The head is 11px, and its
   wings stand a few pixels off the shaft; 16 leaves daylight between them. */
const HEAD_SEP = 16;

/* When a fan has collapsed onto one point of the ink, lay it back out across
   the ink's extent on this side, in the order it already has. `t` is rewritten
   so sidePoint's station lands there; the ray then hits, and the inset is the
   ordinary one. A span too short for the separation gets the whole of it. */
function spreadFan(list, side) {
  if (list.length < 2) return;
  const box = list[0].r[list[0].end];
  if (!box.inkSpan) return;
  const horiz = side === 'left' || side === 'right';
  const axis = horiz ? 1 : 0;
  const placed = list.map(item => {
    const t = item.r[item.end === 'a' ? 'ta' : 'tb'];
    return sidePoint(box, side, t)[axis];
  }).sort((a, b) => a - b);
  let collapsed = false;
  for (let i = 1; i < placed.length; i++) if (placed[i] - placed[i - 1] < HEAD_SEP) collapsed = true;
  if (!collapsed) return;
  const span = box.inkSpan(side);
  if (!span || span.hi - span.lo < 8) return;
  /* Off the tangent: a station at the extreme of a disc meets the outline at
     a point, and the arrow sticks out past the glyph. */
  const pad = Math.min(4, (span.hi - span.lo) * 0.12);
  const lo = span.lo + pad, hi = span.hi - pad;
  if (hi - lo < 4) return;
  const mid = horiz ? box.y + box.h / 2 : box.x + box.w / 2;
  const half = horiz ? box.h / 2 : box.w / 2;
  const n = list.length;
  list.forEach((item, i) => {
    const at = lo + (hi - lo) * (i / (n - 1));
    item.r[item.end === 'a' ? 'ta' : 'tb'] = (at - mid) / (half * FAN);
  });
}

/* Spread the edges that share a side evenly across it, ordered so that lines
   never cross each other on the way out. */
export function planEdges(edges, boxes, lanes = {}) {
  const groups = {};
  /* An edge that closes a loop leaves the row and comes back underneath it,
     because that is what a loop looks like. Routed like any other edge it
     would run right-to-left straight through every box between its ends. */
  const back = backEdges(Object.keys(boxes).map(id => ({ id })), edges);
  const floor = Math.max(0, ...Object.values(boxes).map(bottomOf)) + 46;

  const rec = edges.map(e => {
    const a = boxes[e.from], b = boxes[e.to];
    if (!a || !b) return null;
    const isBack = back.has(`${e.from}>${e.to}`);
    /* A back edge leaves its source from the bottom and rises into its target
       from the bottom, because a feedback loop runs along the floor. But the
       two vertical legs are not checked against the boxes in their column: if
       another box sits below the source or the target in the same column, the
       straight drop runs through it and the line reads as an edge between the
       wrong two boxes. Such a leg leaves the column instead — out of the
       source's right side, or into the target's left — and travels down the
       gutter beside the column, where there is nothing to cross. */
    const [sa, sb] = isBack
      ? [blockedBelow(a, boxes) ? 'right' : 'bottom', blockedBelow(b, boxes) ? 'left' : 'bottom']
      : sides(a, b);
    const r = { e, a, b, sa, sb, key: edgeKey(e), back: isBack, floor, via: lanes[edgeKey(e)],
      gutterA: colEdge(a, boxes, 'right'), gutterB: colEdge(b, boxes, 'left') };
    (groups[`${e.from}|${sa}`] ||= []).push({ r, end: 'a' });
    (groups[`${e.to}|${sb}`]   ||= []).push({ r, end: 'b' });
    return r;
  }).filter(Boolean);

  for (const [k, list] of Object.entries(groups)) {
    const side = k.split('|')[1];
    const axis = side === 'left' || side === 'right' ? 1 : 0;   // spread along y for vertical sides
    list.sort((p, q) => {
      const op = center(p.end === 'a' ? p.r.b : p.r.a)[axis];
      const oq = center(q.end === 'a' ? q.r.b : q.r.a)[axis];
      return op - oq;
    });
    const n = list.length;
    list.forEach((item, i) => {
      const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      item.r[item.end === 'a' ? 'ta' : 'tb'] = t;
    });
    /* A small disc's nearest ink is one point. Solving each station on its
       own parks every arrowhead there, and the fan the ordering exists to
       create is gone. Spread them back across the ink, in the same order,
       far enough apart that two heads still read as two. A fan that already
       lands apart is left where it is: a blob's stations do not collapse. */
    spreadFan(list, side);
  }

  /* Two back edges that both left a column by the gutter would drop down the
     same vertical and read as one line. Each gets a lane of its own. The one
     that leaves (or enters) lowest takes the lane nearest the column: the
     others' horizontal runs pass above it, so nothing crosses on the way out. */
  for (const [end, side, at] of [['a', 'right', 'gutterA'], ['b', 'left', 'gutterB']]) {
    const s = end === 'a' ? 'sa' : 'sb', t = end === 'a' ? 'ta' : 'tb';
    const lane = {};
    for (const r of rec.filter(r => r.back && r[s] === side)
      .sort((p, q) => sidePoint(q[end], side, q[t])[1] - sidePoint(p[end], side, p[t])[1])) {
      const n = lane[r[end].col ?? 0] = (lane[r[end].col ?? 0] ?? -1) + 1;
      r[at] += (side === 'right' ? 1 : -1) * n * BACK_LANE;
    }
  }

  spreadKnees(rec);

  for (const r of rec) r.pts = route(r);
  return rec;
}

/* Lines that converge on one box turn in the same place, which draws them as
   one line.

   An edge through a gutter goes out, turns, changes row, and goes in. Where it
   turns is a fraction of the way across, so three edges leaving one column for
   one target turn at the same x and their vertical runs lie on top of each
   other — three quarters of a pixel apart, for hundreds of pixels. The reader
   cannot trace any of them, and a label on that stretch belongs to all three
   (#102). Fan-out got its lanes in #52 by spreading along the side it leaves;
   this is the other half, and the side cannot fix it, because what collides is
   the turn and not the exit.

   Who turns first: the one with least row to change. An edge's vertical run
   covers the rows between its ends, so the longest one would be crossed by
   everything that turns to the left of it — and is therefore the one that
   turns last, nearest its target, where the others' rows are already behind
   them. Centred on where the turn would have been, so a board with nothing to
   separate is drawn exactly as it was. */
const KNEE_LANE = 14;      // between two knees sharing one gutter
const SAME_KNEE = 6;       // turns within this of each other are the same turn

function spreadKnees(rec) {
  /** @type {Map<string, any[]>} */
  const arriving = new Map();
  for (const r of rec) {
    if (r.back || r.via?.length || r.e.bend === 'straight') continue;
    if (r.sa !== 'left' && r.sa !== 'right') continue;
    const A = sidePoint(r.a, r.sa, r.ta), B = sidePoint(r.b, r.sb, r.tb);
    if (Math.abs(A[1] - B[1]) < 2) continue;            // level: a straight shot, no turn
    r.span = [Math.min(A[1], B[1]), Math.max(A[1], B[1])];
    r.knee = A[0] + (B[0] - A[0]) * KNEE;
    if (!arriving.has(r.e.to)) arriving.set(r.e.to, []);
    arriving.get(r.e.to).push(r);
  }
  /* Only what actually collides. Two edges into one box turn in the same place
     only if they turn at the same x *and* their runs cover some of the same
     rows; separating anything else moves a line that was already clear, and a
     line moved for no reason is one more thing to cross. */
  for (const list of arriving.values()) {
    const stack = list.filter(r => list.some(o => o !== r
      && Math.abs(o.knee - r.knee) < SAME_KNEE
      && o.span[0] < r.span[1] && o.span[1] > r.span[0]));
    if (stack.length < 2) continue;
    /* The one with least row to change turns first. Its vertical run is the
       shortest, so it is the one the others can afford to pass in front of. */
    stack.sort((p, q) => (p.span[1] - p.span[0]) - (q.span[1] - q.span[0]) || (p.key < q.key ? -1 : 1));
    stack.forEach((r, i) => { r.lane = (i - (stack.length - 1) / 2) * KNEE_LANE; });
  }
}

/* Is there another box below this one, in its column, overlapping it across?
   The leg of a back edge drops (or rises) straight through its column; only a
   box that overlaps it across is in the way. A neighbour elsewhere in the
   column does not block it. */
function blockedBelow(box, boxes) {
  return Object.values(boxes).some(o => o !== box && (o.col ?? 0) === (box.col ?? 0)
    && o.y > box.y && o.x < box.x + box.w && o.x + o.w > box.x);
}

/* A vertical line just outside a column: right of its widest box, or left of
   it. A back edge whose leg is blocked below travels here, clear of everything
   the column owns. */
const BACK_GUTTER = 22;
const BACK_LANE = 12;      // between two back edges sharing one gutter
function colEdge(box, boxes, side) {
  const col = Object.values(boxes).filter(o => (o.col ?? 0) === (box.col ?? 0));
  return side === 'right'
    ? Math.max(...col.map(o => o.x + o.w)) + BACK_GUTTER
    : Math.min(...col.map(o => o.x)) - BACK_GUTTER;
}

function route({ a, b, sa, sb, ta = 0, tb = 0, e, back, floor, gutterA, gutterB, via, lane = 0 }) {
  const A = sidePoint(a, sa, ta);
  const B = sidePoint(b, sb, tb);

  /* Down, back along the floor, and up into the target: the shape every
     control diagram uses for feedback, and the reason the loop reads as one. */
  if (back) {
    /* A leg that leaves the column runs out to the gutter first, then drops
       (or rises) there; one that is not blocked just drops in place. */
    const out = sa === 'right' ? [[gutterA, A[1]], [gutterA, floor]] : [[A[0], floor]];
    const into = sb === 'left' ? [[gutterB, floor], [gutterB, B[1]]] : [[B[0], floor]];
    return [A, ...out, ...into, B];
  }

  const horiz = sa === 'left' || sa === 'right';

  // Cross each reserved row horizontally and change height only in the
  // gutters, even when the endpoints happen to be level with one another.
  if (e.bend !== 'straight' && via?.length && horiz) {
    const pts = [A];
    let last = A;
    let right = gutterA - BACK_GUTTER + GAP;
    for (const lane of via) {
      const left = lane.x - GAP;
      const gx = right + (left - right) * KNEE;
      pts.push([gx, last[1]], [gx, lane.y], [left, lane.y], [lane.x + lane.w + GAP, lane.y]);
      last = pts[pts.length - 1];
      right = last[0];
    }
    const gx = right + (gutterB + BACK_GUTTER - GAP - right) * KNEE;
    pts.push([gx, last[1]], [gx, B[1]], B);
    return pts;
  }

  if (e.bend === 'straight' || Math.abs(horiz ? A[1] - B[1] : A[0] - B[0]) < 2) {
    return [A, B];
  }
  if (horiz) {
    // Through the gutter: out, down (or up), in. The knee sits closer to the
    // source so a long fan stays readable near its origin, and `lane` holds it
    // off whatever else turns in the same gutter (#102).
    const gx = A[0] + (B[0] - A[0]) * KNEE + lane;
    return [A, [gx, A[1]], [gx, B[1]], B];
  }
  const gy = A[1] + (B[1] - A[1]) * 0.5;
  return [A, [A[0], gy], [B[0], gy], B];
}

const segLen = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/* Hang the tag on the longest segment of the route. On a gutter route that is
   almost always the vertical drop, which is empty space by construction. */
function tagSpot(pts) {
  let best = 0, bestLen = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = segLen(pts[i], pts[i + 1]);
    if (l > bestLen) { bestLen = l; best = i; }
  }
  const p = pts[best], q = pts[best + 1];
  return {
    at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
    vertical: Math.abs(q[1] - p[1]) > Math.abs(q[0] - p[0]),
    len: bestLen,
  };
}

/* A small paper-backed pill — edge tags, and anything else that needs to sit
   legibly on top of a line. `label` is a string, or the lines it has already
   been wrapped into; a long tag is two short lines rather than one wide one,
   because the gutter it has to sit in is only so wide. */
export function pill(cx, cy, label, {
  size = 10.5, bg = PANEL, fg = INK, border = INK, seed = 1, padX = 9, h = 19,
  weight = 700, spacing = 0.09,
} = {}) {
  const lines = (Array.isArray(label) ? label : [lettering(label)]);
  const box = pillSize(lines, { size, padX, h });
  const lh = size * 1.2;
  const d = roughRect(cx - box.w / 2, cy - box.h / 2, box.w, box.h, h / 2, { seed, amp: 0.6, step: 16 });
  const first = cy - (lines.length - 1) * lh / 2 + size * 0.36;
  return fill(d, bg) + stroke(d, { w: 1.2, color: border }) +
    lines.map((s, i) => text(cx, first + i * lh, s, { size, color: fg, weight, spacing })).join('');
}

/* The step number and the label travel together as one tag, so they can never
   land on top of each other. */
function edgeTag(at, step, label, { lit, seed }) {
  const lines = tagLines(label, step);
  if (!lines.length) return '';
  return pill(at[0], at[1], lines, {
    seed, bg: lit ? ACCENT : PANEL,
    fg: lit ? PAPER : INK, border: lit ? ACCENT : INK,
    size: 10.5, padX: 10,
  });
}

/* Where one tag wants to sit, and how big it is, with no knowledge of the
   others. On a short hop between neighbouring boxes the tag is wider than the
   gap, so centring it on the line buries it under whatever is next door. Lift
   it clear of both boxes instead — nudging it a few pixels is not enough,
   since a box is far taller than the line is thick. `away` records which way
   it was lifted, so that if it later has to move again it keeps going the way
   it already went rather than back across the line it belongs to. */
/**
 * @param {any} r
 * @param {number|null} step
 */
export function tagBox(r, step) {
  const { e } = r;
  const spot = tagSpot(r.pts);
  const { w, h } = pillSize(tagLines(e.label, step));
  let at = spot.at, away = 0;
  if (w > spot.len * 0.95) {
    const { a, b } = r;
    if (!spot.vertical) {
      away = b.x >= a.x ? -1 : 1;
      at = away < 0
        ? [spot.at[0], Math.min(a.y, b.y) - (h / 2 + 3.5)]
        : [spot.at[0], Math.max(a.y + a.h, b.y + b.h) + h / 2 + 3.5];
    } else {
      at = b.y >= a.y
        ? [Math.max(a.x + a.w, b.x + b.w) + w / 2 + 10, spot.at[1]]
        : [Math.min(a.x, b.x) - w / 2 - 10, spot.at[1]];
    }
  }
  return { at, w, h, away };
}

/* `state` is 'idle' | 'lit' | 'dim' — the board lights one path at a time.
   `place` is the anchor render/floating.js settled on, against everything
   else that floats; without one the tag places itself, which is right for a
   lone edge and wrong for anything with neighbours. */
/**
 * @param {any} r
 * @param {{step?: number|null, state?: string, place?: number[]|null}} [opts]
 */
export function drawEdge(r, { step = null, state = 'idle', place = null } = {}) {
  const { e, pts } = r;
  const seed = hashSeed(r.key) % 100000;
  const lit = state === 'lit', dim = state === 'dim';
  const color = lit ? ACCENT : INK;
  const opacity = dim ? 0.4 : 1;
  const async = e.async || e.style === 'async';

  const d = roughPoly(pts, { close: false, seed, amp: 0.9, step: 32 });
  const end = pts[pts.length - 1], prev = pts[pts.length - 2];
  const dir = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
  const spot = tagSpot(pts);

  let out = `<g class="edge" data-edge="${r.key}" opacity="${opacity}">`;
  out += stroke(d, { w: lit ? 3 : 1.9, color, dash: async ? '9 6' : null });
  out += arrowHead(end, dir, { size: lit ? 13 : 11, w: lit ? 2.6 : 1.9, color, seed });
  if (e.label || step != null) {
    // On a short hop between neighbouring boxes the tag is wider than the gap,
    // so centring it on the line buries it under whatever is next door. Lift it
    // clear of both boxes instead — nudging it a few pixels is not enough, since
    // a box is far taller than the line is thick. A pair of edges running both
    // ways between the same two boxes splits above and below, so the two tags
    // do not then collide with each other.
    const at = place || tagBox(r, step).at;
    out += `<g class="tag">${edgeTag(at, step, e.label, { lit, seed: seed + 5 })}</g>`;
  }
  return out + `</g>`;
}

/* A dot that rides the line — the packet, when a flow is playing. */
export function packetAt(pts, t) {
  let total = 0;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = segLen(pts[i], pts[i + 1]);
    segs.push(l); total += l;
  }
  let want = total * Math.min(1, Math.max(0, t));
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const k = segs[i] ? want / segs[i] : 0;
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k];
    }
    want -= segs[i];
  }
  return pts[pts.length - 1];
}

export { sidePoint, tagSpot };
