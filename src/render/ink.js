/* ============================================================
   spiega ink — hand-drawn primitives.

   Two things together sell the hand: geometry that is off true (here) and a
   displacement + grain filter over the whole drawing (theme.handFilter).
   Neither alone is convincing — a jittered path with crisp edges looks like a
   mistake, and a filter over perfect rectangles still reads as a vector.

   Every wobble is seeded, so the same spec draws the same board every time.
   A board that reshuffles its strokes on each render looks broken, not alive.
   ============================================================ */

import { INK } from './theme.js';

/* ---------- seeded noise ---------- */

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = v => (Math.round(v * 100) / 100);

/* ---------- path building ---------- */

/* A polyline drawn as quadratics through the midpoints of each segment.
   This is what keeps a jittered point list from looking like a seismograph:
   the pen curves between wobbles instead of cornering on every one. */
export function smooth(pts, close = false) {
  if (pts.length < 2) return '';
  const p = close ? [...pts, pts[0], pts[1]] : pts;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  if (p.length === 2) return d + `L${f(p[1][0])} ${f(p[1][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
    d += `Q${f(p[i][0])} ${f(p[i][1])} ${f(mx)} ${f(my)}`;
  }
  if (!close) {
    const last = p[p.length - 1];
    d += `L${f(last[0])} ${f(last[1])}`;
  }
  return d + (close ? 'Z' : '');
}

/* Walk a polyline, dropping a point every `step` units and nudging each one off
   the true line. `amp` is how far the hand strays; `drift` is a slow wander on
   top of it, which is what makes a long line bow gently rather than buzz. */
export function waver(pts, { seed = 1, amp = 1.1, step = 26, drift = 0.6 } = {}) {
  const r = rng(seed);
  const out = [];
  let phase = r() * Math.PI * 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      phase += 0.9 + r() * 0.5;
      const off = (r() - 0.5) * 2 * amp + Math.sin(phase) * drift;
      // the hand settles at the ends of a stroke and strays most in the middle
      const ease = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 0.6 + 0.4;
      out.push([x0 + dx * t + nx * off * ease, y0 + dy * t + ny * off * ease]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---------- shapes, as path data ---------- */

export function roughLine(a, b, opts = {}) {
  return smooth(waver([a, b], opts));
}

export function roughPoly(pts, { close = true, ...opts } = {}) {
  return smooth(waver(close ? [...pts, pts[0]] : pts, opts), false);
}

/* A rounded rectangle whose corners are sampled as arcs before wavering, so the
   wobble rides over the rounding instead of fighting it. */
export function roundedPts(x, y, w, h, r = 10, seg = 4) {
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  const arc = (cx, cy, a0, a1) => Array.from({ length: seg + 1 }, (_, i) => {
    const a = (a0 + (a1 - a0) * i / seg) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return [
    ...arc(x + w - r, y + r, -90, 0),
    ...arc(x + w - r, y + h - r, 0, 90),
    ...arc(x + r, y + h - r, 90, 180),
    ...arc(x + r, y + r, 180, 270),
  ];
}

export function roughRect(x, y, w, h, r = 10, opts = {}) {
  const pts = roundedPts(x, y, w, h, r);
  return smooth(waver([...pts, pts[0]], { step: 22, ...opts }), false) + 'Z';
}

export function roughEllipse(cx, cy, rx, ry, opts = {}) {
  const n = 20;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const a = i / n * Math.PI * 2;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
  return smooth(waver(pts, { step: 18, amp: 0.8, ...opts }), false) + 'Z';
}

/* Half an ellipse — the lip and the belly of a cylinder. */
export function roughArc(cx, cy, rx, ry, a0, a1, opts = {}) {
  const n = 14;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
  return smooth(waver(pts, { step: 18, amp: 0.7, ...opts }), false);
}

/* ---------- emitting SVG ---------- */

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Strokes carry class="s" so the board client can find them and draw them on,
   one after another, with stroke-dashoffset. */
export function stroke(d, { w = 1.6, color = INK, dash = null, opacity = 1, cls = 's', extra = '' } = {}) {
  if (!d) return '';
  return `<path class="${cls}" d="${d}" fill="none" stroke="${color}" stroke-width="${w}"` +
    ` stroke-linejoin="round" stroke-linecap="round"` +
    (dash ? ` stroke-dasharray="${dash}"` : '') +
    (opacity !== 1 ? ` opacity="${opacity}"` : '') + ` ${extra}/>`;
}

export function fill(d, color, { opacity = 1, extra = '' } = {}) {
  if (!d) return '';
  return `<path class="f" d="${d}" fill="${color}"` +
    (opacity !== 1 ? ` opacity="${opacity}"` : '') + ` ${extra}/>`;
}

/* Labels are lettered in capitals, the way people write on a whiteboard —
   except where the spelling is the information.

   `InvoiceBuilderNCC` uppercased is `INVOICEBUILDERNCC`, and the humps that
   told you where the words were are gone. The name of a class, a topic or a
   table is not prose that happens to be capitalised; it is a string that has
   to be typed back exactly, and flattening its case makes the board worse
   than the sentence it replaced.

   So the transform is per word, and a word is left exactly as written when it
   carries a boundary that capitals would destroy: a lowercase letter followed
   by a capital (`camelCase`, `InvoiceBuilderNCC`), an underscore
   (`invoice_builder`), a dot (`orders.created`, `com.dhl.Invoices`), or the
   punctuation of code (`::`, `()`, and angle brackets against a word, as in
   `Map<String, Int>`). Hyphens are not on the list, on purpose:
   `corrections-api` uppercases to `CORRECTIONS-API` with every boundary still
   visible, so there is nothing to protect. Nor is a lone `<` with spaces
   around it, which is someone writing "latency < 5ms", not a type. */
const CODEY = /[a-z][A-Z]|_|\w\.\w|::|\(\)|\w[<>]|[<>]\w/;

export const lettering = s => String(s)
  .split(/(\s+)/)
  .map(w => (CODEY.test(w) ? w : w.toUpperCase()))
  .join('');

export function text(x, y, s, {
  size = 13, color = INK, weight = 700, anchor = 'middle', spacing = 0.04,
  upper = false, family = null, opacity = 1, cls = 't',
} = {}) {
  const body = upper ? lettering(s) : String(s);
  return `<text class="${cls}" x="${f(x)}" y="${f(y)}" fill="${color}" font-size="${size}"` +
    ` font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}em"` +
    (family ? ` font-family="${family}"` : '') +
    (opacity !== 1 ? ` opacity="${opacity}"` : '') + `>${esc(body)}</text>`;
}

/* An arrowhead drawn as two strokes meeting at the tip, like a pen would. */
export function arrowHead(tip, dirRad, { size = 11, w = 1.8, color = INK, seed = 1, spread = 0.42 } = {}) {
  const [tx, ty] = tip;
  const wing = a => [tx - size * Math.cos(dirRad + a), ty - size * Math.sin(dirRad + a)];
  const o = { seed, amp: 0.5, step: 7 };
  return stroke(roughLine(wing(spread), tip, o), { w, color }) +
    stroke(roughLine(wing(-spread), tip, { ...o, seed: seed + 1 }), { w, color });
}

/* Greedy word wrap. A note is somebody's handwriting in the margin, so it wraps
   at a readable measure rather than stretching to fit whatever was typed; an
   unwrapped sentence drawn centred will happily run clean across the board. */
export function wrapText(s, max = 24, maxLines = 5) {
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) { line = word; continue; }
      if ((line + ' ' + word).length <= max) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  const lines = out.filter((l, i) => l || i === 0);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, max - 1) + '\u2026';
  return kept;
}

export { esc, f as round2 };
