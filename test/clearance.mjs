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

// If turning past the graze would bury the line in another box, keep the
// imperfect old route and let the audit say so; do not trade one bug for two.
const blocked = { ...boxes, blocker: { x: 300, y: 210, w: 50, h: 40, col: 1 } };
const stuck = planEdges([{ from: 'a', to: 'b' }], blocked);
assert.deepEqual(grazingArrows({ boxes: blocked, planned: stuck }).map(g => g.box), ['middle']);
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
console.log('  ok  unrelated boxes have clearance above and below without widening or collisions');
