/* ============================================================
   Is the picture readable? A crude check, made on the drawing.

   The other tests ask whether a picture matches its spec. This one asks
   whether a person can read it: after everything that floats has been placed,
   does any of it print on top of words, or hide under a box?

   It is measured from the SVG the renderer produced, not from the planner's
   own idea of where things went. A check that reused the planner's boxes would
   agree with the planner by construction, including about everything the
   planner gets wrong.

   What it reports, per board:
   - a tag or a callout over a line of a node's text, or over a note card;
   - a tag under a node's box (tags are painted beneath nodes, so it is hidden);
   - a tag or a callout over another tag or callout, or a callout's ball, drawn
     on top, landing on a tag.

   `lines` is reported alongside and not asserted on: a pill crossing a line
   that is not its own is legible, only worse, and it is what the placement
   pass is allowed to fall back to.

   Run `node test/readable.mjs <spec.json>...` to print what it finds.
   ============================================================ */

import fs from 'node:fs';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';

/* Monospace advance. The board's faces (SF Mono, Menlo, Consolas) are all
   about 0.6 em; letter-spacing is added per character on top. */
const ADVANCE = 0.6;
/* Two boxes touching at a hairline are not one word on another. */
const SLACK = 1;

const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (s, k) => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : null; };

function textBox(attrs, body, dx, dy) {
  const x = Number(attr(attrs, 'x')) + dx, y = Number(attr(attrs, 'y')) + dy;
  const size = Number(attr(attrs, 'font-size'));
  const spacing = parseFloat(attr(attrs, 'letter-spacing') || '0');
  const w = [...unescape(body)].length * size * (ADVANCE + spacing);
  const anchor = attr(attrs, 'text-anchor') || 'start';
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return { x: x0, y: y - size * 0.75, w, h: size * 0.95 };
}

function pathBox(d, dx, dy) {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs) + dx, y0 = Math.min(...ys) + dy;
  return { x: x0, y: y0, w: Math.max(...xs) + dx - x0, h: Math.max(...ys) + dy - y0 };
}

/* Walk the drawing once, keeping the stack of groups open at each element so
   every word and every pill knows what it belongs to. Only translations are
   followed: the one rotation on the board is a note's tilt, and a note is
   measured by its card. */
export function measureDrawing(svg) {
  const stack = [];
  const nodeText = [], tags = new Map(), callouts = new Map(), balls = [];
  // an attribute may hold a `>`: every edge is named `from>to`
  const re = /<(\/?)(g|text|path)\b((?:[^>"]|"[^"]*")*?)\/?>([^<]*)/g;
  for (const m of svg.matchAll(re)) {
    const [, close, tag, attrs, body] = m;
    if (tag === 'g') {
      if (close) { stack.pop(); continue; }
      const t = (attr(attrs, 'transform') || '').match(/translate\(([-\d.]+)[ ,]+([-\d.]+)\)/);
      stack.push({ attrs, dx: t ? Number(t[1]) : 0, dy: t ? Number(t[2]) : 0 });
      continue;
    }
    if (close) continue;
    const dx = stack.reduce((s, g) => s + g.dx, 0), dy = stack.reduce((s, g) => s + g.dy, 0);
    const node = stack.find(g => attr(g.attrs, 'data-node'));
    const edge = stack.find(g => attr(g.attrs, 'data-edge'));
    const inTag = stack.some(g => attr(g.attrs, 'class') === 'tag');
    const call = stack.find(g => attr(g.attrs, 'data-callout') != null);
    if (tag === 'text') {
      const b = textBox(attrs, body, dx, dy);
      if (node) nodeText.push({ id: attr(node.attrs, 'data-node'), text: unescape(body), ...b });
      else if (call) {
        // keyed by the group itself: two callouts may share an id, or have none
        const prev = callouts.get(call);
        callouts.set(call, prev ? { text: prev.text + ' ' + unescape(body), ...union(prev, b) } : { text: unescape(body), ...b });
      } else if (edge && inTag) {
        const k = attr(edge.attrs, 'data-edge');
        const t = tags.get(k);
        if (t) t.text = (t.text ? t.text + ' ' : '') + unescape(body);
      }
    } else if (tag === 'path' && call && attr(attrs, 'class') === 'f') {
      // the ball a leader ends in: `M(x - r) y a r r ...`, so its centre is r to the right
      const m = (attr(attrs, 'd') || '').match(/^M(-?[\d.]+) (-?[\d.]+)\s*a([\d.]+)/);
      if (m) balls.push({ x: Number(m[1]) + dx, y: Number(m[2]) + dy - Number(m[3]), w: Number(m[3]) * 2, h: Number(m[3]) * 2 });
    } else if (tag === 'path' && edge && inTag && attr(attrs, 'class') === 'f') {
      const k = attr(edge.attrs, 'data-edge');
      if (!tags.has(k)) tags.set(k, { key: k, text: '', ...pathBox(attr(attrs, 'd') || '', dx, dy) });
    }
  }
  return {
    nodeText,
    tags: [...tags.values()],
    callouts: [...callouts.values()],
    balls,
  };
}

const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const meets = (a, b) =>
  a.x < b.x + b.w - SLACK && a.x + a.w > b.x + SLACK && a.y < b.y + b.h - SLACK && a.y + a.h > b.y + SLACK;

/* Does a polyline pass through a box? */
function crosses(pts, b) {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2));
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
      if (x > b.x + 2 && x < b.x + b.w - 2 && y > b.y + 2 && y < b.y + b.h - 2) return true;
    }
  }
  return false;
}

/* The whole check, over a rendered board. `spec` supplies the node kinds, so a
   note is measured by its card rather than its tilted words. */
export function overprints(spec, r) {
  const drawn = measureDrawing(r.svg);
  const kinds = Object.fromEntries((spec.nodes || []).map(n => [n.id, n.kind]));
  /* The drawing is shifted to make room for what overhangs the top left, and
     the layout's boxes and routes are not. Everything here is in the drawing's
     coordinates. */
  const { x: ox, y: oy } = r.offset;
  const at = b => ({ x: b.x + ox, y: b.y + oy, w: b.w, h: b.h });
  const cards = Object.entries(r.boxes).filter(([id]) => kinds[id] === 'note').map(([id, b]) => ({ id, ...at(b) }));
  const words = drawn.nodeText.filter(t => kinds[t.id] !== 'note');
  // what a tag is painted beneath: the drawing, not a queue's strip of words, which is in `words`
  const bodies = Object.entries(r.boxes).filter(([id]) => kinds[id] !== 'note').map(([id, b]) => ({ id, ...at(b) }));
  const routes = r.planned.map(p => ({ key: p.key, pts: p.pts.map(([x, y]) => [x + ox, y + oy]) }));

  const text = [], lines = [];
  const floats = [
    ...drawn.tags.map(t => ({ ...t, what: `tag "${t.text}"` , tag: true })),
    ...drawn.callouts.map(c => ({ ...c, what: `callout "${c.text}"`, tag: false })),
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

  for (const t of drawn.tags)
    for (const p of routes)
      if (p.key !== t.key && crosses(p.pts, t)) lines.push(`tag "${t.text}" sits on ${p.key}`);
  for (const c of drawn.callouts)
    for (const p of routes)
      if (crosses(p.pts, c)) lines.push(`callout "${c.text}" sits on ${p.key}`);
  return { text, lines };
}

export function drawnBoard(ops) {
  const b = emptyBoard();
  const { errors } = applyOps(b, ops);
  if (errors.length) throw new Error(errors.join('; '));
  return b;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { specToOps } = await import('../src/spec.js');
  for (const file of process.argv.slice(2)) {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = renderSVG(drawnBoard(specToOps(spec)));
    const { text, lines } = overprints(spec, r);
    console.log(`${file}: ${text.length} over text, ${lines.length} over lines`);
    for (const s of text) console.log(`  TEXT  ${s}`);
    for (const s of lines) console.log(`  line  ${s}`);
  }
}
