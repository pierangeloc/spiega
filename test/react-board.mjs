/* The board page: the React app every board at /b/<name>/ is served.

   Run with `node dist/test/react-board.mjs`, or `pnpm test`.

   Everything here renders the real components through react-dom/server, out
   of the SSR build in dist/support, against a fixture store or a store fed by
   a stubbed event stream. The suites run inside dist/ under plain node (ADR
   0002), which does not read JSX; that build is how the view gets here.

   What is being protected:

   - The stage mounts the renderer's *own string*. The SVG comes out of
     `renderSVG` as text, so for one fixture board this is an equality rather
     than an opinion.
   - The rail, the phases, the chapter strip, the map and the steps strip say
     what the model says.
   - Every pane has a row of its own in the body grid. A pane without one takes
     the board's `1fr` and the drawing collapses, with nothing thrown anywhere.
   - The page listens to the stream the server sends. If it stops listening the
     board renders empty while the server happily streams at it — the failure
     this cutover could cause for every board at once — so the real transport
     is driven here with a stubbed EventSource.
   - The page the server hands out is one file: no stylesheet to fetch, no
     bundle to fetch, nothing from a CDN. A board that cannot reach its own
     script renders empty and says nothing, and an export is opened from a
     file:// URL, where an external module script is refused outright.
   - The page carries no dagre.
*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectLive, fixtureStore, InkMemory, readFollow, renderBoard, runBrowserCommand, stageRender, STAGE_MARGIN } from '../support/board-view.js';
import { applyOps, emptyBoard } from '../src/board/state.js';
import { specToOps } from '../src/spec.js';
import { renderSVG } from '../src/render/render.js';
import { isReadRoute } from '../packages/server/src/node.js';
import { createFixtureStore, createStore, init } from '../packages/board/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
const test = (name, fn) => {
  try {
    fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

const page = () => fs.readFileSync(path.join(ROOT, 'src/board/index.html'), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

/* The fixture the page bakes in, rebuilt here from the spec on disk through
   the same reducer. Nothing is shared with the bundle but the JSON file, which
   is what makes the comparison below worth making. */
function fixtureBoard() {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/kalman.json'), 'utf8'));
  const board = emptyBoard();
  const { errors } = applyOps(board, specToOps(spec));
  assert.deepEqual(errors, [], 'the fixture spec should apply cleanly');
  return board;
}

test('the stage mounts the renderer\'s SVG string, byte for byte', () => {
  const board = fixtureBoard();
  const expected = renderSVG(board, { margin: STAGE_MARGIN, active: board.active, hand: false });
  const html = renderBoard(fixtureStore(true));
  assert.ok(expected.svg.length > 5000, 'the fixture should draw something substantial');
  assert.equal(count(html, expected.svg), 1,
    'the React stage should mount the renderer\'s string, byte for byte and once');
});

test('the stage is empty for a board with nothing on it', () => {
  const store = fixtureStore(true);
  assert.equal(stageRender({ ...store.getSnapshot(), board: emptyBoard() }), null);
  const html = renderBoard(fixtureStore(true));
  assert.ok(!html.includes('class="blank"'), 'a drawn board shows no invitation');
});

test('the transcript rail carries every line, tagged with its step', () => {
  const board = fixtureBoard();
  const html = renderBoard(fixtureStore(true));
  assert.equal(count(html, 'data-line="'), board.transcript.length);
  // seven of the eight lines name a step, and each is a way into it
  assert.equal(count(html, 'data-step="'), 7);
  assert.equal(count(html, ' go"'), 7, 'a line that names a step wears the cursor of one');
  assert.equal(count(html, 'class="said latest'), 1, 'only the newest line is the latest');
  assert.ok(html.includes('<span class="tag">step 1</span>'));
  assert.ok(html.includes('data-step="6"'), 'the last tagged line points at step 7');
  assert.ok(html.includes('It runs again for every fix that arrives.'));
});

test('an empty transcript says so, as the old rail does', () => {
  const store = fixtureStore(true);
  store.dispatch({ type: 'stateReceived', board: emptyBoard(), full: true });
  assert.ok(renderBoard(store).includes('<div class="empty">Nothing said yet.</div>'));
});

test('the steps strip says where the flow is, and walks it', () => {
  const store = fixtureStore(true);
  assert.ok(renderBoard(store).includes('<span class="n" id="stepn">7 steps</span>'));
  assert.ok(renderBoard(store).includes('press → to walk the flow'));

  store.dispatch({ type: 'stepNext' });
  const walked = renderBoard(store);
  assert.ok(walked.includes('<span class="n" id="stepn">1/7</span>'));
  assert.ok(walked.includes('Odometry carries the last estimate forward'),
    'the strip should carry the step\'s own words');
  // the lit step, and the line that belongs to it, light together
  assert.ok(walked.includes('class="said on go"'), 'the step\'s line is lit');
  assert.ok(walked.includes('class="said off go"'), 'the other steps\' lines recede');
});

test('narration transport follows the model, with a visible no-voice fallback', () => {
  const unavailable = renderBoard(fixtureStore(true));
  assert.ok(unavailable.includes('no voice'));
  assert.ok(unavailable.includes('id="play"'), 'silent flow playback remains available');
  const store = fixtureStore(true, { narratorAvailable: true, voices: [{ name: 'Test Voice', lang: 'en-US', local: true }], voice: 'Test Voice' });
  let html = renderBoard(store);
  assert.ok(html.includes('aria-label="play"'));
  assert.ok(html.includes('Test Voice'));
  assert.ok(!html.includes('id="play"'), 'there is only one player');
  store.dispatch({ type: 'narratePlay', index: 1 });
  store.dispatch({ type: 'narrateSectionStarted', index: 1 });
  store.dispatch({ type: 'narrateWord', index: 1, offset: 0 });
  html = renderBoard(store);
  assert.ok(html.includes('aria-label="pause"'));
  assert.ok(html.includes('class="w lit"'));
  assert.ok(html.includes('saying'));
});

test('whole-board narration marks the outline card and spoken word', () => {
  const store = fixtureStore(true, { narratorAvailable: true });
  const board = emptyBoard();
  applyOps(board, [
    { op: 'node', id: 'first', label: 'First' },
    { op: 'say', text: 'First line' },
    { op: 'chapter', title: 'Second' },
    { op: 'node', id: 'second', label: 'Second' },
    { op: 'say', text: 'Second line' },
  ]);
  store.dispatch({ type: 'stateReceived', board, full: true });
  store.dispatch({ type: 'openMap' });
  store.dispatch({ type: 'narratePlay', index: 1 });
  store.dispatch({ type: 'narrateSectionStarted', index: 1 });
  store.dispatch({ type: 'narrateWord', index: 1, offset: 0 });
  const html = renderBoard(store);
  assert.match(html, /class="mapcard[^\"]* speaking/);
  assert.match(html, /class="t"><span class="w lit">/);
});

test('speech offsets span markdown fragments in transcript and map', () => {
  const store = fixtureStore(true, { narratorAvailable: true });
  const board = emptyBoard();
  const text = 'First **important** then `last`';
  applyOps(board, [
    { op: 'node', id: 'first', label: 'First' },
    { op: 'say', text },
    { op: 'chapter', title: 'Second' },
    { op: 'node', id: 'second', label: 'Second' },
    { op: 'say', text: 'Another chapter.' },
  ]);
  store.dispatch({ type: 'stateReceived', board, full: true });
  store.dispatch({ type: 'selectChapter', chapter: 0 });
  store.dispatch({ type: 'narratePlay', index: 0 });
  store.dispatch({ type: 'narrateSectionStarted', index: 0 });

  const check = (index, scope) => {
    for (const [offset, word] of [[0, 'First'], [6, 'important'], [16, 'then'], [21, 'last']]) {
      store.dispatch({ type: 'narrateWord', index, offset });
      const html = renderBoard(store);
      const content = scope(html);
      assert.deepEqual([...content.matchAll(/<span class="w lit">([^<]+)<\/span>/g)].map(m => m[1]), [word],
        `${word} must be the only lit word at offset ${offset}`);
    }
  };
  check(0, html => html.match(/<span class="said-body">([\s\S]*?)<\/span><\/div>/)?.[1] ?? '');

  store.dispatch({ type: 'openMap' });
  const index = store.getSnapshot().playback.tape.findIndex(s => s.kind === 'outline' && s.card === 1 && s.part === 'line');
  assert.ok(index >= 0);
  store.dispatch({ type: 'narratePlay', index });
  store.dispatch({ type: 'narrateSectionStarted', index });
  check(index, html => html.match(/<span class="line">([\s\S]*?)<\/span><span class="meta">/)?.[1] ?? '');
});

test('replay control stops narration and displays replay captions', () => {
  const store = fixtureStore(true, { narratorAvailable: true });
  assert.ok(renderBoard(store).includes('id="replay"'));
  store.dispatch({ type: 'narratePlay' });
  store.clearCmds();
  store.dispatch({ type: 'replayStart' });
  assert.deepEqual(store.cmds.map(c => c.type), ['narratorStop', 'scheduleReplayStep']);
  assert.equal(store.getSnapshot().playback.tapePlaying, false);
  assert.ok(!renderBoard(store).includes('the board is empty'), 'replay is not an empty-board invitation');
  store.dispatch({ type: 'setCaption', caption: { text: 'Replay words', problem: false } });
  assert.ok(renderBoard(store).includes('class="caption on" id="caption">Replay words'));
});

test('walking the flow redraws the stage with the step lit', () => {
  const store = fixtureStore(true);
  const before = stageRender(store.getSnapshot());
  store.dispatch({ type: 'stepNext' });
  const after = stageRender(store.getSnapshot());
  assert.notEqual(before.svg, after.svg, 'lighting a step changes the drawing');
  assert.equal(renderBoard(store).includes(after.svg), true);
});

test('step controls, follow and fit expose the model transitions', () => {
  const store = fixtureStore(true);
  store.dispatch({ type: 'layoutMeasured', canvas: { w: 1200, h: 800 }, boxes: {}, offset: { x: 0, y: 0 } });
  store.dispatch({ type: 'stageResized', size: { w: 520, h: 600 } });
  const fit = store.getSnapshot().camera.view;
  assert.ok(renderBoard(store).includes('id="follow"'));
  assert.ok(renderBoard(store).includes('aria-pressed="true"'));
  store.dispatch({ type: 'toggleFollow' });
  assert.ok(renderBoard(store).includes('aria-pressed="false"'));
  store.dispatch({ type: 'zoom', factor: 1.25 });
  assert.notDeepEqual(store.getSnapshot().camera.view, fit);
  store.dispatch({ type: 'fit' });
  assert.deepEqual(store.getSnapshot().camera.view, fit);
  store.dispatch({ type: 'keyDown', key: 'ArrowRight' });
  assert.equal(store.getSnapshot().board.active, 0);
  store.dispatch({ type: 'keyDown', key: 'Escape' });
  assert.equal(store.getSnapshot().board.active, null);
});

test('follow preference survives reload and chapter navigation updates the address', () => {
  const values = new Map();
  const replaced = [];
  const browser = {
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
    location: { pathname: '/next', search: '?fixture=1', hash: '' },
    history: { replaceState: (_state, _title, url) => replaced.push(url) },
  };
  const make = () => fixtureStore(true, { following: readFollow(browser), runCmd: cmd => runBrowserCommand(browser, cmd) });
  const store = make();
  store.dispatch({ type: 'toggleFollow' });
  assert.equal(values.get('spiega.follow'), 'off');
  assert.equal(make().getSnapshot().camera.following, false);
  runBrowserCommand(browser, { type: 'setHash', hash: '#1' });
  assert.deepEqual(replaced, ['/next?fixture=1#1']);
  const blocked = { ...browser, get localStorage() { throw new Error('storage blocked'); } };
  assert.equal(readFollow(blocked), true);
  assert.doesNotThrow(() => runBrowserCommand(blocked, { type: 'persistFollow', following: true }));
});

test('chapter tabs keep their own drawing and script when revisited', () => {
  const store = fixtureStore(true);
  const board = emptyBoard();
  const { errors } = applyOps(board, [
    { op: 'node', id: 'first', label: 'First' },
    { op: 'say', text: 'First chapter script' },
    { op: 'chapter', title: 'Second' },
    { op: 'node', id: 'second', label: 'Second' },
    { op: 'say', text: 'Second chapter script' },
  ]);
  assert.deepEqual(errors, []);
  store.dispatch({ type: 'stateReceived', board, full: true });
  store.dispatch({ type: 'selectChapter', chapter: 0 });
  const first = renderBoard(store);
  assert.ok(first.includes('First chapter script'));
  assert.ok(first.includes('data-node="first"'));
  assert.ok(!first.includes('data-node="second"'));
  store.dispatch({ type: 'selectChapter', chapter: null });
  const second = renderBoard(store);
  assert.ok(second.includes('Second chapter script'));
  assert.ok(second.includes('data-node="second"'));
  store.dispatch({ type: 'selectChapter', chapter: 0 });
  assert.equal(stageRender(store.getSnapshot()).svg, stageRender({ ...store.getSnapshot(), chapterStep: null }).svg);
  assert.ok(renderBoard(store).includes('class="here tab"'));
});

test('the chapter map renders the surfaces and their first lines', () => {
  const store = fixtureStore(true);
  const board = emptyBoard();
  applyOps(board, [
    { op: 'chapter', title: 'First chapter' },
    { op: 'node', id: 'shared', label: 'Shared' },
    { op: 'say', text: 'First chapter script' },
    { op: 'chapter', title: 'Second chapter' },
    { op: 'node', id: 'shared', label: 'Shared' },
    { op: 'say', text: 'Second chapter script' },
  ]);
  store.dispatch({ type: 'stateReceived', board, full: true });
  store.dispatch({ type: 'openMap' });
  const html = renderBoard(store);
  assert.ok(html.includes('id="map"'), 'the map opens as a layer over the panes');
  assert.equal(count(html, 'class="mapcard'), 2);
  assert.ok(html.includes('First chapter script') && html.includes('Second chapter script'));
  assert.ok(html.includes('class="thumb"'), 'each card shows its own miniature drawing');
  assert.ok(html.includes('id="maplinks"'), 'links share the board’s ink');
});

test('a chapter break files its ink and leaves a fresh live surface', () => {
  const ink = new InkMemory();
  ink.update(0);
  ink.surface('chapter-live').add('gateway');
  ink.surface('chapter-live').add('gateway>api');
  ink.update(1);
  assert.deepEqual([...ink.surface('chapter-0')], ['gateway', 'gateway>api'],
    'returning to the finished surface must not redraw what was already seen');
  assert.deepEqual([...ink.surface('chapter-live')], [],
    'even the same key on the next surface is new ink');
  ink.surface('chapter-live').add('gateway');
  ink.surface('chapter-0').add('ledger');
  ink.update(1);
  assert.ok(ink.surface('chapter-0').has('ledger'), 'amendments are remembered on their own surface');
  ink.update(0);
  assert.equal(ink.surface('chapter-0').size, 0, 'clearing chapters forgets the previous board');
  assert.equal(ink.surface('chapter-live').size, 0);
});

test('a board with no flow has no steps strip', () => {
  const store = fixtureStore(true);
  const board = emptyBoard();
  applyOps(board, [{ op: 'node', label: 'Alone' }]);
  store.dispatch({ type: 'stateReceived', board, full: true });
  assert.ok(!renderBoard(store).includes('class="steps"'));
});

test('the rail collapses by the class the stylesheet collapses it with', () => {
  assert.ok(renderBoard(fixtureStore(false)).includes('<main id="main" class="norail">'));
  assert.ok(renderBoard(fixtureStore(true)).includes('<main id="main">'));
  assert.match(page(), /main\.norail\{grid-template-columns:0 1fr\}/);
});

test('the camera is the model\'s, written as one transform', () => {
  const store = fixtureStore(true);
  store.dispatch({ type: 'layoutMeasured', canvas: { w: 1000, h: 500 }, boxes: {}, offset: { x: 0, y: 0 } });
  store.dispatch({ type: 'stageResized', size: { w: 800, h: 600 } });
  const { view } = store.getSnapshot().camera;
  assert.ok(view.k > 0 && view.k < 1, `the board should have been fitted, got k=${view.k}`);
  assert.ok(renderBoard(store).includes(`translate(${view.x}px,${view.y}px) scale(${view.k})`));
});

/* A board with three chapters, so every pane the page has is on it. */
const chaptered = () => [
  { op: 'title', text: 'Checkout' },
  { op: 'chapter', title: 'happy path' },
  { op: 'node', id: 'api', label: 'API' },
  { op: 'node', id: 'db', label: 'DB' },
  { op: 'edge', from: 'api', to: 'db' },
  { op: 'say', text: 'API writes the order.' },
  { op: 'chapter', title: 'retries' },
  { op: 'node', id: 'q', label: 'Queue' },
  { op: 'node', id: 'w', label: 'Worker' },
  { op: 'node', id: 'x', label: 'Backoff' },
  { op: 'edge', from: 'q', to: 'w' },
  { op: 'say', text: 'Worker retries transient failures.' },
  { op: 'chapter', title: 'dead letter' },
  { op: 'node', id: 'dlq', label: 'DLQ' },
];

/* The elements React hands straight to body's grid, by tag and first class. */
function panes(html) {
  const found = [];
  let depth = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs, self] = m;
    if (self || /^(br|img|input|meta|hr|link)$/i.test(tag)) continue;
    if (close) { depth--; continue; }
    if (depth === 0) found.push({ tag, cls: /class="([^"\s]*)/.exec(attrs)?.[1] ?? null });
    depth++;
  }
  return found;
}

/* How the chapter strip first shipped: a new pane with no row of its own, in a
   window with the drawing squeezed into a band at the bottom. Named rows are
   also what make a pane that comes and goes safe — a pane that is not
   rendered stops being a grid item, and auto-placement would slide the board
   into its `auto` row. */
test('every pane on the page has a row of its own in the body grid', () => {
  const css = page().match(/<style>([\s\S]*?)<\/style>/)[1];
  const rows = /grid-template-rows:\s*([^;}]+)/.exec(css);
  assert.ok(rows, 'body should lay its panes out in a grid');
  const tracks = rows[1].trim().split(/\s+/).length;

  const found = panes(renderBoard(createFixtureStore({ ops: chaptered(), init: { exported: true } })));
  assert.deepEqual(found.map(p => p.tag), ['div', 'nav', 'main'], 'the bar, the chapter strip and the board');
  assert.equal(found.length, tracks, `the body grid has ${tracks} rows for ${found.length} panes`);
  const placed = found.map(({ tag, cls }) => {
    const rule = new RegExp(`(?:^|[}\\s])${cls ? `\\.${cls}` : tag}\\{grid-row:(\\d+)\\}`, 'm').exec(css);
    assert.ok(rule, `${cls ? '.' + cls : tag} should name its row`);
    return Number(rule[1]);
  });
  assert.deepEqual(placed, [1, 2, 3]);
});

/* The mark is the only thing that says a chapter changed while the reader was
   somewhere else. Nothing throws when it is missing; the tab simply looks like
   every other tab. */
test('the chapter strip marks the chapter that changed behind the reader', () => {
  const store = createFixtureStore({ ops: chaptered(), init: { exported: true } });
  const tabs = () => [...renderBoard(store).matchAll(/<button[^>]*class="([^"]*\btab\b[^"]*)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => ({ cls: m[1], body: m[2] }));

  // A board in chapters opens on its map.
  assert.ok(tabs()[0].cls.startsWith('here '), 'the map is where a chaptered board opens');
  store.dispatch({ type: 'selectChapter', chapter: null });
  const quiet = tabs();
  assert.equal(quiet.length, 4, 'the map, two finished chapters and the one being drawn');
  assert.match(quiet[0].cls, /maptab/, 'the map leads the strip');
  assert.ok(quiet[3].cls.startsWith('here '), 'the live chapter is where the reader is');
  assert.ok(!quiet.some(t => t.body.includes('growing')), 'nothing changed, nothing marked');

  store.dispatch({ type: 'selectChapter', chapter: 0 });
  store.apply([{ op: 'say', text: 'A late line on the live chapter.' }]);
  let now = tabs();
  assert.ok(now[1].cls.startsWith('here '), 'reading chapter 1');
  assert.match(now[3].body, /class="growing"/, 'the live chapter grew behind the reader');
  assert.doesNotMatch(now[1].body, /growing/, 'the one being read is not marked');

  store.apply([{ op: 'amend', chapter: 2, ops: [{ op: 'node', id: 'r', label: 'Retry' }] }], { amended: [2] });
  now = tabs();
  assert.match(now[2].body, /class="growing"/, 'an amended chapter is marked');

  store.dispatch({ type: 'openMap' });
  now = tabs();
  assert.ok(now[0].cls.startsWith('here '), 'the map is where the reader is');
  assert.equal(now.filter(t => t.cls.startsWith('here ')).length, 1, 'and no chapter claims them at the same time');
});

test('the map cards count boxes and lines, and the bar carries no tally', () => {
  const store = createFixtureStore({ ops: chaptered(), init: { exported: true } });
  store.dispatch({ type: 'openMap' });
  const html = renderBoard(store);
  assert.match(html, /2 boxes/);
  assert.match(html, /3 boxes/, 'counts distinguish the thumbnails');
  assert.match(html, /1 lines/);
  assert.doesNotMatch(html, /id="count"/);
});

/* ---------- the live transport ---------- */

/* Just enough of a browser for connectLive: an EventSource the test drives by
   hand, a fetch that answers /whoami and /state, timers it can fire, and the
   window events it listens for. */
function liveBrowser() {
  const streams = [];
  const timers = [];
  const listeners = {};
  const requests = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; streams.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
    close() { this.readyState = 2; }
    emit(type, data) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.handlers[type] ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) });
    }
  }
  const saved = {};
  const globals = {
    EventSource: FakeEventSource,
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('/whoami')) return { ok: true, json: async () => ({ name: 'demo' }) };
      return { ok: false, json: async () => null };
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    location: { hash: '', pathname: '/b/demo/' },
    document: { visibilityState: 'visible' },
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
  return { streams, timers, listeners, requests, restore };
}

const drawn = ops => { const b = emptyBoard(); applyOps(b, ops); return b; };

test('a live board draws what the stream sends, and says when it is cut off', () => {
  const env = liveBrowser();
  try {
    const cmds = [];
    const store = createStore(init(), cmd => cmds.push(cmd));
    connectLive(store, '/b/demo/');
    assert.equal(env.streams.length, 1);
    assert.equal(env.streams[0].url, '/b/demo/events', 'the stream is the board\'s own');
    assert.ok(env.requests.includes('/b/demo/whoami'), 'and the page asks which board it is');

    const stream = env.streams[0];
    stream.emit('open');
    assert.equal(store.getSnapshot().link, 'idle');

    const first = drawn([{ op: 'node', id: 'gw', kind: 'gateway', label: 'API Gateway' }]);
    stream.emit('state', first);
    assert.match(renderBoard(store), /data-node="gw"/, 'the full state draws');
    assert.equal(store.getSnapshot().link, 'live', 'and the dot lights while the agent draws');

    const second = drawn([
      { op: 'node', id: 'gw', kind: 'gateway', label: 'API Gateway' },
      { op: 'node', id: 'orders', label: 'Orders' },
      { op: 'edge', from: 'gw', to: 'orders', label: 'gRPC' },
      { op: 'say', text: 'The gateway calls orders.' },
    ]);
    stream.emit('patch', { board: second, fresh: true });
    const html = renderBoard(store);
    assert.match(html, /data-node="orders"/, 'a patch draws on top');
    assert.match(html, /The gateway calls orders\./, 'and the rail carries what was said');

    // The dot settles back to idle once the agent has stopped.
    env.timers.at(-1).fn();
    assert.equal(store.getSnapshot().link, 'idle');

    stream.emit('saving', { saving: false, why: 'unwritable', file: '/x' });
    assert.match(renderBoard(store), /id="unsaved"/, 'a board that is not saved says so on the board');

    // A live board is tidied before its movie starts, so the request goes to
    // the server first rather than straight into a replay.
    stream.emit('replay');
    assert.deepEqual(cmds.filter(c => c.type === 'settleBoard').map(c => c.then.type), ['replayStart'],
      '`spiega replay` reaches the page');

    // A server that went away: the board says so, then reconnects.
    stream.readyState = 2;
    stream.emit('error');
    assert.equal(store.getSnapshot().link, 'down');
    assert.match(renderBoard(store), /not connected/);
    const retry = env.timers.at(-1);
    assert.ok(retry.ms > 0 && retry.ms <= 5000, 'with backoff');
    retry.fn();
    assert.equal(env.streams.length, 2, 'a new stream is opened');
    assert.equal(stream.readyState, 2);
    env.streams[1].emit('open');
    assert.equal(store.getSnapshot().link, 'idle');
  } finally {
    env.restore();
  }
});

test('the page the server hands out is one file', () => {
  const html = page();
  const fetched = [...html.matchAll(/\s(?:src|href)="(?!data:)([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(fetched, [], 'the page must fetch nothing to draw itself');
  assert.ok(html.includes('<script type="module">'), 'the bundle is inline');
  assert.ok(/--rail:\s*310px/.test(html), 'it carries board.html\'s own stylesheet');
  assert.ok(html.includes('#root{display:contents}'),
    'the mount point hands its children to body\'s grid');
});

test('the page reaches no dagre', () => {
  assert.ok(!page().includes('dagre'));
});

test('the existing board URL is a read route, and only for GET', () => {
  assert.equal(isReadRoute('GET', '/b/example/'), true);
  assert.equal(isReadRoute('POST', '/b/example/'), false);
  assert.equal(isReadRoute('GET', '/next'), false);
  assert.equal(isReadRoute('GET', '/b/demo/'), true, 'named boards keep their route');
});

console.log(`\n${n} checks passed`);
