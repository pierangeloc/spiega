/* A phase of the explanation, marked in the script (#54).

   Run with `node test/groups.mjs`. Its own process, like test/chapters.mjs:
   the state directory is read once, at import, from HOME.

   What is being protected: the grouping is a key on a step and a name beside
   the flow, and both have to survive everything that rebuilds a board — a
   restore from the log, a compaction, a chapter break — or a phase would be
   something the board forgets the moment anybody reloads it. And the header
   has to sit over the lines it is about, which is the only part of this a
   reader ever sees. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-groups-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { emptyBoard, applyOps, boardOps } = await import('../src/board/state.js');
const { groupRuns, lineStates, scriptSteps } = await import('../src/board/script.js');
const { snapshotHTML } = await import('../src/board/snapshot.js');

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

const drawn = ops => { const b = emptyBoard(); applyOps(b, ops); return b; };

/* The Dutch biology board from #54: four steps that are all one reaction,
   with two remarks above them that belong to no step at all. */
const taught = [
  { op: 'group', id: 'combustion', label: 'Verbranding' },
  { op: 'node', id: 'glucose', label: 'Glucose' },
  { op: 'node', id: 'cell', label: 'Cel' },
  { op: 'node', id: 'energy', label: 'Energie' },
  { op: 'edge', from: 'glucose', to: 'cell' },
  { op: 'edge', from: 'cell', to: 'energy' },
  { op: 'say', text: 'Two things happen here, and they are not the same thing.' },
  { op: 'step', edge: 'glucose>cell', step: 'Glucose enters', group: 'combustion' },
  { op: 'step', edge: 'cell>energy', step: 'Energy comes out', group: 'combustion' },
  { op: 'say', text: 'Glucose crosses the membrane.', step: 1 },
  { op: 'say', text: 'And the cell has its energy.', step: 2 },
];

await test('a step carries the group it names', async () => {
  const b = drawn(taught);
  assert.deepEqual(b.flow.map(s => s.group), ['combustion', 'combustion']);
  assert.deepEqual(b.groups, { combustion: 'Verbranding' });
});

await test('the label is optional and falls back to the id', async () => {
  const b = drawn([{ op: 'group', id: 'combustion' }]);
  assert.equal(b.groups.combustion, 'combustion');
});

/* The op may land either side of the steps that join it. An agent naming the
   phase after it has drawn the steps is the common order — you find out what
   the four hops were about by drawing them. */
await test('a group op before and after its steps both work', async () => {
  const steps = [
    { op: 'step', edge: 'a>b', step: 'one', group: 'phase' },
    { op: 'say', text: 'the first hop', step: 1 },
  ];
  const before = drawn([{ op: 'group', id: 'phase', label: 'A Phase' }, ...steps]);
  const after = drawn([...steps, { op: 'group', id: 'phase', label: 'A Phase' }]);
  assert.deepEqual(groupRuns(before), [{ id: 'phase', label: 'A Phase', from: 0, to: 0 }]);
  assert.deepEqual(groupRuns(after), groupRuns(before));
});

/* An op that errors arrives while somebody is talking, and a group nobody
   declared costs a label, not a meaning. */
await test('a step naming an undeclared group still groups, under its id', async () => {
  const b = drawn([
    { op: 'step', edge: 'a>b', step: 'one', group: 'verbranding' },
    { op: 'say', text: 'the first hop', step: 1 },
  ]);
  assert.deepEqual(b.groups, {}, 'nothing was declared');
  assert.deepEqual(groupRuns(b), [{ id: 'verbranding', label: 'verbranding', from: 0, to: 0 }]);
});

await test('a group op with no id is refused, and says so', async () => {
  const b = emptyBoard();
  const r = applyOps(b, [{ op: 'group', label: 'Verbranding' }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /group: "id" must name the group/);
  assert.deepEqual(b.groups, {});
});

/* A group that is not a string would be shown as "[object Object]" over the
   run — so the step draws without one and the agent is told, the way a kind
   with no glyph is. Refusing the step would cost the hop over a label. */
await test('a group that is not an id costs the header, not the step', async () => {
  const b = emptyBoard();
  const r = applyOps(b, [{ op: 'step', edge: 'a>b', step: 'one', group: ['combustion'] }]);
  assert.deepEqual(r.errors, []);
  assert.equal(b.flow.length, 1, 'the hop is still in the flow');
  assert.equal(b.flow[0].group, undefined);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /"group" must be the id of a group/);
});

/* The rail is in the order things were said, and no grouping reorders it. So a
   phase whose lines are interrupted is headed twice rather than spanning a
   line it is not about. */
await test('a non-contiguous group is headed once per run', async () => {
  const b = drawn([
    { op: 'group', id: 'burn', label: 'Verbranding' },
    { op: 'step', edge: 'a>b', step: 'one', group: 'burn' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'step', edge: 'c>d', step: 'three', group: 'burn' },
    { op: 'say', text: 'the first hop', step: 1 },
    { op: 'say', text: 'an aside about the pipe', step: 2 },
    { op: 'say', text: 'and the burn again', step: 3 },
  ]);
  assert.deepEqual(groupRuns(b), [
    { id: 'burn', label: 'Verbranding', from: 0, to: 0 },
    { id: 'burn', label: 'Verbranding', from: 2, to: 2 },
  ], 'the same name over each stretch');
});

await test('a run spans every line of the phase, and stops where it stops', async () => {
  const b = drawn(taught);
  assert.deepEqual(groupRuns(b), [
    { id: 'combustion', label: 'Verbranding', from: 1, to: 2 },
  ], 'the opening remark belongs to no step, so no header reaches over it');
});

await test('two groups in a row are two runs, not one', async () => {
  const b = drawn([
    { op: 'group', id: 'in', label: 'Intake' },
    { op: 'group', id: 'out', label: 'Output' },
    { op: 'step', edge: 'a>b', step: 'one', group: 'in' },
    { op: 'step', edge: 'b>c', step: 'two', group: 'out' },
    { op: 'say', text: 'first', step: 1 },
    { op: 'say', text: 'second', step: 2 },
  ]);
  assert.deepEqual(groupRuns(b).map(r => [r.id, r.from, r.to]), [['in', 0, 0], ['out', 1, 1]]);
});

/* Everything that rebuilds a board. A field the restore drops is lost at the
   next reload, and a field a chapter break drops is lost the moment the
   explanation moves on — both silently, which is what makes them worth a
   test rather than a reading of the code. */
await test('a group survives a restore and a compaction', async () => {
  const b = drawn(taught);
  const strip = x => JSON.stringify(x, (k, v) => (k === 'at' ? undefined : v));
  const restored = drawn(b.log.map(({ at, ...op }) => op));
  assert.equal(strip(restored.groups), strip(b.groups), 'replayed from its own log');
  assert.equal(strip(restored.flow), strip(b.flow));
  const compact = drawn(boardOps(b));
  assert.equal(strip(compact.groups), strip(b.groups), 'rebuilt from the minimal op set');
  assert.equal(strip(compact.flow), strip(b.flow));
  assert.deepEqual(groupRuns(compact), groupRuns(b), 'and reads the same in the rail');
});

await test('two chapters of groups reach the same state three ways', async () => {
  const b = drawn([
    ...taught,
    { op: 'chapter', title: 'Enzymes' },
    { op: 'group', id: 'split', label: 'Splitsing' },
    { op: 'node', id: 'fat' },
    { op: 'node', id: 'lipase' },
    { op: 'edge', from: 'fat', to: 'lipase' },
    { op: 'step', edge: 'fat>lipase', step: 'Lipase takes it apart', group: 'split' },
    { op: 'say', text: 'The same fat, taken apart.', step: 1 },
  ]);
  assert.deepEqual(b.chapters[0].groups, { combustion: 'Verbranding' },
    'the finished chapter keeps the names it taught');
  assert.deepEqual(b.groups, { split: 'Splitsing' }, 'and the live one starts its own');

  const strip = x => JSON.stringify(x, (k, v) => (k === 'at' ? undefined : v));
  const fields = x => strip([x.chapters, x.groups, x.flow, x.chapter]);
  const restored = drawn(b.log.map(({ at, ...op }) => op));
  const compact = drawn(boardOps(b));
  assert.equal(fields(restored), fields(b), 'replayed from the log');
  assert.equal(fields(compact), fields(b), 'rebuilt from the minimal op set');
  assert.deepEqual(groupRuns(b.chapters[0]),
    [{ id: 'combustion', label: 'Verbranding', from: 1, to: 2 }],
    'and a chapter nobody is drawing on still reads its own phases');
});

await test('an amendment can name a phase in a chapter already taught', async () => {
  const b = drawn([...taught, { op: 'chapter', title: 'Enzymes' }, { op: 'node', id: 'lipase' }]);
  const r = applyOps(b, [{ op: 'amend', chapter: 1, ops: [
    { op: 'group', id: 'combustion', label: 'De verbranding' },
  ] }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(b.chapters[0].groups, { combustion: 'De verbranding' }, 'renamed back there');
  assert.deepEqual(b.groups, {}, 'and nothing happened to the chapter being drawn on');
});

/* ---------- the rail, run out of the page ---------- */

/* The real renderRail against stubs, the way smoke.mjs runs the play button
   and the chapter strip. The header is the whole visible half of this change,
   and the page is the one consumer the suite otherwise never sees. */
function rendered(board) {
  const html = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const m = src.match(/function renderRail\(\)[\s\S]*?\n}\n/);
  assert.ok(m, 'board.html should define renderRail()');

  const kids = [];
  const matches = (el, sel) => sel.split('.').filter(Boolean)
    .every(c => String(el.className).split(/\s+/).includes(c));
  const rail = {
    kids,
    get innerHTML() { return this._raw + kids.map(k => k.innerHTML).join(''); },
    set innerHTML(v) { kids.length = 0; this._raw = v; },
    _raw: '',
    appendChild(el) { kids.push(el); },
    insertBefore(el, ref) {
      const i = kids.indexOf(ref);
      kids.splice(i < 0 ? kids.length : i, 0, el);
    },
    querySelector(sel) { return kids.find(k => matches(k, sel)) || null; },
    querySelectorAll(sel) { return kids.filter(k => matches(k, sel)); },
    scrollTo() {}, scrollTop: 0, scrollHeight: 0, clientHeight: 300,
  };
  const context = {
    $: () => rail,
    document: { createElement: () => {
      const el = { className: '', title: '', dataset: {}, innerHTML: '',
        querySelector: () => null, remove() { kids.splice(kids.indexOf(el), 1); } };
      return el;
    } },
    view_of: () => board,
    lineStates,
    groupRuns,
    mdish: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    wrapWords: () => {},
    loadTape: () => {},
  };
  vm.createContext(context);
  new vm.Script(`${m[0]}\nrenderRail();`).runInContext(context, { displayErrors: true });
  return kids;
}

await test('the rail puts the header over the run of lines it is about', async () => {
  const kids = rendered(drawn(taught));
  assert.deepEqual(kids.map(k => k.className.split(' ')[0]),
    ['said', 'phase', 'said', 'said'],
    'the opening remark first, then the header, then the two lines of the phase');
  assert.match(kids[1].innerHTML, /Verbranding/);
  assert.equal(kids[1].dataset.group, 'combustion');
  assert.deepEqual(kids.filter(k => k.className === 'phase').length, 1);
});

await test('the rail repeats the header on a phase that is interrupted', async () => {
  const kids = rendered(drawn([
    { op: 'group', id: 'burn', label: 'Verbranding' },
    { op: 'step', edge: 'a>b', step: 'one', group: 'burn' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'step', edge: 'c>d', step: 'three', group: 'burn' },
    { op: 'say', text: 'the first hop', step: 1 },
    { op: 'say', text: 'an aside about the pipe', step: 2 },
    { op: 'say', text: 'and the burn again', step: 3 },
  ]));
  assert.deepEqual(kids.map(k => k.className.split(' ')[0]),
    ['phase', 'said', 'said', 'phase', 'said']);
  assert.match(kids[0].innerHTML, /Verbranding/);
  assert.match(kids[3].innerHTML, /Verbranding/);
});

/* Headers are rebuilt where the lines are not. A rail rendered twice must not
   grow a second set of them — and the lines themselves must be the same
   elements, or every one of them restarts its fade-in on each step change. */
await test('rendering the rail again does not stack up headers', async () => {
  const board = drawn(taught);
  const html = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.ok(/\.phase'\)\.forEach\(h => h\.remove\(\)\)/.test(src),
    'renderRail should take the headers out before putting them back');
  const once = rendered(board);
  assert.equal(once.filter(k => k.className === 'phase').length, 1);
});

/* A snapshot is the still you paste into the PR. If it lost the phases, the
   saved board and the live one would disagree about what the explanation is
   made of. */
await test('a snapshot heads the same runs', async () => {
  const out = snapshotHTML(drawn(taught));
  assert.match(out, /<li class="phase">Verbranding<\/li>/);
  const said = out.slice(out.indexOf('What was said'));
  assert.ok(said.indexOf('Two things happen') < said.indexOf('class="phase"'),
    'the header comes after the remark that belongs to no step');
  assert.ok(said.indexOf('class="phase"') < said.indexOf('crosses the membrane'),
    'and before the first line of the phase');
});

/* Found in review, by driving the thing an agent would actually do: declare
   the phases, then name the first chapter.

   A group op is a dictionary entry, not something drawn, so a surface holding
   only group names is still blank and the `chapter` op names it rather than
   filing it. Counting them put an untitled chapter containing nothing but
   labels in front of the explanation — and took the names away from the steps
   that were about to use them. */
await test('declaring the phases before the first chapter does not file a chapter', async () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'title', text: 'Biology' },
    { op: 'group', id: 'intake', label: 'Opname' },
    { op: 'group', id: 'burn', label: 'Verbranding' },
    { op: 'chapter', title: 'Nutrients' },
    { op: 'node', id: 'fat' }, { op: 'node', id: 'energy' },
    { op: 'edge', from: 'fat', to: 'energy' },
    { op: 'step', edge: 'fat>energy', step: 'burns', group: 'intake' },
    { op: 'say', text: 'Fat burns.', step: 1 },
  ]);
  assert.deepEqual(b.chapters, [], 'names on their own are not a chapter');
  assert.equal(b.chapter, 'Nutrients');
  assert.deepEqual(groupRuns(b).map(r => r.label), ['Opname'],
    'and the names reached the steps that use them');
});

/* Also found in review, and older than groups: `boardOps` wrote a line's step
   only when the line carried one explicitly, so a line attributed by having
   been said while a step was lit came back tied to nothing. Past LOG_CAP, a
   board replays from `boardOps` — so the rail quietly stopped highlighting on
   exactly the long sessions that need it, and a phase lost its lines with it.
   A finished chapter already froze this on its way out; the live one did not. */
await test('a compacted board keeps the attribution the log walk gave it', async () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'group', id: 'burn', label: 'Verbranding' },
    { op: 'node', id: 'a' }, { op: 'node', id: 'b' }, { op: 'edge', from: 'a', to: 'b' },
    { op: 'step', edge: 'a>b', step: 'hop', group: 'burn' },
    { op: 'focus', step: 0 },
    { op: 'say', text: 'said while step 1 was lit' },
  ]);
  assert.deepEqual(scriptSteps(b), [0], 'attributed by the walk, not by the line');
  const compact = emptyBoard();
  applyOps(compact, boardOps(b));
  assert.deepEqual(scriptSteps(compact), [0], 'and still attributed after compaction');
  assert.deepEqual(groupRuns(compact).map(r => r.label), ['Verbranding']);
});

console.log(`\n  ${n} checks on step groups`);
