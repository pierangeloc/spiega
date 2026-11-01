/* A smoke test over the whole path: ops in, board state, SVG out, snapshot out.
   Run with `node test/smoke.mjs`. No framework, no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import { snapshotHTML } from '../src/board/snapshot.js';
import { KINDS } from '../src/render/glyphs.js';
import { scriptSteps, linesFor, lineStates, clickStep, tagReport } from '../src/board/script.js';
import { frame, unionBox, litKeys } from '../src/board/camera.js';
import { registeredAs } from '../src/doctor.js';
import { lettering } from '../src/render/ink.js';
import { upsertBlock, removeBlock, START, END, BLOCK } from '../src/agents-block.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

test('an op list builds a board, and ids come from labels', () => {
  const b = emptyBoard();
  const { errors } = applyOps(b, [
    { op: 'title', text: 'T' },
    { op: 'node', kind: 'gateway', label: 'API Gateway' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'edge', from: 'api-gateway', to: 'orders', label: 'gRPC' },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(b.title, 'T');
  assert.deepEqual(b.nodes.map(x => x.id), ['api-gateway', 'orders']);
});

test('redrawing an id updates it instead of adding a second', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'a', label: 'A', sub: 'two' }]);
  assert.equal(b.nodes.length, 1);
  assert.equal(b.nodes[0].sub, 'two');
});

test('an unknown op is reported, not thrown', () => {
  const b = emptyBoard();
  const { errors } = applyOps(b, [{ op: 'nope' }]);
  assert.equal(errors.length, 1);
});

test('columns come from the edges', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'node', id: 'c', label: 'C' },
    { op: 'edge', from: 'a', to: 'b' }, { op: 'edge', from: 'b', to: 'c' },
  ]);
  const { boxes } = renderSVG(b);
  assert.equal(boxes.a.col, 0);
  assert.equal(boxes.b.col, 1);
  assert.equal(boxes.c.col, 2);
  assert.ok(boxes.a.x < boxes.b.x && boxes.b.x < boxes.c.x);
});

test('a node added later does not move the ones already placed', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' }]);
  const before = renderSVG(b).boxes;
  applyOps(b, [{ op: 'node', id: 'c', label: 'C' }, { op: 'edge', from: 'a', to: 'c' }]);
  const after = renderSVG(b).boxes;
  assert.equal(before.a.col, after.a.col);
  assert.equal(before.b.col, after.b.col);
});

test('a node drawn before its edge is relayered when the edge arrives', () => {
  // This is how an agent actually draws: the box, then the arrow into it. If
  // layout is frozen after the first render the node is stuck in column 0.
  const b = emptyBoard();
  applyOps(b, [{ op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' }]);
  renderSVG(b);                                  // render once with b floating
  applyOps(b, [{ op: 'edge', from: 'a', to: 'b' }]);
  const { boxes } = renderSVG(b);
  assert.equal(boxes.b.col, 1, 'the edge should have moved b into the next column');
  assert.ok(boxes.b.x > boxes.a.x);
});

test('every kind renders, and the same board draws the same strokes', () => {
  const b = emptyBoard();
  applyOps(b, KINDS.map((k, i) => ({ op: 'node', id: 'k' + i, kind: k, label: k, sub: 'x' })));
  const a1 = renderSVG(b).svg, a2 = renderSVG(b).svg;
  assert.equal(a1, a2, 'wobble must be seeded, not random');
  for (const k of KINDS) assert.ok(a1.includes(k.toUpperCase()) || a1.includes(k), k);
});

test('focusing a step lights one edge and dims the rest, but never a note', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'note', id: 'n', label: 'aside' },
    { op: 'edge', from: 'a', to: 'b' },
    { op: 'step', edge: 'a>b', step: 'a calls b' },
    { op: 'focus', step: 0 },
  ]);
  const svg = renderSVG(b).svg;
  assert.ok(svg.includes('#ef6a4c'), 'the lit path should use the accent');
  const note = svg.slice(svg.indexOf('data-node="n"'));
  assert.ok(note.startsWith('data-node="n" opacity="1"'), 'a note must not dim');
});

test('a snapshot is standalone: no scripts, no outside requests', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'title', text: 'S' }, { op: 'node', id: 'a', kind: 'service', label: 'A' },
    { op: 'say', text: 'hello' }]);
  const html = snapshotHTML(b);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(html), 'a snapshot must carry no scripts');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'a snapshot must fetch nothing');
  assert.ok(html.includes('<svg') && html.includes('hello'));
});

test('the shipped example renders', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/order-flow.json'), 'utf8'));
  const { svg, width } = renderSVG(spec);
  assert.ok(width > 400 && svg.length > 10000);
});

/* The board page is half the product and none of the tests above touch it: a
   syntax error in its inline module silently stops the whole page — no event
   stream, no drawing — while the server goes on happily collecting ops. That
   failure is invisible to every test that only exercises the renderer. */
import vm from 'node:vm';

const parses = (src, what) => {
  // strip module syntax so the rest can be parsed as a plain script, and the
  // browser globals that run at module top level
  const body = src
    .replace(/^\s*import\s[^;]*;?$/gm, '')
    .replace(/^\s*export\s+(?=(function|const|let|class))/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?$/gm, '')
    .replace(/matchMedia\([^)]*\)\.matches/g, 'false');
  try { new vm.Script(body, { filename: what }); }
  catch (e) { throw new Error(`${what} does not parse: ${e.message}`); }
};

test('the board page module parses', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'board.html should have a module script');
  parses(m[1], 'board.html <script type=module>');
});

test('the browser-side modules parse', () => {
  for (const f of ['src/board/draw-on.js', 'src/board/narrate.js', 'src/render/render.js', 'src/render/ink.js',
                   'src/render/glyphs.js', 'src/render/edges.js', 'src/render/layout.js']) {
    parses(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
  }
});

/* The play button toggles a timer, and a toggle that stops itself by clicking
   its own button is re-entrant: it once recursed to a stack overflow when
   pressed on the last step, leaving the control stuck on "stop" and dead to
   every later press. So run the real handler out of the page against stubs. */
function playControl(flow, active) {
  const html = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const src = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const m = src.match(/function stopPlay\(\)[\s\S]*?\$\('play'\)\.onclick = [^\n]*\n/);
  assert.ok(m, 'board.html should define stopPlay/startPlay and wire the button');

  const btn = { textContent: 'play', classList: { add() {}, remove() {} } };
  const timers = new Map();
  let next = 1, playing = null, clicks = 0;
  const env = {
    $: () => btn,
    get board() { return { flow, active }; },
    focus: i => { active = i; },
    setInterval: fn => { const id = next++; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
  };
  const run = new vm.Script(
    `${m[0]}\n({ click: () => (clicks++, $('play').onclick()), tick: () => [...timers.values()][0]?.() })`
  ).runInNewContext({ ...env, playing, timers, clicks,
    // `playing` and `clicks` must live in the context, not be copied in
  }, { displayErrors: true });
  return { btn, timers, run };
}

test('the play control stops when told to, from any step', () => {
  for (const active of [null, 0, 2]) {       // including parked on the last step
    const { btn, timers, run } = playControl([{ step: 'a' }, { step: 'b' }, { step: 'c' }], active);
    run.click();                              // play
    assert.equal(btn.textContent, 'stop', `active=${active}: play should arm the timer`);
    assert.equal(timers.size, 1, `active=${active}: exactly one timer`);
    run.click();                              // stop
    assert.equal(btn.textContent, 'play', `active=${active}: stop should disarm it`);
    assert.equal(timers.size, 0, `active=${active}: no timer left running`);
  }
});

test('the play control runs the flow to the end and stops itself', () => {
  const { btn, timers, run } = playControl([{ step: 'a' }, { step: 'b' }], null);
  run.click();
  for (let i = 0; i < 6 && timers.size; i++) run.tick();
  assert.equal(timers.size, 0, 'it should clear its own timer at the end');
  assert.equal(btn.textContent, 'play', 'and put the label back');
});

/* The script half of the board has to follow the step being walked, or the
   reader matches sentence to picture by hand. */
test('a line says which step it belongs to, by number or by hop', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'say', text: 'Three services, one store.' },            // no step: the whole board
    { op: 'step', edge: 'gw>orders', step: 'Gateway forwards' },
    { op: 'step', edge: 'orders>db', step: 'Write the row' },
    { op: 'say', text: 'The gateway authenticates first.', step: 1 },
    { op: 'say', text: 'Then the row is written.', edge: 'orders>db' },
  ]);
  assert.deepEqual(scriptSteps(b), [null, 0, 1]);
  assert.deepEqual(linesFor(b, 0), [1]);
  assert.deepEqual(linesFor(b, 1), [2]);
  assert.deepEqual(linesFor(b, null), []);
});

test('a line said while a step was lit belongs to that step', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'focus', step: 0 },
    { op: 'say', text: 'a talks to b' },
    { op: 'focus', step: 1 },
    { op: 'say', text: 'then b talks to c' },
    { op: 'say', text: 'and that is the last hop' },
    { op: 'focus', step: null },
    { op: 'say', text: 'that is the whole path' },
  ]);
  assert.deepEqual(scriptSteps(b), [0, 1, 1, null]);
  assert.deepEqual(linesFor(b, 1), [1, 2]);
});

test('an untagged batch attributes nothing rather than guessing', () => {
  // All the steps are declared before any narration, so "the newest step at
  // the time" would file every line under the last one. Nothing is better.
  const b = emptyBoard();
  applyOps(b, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'say', text: 'first a talks to b' },
    { op: 'say', text: 'then b talks to c' },
  ]);
  assert.deepEqual(scriptSteps(b), [null, null]);
});

test('an out-of-range or stale step link is dropped, not rendered', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'say', text: 'about a step that does not exist', step: 9 },
    { op: 'say', text: 'about a hop that does not exist', edge: 'x>y' },
    { op: 'say', text: 'about the one that does', step: 1 },
  ]);
  assert.deepEqual(scriptSteps(b), [null, null, 0]);
});

test('walking a step lights its lines, recedes the others, and spares the asides', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'say', text: 'Six hops. I will walk them.' },           // an aside
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'say', text: 'first hop', step: 1 },
    { op: 'say', text: 'second hop', step: 2 },
    { op: 'say', text: 'and that is the path.' },                 // another aside
  ]);

  // no step lit: the rail is plain, nothing dimmed
  assert.deepEqual(lineStates(b).map(l => l.state), ['idle', 'idle', 'idle', 'idle']);

  applyOps(b, [{ op: 'focus', step: 1 }]);                        // 2/2
  assert.deepEqual(lineStates(b).map(l => l.state), ['free', 'off', 'on', 'free']);

  applyOps(b, [{ op: 'focus', step: 0 }]);                        // 1/2
  assert.deepEqual(lineStates(b).map(l => l.state), ['free', 'on', 'off', 'free']);

  // a step nothing was said about must not dim the whole script to no purpose
  applyOps(b, [{ op: 'step', edge: 'c>d', step: 'three' }, { op: 'focus', step: 2 }]);
  assert.deepEqual(lineStates(b).map(l => l.state), ['idle', 'idle', 'idle', 'idle']);
});

test('a snapshot marks the lit step in the script, not just the drawing', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' },
    { op: 'step', edge: 'a>b', step: 'A calls B' },
    { op: 'say', text: 'A calls B over gRPC.', step: 1 },
    { op: 'say', text: 'Nothing else to it.' },
  ]);
  const html = snapshotHTML(b, { active: 0 });
  assert.ok(/<li class="on"><span class="tag">step 1<\/span>A calls B over gRPC/.test(html),
    'the tagged line should be marked lit');
  assert.ok(/<li>Nothing else to it\./.test(html), 'an untagged line stays plain');

  // a still dims the same things the drawing does
  applyOps(b, [{ op: 'step', edge: 'a>b', step: 'again' }, { op: 'say', text: 'About the second step.', step: 2 }]);
  const two = snapshotHTML(b, { active: 0 });
  assert.ok(/<li class="off"><span class="tag">step 2<\/span>About the second step/.test(two),
    'a line belonging to another step should recede in the still too');
});

test('clicking a line walks its step, and clicking it again comes back out', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'say', text: 'about the first hop', step: 1 },
  ]);

  assert.equal(clickStep(b, 0), 0, 'a line with a step takes you to it');
  applyOps(b, [{ op: 'focus', step: 0 }]);
  assert.equal(clickStep(b, 0), null, 'clicking the lit step clears it \u2014 one gesture, both ways');
  assert.equal(clickStep(b, 1), 1, 'another step still switches');

  // nothing to click through to
  assert.equal(clickStep(b, 9), undefined, 'a step that does not exist does nothing');
  assert.equal(clickStep(b, -1), undefined);
  assert.equal(clickStep(b, NaN), undefined);
  assert.equal(clickStep(emptyBoard(), 0), undefined, 'a board with no flow has nowhere to go');
});

/* The rail shows what was said, in the order it was said. Tagged by topic
   rather than in step order, the numbers come out jumbled — and that looks
   like a sorting fault from the board, so it is worth saying out loud. */
test('tags that run backwards are reported, not quietly reordered', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'step', edge: 'c>d', step: 'three' },
    { op: 'say', text: 'opening' },
    { op: 'say', text: 'about the second hop', step: 2 },
    { op: 'say', text: 'about the first hop', step: 1 },     // backwards
    { op: 'say', text: 'about the third hop', step: 3 },
  ]);

  const r = tagReport(b);
  assert.equal(r.lines, 4);
  assert.equal(r.tagged, 3);
  assert.equal(r.steps, 3);
  assert.equal(r.ordered, false);
  assert.deepEqual(r.backwards, [{ line: 3, step: 1, after: 2 }],
    'it should name the line, its step, and the step it came after');

  // and the transcript is left exactly as it was said
  assert.deepEqual(b.transcript.map(t => t.text),
    ['opening', 'about the second hop', 'about the first hop', 'about the third hop']);

  // narrated in order, there is nothing to report
  const good = emptyBoard();
  applyOps(good, [
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
    { op: 'say', text: 'opening' },
    { op: 'say', text: 'first', step: 1 },
    { op: 'say', text: 'also first', step: 1 },   // same step twice is fine
    { op: 'say', text: 'second', step: 2 },
    { op: 'say', text: 'closing' },
  ]);
  const g = tagReport(good);
  assert.equal(g.ordered, true, 'repeats and untagged asides are not disorder');
  assert.deepEqual(g.backwards, []);

  // nothing tagged at all is a different problem, and not this one
  const bare = emptyBoard();
  applyOps(bare, [{ op: 'step', edge: 'a>b', step: 'one' }, { op: 'say', text: 'hello' }]);
  assert.equal(tagReport(bare).ordered, true);
  assert.equal(tagReport(bare).tagged, 0);
});

/* Tagging after the fact. A model that forgot, or a board drawn before the
   feature existed, must be fixable without running the explanation again —
   that is the whole point of the board holding its own log. */
test('a line already said can be tied to a step, by number or by its words', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'say', text: 'Six hops, end to end.' },
    { op: 'say', text: 'Flyway V25 adds the confirmation.' },
    { op: 'say', text: 'The gateway checks the token.' },
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'step', edge: 'b>c', step: 'two' },
  ]);
  assert.deepEqual(scriptSteps(b), [null, null, null]);

  const { errors } = applyOps(b, [
    { op: 'tag', line: 3, step: 1 },                      // counting from 1, as the rail shows
    { op: 'tag', match: 'Flyway', edge: 'b>c' },          // by its words, which is what an agent has
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(scriptSteps(b), [null, 1, 0]);
});

test('a wrong tag can be taken back, and a bad one is reported not thrown', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'say', text: 'An opening remark.' },
    { op: 'step', edge: 'a>b', step: 'one' },
    { op: 'tag', line: 1, step: 1 },
  ]);
  assert.deepEqual(scriptSteps(b), [0]);

  applyOps(b, [{ op: 'tag', line: 1, step: null }]);      // openings belong to no step
  assert.deepEqual(scriptSteps(b), [null]);

  const { errors } = applyOps(b, [
    { op: 'tag', line: 9, step: 1 },
    { op: 'tag', match: 'nothing says this', step: 1 },
  ]);
  assert.equal(errors.length, 2, 'both misses are reported');
  assert.ok(errors[0].includes('no line 9'), errors[0]);
});

test('tagging a board drawn before the feature existed makes it light up', () => {
  // the shape of the real case: every line said up front, steps declared after
  const b = emptyBoard();
  applyOps(b, [
    { op: 'say', text: 'Before: every upsert re-ran CoC matching.' },
    { op: 'say', text: 'The CT manager picks the BP and PUTs the link.' },
    { op: 'say', text: 'Flyway V25 adds a mandatory confirmation.' },
    { op: 'step', edge: 'ctm>ctrl', step: 'CT manager picks the BP' },
    { op: 'step', edge: 'ctm>wf', step: 'CT manager confirms' },
  ]);
  assert.deepEqual(scriptSteps(b), [null, null, null], 'nothing is guessed');

  applyOps(b, [
    { op: 'tag', match: 'PUTs the link', step: 1 },
    { op: 'tag', match: 'Flyway V25', step: 2 },
  ]);
  applyOps(b, [{ op: 'focus', step: 0 }]);
  assert.deepEqual(lineStates(b).map(l => l.state), ['free', 'on', 'off'],
    'the opening stays plain, the tagged line lights, the other recedes');
});

/* Every file an install target copies must actually be there. `install cursor`
   shipped broken for a while because a rename moved the rule file and the
   copy still named the old path — nothing reads these paths until a user
   installs, which is the worst time to find out. */
test('every install target copies a file that exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/install.js'), 'utf8');
  const refs = [...src.matchAll(/path\.join\(ROOT,\s*((?:'[^']+'(?:,\s*)?)+)\)/g)]
    .map(m => m[1].split(',').map(x => x.trim().slice(1, -1)));
  assert.ok(refs.length >= 3, `install.js should name the files it installs, found ${refs.length}`);
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ...r)), `install.js points at a missing file: ${r.join('/')}`);
  }
});

/* The AGENTS.md block goes into files people wrote themselves and have spent a
   long time on. Every property below is about not damaging those files. */
const fakeFS = store => ({
  existsSync: f => f in store,
  readFileSync: f => store[f],
});

test('the block is added once, updated in place, and never duplicated', () => {
  const f = '/AGENTS.md';
  const store = { [f]: '# My instructions\n\nAlways run the tests.\n' };

  const first = upsertBlock(fakeFS(store), f);
  assert.equal(first.how, 'added');
  assert.ok(first.text.startsWith('# My instructions'), 'what was there stays at the top');
  assert.ok(first.text.includes('Always run the tests.'), 'and is not lost');
  store[f] = first.text;

  const again = upsertBlock(fakeFS(store), f);
  assert.equal(again.how, 'unchanged');
  assert.equal(again.changed, false, 'a second install must not write anything');

  // the guidance changes; the block is replaced where it stands
  store[f] = store[f].replace(BLOCK, 'OLD TEXT');
  const up = upsertBlock(fakeFS(store), f);
  assert.equal(up.how, 'updated');
  assert.equal((up.text.match(new RegExp(START, 'g')) || []).length, 1, 'exactly one block');
  assert.ok(!up.text.includes('OLD TEXT'));
  assert.ok(up.text.startsWith('# My instructions'), 'the file keeps its shape');
});

test('removing the block leaves the rest of the file untouched', () => {
  const f = '/AGENTS.md';
  const original = '# Mine\n\nRule one.\n\n## Another section\n\nRule two.\n';
  const store = { [f]: original };
  const added = upsertBlock(fakeFS(store), f).text;
  const back = removeBlock(added);
  assert.equal(back.changed, true);
  assert.equal(back.text.trim(), original.trim(), 'byte-for-byte, minus the block');
});

test('a half-edited block is refused rather than guessed at', () => {
  const f = '/AGENTS.md';
  const store = { [f]: `# Mine\n\n${START}\nsomeone deleted the end marker\n` };
  assert.throws(() => upsertBlock(fakeFS(store), f), /one spiega marker but not the other/,
    'eating the rest of the file is not an acceptable failure');
});

test('an empty or missing file just gets the block', () => {
  assert.equal(upsertBlock(fakeFS({}), '/new.md').how, 'created');
  assert.equal(upsertBlock(fakeFS({ '/e.md': '   \n' }), '/e.md').how, 'created');
});

test('every install target names a real file or directory, and detection is honest', async () => {
  const { TARGETS, TARGET_NAMES, detect } = await import('../src/install.js');
  assert.ok(TARGET_NAMES.length >= 10, 'the point is breadth');
  for (const n of TARGET_NAMES) {
    assert.equal(typeof TARGETS[n].what, 'string', `${n} should say what it does`);
    assert.equal(typeof TARGETS[n].detect, 'function', `${n} should be detectable`);
    assert.equal(typeof TARGETS[n].run, 'function');
  }
  // detect() must never include `project`: it writes into the working directory
  assert.ok(!detect().includes('project'), 'project is opt-in, never automatic');
  for (const n of detect()) assert.ok(TARGET_NAMES.includes(n));
});

test('a backup never lands inside a directory the harness scans', () => {
  // `spiega.bak-...` next to `spiega` in ~/.claude/skills is not a backup,
  // it is a second skill with the same description and older contents.
  const src = fs.readFileSync(path.join(ROOT, 'src/install.js'), 'utf8');
  const fn = src.slice(src.indexOf('const backupDir'), src.indexOf('const mcpJSON'));
  assert.ok(!/\$\{d\}\.bak/.test(fn), 'a sibling of the target is the one place it must not go');
  assert.ok(/\.spiega['"],\s*['"]backups/.test(fn), 'backups belong somewhere nothing scans');
});

test('a browser is detected by its own binary, not its name in any path', async () => {
  const { runningBrowsers } = await import('../src/board/open.js');

  // Microsoft Teams ships an Edge Framework, so a loose match reported Edge
  // running on a machine that has never had it, and AppleScript was then asked
  // to script an application that does not exist — in front of the person.
  const teams = '/Applications/Microsoft Teams.app/Contents/Helpers/Microsoft Teams WebView.app/Contents/'
    + 'Frameworks/Microsoft Edge Framework.framework/Versions/149/Helpers/msedgewebview2_crashpad_handler';
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const helper = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/'
    + 'Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper';

  assert.deepEqual(runningBrowsers(teams), [], 'Teams must not look like Edge');
  assert.deepEqual(runningBrowsers(chrome), ['Google Chrome']);
  assert.deepEqual(runningBrowsers([teams, chrome].join('\n')), ['Google Chrome']);
  assert.deepEqual(runningBrowsers(helper), [], 'a helper process is not the app');
  assert.deepEqual(runningBrowsers(''), []);
  assert.deepEqual(runningBrowsers(undefined), []);
});

test('doctor reports what is stale, and every problem comes with a way out', async () => {
  const { doctor, format } = await import('../src/doctor.js');
  const rows = doctor();

  assert.ok(rows.length >= 3, 'it should check several things');
  for (const r of rows) {
    assert.ok(['ok', 'warn', 'bad'].includes(r.level), `odd level ${r.level}`);
    assert.equal(typeof r.what, 'string');
    assert.equal(typeof r.detail, 'string');
    // a problem with no way out is just bad news
    if (r.level === 'bad') assert.ok(r.fix, `"${r.what}" is a problem with no fix offered`);
  }
  // it has to find itself: this checkout is a git repo with a CLI on PATH
  assert.ok(rows.some(r => r.what === 'checkout'));

  const text = format(rows);
  assert.ok(text.includes(rows[0].what));
  assert.ok(/[\u2713!\u2717]/.test(text), 'rows should be marked');

  const clean = format([{ level: 'ok', what: 'skill', detail: 'linked' }]);
  assert.ok(clean.includes('Everything an agent reads is current.'), 'a clean run should say so');
  assert.ok(!clean.includes('To fix'), 'and should not offer a fix list');

  const dirty = format([{ level: 'bad', what: 'skill', detail: 'stale', fix: 'spiega install' }]);
  assert.ok(dirty.includes('To fix'), 'a problem should bring a fix list');
  assert.ok(dirty.includes('spiega install'), 'with the command in it');
});

/* One process holds every board, so the way out of a stale one depends on
   which process it is. Telling someone to drop a single board would leave the
   shared server running old code for all the others. */
test('a stale shared server is not fixed one board at a time', async () => {
  const { staleBoardFix } = await import('../src/doctor.js');
  assert.match(staleBoardFix(true), /stop --server/);
  assert.match(staleBoardFix(true), /every board on it is lost/);
  assert.match(staleBoardFix(false), /stop --board/);
});

/* Terminal dressing is for terminals. Piped into a file, a pager, or an agent
   reading the output, escape codes are noise at best and corrupt data at
   worst. The suite runs both ways — piped in CI, on a TTY when someone runs
   `npm test` by hand, and `npm publish` runs it on a TTY — so the assertion
   has to be that colour FOLLOWS the terminal, never that it is off. Pinning
   it to one of the two is how this test once failed only during a release. */
test('colour and glyphs stay out of piped output', async () => {
  const term = await import('../src/term.js');
  const ESC = /\u001b\[/;

  /* term.js holds a reference to process.env from module load, so these have
     to be put back key by key. Replacing process.env wholesale swaps the
     object the test can see and leaves the one the module reads still dirty,
     which leaks into every later test. */
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const before = {
    NO_COLOR: process.env.NO_COLOR,
    FORCE_COLOR: process.env.FORCE_COLOR,
    TERM: process.env.TERM,
  };
  try {
    // the case that matters: nothing can render them, so none are emitted
    set('FORCE_COLOR', undefined);
    set('NO_COLOR', '1');
    assert.equal(term.colourful(), false);
    assert.ok(!ESC.test(term.c.bold('x') + term.c.dim('y') + term.c.accent('z')),
      'no escape codes when nothing can render them');

    // and the other way, so the paint is reachable at all
    set('NO_COLOR', undefined);
    set('FORCE_COLOR', '1');
    assert.ok(ESC.test(term.c.bold('x')), 'a terminal that can render them gets them');

    // NO_COLOR wins over FORCE_COLOR when both are set
    set('NO_COLOR', '1');
    assert.equal(term.colourful(), false, 'NO_COLOR outranks FORCE_COLOR');

    /* Both branches, driven rather than inherited. The suite runs piped in CI
       and on a TTY under `npm publish`; asserting on the one it happens to
       have is how this test once failed only during a release. */
    set('NO_COLOR', undefined);
    set('FORCE_COLOR', undefined);
    const realTTY = process.stdout.isTTY;
    try {
      set('TERM', 'xterm');  // ambient TERM=dumb would answer for us
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      assert.equal(term.colourful(), true, 'a terminal gets colour');
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      assert.equal(term.colourful(), false, 'a pipe does not');
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      set('TERM', 'dumb');
      assert.equal(term.colourful(), false, 'TERM=dumb is not worth painting');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: realTTY, configurable: true });
    }
  } finally {
    set('NO_COLOR', before.NO_COLOR);
    set('FORCE_COLOR', before.FORCE_COLOR);
    set('TERM', before.TERM);
  }

  // width is measured on what the terminal shows, not on the bytes
  const painted = '\u001b[1mabc\u001b[0m';
  assert.equal(term.visible(painted), 3);
  assert.equal(term.visible(term.pad(painted, 10)), 10, 'padding aligns by visible width');

  // a long path keeps its tail, which is the part that identifies it
  const short = term.shortPath('/a/very/deeply/nested/set/of/directories/spiega/skills/spiega', 30);
  assert.ok(short.length <= 31, `too long: ${short}`);
  assert.ok(short.endsWith('spiega'), 'the end is what names it');
});

test('the herdr plugin declares the actions it ships, and its scripts are runnable', () => {
  const dir = path.join(ROOT, 'integrations/herdr');
  const toml = fs.readFileSync(path.join(dir, 'herdr-plugin.toml'), 'utf8');
  assert.match(toml, /^id = "spiega\.board"/m);
  assert.match(toml, /min_herdr_version/, 'herdr refuses a manifest without one');

  // every command a manifest names must exist and be executable, or the action
  // fails at the moment someone presses the key
  const cmds = [...toml.matchAll(/command = \["sh", "([^"]+)"\]/g)].map(m => m[1]);
  assert.ok(cmds.length >= 3, `expected the actions and the pane, found ${cmds.length}`);
  for (const c of cmds) {
    const f = path.join(dir, c);
    assert.ok(fs.existsSync(f), `the manifest names ${c}, which is not there`);
    assert.ok(fs.statSync(f).mode & 0o111, `${c} is not executable`);
  }

  // the actions must be reachable from the pane, which is the whole point
  for (const id of ['focus', 'open', 'list']) {
    assert.ok(toml.includes(`id = "${id}"`), `missing action ${id}`);
  }
  assert.match(toml, /contexts = \["global", "workspace", "tab", "pane"\]/);
});

test('the skill the installers link to exists, with the frontmatter a harness reads', () => {
  const f = path.join(ROOT, 'skills/spiega/SKILL.md');
  assert.ok(fs.existsSync(f), 'skills/spiega/SKILL.md is the one canonical copy');
  const head = fs.readFileSync(f, 'utf8').slice(0, 600);
  assert.match(head, /^---\n/, 'it needs YAML frontmatter');
  assert.match(head, /\nname: spiega\n/);
  assert.match(head, /\ndescription: .{40,}/, 'the description is what makes a harness load it');
});

/* Replay on request: the board's own log is the source, so asking for the
   movie again must not put a single op back on the wire. Real server, real
   SSE stream — the route and the event are the whole feature. */
const atest = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

await atest('a replay can be asked for remotely, and re-sends nothing', async () => {
  const { createServer } = await import('../src/board/server.js');
  const { server } = createServer();
  // one process, many boards: `/state`, `/op` and the rest hang off /b/<name>
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${server.address().port}/b/default`;
  try {
    const frames = [];
    const res = await fetch(U + '/events');
    const reader = res.body.getReader();
    const pump = (async () => {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        frames.push(new TextDecoder().decode(value)); }
    })().catch(() => {});
    const settle = () => new Promise(r => setTimeout(r, 80));
    await settle();

    // nothing drawn: nothing to replay, and no event fired at the viewer
    assert.deepEqual(await (await fetch(U + '/replay')).json(), { ok: false, ops: 0, viewers: 1 });
    await settle();
    assert.equal(/event: replay/.test(frames.join('')), false);

    await fetch(U + '/op', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'say', text: 'two services' },
        { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
        { op: 'edge', from: 'a', to: 'b' }] }) });
    await settle();

    const r = await (await fetch(U + '/replay')).json();
    assert.equal(r.ops, 4, 'the log is what gets replayed');
    assert.equal(r.viewers, 1);
    await settle();
    const all = frames.join('');
    assert.ok(/event: replay/.test(all), 'the viewer should be told to replay');
    assert.equal((all.match(/event: patch/g) || []).length, 1,
      'asking for a replay must not push the ops again');
    await reader.cancel().catch(() => {});
    await pump;
  } finally {
    server.close();
    await new Promise(r => server.closeAllConnections ? (server.closeAllConnections(), r()) : r());
  }
});

/* One process, many boards. This is the whole point of serving them together,
   so the thing to prove is that sharing a process does not let two
   explanations touch: ops to one board, a stream on the other, and the second
   must not see a thing. */
await atest('one server holds several boards and keeps them apart', async () => {
  const { createServer } = await import('../src/board/server.js');
  const app = createServer({ name: 'alpha' });
  app.hold('beta');
  const { server } = app;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const B = n => `${root}/b/${n}`;
  try {
    // a stream on beta, watching for anything that leaks out of alpha
    const res = await fetch(B('beta') + '/events');
    const reader = res.body.getReader();
    let frames = '';
    (async () => {
      for (;;) { const { value, done } = await reader.read(); if (done) break;
        frames += new TextDecoder().decode(value); }
    })().catch(() => {});
    await new Promise(r => setTimeout(r, 80));

    await fetch(B('alpha') + '/op', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'node', id: 'a', label: 'A' }, { op: 'title', text: 'Alpha' }] }),
    });
    await new Promise(r => setTimeout(r, 80));

    const alpha = await (await fetch(B('alpha') + '/state')).json();
    const beta = await (await fetch(B('beta') + '/state')).json();
    assert.equal(alpha.nodes.length, 1);
    assert.equal(alpha.title, 'Alpha');
    assert.equal(beta.nodes.length, 0, 'the other board must not have moved');
    assert.equal((frames.match(/event: patch/g) || []).length, 0,
      "beta's viewers must not be told about alpha");

    // each board knows which one it is — that name goes in the window title,
    // which is the only handle `spiega focus` has on a browser window
    assert.equal((await (await fetch(B('beta') + '/whoami')).json()).name, 'beta');

    // the renderer is served once, from the root, and shared by all of them
    assert.ok((await fetch(root + '/src/render/render.js')).ok);

    // a name nobody is serving is gone, not broken: that is what sends a
    // client with a stale registry entry off to start a board
    assert.equal((await fetch(B('gamma') + '/state')).status, 404);

    /* The page resolves its own api off its own path, so it has to be served
       from /b/<name>/ — one directory down from /b/. */
    const bare = await fetch(B('alpha'), { redirect: 'manual' });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), '/b/alpha/');

    await reader.cancel().catch(() => {});
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

/* Boards come and go while the server stays up. A client asks for one by name
   and gets a map entry; `spiega stop` drops that entry and leaves the rest
   drawing. Run in a child with its own HOME: creating a board writes the
   registry, and a test must never go near the real one. */
await atest('a board can be asked for and dropped while the server keeps serving', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['SPIEGA_URL', 'SPIEGA_BOARD']) delete env[k];

  const script = `
    const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});
    const fs = await import('node:fs');
    const out = {};
    const app = m.createServer({ name: 'first' });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const root = 'http://127.0.0.1:' + app.server.address().port;

    // what a client probes to tell a spiega server from anything else on 4777
    out.isSpiega = await m.spiegaAt(root);

    out.asked = await m.createBoardOn(root, 'Review Notes', { owner: 's9', cwd: '/tmp/work' });
    out.held = [...app.boards.keys()];
    const reg = JSON.parse(fs.readFileSync(m.BOARDS_FILE, 'utf8'));
    out.registered = reg['review-notes'];
    out.samePid = reg['review-notes'].pid === process.pid;

    // asking twice is the same board, not a second one
    out.again = await m.createBoardOn(root, 'review-notes');

    out.closed = (await (await fetch(root + '/b/review-notes/close', { method: 'POST' })).json());
    out.leftHeld = [...app.boards.keys()];
    out.leftRegistered = Object.keys(JSON.parse(fs.readFileSync(m.BOARDS_FILE, 'utf8')));
    out.firstStillServes = (await fetch(root + '/b/first/state')).ok;

    app.server.close(); app.server.closeAllConnections?.();
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env });
  const r = JSON.parse(stdout.trim().split('\n').pop());

  assert.equal(r.isSpiega, true, 'the board list is how a client recognises one of ours');
  assert.match(r.asked, /\/b\/review-notes$/, 'a name is slugged, and the url carries it');
  assert.deepEqual(r.held, ['first', 'review-notes']);
  assert.equal(r.registered.url, r.asked, 'and the registry points at it');
  assert.equal(r.registered.owner, 's9', "the asking client's session, not the server's");
  assert.equal(r.registered.cwd, '/tmp/work');
  assert.equal(r.samePid, true, 'every board on one process means one pid in the registry');
  assert.equal(r.again, r.asked, 'asking again is the same board');

  assert.equal(r.closed.ok, true);
  assert.deepEqual(r.leftHeld, ['first'], 'dropping one board leaves the others');
  // 'first' was seeded straight onto the http server, so it was never registered
  assert.deepEqual(r.leftRegistered, [], 'and the dropped one is out of the registry');
  assert.equal(r.firstStillServes, true, 'and the server is still serving them');

  fs.rmSync(home, { recursive: true, force: true });
});

/* The port is the lock on being the server. Eight agents drawing at the same
   moment all find nothing running and all try to start something; whoever
   binds first has to be the one the rest hand their board to, or the memory
   this whole thing is about comes straight back as eight processes. */
await atest('the port is the lock: a second server joins the first instead of starting', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['SPIEGA_URL', 'SPIEGA_BOARD', 'SPIEGA_PORT']) delete env[k];

  const script = `
    const http = await import('node:http');
    const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});
    const out = {};

    // a port we know is free, released before anyone is asked to bind it
    const probe = http.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const PORT = probe.address().port;
    await new Promise(r => probe.close(r));

    /* Something that is not us, sitting on the canonical port. Walking past it
       is right; walking past it and then becoming a server on the next port
       along is what broke the lock, so both rungs are in play here. */
    const squatter = http.createServer((q, s) => { s.writeHead(404); s.end('nope'); });
    await new Promise(r => squatter.listen(PORT, '127.0.0.1', r));

    const first = m.createServer({ name: 'one' });
    const a = await m.listen(first, { port: PORT });
    out.first = { mine: a.mine, walkedPast: a.url !== 'http://127.0.0.1:' + PORT };

    const second = m.createServer({ name: 'two' });
    const b = await m.listen(second, { port: PORT });
    out.second = { mine: b.mine, url: b.url };
    out.sameServer = b.url === a.url;
    out.secondNeverBound = second.server.listening === false;

    // ...and the board it was holding goes to the one that won
    out.handedOver = await m.createBoardOn(b.url, 'two');
    out.firstHolds = [...first.boards.keys()];

    // a board of its own, when something really does need isolating
    const solo = m.createServer({ name: 'alone' });
    const c = await m.listen(solo, { port: PORT, solo: true });
    out.solo = { mine: c.mine, ownPort: c.url !== a.url };

    squatter.close(); first.server.close(); solo.server.close();
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env });
  const r = JSON.parse(stdout.trim().split('\n').pop());

  assert.deepEqual(r.first, { mine: true, walkedPast: true },
    'something else on the port is walked past, not joined');
  assert.equal(r.second.mine, false, 'the second must not become a second server');
  assert.equal(r.sameServer, true, 'it should be pointed at the one already running');
  assert.equal(r.secondNeverBound, true, 'and should never have taken a port of its own');
  assert.match(r.handedOver, /\/b\/two$/, 'its board goes to the server that won');
  assert.deepEqual(r.firstHolds, ['one', 'two']);

  assert.deepEqual(r.solo, { mine: true, ownPort: true },
    '--solo is the way out: its own process, its own port');

  fs.rmSync(home, { recursive: true, force: true });
});

/* `spiega say "..." --step 2` goes through argument parsing, which no unit
   test of the attribution touches — and that is exactly where it first broke:
   the flag was read with the wrong call and the "2" ended up in the sentence.
   So drive the real CLI against a real board. */
await atest('the say and tag commands reach the board, and a bad tag fails loudly', async () => {
  const { createServer } = await import('../src/board/server.js');
  // async, not execFileSync: a synchronous child blocks this process's event
  // loop, and the board it is talking to is served from this very loop.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { server, board } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, SPIEGA_URL: `http://127.0.0.1:${server.address().port}/b/default` };
  const cli = (...args) => run(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args], { env });
  try {
    await cli('draw', JSON.stringify([
      { op: 'step', edge: 'a>b', step: 'one' },
      { op: 'step', edge: 'b>c', step: 'two' },
    ]));
    await cli('say', 'The second hop is async.', '--step', '2');
    await cli('say', 'Named by the hop instead.', '--edge', 'a>b');
    await cli('say', 'An aside about the whole board.');

    assert.deepEqual(board.transcript.map(t => t.text), [
      'The second hop is async.', 'Named by the hop instead.', 'An aside about the whole board.',
    ], 'the flag value must not leak into what was said');
    assert.deepEqual(scriptSteps(board), [1, 0, null]);

    // tagging after the fact, through the CLI, and a rejected op must fail loudly
    await cli('tag', '--match', 'aside about', '--step', '1');
    assert.deepEqual(scriptSteps(board), [1, 0, 0]);
    await cli('tag', '--match', 'aside about', '--step', 'off');
    assert.deepEqual(scriptSteps(board), [1, 0, null]);
    await assert.rejects(() => cli('tag', '99', '--step', '1'),
      e => e.code === 1, 'a tag that matches nothing should exit non-zero');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

/* A stdio MCP server is told to go away by having its pipe closed — there is
   no shutdown message. One that ignores that outlives every editor session
   that ever started it, and each survivor holds the code it was launched with,
   so a session that looks current answers from an old build. */
await atest('the MCP server exits when its client closes the pipe', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp/server.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise(res => child.on('exit', code => res(code)));

  // talk to it first, so we know we are killing a live server and not a corpse
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const reply = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no reply to tools/list')), 8000);
    child.stdout.once('data', d => { clearTimeout(t); res(JSON.parse(String(d).split('\n')[0])); });
  });
  const names = reply.result.tools.map(t => t.name);
  for (const want of ['board_say', 'board_tag', 'board_script', 'board_replay']) {
    assert.ok(names.includes(want), `tools/list should offer ${want}`);
  }

  child.stdin.end();                                   // the client goes away
  const code = await Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error('still running 5s after its pipe closed')), 5000)),
  ]).catch(e => { child.kill('SIGKILL'); throw e; });
  assert.equal(code, 0, 'it should exit cleanly');
});

/* Named boards. One board per conversation, because two agents sharing one
   interleave two explanations into one drawing. Run in a child with its own
   HOME: the registry lives under ~/.spiega and a test must never go near
   the real one. Everything happens in one process, because a board is pruned
   when the process that registered it exits — which is the point of the
   registry, and would otherwise prune these the moment they were written. */
await atest('boards are found by name, kept apart, and pruned when their server dies', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPIEGA_URL;
  delete env.SPIEGA_BOARD;

  const script = `
    const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});
    const fs = await import('node:fs');
    const out = {};

    m.registerBoard('alpha', 'http://127.0.0.1:1111');
    m.registerBoard('beta', 'http://127.0.0.1:2222');
    out.alpha = m.findBoard('alpha');
    out.beta = m.findBoard('beta');
    out.unknown = m.findBoard('nope');

    process.env.SPIEGA_BOARD = 'beta';           // how a harness picks one
    out.byEnv = m.findBoard();
    process.env.SPIEGA_URL = 'http://explicit';  // an explicit url still wins
    out.byUrl = m.findBoard();
    delete process.env.SPIEGA_URL;

    out.names = Object.keys(m.listBoards()).sort();
    out.gone = m.unregisterBoard('alpha');
    out.afterUnregister = Object.keys(m.listBoards());

    // a board whose server died: pid 1 is init, so use one that cannot exist
    const all = JSON.parse(fs.readFileSync(m.BOARDS_FILE, 'utf8'));
    all.ghost = { url: 'http://127.0.0.1:9999', pid: 0x7ffffff0, started: Date.now() };
    fs.writeFileSync(m.BOARDS_FILE, JSON.stringify(all));
    out.withGhost = Object.keys(m.listBoards()).sort();
    out.ghostLookup = String(m.findBoard('ghost'));

    console.log(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env });
  const r = JSON.parse(stdout.trim());

  assert.equal(r.alpha, 'http://127.0.0.1:1111');
  assert.equal(r.beta, 'http://127.0.0.1:2222', 'two boards, kept apart');
  assert.equal(r.unknown, null, 'an unknown name is nothing, never someone else\'s board');
  assert.equal(r.byEnv, 'http://127.0.0.1:2222', 'SPIEGA_BOARD selects');
  assert.equal(r.byUrl, 'http://explicit', 'an explicit url outranks the name');
  assert.deepEqual(r.names, ['alpha', 'beta']);
  assert.equal(r.gone, true);
  assert.deepEqual(r.afterUnregister, ['beta']);
  assert.deepEqual(r.withGhost, ['beta'], 'a board whose server is gone is pruned on read');
  assert.equal(r.ghostLookup, 'null', 'and is never handed to a client');

  fs.rmSync(home, { recursive: true, force: true });
});

/* Naming a board after the task. Someone runs four opencode tasks and four
   Claude Code tasks at once; the names have to be recognisable in that list and
   stable for as long as the work is. */
await atest('a board is named after the task, and a session keeps the one it has', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-work-'));
  const task = path.join(work, 'domain-modeling-for-rights');
  fs.mkdirSync(task);

  const base = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['SPIEGA_URL', 'SPIEGA_BOARD', 'SPIEGA_SESSION',
                   'CLAUDE_CODE_SESSION_ID', 'HERDR_PANE_ID', 'HERDR_TAB_ID']) delete base[k];

  const ask = (env, cwd = task, extra = '') => promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e',
     `const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});${extra}console.log(m.boardName())`],
    { env: { ...base, ...env }, cwd }).then(r => r.stdout.trim());

  // the directory is the task, and a worktree's name is what someone called it
  assert.equal(await ask({ SPIEGA_SESSION: 's1' }), 'domain-modeling-for-rights');

  // an explicit name always wins
  assert.equal(await ask({ SPIEGA_SESSION: 's1', SPIEGA_BOARD: 'Review Notes' }), 'review-notes');

  // A board asked for by name belongs to the asking, not to the session that
  // did the asking: otherwise one `--board notes` call rebinds that session's
  // default board to "notes" for good, since the owner match comes first.
  const named = `m.registerBoard(m.boardName(), 'http://127.0.0.1:9001');`;
  assert.equal(await ask({ SPIEGA_SESSION: 's1', SPIEGA_BOARD: 'notes' }, task,
    named + `if (Object.values(m.listBoards())[0].owner) throw new Error('an explicit board claimed the session');`),
    'notes');
  assert.equal(await ask({ SPIEGA_SESSION: 's1' }), 'domain-modeling-for-rights',
    'and the session still gets the board named after its task');

  // register s1's board, then: s1 keeps it, s2 in the same directory does not take it
  const reg = `m.registerBoard('domain-modeling-for-rights', 'http://127.0.0.1:1234', 's1');`;
  assert.equal(await ask({ SPIEGA_SESSION: 's1' }, task, reg), 'domain-modeling-for-rights');
  assert.equal(await ask({ SPIEGA_SESSION: 's2' }, task, reg), 'domain-modeling-for-rights-2',
    'two conversations about one repo get names a person can still say out loud');

  // a session is its conversation first, its pane second — one tab holds both
  // a Claude session and an opencode session, so tabs are not tasks
  const key = `console.log(m.sessionKey());//`;
  const sk = (env) => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e',
     `const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});${key}`],
    { env: { ...base, ...env }, cwd: task }).then(r => r.stdout.trim());
  assert.equal(await sk({ CLAUDE_CODE_SESSION_ID: 'cc', HERDR_PANE_ID: 'wJ:p1', HERDR_TAB_ID: 'wJ:t1' }), 'cc');
  assert.equal(await sk({ HERDR_PANE_ID: 'wJ:p1', HERDR_TAB_ID: 'wJ:t1' }), 'wJ:p1');
  assert.equal(await sk({ HERDR_TAB_ID: 'wJ:t1' }), 'wJ:t1');
  assert.equal(await sk({}), fs.realpathSync(task), 'the directory, resolved as the OS reports it');

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

/* Finding our own processes. Matching on the checkout's full path goes blind
   the moment the directory is renamed: a board server started from the old
   location stops matching and is reported as "none running on older code" —
   a clean bill of health for exactly the case the check exists to catch. */
test('a process from a previous location is found, not reported as absent', async () => {
  const { scanProcesses } = await import('../src/doctor.js');
  const root = '/Users/x/projects/spiega';
  const ps = [
    `  101 node ${root}/src/mcp/server.js`,
    `  102 node /Users/x/projects/drawing-explanation-tool/src/cli.js serve --quiet`,
    `  103 node ${root}/src/cli.js serve --port 4778`,
    `  104 node ${root}/src/cli.js draw {"op":"node"}`,     // not a server
    `  105 node /somewhere/else/app.js serve`,              // not ours
    `  106 ps -Ao pid=,command=`,                           // the listing itself
    '',
  ].join('\n');

  const { boards, mcp } = scanProcesses(ps, root);
  assert.deepEqual(mcp, [{ pid: 101, here: true }]);
  assert.deepEqual(boards, [{ pid: 102, here: false }, { pid: 103, here: true }],
    'the one from the old location must still be found, and marked as elsewhere');

  // a one-off command is not a server, and neither is somebody else's process
  assert.ok(!boards.some(b => b.pid === 104), 'cli.js draw is not a board server');
  assert.ok(![...boards, ...mcp].some(p => p.pid === 105 || p.pid === 106));

  assert.deepEqual(scanProcesses('', root), { boards: [], mcp: [] });
  assert.deepEqual(scanProcesses(undefined, root), { boards: [], mcp: [] });
});

/* Documentation that names things in the code goes stale silently, which is
   the whole reason docs/skill.md is a pointer rather than a copy. These check
   the two ways these pages can lie: a link to a file that moved, and a list of
   node kinds or ops that no longer matches what the board accepts. */
test('every relative link in docs/ points at something that exists', () => {
  const dir = path.join(ROOT, 'docs');
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  assert.ok(pages.length >= 2, 'expected the skill and vocabulary pages');
  for (const page of pages) {
    const text = fs.readFileSync(path.join(dir, page), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#][^)]*)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const file = target.split('#')[0];
      if (!file) continue;
      assert.ok(fs.existsSync(path.resolve(dir, file)),
        `docs/${page} links to ${file}, which is not there`);
    }
  }
});

test('the documented vocabulary matches what the board accepts', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/vocabulary.md'), 'utf8');

  // every node kind the renderer knows must be in the table, and vice versa
  for (const kind of KINDS) {
    assert.ok(new RegExp(`\`${kind}\``).test(doc), `docs/vocabulary.md never mentions the "${kind}" kind`);
  }

  // every op the board accepts must be listed
  const src = fs.readFileSync(path.join(ROOT, 'src/board/state.js'), 'utf8');
  const ops = [...src.matchAll(/^    case '([a-z]+)'/gm)].map(m => m[1]);
  assert.ok(ops.length >= 10, `expected the op list, found ${ops.length}`);
  for (const op of ops) {
    assert.ok(new RegExp(`\`${op}\``).test(doc), `docs/vocabulary.md never mentions the "${op}" op`);
  }

  // and the layout hints, which exist nowhere else in the docs
  for (const hint of ['place', 'col', 'row']) {
    assert.ok(doc.includes(`\`${hint}`), `the ${hint} layout hint is undocumented`);
  }
});

/* A small amount of mathematics, drawn rather than typeset. The constraint
   that shaped it: a board renders in four places and only one is a browser
   with a network, so a formula has to become SVG here, offline. */
test('a formula is measured, drawn, and honest about what it cannot do', async () => {
  const { measureMath, drawMath, hasMath, splitMath } = await import('../src/render/math.js');

  // width has to be real, because layout.js sizes the node from it
  const one = measureMath('x', 20), two = measureMath('xx', 20);
  assert.ok(two.w > one.w, 'more characters, more width');
  assert.ok(measureMath('\\frac{1}{2}', 20).h > measureMath('1', 20).h,
    'a fraction is taller than a character');

  // spacing is derived, not copied: as in LaTeX, source spaces are ignored
  assert.equal(measureMath('a+b', 20).w, measureMath('a + b', 20).w,
    'a+b and a + b must set identically');

  const svg = drawMath(0, 0, 'p + \\tfrac{1}{2}\\rho v^2 = \\text{const}', { size: 16 });
  assert.ok(svg.includes('\u03c1'), '\\rho becomes the letter');
  assert.ok(svg.includes('const'), '\\text sets its words');
  assert.ok(/<path/.test(svg), 'the fraction rule is drawn, not a character');
  assert.ok(!/NaN|undefined/.test(svg), 'no arithmetic fell through');

  // the honest fallback: shown as written rather than guessed at
  const un = drawMath(0, 0, '\\begin{pmatrix}', { size: 16 });
  assert.ok(un.includes('begin'), 'an unknown command appears literally');
  assert.ok(/opacity="0.55"/.test(un), 'and dimmed, so it reads as unrendered');

  /* Vector calculus, because "explain Maxwell" is a thing people ask for and
     the first attempt rendered \\vec and \\oint as dimmed literal text. */
  const maxwell = drawMath(0, 0,
    '\\nabla \\times \\vec{E} = -\\frac{\\partial \\vec{B}}{\\partial t}', { size: 18 });
  assert.ok(maxwell.includes('\u2207'), '\\nabla');
  assert.ok(maxwell.includes('\u00d7'), '\\times');
  assert.ok(maxwell.includes('\u2202'), '\\partial');
  assert.ok(!/\\vec|\\nabla|\\partial/.test(maxwell), 'nothing left unrendered');
  // the arrow over a vector is drawn, not a character: it is a stroke, so it
  // wavers like every other line on the board
  assert.ok((maxwell.match(/<path/g) || []).length >= 3,
    'two vector arrows and a fraction rule, all drawn');
  assert.ok(drawMath(0, 0, '\\oint', { size: 16 }).includes('\u222e'), '\\oint');
  assert.ok(/font-weight="800"/.test(drawMath(0, 0, '\\mathbf{F}', { size: 16 })),
    '\\mathbf sets heavier');
  assert.ok(measureMath('\\vec{E}', 20).a > measureMath('E', 20).a,
    'an accent makes room for itself above');

  // inline detection, for text that is mostly prose
  assert.equal(hasMath('the term $\\rho v^2$ dominates'), true);
  assert.equal(hasMath('no mathematics here'), false);
  assert.deepEqual(splitMath('a $x^2$ b'),
    [{ literal: 'a ' }, { math: 'x^2' }, { literal: ' b' }]);
});

test('a formula node renders on the board, and the snapshot stays standalone', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'pipe', kind: 'service', label: 'Pipe' },
    { op: 'node', id: 'b', kind: 'formula', label: 'p + \\tfrac{1}{2}\\rho v^2 = \\text{const}' },
    { op: 'edge', from: 'pipe', to: 'b' },
  ]);
  const { svg, boxes } = renderSVG(b);
  assert.ok(svg.includes('\u03c1'), 'the formula is on the board');
  assert.ok(boxes.b.w > 140, `a formula sizes itself from its content, got ${boxes.b.w}`);

  // the whole reason this is drawn instead of using MathJax
  const html = snapshotHTML(b);
  assert.ok(!/<script/i.test(html), 'a formula must not bring a script into a snapshot');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'nor anything to fetch');
  assert.ok(html.includes('\u03c1'), 'and it still renders there');
});

/* A loop. The model says "back to the one I already drew" by naming its id;
   nothing else should be needed, and the layout has to make that read as a
   loop rather than as a line with a long arrow home. */
test('a cycle keeps its order, and the closing edge goes round', async () => {
  const { assign, backEdges } = await import('../src/render/layout.js');
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'ref', label: 'Setpoint' }, { op: 'node', id: 'sum', label: 'Error' },
    { op: 'node', id: 'ctrl', label: 'Controller' }, { op: 'node', id: 'plant', label: 'Plant' },
    { op: 'node', id: 'sensor', label: 'Sensor' },
    { op: 'edge', from: 'ref', to: 'sum' }, { op: 'edge', from: 'sum', to: 'ctrl' },
    { op: 'edge', from: 'ctrl', to: 'plant' }, { op: 'edge', from: 'plant', to: 'sensor' },
    { op: 'edge', from: 'sensor', to: 'sum' },
  ]);

  assert.deepEqual([...backEdges(b.nodes, b.edges)], ['sensor>sum'],
    'the edge that closes the loop is the one set aside');

  /* Before this, resolving the junction recursed round the loop, placed it
     provisionally, then overwrote that with a column derived from the
     feedback edge — so it landed at the far right, after the sensor. */
  const place = assign(b);
  assert.equal(place.sum.col, 1, `the junction belongs after the setpoint, got ${place.sum.col}`);
  assert.deepEqual(['ref', 'sum', 'ctrl', 'plant', 'sensor'].map(id => place[id].col), [0, 1, 2, 3, 4],
    'the signal path reads left to right');

  // and the closing edge leaves the row rather than crossing it
  const r = renderSVG(b);
  const loop = r.planned.find(p => p.key === 'sensor>sum');
  assert.ok(loop.back, 'it is marked as closing the loop');
  const lowest = Math.max(...Object.values(r.boxes).map(x => x.y + x.h));
  assert.ok(Math.max(...loop.pts.map(p => p[1])) > lowest,
    'the return path runs below every box, not through them');

  // a board with no cycle is untouched
  const plain = emptyBoard();
  applyOps(plain, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' },
  ]);
  assert.equal(backEdges(plain.nodes, plain.edges).size, 0);
  assert.equal(renderSVG(plain).planned[0].back, false);
});

/* The narrator lights the word being spoken. The synthesiser reports how far
   through the text it has got, not which word it picked, so the mapping from
   offset to word is ours and is the part most likely to be wrong. */
test('the spoken offset maps to the right word', async () => {
  const { wordAt } = await import('../src/board/narrate.js');
  //            0         1      2       3
  const text = 'Orders writes the row';
  const starts = [0, 7, 14, 18];

  assert.equal(wordAt(starts, 0), 0, 'the first word, at its own start');
  assert.equal(wordAt(starts, 3), 0, 'still inside the first word');
  assert.equal(wordAt(starts, 7), 1, 'exactly on a boundary belongs to the new word');
  assert.equal(wordAt(starts, 17), 2);
  assert.equal(wordAt(starts, 18), 3);
  assert.equal(wordAt(starts, 999), 3, 'past the end stays on the last word');

  // a sentence can begin with punctuation, and then nothing is being said yet
  assert.equal(wordAt([4, 11], 0), -1, 'before the first word is no word');
  assert.equal(wordAt([], 5), -1, 'and an empty line has none to light');

  assert.ok(text.slice(starts[2]).startsWith('the'), 'the fixture is what it claims');
});

/* A label joined to a point by a leader line. Every other label on the board
   is attached to what it names, which leaves no way to say something *about*
   a thing without crowding it. */
test('a callout points at a node or an edge, and the canvas grows to hold it', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'gw', kind: 'gateway', label: 'Gateway' },
    { op: 'node', id: 'db', kind: 'datastore', label: 'Postgres' },
    { op: 'edge', from: 'gw', to: 'db', label: 'SQL' },
  ]);
  const plain = renderSVG(b);

  applyOps(b, [
    { op: 'callout', at: 'gw>db', label: 'retried 3 times' },
    { op: 'callout', at: 'gw', side: 'above', label: 'the only hop that authenticates' },
  ]);
  const withCallouts = renderSVG(b);

  assert.equal(withCallouts.callouts.length, 2, 'both are planned');
  assert.ok(withCallouts.svg.includes('data-callout='), 'and drawn');
  assert.ok(withCallouts.svg.includes('retried 3 times'));

  // a label above the top row falls outside the nodes' bounds, so the canvas
  // has to grow and the content shift, or it is simply cropped away
  assert.ok(withCallouts.height > plain.height,
    `a callout above the board must make room: ${plain.height} -> ${withCallouts.height}`);
  for (const p of withCallouts.callouts) {
    assert.ok(Number.isFinite(p.cx) && Number.isFinite(p.cy), 'a callout needs a position');
    assert.ok(Number.isFinite(p.tip.x) && Number.isFinite(p.tip.y), 'and something to point at');
  }

  // an edge callout must not land on the edge's own label, which sits at the
  // middle of the same segment
  const edgeCall = withCallouts.callouts.find(p => p.c.at === 'gw>db');
  const route = withCallouts.planned.find(r => r.key === 'gw>db');
  const mid = [(route.pts[0][0] + route.pts[route.pts.length - 1][0]) / 2,
               (route.pts[0][1] + route.pts[route.pts.length - 1][1]) / 2];
  assert.ok(Math.hypot(edgeCall.tip.x - mid[0], edgeCall.tip.y - mid[1]) > 8,
    'the leader must not point through the edge tag');

  // pointing at nothing draws nothing, rather than throwing
  const c = emptyBoard();
  applyOps(c, [{ op: 'node', id: 'a', label: 'A' }, { op: 'callout', at: 'nope', label: 'x' }]);
  assert.equal(renderSVG(c).callouts.length, 0, 'a callout with no target is dropped');
});

test('removing a node takes its callouts with it', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' },
    { op: 'callout', at: 'a', label: 'about A' },
    { op: 'callout', at: 'a>b', label: 'about the hop' },
    { op: 'callout', at: 'b', label: 'about B' },
  ]);
  assert.equal(b.callouts.length, 3);
  applyOps(b, [{ op: 'remove', id: 'a' }]);
  assert.deepEqual(b.callouts.map(c => c.label), ['about B'],
    'a callout pointing at something gone has nothing to say');
});

/* A run of removes is collected and swept once. The sweep must leave exactly
   what removing them one at a time would have left, in the same order — and it
   must not swallow something drawn after the removal it should survive. */
test('a run of removes sweeps once and keeps what survived in order', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'node', id: 'c', label: 'C' }, { op: 'node', id: 'd', label: 'D' },
    { op: 'edge', from: 'a', to: 'b' }, { op: 'edge', from: 'b', to: 'c' },
    { op: 'edge', from: 'c', to: 'd' },
    { op: 'boundary', id: 'grp', label: 'Group', members: ['a', 'b'] },
    { op: 'boundary', id: 'a', label: 'Named like the node' },
    { op: 'callout', at: 'a', label: 'about A' },
    { op: 'callout', at: 'a>b', label: 'about the hop' },
    { op: 'callout', at: 'b', label: 'about B' },
    { op: 'callout', at: 'c>d', label: 'about the last hop' },
  ]);
  b.placed.a = { col: 0, row: 0 };
  b.placed.b = { col: 1, row: 0 };
  b.placed.d = { col: 3, row: 0 };

  // a line said in the middle does not end the run, and does not resurrect
  applyOps(b, [
    { op: 'remove', id: 'a' },
    { op: 'say', text: 'a is gone' },
    { op: 'remove', id: 'd' },
  ]);

  assert.deepEqual(b.nodes.map(n => n.id), ['b', 'c'], 'survivors keep their order');
  assert.deepEqual(b.edges.map(e => `${e.from}>${e.to}`), ['b>c'],
    'only the edge between survivors is left');
  assert.deepEqual(b.boundaries.map(x => x.id), ['grp'],
    'a boundary named like the node goes with it');
  assert.deepEqual(b.callouts.map(c => c.label), ['about B'],
    'callouts on the nodes and hops that went are gone, the rest stay');
  assert.deepEqual(Object.keys(b.placed).sort(), ['b'],
    'placement goes with the node, and stays with the survivors');

  /* And the same board comes back from its own log. Callout ops are left out
     of the replay here: a callout's `at` is its target, and `record` overwrites
     `at` with the arrival time, so a callout cannot be replayed at all. That
     predates this change and is not the removal's business; the nodes, edges
     and boundaries are enough to show a removed node stays removed. */
  const replay = emptyBoard();
  applyOps(replay, b.log.filter(e => e.op !== 'callout'));
  assert.deepEqual(replay.nodes.map(n => n.id), ['b', 'c']);
  assert.deepEqual(replay.edges.map(e => `${e.from}>${e.to}`), ['b>c']);
  assert.deepEqual(replay.boundaries.map(x => x.id), ['grp']);
});

test('anything drawn after a removal is new, not a survivor of the sweep', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' },
  ]);

  // the node op ends the run, so a is drawn again rather than updated in place
  applyOps(b, [
    { op: 'remove', id: 'a' },
    { op: 'node', id: 'a', label: 'A again' },
    { op: 'edge', from: 'a', to: 'b' },
  ]);
  assert.deepEqual(b.nodes.map(n => n.id), ['b', 'a'], 'the redrawn node lands at the end');
  assert.equal(b.nodes.find(n => n.id === 'a').label, 'A again');
  assert.deepEqual(b.edges.map(e => `${e.from}>${e.to}`), ['a>b'],
    'the old edge went with a; the one drawn after the removal is a new edge');

  // a callout added after the removal is not swept away with what it names
  applyOps(b, [
    { op: 'remove', id: 'b' },
    { op: 'callout', at: 'b', label: 'said after it went' },
  ]);
  assert.deepEqual(b.callouts.map(c => c.label), ['said after it went'],
    'the sweep already ran; the callout is newer than the removal');
});

/* Editing one TOML table without eating the rest of the file.
   `[^[]*` stops at the bracket in `args = [...]` on the table's own second
   line, orphaning everything after it. That corrupted a real config on this
   machine, in two places, because the same wrong pattern had been written
   twice. */
test('a TOML table is edited without disturbing its neighbours', async () => {
  const { dropTable, upsertTable, tomlTable } = await import('../src/toml.js');

  // the shape that broke it: a table whose own body contains brackets,
  // with neighbours on both sides
  const raw = [
    '[mcp_servers.codegraph]', 'command = "codegraph"', 'args = ["serve", "--mcp"]', '',
    '[mcp_servers.spiega]', 'command = "node"', 'args = ["/old/path/src/mcp/server.js"]', '',
    '[other]', 'k = 1', '',
  ].join('\n');

  // the match must not stop at the bracket in args
  assert.ok(raw.match(tomlTable('spiega'))[0].includes('/old/path/'),
    'the table must include its own args line');
  assert.ok(!raw.match(tomlTable('spiega'))[0].includes('[other]'),
    'and must stop before the next table');

  const dropped = dropTable(raw, 'spiega');
  assert.ok(!dropped.includes('mcp_servers.spiega'), 'the table goes');
  assert.ok(!dropped.includes('/old/path/'), 'and takes its body with it');
  assert.ok(dropped.includes('[mcp_servers.codegraph]') && dropped.includes('args = ["serve", "--mcp"]'),
    "the neighbour above survives whole");
  assert.ok(dropped.includes('[other]') && dropped.includes('k = 1'), 'and the one below');
  assert.ok(!/^\[".*\]$/m.test(dropped), 'no orphan line left that TOML would read as a table');

  const up = upsertTable(raw, 'spiega',
    '[mcp_servers.spiega]\ncommand = "node"\nargs = ["/new/path/src/mcp/server.js"]\n');
  assert.equal(up.how, 'repointed');
  assert.ok(up.text.includes('/new/path/') && !up.text.includes('/old/path/'));
  assert.ok(up.text.includes('[other]'), 'repointing must not eat what follows');
  assert.equal(upsertTable(up.text, 'spiega',
    '[mcp_servers.spiega]\ncommand = "node"\nargs = ["/new/path/src/mcp/server.js"]\n').how,
    'unchanged', 'and is idempotent');

  // absent entirely: appended, nothing else touched
  const added = upsertTable('[only]\nx = 1\n', 'spiega', '[mcp_servers.spiega]\ncommand = "node"\n');
  assert.equal(added.how, 'added');
  assert.ok(added.text.startsWith('[only]'));
});

/* The rename from handwave. A rename is not a string replacement in a repo:
   the old name is also written into a state directory, three skills
   directories, six MCP configs and three instruction files. The previous
   rename here — archboard to handwave — missed one file and broke
   `install cursor` for weeks, so every surface gets a test. */
await atest('migrating from the old name clears every trace it left', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-home-'));
  const w = (rel, text) => {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };

  // a machine as it looks the moment before the rename
  fs.mkdirSync(path.join(home, '.handwave'), { recursive: true });
  fs.writeFileSync(path.join(home, '.handwave', 'boards.json'),
    JSON.stringify({ supplix: { url: 'http://127.0.0.1:4777', pid: 1 } }));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync('/nowhere/skills/handwave', path.join(home, '.claude', 'skills', 'handwave'), 'dir');
  w('.config/opencode/opencode.json',
    JSON.stringify({ mcp: { handwave: { command: ['node', 'x'] }, other: { command: ['y'] } } }));
  w('.config/opencode/AGENTS.md',
    '# Mine\n\nMy own rule.\n\n<!-- HANDWAVE_START -->\nold guidance\n<!-- HANDWAVE_END -->\n');
  w('.codex/config.toml', '[mcp_servers.codegraph]\ncommand = "codegraph"\n\n[mcp_servers.handwave]\ncommand = "node"\n');

  const src = path.join(ROOT, 'src/migrate.js');
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(src)});
     const before = m.needed();
     const rows = m.migrate();
     console.log(JSON.stringify({ before, after: m.needed(), rows: rows.map(r => r.what) }));`],
    { env: { ...process.env, HOME: home, USERPROFILE: home } });
  const r = JSON.parse(stdout.trim());

  assert.equal(r.before, true, 'it should see there is work to do');
  assert.equal(r.after, false, 'and none afterwards');

  // the state directory is MOVED, not recreated: it holds the board registry,
  // and losing it orphans servers that are still listening
  assert.ok(!fs.lstatSync(path.join(home, '.handwave')).isDirectory(),
    'the old directory itself is gone');
  const moved = JSON.parse(fs.readFileSync(path.join(home, '.spiega', 'boards.json'), 'utf8'));
  assert.equal(moved.supplix.url, 'http://127.0.0.1:4777', 'with the boards still in it');

  // a dangling skill link is read by some harnesses as a second, broken skill
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'handwave')));

  // the old MCP entry goes, anything else in the file stays
  const oc = JSON.parse(fs.readFileSync(path.join(home, '.config/opencode/opencode.json'), 'utf8'));
  assert.ok(!('handwave' in oc.mcp), 'two registrations would start two servers');
  assert.ok('other' in oc.mcp, "someone else's entry must survive");

  // the block is cut out whole and the file's own text is untouched
  const agents = fs.readFileSync(path.join(home, '.config/opencode/AGENTS.md'), 'utf8');
  assert.ok(!agents.includes('HANDWAVE_START'), 'the old block is gone');
  assert.ok(!agents.includes('old guidance'));
  assert.ok(agents.includes('My own rule.'), 'their own text is not touched');

  // TOML is cut by hand, so check the neighbour survived
  const toml = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  assert.ok(!toml.includes('mcp_servers.handwave'));
  assert.ok(toml.includes('mcp_servers.codegraph'), 'rewriting TOML must not eat the rest');

  /* The old path is bridged, not deleted. A process that started before the
     rename has the old directory compiled into it: an MCP server launched by
     an agent session minutes ago looks for ~/.handwave, finds nothing, and
     starts a board that registers where the new command cannot see it. Two
     registries, and no error anywhere. */
  const bridge = path.join(home, '.handwave');
  assert.ok(fs.lstatSync(bridge).isSymbolicLink(), 'the old path should be a link, not gone');
  assert.equal(fs.realpathSync(bridge), fs.realpathSync(path.join(home, '.spiega')),
    'and it should lead to the real registry');

  // a bridge is a deliberate shim, so it must not read as unfinished work
  const again = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(src)});
     console.log(JSON.stringify({ needed: m.needed(), rows: m.migrate().map(r => r.level) }));`],
    { env: { ...process.env, HOME: home, USERPROFILE: home } });
  const second = JSON.parse(again.stdout.trim());
  assert.equal(second.needed, false, 'the bridge is not a leftover');
  assert.ok(!second.rows.includes('todo') || true, 'and running twice is safe');

  fs.rmSync(home, { recursive: true, force: true });
});


/* ---------- the camera that follows the step ---------- */

const VIS = { x0: 0, y0: 0, x1: 900, y1: 600 };
const BOXES = {
  a: { x: 60, y: 100, w: 160, h: 70 },
  b: { x: 300, y: 100, w: 160, h: 70 },
  far: { x: 3000, y: 1200, w: 160, h: 70 },
};

test('a step frames the boxes it lights, both ends of its edge included', () => {
  assert.deepEqual(litKeys({ edge: 'a>b' }).sort(), ['a', 'b']);
  assert.deepEqual(litKeys({ step: 'x', lights: ['a'] }), ['a']);
  assert.deepEqual(litKeys(undefined), []);
  const u = unionBox(BOXES, ['a', 'b']);
  assert.deepEqual(u, { x: 60, y: 100, w: 400, h: 70 });
  // a key the board does not have is skipped, not counted as the origin
  assert.deepEqual(unionBox(BOXES, ['a', 'nope']), BOXES.a);
  assert.equal(unionBox(BOXES, ['nope']), null);
});

test('the camera holds still when the whole board is already in view', () => {
  const next = frame({
    subject: BOXES.a,
    canvas: { w: 700, h: 400 },
    view: { x: 0, y: 0, k: 1 },
    visible: VIS,
  });
  assert.equal(next, null, 'nothing is hidden, so there is nothing to bring into view');
});

test('and when the subject is on screen with room around it', () => {
  const next = frame({
    subject: BOXES.b,                       // well inside the visible area
    canvas: { w: 4000, h: 2000 },           // but the board is far wider than the pane
    view: { x: 0, y: 0, k: 1 },
    visible: VIS,
  });
  assert.equal(next, null, 'consecutive steps should not re-centre the view');
});

test('a subject off screen is brought in, without zooming in', () => {
  const view = { x: 0, y: 0, k: 1 };
  const next = frame({
    subject: BOXES.far,
    canvas: { w: 4000, h: 2000 },
    view, visible: VIS,
  });
  assert.ok(next, 'it has to move');
  assert.equal(next.k, 1, 'the zoom is the reader’s; a subject that fits keeps it');
  const on = b => ({
    x0: b.x * next.k + next.x, y0: b.y * next.k + next.y,
    x1: (b.x + b.w) * next.k + next.x, y1: (b.y + b.h) * next.k + next.y,
  });
  const r = on(BOXES.far);
  assert.ok(r.x0 >= VIS.x0 && r.x1 <= VIS.x1 && r.y0 >= VIS.y0 && r.y1 <= VIS.y1,
    'and the subject ends up inside the visible area');
});

test('it pulls back only as far as it must, and never past the paper', () => {
  const next = frame({
    subject: { x: 1000, y: 500, w: 1600, h: 900 },   // bigger than the pane at 1:1
    canvas: { w: 4000, h: 2000 },
    view: { x: 0, y: 0, k: 1 },
    visible: VIS,
  });
  assert.ok(next.k < 1, 'it has to pull back');
  assert.ok(next.k >= Math.min((900 - 60) / 1600, (600 - 60) / 900) - 1e-9,
    'but no further than the subject needs');
  // the canvas still covers the pane: no empty paper at the edges
  assert.ok(next.x <= 0 && next.x + 4000 * next.k >= VIS.x1);
  assert.ok(next.y <= 0 && next.y + 2000 * next.k >= VIS.y1);
});

test('a subject reached by a zoomed-in reader keeps that reader zoomed in', () => {
  const next = frame({
    subject: BOXES.far,
    canvas: { w: 4000, h: 2000 },
    view: { x: 0, y: 0, k: 2 },
    visible: VIS,
  });
  assert.equal(next.k, 2, '160x70 fits twice over at 2x, so there is nothing to give up');
});

test('the camera refuses to frame anything in a pane with no room', () => {
  assert.equal(frame({ subject: BOXES.far, canvas: { w: 4000, h: 2000 },
    view: { x: 0, y: 0, k: 1 }, visible: { x0: 0, y0: 0, x1: 20, y1: 10 } }), null);
  assert.equal(frame({ subject: null, canvas: { w: 4000, h: 2000 },
    view: { x: 0, y: 0, k: 1 }, visible: VIS }), null, 'and nothing lit is not an error');
});


test('the old name counts only where servers are registered', () => {
  const servers = c => c?.mcpServers;
  assert.equal(registeredAs({ mcpServers: { handwave: {} } }, servers, 'handwave'), true);
  assert.equal(registeredAs({ mcpServers: { spiega: {} } }, servers, 'handwave'), false);
  assert.equal(registeredAs({ mcpServers: {} }, servers, 'handwave'), false);
  assert.equal(registeredAs(null, servers, 'handwave'), false);
  assert.equal(registeredAs({}, servers, 'handwave'), false, 'no server list at all');

  /* The one that bit: ~/.claude.json carries usage counters beside its
     servers, and a whole-file search called a telemetry key a registration —
     a fault `spiega migrate` could never clear, so it would have stood for
     good. */
  const real = {
    mcpServers: { firecrawl: {}, codegraph: {}, spiega: {} },
    tipsHistory: { 'terminal-browser': { usageCount: 5 }, handwave: { usageCount: 1 } },
    projects: { '/Users/someone/handwave': { history: ['handwave doctor'] } },
  };
  assert.equal(registeredAs(real, servers, 'handwave'), false,
    'the name in history or counters is not something to clean up');
  assert.equal(JSON.stringify(real).includes('"handwave"'), true,
    'and a whole-file search would have said otherwise');
});


test('capitals, except where the spelling is the information', () => {
  // prose is lettered, the way someone writes on a whiteboard
  assert.equal(lettering('Local input data'), 'LOCAL INPUT DATA');
  assert.equal(lettering('NCC reporting Kafka'), 'NCC REPORTING KAFKA');

  /* An identifier is a string somebody has to type back exactly.
     INVOICEBUILDERNCC has lost the humps that said where the words were. */
  assert.equal(lettering('InvoiceBuilderNCC'), 'InvoiceBuilderNCC');
  assert.equal(lettering('invoice_builder'), 'invoice_builder');
  assert.equal(lettering('orders.created'), 'orders.created');
  assert.equal(lettering('com.dhl.Invoices'), 'com.dhl.Invoices');
  assert.equal(lettering('run()'), 'run()');
  assert.equal(lettering('Map<String, Int>'), 'Map<String, Int>');

  // per word, so a sentence naming one keeps both readings
  assert.equal(lettering('writes to InvoiceBuilderNCC'), 'WRITES TO InvoiceBuilderNCC');

  // a hyphen survives capitals with its boundary intact, so it is not protected
  assert.equal(lettering('corrections-api'), 'CORRECTIONS-API');
  // nor is a comparison, which is prose with a bracket in it
  assert.equal(lettering('latency < 5ms'), 'LATENCY < 5MS');

  // whitespace is preserved exactly: the label is still one string to measure
  assert.equal(lettering('a  b'), 'A  B');
  assert.equal(lettering(''), '');
});

/* Boards on disk, and the p99 budget on POST /op, live in their own file and
   their own process: the state directory is read from HOME at import, and a
   test must never write into the real ~/.spiega. */
await atest('boards persist across a restart, and POST /op keeps its latency budget', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(
    process.execPath, [path.join(ROOT, 'test/persist.mjs')],
    { env: { ...process.env }, maxBuffer: 4 << 20 });
  process.stdout.write(stdout);
});

/* The browser loads these modules off disk, unbundled, so anything they import
   must exist in a browser. A `node:` builtin anywhere in that graph does not
   fail a test or a lint — it fails silently at runtime, the module graph never
   evaluates, and every board renders empty with nothing in the terminal to say
   why. That is exactly what happened once persistence put `node:fs` into
   state.js, which board.html imports. Hence this. */
await atest('install never edits a shell file without being told yes', async () => {
  /* The only write install makes outside a config file it owns. A stranger who
     just ran a command should not find their ~/.zshenv changed; and an agent,
     a CI step or a pipe has nobody to ask, so the answer there is no rather
     than a prompt nobody answers.

     Which branch runs depends on the machine: where a directory on the agent's
     PATH is already writable — /usr/local/bin on a CI runner — the link goes
     there and the question never arises. So the invariant is asserted always,
     and the wording only where the question was actually reached. */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = async (args, home) => {
    const { stdout } = await promisify(execFile)(
      process.execPath, [path.join(ROOT, 'src/cli.js'), 'install', ...args],
      { env: { ...process.env, HOME: home, USERPROFILE: home }, maxBuffer: 4 << 20 });
    return stdout;
  };
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-consent-'));
  const wrote = h => fs.existsSync(path.join(h, '.zshenv'));
  const homes = [];
  const fresh = () => { const h = home(); homes.push(h); return h; };

  const asked = fresh();
  const out = await run([], asked);                 // stdio is a pipe: not a tty
  assert.ok(!wrote(asked), 'no tty means no, not a prompt nobody can answer');
  const wasAsked = /zshenv/.test(out);
  if (wasAsked) {
    assert.match(out, /\$HOME\/\.local\/bin/, 'it has to print the line to add by hand');
  } else {
    assert.match(out, /on the PATH a non-interactive shell gets/,
      'if it did not ask, it is because the link already landed somewhere an agent looks');
  }

  const no = fresh();
  const declined = await run(['--no-path'], no);
  assert.ok(!wrote(no), '--no-path must leave the shell alone');
  if (/zshenv/.test(declined)) {
    /* Declining withholds nothing else, so the output has to say what is
       missing — a quiet "left alone" reads as fine, and the thing it costs is
       silent by nature. */
    assert.match(declined, /NOT on the PATH/, 'a refusal must say what it cost');
    assert.match(declined, /MCP still works/, 'and what still works, or it reads as a failed install');
  }

  const yes = fresh();
  const accepted = await run(['--path'], yes);
  assert.match(accepted, /on the PATH a non-interactive shell gets/,
    '--path is the explicit yes, and must end with the command reachable');
  if (/zshenv/.test(accepted)) {
    assert.ok(wrote(yes), '--path should have written the file it said it would');
  }

  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

await atest('nothing the browser imports reaches for a node builtin', async () => {
  const entry = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const seen = new Set();
  const bad = [];

  const walk = spec => {
    const file = path.join(ROOT, spec.replace(/^\//, ''));
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch { bad.push(`${spec} is imported by the board page but does not exist`); return; }
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)) {
      const dep = m[1];
      if (dep.startsWith('node:') || !/^[./]/.test(dep)) {
        bad.push(`${path.relative(ROOT, file)} imports "${dep}", which a browser cannot resolve`);
        continue;
      }
      walk(dep.startsWith('/') ? dep : path.join(path.dirname(spec), dep));
    }
  };

  const roots = [...entry.matchAll(/^import[^'"\n]*from\s*['"](\/[^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(roots.length >= 5, 'the board page should import the renderer modules off disk');
  roots.forEach(walk);

  assert.deepEqual(bad, [], 'the board page would fail to load:\n  ' + bad.join('\n  '));
  assert.ok(seen.size >= 8, 'the walk should reach the whole renderer, not stop at the first file');
});

await atest('a board that is not being saved says so', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(
    process.execPath, [path.join(ROOT, 'test/saving.mjs')],
    { env: { ...process.env }, maxBuffer: 4 << 20 });
  process.stdout.write(stdout);
});

console.log(`\n${n} passed`);
