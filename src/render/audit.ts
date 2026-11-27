/* ============================================================
   spiega audit — what the drawing came out like, measured on the drawing.

   An agent draws a board it never sees. Everything it learns back is the one
   line POST /op answers with, and until now that line was three counts: so
   many boxes, so many lines, so many steps. True, and no use at all — they
   say the ops were accepted, not that the picture works. The board in #48 had
   seven labels stacked in the gutter they label and an arrow running under a
   note, and `board_draw` returned `14 boxes, 17 lines`. A person found it by
   looking at the pane.

   This is the measurement that rides back instead (#56). Three things, in the
   order they cost a reader:

   - text that could not be placed clear: a label or a callout printed over
     words, over a note, or hidden under a box it is painted beneath. This
     half came from test/readable.mjs and is measured from the SVG rather than
     from the planner's boxes — a check that reused the planner's own idea of
     where things went would agree with the planner by construction, including
     about everything the planner gets wrong.
   - an arrow through a box that is not an end of it. The line enters one box
     and leaves another, so it reads as an edge between the wrong two (#49).
   - crossings, as one number, so a board going from two to nineteen is
     visible.

   Two more ride back as warnings rather than as the report, because they are
   about what the reader will be able to make out, not about what printed over
   what: a board so wide it can only be shown at a size its lettering cannot be
   read at (#209), and an arrow that runs close enough past a box it has
   nothing to do with to read as touching it (#216).

   It reports; it never refuses. The board is live and somebody is mid-
   sentence, so a refused op is a box that never appears, which is worse than
   a crowded one. And it is a measurement of the drawing, not a verdict on the
   explanation: "two arrows cross a box that is not an end of it" is a fact,
   where "this board is unreadable" is not something that can be computed.

   Browser-safe, like everything else under src/render: no node builtins, no
   bare specifiers. See AGENTS.md.
   ============================================================ */

import type { Pt } from './ink.js';

type Rect = { x: number, y: number, w: number, h: number };
type Route = { key: string, pts: Pt[] };
/* What a rendered board hands over that the audit reads: renderSVG's result,
   less everything the audit has no use for. */
type Drawn = {
  svg: string, width: number, height: number,
  offset: { x: number, y: number }, boxes: Record<string, Rect>, planned: Route[],
};
type Astray = { kind: 'tag' | 'callout' | 'tab', text: string, on: string };
type Buried = { edge: string, box: string };
type Grazed = { edge: string, box: string, gap: number, side: 'above' | 'below' | 'left of' | 'right of' | 'along the rim of' };
type Small = { fit: number, px: number };
/* A drawn pill or card, with the words found on it. */
type Words = Rect & { text: string };

/* Monospace advance. The board's faces (SF Mono, Menlo, Consolas) are all
   about 0.6 em; letter-spacing is added per character on top. */
const ADVANCE = 0.6;
/* Two boxes touching at a hairline are not one word on another. */
const SLACK = 1;
/* The outer 6px of a box is where its ink wavers, so a line grazing the rim
   is drawn beside the box rather than through it. */
const INSET = 6;
/* A polyline is sampled this often. Fine enough that a 12px box on a diagonal
   cannot be stepped over. */
const STEP = 2;
/* Below this, crossings are what a board of any size costs: every committed
   example and every board in test/boards sits at two or fewer. Saying "1 line
   crossing" after every batch teaches an agent to skip the whole line. */
export const CROSSINGS_FLOOR = 4;
/* How many crossed boxes are named before the rest become a count. A report
   longer than the explanation it interrupts does not get read. */
const NAMED = 4;

/* The screen a board is assumed to be read on (#209). Nothing on a board is
   drawn small — its lettering is a constant in board units — but the page fits
   the whole board into its pane, so a wide board is shown shrunk, and its
   words with it. How far depends on a screen the server never sees, so the
   arithmetic needs one written down: 1440×900, a laptop's usable window and
   the size these boards are mostly read at, often as one pane of a split.

   What it costs when it is wrong: on a bigger screen the board is shown larger
   than this says, so the warning comes early and names a size the reader is
   not actually suffering; on a smaller one, or a narrower pane, it comes late
   and the real size is worse than the one named. Either way the board is
   drawn exactly as before — this only decides when the agent hears about it. */
export const REFERENCE_VIEW = { w: 1440, h: 900 };
/* Lettering on a screen below this is deciphered rather than read. Measured
   against the largest lettering on any box, which is a box's name, so when
   that is under it everything else on the board — the line labels at 10.5,
   the subs at 10 — is further under it still. */
export const TEXT_FLOOR = 12;
/* How close a line may run past a box that is neither of its ends before it
   reads as touching it (#216). A lit line is 3px of ink and a box's outline
   wavers by a pixel or two, so at 2 units apart the two strokes meet; at 10
   there is a clear stripe of paper between them even with the line lit and the
   box dimmed. Every committed board either sits at 2 — the one that was
   reported — or clears the nearest box it passes by 22 or more.

   What it costs when it is wrong: too high and the agent is told about lanes a
   reader can see are clear, which teaches it to skip the line; too low and a
   line that reads as ending at a box it never meant goes unreported, which is
   the silence this exists to end. */
export const CLEARANCE = 10;

const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (s: string, k: string): string | null => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : null; };

function textBox(attrs: string, body: string, dx: number, dy: number): Rect {
  const x = Number(attr(attrs, 'x')) + dx, y = Number(attr(attrs, 'y')) + dy;
  const size = Number(attr(attrs, 'font-size'));
  const spacing = parseFloat(attr(attrs, 'letter-spacing') || '0');
  const w = [...unescape(body)].length * size * (ADVANCE + spacing);
  const anchor = attr(attrs, 'text-anchor') || 'start';
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return { x: x0, y: y - size * 0.75, w, h: size * 0.95 };
}

function pathBox(d: string, dx: number, dy: number): Rect {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs) + dx, y0 = Math.min(...ys) + dy;
  return { x: x0, y: y0, w: Math.max(...xs) + dx - x0, h: Math.max(...ys) + dy - y0 };
}

/* Walk the drawing once, keeping the stack of groups open at each element so
   every word and every pill knows what it belongs to. Only translations are
   followed: the one rotation on the board is a note's tilt, and a note is
   measured by its card. */
export function measureDrawing(svg: string) {
  type Group = { attrs: string, dx: number, dy: number, fills: Words[] };
  const stack: Group[] = [];
  const nodeText: (Rect & { id: string, text: string, size: number })[] = [];
  /* Keyed by the tag's own group, like a callout: an arrow carrying several
     hops (#113) has a pill per hop, all under the one `data-edge`, and keyed
     by the edge they would be measured as one pill holding all their words. */
  const tags = new Map<Group, Words & { key: string }>();
  const callouts = new Map<Group, Words>();
  const balls: Rect[] = [];
  const tabs: Words[] = [];
  const named = (k: string): string | undefined =>
    stack.map(g => attr(g.attrs, k)).find((v): v is string => !!v);
  // an attribute may hold a `>`: every edge is named `from>to`
  const re = /<(\/?)(g|text|path)\b((?:[^>"]|"[^"]*")*?)\/?>([^<]*)/g;
  for (const m of svg.matchAll(re)) {
    const [, close, tag, attrs, body] = m;
    if (tag === 'g') {
      if (close) { stack.pop(); continue; }
      const t = (attr(attrs, 'transform') || '').match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/);
      stack.push({ attrs, dx: t ? Number(t[1]) : 0, dy: t ? Number(t[2]) : 0, fills: [] });
      continue;
    }
    if (close) continue;
    const dx = stack.reduce((s, g) => s + g.dx, 0), dy = stack.reduce((s, g) => s + g.dy, 0);
    const nodeId = named('data-node');
    const edgeId = named('data-edge');
    const inTag = stack.find(g => attr(g.attrs, 'class') === 'tag');
    const call = stack.find(g => attr(g.attrs, 'data-callout') != null);
    /* A boundary's name rides a card. The card is what is measured, and it is
       measured by the card and not by its words: a card over a card hides the
       name under it, and the words alone would not show that.

       The card is the last thing filled in before the name is written on it.
       That is how it reads in a drawing, and it reads the same in the frozen
       pictures of the boards that were wrong, where the card was drawn inside
       the enclosure's own group and was the second fill in it. */
    const bgroup = stack.find(g => {
      const c = attr(g.attrs, 'class');
      return c === 'boundary' || c === 'boundary-card';
    });
    if (tag === 'text') {
      const b = textBox(attrs, body, dx, dy);
      if (nodeId !== undefined) nodeText.push({ id: nodeId, text: unescape(body), size: Number(attr(attrs, 'font-size')), ...b });
      else if (call) {
        // keyed by the group itself: two callouts may share an id, or have none
        const prev = callouts.get(call);
        callouts.set(call, prev ? { text: prev.text + ' ' + unescape(body), ...union(prev, b) } : { text: unescape(body), ...b });
      } else if (bgroup) {
        const card = bgroup.fills[bgroup.fills.length - 1];
        if (card) {
          card.text = (card.text ? card.text + ' ' : '') + unescape(body);
          tabs.push(card);
        }
      } else if (edgeId !== undefined && inTag) {
        const t = tags.get(inTag);
        if (t) t.text = (t.text ? t.text + ' ' : '') + unescape(body);
      }
    } else if (tag === 'path' && bgroup && attr(attrs, 'class') === 'f') {
      bgroup.fills.push({ ...pathBox(attr(attrs, 'd') || '', dx, dy), text: '' });
    } else if (tag === 'path' && call && attr(attrs, 'class') === 'f') {
      // the ball a leader ends in: `M(x - r) y a r r ...`, so its centre is r to the right
      const m = (attr(attrs, 'd') || '').match(/^M(-?[\d.]+) (-?[\d.]+)\s*a([\d.]+)/);
      if (m) balls.push({ x: Number(m[1]) + dx, y: Number(m[2]) + dy - Number(m[3]), w: Number(m[3]) * 2, h: Number(m[3]) * 2 });
    } else if (tag === 'path' && edgeId !== undefined && inTag && attr(attrs, 'class') === 'f') {
      if (!tags.has(inTag)) tags.set(inTag, { key: edgeId, text: '', ...pathBox(attr(attrs, 'd') || '', dx, dy) });
    }
  }
  return {
    nodeText,
    tags: [...tags.values()],
    callouts: [...callouts.values()],
    tabs,
    balls,
  };
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const meets = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - SLACK && a.x + a.w > b.x + SLACK && a.y < b.y + b.h - SLACK && a.y + a.h > b.y + SLACK;

/* Does a polyline pass through a box? Sampled rather than solved: a route is
   a handful of short segments and the boxes are few, so the crude version is
   fast enough to run on every batch and has no cases in it to get wrong. */
function crosses(pts: Pt[], b: Rect, inset = 2): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
      if (x > b.x + inset && x < b.x + b.w - inset && y > b.y + inset && y < b.y + b.h - inset) return true;
    }
  }
  return false;
}

/* The text half, over a rendered board. `spec` supplies the node kinds, so a
   note is measured by its card rather than its tilted words. */
export function overprints(spec: { nodes?: { id: string, kind?: string }[] }, r: Drawn) {
  const drawn = measureDrawing(r.svg);
  const kinds = Object.fromEntries((spec.nodes || []).map(n => [n.id, n.kind]));
  /* The drawing is shifted to make room for what overhangs the top left, and
     the layout's boxes and routes are not. Everything here is in the drawing's
     coordinates. */
  const { x: ox, y: oy } = r.offset;
  const at = (b: Rect): Rect => ({ x: b.x + ox, y: b.y + oy, w: b.w, h: b.h });
  const cards = Object.entries(r.boxes).filter(([id]) => kinds[id] === 'note').map(([id, b]) => ({ id, ...at(b) }));
  const words = drawn.nodeText.filter(t => kinds[t.id] !== 'note');
  // what a tag is painted beneath: the drawing, not a queue's strip of words, which is in `words`
  const bodies = Object.entries(r.boxes).filter(([id]) => kinds[id] !== 'note').map(([id, b]) => ({ id, ...at(b) }));
  const routes = r.planned.map(p => ({ key: p.key, pts: p.pts.map(([x, y]) => [x + ox, y + oy]) }));

  const text: string[] = [], astray: Astray[] = [];
  const floats = [
    ...drawn.tags.map(t => ({ ...t, what: `tag "${t.text}"` , tag: true })),
    ...drawn.callouts.map(c => ({ ...c, what: `callout "${c.text}"`, tag: false })),
    /* A boundary's card is painted with the enclosure, which is under the
       nodes, so a card under a box is hidden the way a tag is. */
    ...drawn.tabs.map(t => ({ ...t, what: `tab "${t.text}"`, tag: true })),
  ];
  for (const f of floats) {
    for (const t of words) if (meets(f, t)) text.push(`${f.what} prints over ${t.id}'s "${t.text}"`);
    for (const c of cards) if (meets(f, c)) text.push(`${f.what} prints over the note ${c.id}`);
    if (f.tag) for (const b of bodies) if (meets(f, b) && !words.some(t => t.id === b.id && meets(f, t)))
      text.push(`${f.what} is hidden under ${b.id}`);
  }
  for (const b of drawn.balls)
    for (const t of drawn.tags) if (meets(b, t)) text.push(`a callout's ball lands on tag "${t.text}"`);
  for (let i = 0; i < floats.length; i++)
    for (let j = i + 1; j < floats.length; j++)
      if (meets(floats[i], floats[j])) text.push(`${floats[i].what} prints over ${floats[j].what}`);

  /* A label on a line that is not its own. The words are legible — this is
     the fallback the placement pass is allowed to take — but a label the
     reader cannot attribute has failed at the one thing a label is for, so
     it is kept as what it is rather than as a sentence. */
  for (const t of drawn.tags)
    for (const p of routes)
      if (p.key !== t.key && crosses(p.pts, t)) astray.push({ kind: 'tag', text: t.text, on: p.key });
  for (const c of drawn.callouts)
    for (const p of routes)
      if (crosses(p.pts, c)) astray.push({ kind: 'callout', text: c.text, on: p.key });
  /* A card is painted under the edges, so a line across it strikes the name
     through — worse than a pill laid over a line, which only hides the line. */
  for (const t of drawn.tabs)
    for (const p of routes)
      if (crosses(p.pts, t)) astray.push({ kind: 'tab', text: t.text, on: p.key });
  return { text, astray, lines: astray.map(a => `${a.kind} "${a.text}" sits on ${a.on}`) };
}

/* Every arrow that passes through a box which is neither of its ends. The
   board says it connects those two; the line says it touched four. */
export function buriedArrows({ boxes, planned }: { boxes: Record<string, Rect>, planned: Route[] }): Buried[] {
  const found: Buried[] = [];
  for (const r of planned) {
    const [from, to] = r.key.split('>');
    for (const [id, b] of Object.entries(boxes)) {
      if (id === from || id === to) continue;
      if (crosses(r.pts, b, INSET)) found.push({ edge: r.key, box: id });
    }
  }
  return found;
}

/* Every arrow that runs within CLEARANCE of a box which is neither of its
   ends, without going through it — that half is buriedArrows'. At rest the
   line reads fine; lit, it is a bright stroke grazing a faded box, and that
   reads as a line ending there (#216). Sampled like `crosses`, and measured
   to the box's outline, so a line in the rim the INSET forgives is a gap of 0
   rather than a line through the box. */
export function grazingArrows({ boxes, planned }: { boxes: Record<string, Rect>, planned: Route[] }): Grazed[] {
  const found: Grazed[] = [];
  for (const r of planned) {
    const [from, to] = r.key.split('>');
    for (const [id, b] of Object.entries(boxes)) {
      if (id === from || id === to || crosses(r.pts, b, INSET)) continue;
      let gap = Infinity, at: Pt = [0, 0];
      for (let i = 1; i < r.pts.length; i++) {
        const [x0, y0] = r.pts[i - 1], [x1, y1] = r.pts[i];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
        for (let k = 0; k <= n; k++) {
          const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
          const d = Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
          if (d < gap) { gap = d; at = [x, y]; }
        }
      }
      if (gap >= CLEARANCE) continue;
      const [x, y] = at;
      const side = gap === 0 ? 'along the rim of'
        : y < b.y ? 'above' : y > b.y + b.h ? 'below' : x < b.x ? 'left of' : 'right of';
      found.push({ edge: r.key, box: id, gap: Math.round(gap * 10) / 10, side });
    }
  }
  return found;
}

/* How large the board's lettering lands on the reference screen, when that is
   under the floor. The page fits the whole board into its pane and never zooms
   in to do it, so the scale is capped at 1 — and a board shown at full size is
   not one the fit shrank, whatever sizes it was lettered in, so it is not one a
   chapter break would help. */
export function smallText(r: Drawn): Small | null {
  if (!(r.width > 0) || !(r.height > 0)) return null;
  const fit = Math.min(1, REFERENCE_VIEW.w / r.width, REFERENCE_VIEW.h / r.height);
  const sizes = measureDrawing(r.svg).nodeText.map(t => t.size).filter(Number.isFinite);
  if (fit >= 1 || !sizes.length) return null;
  const px = Math.max(...sizes) * fit;
  return px < TEXT_FLOOR ? { fit, px } : null;
}

/* Do two segments meet anywhere but at their ends? Routes share their ends by
   design — every arrow out of one box leaves from the same side — so a shared
   endpoint is the drawing working, not a crossing. */
const meet = (p: Pt, q: Pt, r: Pt, s: Pt): boolean => {
  const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (!d) return false;   // parallel, including the overlapping case: no X to see
  const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
};

/* How many pairs of arrows cross. Pairs rather than points: two lines that
   meet twice are one tangle to a reader, not two. */
export function crossings(planned: Route[]): number {
  let n = 0;
  for (let i = 0; i < planned.length; i++)
    for (let j = i + 1; j < planned.length; j++) {
      const A = planned[i].pts, B = planned[j].pts;
      let hit = false;
      for (let a = 1; a < A.length && !hit; a++)
        for (let b = 1; b < B.length && !hit; b++) hit = meet(A[a - 1], A[a], B[b - 1], B[b]);
      if (hit) n++;
    }
  return n;
}

/* The whole measurement, over a board the renderer has just drawn. */
export function audit(spec: { nodes?: { id: string, kind?: string }[] }, r: Drawn) {
  const { text, astray } = overprints(spec, r);
  return {
    over: text,
    astray,
    buried: buriedArrows(r),
    crossings: crossings(r.planned),
    grazed: grazingArrows(r),
    small: smallText(r),
  };
}

/* The half of the measurement that rides back as warnings: what the reader
   will not be able to make out, said as a fact about the board, with what it
   costs. Like the report, it never refuses and is empty for a board that came
   out fine. */
export function measuredWarnings({ grazed = [], small = null }: { grazed?: Grazed[], small?: Small | null }): string[] {
  const lines: string[] = [];
  if (small) {
    lines.push(`at ${REFERENCE_VIEW.w}×${REFERENCE_VIEW.h} this board fits at ${Math.round(small.fit * 100)}%, ` +
      `so its labels land at ${small.px.toFixed(1)}px; a chapter break is where the rest of it goes`);
  }
  if (grazed.length) {
    const named = grazed.slice(0, NAMED).map(g => (g.gap
      ? `${g.edge}, ${g.gap} unit${g.gap === 1 ? '' : 's'} ${g.side} ${g.box}`
      : `${g.edge}, ${g.side} ${g.box}`)).join('; ');
    const rest = grazed.length - NAMED;
    lines.push(`${grazed.length} arrow${grazed.length > 1 ? 's' : ''} ` +
      `pass${grazed.length > 1 ? '' : 'es'} close enough to a box that is not an end of ` +
      `${grazed.length > 1 ? 'them' : 'it'} to read as touching it, most of all when lit: ` +
      named + (rest > 0 ? `, and ${rest} more` : ''));
  }
  return lines;
}

/* What of it is worth saying, in the order it costs a reader. Empty when the
   board came out clean, which is most of the time and is the point: a clean
   board must not grow a wall of "0 problems" under its counts.

   Each line names the condition and the count and stops there. It does not
   say what to do: the remedy for a board that cannot be placed is fewer things
   on it, and a report that provoked a blind redraw would be worse than
   silence. */
export function report({ over = [], astray = [], buried = [], crossings = 0 }: {
  over?: string[], astray?: Astray[], buried?: Buried[], crossings?: number,
}): string[] {
  const lines = [...over];
  /* A label on somebody else's line. Named rather than counted, because
     "a label is ambiguous" is nothing to act on and "this label, on that
     line" is. */
  if (astray.length) {
    const named = astray.slice(0, NAMED).map(a => `"${a.text}" on ${a.on}`).join(', ');
    const rest = astray.length - NAMED;
    lines.push(`${astray.length} label${astray.length > 1 ? 's' : ''} ` +
      `sit${astray.length > 1 ? '' : 's'} on a line that is not ` +
      `${astray.length > 1 ? 'their' : 'its'} own: ` + named + (rest > 0 ? `, and ${rest} more` : ''));
  }
  if (buried.length) {
    const named = buried.slice(0, NAMED).map(b => `${b.edge} through ${b.box}`).join(', ');
    const rest = buried.length - NAMED;
    lines.push(`${buried.length} arrow${buried.length > 1 ? 's' : ''} ` +
      `cross${buried.length > 1 ? '' : 'es'} a box that is not an end of it: ` +
      named + (rest > 0 ? `, and ${rest} more` : ''));
  }
  if (crossings > CROSSINGS_FLOOR) lines.push(`${crossings} pairs of lines cross`);
  return lines;
}
