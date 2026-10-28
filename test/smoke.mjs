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
import { scriptSteps, linesFor, lineStates } from '../src/board/script.js';
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
  for (const f of ['src/board/draw-on.js', 'src/render/render.js', 'src/render/ink.js',
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
  assert.throws(() => upsertBlock(fakeFS(store), f), /one handwave marker but not the other/,
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
  // `handwave.bak-...` next to `handwave` in ~/.claude/skills is not a backup,
  // it is a second skill with the same description and older contents.
  const src = fs.readFileSync(path.join(ROOT, 'src/install.js'), 'utf8');
  const fn = src.slice(src.indexOf('const backupDir'), src.indexOf('const mcpJSON'));
  assert.ok(!/\$\{d\}\.bak/.test(fn), 'a sibling of the target is the one place it must not go');
  assert.ok(/\.handwave['"],\s*['"]backups/.test(fn), 'backups belong somewhere nothing scans');
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

test('the herdr plugin declares the actions it ships, and its scripts are runnable', () => {
  const dir = path.join(ROOT, 'integrations/herdr');
  const toml = fs.readFileSync(path.join(dir, 'herdr-plugin.toml'), 'utf8');
  assert.match(toml, /^id = "handwave\.board"/m);
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
  const f = path.join(ROOT, 'skills/handwave/SKILL.md');
  assert.ok(fs.existsSync(f), 'skills/handwave/SKILL.md is the one canonical copy');
  const head = fs.readFileSync(f, 'utf8').slice(0, 600);
  assert.match(head, /^---\n/, 'it needs YAML frontmatter');
  assert.match(head, /\nname: handwave\n/);
  assert.match(head, /\ndescription: .{40,}/, 'the description is what makes a harness load it');
});

/* Replay on request: the board's own log is the source, so asking for the
   movie again must not put a single op back on the wire. Real server, real
   SSE stream — the route and the event are the whole feature. */
const atest = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };

await atest('a replay can be asked for remotely, and re-sends nothing', async () => {
  const { createServer } = await import('../src/board/server.js');
  const { server } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${server.address().port}`;
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

/* `handwave say "..." --step 2` goes through argument parsing, which no unit
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
  const env = { ...process.env, HANDWAVE_URL: `http://127.0.0.1:${server.address().port}` };
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
   HOME: the registry lives under ~/.handwave and a test must never go near
   the real one. Everything happens in one process, because a board is pruned
   when the process that registered it exits — which is the point of the
   registry, and would otherwise prune these the moment they were written. */
await atest('boards are found by name, kept apart, and pruned when their server dies', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.HANDWAVE_URL;
  delete env.HANDWAVE_BOARD;

  const script = `
    const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});
    const fs = await import('node:fs');
    const out = {};

    m.registerBoard('alpha', 'http://127.0.0.1:1111');
    m.registerBoard('beta', 'http://127.0.0.1:2222');
    out.alpha = m.findBoard('alpha');
    out.beta = m.findBoard('beta');
    out.unknown = m.findBoard('nope');

    process.env.HANDWAVE_BOARD = 'beta';           // how a harness picks one
    out.byEnv = m.findBoard();
    process.env.HANDWAVE_URL = 'http://explicit';  // an explicit url still wins
    out.byUrl = m.findBoard();
    delete process.env.HANDWAVE_URL;

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
  assert.equal(r.byEnv, 'http://127.0.0.1:2222', 'HANDWAVE_BOARD selects');
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
  for (const k of ['HANDWAVE_URL', 'HANDWAVE_BOARD', 'HANDWAVE_SESSION',
                   'CLAUDE_CODE_SESSION_ID', 'HERDR_PANE_ID', 'HERDR_TAB_ID']) delete base[k];

  const ask = (env, cwd = task, extra = '') => promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e',
     `const m = await import(${JSON.stringify(path.join(ROOT, 'src/board/server.js'))});${extra}console.log(m.boardName())`],
    { env: { ...base, ...env }, cwd }).then(r => r.stdout.trim());

  // the directory is the task, and a worktree's name is what someone called it
  assert.equal(await ask({ HANDWAVE_SESSION: 's1' }), 'domain-modeling-for-rights');

  // an explicit name always wins
  assert.equal(await ask({ HANDWAVE_SESSION: 's1', HANDWAVE_BOARD: 'Review Notes' }), 'review-notes');

  // register s1's board, then: s1 keeps it, s2 in the same directory does not take it
  const reg = `m.registerBoard('domain-modeling-for-rights', 'http://127.0.0.1:1234', 's1');`;
  assert.equal(await ask({ HANDWAVE_SESSION: 's1' }, task, reg), 'domain-modeling-for-rights');
  assert.equal(await ask({ HANDWAVE_SESSION: 's2' }, task, reg), 'domain-modeling-for-rights-2',
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

console.log(`\n${n} passed`);
