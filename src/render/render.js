/* ============================================================
   spiega render — a spec becomes one SVG.

   Draw order is the whole trick: boundaries under everything, then edges, then
   nodes on top of the lines that touch them, then notes, which are stuck on
   last because that is what a note is.
   ============================================================ */

import { PAPER, INK, MUTED, ACCENT, PANEL, handFilter } from './theme.js';
import { roughRect, stroke, fill, text, hashSeed } from './ink.js';
import { drawNode, drawBoundary } from './glyphs.js';
import { drawEdge, planEdges, edgeKey } from './edges.js';
import { assign, layout, boundaryBox } from './layout.js';

/* Flow steps may name an edge ("gw>orders") and/or nodes to light. Numbering
   runs over the steps that name an edge, so the badges on the board match the
   numbers in the step list beside it. */
export function indexFlow(spec) {
  const stepOf = {};        // edge key -> step number
  const steps = spec.flow || [];
  let n = 0;
  steps.forEach((s, i) => {
    if (s.edge) { n++; stepOf[s.edge] = n; }
    s._n = s.edge ? n : null;
    s._i = i;
  });
  return { stepOf, steps };
}

/* What is lit, what is dimmed, at a given step. null = everything plain. */
function focusAt(spec, steps, active) {
  if (active == null || !steps[active]) return null;
  const s = steps[active];
  const nodes = new Set(s.lights || []);
  const edges = new Set();
  if (s.edge) {
    edges.add(s.edge);
    const [a, b] = s.edge.split('>');
    nodes.add(a); nodes.add(b);
  }
  return { nodes, edges };
}

export function renderSVG(spec, { active, placed = null, margin = 0, hand = true } = {}) {
  // A board carries its own highlighted step, so renderSVG(board) does the
  // right thing; pass `active` only to override it (null clears it).
  if (active === undefined) active = spec.active ?? null;
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const place = assign({ nodes, edges }, placed || {});
  const { boxes, width, height } = layout({ nodes, edges }, place);
  const { stepOf, steps } = indexFlow(spec);
  const focus = focusAt(spec, steps, active);

  const W = width + margin * 2, H = height + margin * 2;
  const k = Math.max(0.7, Math.min(2.2, Math.sqrt(W * H) / 760));

  let body = '';

  for (const b of spec.boundaries || []) {
    const bb = boundaryBox(b.members || [], boxes);
    if (bb) body += `<g data-boundary="${b.id}">${drawBoundary(b, bb)}</g>`;
  }

  const planned = planEdges(edges, boxes);
  for (const r of planned) {
    const state = !focus ? 'idle' : focus.edges.has(r.key) ? 'lit' : 'dim';
    const step = r.e.step != null ? r.e.step : (stepOf[r.key] ?? null);
    body += drawEdge(r, { step, state });
  }

  for (const n of nodes) {
    const box = boxes[n.id];
    if (!box) continue;
    // A note is an annotation, not part of the flow — it never dims, or the
    // one sentence explaining why a step matters fades out exactly when that
    // step is being explained.
    const state = !focus || n.kind === 'note' ? 'idle'
      : focus.nodes.has(n.id) ? 'lit' : 'dim';
    const halo = state === 'lit'
      ? stroke(roughRect(box.x - 8, box.y - 8, box.w + 16, box.h + 16, 16,
          { seed: hashSeed(n.id) % 9999, amp: 1.3, step: 30 }),
          { w: 2.4, color: ACCENT, opacity: 0.9, dash: '14 7' })
      : '';
    body += `<g class="node" data-node="${n.id}" opacity="${state === 'dim' ? 0.5 : 1}">` +
      halo + drawNode(n, box) + `</g>`;
  }

  // The wobble already lives in the path data (render/ink.js), so the filter is
  // only ever grain. On a live board that redraws while it animates, the grain
  // is cheaper as a CSS overlay — see board/board.html — so `hand` is off there.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    (hand ? `<defs>${handFilter(k)}</defs>` : '') +
    `<g${hand ? ' filter="url(#hand)"' : ''} transform="translate(${margin} ${margin})">${body}</g>` +
    `</svg>`;

  return { svg, width: W, height: H, boxes, place, steps, stepOf, planned };
}

export { edgeKey };
