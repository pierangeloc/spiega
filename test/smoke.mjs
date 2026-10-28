/* A smoke test over the whole path: ops in, board state, SVG out, snapshot out.
   Run with `node test/smoke.mjs`. No framework, no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import { snapshotHTML } from '../src/board/snapshot.js';
import { KINDS } from '../src/render/glyphs.js';
import { scriptSteps, linesFor, lineStates } from '../src/board/script.js';

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

console.log(`\n${n} passed`);
