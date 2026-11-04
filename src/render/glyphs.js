/* ============================================================
   spiega glyphs — one drawing per kind of thing on the board.

   Every glyph is built the same way, in this order, because that is the order a
   hand would lay it down and the order that reads correctly when the strokes
   animate on: cast shadow, body fill, thickness band, ink outline, detail, label.
   ============================================================ */

import { INK, MUTED, SHADOW, ACCENT, bodyOf, mix } from './theme.js';
import {
  roughRect, roughLine, roughEllipse, roughArc, roughPoly, roundedPts,
  stroke, fill, text, hashSeed, rng, wrapText, NOTE_LINES, lettering,
  nodeText, NODE_TITLE_LH, NODE_SUB_LH, tabSize, waver, round2 } from './ink.js';
import { measureMath, drawMath } from './math.js';

const SH_DX = 5, SH_DY = 6;          // the cast shadow sits down and to the left-ish
const R = 12;                         // default corner radius

/* The shadow is flat cobalt, never a blur: a blurred shadow is a screen effect,
   a flat offset one is what you get when you ink a shape twice on paper. */
const castShadow = (d, dx = SH_DX, dy = SH_DY) =>
  `<g class="shadow" transform="translate(${dx} ${dy})">${fill(d, SHADOW, { opacity: 0.17 })}</g>`;

/* A title and a sub, each wrapped (see nodeText), the block centred on `cy`. A
   title of one line over a sub of one line lands exactly where it always did;
   every extra line moves the block up by half a line so it grows both ways. */
const labelBlock = (cx, cy, title, subtitle, { titleSize = 13.5, color = INK } = {}) => {
  if (!title) return '';
  const t = nodeText(title, subtitle);
  const top = cy + (subtitle ? -3 : 4.5) - t.extra / 2;
  let out = t.title.map((ln, i) =>
    text(cx, top + i * NODE_TITLE_LH, ln, { size: titleSize, color, upper: true, spacing: 0.06 })).join('');
  const subTop = top + 16 + (t.title.length - 1) * NODE_TITLE_LH;
  out += t.sub.map((ln, j) =>
    text(cx, subTop + j * NODE_SUB_LH, ln, { size: 10, color: MUTED, weight: 500, spacing: 0.04 })).join('');
  return out;
};

/* A closed outline whose corners are corners.

   `roughPoly` rounds its corners, because `smooth` curves through the
   midpoints of the edges and a corner only ever appears as a control point.
   That is what makes the other glyphs soft, and it is right for them — a
   cloud has no corners to begin with. A shape that means "not that other
   shape" needs them sharp, so the edges are the same seeded wobble and the
   turns are turns. */
const sharpPoly = (pts, opts = {}) => {
  const p = waver([...pts, pts[0]], { step: 22, ...opts });
  return 'M' + p.map(([x, y]) => `${round2(x)} ${round2(y)}`).join('L') + 'Z';
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
/* A pentagon: the leading edge comes to a point at the side's midpoint, so
   a line that arrives anywhere else on that side meets air unless it knows
   the slant. */
function gatewayPts(box) {
  const { x, y, w, h } = box;
  const c = 14;
  return [
    [x + c, y], [x + w, y], [x + w, y + h], [x + c, y + h], [x, y + h / 2],
  ];
}

function gGateway(box, n, m, seed) {
  const { x, y, w, h } = box;
  const c = 14;
  const pts = gatewayPts(box);
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

/* A queue's words sit under the slots, not in them, so it is the strip below
   that grows when they wrap. */
function queueLabel(cx, bottom, n) {
  const t = nodeText(n.label, n.sub);
  const title = t.title.length ? t.title : [''];
  return title.map((ln, i) =>
      text(cx, bottom + 17 + i * NODE_TITLE_LH, ln, { size: 12, upper: true, spacing: 0.06 })).join('') +
    t.sub.map((ln, j) =>
      text(cx, bottom + 30 + (title.length - 1) * NODE_TITLE_LH + j * NODE_SUB_LH, ln,
        { size: 10, color: MUTED, weight: 500 })).join('');
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
    queueLabel(x + w / 2, y + h, n);
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
  const lines = n.lines || wrapText(n.label, 24, NOTE_LINES);
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

/* ---------- the field glyph ----------

   A field is a named value: a column of a CSV, a field of a message on a
   topic, a key in a config, a member of a DTO. It is about software, and it is
   not a piece of infrastructure — which the furniture above cannot say. A
   cylinder says durable storage and a row of slots says a queue, and a board
   that draws a field name as either asserts something the explanation does not
   mean. The four neutral glyphs below escape that by leaving software behind
   altogether; a field cannot, because it is a thing in the software.

   So it is drawn as what it is: a card with one corner notched, like a
   luggage tag or a form field. The notch is the whole of the reading — it
   says "a label for a value" where a plain rectangle would say "a component",
   and it says it without claiming to be any of the furniture. The corners
   are sharp, because a rounded rectangle is a service and this is not one. */

/* A notch is a bite taken out of the corner: the edge comes in, turns, and
   goes back out. The point sits deeper than the straight cut across the same
   corner would, so the bite is a notch and not a chamfer. */
function notchPts(x, y, w, h, side, d) {
  return side === 'left'
    ? [[x + d, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + d],
      [x + d * 0.42, y + d * 0.74]]
    : [[x, y], [x + w - d, y], [x + w - d * 0.42, y + d * 0.74], [x + w, y + d],
      [x + w, y + h], [x, y + h]];
}

function gField(box, n, m, seed, side) {
  const { x, y, w, h } = box;
  /* Deep enough to read as a notch from across a room, shallow enough that
     the card is still a card. */
  const d = Math.min(19, Math.max(11, Math.round(Math.min(w, h) * 0.32)));
  const body = sharpPoly(notchPts(x, y, w, h, side, d), { seed, amp: 0.9 });
  const t = Math.min(7, h * 0.16);
  const band = sharpPoly([[x, y + h - t], [x + w, y + h - t], [x + w, y + h], [x, y + h]],
    { seed: seed + 41, amp: 0.6 });
  /* The words sit below the notch, never under it: the bite is empty paper
     with the card's own outline around it, and a label crossing that reads as
     a mistake rather than as a tag. */
  const label = labelBlock(x + w / 2, y + h / 2 + 3, n.label, n.sub, { titleSize: 12.5 });
  return castShadow(body) + fill(body, m.l) + fill(band, m.m) +
    stroke(body, { w: 2 }) + label;
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
   on a flat base; this has no flat edge and no inside worth separating.

   The vertices wobble independently so the mass does not read as a clean
   ellipse, then each half is scaled out to its side of the box so the ink
   meets the box where a line arrives at a side's midpoint. Off that point the
   outline curves back inside the box; inkInset asks for these same points so
   a fanned line can follow the curve instead of stopping at the box. */
function blobPts(box, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2, r = rng(seed);
  const raw = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    const kx = 0.93 + r() * 0.07, ky = 0.78 + r() * 0.22;
    return [Math.cos(a) * kx, Math.sin(a) * ky];
  });
  const rx0 = Math.min(...raw.map(p => p[0])), rx1 = Math.max(...raw.map(p => p[0]));
  const ry0 = Math.min(...raw.map(p => p[1])), ry1 = Math.max(...raw.map(p => p[1]));
  return raw.map(([rx, ry]) => [
    cx + (rx < 0 ? rx / -rx0 : rx / rx1) * w * 0.5,
    cy + (ry < 0 ? ry / -ry0 : ry / ry1) * h * 0.5,
  ]);
}

function gBlob(box, n, m, seed) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2;
  const pts = blobPts(box, seed);
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
/* The bowl, its lip and its base, as the points both the drawing and the
   inset are taken from. The belly is narrower than the box, the rim narrower
   still, so an edge aimed at the box stops in the margin beside the bowl. */
function vesselGeom(box) {
  const { x, y, w, h } = box;
  const cx = x + w / 2;
  const top = y + 13, bottom = y + h - 7;
  const rimRX = Math.min(w * 0.29, 50);
  const bellyRX = Math.min(w * 0.4, 66);
  const baseRX = Math.min(w * 0.24, 40);
  const bellyY = y + h * 0.56;
  const lipRy = Math.min(7, h * 0.1);
  return {
    cx, top, bottom, rimRX, bellyRX, baseRX, bellyY, lipRy,
    body: [
      [cx - rimRX, top], [cx - bellyRX, bellyY], [cx - baseRX, bottom],
      [cx + baseRX, bottom], [cx + bellyRX, bellyY], [cx + rimRX, top],
    ],
    base: [
      [cx - baseRX, bottom], [cx + baseRX, bottom],
      [cx + baseRX - 4, bottom + 5], [cx - baseRX + 4, bottom + 5],
    ],
  };
}

function gVessel(box, n, m, seed) {
  const { y, h } = box;
  const g = vesselGeom(box);
  const { cx, top, bottom, rimRX, baseRX, lipRy } = g;
  const body = roughPoly(g.body, { seed, amp: 1.0, step: 22 });
  const lip = roughEllipse(cx, top, rimRX, lipRy, { seed: seed + 3, amp: 0.7 });
  const base = roughPoly(g.base, { seed: seed + 4, amp: 0.6 });
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
/* The orb, not the specks. The specks are a couple of pixels and say
   "particle"; the body an edge should meet is the circle, which sits in the
   upper part of a box sized for its label. */
function particleOrb(box) {
  const { x, y, w, h } = box;
  const r = Math.min(15, h * 0.22);
  return { cx: x + w / 2, cy: y + Math.min(20, h * 0.27), rx: r, ry: r * 0.94 };
}

function gParticle(box, n, m, seed) {
  const { y, h } = box;
  const { cx, cy, rx, ry } = particleOrb(box);
  const r = rx;
  const orb = roughEllipse(cx, cy, rx, ry, { seed });
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
/* The disc. The rays are strokes thrown off it; an edge meets the body. */
function sourceDisc(box) {
  const { x, y, w, h } = box;
  const r = Math.min(13, h * 0.19);
  return { cx: x + w / 2, cy: y + 21, rx: r, ry: r * 0.95 };
}

function gSource(box, n, m, seed) {
  const { y, h } = box;
  const { cx, cy, rx, ry } = sourceDisc(box);
  const r = rx;
  const disc = roughEllipse(cx, cy, rx, ry, { seed });
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
  formula: gFormula, field: gField, blob: gBlob, vessel: gVessel, particle: gParticle,
  source: gSource,
};

export const KINDS = Object.keys(GLYPHS);

const glyphSeed = n => hashSeed(n.id || n.label || 'n') % 100000;

/* `side` is the field glyph's notch side: which way the value runs. It is
   decided by the caller, which is the only place that knows the edges. */
export function drawNode(n, box, side = 'right') {
  const kind = GLYPHS[n.kind] ? n.kind : 'service';
  const m = bodyOf(n.body, kind);
  return GLYPHS[kind](box, n, m, glyphSeed(n), side);
}

/* How far a glyph's ink sits inside its box, at one station along a side,
   and whether that station has to slide along the side to meet the ink.

   `along` is the fraction of the half-extent from the centre, the same number
   sidePoint spreads a fan over. The answer is measured on the outline the
   glyph draws — the control polygon, not the hand's wobble on top of it — so
   a line stops GAP short of the shape, and the wobble stays the wobble.
   A ray that misses the ink slides to the nearest point of it: a particle's
   circle does not fill its box, and an arrow that stayed at the miss would
   stop in the margin while its neighbour landed on the circle. A rectangle
   is not listed, and answers nothing, which is why a board without one of
   these glyphs does not move. */
function polyHits(pts, horiz, at) {
  const closed = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
    ? pts : [...pts, pts[0]];
  const hits = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i], b = closed[i + 1];
    const a0 = horiz ? a[1] : a[0], b0 = horiz ? b[1] : b[0];
    if ((a0 - at) * (b0 - at) > 0 || a0 === b0) continue;
    const k = (at - a0) / (b0 - a0);
    if (k < 0 || k > 1) continue;
    const a1 = horiz ? a[0] : a[1], b1 = horiz ? b[0] : b[1];
    hits.push(a1 + (b1 - a1) * k);
  }
  return hits;
}

function ellipseHits(e, side, at) {
  if (side === 'left' || side === 'right') {
    const n = (at - e.cy) / e.ry;
    if (n * n > 1) return [];
    const dx = e.rx * Math.sqrt(Math.max(0, 1 - n * n));
    return [side === 'left' ? e.cx - dx : e.cx + dx];
  }
  const n = (at - e.cx) / e.rx;
  if (n * n > 1) return [];
  const dy = e.ry * Math.sqrt(Math.max(0, 1 - n * n));
  return [side === 'top' ? e.cy - dy : e.cy + dy];
}

/* The outlines an edge should stop short of. An ellipse is named so the hit
   is solved rather than sampled; everything else is a closed polyline. */
function outlinesOf(node, box) {
  const { x, y, w, h } = box;
  switch (node.kind) {
    case 'blob': return [blobPts(box, glyphSeed(node))];
    case 'vessel': {
      const g = vesselGeom(box);
      return [g.body, g.base, { ellipse: true, cx: g.cx, cy: g.top, rx: g.rimRX, ry: g.lipRy }];
    }
    case 'particle': return [{ ellipse: true, ...particleOrb(box) }];
    case 'source': return [{ ellipse: true, ...sourceDisc(box) }];
    case 'gateway': return [gatewayPts(box)];
    case 'external': return [cloudPts(x + 4, x + w - 4, y + h - 6, h)];
    default: return null;
  }
}

function ellipseSamples(e, n = 64) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [e.cx + e.rx * Math.cos(a), e.cy + e.ry * Math.sin(a)];
  });
}

/* Vertices alone miss the nearest point when it sits mid-edge. A step of a
   few pixels is closer than the hand's wobble, which is the tolerance the
   arrival is already allowed. */
function walk(pts) {
  const closed = pts.length > 1 ? [...pts, pts[0]] : pts;
  const out = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i], b = closed[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/* The extent of the ink along a side, in board coordinates. A fan that has
   collapsed is laid back out across this, so two arrows into a small disc
   stay two. Null for a rectangle: there is no ink inside the box to spread over. */
export function inkSpan(node, box, side) {
  const shapes = outlinesOf(node, box);
  if (!shapes) return null;
  const horiz = side === 'left' || side === 'right';
  let lo = Infinity, hi = -Infinity;
  for (const s of shapes) {
    for (const p of s.ellipse ? ellipseSamples(s, 48) : walk(s)) {
      const c = horiz ? p[1] : p[0];
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
  }
  return lo === Infinity ? null : { lo, hi };
}

export function inkAt(node, box, side, along) {
  const none = { inset: 0, slide: 0 };
  const shapes = outlinesOf(node, box);
  if (!shapes) return none;
  const horiz = side === 'left' || side === 'right';
  const { x, y, w, h } = box;
  const at = horiz ? y + h / 2 * (1 + along) : x + w / 2 * (1 + along);
  const hits = shapes.flatMap(s => s.ellipse ? ellipseHits(s, side, at) : polyHits(s, horiz, at));
  const edge = side === 'left' ? x : side === 'right' ? x + w : side === 'top' ? y : y + h;
  if (hits.length) {
    const ink = side === 'left' || side === 'top' ? Math.min(...hits) : Math.max(...hits);
    const inset = side === 'left' || side === 'top' ? ink - edge : edge - ink;
    return { inset: inset > 0 ? inset : 0, slide: 0 };
  }
  /* The ray misses. The nearest ink is where this arrow can still arrive
     without crossing the glyph to get there: GAP short of that point, on
     the side we came in on. */
  const station = horiz
    ? [side === 'left' ? x : x + w, at]
    : [at, side === 'top' ? y : y + h];
  let best = null, bestD = Infinity;
  for (const s of shapes) {
    for (const p of s.ellipse ? ellipseSamples(s) : walk(s)) {
      const d = (p[0] - station[0]) ** 2 + (p[1] - station[1]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  if (!best) return none;
  if (horiz) {
    const inset = side === 'left' ? best[0] - x : (x + w) - best[0];
    return { inset: inset > 0 ? inset : 0, slide: best[1] - at };
  }
  const inset = side === 'top' ? best[1] - y : (y + h) - best[1];
  return { inset: inset > 0 ? inset : 0, slide: best[0] - at };
}

/* A boundary is drawn under everything it contains: a loose dashed enclosure,
   for a VPC, a bounded context, a trust zone. */
/**
 * @param {{id?: string, label?: string, tint?: string}} b
 * @param {import('./layout.js').Box} box
 */
export function drawBoundary(b, box) {
  const { x, y, w, h } = box;
  const seed = hashSeed(b.id || b.label || 'b') % 100000;
  const d = roughRect(x, y, w, h, 16, { seed, amp: 1.4, step: 34 });
  return `<g class="boundary">` +
    fill(d, '#ffffff', { opacity: 0.35 }) +
    stroke(d, { w: 1.5, color: MUTED, dash: '10 8' }) +
    `</g>`;
}

/* And its name rides a card on the wall.

   The card slides along the top of the wall it belongs to, so the place it
   occupies is not a constant: render/floating.js places it against everything
   else that floats, and passes back where it went. Without that, two walls
   starting at the same height put their names in the same place and one of
   them was painted over the other: a boundary on the board that was named
   nowhere (#87).

   The cards are drawn after every wall, not with the wall they belong to. A
   dashed wall drawn over a card strikes the name through it, which is the
   same failure as a card drawn over a card, and two enclosures that share a
   wall are exactly where it happens. */
/**
 * @param {{id?: string, label?: string, tint?: string}} b
 * @param {import('./layout.js').Box} box
 * @param {{x: number, y: number, w: number, h: number}|null} [tab]
 * @param {string} [name] what the card says, when it is not the boundary's own
 *   label: a piece of a split boundary says which piece it is
 */
export function drawBoundaryCard(b, box, tab = null, name = b.label) {
  const { x, y } = box;
  const seed = hashSeed(b.id || b.label || 'b') % 100000;
  const lab = lettering(name || '');
  const { w: tw, h: th } = tabSize(name);
  const tx = tab ? tab.x : x + 16;
  const ty = tab ? tab.y : y - 11;
  const card = roughRect(tx, ty, tw, th, 7, { seed: seed + 3, amp: 0.8 });
  return `<g class="boundary-card">` +
    fill(card, b.tint || '#f8f6f0') + stroke(card, { w: 1.3, color: MUTED }) +
    text(tx + tw / 2, ty + th / 2 + 4.5, lab, { size: 10.5, color: MUTED, weight: 700, spacing: 0.12 }) +
    `</g>`;
}

export { castShadow, labelBlock, ACCENT };
