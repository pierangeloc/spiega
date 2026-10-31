// @ts-check
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
import { planCallouts, drawCallout } from './callout.js';
import { assign, layout, boundaryBox } from './layout.js';

/** @typedef {import('../board/state.js').Board} Board */
/** @typedef {import('../board/state.js').FlowStep} FlowStep */
/** @typedef {import('./layout.js').Placed} Placed */

/* Flow steps may name an edge ("gw>orders") and/or nodes to light. Numbering
   runs over the steps that name an edge, so the badges on the board match the
   numbers in the step list beside it. */
/**
 * @param {{flow?: FlowStep[]}} spec
 * @returns {{stepOf: Record<string, number>, steps: FlowStep[]}}
 */
export function indexFlow(spec) {
  /** @type {Record<string, number>} */
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
/**
 * @param {Board} spec
 * @param {FlowStep[]} steps
 * @param {number|null} active
 * @returns {{nodes: Set<string>, edges: Set<string>}|null}
 */
function focusAt(spec, steps, active) {
  if (active == null || !steps[active]) return null;
  const s = steps[active];
  /** @type {Set<string>} */
  const nodes = new Set(s.lights || []);
  /** @type {Set<string>} */
  const edges = new Set();
  if (s.edge) {
    edges.add(s.edge);
    const [a, b] = s.edge.split('>');
    nodes.add(a); nodes.add(b);
  }
  return { nodes, edges };
}

/**
 * @param {Board} spec
 * @param {{
 *   active?: number|null,
 *   placed?: Placed|null,
 *   margin?: number,
 *   hand?: boolean
 * }} [options]
 */
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

  /* Callouts are planned before the canvas is sized, because a label can sit
     outside the nodes' bounds and would otherwise be cropped. Whatever falls
     past an edge becomes extra canvas, and content shifts to make room. */
  const calls = planCallouts(spec.callouts, boxes, planEdges(edges, boxes));
  let padL = 0, padT = 0, extraR = 0, extraB = 0;
  for (const p of calls) {
    padL = Math.max(padL, -(p.box.x - 10));
    padT = Math.max(padT, -(p.box.y - 10));
    extraR = Math.max(extraR, p.box.x + p.box.w + 10 - width);
    extraB = Math.max(extraB, p.box.y + p.box.h + 10 - height);
  }
  padL = Math.max(0, padL); padT = Math.max(0, padT);
  const W = width + padL + Math.max(0, extraR) + margin * 2;
  const H = height + padT + Math.max(0, extraB) + margin * 2;
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
  for (const p of calls) {
    const key = String(p.c.at || '');
    const state = !focus ? 'idle'
      : (focus.edges.has(key) || focus.nodes.has(key)) ? 'lit' : 'dim';
    body += drawCallout(p, { state });
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    (hand ? `<defs>${handFilter(k)}</defs>` : '') +
    `<g${hand ? ' filter="url(#hand)"' : ''} transform="translate(${margin + padL} ${margin + padT})">${body}</g>` +
    `</svg>`;

  /* `boxes` are layout coordinates; the drawing is shifted by this much to
     make room for the margin and for callouts that overflow the top left. A
     caller aiming a camera at a box needs both. */
  const offset = { x: margin + padL, y: margin + padT };

  return { svg, width: W, height: H, boxes, offset, place, steps, stepOf, planned, callouts: calls };
}

export { edgeKey };
