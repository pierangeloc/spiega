/* Routing must leave visible paper between an arrow and an unrelated box. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { specToOps } from '../src/spec.js';
import { renderSVG } from '../src/render/render.js';
import { planEdges } from '../src/render/edges.js';
import { buriedArrows, crossings, grazingArrows } from '../src/render/audit.js';

const spec = JSON.parse(fs.readFileSync(new URL('./boards/issue-113-three-hops-one-pair.json', import.meta.url)));
const board = emptyBoard();
assert.deepEqual(applyOps(board, specToOps(spec)).errors, []);
const drawing = renderSVG(board, { margin: 16 });
assert.deepEqual(grazingArrows(drawing), [], 'the reported ch>db line must clear corrections-api');
assert.deepEqual(buriedArrows(drawing), []);
assert.equal(crossings(drawing.planned), 0);
assert.ok(drawing.width <= 1675, `clearance must not widen the reported board: ${drawing.width}`);

// Here the unrelated box is above the line rather than below it, and the
// source approaches from below. Both final and initial runs must be checked.
const boxes = {
  a: { x: 0, y: 200, w: 100, h: 60, col: 0 },
  middle: { x: 250, y: 116, w: 100, h: 70, col: 1 },
  b: { x: 500, y: 160, w: 100, h: 60, col: 2 },
};
const planned = planEdges([{ from: 'a', to: 'b' }], boxes);
assert.deepEqual(grazingArrows({ boxes, planned }), [], 'the line must also clear a box above it');
assert.deepEqual(buriedArrows({ boxes, planned }), []);
assert.equal(crossings(planned), 0);
const knee = planned[0].pts[1][0];
assert.ok(knee >= boxes.middle.x + boxes.middle.w + 10, 'the knee moves past the other end of the box');
assert.ok(knee <= planned[0].pts.at(-1)[0], 'the knee stays inside the existing gutter span');

// A line on the rim has zero clearance and must not be ignored as though it
// were already clear. Its end is level with the unrelated box's bottom.
const onRim = { ...boxes, b: { ...boxes.b, y: 156 } };
const rimRoute = planEdges([{ from: 'a', to: 'b' }], onRim);
assert.deepEqual(grazingArrows({ boxes: onRim, planned: rimRoute }), []);
assert.deepEqual(buriedArrows({ boxes: onRim, planned: rimRoute }), []);

// A single knee past the graze would bury the line in another box. The
// intermediate row can clear both, but must not trade one bug for two.
const blocked = { ...boxes, blocker: { x: 300, y: 210, w: 50, h: 40, col: 1 } };
const stuck = planEdges([{ from: 'a', to: 'b' }], blocked);
assert.deepEqual(grazingArrows({ boxes: blocked, planned: stuck }), []);
assert.deepEqual(buriedArrows({ boxes: blocked, planned: stuck }), []);

// The only clear knee would cross this short vertical line between c and d.
// The two end boxes themselves are clear of both candidate horizontal runs.
const crossed = { ...boxes,
  c: { x: 300, y: 200, w: 40, h: 10, col: 1 },
  d: { x: 300, y: 248, w: 40, h: 10, col: 1 },
};
const guarded = planEdges([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], crossed);
assert.deepEqual(grazingArrows({ boxes: crossed, planned: guarded }).map(g => g.box), ['middle']);
assert.equal(crossings(guarded), 0, 'a graze is not fixed by creating a line crossing');
assert.deepEqual(buriedArrows({ boxes: crossed, planned: guarded }), []);

// An explicit straight route belongs to its author, not this knee selector.
const straight = planEdges([{ from: 'a', to: 'b', bend: 'straight' }], boxes);
assert.equal(straight[0].pts.length, 2);

// A board with no graze keeps its original knee, rather than moving for air
// it already has and introducing an unnecessary crossing or label change.
const clear = { ...boxes, middle: { ...boxes.middle, y: 60 } };
const unchanged = planEdges([{ from: 'a', to: 'b' }], clear);
assert.equal(unchanged[0].pts[1][0], 108 + (492 - 108) * 0.42);

// Both ways to turn once are wrong: above the lower box grazes the upper
// one, while turning before the column sends the final run through the lower
// box. A short intermediate run between them clears both.
const channel = {
  from: { x: 60, y: 105.72, w: 149, h: 60, col: 0 },
  upper: { x: 400, y: 64, w: 120, h: 63, col: 1 },
  lower: { x: 400, y: 189, w: 120, h: 60, col: 1 },
  to: { x: 1033, y: 213.88, w: 130, h: 60, col: 2 },
};
const throughChannel = planEdges([{ from: 'from', to: 'to' }], channel);
assert.deepEqual(grazingArrows({ boxes: channel, planned: throughChannel }), [], 'a two-knee detour clears the upper box');
assert.deepEqual(buriedArrows({ boxes: channel, planned: throughChannel }), [], 'the detour stays above the lower box');
assert.ok(throughChannel[0].pts.every(([x]) => x >= throughChannel[0].pts[0][0] && x <= throughChannel[0].pts.at(-1)[0]));
assert.ok(throughChannel[0].pts.every(([, y]) => y >= 64 && y <= 273.88), 'the detour stays inside the board height');

// Mirror the same channel: the choice must not assume left-to-right routing.
const mirror = Object.fromEntries(Object.entries(channel).map(([id, box]) => [id,
  { ...box, x: 1163 - box.x - box.w, col: 2 - box.col }]));
const mirrored = planEdges([{ from: 'from', to: 'to' }], mirror);
assert.deepEqual(grazingArrows({ boxes: mirror, planned: mirrored }), []);
assert.deepEqual(buriedArrows({ boxes: mirror, planned: mirrored }), []);

// A reserved settle row is part of the layout, not an automatic knee to
// replace even if it happens to run close to the upper box.
const via = { x: 400, y: 132, w: 120, h: 0, col: 1 };
const reserved = planEdges([{ from: 'from', to: 'to' }], channel, { 'from>to': [via] });
assert.ok(reserved[0].pts.some(([, y]) => y === via.y));
assert.equal(grazingArrows({ boxes: channel, planned: reserved }).some(g => g.box === 'upper'), true);
console.log('  ok  unrelated boxes have clearance above and below without widening or collisions');
