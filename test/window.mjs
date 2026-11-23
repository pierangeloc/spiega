/* The board's window on Effect: finding a browser, launching it in app mode,
   raising the window that already shows a board — and the plain functions the
   CLI and MCP still call.

   Nothing here starts a browser or asks a window server anything. The machine
   is a fake `Desktop` that records what it was asked to do, the record of what
   was opened lives in a temp SpiegaHome, and the grace period runs on a
   TestClock. That is also what lets the Linux and Windows paths be driven on
   whatever machine runs the suite — which checks what they would launch, and
   says nothing about whether a window then appears there. Nobody has looked
   at that on Linux.
   Run with `node dist/test/window.mjs` (or via vitest through window.spec.mjs). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import {
  BoardWindows,
  Desktop,
  OPENING_MS,
  findChromium,
  focusBoard,
  notRaisedHow,
  openBoard,
  showBoard,
} from '../packages/server/src/window.js';
import { SpiegaHome } from '../packages/server/src/config.js';

let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e?.stack || String(e)).split('\n').join('\n        '));
  }
};

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const U = 'http://127.0.0.1:4777/b/skills-2';

/* A machine that answers from what it was given and remembers what it was asked. */
const fakeDesktop = ({ platform = 'darwin', files = [], bins = [], ps = '', titles = {}, launchFails = null, psFails = false } = {}) => {
  const asked = { launched: [], scripts: [] };
  const desktop = {
    platform,
    exists: file => files.includes(file),
    onPath: bin => bins.includes(bin),
    launch: (cmd, args, shell) => {
      if (launchFails) throw launchFails;
      asked.launched.push([cmd, [...args], shell]);
    },
    processes: () => { if (psFails) throw new Error('no ps'); return ps; },
    osascript: script => {
      asked.scripts.push(script);
      const app = /tell application "([^"]+)"/.exec(script)[1];
      const tag = /contains "([^"]+)"/.exec(script)[1];
      const answer = titles[app];
      if (answer instanceof Error) throw answer;
      return (answer || []).some(t => t.includes(tag)) ? 'ok\n' : 'none\n';
    },
  };
  return { desktop, asked, layer: Desktop.make(desktop) };
};

const run = (effect, layer) => Effect.runSync(effect.pipe(Effect.provide(layer)));

await test('macOS: a Chromium-family browser is launched in app mode, sized and placed as asked', () => {
  const m = fakeDesktop({ files: [CHROME, BRAVE] });
  const r = run(openBoard(U, { size: '1200x900', pos: '10:20' }), m.layer);
  assert.deepEqual(r, { how: 'chrome app window', app: true });
  assert.deepEqual(m.asked.launched, [[CHROME, [`--app=${U}`, '--window-size=1200,900', '--window-position=10,20'], false]]);
  assert.deepEqual(run(findChromium('brave'), m.layer), { name: 'brave', cmd: BRAVE }, 'the one asked for comes first');
});

await test('macOS: no Chromium, or a tab asked for, goes to the default browser through `open`', () => {
  const none = fakeDesktop();
  assert.deepEqual(run(openBoard(U), none.layer), { how: 'default browser', app: false });
  assert.deepEqual(none.asked.launched, [['open', [U], false]]);
  const tab = fakeDesktop({ files: [CHROME] });
  run(openBoard(U, { app: false }), tab.layer);
  assert.deepEqual(tab.asked.launched, [['open', [U], false]], 'a tab stays a tab');
});

await test('Linux: the first browser on PATH is launched in app mode; none is xdg-open', () => {
  const m = fakeDesktop({ platform: 'linux', bins: ['chromium-browser', 'brave'] });
  assert.deepEqual(run(findChromium(), m.layer), { name: 'brave', cmd: 'brave' }, 'brave is ahead of chromium in the order');
  assert.deepEqual(run(openBoard(U, { browser: 'chromium' }), m.layer), { how: 'chromium app window', app: true });
  assert.deepEqual(m.asked.launched, [['chromium-browser', [`--app=${U}`], false]]);
  const bare = fakeDesktop({ platform: 'linux' });
  assert.deepEqual(run(openBoard(U), bare.layer), { how: 'default browser', app: false });
  assert.deepEqual(bare.asked.launched, [['xdg-open', [U], false]]);
});

await test('Windows: nothing installed is `start`, through the shell', () => {
  const m = fakeDesktop({ platform: 'win32' });
  run(openBoard(U), m.layer);
  assert.deepEqual(m.asked.launched, [['start', [U], true]]);
});

await test('a browser that cannot be started fails in the error channel, carrying what was thrown', () => {
  const boom = new Error('spawn EACCES');
  const m = fakeDesktop({ files: [CHROME], launchFails: boom });
  const e = run(Effect.flip(openBoard(U)), m.layer);
  assert.equal(e._tag, 'LaunchFailed');
  assert.equal(e.cmd, CHROME);
  assert.equal(e.cause, boom);
});

await test('raising: each reason there is no window is its own typed error, in the words it always had', () => {
  const linux = run(Effect.flip(focusBoard('skills-2', U)), fakeDesktop({ platform: 'linux' }).layer);
  assert.equal(linux._tag, 'NoWindowRaising');
  assert.equal(notRaisedHow(linux), `no window raising on linux yet \u2014 open ${U}`);

  for (const m of [fakeDesktop(), fakeDesktop({ psFails: true })]) {
    const none = run(Effect.flip(focusBoard('skills-2', U)), m.layer);
    assert.equal(none._tag, 'NoBrowserRunning');
    assert.equal(notRaisedHow(none), 'no browser running \u2014 `spiega open`');
    assert.deepEqual(m.asked.scripts, [], 'and AppleScript is never asked about a browser that is not there');
  }

  const m = fakeDesktop({ ps: CHROME, titles: { 'Google Chrome': ['spiega [other]'] } });
  const missing = run(Effect.flip(focusBoard('skills-2', U)), m.layer);
  assert.equal(missing._tag, 'NoBoardWindow');
  assert.equal(notRaisedHow(missing), 'no window showing "skills-2" \u2014 `spiega open` makes one');
});

await test('raising: the window titled with the board is raised, past a browser that will not answer', () => {
  const m = fakeDesktop({
    ps: [CHROME, BRAVE].join('\n'),
    titles: { 'Google Chrome': new Error('not scriptable'), 'Brave Browser': ['spiega [skills-2]'] },
  });
  assert.deepEqual(run(focusBoard('skills-2', U), m.layer), { how: 'raised in Brave Browser' });
  assert.equal(m.asked.scripts.length, 2, 'Chrome was asked first and failed; Brave was asked next');
});

/* The decision, on the live halves: a fake machine, a temp home, a TestClock. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-window-'));
const T = 1_700_000_000_000;
const showing = (m, effect) => Effect.runPromise(Effect.gen(function* () {
  yield* TestClock.setTime(T);
  return yield* effect;
}).pipe(
  Effect.provide(BoardWindows.live.pipe(Layer.provide(Layer.mergeAll(m.layer, SpiegaHome.fromPath(home))))),
  Effect.provide(TestClock.layer()),
));
const record = () => JSON.parse(fs.readFileSync(path.join(home, '.spiega', 'windows.json'), 'utf8'));

await test('showBoard raises the window there is, and yields the URL', async () => {
  const m = fakeDesktop({ files: [CHROME], ps: CHROME, titles: { 'Google Chrome': ['spiega [skills-2]'] } });
  const r = await showing(m, showBoard(U, 'skills-2'));
  assert.deepEqual(r, { url: U, raised: true, how: 'raised in Google Chrome' });
  assert.deepEqual(m.asked.launched, [], 'and no second window is made');
});

await test('showBoard opens one window, believes the record for the grace period, then opens again', async () => {
  const m = fakeDesktop({ files: [CHROME], ps: CHROME });
  const first = await showing(m, showBoard(U, 'race'));
  assert.deepEqual(first, { url: U, raised: false, how: 'chrome app window', app: true });
  assert.equal(record().race, T, 'the open is recorded at the clock\'s time');

  /* The window from the line above is still loading, so its title carries no
     [race] yet and the window server honestly reports nothing. */
  const racing = await showing(m, showBoard(U, 'race'));
  assert.deepEqual(racing, { url: U, raised: true, how: 'opening' });
  assert.equal(m.asked.launched.length, 1, 'nothing is opened on top of it');

  const later = await showing(m, Effect.gen(function* () {
    yield* TestClock.adjust(`${OPENING_MS} millis`);
    return yield* showBoard(U, 'race', { size: '800x600' });
  }));
  assert.equal(later.raised, false, 'a window the person has since closed can be reopened');
  assert.deepEqual(m.asked.launched[1], [CHROME, [`--app=${U}`, '--window-size=800,600'], false]);
});

await test('showBoard on Linux cannot raise, so it opens: in app mode where there is a browser', async () => {
  const m = fakeDesktop({ platform: 'linux', bins: ['google-chrome'] });
  const r = await showing(m, showBoard(U, 'linux-board'));
  assert.deepEqual(r, { url: U, raised: false, how: 'chrome app window', app: true });
  assert.deepEqual(m.asked.launched, [['google-chrome', [`--app=${U}`], false]]);
});

await test('a board with no name cannot be found by title, so it is opened without asking', async () => {
  const m = fakeDesktop({ files: [CHROME], ps: CHROME });
  const r = await showing(m, showBoard(U, ''));
  assert.equal(r.raised, false);
  assert.deepEqual(m.asked.scripts, [], 'nothing is asked of the window server');
  assert.equal(m.asked.launched.length, 1);
});

/* ---------- the plain door the CLI and MCP still use ---------- */

await test('the plain showBoard keeps its shape, and a launch that throws still throws what it threw', async () => {
  const { showBoard: plainShow } = await import('../src/board/open.js');
  const book = {};
  const halves = {
    opened: name => book[name] || 0,
    note: name => { book[name] = Date.now(); },
  };
  const raised = plainShow(U, 'skills-2', { ...halves, focus: () => ({ ok: true, how: 'raised in Google Chrome' }),
    open: () => assert.fail('opened a second window') });
  assert.deepEqual(raised, { ok: true, how: 'raised in Google Chrome', raised: true });

  const opened = plainShow(U, 'fresh', { ...halves, focus: () => ({ ok: false, how: 'none' }),
    open: (url, opts) => ({ how: `opened ${url} app=${opts.app}`, app: opts.app }) });
  assert.deepEqual(opened, { how: `opened ${U} app=true`, app: true, raised: false });
  assert.ok(book.fresh, 'and the open was recorded');

  const boom = new Error('spawn ENOENT');
  assert.throws(() => plainShow(U, 'broken', { ...halves, focus: () => ({ ok: false, how: 'none' }),
    open: () => { throw boom; } }), e => e === boom, 'the very error, not an Effect wrapper around it');
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${n} passed`);
