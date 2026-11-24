/* The board app: model, messages, pure update, and fixture store (#152).

   Run with `node dist/test/board-app.mjs`, or `pnpm test`.

   What is being protected:
   - The compiled board app carries no React, DOM, or node: runtime imports.
     Its view does, and is meant to: packages/board/src/view is React, bundled
     by Vite rather than compiled into the artefact (#153), and what it draws
     is checked in react-board.mjs.
   - Stepping, chapter switching, map navigation, follow/fit camera framing,
     narrator tape playback, voice/rate controls, silent flow playback, and
     replay all run as pure (Model, Msg) -> [Model, Cmd[]] transitions.
   - The fixture store drives the whole loop in Node with no server running,
     round-tripping `postOps` through the real reducer (`applyOps`). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  activeStep,
  createFixtureStore,
  currentLineStates,
  currentMap,
  currentRailMarks,
  currentSurface,
  init,
  narratorDrives,
  replayEntries,
  unsavedWarning,
  update,
} from '../packages/board/src/index.js';
import { applyOps, emptyBoard } from '../src/board/state.js';

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

/* A single-chapter board with a 3-node chain, 2 steps, and tagged narration. */
const singleChapterOps = () => [
  { op: 'title', text: 'Order path' },
  { op: 'node', id: 'gw', kind: 'gateway', label: 'Gateway' },
  { op: 'node', id: 'api', kind: 'service', label: 'Orders API' },
  { op: 'node', id: 'db', kind: 'datastore', label: 'Orders DB' },
  { op: 'edge', from: 'gw', to: 'api', label: 'HTTP' },
  { op: 'edge', from: 'api', to: 'db', label: 'SQL' },
  { op: 'step', edge: 'gw>api', step: 'Gateway routes to API' },
  { op: 'step', edge: 'api>db', step: 'API writes order' },
  { op: 'say', text: 'Overview of the order path.' },
  { op: 'say', text: 'The gateway forwards the request.', step: 1 },
  { op: 'say', text: 'Then the API persists the row.', step: 2 },
];

/* A three-chapter board (2 finished + 1 live) sharing a box across chapters. */
const multiChapterOps = () => [
  { op: 'title', text: 'Checkout' },
  { op: 'chapter', title: 'happy path' },
  { op: 'node', id: 'api', label: 'API' },
  { op: 'node', id: 'db', label: 'DB' },
  { op: 'edge', from: 'api', to: 'db' },
  { op: 'step', edge: 'api>db', step: 'API writes order' },
  { op: 'say', text: 'API writes the order.', step: 1 },
  { op: 'chapter', title: 'retries' },
  { op: 'node', id: 'q', label: 'Queue' },
  { op: 'node', id: 'w', label: 'Worker' },
  { op: 'edge', from: 'q', to: 'w' },
  { op: 'step', edge: 'q>w', step: 'Worker consumes' },
  { op: 'say', text: 'Worker retries transient failures.', step: 1 },
  { op: 'chapter', title: 'dead letter' },
  { op: 'node', id: 'api2', label: 'API' },
  { op: 'node', id: 'dlq', label: 'DLQ' },
  { op: 'edge', from: 'api2', to: 'dlq' },
  { op: 'step', edge: 'api2>dlq', step: 'Parked in DLQ' },
  { op: 'say', text: 'After three tries it lands in the DLQ.', step: 1 },
];

await test('the compiled board app has zero React, DOM, or node: imports', () => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../packages/board/src');
  const files = fs.globSync('**/*.js', { cwd: dir });
  assert.ok(files.length >= 5, 'compiled board app modules exist');
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]react/, `${file} must not import react`);
    assert.doesNotMatch(src, /from\s+['"]node:/, `${file} must not import node: builtins`);
    assert.doesNotMatch(src, /\b(window|document|localStorage|speechSynthesis|EventSource)\b/,
      `${file} must not reference browser DOM globals`);
  }
});

await test('stepping on live chapter emits postOps; on finished chapter stays local', () => {
  const store = createFixtureStore({ ops: singleChapterOps() });
  assert.equal(activeStep(store.getSnapshot()), null);

  // Live chapter: stepNext emits postOps, fixture store applies it and echoes stateReceived
  store.clearCmds();
  store.dispatch({ type: 'stepNext' });
  assert.equal(activeStep(store.getSnapshot()), 0);
  assert.ok(store.cmds.some(c => c.type === 'postOps' && c.ops[0]?.op === 'focus' && c.ops[0]?.step === 0));

  store.dispatch({ type: 'keyDown', key: 'ArrowRight' });
  assert.equal(activeStep(store.getSnapshot()), 1);

  // Clamped at the end of the flow
  store.dispatch({ type: 'stepNext' });
  assert.equal(activeStep(store.getSnapshot()), 1);

  store.dispatch({ type: 'keyDown', key: 'ArrowLeft' });
  assert.equal(activeStep(store.getSnapshot()), 0);

  store.dispatch({ type: 'keyDown', key: 'Escape' });
  assert.equal(activeStep(store.getSnapshot()), null);

  // Finished chapter: stepping is local, never emits postOps
  const multi = createFixtureStore({ ops: multiChapterOps(), hash: '#1' });
  assert.equal(multi.getSnapshot().viewing, 0);
  multi.clearCmds();
  multi.dispatch({ type: 'stepNext' });
  assert.equal(activeStep(multi.getSnapshot()), 0);
  assert.equal(multi.cmds.filter(c => c.type === 'postOps').length, 0,
    'walking a finished chapter must not post ops to the live board');
});

await test('exported copy steps locally without emitting postOps', () => {
  const b = emptyBoard();
  applyOps(b, singleChapterOps());
  let [m] = update(init({ exported: true }), { type: 'stateReceived', board: b, full: true });
  assert.equal(m.link, 'idle');

  let cmds;
  [m, cmds] = update(m, { type: 'stepNext' });
  assert.equal(activeStep(m), 0);
  assert.equal(cmds.length, 0);
});

await test('clickLine toggles step and parks narrator; clickNode cycles steps lighting that box', () => {
  const store = createFixtureStore({
    ops: singleChapterOps(),
    init: { narratorAvailable: true },
  });

  // Clicking line 1 (tagged step 0) focuses step 0 and parks playhead at 1
  store.clearCmds();
  store.dispatch({ type: 'clickLine', line: 1, step: 0 });
  assert.equal(activeStep(store.getSnapshot()), 0);
  assert.equal(store.getSnapshot().playback.tapeIndex, 1);
  assert.ok(store.cmds.some(c => c.type === 'narratorPark' && c.index === 1));

  // Clicking the same step again clears it (clickStep toggle)
  store.dispatch({ type: 'clickLine', line: 1, step: 0 });
  assert.equal(activeStep(store.getSnapshot()), null);

  // 'api' is in both step 0 (gw>api) and step 1 (api>db), so clicking it walks 0 -> 1 -> null
  store.dispatch({ type: 'clickNode', nodeId: 'api' });
  assert.equal(activeStep(store.getSnapshot()), 0);
  store.dispatch({ type: 'clickNode', nodeId: 'api' });
  assert.equal(activeStep(store.getSnapshot()), 1);
  store.dispatch({ type: 'clickNode', nodeId: 'api' });
  assert.equal(activeStep(store.getSnapshot()), null);

  // Line states reflect active step
  store.dispatch({ type: 'focusStep', step: 0 });
  assert.deepEqual(
    currentLineStates(store.getSnapshot()).map(s => s.state),
    ['free', 'on', 'off'],
  );
});

await test('chapter switching, map landing, hash navigation, and changed badges', () => {
  // Multi-chapter board (2+ finished chapters) with no hash opens on the map
  const store = createFixtureStore({ ops: multiChapterOps() });
  assert.equal(store.getSnapshot().mapOpen, true);
  assert.equal(store.getSnapshot().playback.tapeWhole, true);
  assert.equal(currentMap(store.getSnapshot()).cards.length, 3);
  assert.ok(store.cmds.some(c => c.type === 'setHash' && c.hash === '#map'));

  // Select chapter 0 -> closes map, sets hash #1, rescopes tape to chapter 0
  store.clearCmds();
  store.dispatch({ type: 'selectChapter', chapter: 0 });
  assert.equal(store.getSnapshot().mapOpen, false);
  assert.equal(store.getSnapshot().viewing, 0);
  assert.equal(store.getSnapshot().playback.tapeWhole, false);
  assert.equal(store.getSnapshot().playback.tape.length, 1);
  assert.ok(store.cmds.some(c => c.type === 'setHash' && c.hash === '#1'));

  // Incoming op on the live chapter while viewing chapter 0 marks live (null) as changed
  store.apply([{ op: 'say', text: 'New live line.' }]);
  assert.ok(store.getSnapshot().changed.includes(null));

  // Amended chapter 2 while viewing chapter 0 marks chapter index 1 as changed
  store.apply([{ op: 'amend', chapter: 2, ops: [{ op: 'node', id: 'x', label: 'Backoff' }] }], { amended: [2] });
  assert.ok(store.getSnapshot().changed.includes(1));

  // Switching to chapter 1 clears its changed badge
  store.dispatch({ type: 'selectChapter', chapter: 1 });
  assert.equal(store.getSnapshot().viewing, 1);
  assert.ok(!store.getSnapshot().changed.includes(1));

  // Pressing 'm' opens the map, pressing 'm' again returns to chapter 1
  store.dispatch({ type: 'keyDown', key: 'm' });
  assert.equal(store.getSnapshot().mapOpen, true);
  store.dispatch({ type: 'keyDown', key: 'm' });
  assert.equal(store.getSnapshot().mapOpen, false);
  assert.equal(store.getSnapshot().viewing, 1);

  // Hash navigation to live (empty hash) clears live's changed badge
  store.dispatch({ type: 'hashChanged', hash: '' });
  assert.equal(store.getSnapshot().viewing, null);
  assert.ok(!store.getSnapshot().changed.includes(null));
});

await test('follow/fit camera framing uses camera.frame and respects user pan/zoom', () => {
  const store = createFixtureStore({
    ops: singleChapterOps(),
    init: { stage: { w: 400, h: 300 }, following: true },
  });

  // Provide a wide canvas where 'db' sits far to the right (off screen at k=1)
  store.dispatch({
    type: 'layoutMeasured',
    canvas: { w: 1600, h: 300 },
    offset: { x: 0, y: 0 },
    boxes: {
      gw: { x: 20, y: 80, w: 120, h: 60 },
      api: { x: 700, y: 80, w: 120, h: 60 },
      db: { x: 1400, y: 80, w: 120, h: 60 },
    },
  });

  // Zoom in to k=1 at the left edge so the whole board does NOT fit and db is off screen
  store.dispatch({ type: 'zoom', factor: 4, origin: { x: 0, y: 0 } });
  const beforePan = store.getSnapshot().camera.view;
  assert.equal(store.getSnapshot().camera.userMoved, true);

  // Focus step 1 (api>db) with following=true -> camera pans right to frame api+db
  store.dispatch({ type: 'focusStep', step: 1 });
  const framed = store.getSnapshot().camera.view;
  assert.notEqual(framed.x, beforePan.x, 'camera moved to bring off-screen lit boxes into view');

  // Toggle follow off -> persists preference, stepping no longer moves camera
  store.clearCmds();
  store.dispatch({ type: 'toggleFollow' });
  assert.equal(store.getSnapshot().camera.following, false);
  assert.ok(store.cmds.some(c => c.type === 'persistFollow' && c.following === false));

  store.dispatch({ type: 'pan', dx: 50, dy: 10 });
  const afterManualPan = store.getSnapshot().camera.view;
  store.dispatch({ type: 'focusStep', step: 0 });
  assert.deepEqual(store.getSnapshot().camera.view, afterManualPan,
    'camera stays put when following is off');

  // Toggle follow back on -> immediately frames the active step
  store.dispatch({ type: 'toggleFollow' });
  assert.equal(store.getSnapshot().camera.following, true);
  assert.notDeepEqual(store.getSnapshot().camera.view, afterManualPan,
    'turning follow on immediately frames the currently active step');

  // Fit resets userMoved and computes fit scale
  store.dispatch({ type: 'keyDown', key: '0' });
  assert.equal(store.getSnapshot().camera.userMoved, false);
  assert.ok(store.getSnapshot().camera.view.k < 0.5, 'wide canvas scaled down to fit stage');
});

await test('narrator playback: whole-board tour switches chapters, steps, and returns to map', () => {
  const store = createFixtureStore({
    ops: multiChapterOps(),
    init: { narratorAvailable: true },
  });

  // Starts on map with whole-board tape (lede + 3*(title+line) + 3 chapter lines = 10 sections)
  const snap0 = store.getSnapshot();
  assert.equal(snap0.mapOpen, true);
  assert.equal(snap0.playback.tape[0].kind, 'outline');
  assert.equal(snap0.playback.tape.length, 10);
  assert.equal(narratorDrives(snap0), true);

  // Space starts narration from index 0
  store.clearCmds();
  store.dispatch({ type: 'keyDown', key: ' ' });
  assert.equal(store.getSnapshot().playback.tapePlaying, true);
  assert.equal(store.getSnapshot().playback.tapeIndex, 0);
  assert.ok(store.cmds.some(c => c.type === 'narratorPlay' && c.index === 0));

  // Reaching first chapter's line (index 7) closes map, opens chapter 0, focuses step 0
  store.dispatch({ type: 'narrateSectionStarted', index: 7 });
  assert.equal(store.getSnapshot().mapOpen, false);
  assert.equal(store.getSnapshot().viewing, 0);
  assert.equal(activeStep(store.getSnapshot()), 0);
  assert.equal(store.getSnapshot().playback.tapeWhole, true, 'tape navigation preserves whole-board scope');
  assert.deepEqual(currentRailMarks(store.getSnapshot()), ['now']);

  // Pause via Space, then resume continues from index 7
  store.dispatch({ type: 'keyDown', key: ' ' });
  assert.equal(store.getSnapshot().playback.tapePlaying, false);
  store.clearCmds();
  store.dispatch({ type: 'keyDown', key: ' ' });
  assert.ok(store.cmds.some(c => c.type === 'narratorPlay' && c.index === 7));

  // Finishing the last section ends playback and returns to the map
  const last = store.getSnapshot().playback.tape.length - 1;
  store.dispatch({ type: 'narrateSectionStarted', index: last });
  assert.equal(store.getSnapshot().viewing, null);
  store.dispatch({ type: 'narrateSectionEnded', index: last });
  assert.equal(store.getSnapshot().playback.tapePlaying, false);
  assert.equal(store.getSnapshot().playback.tapeEnded, true);
  assert.equal(store.getSnapshot().mapOpen, true);

  // Pressing play after tape ended restarts from 0
  store.clearCmds();
  store.dispatch({ type: 'narrateToggle' });
  assert.ok(store.cmds.some(c => c.type === 'narratorPlay' && c.index === 0));
});

await test('rate cycling, keyboard rate nudges, and voice selection', () => {
  const store = createFixtureStore({
    ops: singleChapterOps(),
    init: { narratorAvailable: true },
  });

  // cycleRate follows RATES: 1 -> 1.25 -> 1.5 -> 2 -> 0.75
  store.dispatch({ type: 'cycleRate' });
  assert.equal(store.getSnapshot().playback.rate, 1.25);
  store.dispatch({ type: 'cycleRate' });
  assert.equal(store.getSnapshot().playback.rate, 1.5);
  store.dispatch({ type: 'cycleRate' });
  assert.equal(store.getSnapshot().playback.rate, 2);
  store.dispatch({ type: 'cycleRate' });
  assert.equal(store.getSnapshot().playback.rate, 0.75);

  // '[' and ']' nudge rate by 0.1, clamped to [0.5, 2.5]
  store.dispatch({ type: 'keyDown', key: ']' });
  assert.equal(store.getSnapshot().playback.rate, 0.85);
  store.dispatch({ type: 'setRate', rate: 9 });
  assert.equal(store.getSnapshot().playback.rate, 2.5);
  store.dispatch({ type: 'setRate', rate: 0.1 });
  assert.equal(store.getSnapshot().playback.rate, 0.5);

  // Voice selection stops tape, persists voice, sets voice, and samples it
  store.dispatch({
    type: 'voicesChanged',
    voices: [{ name: 'Samantha', lang: 'en-US', local: true }],
  });
  store.dispatch({ type: 'narrateToggle' });
  assert.equal(store.getSnapshot().playback.tapePlaying, true);

  store.clearCmds();
  store.dispatch({ type: 'setVoice', name: 'Samantha' });
  assert.equal(store.getSnapshot().playback.voice, 'Samantha');
  assert.equal(store.getSnapshot().playback.tapePlaying, false);
  assert.deepEqual(
    store.cmds.map(c => c.type),
    ['persistVoice', 'narratorSetVoice', 'narratorSample'],
  );
});

await test('silent flow timer steps through flow and stops at end', () => {
  // narratorAvailable: false -> silent flow timer is active
  const store = createFixtureStore({
    ops: singleChapterOps(),
    init: { narratorAvailable: false },
  });
  assert.equal(narratorDrives(store.getSnapshot()), false);

  store.clearCmds();
  store.dispatch({ type: 'flowPlayToggle' });
  assert.equal(store.getSnapshot().playback.flowPlaying, true);
  assert.equal(activeStep(store.getSnapshot()), 0);
  assert.ok(store.cmds.some(c => c.type === 'startFlowTimer'));

  store.stepFlow();
  assert.equal(activeStep(store.getSnapshot()), 1);

  // Past the last step -> stops timer
  store.clearCmds();
  store.stepFlow();
  assert.equal(store.getSnapshot().playback.flowPlaying, false);
  assert.ok(store.cmds.some(c => c.type === 'stopFlowTimer'));
});

await test('replay coalesces amends, steps without mutating live board, and blocks clicks', () => {
  const store = createFixtureStore({ ops: multiChapterOps() });
  store.apply([
    { op: 'amend', chapter: 1, ops: [{ op: 'node', id: 'm1', label: 'Metrics' }] },
    { op: 'amend', chapter: 1, ops: [{ op: 'edge', from: 'api', to: 'm1' }] },
  ]);

  const entries = replayEntries(store.getSnapshot().board.log);
  const amends = entries.filter(e => e.op === 'amend');
  assert.equal(amends.length, 1, 'consecutive amends to chapter 1 coalesce into one visit');
  assert.equal(amends[0].ops.length, 2);

  const liveBefore = store.getSnapshot().board;
  store.dispatch({ type: 'replayStart' });
  assert.equal(store.getSnapshot().replay.active, true);
  assert.equal(currentSurface(store.getSnapshot()).nodes.length, 0);

  // Clicking a node during replay is ignored
  store.dispatch({ type: 'clickNode', nodeId: 'api' });
  assert.equal(activeStep(store.getSnapshot()), null);

  // Step through the whole replay deterministically
  let steps = 0;
  while (store.getSnapshot().replay.active && steps < 100) {
    store.stepReplay();
    steps++;
  }
  assert.equal(store.getSnapshot().replay.active, false);
  assert.equal(store.getSnapshot().board, liveBefore, 'replay never mutates the live board');
});

await test('saving warnings, export request, rail toggle, and store subscriptions', () => {
  const store = createFixtureStore({ ops: singleChapterOps() });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });

  store.dispatch({ type: 'savingChanged', status: { saving: false, why: 'other-server' } });
  assert.match(unsavedWarning(store.getSnapshot()) ?? '', /another spiega owns/);
  store.dispatch({ type: 'savingChanged', status: { saving: false, why: 'memory' } });
  assert.equal(unsavedWarning(store.getSnapshot()), null);

  store.dispatch({ type: 'toggleRail' });
  assert.equal(store.getSnapshot().railOpen, false);

  store.dispatch({ type: 'toggleExportMenu' });
  assert.equal(store.getSnapshot().exportMenuOpen, true);
  store.clearCmds();
  store.dispatch({ type: 'requestExport', scope: 'all' });
  assert.equal(store.getSnapshot().exportMenuOpen, false);
  assert.ok(store.cmds.some(c => c.type === 'exportBoard' && c.scope === 'all' && c.viewing === 'live'));

  assert.ok(notifications >= 4);
  const before = notifications;
  unsubscribe();
  store.dispatch({ type: 'toggleRail' });
  assert.equal(notifications, before, 'unsubscribed listener is no longer notified');
});

console.log(`\n${n} checks passed.`);
if (process.exitCode) process.exit(process.exitCode);
