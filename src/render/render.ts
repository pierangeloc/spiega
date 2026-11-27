/* ============================================================
   spiega render — a spec becomes one SVG.

   Draw order is the whole trick: boundaries under everything, then edges, then
   nodes on top of the lines that touch them, then notes, which are stuck on
   last because that is what a note is.
   ============================================================ */

import { PAPER, INK, MUTED, ACCENT, PANEL, handFilter } from './theme.js';
import { roughRect, stroke, fill, text, hashSeed, pillSize, tagLines } from './ink.js';
import { drawNode, drawBoundary, drawBoundaryCard, inkAt, inkSpan } from './glyphs.js';
import { drawEdge, planEdges, edgeKey } from './edges.js';
import type { Hop } from './edges.js';
import { drawCallout } from './callout.js';
import { planFloating } from './floating.js';
import { assign, layout, boundaryShapes, pieceNames, hopRow, HOP_AIR, HOP_END } from './layout.js';

import type { Board, Edge, FlowStep } from '@spiega/core';
import type { Placed } from './layout.js';

/* Where a boundary's card sits, in the corner-based form the drawing takes.
   The centre is what the placement pass works in; the card is drawn from its
   top-left corner. */
const tabRect = (t: { at: number[], w: number, h: number } | undefined): { x: number, y: number, w: number, h: number } | null => (t ? { x: t.at[0] - t.w / 2, y: t.at[1] - t.h / 2, w: t.w, h: t.h } : null);

/* Flow steps may name an edge ("gw>orders") and/or nodes to light. Numbering
   runs over the steps that name an edge, so the badges on the board match the
   numbers in the step list beside it. */
export function indexFlow(spec: { flow?: FlowStep[] }): { stepOf: Record<string, number>, steps: FlowStep[] } {
  const stepOf: Record<string, number> = {};        // edge key -> step number
  const steps = spec.flow || [];
  let n = 0;
  steps.forEach((s, i) => {
    if (s.edge) { n++; stepOf[s.edge] = n; }
    s._n = s.edge ? n : null;
    s._i = i;
  });
  return { stepOf, steps };
}

/* The tags one arrow carries, and which of them the walk is at (#113).

   An arrow with one hop carries one tag, numbered as it always was, and lights
   with the line. An arrow with several carries a tag per hop, and each is
   paired with the flow step it is: by number first, the step whose badge the
   hop already wears, and then in order, the first unpaired hop with the first
   unpaired step that names this arrow. A hop takes its badge from its step
   when it was given none of its own, and is lit only while the board is at
   that step — so walking 3, 5 and 7 lights three different pills on the one
   line, each saying its own words. */
function hopsOf(r: { e: Edge, key: string }, steps: FlowStep[], active: number | null,
  stepFor: (r: { e: Edge, key: string }) => number | null): Hop[] {
  const { e, key } = r;
  if (!e.then?.length) return [{ key, label: e.label, step: stepFor(r), lit: true }];
  const stops = [{ label: e.label, step: e.step }, ...e.then];
  const walk = steps.filter(s => s.edge === key);
  const pair: (FlowStep | undefined)[] = stops.map(() => undefined);
  const taken = new Set<FlowStep>();
  stops.forEach((s, i) => {
    const hit = s.step == null ? undefined : walk.find(f => !taken.has(f) && f._n === s.step);
    if (hit) { pair[i] = hit; taken.add(hit); }
  });
  stops.forEach((_, i) => {
    if (pair[i]) return;
    const next = walk.find(f => !taken.has(f));
    if (next) { pair[i] = next; taken.add(next); }
  });
  const hops = stops.map((s, i) => ({
    key: i ? `${key}#${i + 1}` : key,
    label: s.label,
    step: s.step !== undefined ? s.step : (pair[i]?._n ?? null),
    lit: active != null && pair[i]?._i === active,
  }));
  /* Each hop wants the stretch of the route its share of the row of pills
     covers, so a long label is not squeezed against a short one: the gutter
     was sized for the row (layout.js), and this is the same row laid along
     the line. */
  const ws = hops.map(h => pillSize(tagLines(h.label, h.step)).w);
  const total = hopRow(ws);
  let run = HOP_END;
  return hops.map((h, i) => {
    const along = (run + ws[i] / 2) / total;
    run += ws[i] + HOP_AIR;
    return { ...h, along };
  });
}

/* What one step lights: its own hop, both ends of it, and anything it names. */
function lightsOf(s: FlowStep): { nodes: Set<string>, edges: Set<string> } {
  const nodes = new Set<string>(s.lights || []);
  const edges = new Set<string>();
  if (s.edge) {
    edges.add(s.edge);
    const [a, b] = s.edge.split('>');
    nodes.add(a); nodes.add(b);
  }
  return { nodes, edges };
}

/* What is lit, what is context, and what is dimmed, at a given step.
   null = everything plain.

   Three tiers, but not three opacities — that was the worry in #54 and it is
   the wrong way to read it. There are two independent things to say, and they
   use different means:

     opacity   says whether a thing is part of the phase being explained
     orange    says which single hop is happening now

   So a node or an edge that belongs to the active step's phase, but is not the
   step itself, is drawn exactly as it is drawn on a board with no step lit at
   all: full strength, no halo, no accent. It is not a middle state; it is the
   board's ordinary state, and what moves is everything around it. A reader
   sees the phase standing clear of the rest of the drawing, and within it one
   arrow coloured in.

   `context` is empty when the active step names no phase, which makes a
   grouped board behave exactly as an ungrouped one until somebody groups
   something. */
type Focus = { nodes: Set<string>, edges: Set<string>, context: { nodes: Set<string>, edges: Set<string> } };
function focusAt(steps: FlowStep[], active: number | null): Focus | null {
  if (active == null) return null;
  const s = steps[active];
  if (!s) return null;
  const { nodes, edges } = lightsOf(s);
  const cn = new Set<string>();
  const ce = new Set<string>();
  if (s.group) {
    for (const peer of steps) {
      if (peer === s || peer.group !== s.group) continue;
      const also = lightsOf(peer);
      for (const id of also.nodes) if (!nodes.has(id)) cn.add(id);
      for (const key of also.edges) if (!edges.has(key)) ce.add(key);
    }
  }
  return { nodes, edges, context: { nodes: cn, edges: ce } };
}

/* Which way a field's notch points.

   The notch is on the side the value runs: a field that gives a value notches
   right, towards whatever it feeds, and a field that only receives one notches
   left, back towards whatever it came from. On a mapping board that mirrors
   the two sides against each other, so the reader tells source from target by
   the shape rather than by a colour.

   The flow decides it, not the column: a column says where a box sits, and
   not which way its value went. A node may be given the other side with a
   `notch` field, for the board where the flow says nothing — a lone field
   with no edges at all, which is not a side of anything. */
function notchSides(nodes: Board['nodes'], edges: Board['edges']): Record<string, 'left' | 'right'> {
  const ends: Record<string, { in: number, out: number }> = {};
  for (const n of nodes) ends[n.id] = { in: 0, out: 0 };
  for (const e of edges) {
    if (ends[e.from]) ends[e.from].out++;
    if (ends[e.to]) ends[e.to].in++;
  }
  const out: Record<string, 'left' | 'right'> = {};
  for (const n of nodes) {
    const { in: i, out: o } = ends[n.id];
    out[n.id] = n.notch === 'left' || n.notch === 'right' ? n.notch
      : o > 0 ? 'right' : i > 0 ? 'left' : 'right';
  }
  return out;
}

export function renderSVG(
  spec: Board,
  { active, placed = null, margin = 0, hand = true }: {
    active?: number | null,
    placed?: Placed | null,
    margin?: number,
    hand?: boolean,
  } = {},
) {
  // A board carries its own highlighted step, so renderSVG(board) does the
  // right thing; pass `active` only to override it (null clears it).
  if (active === undefined) active = spec.active ?? null;
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const place = assign({ nodes, edges }, placed || {});
  const { stepOf, steps } = indexFlow(spec);
  const stepFor = (r: { e: Edge, key: string }): number | null => (r.e.step != null ? r.e.step : (stepOf[r.key] ?? null));
  // the gutters are sized for the tags that cross them, step numbers included
  const { boxes, lanes, width, height } = layout({ nodes, edges, boundaries: spec.boundaries }, place, e => stepFor({ e, key: edgeKey(e) }));
  const focus = focusAt(steps, active);
  const notches = notchSides(nodes, edges);

  /* Everything that floats is placed before the canvas is sized, in one pass
     against one set of obstacles (render/floating.js): a boundary's tab, tags
     and callouts resolved against each other, the boxes, the notes and the
     routed lines, or two edges leaving the same box land their pills on the
     same spot and a callout prints across a neighbour's name. A label can end
     up outside the nodes' bounds and would otherwise be cropped, so whatever
     falls past an edge becomes extra canvas, and content shifts to make room. */
  /* Edges route to a box, and a box has no outline. A convex glyph's ink
     leaves the box everywhere but the points where it touches, so a line
     aimed at the box stops short of the ink unless the box can say how far.
     The glyph declares that; edges stay geometry and ask. A rectangle
     declares nothing, and its lines do not move. */
  for (const n of nodes) {
    const box = boxes[n.id];
    if (box) {
      box.inkAt = (side, along) => inkAt(n, box, side, along);
      box.inkSpan = side => inkSpan(n, box, side);
    }
  }
  const planned = planEdges(edges, boxes, lanes);
  /* The rectangles a boundary is drawn as, and the cards that carry its name.
     A boundary that cannot be one true rectangle is drawn as several, and each
     piece carries its own card, and the card says which piece it is. */
  const boundaries = (spec.boundaries || [])
    .map(b => ({ ...b, shapes: boundaryShapes(b.members || [], boxes) }))
    .filter(b => b.shapes.length)
    .map(b => ({ ...b, names: pieceNames(b.label, b.shapes) }));
  const hopsFor = (r: { e: Edge, key: string }) => hopsOf(r, steps, active ?? null, stepFor);
  const { tags, tabs, callouts: calls } = planFloating({
    planned, boxes, callouts: spec.callouts, boundaries, stepFor, hopsFor });
  const floats = [...calls.map(p => p.box),
    ...[...tags.values()].map(t => ({ x: t.at[0] - t.w / 2, y: t.at[1] - t.h / 2, w: t.w, h: t.h })),
    ...[...tabs.values()].map(t => ({ x: t.at[0] - t.w / 2, y: t.at[1] - t.h / 2, w: t.w, h: t.h }))];
  let padL = 0, padT = 0, extraR = 0, extraB = 0;
  for (const b of floats) {
    padL = Math.max(padL, -(b.x - 10));
    padT = Math.max(padT, -(b.y - 10));
    extraR = Math.max(extraR, b.x + b.w + 10 - width);
    extraB = Math.max(extraB, b.y + b.h + 10 - height);
  }
  padL = Math.max(0, padL); padT = Math.max(0, padT);
  const W = width + padL + Math.max(0, extraR) + margin * 2;
  const H = height + padT + Math.max(0, extraB) + margin * 2;
  const k = Math.max(0.7, Math.min(2.2, Math.sqrt(W * H) / 760));

  let body = '';

  /* Every enclosure first, and the cards that name them after. A card is a
     label, and a label goes above the structure: a dashed wall drawn over a
     card strikes the name through it, which is the same failure as a card
     drawn over a card (#87). */
  for (const b of boundaries)
    body += `<g data-boundary="${b.id}">${b.shapes.map(bb => drawBoundary(b, bb)).join('')}</g>`;
  for (const b of boundaries)
    body += `<g data-boundary="${b.id}">` +
      b.shapes.map((bb, i) => drawBoundaryCard(b, bb, tabRect(tabs.get(`${b.id}#${i}`)), b.names[i])).join('') +
      `</g>`;

  for (const r of planned) {
    /* In the phase but not the step: drawn as it is on a board with nothing
       lit, which is what makes the phase read as a region rather than as a
       third shade of grey. */
    const state = !focus ? 'idle'
      : focus.edges.has(r.key) ? 'lit'
      : focus.context.edges.has(r.key) ? 'idle' : 'dim';
    const hops = r.e.then?.length ? hopsFor(r).map(h => ({ ...h, at: tags.get(h.key)?.at || null })) : null;
    body += drawEdge(r, { step: stepFor(r), state, place: tags.get(r.key)?.at || null, hops });
  }

  for (const n of nodes) {
    const box = boxes[n.id];
    if (!box) continue;
    // A note is an annotation, not part of the flow — it never dims, or the
    // one sentence explaining why a step matters fades out exactly when that
    // step is being explained.
    const state = !focus || n.kind === 'note' ? 'idle'
      : focus.nodes.has(n.id) ? 'lit'
      : focus.context.nodes.has(n.id) ? 'idle' : 'dim';
    const halo = state === 'lit'
      ? stroke(roughRect(box.x - 8, box.y - 8, box.w + 16, box.h + 16, 16,
          { seed: hashSeed(n.id) % 9999, amp: 1.3, step: 30 }),
          { w: 2.4, color: ACCENT, opacity: 0.9, dash: '14 7' })
      : '';
    body += `<g class="node" data-node="${n.id}" opacity="${state === 'dim' ? 0.5 : 1}">` +
      halo + drawNode(n, box, notches[n.id]) + `</g>`;
  }

  // The wobble already lives in the path data (render/ink.js), so the filter is
  // only ever grain. On a live board that redraws while it animates, the grain
  // is cheaper as a CSS overlay — see packages/board/board.css — so `hand` is off there.
  for (const p of calls) {
    const key = String(p.c.at || '');
    const state = !focus ? 'idle'
      : (focus.edges.has(key) || focus.nodes.has(key)) ? 'lit'
      : (focus.context.edges.has(key) || focus.context.nodes.has(key)) ? 'idle' : 'dim';
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

  return { svg, width: W, height: H, boxes, offset, place, steps, stepOf, planned, tags, tabs, callouts: calls };
}

export { edgeKey };
