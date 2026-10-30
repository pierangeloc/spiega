/* ============================================================
   spiega glyphs — one drawing per kind of thing on the board.

   Every glyph is built the same way, in this order, because that is the order a
   hand would lay it down and the order that reads correctly when the strokes
   animate on: cast shadow, body fill, thickness band, ink outline, detail, label.
   ============================================================ */

import { INK, MUTED, SHADOW, ACCENT, bodyOf, mix } from './theme.js';
import {
  roughRect, roughLine, roughEllipse, roughArc, roughPoly, roundedPts,
  stroke, fill, text, hashSeed, rng, wrapText, lettering } from './ink.js';
import { measureMath, drawMath } from './math.js';

const SH_DX = 5, SH_DY = 6;          // the cast shadow sits down and to the left-ish
const R = 12;                         // default corner radius

/* The shadow is flat cobalt, never a blur: a blurred shadow is a screen effect,
   a flat offset one is what you get when you ink a shape twice on paper. */
const castShadow = (d, dx = SH_DX, dy = SH_DY) =>
  `<g class="shadow" transform="translate(${dx} ${dy})">${fill(d, SHADOW, { opacity: 0.17 })}</g>`;

const labelBlock = (cx, cy, title, subtitle, { titleSize = 13.5, color = INK } = {}) => {
  if (!title) return '';
  const dy = subtitle ? -3 : 4.5;
  return text(cx, cy + dy, title, { size: titleSize, color, upper: true, spacing: 0.06 }) +
    (subtitle ? text(cx, cy + 13, subtitle, { size: 10, color: MUTED, weight: 500, spacing: 0.04 }) : '');
};

/* The band along the bottom edge that gives a flat shape its thickness.
   It is the one place a second tone of the body colour appears. */
const thicknessBand = (x, y, w, h, m, seed, r = R) => {
  const t = Math.min(9, h * 0.22);
  const d = roughRect(x, y + h - t, w, t, Math.min(r, t), { seed: seed + 41, amp: 0.7 });
  return fill(d, m);
};

/* ---------- the glyphs ---------- */

function gService(box, n, m, seed) {
  const { x, y, w, h } = box;
  const body = roughRect(x, y, w, h, R, { seed, amp: 1.0 });
  return castShadow(body) + fill(body, m.l) + thicknessBand(x, y, w, h, m.m, seed) +
    stroke(body, { w: 2 }) +
    labelBlock(x + w / 2, y + h / 2, n.label, n.sub);
}

/* A gateway is a service with a chevron bitten out of its leading edge — the
   shape says "everything funnels through here" before the label is read. */
function gGateway(box, n, m, seed) {
  const { x, y, w, h } = box;
  const c = 14;
  const pts = [
    [x + c, y], [x + w, y], [x + w, y + h], [x + c, y + h], [x, y + h / 2],
  ];
  const body = roughPoly(pts, { seed, amp: 1.0, step: 24 });
  return castShadow(body) + fill(body, m.l) +
    stroke(body, { w: 2 }) +
    stroke(roughLine([x + c + 10, y + 8], [x + c + 10, y + h - 8], { seed: seed + 7, amp: 0.8 }),
      { w: 1.1, color: m.d, opacity: 0.55 }) +
    labelBlock(x + c / 2 + w / 2, y + h / 2, n.label, n.sub);
}

function gDatastore(box, n, m, seed) {
  const { x, y, w, h } = box;
  const ry = Math.min(14, h * 0.2), cx = x + w / 2;
  const topY = y + ry, botY = y + h - ry;
  const silhouette =
    `M${x} ${topY}L${x} ${botY}` +
    `A${w / 2} ${ry} 0 0 0 ${x + w} ${botY}` + `L${x + w} ${topY}` +
    `A${w / 2} ${ry} 0 0 0 ${x} ${topY}Z`;
  const lip = roughEllipse(cx, topY, w / 2, ry, { seed: seed + 3 });
  return castShadow(silhouette) + fill(silhouette, m.l) +
    fill(lip, mix(m.l, '#ffffff', 0.35)) +
    stroke(roughArc(cx, botY, w / 2, ry, 0, 180, { seed: seed + 5 }), { w: 2 }) +
    stroke(roughLine([x, topY], [x, botY], { seed: seed + 6, amp: 0.8 }), { w: 2 }) +
    stroke(roughLine([x + w, topY], [x + w, botY], { seed: seed + 8, amp: 0.8 }), { w: 2 }) +
    stroke(lip, { w: 2 }) +
    labelBlock(cx, y + h / 2 + ry / 2, n.label, n.sub);
}

/* A queue shows its slots, and fills a few of them, so depth is visible at a
   glance. The filled count is cosmetic unless the spec sets n.depth. */
function gQueue(box, n, m, seed) {
  const { x, y, w, h } = box;
  const body = roughRect(x, y, w, h, 6, { seed, amp: 0.9 });
  const slots = Math.max(3, Math.min(8, n.slots || 5));
  const filled = n.depth == null ? Math.ceil(slots / 2) : Math.min(slots, n.depth);
  const sw = w / slots;
  let inner = '';
  for (let i = 0; i < slots; i++) {
    const sx = x + i * sw;
    if (i < filled) {
      inner += fill(roughRect(sx + 3, y + 3, sw - 6, h - 6, 3, { seed: seed + 20 + i, amp: 0.6 }), m.m);
    }
    if (i > 0) {
      inner += stroke(roughLine([sx, y + 2], [sx, y + h - 2], { seed: seed + 30 + i, amp: 0.7 }),
        { w: 1.2, opacity: 0.7 });
    }
  }
  return castShadow(body) + fill(body, m.l) + inner + stroke(body, { w: 2 }) +
    text(x + w / 2, y + h + 17, n.label || '', { size: 12, upper: true, spacing: 0.06 }) +
    (n.sub ? text(x + w / 2, y + h + 30, n.sub, { size: 10, color: MUTED, weight: 500 }) : '');
}

/* A cache is inked twice — the doubled outline is the visual shorthand for
   "this is a copy of something that lives elsewhere". */
function gCache(box, n, m, seed) {
  const { x, y, w, h } = box;
  const body = roughRect(x, y, w, h, R, { seed, amp: 1.0 });
  const ghost = roughRect(x + 4, y + 4, w - 8, h - 8, R - 3, { seed: seed + 11, amp: 0.9 });
  return castShadow(body) + fill(body, m.l) + thicknessBand(x, y, w, h, m.m, seed) +
    stroke(body, { w: 2 }) +
    stroke(ghost, { w: 1.1, color: m.d, opacity: 0.5, dash: '7 5' }) +
    labelBlock(x + w / 2, y + h / 2, n.label, n.sub);
}

/* A client is a screen on a stand: the one glyph that should read as "a person
   is on the other side of this". */
function gClient(box, n, m, seed) {
  const { x, y, w, h } = box;
  const sh = h - 14;
  const body = roughRect(x, y, w, sh, 8, { seed, amp: 1.0 });
  const cx = x + w / 2;
  return castShadow(body) + fill(body, m.l) +
    stroke(body, { w: 2 }) +
    stroke(roughLine([x + 10, y + sh - 11], [x + w - 10, y + sh - 11], { seed: seed + 9, amp: 0.7 }),
      { w: 1.1, opacity: 0.45 }) +
    stroke(roughLine([cx, y + sh], [cx, y + h - 4], { seed: seed + 12, amp: 0.6 }), { w: 2 }) +
    stroke(roughLine([cx - 16, y + h - 3], [cx + 16, y + h - 3], { seed: seed + 13, amp: 0.6 }), { w: 2 }) +
    labelBlock(cx, y + sh / 2 - 2, n.label, n.sub);
}

/* Anything outside the boundary of what is being explained: a cloud, drawn
   loosely, with no thickness band, because it has no inside worth showing. */
/* The union outline of a row of overlapping circles sitting on a baseline.
   Tangent lobes meet in a cusp and read as a mountain range; only circles that
   genuinely overlap, with the buried arcs dropped, look like a cloud. */
function cloudPts(x0, x1, base, h) {
  const fr = [0.5, 0.82, 0.68, 0.44];
  const rs = fr.map(v => v * h * 0.62);
  const first = rs[0], last = rs[rs.length - 1];
  const inner = Math.max(1, (x1 - x0) - first - last);
  const cs = rs.map((r, i) => ({ x: x0 + first + (inner * i) / (rs.length - 1), y: base, r }));

  // the upper intersection of two circles, as an angle on each
  const meet = (A, B) => {
    const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
    if (d >= A.r + B.r || d <= Math.abs(A.r - B.r)) return null;   // no overlap: give up
    const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
    const k = Math.sqrt(Math.max(0, A.r * A.r - a * a));
    const px = A.x + (a * dx) / d - (k * -dy) / d;
    const py = A.y + (a * dy) / d - (k * dx) / d;      // the one above the baseline
    const ang = (C) => {
      let t = (Math.atan2(py - C.y, px - C.x) * 180) / Math.PI;
      return t < 0 ? t + 360 : t;
    };
    return [ang(A), ang(B)];
  };

  const pts = [[cs[0].x - cs[0].r, base]];
  let start = 180;
  for (let i = 0; i < cs.length; i++) {
    let end = 360;
    let nextStart = 180;
    if (i < cs.length - 1) {
      const m = meet(cs[i], cs[i + 1]);
      if (m) { [end, nextStart] = m; }
      else { end = 270; nextStart = 270; }
    }
    const steps = Math.max(3, Math.round(Math.abs(end - start) / 14));
    for (let k = 0; k <= steps; k++) {
      const t = ((start + ((end - start) * k) / steps) * Math.PI) / 180;
      pts.push([cs[i].x + cs[i].r * Math.cos(t), cs[i].y + cs[i].r * Math.sin(t)]);
    }
    start = nextStart;
  }
  pts.push([cs[cs.length - 1].x + cs[cs.length - 1].r, base]);
  return pts;
}

function gExternal(box, n, m, seed) {
  const { x, y, w, h } = box;
  const base = y + h - 6;
  const pts = cloudPts(x + 4, x + w - 4, base, h);
  const body = roughPoly(pts, { seed, amp: 1.0, step: 26 });
  return castShadow(body) + fill(body, m.l) + stroke(body, { w: 1.9 }) +
    labelBlock(x + w / 2, base - h * 0.24, n.label, n.sub, { titleSize: 12.5 });
}

/* Compute: a stack of identical things. Replica count is the point. */
function gCompute(box, n, m, seed) {
  const { x, y, w, h } = box;
  const copies = Math.max(1, Math.min(4, n.replicas || 3));
  const step = 6, bh = h - step * (copies - 1);
  let out = '';
  const front = roughRect(x, y + step * (copies - 1), w, bh, R, { seed, amp: 1.0 });
  out += castShadow(front);
  for (let i = 0; i < copies; i++) {
    const d = roughRect(x + (copies - 1 - i) * step * 0.9, y + i * step, w, bh, R,
      { seed: seed + i * 17, amp: 1.0 });
    out += fill(d, i === copies - 1 ? m.l : mix(m.l, '#ffffff', 0.18)) + stroke(d, { w: i === copies - 1 ? 2 : 1.3 });
  }
  return out + labelBlock(x + w / 2, y + step * (copies - 1) + bh / 2, n.label, n.sub);
}

/* A note is the agent's own handwriting on the board: a keyword, an aside, a
   number worth remembering. Tilted, because nobody sticks one on straight. */
function gNote(box, n, m, seed) {
  const { x, y, w, h } = box;
  const tilt = ((hashSeed(n.id || n.label || 'note') % 200) / 100 - 1) * 1.6;
  const body = roughRect(0, 0, w, h, 3, { seed, amp: 1.2 });
  const fold = roughPoly([[w - 16, h], [w, h - 16], [w, h]], { seed: seed + 4, amp: 0.8 });
  const lines = n.lines || wrapText(n.label, 24);
  let txt = '';
  const lh = 15, y0 = h / 2 - (lines.length - 1) * lh / 2 + 4;
  lines.forEach((ln, i) => {
    txt += text(w / 2, y0 + i * lh, ln, { size: 12, upper: false, weight: 600, spacing: 0.02 });
  });
  return `<g transform="translate(${x} ${y}) rotate(${tilt.toFixed(2)} ${w / 2} ${h / 2})">` +
    castShadow(body, 4, 5) + fill(body, m.l) + fill(fold, m.m) +
    stroke(body, { w: 1.6 }) + stroke(fold, { w: 1.3 }) + txt + `</g>`;
}

/* A formula, standing on its own.

   No box: a box says "a component", and a formula is not one — it is writing
   on the board, like a note, but set rather than wrapped. The only furniture
   is a hand-drawn rule beneath it, which is what someone does when they want
   the formula to be the thing you look at. */
function gFormula(box, n, m, seed) {
  const { x, y, w, h } = box;
  const src = n.label || '';
  const size = 17;
  const mm = measureMath(src, size);
  const cx = w / 2, baseline = h / 2 + mm.a / 2;
  const rule = roughLine([cx - mm.w / 2 - 6, baseline + mm.d + 7],
    [cx + mm.w / 2 + 6, baseline + mm.d + 7], { seed: seed + 3, amp: 0.7, step: 11 });
  return `<g transform="translate(${x} ${y})">` +
    drawMath(cx, baseline, src, { size, anchor: 'middle', seed }) +
    stroke(rule, { w: 1.5, color: ACCENT }) +
    (n.sub ? text(cx, h - 2, n.sub, { size: 10, color: MUTED, weight: 500 }) : '') +
    `</g>`;
}

/* ---------- the neutral glyphs ----------

   The ten above are software's furniture, and each says something specific:
   a cylinder is durable storage, a row of slots is a queue. Asked to draw a
   plant, those meanings are a lie — H2O is not a database. These four carry no
   infrastructure reading at all, so a figure that is not about software can
   use the same board without its shapes contradicting its words. */

/* A blob is a body with no orientation: one closed, uneven mass. It is the
   glyph for a region, an organism or a substance whose outline is the
   information. Deliberately not a cloud: a cloud is a union of lobes sitting
   on a flat base; this has no flat edge and no inside worth separating. */
function gBlob(box, n, m, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2, r = rng(seed);
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    const kx = 0.93 + r() * 0.07, ky = 0.78 + r() * 0.22;
    return [cx + Math.cos(a) * w * 0.46 * kx, cy + Math.sin(a) * h * 0.4 * ky];
  });
  const body = roughPoly(pts, { seed, amp: 1.1, step: 24 });
  const under = roughPoly(pts.map(([px, py]) => [px, py + 6]), { seed: seed + 2, amp: 1.1, step: 24 });

  /* The blob is narrower than its box, so the label has to fit the drawing,
     not the box. Wrap it at the width the mass actually has, and shrink a
     single long word rather than letting it spill over the outline. */
  const source = n.label || '';
  const innerW = w * 0.78;
  const longest = Math.max(1, ...String(source).split(/\s+/).map(s => s.length));
  const titleSize = Math.max(9.5, Math.min(12.5, innerW / (longest * 0.72)));
  const maxChars = Math.max(6, Math.floor(innerW / (titleSize * 0.72)));
  const lines = source ? wrapText(source, maxChars, 3) : [];
  const lh = 15, subGap = 13;
  const blockH = (lines.length - 1) * lh + (n.sub ? subGap : 0);
  const y0 = cy - blockH / 2 + 4.5;
  let lab = '';
  lines.forEach((ln, i) => {
    lab += text(cx, y0 + i * lh, ln, { size: titleSize, upper: true, spacing: 0.06 });
  });
  if (n.sub) {
    lab += text(cx, y0 + (lines.length - 1) * lh + subGap, n.sub,
      { size: 10, color: MUTED, weight: 500, spacing: 0.04 });
  }
  return castShadow(body) + fill(under, m.m) + fill(body, m.l) +
    stroke(body, { w: 2 }) + lab;
}

/* A vessel holds something. In the wide, short box the layout hands a node, a
   jar would stretch into a tray, so this is a bowl: a rim clearly narrower
   than the belly, sides that bell out below the rim and gather in at the base.
   The dark mouth and the base band are what keep it off the datastore
   cylinder, whose top is a closed, lit face. */
function gVessel(box, n, m, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const top = y + 13, bottom = y + h - 7;
  const rimRX = Math.min(w * 0.29, 50);
  const bellyRX = Math.min(w * 0.4, 66);
  const baseRX = Math.min(w * 0.24, 40);
  const bellyY = y + h * 0.56;
  const body = roughPoly([
    [cx - rimRX, top], [cx - bellyRX, bellyY], [cx - baseRX, bottom],
    [cx + baseRX, bottom], [cx + bellyRX, bellyY], [cx + rimRX, top],
  ], { seed, amp: 1.0, step: 22 });
  const lip = roughEllipse(cx, top, rimRX, Math.min(7, h * 0.1), { seed: seed + 3, amp: 0.7 });
  const base = roughPoly([
    [cx - baseRX, bottom], [cx + baseRX, bottom],
    [cx + baseRX - 4, bottom + 5], [cx - baseRX + 4, bottom + 5],
  ], { seed: seed + 4, amp: 0.6 });
  const level = roughLine([cx - baseRX * 0.8, y + h * 0.84], [cx + baseRX * 0.8, y + h * 0.84],
    { seed: seed + 7, amp: 0.7, step: 14 });
  return castShadow(body) + fill(body, m.l) + fill(base, m.m) + fill(lip, m.m) +
    stroke(body, { w: 2 }) + stroke(lip, { w: 2 }) +
    stroke(level, { w: 1.2, color: m.d, opacity: 0.55 }) +
    labelBlock(cx, y + h * 0.54, n.label, n.sub);
}

/* A particle is one small thing, with two neighbours to say it is a particle
   and not a status light. It has no slot, box or mouth to imply storage or
   passage — only a body, a highlight, and a couple of specks. */
function gParticle(box, n, m, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + Math.min(20, h * 0.27), r = Math.min(15, h * 0.22);
  const orb = roughEllipse(cx, cy, r, r * 0.94, { seed });
  const shine = roughEllipse(cx - r * 0.3, cy - r * 0.32, r * 0.34, r * 0.24,
    { seed: seed + 4, amp: 0.5 });
  const a = roughEllipse(cx + r * 1.8, cy - r * 0.6, 2.6, 2.3, { seed: seed + 5, amp: 0.4 });
  const b = roughEllipse(cx - r * 1.7, cy + r * 0.8, 2.1, 1.9, { seed: seed + 6, amp: 0.4 });
  return castShadow(orb) + fill(orb, m.l) + fill(shine, mix(m.l, '#ffffff', 0.5)) +
    fill(a, m.m) + fill(b, m.m) + stroke(orb, { w: 2 }) +
    stroke(a, { w: 0.9, color: m.d, opacity: 0.45 }) +
    stroke(b, { w: 0.9, color: m.d, opacity: 0.45 }) +
    labelBlock(cx, y + h - 18, n.label, n.sub);
}

/* A source emits: a filled disc with rays thrown off it. It is the sun, a
   spring, a supply — the thing at the start, not a shape that stores or
   carries what it gives. Rays stay off the bottom so the label has a clear
   line to sit on. */
function gSource(box, n, m, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + 21, r = Math.min(13, h * 0.19);
  const disc = roughEllipse(cx, cy, r, r * 0.95, { seed });
  let rays = '';
  for (let i = 0; i < 7; i++) {
    const a = (195 + i * 25) * Math.PI / 180;
    const inner = r + 4, outer = inner + 7 + ((seed + i * 13) % 5);
    rays += stroke(roughLine(
      [cx + Math.cos(a) * inner, cy + Math.sin(a) * inner],
      [cx + Math.cos(a) * outer, cy + Math.sin(a) * outer],
      { seed: seed + 10 + i, amp: 0.5, step: 7 }), { w: 1.6, color: m.d });
  }
  return castShadow(disc) + fill(disc, m.l) + stroke(disc, { w: 2 }) + rays +
    labelBlock(cx, y + h - 20, n.label, n.sub);
}

const GLYPHS = {
  service: gService, gateway: gGateway, datastore: gDatastore, queue: gQueue,
  cache: gCache, client: gClient, external: gExternal, compute: gCompute, note: gNote,
  formula: gFormula, blob: gBlob, vessel: gVessel, particle: gParticle, source: gSource,
};

export const KINDS = Object.keys(GLYPHS);

export function drawNode(n, box) {
  const kind = GLYPHS[n.kind] ? n.kind : 'service';
  const m = bodyOf(n.body, kind);
  const seed = hashSeed(n.id || n.label || 'n') % 100000;
  return GLYPHS[kind](box, n, m, seed);
}

/* A boundary is drawn under everything it contains: a loose dashed enclosure
   with its name on a tab, for a VPC, a bounded context, a trust zone. */
export function drawBoundary(b, box) {
  const { x, y, w, h } = box;
  const seed = hashSeed(b.id || b.label || 'b') % 100000;
  const d = roughRect(x, y, w, h, 16, { seed, amp: 1.4, step: 34 });
  const lab = lettering(b.label || '');
  const tw = lab.length * 7.4 + 20;
  const tab = roughRect(x + 16, y - 11, tw, 22, 7, { seed: seed + 3, amp: 0.8 });
  return `<g class="boundary">` +
    fill(d, '#ffffff', { opacity: 0.35 }) +
    stroke(d, { w: 1.5, color: MUTED, dash: '10 8' }) +
    fill(tab, b.tint || '#f8f6f0') + stroke(tab, { w: 1.3, color: MUTED }) +
    text(x + 16 + tw / 2, y + 4.5, lab, { size: 10.5, color: MUTED, weight: 700, spacing: 0.12 }) +
    `</g>`;
}

export { castShadow, labelBlock, ACCENT };
