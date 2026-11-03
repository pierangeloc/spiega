/* ============================================================
   Callouts: a label joined to a point by a leader line.

   Every other label on this board is attached to the thing it names — inside
   a box, or riding on an edge. That leaves no way to say something *about* a
   thing without crowding it, so the caveat ends up either stuffed into an
   edge label ("gRPC, retried 3 times, then dead-lettered") or exiled to a
   margin note that points at nothing.

   This is the device a textbook figure uses for the same reason: the word
   sits in clear space and a thin line says what it is about.

   It deliberately takes no coordinates. `at` names something the board
   already knows — a node, or an edge as `from>to` — and a side says which way
   to put the label: one of the four faces, or one of the four corners. Position stays derived, which is most of why boards here
   do not come out a mess.
   ============================================================ */

import { roughLine, stroke, fill, text, waver, smooth, wrapText } from './ink.js';
import { INK, ACCENT, MUTED } from './theme.js';

const LEAD = 52;          // how far the label sits from the point
const LINE = 15;          // line height of the label
const CHAR = 6.6;         // advance at the label's size, for the box
const DOT = 4;            // radius of the ball the leader ends in

/* The four faces keep the names boards already use. The corners are named the
   same way, and the compass letters are accepted for all eight because that is
   what people reach for; they are aliases and resolve to the long names. A
   diagonal is a unit vector like the rest, so LEAD is the same distance out
   whichever way a label goes. */
const D = Math.SQRT1_2;
const DIRS = {
  above: [0, -1], below: [0, 1], left: [-1, 0], right: [1, 0],
  'above-left': [-D, -D], 'above-right': [D, -D], 'below-left': [-D, D], 'below-right': [D, D],
};
const ALIASES = {
  n: 'above', s: 'below', e: 'right', w: 'left',
  nw: 'above-left', ne: 'above-right', sw: 'below-left', se: 'below-right',
};
export const sideName = s => {
  const k = String(s);
  if (Object.hasOwn(DIRS, k)) return k;
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : null;
};

/* Where the leader points, and from which direction. A node is aimed at the
   middle of one of its sides; an edge at the middle of its longest segment,
   offset from the middle, where its own label already sits. */
function target(c, boxes, planned, side) {
  const at = String(c.at || '');

  const r = planned.find(p => p.key === at);
  if (r && r.pts && r.pts.length > 1) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [p, q] = [r.pts[i], r.pts[i + 1]];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > bestLen) { bestLen = l; best = i; }
    }
    /* Not the middle: the middle of the longest segment is exactly where the
       edge's own label sits, so aiming there put the leader line through the
       tag it was meant to annotate. A third of the way along clears it on a
       long run; on a short hop between neighbouring columns the tag is nearly
       as wide as the segment, so the aim moves nearer the start. */
    const [p, q] = [r.pts[best], r.pts[best + 1]];
    const t = bestLen > 220 ? 0.3 : 0.18;
    return { x: p[0] + (q[0] - p[0]) * t, y: p[1] + (q[1] - p[1]) * t, kind: 'edge' };
  }

  const b = boxes[at];
  if (!b) return null;
  /* Where on the box: the middle of the face it faces, or for a diagonal the
     corner it faces. */
  const [dx, dy] = DIRS[side];
  return {
    x: dx < 0 ? b.x : dx > 0 ? b.x + b.w : b.x + b.w / 2,
    y: dy < 0 ? b.y : dy > 0 ? b.y + b.h : b.y + b.h / 2,
    kind: 'node',
  };
}

/* Where one side puts a callout: its target, its text, and the box the text
   occupies. The words sit so that their nearest point is LEAD from the target,
   on a face or a corner alike. `slide` moves them along a face, so the leader
   comes in on a slant instead of straight. */
function place(c, boxes, planned, side, slide = 0) {
  const tip = target(c, boxes, planned, side);
  if (!tip) return null;

  const lines = wrapText(String(c.label || ''), c.wrap || 22, 4);
  const w = Math.max(...lines.map(l => l.length)) * CHAR;
  const h = lines.length * LINE;

  const dir = DIRS[side];
  const cx = tip.x + dir[0] * LEAD + Math.sign(dir[0]) * w / 2 + (dir[0] ? 0 : slide);
  const cy = tip.y + dir[1] * LEAD + Math.sign(dir[1]) * h / 2 + (dir[0] ? slide : 0);

  return {
    c, tip, side, lines, w, h, cx, cy,
    box: { x: cx - w / 2, y: cy - h / 2, w, h },
  };
}

/* The three points the leader is drawn through: out of the text block nearest
   the point, bowed a little in the middle, and into the point. */
function leaderPts(p) {
  const { tip, cx, cy, h, side } = p;
  const dir = DIRS[side].map(v => -Math.sign(v));
  const from = [cx + dir[0] * (p.w / 2 + 6), cy + dir[1] * (h / 2 + 6)];
  /* The bow is across the line, whichever way it runs. */
  const bow = dir[0] && dir[1] ? [dir[1] * 7 * D, -dir[0] * 7 * D] : [dir[1] * 7, dir[0] * 7];
  const mid = [(from[0] + tip.x) / 2 + bow[0], (from[1] + tip.y) / 2 + bow[1]];
  return [from, mid, [tip.x, tip.y]];
}

/* Walk a polyline in steps of about `step`, yielding the points on it. */
function* along(pts, step = 3) {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k <= n; k++) yield [x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n];
  }
}

const TEXT_PAD = 4;       // how near a routed line may come to the words
const LEAD_CLEAR = 6;     // how near one may run beside the leader
const TIP_SKIP = 18;      // the leader ends where a node's own edges begin, so its last stretch is exempt

/* Does this placement sit on a routed line? Both halves are asked, because the
   words and the leader are separate ways to be read as part of an edge: a line
   through a word, and a leader that runs alongside a line of another meaning
   down the same corridor. A leader necessarily meets the thing it points at,
   and a node's own edges start a few pixels from its side, so the last
   stretch before the point is not held against it. */
function onAnEdge(p, planned) {
  const { x, y, w, h } = p.box;
  const lead = leaderPts(p);
  const near = [...along(lead, 2)].filter(([px, py]) => Math.hypot(px - p.tip.x, py - p.tip.y) > TIP_SKIP);
  for (const r of planned) {
    if (!r.pts || r.pts.length < 2) continue;
    for (const [px, py] of along(r.pts)) {
      if (px > x - TEXT_PAD && px < x + w + TEXT_PAD && py > y - TEXT_PAD && py < y + h + TEXT_PAD) return true;
      if (near.some(([qx, qy]) => Math.hypot(px - qx, py - qy) < LEAD_CLEAR)) return true;
    }
  }
  return false;
}

/* Landing on a node is as bad as landing on an edge, so a side tried in place
   of the one asked for is also held to being clear of every box. The side
   asked for is not: it stays where it is whatever stands there, so a board
   that is fine today does not move. */
function onANode(p, boxes) {
  const { x, y, w, h } = p.box;
  const lead = [...along(leaderPts(p), 2)];
  return Object.values(boxes).some(b =>
    (x < b.x + b.w + TEXT_PAD && x + w > b.x - TEXT_PAD && y < b.y + b.h + (b.labelBelow || 0) + TEXT_PAD && y + h > b.y - TEXT_PAD) ||
    lead.some(([qx, qy]) => Math.hypot(qx - p.tip.x, qy - p.tip.y) > TIP_SKIP
      && qx > b.x && qx < b.x + b.w && qy > b.y && qy < b.y + b.h + (b.labelBelow || 0)));
}

/* The side asked for is a preference, not a command: keep it when it is
   clear, otherwise take the first of these that is, and when none is, keep
   what was asked for rather than guess at something worse. The order is fixed
   and does not depend on the other callouts, so adding one does not move the
   rest: the four faces in the order below, above, right, left, then the four
   corners in the order below-right, below-left, above-right, above-left. */
const SIDES = ['below', 'above', 'right', 'left', 'below-right', 'below-left', 'above-right', 'above-left'];

/* A node with an edge leaving the very side a callout is aimed at has no clear
   straight way in: the leader and the edge start at the same point and run the
   same way. When no side is clear straight, the words slide along theirs, so
   the leader leaves on a slant, away from the line. Every side is tried
   straight before any is tried slid. */
const SLIDES = [0, 40, -40];

/* Everything a callout needs, including the box it occupies — the caller has
   to grow the canvas to fit labels that fall outside the nodes' bounds. */
export function planCallouts(callouts, boxes, planned) {
  return (callouts || []).map(c => {
    const side = sideName(c.side) || 'below';
    const asked = place(c, boxes, planned, side);
    if (!asked) return null;
    if (!onAnEdge(asked, planned)) return asked;
    for (const slide of SLIDES) {
      for (const s of [side, ...SIDES.filter(s => s !== side)]) {
        if (s === side && !slide) continue;
        if (slide && DIRS[s][0] && DIRS[s][1]) continue;   // a corner is already on a slant
        const p = place(c, boxes, planned, s, slide);
        if (p && !onAnEdge(p, planned) && !onANode(p, boxes)) return p;
      }
    }
    return asked;
  }).filter(Boolean);
}

/* A leader line, a dot where it lands, and the words. The mark is a ball
   because a ball has no direction: the wedge it replaced was one fixed shape,
   so it pointed the same way whichever side the leader came from, and on most
   of them it read as an arrowhead aimed the wrong way.

   The line wavers like every other line on the board, and it is the accent
   colour: a callout is an aside, and it should be findable without being
   mistaken for part of the structure. */
export function drawCallout(p, { state = 'idle' } = {}) {
  const { tip, lines, cx, cy, h } = p;
  const seed = (p.c.id || '').split('').reduce((a, ch) => a + ch.charCodeAt(0), 7);

  const lead = waver(leaderPts(p), { seed, amp: 1.1, step: 9 });

  const dim = state === 'dim' ? 0.45 : 1;
  const top = cy - h / 2 + 11;

  return `<g data-callout="${p.c.id}" opacity="${dim}">` +
    stroke(smooth(lead, false), { w: 1.5, color: ACCENT }) +
    fill(`M${(tip.x - DOT).toFixed(1)} ${tip.y.toFixed(1)} a${DOT} ${DOT} 0 1 0 ${DOT * 2} 0 a${DOT} ${DOT} 0 1 0 ${-DOT * 2} 0z`, ACCENT) +
    lines.map((ln, i) =>
      text(cx, top + i * LINE, ln, { size: 11.5, color: INK, weight: 600, spacing: 0.02 })
    ).join('') +
    `</g>`;
}
