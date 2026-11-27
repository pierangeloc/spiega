/* Reproduce and classify the seed-217 synthetic routing sample from #217.
   Run `pnpm run build && node dist/tools/clearance-sample.js`. `--use` loads
   an alternate built edges module; `--compare` additionally measures it on
   the same boxes. Paths are relative to this built script, or absolute URLs.
   This deliberately generates only forward, un-authored edges; it does not
   estimate the frequency of authored, back-edge or waypoint routes. */
import { planEdges } from '../src/render/edges.js';
import { CLEARANCE, grazingArrows, buriedArrows, crossings } from '../src/render/audit.js';

let seed = 217;
const rand = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
const sample = () => {
  const boxes = {}, cols = [];
  for (let col = 0; col < 4; col++) {
    const ids = [], count = 1 + rand(3);
    let y = 50 + rand(60);
    for (let i = 0; i < count; i++) {
      const id = `n${col}_${i}`;
      boxes[id] = { x: 60 + col * 320 + rand(20), y, w: 120 + rand(30), h: 60 + rand(20), col };
      y += 125;
      ids.push(id);
    }
    cols.push(ids);
  }
  const edges = [];
  for (let i = 0; i < 7; i++) {
    const col = rand(3), target = col + 1 + rand(3 - col);
    const from = cols[col][rand(cols[col].length)], to = cols[target][rand(cols[target].length)];
    if (!edges.some(e => e.from === from && e.to === to)) edges.push({ from, to });
  }
  return { boxes, edges };
};

const distance = (pts, b) => Math.min(...pts.slice(1).map((p, i) => {
  const q = pts[i];
  return Math.hypot(Math.max(b.x - Math.max(p[0], q[0]), 0, Math.min(p[0], q[0]) - b.x - b.w),
    Math.max(b.y - Math.max(p[1], q[1]), 0, Math.min(p[1], q[1]) - b.y - b.h - (b.labelBelow || 0)));
}));
const pointDistance = (p, b) => Math.hypot(Math.max(b.x - p[0], 0, p[0] - b.x - b.w),
  Math.max(b.y - p[1], 0, p[1] - b.y - b.h));
const overlaps = (a, b) => a.slice(1).some((q, i) => b.slice(1).some((t, j) => [0, 1].some(axis => {
  const p = a[i], s = b[j], other = 1 - axis;
  return p[other] === q[other] && s[other] === t[other] && p[other] === s[other] &&
    Math.min(Math.max(p[axis], q[axis]), Math.max(s[axis], t[axis])) >
    Math.max(Math.min(p[axis], q[axis]), Math.min(s[axis], t[axis]));
})));

/* Classify one edge/box graze. For ordinary knees, test exactly the same
   candidate set and safety checks as the router, but ask which constraint
   prevents clearing this particular box. The categories are ordered and
   exclusive; they do not assert that the first blocker is the only blocker. */
function cause(g, r, boxes, planned) {
  if (r.e.bend === 'straight') return 'authored straight';
  if (r.back) return 'back edge';
  if (r.via?.length) return 'waypoint';
  if (r.pts.length === 2) return 'automatic straight';
  if (r.pts.length === 6) return 'two-knee detour still grazes';
  if (r.pts.length !== 4 || !['left', 'right'].includes(r.sa)) return 'other route';
  const a = r.pts[0], b = r.pts.at(-1), target = boxes[g.box];
  if (pointDistance(a, target) < CLEARANCE || pointDistance(b, target) < CLEARANCE) return 'endpoint too close';
  const obstacles = Object.entries(boxes).filter(([id]) => id !== r.e.from && id !== r.e.to).map(([, box]) => box);
  const old = obstacles.map(box => distance(r.pts, box));
  const candidates = obstacles.flatMap(box => [box.x - CLEARANCE - 2, box.x + box.w + CLEARANCE + 2])
    .filter(x => x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]))
    .map(x => [a, [x, a[1]], [x, b[1]], b])
    .filter(pts => distance(pts, target) >= CLEARANCE);
  if (!candidates.length) return 'no enumerated knee clears target';
  const boxSafe = candidates.filter(pts => obstacles.every((box, i) => {
    const d = distance(pts, box);
    return !(d === 0 && old[i] > 0) && !(d < CLEARANCE && old[i] >= CLEARANCE);
  }));
  if (!boxSafe.length) return 'candidate introduces box graze/collision';
  const lineSafe = boxSafe.filter(pts => planned.every(other => other === r ||
    (crossings([{ ...r, pts }, other]) <= crossings([r, other]) &&
      (!overlaps(pts, other.pts) || overlaps(r.pts, other.pts)))));
  if (!lineSafe.length) return 'candidate introduces line crossing/overlap';
  const deficit = ds => ds.reduce((sum, d) => sum + Math.max(0, CLEARANCE - d), 0);
  if (!lineSafe.some(pts => deficit(obstacles.map(box => distance(pts, box))) < deficit(old)))
    return 'candidate does not improve total deficit';
  return 'safe improving candidate after sequential routing';
}

const compareIndex = process.argv.indexOf('--compare');
const baseline = compareIndex < 0 ? null : (await import(process.argv[compareIndex + 1])).planEdges;
const useIndex = process.argv.indexOf('--use');
const planner = useIndex < 0 ? planEdges : (await import(process.argv[useIndex + 1])).planEdges;
const counts = { 'authored straight': 0, 'back edge': 0, waypoint: 0, 'automatic straight': 0 }, examples = {};
let grazes = 0, grazingRoutes = 0, affectedBoards = 0, buried = 0, crossed = 0;
const comparison = { grazes: 0, grazingRoutes: 0, affectedBoards: 0, buried: 0, crossings: 0,
  moreBuried: 0, moreCrossings: 0, moreGrazes: 0 };
for (let i = 0; i < 1000; i++) {
  const { boxes, edges } = sample(), planned = planner(edges, boxes);
  const found = grazingArrows({ boxes, planned });
  affectedBoards += Number(found.length > 0);
  grazes += found.length;
  grazingRoutes += new Set(found.map(g => g.edge)).size;
  buried += buriedArrows({ boxes, planned }).length;
  crossed += crossings(planned);
  if (baseline) {
    const prev = baseline(edges, boxes);
    const oldGrazes = grazingArrows({ boxes, planned: prev });
    const pg = oldGrazes.length, pb = buriedArrows({ boxes, planned: prev }).length;
    const pc = crossings(prev), nb = buriedArrows({ boxes, planned }).length, nc = crossings(planned);
    comparison.grazes += pg; comparison.grazingRoutes += new Set(oldGrazes.map(g => g.edge)).size;
    comparison.affectedBoards += Number(pg > 0);
    comparison.buried += pb; comparison.crossings += pc;
    comparison.moreBuried += Number(nb > pb); comparison.moreCrossings += Number(nc > pc);
    comparison.moreGrazes += Number(found.length > pg);
  }
  for (const g of found) {
    const r = planned.find(route => route.key === g.edge);
    const kind = cause(g, r, boxes, planned);
    counts[kind] = (counts[kind] || 0) + 1;
    examples[kind] ||= { index: i, graze: g, boxes, edges, pts: r.pts };
  }
}
console.log(JSON.stringify({ seed: 217, boards: 1000, affectedBoards, grazes, grazingRoutes, buried, crossings: crossed, counts,
  ...(baseline ? { comparison } : {}) }, null, 2));
if (process.argv.includes('--examples')) console.log(JSON.stringify(examples, null, 2));
