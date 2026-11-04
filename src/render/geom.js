// @ts-check
/* ============================================================
   spiega geom — the few measurements placement is made of.

   Shared by the callout planner and the floating-text pass, which ask the
   same two questions of every candidate many times over: does this line run
   through that box, and how near does it come. Answered exactly, from the
   segments, rather than by walking each line in small steps — on a board of
   any size the walk was most of the time a render took.
   ============================================================ */

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/* Does the segment p–q pass through the rectangle? Clipped against each slab
   in turn (Liang–Barsky), so a line that only grazes a corner is a miss. */
/**
 * @param {number[]} p
 * @param {number[]} q
 * @param {Rect} r
 * @returns {boolean}
 */
export function cuts(p, q, r) {
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [d, lo, hi, o] of /** @type {[number, number, number, number][]} */ ([
    [dx, r.x, r.x + r.w, p[0]], [dy, r.y, r.y + r.h, p[1]]])) {
    if (Math.abs(d) < 1e-9) { if (o <= lo || o >= hi) return false; continue; }
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * @param {number[][]} pts
 * @param {Rect} r
 * @returns {boolean}
 */
export const wireCuts = (pts, r) => pts.some((p, i) => i > 0 && cuts(pts[i - 1], p, r));

/* How far a point is from the segment a–b. */
/**
 * @param {number[]} p
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function toSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/* How far a point is from a polyline. */
/**
 * @param {number[]} p
 * @param {number[][]} pts
 * @returns {number}
 */
export function toLine(p, pts) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, toSegment(p, pts[i - 1], pts[i]));
  return d;
}
