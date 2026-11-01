/* ============================================================
   spiega edges — the lines between things, and what rides on them.

   Routing runs in the gutters between columns, never across them. A node that
   fans out to four others sends four lines out of four distinct points on its
   right edge, which then drop through the gutter to their targets. That is both
   what a person draws and the only arrangement where the lines do not pile up
   on one exit point and bury each other's labels.
   ============================================================ */

import { INK, MUTED, ACCENT, PANEL, PAPER } from './theme.js';
import { roughLine, roughPoly, roughRect, roughEllipse, stroke, fill, text, arrowHead, hashSeed, lettering } from './ink.js';
import { backEdges } from './layout.js';

const GAP = 8;             // breathing room between a box edge and its line
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

/* A point on one side of a box, `t` from -1 (top/left) to 1 (bottom/right). */
function sidePoint(box, side, t = 0) {
  const [cx, cy] = center(box);
  const hx = box.w / 2, hy = box.h / 2;
  switch (side) {
    case 'right':  return [box.x + box.w + GAP, cy + hy * FAN * t];
    case 'left':   return [box.x - GAP,         cy + hy * FAN * t];
    case 'top':    return [cx + hx * FAN * t,   box.y - GAP];
    default:       return [cx + hx * FAN * t,   box.y + box.h + GAP];
  }
}

/* Spread the edges that share a side evenly across it, ordered so that lines
   never cross each other on the way out. */
export function planEdges(edges, boxes) {
  const groups = {};
  /* An edge that closes a loop leaves the row and comes back underneath it,
     because that is what a loop looks like. Routed like any other edge it
     would run right-to-left straight through every box between its ends. */
  const back = backEdges(Object.keys(boxes).map(id => ({ id })), edges);
  const floor = Math.max(0, ...Object.values(boxes).map(b => b.y + b.h)) + 46;

  const rec = edges.map(e => {
    const a = boxes[e.from], b = boxes[e.to];
    if (!a || !b) return null;
    const isBack = back.has(`${e.from}>${e.to}`);
    const [sa, sb] = isBack ? ['bottom', 'bottom'] : sides(a, b);
    const r = { e, a, b, sa, sb, key: edgeKey(e), back: isBack, floor };
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
  }

  for (const r of rec) r.pts = route(r);
  return rec;
}

function route({ a, b, sa, sb, ta = 0, tb = 0, e, back, floor }) {
  const A = sidePoint(a, sa, ta);
  const B = sidePoint(b, sb, tb);

  /* Down, back along the floor, and up into the target: the shape every
     control diagram uses for feedback, and the reason the loop reads as one. */
  if (back) return [A, [A[0], floor], [B[0], floor], B];

  const horiz = sa === 'left' || sa === 'right';

  if (e.bend === 'straight' || Math.abs(horiz ? A[1] - B[1] : A[0] - B[0]) < 2) {
    return [A, B];
  }
  if (horiz) {
    // Through the gutter: out, down (or up), in. The knee sits closer to the
    // source so a long fan stays readable near its origin.
    const gx = A[0] + (B[0] - A[0]) * 0.42;
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
   legibly on top of a line. */
export function pill(cx, cy, label, {
  size = 10.5, bg = PANEL, fg = INK, border = INK, seed = 1, padX = 9, h = 19,
  weight = 700, spacing = 0.09,
} = {}) {
  const s = lettering(label);
  const w = s.length * size * 0.62 + padX * 2;
  const d = roughRect(cx - w / 2, cy - h / 2, w, h, h / 2, { seed, amp: 0.6, step: 16 });
  return fill(d, bg) + stroke(d, { w: 1.2, color: border }) +
    text(cx, cy + size * 0.36, s, { size, color: fg, weight, spacing });
}

/* The step number and the label travel together as one tag, so they can never
   land on top of each other. */
function edgeTag(at, step, label, { lit, seed }) {
  const txt = label ? String(label) : '';
  const full = step != null ? (txt ? `${step}  ${txt}` : String(step)) : txt;
  if (!full) return '';
  return pill(at[0], at[1], full, {
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
  const label = (step != null ? String(step) + '  ' : '') + (e.label || '');
  const spot = tagSpot(r.pts);
  const w = lettering(label).length * 6.51 + 20;
  let at = spot.at, away = 0;
  if (w > spot.len * 0.95) {
    const { a, b } = r;
    if (!spot.vertical) {
      away = b.x >= a.x ? -1 : 1;
      at = away < 0
        ? [spot.at[0], Math.min(a.y, b.y) - 13]
        : [spot.at[0], Math.max(a.y + a.h, b.y + b.h) + 13];
    } else {
      at = b.y >= a.y
        ? [Math.max(a.x + a.w, b.x + b.w) + w / 2 + 10, spot.at[1]]
        : [Math.min(a.x, b.x) - w / 2 - 10, spot.at[1]];
    }
  }
  return { at, w, h: 19, away };
}

/* Tags are placed one edge at a time, which is exactly why they collide: a
   node that fans out sends several edges through the same gutter, each lifts
   its tag clear of the same box, and they all land on the same spot. Nothing
   downstream can tell, because each pill draws itself happily on top of the
   last. So resolve them together, once, before any of them is drawn.

   Order matters for stability: left to right, then top to bottom, so adding an
   edge on the right never reshuffles the tags on the left. A tag that was
   lifted keeps being pushed the way it was lifted; one sitting on its own line
   moves to whichever side is nearer, since either reads fine. */
/**
 * @param {any[]} planned
 * @param {(r: any) => number|null} [stepFor]
 * @returns {Map<string, number[]>}
 */
export function planTags(planned, stepFor = () => null) {
  const PAD = 4;
  const placed = [];
  const out = new Map();
  const items = planned
    .map(r => ({ r, ...tagBox(r, stepFor(r)) }))
    .filter(t => {
      const { e } = t.r;
      return e.label || stepFor(t.r) != null;
    })
    .sort((p, q) => (p.at[0] - q.at[0]) || (p.at[1] - q.at[1]));

  const hits = (a, b) =>
    Math.abs(a.at[0] - b.at[0]) < (a.w + b.w) / 2 + PAD &&
    Math.abs(a.at[1] - b.at[1]) < (a.h + b.h) / 2 + PAD;

  for (const t of items) {
    // bounded: each pass moves clear of one neighbour, and there are finitely
    // many. The cap stops a pathological spec from spinning here.
    for (let guard = 0; guard < 40; guard++) {
      const clash = placed.find(p => hits(p, t));
      if (!clash) break;
      const dir = t.away || (t.at[1] >= clash.at[1] ? 1 : -1);
      t.at = [t.at[0], clash.at[1] + dir * ((t.h + clash.h) / 2 + PAD)];
      t.away = dir;
    }
    placed.push(t);
    out.set(t.r.key, t.at);
  }
  return out;
}

/* `state` is 'idle' | 'lit' | 'dim' — the board lights one path at a time.
   `place` is the anchor planTags settled on; without one the tag places itself,
   which is right for a lone edge and wrong for a fan. */
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
