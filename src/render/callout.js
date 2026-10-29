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
   to put the label. Position stays derived, which is most of why boards here
   do not come out a mess.
   ============================================================ */

import { roughLine, stroke, fill, text, waver, smooth, wrapText } from './ink.js';
import { INK, ACCENT, MUTED } from './theme.js';

const LEAD = 52;          // how far the label sits from the point
const LINE = 15;          // line height of the label
const CHAR = 6.6;         // advance at the label's size, for the box

/* Where the leader points, and from which direction. A node is aimed at the
   middle of one of its sides; an edge at the middle of its longest segment,
   offset from the middle, where its own label already sits. */
function target(c, boxes, planned) {
  const at = String(c.at || '');

  const r = planned.find(p => p.key === at);
  if (r && r.pts && r.pts.length > 1) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [p, q] = [r.pts[i], r.pts[i + 1]];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > bestLen) { bestLen = l; best = i; }
    }
    /* A third of the way along, not the middle: the middle of the longest
       segment is exactly where the edge's own label sits, so aiming there put
       the leader line through the tag it was meant to annotate. */
    const [p, q] = [r.pts[best], r.pts[best + 1]];
    return { x: p[0] + (q[0] - p[0]) * 0.3, y: p[1] + (q[1] - p[1]) * 0.3, kind: 'edge' };
  }

  const b = boxes[at];
  if (!b) return null;
  const side = c.side || 'below';
  if (side === 'above') return { x: b.x + b.w / 2, y: b.y, kind: 'node' };
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2, kind: 'node' };
  if (side === 'right') return { x: b.x + b.w, y: b.y + b.h / 2, kind: 'node' };
  return { x: b.x + b.w / 2, y: b.y + b.h, kind: 'node' };
}

/* Everything a callout needs, including the box it occupies — the caller has
   to grow the canvas to fit labels that fall outside the nodes' bounds. */
export function planCallouts(callouts, boxes, planned) {
  return (callouts || []).map(c => {
    const tip = target(c, boxes, planned);
    if (!tip) return null;

    const side = c.side || 'below';
    const lines = wrapText(String(c.label || ''), c.wrap || 22, 4);
    const w = Math.max(...lines.map(l => l.length)) * CHAR;
    const h = lines.length * LINE;

    const dir = { above: [0, -1], below: [0, 1], left: [-1, 0], right: [1, 0] }[side] || [0, 1];
    const cx = tip.x + dir[0] * (LEAD + w / 2);
    const cy = tip.y + dir[1] * (LEAD + h / 2);

    return {
      c, tip, side, lines, w, h, cx, cy,
      box: { x: cx - w / 2, y: cy - h / 2, w, h },
    };
  }).filter(Boolean);
}

/* A leader line, a mark where it lands, and the words.

   The line wavers like every other line on the board, and it is the accent
   colour: a callout is an aside, and it should be findable without being
   mistaken for part of the structure. */
export function drawCallout(p, { state = 'idle' } = {}) {
  const { tip, lines, cx, cy, h, side } = p;
  const seed = (p.c.id || '').split('').reduce((a, ch) => a + ch.charCodeAt(0), 7);

  // start the line at the edge of the text block nearest the point
  const dir = { above: [0, 1], below: [0, -1], left: [1, 0], right: [-1, 0] }[side] || [0, -1];
  const from = [cx + dir[0] * (p.w / 2 + 6), cy + dir[1] * (h / 2 + 6)];
  const mid = [(from[0] + tip.x) / 2 + dir[1] * 7, (from[1] + tip.y) / 2 + dir[0] * 7];
  const lead = waver([from, mid, [tip.x, tip.y]], { seed, amp: 1.1, step: 9 });

  const dim = state === 'dim' ? 0.45 : 1;
  const top = cy - h / 2 + 11;

  return `<g data-callout="${p.c.id}" opacity="${dim}">` +
    stroke(smooth(lead, false), { w: 1.5, color: ACCENT }) +
    fill(`M${tip.x.toFixed(1)} ${tip.y.toFixed(1)} m-4 -4 l8 0 l-4 8 z`, ACCENT) +
    lines.map((ln, i) =>
      text(cx, top + i * LINE, ln, { size: 11.5, color: INK, weight: 600, spacing: 0.02 })
    ).join('') +
    `</g>`;
}
