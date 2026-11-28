/* What the drawing came out like, and who is told (#56).

   Run with `node test/audit.mjs`. Its own process because the state directory
   is read once, at import, from HOME: these tests want a temp home.

   The thing being protected here is not the arithmetic, which is crude on
   purpose. It is the shape of the answer. An agent reads one string after it
   draws, and that string has to stay useful: counts first, nothing added when
   the board is clean, and no sentence that tells the agent what to do about
   it. A report that fired on every batch would be skipped, and a report that
   said "this board is unreadable" would be claiming something nobody can
   compute from a drawing. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-audit-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer } = await import('../src/board/server.js');
const { emptyBoard, applyOps } = await import('../src/board/state.js');
const { renderSVG } = await import('../src/render/render.js');
const { specToOps } = await import('../src/spec.js');
const { audit, report, measuredWarnings, measuredOf, grazingArrows, smallText, CROSSINGS_FLOOR, CLEARANCE, TEXT_FLOOR, SUB_FLOOR } =
  await import('../src/render/audit.js');

let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

const specs = dir => fs.readdirSync(path.join(ROOT, dir))
  .filter(f => f.endsWith('.json') && f !== 'manifest.json')
  .map(f => [`${dir}/${f}`, JSON.parse(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))]);

const drawn = spec => {
  const b = emptyBoard();
  const { errors } = applyOps(b, specToOps(spec));
  if (errors.length) throw new Error(errors.join('; '));
  return b;
};
const auditOf = spec => audit(spec, renderSVG(drawn(spec), { margin: 16 }));

/* The board the audit was built to be able to describe. Nothing on it prints
   over anything — which is why three counts could be returned for it in good
   faith — and one of its arrows still runs underneath two boxes it has nothing
   to do with. */
await test('the board in test/boards says exactly which arrows run under a box', async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8'));
  const found = auditOf(spec);
  assert.deepEqual(found.over, [], 'no label on this board prints over anything, and that was the problem');
  assert.deepEqual(found.buried.map(b => `${b.edge} through ${b.box}`),
    ['r7>ext through risk', 'r7>ext through n2'],
    'the arrow from rule 7 passes under the risk budget and under the note');
  assert.deepEqual(report(found), [
    '2 labels sit on a line that is not their own: "FIRST MONTH VS SECOND MONTH" on store>r1, "OVER BUDGET" on r2>cost',
    '2 arrows cross a box that is not an end of it: r7>ext through risk, r7>ext through n2',
  ], 'and that is the whole of what the agent is told: the condition, the count, no advice');
});

/* A label on somebody else's line is what the placement pass falls back to
   when nothing is clear, and it was left out of the first report for that
   reason — "legible, only worse". A board drawn in anger said otherwise: the
   reader could not tell which of two arrows `2 BURNS FAST` belonged to, the
   person had to say so, and the agent had been told nothing (#103). */
await test('a label on a line that is not its own is named, not counted', async () => {
  const one = report({ astray: [{ kind: 'tag', text: 'burns fast', on: 'fat>energy' }] });
  assert.deepEqual(one, ['1 label sits on a line that is not its own: "burns fast" on fat>energy']);

  const many = report({ astray: Array.from({ length: 6 },
    (_, i) => ({ kind: 'tag', text: `label ${i}`, on: `a>b${i}` })) });
  assert.match(many[0], /^6 labels sit on a line that is not their own: /);
  assert.equal((many[0].match(/ on a>b/g) || []).length, 4, 'four named');
  assert.match(many[0], /, and 2 more$/);
});

/* It has to stay rare enough to be read. Measured before it was switched on:
   1 of 19 committed boards and 36 of 200 random boards of real size — against
   ~70% of random boards for an arrow through a foreign box. */
await test('the boards that are meant to look good have no stray labels', async () => {
  const stray = [];
  for (const [name, spec] of [...specs('test/boards'), ...specs('examples')]) {
    if (name.includes('issue-56-arrow-under-box')) continue;   // the known-bad one
    for (const a of auditOf(spec).astray) stray.push(`${name}: "${a.text}" on ${a.on}`);
  }
  assert.deepEqual(stray, []);
});

/* Every other committed board is clean on this axis, which is what makes the
   measurement worth reporting at all: a number that is never zero says
   nothing. If a change to edge routing buries an arrow on one of these, this
   is where it is noticed. */
await test('no other committed board or example runs an arrow under a box', async () => {
  const dirty = [];
  for (const [name, spec] of [...specs('test/boards'), ...specs('examples')]) {
    if (name.includes('issue-56-arrow-under-box')) continue;
    const found = auditOf(spec);
    for (const b of found.buried) dirty.push(`${name}: ${b.edge} through ${b.box}`);
    assert.ok(found.crossings <= CROSSINGS_FLOOR,
      `${name} crosses ${found.crossings} pairs of lines, at or under the floor of ${CROSSINGS_FLOOR} is expected`);
  }
  assert.deepEqual(dirty, []);
});

/* A clean board must not grow a wall of "0 problems" under its counts. The
   floor is here for the same reason: every committed board sits at two
   crossings or fewer, and a line that fires on every batch is a line that
   stops being read. */
await test('a clean board adds nothing, and one crossing is not worth saying', async () => {
  const clean = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/order-flow.json'), 'utf8'));
  const found = auditOf(clean);
  assert.deepEqual(found.buried, []);
  assert.deepEqual(report(found), []);
  assert.deepEqual(report({ crossings: CROSSINGS_FLOOR }), [], 'at the floor, still silence');
  assert.deepEqual(report({ crossings: CROSSINGS_FLOOR + 1 }), [`${CROSSINGS_FLOOR + 1} pairs of lines cross`]);
});

/* Four named, then a count. The board that provokes this is the one with
   fifteen of them, and a report longer than the sentence it interrupts does
   not get read. */
await test('a tangle names a few and counts the rest', async () => {
  const buried = Array.from({ length: 7 }, (_, i) => ({ edge: `a>b${i}`, box: `n${i}` }));
  const [line] = report({ buried });
  assert.match(line, /^7 arrows cross a box that is not an end of it: /);
  assert.equal((line.match(/through/g) || []).length, 4);
  assert.match(line, /, and 3 more$/);
  assert.match(report({ buried: buried.slice(0, 1) })[0], /^1 arrow crosses a box that is not an end of it: a>b0 through n0$/);
});

/* ---------- what the reader will not make out (#209, #216) ---------- */

const board = name => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

/* The router now fixes the reported knee, but authored straight lines cannot
   be rerouted. The audit must still warn about a graze it cannot move. */
const grazeSpec = () => {
  const spec = board('test/boards/issue-113-three-hops-one-pair.json');
  spec.edges.find(e => e.from === 'ch' && e.to === 'db').bend = 'straight';
  return spec;
};
const twoUnitGraze = () => ({
  boxes: { corr: { x: 100, y: 102, w: 100, h: 70 } },
  planned: [{ key: 'ch>db', pts: [[0, 100], [300, 100]] }],
});
await test('an arrow that runs 2 units over a box it does not touch is named, with the gap', async () => {
  const grazed = grazingArrows(twoUnitGraze());
  assert.deepEqual(grazed, [{ edge: 'ch>db', box: 'corr', gap: 2, side: 'above' }]);
  assert.deepEqual(measuredWarnings({ grazed }), [
    '1 arrow passes close enough to a box that is not an end of it to read as touching it, most of all when lit: ' +
    'ch>db, 2 units above corr',
  ]);
});

/* The corrected ordinary route no longer grazes, but the wider pills from
   #215 still make this board's labels land under the reference-screen floor. */
await test('the corrected reported board still warns about its fit', async () => {
  const found = auditOf(board('test/boards/issue-113-three-hops-one-pair.json'));
  assert.deepEqual(found.grazed, []);
  assert.deepEqual(measuredWarnings(found), [
    'at 1440×900 this board fits at 86%, so its labels land at 11.6px, under 12; ' +
    'a chapter break is where the rest of it goes',
  ]);
});

/* The same line, the same box, with paper between them: silence. And the
   threshold is the threshold — a gap of exactly CLEARANCE is clear. */
await test('the same arrow clearing the same box comfortably says nothing', async () => {
  const r = twoUnitGraze();
  const lowered = by => ({ ...r, boxes: { ...r.boxes, corr: { ...r.boxes.corr, y: r.boxes.corr.y + by } } });
  assert.deepEqual(grazingArrows(lowered(30)), [], '32 units of paper between them');
  assert.deepEqual(grazingArrows(lowered(CLEARANCE - 2)), [], 'exactly at the threshold is clear');
  assert.equal(grazingArrows(lowered(CLEARANCE - 3)).length, 1, 'and one unit closer is not');
  assert.deepEqual(measuredWarnings({ grazed: grazingArrows(lowered(30)) }), []);
});

await test('no committed board or example runs an arrow close by a box', async () => {
  const close = [];
  for (const [name, spec] of [...specs('test/boards'), ...specs('examples')]) {
    for (const g of auditOf(spec).grazed) close.push(`${name}: ${g.edge} ${g.gap} ${g.side} ${g.box}`);
  }
  assert.deepEqual(close, []);
});

/* The arithmetic, on a drawing with nothing else in it: the page fits the
   board into 1440×900 and never zooms in, and each kind of lettering on a box
   is measured against its own floor — a label against 12, the greyed sub
   under it against 10. */
const MUTED = '#857d6e';
const lettered = (width, height, ...texts) => ({
  svg: texts.map(([size, fill = '#231e16'], i) =>
    `<g data-node="n${i}"><text x="0" y="0" fill="${fill}" font-size="${size}">A</text></g>`).join(''),
  width, height, offset: { x: 0, y: 0 }, boxes: {}, planned: [],
});
const boxed = (width, height) => lettered(width, height, [13.5], [10, MUTED]);

await test('text is measured on the reference screen, each kind against its own floor', async () => {
  assert.deepEqual(smallText(boxed(2880, 300)), { fit: 0.5, below: [
    { of: 'labels', px: 6.75, floor: TEXT_FLOOR }, { of: 'subs', px: 5, floor: SUB_FLOOR },
  ] }, 'half as wide as the screen fits at half');
  assert.deepEqual(smallText(boxed(600, 1800)).fit, 0.5, 'and so does twice as tall');
  assert.equal(smallText(boxed(400, 300)), null, 'a board shown at full size is never shrunk, whatever its sizes');
  assert.equal(smallText(lettered(400, 300, [9.5], [8, MUTED])), null, 'not even one lettered under both floors');
});

/* The board the old check got wrong both ways: a label that clears its floor
   by a hair kept it quiet about subs no one could read. */
await test('a board whose labels clear the floor is still told its subs do not', async () => {
  const width = 1440 * 13.5 / TEXT_FLOOR;
  assert.deepEqual(smallText(boxed(width, 300)).below.map(b => b.of), ['subs'],
    'a label landing exactly on its floor is not under it; the sub under it is');
  assert.deepEqual(measuredWarnings({ small: smallText(boxed(width, 300)) }), [
    'at 1440×900 this board fits at 89%, so its subs land at 8.9px, under 10; a chapter break is where the rest of it goes',
  ]);
  assert.deepEqual(measuredWarnings({ small: smallText(boxed(4114, 300)) }), [
    'at 1440×900 this board fits at 35%, so its labels land at 4.7px, under 12, and its subs at 3.5px, under 10; ' +
    'a chapter break is where the rest of it goes',
  ]);
});

/* Measured at the largest, one formula held a board of labels over the
   floor; measured at the smallest, one blob that shrank its own long word
   would speak for the whole board. */
await test('a kind of lettering is measured at the size most of it is set in', async () => {
  const formula = lettered(1800, 300, [17], [13.5], [13.5], [13.5]);
  assert.deepEqual(smallText(formula).below, [{ of: 'labels', px: 10.8, floor: TEXT_FLOOR }]);
  const blob = lettered(1500, 300, [9.5], [13.5], [13.5], [13.5]);
  assert.equal(smallText(blob), null, '13.5 at 96% is 13px, whatever the one blob does');
});

await test('a wide board says how small its lettering lands, and a board that fits says nothing', async () => {
  /* #215 widened this board's pills, knocking its fit down a point. */
  assert.deepEqual(measuredWarnings(auditOf(board('test/boards/issue-119-source-columns.json'))), [
    'at 1440×900 this board fits at 52%, so its labels land at 7.0px, under 12, and its subs at 5.2px, under 10; ' +
    'a chapter break is where the rest of it goes',
  ]);
  // the showcase board whose labels nearly clear: what is wrong with it is its subs
  /* #215 widened this board's pills too, shrinking labels and subs by the same factor. */
  assert.deepEqual(auditOf(board('examples/order-flow.json')).small.below.map(b => `${b.of} ${b.px.toFixed(1)}`),
    ['labels 11.2', 'subs 8.3']);
  assert.equal(auditOf(board('examples/kalman.json')).small, null);
});

/* A fact about the whole board is true on every batch after the one that
   made it true, and a line said on every reply is a line an agent learns to
   skip. So each is said against what the last audit found. */
await test('a measured warning is said when it becomes true, not on every batch after', async () => {
  const wide = measuredOf({ small: smallText(boxed(4114, 300)) });
  const subsOnly = measuredOf({ small: smallText(boxed(1620, 300)) });
  assert.deepEqual(wide, { small: ['labels', 'subs'], grazed: [] });
  assert.deepEqual(measuredWarnings({ small: smallText(boxed(4114, 300)) }, wide), [], 'still under: not said again');
  assert.equal(measuredWarnings({ small: smallText(boxed(4114, 300)) }, subsOnly).length, 1,
    'labels crossing under where only the subs were is a crossing');
  assert.deepEqual(measuredWarnings({ small: smallText(boxed(1620, 300)) }, wide), [],
    'labels coming back over, subs still under, is nothing new');
  const g = { edge: 'a>b', box: 'c', gap: 2, side: 'above' }, h = { edge: 'a>d', box: 'c', gap: 3, side: 'below' };
  assert.deepEqual(measuredWarnings({ grazed: [g, h] }, measuredOf({ grazed: [g] })), [
    '1 arrow passes close enough to a box that is not an end of it to read as touching it, most of all when lit: ' +
    'a>d, 3 units below c',
  ], 'only the graze that is new');
  assert.deepEqual(measuredWarnings({ grazed: [g] }, measuredOf({ grazed: [g] })), []);
});

/* ---------- who is told ---------- */

const listen = async name => {
  const app = createServer({ name, persist: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${app.server.address().port}/b/${name}`;
  return { app, U, close: () => new Promise(r => { app.server.close(r); app.server.closeAllConnections?.(); }) };
};
const post = (url, body) => fetch(url + '/op', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json());

/* Asked for by name. POST /op is on the critical path of somebody talking,
   and most ops cannot change where an arrow runs: a line of transcript has no
   geometry. So the render happens for the callers that draw and for nobody
   else, and never before the pane has been told. */
await test('POST /op renders nothing unless the caller asks for the audit', async () => {
  const s = await listen('ask');
  try {
    const ops = specToOps(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8')));
    const quiet = await post(s.U, { ops });
    assert.equal(quiet.ok, true);
    assert.equal(quiet.audit, undefined, 'nothing was measured, and nothing is claimed');
    assert.equal(quiet.nodes, 14, 'the counts are unchanged either way');

    const asked = await post(s.U, { ops: [{ op: 'say', text: 'and that is the fan' }], audit: true });
    assert.deepEqual(asked.audit.lines, [
      '2 labels sit on a line that is not their own: "FIRST MONTH VS SECOND MONTH" on store>r1, "OVER BUDGET" on r2>cost',
      '2 arrows cross a box that is not an end of it: r7>ext through risk, r7>ext through n2',
    ]);
    assert.equal(asked.audit.crossings, 2, 'the numbers come back too, for a caller that wants them');
  } finally { await s.close(); }
});

/* An explanation does not stop because the measurement of it failed, and an
   empty board is not a complaint. */
await test('an empty board is audited in silence', async () => {
  const s = await listen('empty');
  try {
    const r = await post(s.U, { ops: [{ op: 'title', text: 'nothing yet' }], audit: true });
    assert.deepEqual(r.audit.lines, []);
    assert.deepEqual(r.audit.buried, []);
  } finally { await s.close(); }
});

/* `{"op":"node","id":"gw"}` drew an empty box and the reply said `1 box`
   (#209). It is still drawn — it may be a spacer — but it is said. */
await test('a box with nothing in it is said, by its id, on the reply that drew it', async () => {
  const s = await listen('empty-box');
  try {
    const r = await post(s.U, { ops: [{ op: 'node', id: 'gw' }] });
    assert.equal(r.ok, true, 'it is drawn');
    assert.equal(r.nodes, 1);
    assert.deepEqual(r.warnings, ['node "gw": no label, so it is drawn as an empty box.']);

    const sub = await post(s.U, { ops: [{ op: 'node', id: 'db', kind: 'datastore', sub: 'postgres' }] });
    assert.deepEqual(sub.warnings, [
      'node "db": no label, so it is drawn as an empty box; its sub "postgres" is only lettered under a label, ' +
      'so that is not drawn either.',
    ]);

    const queue = await post(s.U, { ops: [{ op: 'node', id: 'jobs', kind: 'queue', sub: 'retries' }] });
    assert.deepEqual(queue.warnings, ['node "jobs": no label, so its sub "retries" is the only thing lettered on it.']);

    // moving a box that has its label is not drawing an empty one, and a note letters its own lines
    const fine = await post(s.U, { ops: [{ op: 'node', id: 'gw', label: 'Gateway' }, { op: 'node', id: 'gw', col: 3 },
      { op: 'note', id: 'n1', lines: ['an aside'] }] });
    assert.deepEqual(fine.warnings, []);
  } finally { await s.close(); }
});

/* Which kinds letter a sub with no label is the reducer's list, kept off the
   glyphs so a node op never renders. Held to the glyphs here, by drawing every
   kind with a sub and nothing else. */
await test('the kinds said to letter a sub alone are the ones whose glyph does', async () => {
  const { drawNode, KINDS } = await import('../src/render/glyphs.js');
  const { SUB_ALONE } = await import('../src/board/state.js');
  const lettered = KINDS.filter(kind => kind !== 'note' &&
    drawNode({ id: 'x', kind, sub: 'SUBWORD' }, { x: 0, y: 0, w: 160, h: 70 }).includes('SUBWORD'));
  assert.deepEqual(lettered.sort(), [...SUB_ALONE].sort());
});

/* The reducer refused an edge with no `to` and accepted one whose `to` named
   nothing, and the arrow stubbed into empty paper (#208's easy-bill board). */
await test('an edge that ends at nothing names the end, and the chapter it is in', async () => {
  const s = await listen('stub');
  try {
    const r = await post(s.U, { ops: [{ op: 'node', id: 'api', label: 'API' }, { op: 'edge', from: 'api', to: 'ghost' }] });
    assert.equal(r.ok, true, 'the edge is kept: the box may be on its way');
    assert.deepEqual(r.warnings, ['edge api>ghost: no box "ghost" on the board, so the arrow ends at nothing.']);

    // drawn before its boxes in the same batch is not drawn at nothing
    const ahead = await post(s.U, { ops: [{ op: 'edge', from: 'a', to: 'b' },
      { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' }] });
    assert.deepEqual(ahead.warnings, []);
    // and an edge swept away with its box in the same batch is not there to warn about
    const gone = await post(s.U, { ops: [{ op: 'edge', from: 'a', to: 'nope' }, { op: 'remove', id: 'a' }] });
    assert.deepEqual(gone.warnings, []);

    /* Ids are per chapter, so the likeliest cause is a box from the chapter
       before, and that is said, with what fixes it. */
    const later = await post(s.U, { ops: [{ op: 'node', id: 'db', kind: 'datastore', label: 'Orders DB' },
      { op: 'chapter', title: 'Reads' }, { op: 'node', id: 'cache', kind: 'cache', label: 'Cache' },
      { op: 'edge', from: 'cache', to: 'db' }, { op: 'edge', from: 'cache', to: 'ghost' }] });
    assert.deepEqual(later.warnings.slice(-2), [
      'edge cache>db: no box "db" on this chapter, so the arrow ends at nothing. "db" is in chapter 1, and ids are ' +
      'per chapter: an edge to it belongs there, which is what board_amend is for — drawing "db" again here would ' +
      'put a second copy of it on this chapter.',
      'edge cache>ghost: no box "ghost" on this chapter, so the arrow ends at nothing. Ids are per chapter, so a box ' +
      'drawn in another chapter is not on this one.',
    ]);
    // the amendment that fixes it is measured against the chapter it lands in
    const amended = await post(s.U, { ops: [{ op: 'amend', chapter: 1, ops: [
      { op: 'node', id: 'cache', kind: 'cache', label: 'Cache' }, { op: 'edge', from: 'cache', to: 'db' }] }] });
    assert.deepEqual(amended.warnings, []);
  } finally { await s.close(); }
});

/* The two that need a drawing ride on the same list as the two that do not:
   `warnings` is what the MCP server appends to the tool reply and the CLI
   prints, and the agent is listening to exactly that. */
await test('a graze and a board too wide to read arrive as warnings on the reply that drew them', async () => {
  const s = await listen('measured');
  try {
    const graze = await post(s.U, { ops: specToOps(grazeSpec()), audit: true });
    assert.deepEqual(graze.warnings, [
      'at 1440×900 this board fits at 86%, so its labels land at 11.6px, under 12; ' +
      'a chapter break is where the rest of it goes',
      '1 arrow passes close enough to a box that is not an end of it to read as touching it, most of all when lit: ' +
      'ch>db, 9.6 units above corr',
    ]);
    assert.equal(graze.audit.warnings, undefined, 'said once, where warnings are said');
    assert.deepEqual(graze.audit.grazed, [{ edge: 'ch>db', box: 'corr', gap: 9.6, side: 'above' }],
      'and the measurement comes back too, for a caller that wants it');

    const wide = await post(s.U, { ops: [{ op: 'clear' }, ...specToOps(board('test/boards/issue-119-source-columns.json'))],
      audit: true });
    assert.deepEqual(wide.warnings, ['at 1440×900 this board fits at 52%, so its labels land at 7.0px, under 12, ' +
      'and its subs at 5.2px, under 10; a chapter break is where the rest of it goes']);
    assert.equal(wide.audit.measured, undefined, 'what is kept for the next audit is not handed back');

    // not asked for, not rendered, not said
    const quiet = await post(s.U, { ops: [{ op: 'say', text: 'and that is the fan' }] });
    assert.deepEqual(quiet.warnings, []);
  } finally { await s.close(); }
});

/* An agent drawing a long explanation onto a wide board audits every batch,
   and has to hear that it is wide once — on the batch that made it so. */
await test('a board is told it is too wide, or that an arrow grazes, once, when it happens', async () => {
  const s = await listen('once');
  try {
    const wide = specToOps(board('test/boards/issue-119-source-columns.json'));
    const said = r => r.warnings.filter(w => w.startsWith('at 1440×900'));
    assert.equal(said(await post(s.U, { ops: wide, audit: true })).length, 1, 'said on the batch that crossed');
    const next = await post(s.U, { ops: [{ op: 'say', text: 'and on it goes' }], audit: true });
    assert.deepEqual(next.warnings, [], 'and not on the batch after');
    assert.ok(next.audit.small, 'though the audit still measures it');

    // a board that comes back over the floor and goes under again has crossed again
    const ids = board('test/boards/issue-119-source-columns.json').nodes.map(n => n.id);
    await post(s.U, { ops: ids.slice(1).map(id => ({ op: 'remove', id })), audit: true });
    assert.equal(said(await post(s.U, { ops: wide, audit: true })).length, 1, 'said again on crossing again');

    // a new chapter is a new surface, and a cleared board a new board
    assert.equal(said(await post(s.U, { ops: [{ op: 'chapter', title: 'More' }, ...wide], audit: true })).length, 1);
    assert.equal(said(await post(s.U, { ops: [{ op: 'clear' }, ...wide], audit: true })).length, 1);

    // and a graze is the same: said for the arrow that came to graze, then not
    const graze = specToOps(grazeSpec());
    assert.equal((await post(s.U, { ops: [{ op: 'clear' }, ...graze], audit: true })).warnings.length, 2);
    assert.deepEqual((await post(s.U, { ops: [{ op: 'say', text: 'still there' }], audit: true })).warnings, []);
  } finally { await s.close(); }
});

/* A warning that always fires is noise, and nothing else would catch it. */
await test('a board that is fine is told none of the four', async () => {
  const s = await listen('fine');
  try {
    const r = await post(s.U, { ops: specToOps(board('examples/kalman.json')), audit: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  } finally { await s.close(); }
});

/* It runs on every batch an agent draws, after the broadcast rather than
   before it, so the budget is the agent's own reply and not the drawing
   appearing. Loose on purpose: this fails when something quadratic goes in,
   not when a laptop is busy. */
await test('auditing a board of real size costs a millisecond or two', async () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8'));
  const board = drawn(spec);
  audit(spec, renderSVG(board, { margin: 16 }));   // warm
  const ms = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const r = renderSVG(board, { margin: 16 });
    audit(spec, r);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ms.sort((a, b) => a - b);
  assert.ok(ms[10] < 25, `the median render-and-audit took ${ms[10].toFixed(1)} ms`);
});

console.log(`  ${n} audit checks passed`);
fs.rmSync(HOME, { recursive: true, force: true });
