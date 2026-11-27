/* ============================================================
   spiega map links — the ink between two cards.

   Where a link starts, where it stops and which way its head points are one
   decision, so they are made in one place. They used to be made inline in the
   page's drawing code, with the head's direction written down beside the
   branch that assumed it: "the card below" meant straight down, "the next card
   in the row" meant straight across. A strip that wraps broke the first, and
   cards that are not the same height broke the second, and the line went where
   the geometry said while the head went where the comment did (#196).

   This file is loaded by the browser. No `node:` imports, ever — see the
   warning at the top of state.js.
   ============================================================ */

import { arrowHead, hashSeed, roughLine, stroke } from '../render/ink.js';
import type { MapLink } from './map.js';

/** A card's box on the map, in the coordinates of the strip. */
export type Rect = { x: number, y: number, w: number, h: number };

/** The path data to draw, where the label belongs, and the way the head faces. */
export type LinkInk = { d: string, mid: number[], angle: number };

/* Two cards are in one row when their tops agree to within a few pixels; the
   rows of a wrapped strip are a card apart, so nothing near this is ambiguous. */
export const sameRow = (a: Rect, b: Rect): boolean => Math.abs(a.y - b.y) < 8;

/* When a word cannot fit between cards, bias its clear space below the link.
   The space above a row often carries a different, wrapped-row link. */
export function mapLabelHome(mid: number[], w: number, h: number, gutter: number | null): number[] {
  if (gutter !== null && w > gutter) return [mid[0], mid[1] + 8];
  return gutter !== null && gutter < 60 ? [mid[0], mid[1] - h / 2 - 5] : mid;
}

/** Place measured pills close to their links without covering cards or each other. */
export function placeMapLabels(labels: { mid: number[], w: number, h: number }[], cards: Rect[]): Rect[] {
  const placed: Rect[] = [];
  for (const label of labels) {
    const home = { x: label.mid[0] - label.w / 2, y: label.mid[1] - label.h / 2, w: label.w, h: label.h };
    const obstacles = [...cards, ...placed];
    const clear = ({ x, y }: { x: number, y: number }): boolean => !obstacles.some(r =>
      x < r.x + r.w + 2 && x + label.w + 2 > r.x &&
      y < r.y + r.h + 2 && y + label.h + 2 > r.y);
    if (home.x >= 0 && home.y >= 0 && clear(home)) { placed.push(home); continue; }
    const xs = [Math.max(0, home.x)], ys = [Math.max(0, home.y)];
    for (const r of obstacles) {
      xs.push(r.x - label.w - 2, r.x + r.w + 2);
      ys.push(r.y - label.h - 2, r.y + r.h + 2);
    }
    const candidates = xs.flatMap(x => ys.filter(y => x >= 0 && y >= 0).map(y => ({ x, y })));
    candidates.sort((a, b) => (a.x - home.x) ** 2 + (a.y - home.y) ** 2 -
      ((b.x - home.x) ** 2 + (b.y - home.y) ** 2));
    const best = candidates.find(clear);
    // The candidates include a point beyond every obstacle, so one always fits.
    if (best) placed.push({ ...best, w: label.w, h: label.h });
  }
  return placed;
}

/* A displaced pill needs a visible tie to its own line, not merely the nearest
   empty patch of paper. The tie is omitted if it would run through a card or
   another pill; unlike the arrow, it is an annotation rather than a route. */
export function mapLabelLeader(mid: number[], pill: Rect, obstacles: Rect[], link: MapLink): string {
  const [x1, y1] = mid;
  const x = Math.max(pill.x, Math.min(x1, pill.x + pill.w));
  const y = Math.max(pill.y, Math.min(y1, pill.y + pill.h));
  if (Math.hypot(x - x1, y - y1) <= 8) return '';
  const crosses = (r: Rect, x2: number, y2: number): boolean => {
    const dx = x2 - x1, dy = y2 - y1;
    let lo = 0, hi = 1;
    for (const [origin, delta, min, max] of [[x1, dx, r.x, r.x + r.w], [y1, dy, r.y, r.y + r.h]]) {
      if (delta === 0) { if (origin <= min || origin >= max) return false; continue; }
      const a = (min - origin) / delta, b = (max - origin) / delta;
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      if (lo >= hi) return false;
    }
    return true;
  };
  const ends = [[x, y], [pill.x, y], [pill.x + pill.w, y], [x, pill.y], [x, pill.y + pill.h],
    [pill.x, pill.y], [pill.x + pill.w, pill.y], [pill.x, pill.y + pill.h], [pill.x + pill.w, pill.y + pill.h]];
  ends.sort((a, b) => Math.hypot(a[0] - x1, a[1] - y1) - Math.hypot(b[0] - x1, b[1] - y1));
  const end = ends.find(([ex, ey]) => !obstacles.some(r => crosses(r, ex, ey)));
  if (!end) return '';
  const [x2, y2] = end;
  return `<line class="mapleader" data-link="${link.from}-${link.to}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
    `stroke="#857d6e" stroke-width="1.2"/><circle cx="${x1}" cy="${y1}" r="2" fill="#857d6e"/>`;
}

export function linkInk(a: Rect, b: Rect, link: MapLink): LinkInk {
  const seed = hashSeed(`${link.from}>${link.to}`);
  const shared = link.shared.length > 0;
  const style = { w: shared ? 1.7 : 1.3, dash: shared ? null : '7 6', opacity: shared ? 1 : 0.5 };
  const row = sameRow(a, b), next = link.to === link.from + 1;
  if (next) {
    /* Across the gutter when the cards share a row, down into the top of the
       next one when they do not. Either way the head takes its direction off
       the line it ends, because the two cards are only *usually* centred on
       each other: a wrapped strip sends the hop from the end of one row to the
       start of the next, a long diagonal. */
    const p = row ? [a.x + a.w, a.y + a.h / 2] : [a.x + a.w / 2, a.y + a.h];
    const q = row ? [b.x, b.y + b.h / 2] : [b.x + b.w / 2, b.y];
    const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
    return {
      d: stroke(roughLine(p, q, { seed }), style) + arrowHead(q, angle, { seed, w: style.w, size: 10 }),
      mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
      angle,
    };
  }
  const p = row ? [a.x + a.w / 2, a.y] : [a.x + a.w, a.y + a.h / 2];
  const q = row ? [b.x + b.w / 2, b.y] : [b.x + b.w, b.y + b.h / 2];
  const lift = row ? Math.min(84, Math.max(38, Math.abs(q[0] - p[0]) * 0.16)) : Math.min(96, 44 + (link.to - link.from) * 14);
  const c1 = row ? [p[0], p[1] - lift] : [p[0] + lift, p[1]];
  const c2 = row ? [q[0], q[1] - lift] : [q[0] + lift, q[1]];
  const angle = Math.atan2(q[1] - c2[1], q[0] - c2[0]);
  return {
    d: stroke(`M${p[0]} ${p[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${q[0]} ${q[1]}`, style) +
      arrowHead(q, angle, { seed, w: style.w, size: 10 }),
    mid: [(p[0] + 3 * c1[0] + 3 * c2[0] + q[0]) / 8, (p[1] + 3 * c1[1] + 3 * c2[1] + q[1]) / 8],
    angle,
  };
}
