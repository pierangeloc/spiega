// @ts-check
/* ============================================================
   spiega floating — one placement pass over everything that floats.

   Two kinds of text on the board have no fixed home: the tag riding an edge
   and the callout beside a thing. Each used to be placed against its own kind
   and nothing else — tags against tags, callouts against callouts — so a tag
   landed under a box it was not about, a callout printed across a neighbour's
   name, and a note, painted last because that is what a note is, covered
   whatever had been put behind it. Nothing downstream could tell: every pill
   draws itself happily over whatever is already there.

   So they are placed here, once, against one set of obstacles:

   - solids: what a word must never land on. Every node's box, which holds its
     words (and, for a queue, the strip below it that holds them instead), every
     note card, and each tag and callout as soon as it has been placed. A tag
     is painted beneath the nodes, so landing on a box hides it; a callout is
     painted over them, so landing on one prints a word on a word. Either way
     it is unreadable.
   - arrowheads, which are solids of a lesser kind: a pill laid over one leaves
     the line but loses which way it runs, which is the one thing a tag on a
     short hop is tempted to cover.
   - wires: the routed edges. A line crossed by a pill is still legible; a word
     printed on a word is not. So a wire costs something, and a solid costs a
     great deal more, and when nothing is clear the least bad place wins.

   A boundary's tab (#87) would enter as one more solid, pushed by obstacles()
   with the others; nothing in the pass would change.

   Order is what keeps a board still while it is being drawn. Tags go first,
   left to right and then top to bottom by where each would rather be, so
   adding an edge on the right never reshuffles the tags on the left. Callouts
   go after, in the order they were said: a callout is an aside, and it gives
   way to the structure rather than the other way round. Each candidate list
   starts with where the thing has always gone, so a label that was already on
   its own line and clear of everything stays exactly where it was.
   ============================================================ */

import { tagBox } from './edges.js';
import { cuts, wireCuts, toSegment } from './geom.js';
import { calloutCandidates, onEdges, leaderNear, target, TEXT_PAD, DOT } from './callout.js';

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {import('./layout.js').Box} Box */
/** @typedef {import('../board/state.js').Edge} Edge */
/** @typedef {import('../board/state.js').Callout} Callout */
/* An edge as planEdges routed it: the fields this pass reads. */
/** @typedef {{e: Edge, key: string, a: Box, b: Box, pts: number[][]}} Route */
/* A callout as callout.js places it: the box its words take, where the leader
   lands, and what drawCallout needs to draw it there. */
/** @typedef {{
 *   c: Callout, tip: {x: number, y: number, kind: string}, side: string,
 *   lines: string[], w: number, h: number, cx: number, cy: number, box: Rect
 * }} CalloutPlace */
/** @typedef {{rect: Rect, what: string, float?: boolean, weight?: number}} Solid */
/** @typedef {{key: string, pts: number[][]}} Wire */
/** @typedef {{solids: Solid[], wires: Wire[]}} Obstacles */
/** @typedef {{key: string, at: number[], w: number, h: number}} PlacedTag */

const SOLID = 1000;       // a word on a word, or a pill under a box
const ARROW = 200;        // a pill over an arrowhead: the line is still there, which way it goes is not
const WIRE = 10;          // a pill across a line that is not its own
const PAD = 4;            // the air two pills keep between them
const BESIDE = 7;         // a pill set beside its line stands this far off it, clear of the arrowhead's wings
const TOUCH = BESIDE;     // how far off its own line a pill may sit and still be on it
const HEAD = 8, WING = 5;  // the front of an arrowhead, which is the part that says which way, and its spread
const NEAR = 8;           // another line within this much of as near as its own makes a pill ambiguous

/* Everything fixed that floating text must keep off. */
/**
 * @param {Record<string, Box>} boxes
 * @param {Route[]} planned
 * @returns {Obstacles}
 */
export function obstacles(boxes, planned) {
  /** @type {Solid[]} */
  const solids = Object.entries(boxes).map(([id, b]) => ({
    what: id, rect: { x: b.x, y: b.y, w: b.w, h: b.h + (b.labelBelow || 0) },
  }));
  for (const r of planned) {
    if (r.pts.length < 2) continue;
    const tip = r.pts[r.pts.length - 1], prev = r.pts[r.pts.length - 2];
    const len = Math.hypot(tip[0] - prev[0], tip[1] - prev[1]) || 1;
    const ux = (tip[0] - prev[0]) / len, uy = (tip[1] - prev[1]) / len;
    /* The head is drawn 11px back from the tip. A pill may touch the base of
       it, which is where a tag sized into its gutter has always ended; the
       front of it is what must show. */
    const xs = [tip[0], tip[0] - ux * HEAD + uy * WING, tip[0] - ux * HEAD - uy * WING];
    const ys = [tip[1], tip[1] - uy * HEAD - ux * WING, tip[1] - uy * HEAD + ux * WING];
    const x = Math.min(...xs), y = Math.min(...ys);
    solids.push({ what: `arrow ${r.key}`, weight: ARROW,
      rect: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } });
  }
  return { solids, wires: planned.map(r => ({ key: r.key, pts: r.pts })) };
}

/**
 * @param {Rect} a
 * @param {Rect} b
 * @returns {number} the area they share
 */
const shared = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/* How far a rectangle stands from a polyline: nothing if the line passes
   through it, otherwise the nearest an end of a stretch comes to the box or a
   corner of the box comes to a stretch. */
/**
 * @param {Rect} r
 * @param {number[][]} pts
 */
function standOff(r, pts) {
  const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
  /** @param {number[]} p */
  const toRect = p => Math.hypot(Math.max(r.x - p[0], 0, p[0] - r.x - r.w), Math.max(r.y - p[1], 0, p[1] - r.y - r.h));
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    if (cuts(pts[i - 1], pts[i], r)) return 0;
    d = Math.min(d, toRect(pts[i - 1]), toRect(pts[i]), ...corners.map(c => toSegment(c, pts[i - 1], pts[i])));
  }
  return d;
}

/** @param {Rect} r @param {number} by @returns {Rect} */
const grow = (r, by) => ({ x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 });

/* What a solid costs: a great deal for touching it at all, and a little more
   the more of the label it covers, so when every place is bad the one that
   hides least wins. */
/**
 * @param {Rect} r
 * @param {Solid[]} solids
 */
function solidCost(r, solids) {
  let c = 0;
  for (const s of solids) {
    const a = shared(r, s.rect);
    if (a > 0) c += (s.weight ?? SOLID) * (1 + a / Math.max(1, r.w * r.h));
  }
  return c;
}

/* Where one tag could sit, best first. Every one of them is on its own line or
   just beside it, because a pill that drifts off its edge is a label for
   whichever line it ends up nearest.

   First, where tagBox has always put it. Then the run into the target, which
   no other edge shares, so a pill there cannot be read as another edge's: a
   fan of seven edges drops through one corridor and parts only at the end,
   and a tag hung in the corridor sits on all seven. Then every other stretch of
   its own route, longest first, at its middle and either side of it. Then just
   beside its line. Last, stepped up and down from where it wanted to be, which
   is what the old pass did for everything. */
/**
 * @param {Route} r
 * @param {{at: number[], w: number, h: number, away: number}} ideal
 * @returns {number[][]}
 */
function tagSpots(r, ideal) {
  const pts = r.pts;
  /** @type {number[][]} */
  const out = [ideal.at];
  const segs = pts.slice(1).map((q, i) => ({ p: pts[i], q, i, len: Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]) }));
  /** @param {{p: number[], q: number[]}} s @param {number} t */
  const on = (s, t) => [s.p[0] + (s.q[0] - s.p[0]) * t, s.p[1] + (s.q[1] - s.p[1]) * t];
  const last = segs[segs.length - 1];
  if (last) out.push(on(last, 0.5));
  const byLength = [...segs].sort((a, b) => (b.len - a.len) || (a.i - b.i));
  /* Flush against either end as well as at fractions of the way: a run that
     is barely longer than the pill has exactly one place where the pill clears
     both the box at one end and the corridor at the other. */
  /** @param {{p: number[], q: number[], len: number}} s @returns {number[]} */
  const flush = s => {
    const half = Math.abs(s.q[0] - s.p[0]) >= Math.abs(s.q[1] - s.p[1]) ? ideal.w / 2 : ideal.h / 2;
    return s.len > half * 2 ? [(half + 2) / s.len, 1 - (half + 2) / s.len] : [];
  };
  for (const s of byLength) for (const t of [0.5, 0.3, 0.7, 0.15, 0.85, ...flush(s)]) out.push(on(s, t));
  for (const s of byLength) {
    const [mx, my] = on(s, 0.5);
    const flat = Math.abs(s.q[0] - s.p[0]) >= Math.abs(s.q[1] - s.p[1]);
    if (flat) out.push([mx, my - (ideal.h / 2 + BESIDE)], [mx, my + ideal.h / 2 + BESIDE]);
    else out.push([mx + ideal.w / 2 + BESIDE, my], [mx - (ideal.w / 2 + BESIDE), my]);
  }
  const dir = ideal.away || 1;
  for (let k = 1; k <= 6; k++)
    for (const d of [dir, -dir]) out.push([ideal.at[0], ideal.at[1] + d * k * (ideal.h + PAD)]);
  return out;
}

/* The first spot that costs nothing, else the cheapest, earlier winning a tie.
   `costOf` is told the best so far, so it can stop adding as soon as it is
   past it. */
/**
 * @param {number[][]} spots
 * @param {(at: number[], low: number) => number} costOf
 * @returns {number[]}
 */
function cheapest(spots, costOf) {
  let best = spots[0], low = Infinity;
  for (const at of spots) {
    const c = costOf(at, low);
    if (c === 0) return at;
    if (c < low) { low = c; best = at; }
  }
  return best;
}

/* The pass. `planned` is what planEdges routed; `stepFor` says which number
   rides on an edge's tag, since the tag is as wide as the number and the words
   together. Returns where every tag sits, and every callout placement in the
   shape drawCallout takes. */
/**
 * @param {{
 *   planned: Route[],
 *   boxes: Record<string, Box>,
 *   callouts?: Callout[],
 *   stepFor?: (r: Route) => number|null,
 * }} args
 * @returns {{tags: Map<string, PlacedTag>, callouts: CalloutPlace[]}}
 */
export function planFloating({ planned, boxes, callouts = [], stepFor = () => null }) {
  const obs = obstacles(boxes, planned);
  /* A callout on an edge lands its ball on the line at a point fixed by the
     route, whichever side its words go, so that point is known before any tag
     is placed and a tag must keep off it: the ball is drawn on top, and it
     lands in the middle of a word. A callout on a node lands on the node's
     face, which a tag already keeps off. */
  for (const c of callouts || []) {
    const tip = target(c, boxes, planned, 'below');
    if (tip && tip.kind === 'edge')
      obs.solids.push({ what: `the ball of callout ${c.id || ''}`, rect: grow({ x: tip.x, y: tip.y, w: 0, h: 0 }, DOT + 1) });
  }

  const items = planned
    .filter(r => r.e.label || stepFor(r) != null)
    .map(r => ({ r, ideal: tagBox(r, stepFor(r)) }))
    .sort((p, q) => (p.ideal.at[0] - q.ideal.at[0]) || (p.ideal.at[1] - q.ideal.at[1]));

  /** @type {Map<string, PlacedTag>} */
  const tags = new Map();
  for (const { r, ideal } of items) {
    const { w, h } = ideal;
    /** @param {number[]} at @returns {Rect} */
    const rect = at => ({ x: at[0] - w / 2, y: at[1] - h / 2, w, h });
    const at = cheapest(tagSpots(r, ideal), (at, low) => {
      const box = rect(at);
      let c = solidCost(grow(box, PAD / 2), obs.solids);
      if (c >= low) return c;
      /* A pill beside its line rather than on it is read as the label of
         whichever line is nearest, so another line as near as its own makes
         it ambiguous — which is worse than crossing that line from on top of
         its own. And a pill that has wandered off costs as much, every twenty
         pixels, as crossing a line. Touching, or a hair off, is free. */
      const own = standOff(box, r.pts);
      for (const wire of obs.wires) {
        if (wire.key === r.key) continue;
        if (wireCuts(wire.pts, grow(box, -1))) c += WIRE;
        else if (own > 0 && standOff(box, wire.pts) <= own + NEAR) c += WIRE * 1.5;
      }
      return c + Math.max(0, own - TOUCH) * WIRE / 20;
    });
    tags.set(r.key, { key: r.key, at, w, h });
    obs.solids.push({ what: `tag ${r.key}`, rect: grow(rect(at), PAD / 2), float: true });
  }

  /** @type {CalloutPlace[]} */
  const calls = [];
  for (const c of callouts || []) {
    /** @type {CalloutPlace[]} */
    const options = calloutCandidates(c, boxes, planned);
    if (!options.length) continue;
    let best = options[0], low = Infinity;
    for (const p of options) {
      let cost = solidCost(grow(p.box, TEXT_PAD), obs.solids);
      if (cost >= low) continue;
      cost += WIRE * onEdges(p, planned);
      /* A leader is drawn over everything, so one laid across a box strikes
         through it; across a pill or an arrowhead it is only one more line. */
      const lead = leaderNear(p);
      for (const s of obs.solids)
        if (lead.some(([x, y]) => x > s.rect.x && x < s.rect.x + s.rect.w && y > s.rect.y && y < s.rect.y + s.rect.h))
          cost += s.float || s.weight ? WIRE : SOLID;
      if (cost === 0) { best = p; break; }
      if (cost < low) { low = cost; best = p; }
    }
    calls.push(best);
    obs.solids.push({ what: `callout ${c.id || ''}`, rect: grow(best.box, PAD / 2), float: true });
  }

  return { tags, callouts: calls };
}
