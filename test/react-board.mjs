/* The React board, served beside the old one (#153).

   Run with `node dist/test/react-board.mjs`, or `pnpm test`.

   Everything here runs against a fixture store — no server, no SSE stream, no
   timers — and renders the real components through react-dom/server, out of
   the SSR build in dist/support. The suites run inside dist/ under plain node
   (ADR 0002), which does not read JSX; that build is how the view gets here.

   What is being protected:

   - The stage mounts the *same string* the old page mounts. The SVG comes out
     of `renderSVG` as text, so for one fixture board this is an equality
     rather than an opinion, and it is the only part of "do the two boards look
     alike" that a test can settle. The options are checked against board.html
     itself, so the two pages cannot drift apart by one page changing its
     margin.
   - The rail, the phases and the steps strip say what the model says.
   - The rail collapses the way board.html's does, by the same class.
   - The page the server hands out is one file: no stylesheet to fetch, no
     bundle to fetch, nothing from a CDN. A board that cannot reach its own
     script renders empty and says nothing, and this one is also opened from a
     file:// URL, where an external module script is refused outright.
   - The page carries no dagre, as the old one does not.
*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureStore, readFollow, renderBoard, runBrowserCommand, stageRender, STAGE_MARGIN } from '../support/board-view.js';
import { applyOps, emptyBoard } from '../src/board/state.js';
import { specToOps } from '../src/spec.js';
import { renderSVG } from '../src/render/render.js';
import { isReadRoute } from '../packages/server/src/node.js';

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

const page = () => fs.readFileSync(path.join(ROOT, 'src/next/index.html'), 'utf8');
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

test('the stage mounts the same SVG string the old page would', () => {
  const board = fixtureBoard();
  const expected = renderSVG(board, { margin: STAGE_MARGIN, active: board.active, hand: false });
  const html = renderBoard(fixtureStore(true));
  assert.ok(expected.svg.length > 5000, 'the fixture should draw something substantial');
  assert.equal(count(html, expected.svg), 1,
    'the React stage should mount the renderer\'s string, byte for byte and once');
});

test('the React stage asks the renderer for board.html\'s options', () => {
  const old = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const margin = /const MARGIN = (\d+)/.exec(old);
  assert.ok(margin, 'board.html should still declare MARGIN');
  assert.equal(STAGE_MARGIN, Number(margin[1]),
    'the two pages must hand the renderer the same margin');
  assert.match(old, /renderSVG\(board, \{ margin: MARGIN, active: board\.active, hand: false \}\)/,
    'board.html should still render with { margin, active, hand: false }');
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

test('a board with no flow has no steps strip', () => {
  const store = fixtureStore(true);
  const board = emptyBoard();
  applyOps(board, [{ op: 'node', label: 'Alone' }]);
  store.dispatch({ type: 'stateReceived', board, full: true });
  assert.ok(!renderBoard(store).includes('class="steps"'));
});

test('the rail collapses by the class board.html collapses it with', () => {
  assert.ok(renderBoard(fixtureStore(false)).includes('<main id="main" class="norail">'));
  assert.ok(renderBoard(fixtureStore(true)).includes('<main id="main">'));
  const old = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  assert.match(old, /main\.norail\{grid-template-columns:0 1fr\}/,
    'board.html should still collapse the rail with main.norail');
});

test('the camera is the model\'s, written as board.html writes it', () => {
  const store = fixtureStore(true);
  store.dispatch({ type: 'layoutMeasured', canvas: { w: 1000, h: 500 }, boxes: {}, offset: { x: 0, y: 0 } });
  store.dispatch({ type: 'stageResized', size: { w: 800, h: 600 } });
  const { view } = store.getSnapshot().camera;
  assert.ok(view.k > 0 && view.k < 1, `the board should have been fitted, got k=${view.k}`);
  assert.ok(renderBoard(store).includes(`translate(${view.x}px,${view.y}px) scale(${view.k})`));
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

test('the page reaches no dagre, as the old page does not', () => {
  assert.ok(!page().includes('dagre'));
});

test('/next is a read route, and only for GET', () => {
  assert.equal(isReadRoute('GET', '/next'), true);
  assert.equal(isReadRoute('POST', '/next'), false);
  assert.equal(isReadRoute('GET', '/b/demo/'), true, 'the old page keeps its route');
});

console.log(`\n${n} checks passed`);
