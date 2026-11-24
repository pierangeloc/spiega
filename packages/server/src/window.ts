/* ============================================================
   The board's own window, as Effects.

   A terminal pane has to encode every frame and push it through the TTY, so
   panning and zooming there cost far more than the drawing itself ever does.
   A browser window runs the same board at the display's refresh rate.

   App mode (`--app=URL`) is the point: a chromeless window with no tabs and no
   address bar, with its own entry in the Dock or taskbar, which sits beside a
   terminal like a native sidecar instead of competing with your other tabs.

   Two services, so that every decision here can be run without a browser or a
   window server. `Desktop` is the machine: which platform, which files exist,
   how a process is started and asked about. `BoardWindows` is the four things
   `showBoard` decides between — raise, open, and the record of what was
   opened a moment ago — so a caller that brings its own halves (the plain
   wrapper in src/board/open.ts, and the tests behind it) still goes through
   the one decision rather than a copy of it.

   `Desktop.live.launch` is asynchronous, and the one place here that has to
   be: `findChromium` can see a binary that is gone by the time `launch` spawns
   it — an upgrade swapping the bundle, a PATH entry that stops resolving — and
   `child_process.spawn` does not throw for that. It returns a `ChildProcess`
   and reports the failure a tick later as an `'error'` event, which Node
   rethrows as an uncaught exception if nothing is listening (#186). So launch
   attaches that listener and waits out `SPAWN_GRACE_MS` before declaring the
   process started: long enough for ENOENT/EACCES to surface, short beside the
   time a browser takes to actually paint a window. Everything else here stays
   synchronous underneath — raising a window is a synchronous AppleScript call
   — so `Effect.runPromise`, not `Effect.runSync`, is how a caller runs these. */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { Clock, Context, Effect, Layer } from 'effect';
import { SpiegaHome } from './config.js';
import { LaunchFailed, NoBoardWindow, NoBrowserRunning, NoWindowRaising } from './errors.js';

export interface DesktopShape {
  readonly platform: string;
  readonly exists: (file: string) => boolean;
  readonly onPath: (bin: string) => boolean;
  /* Start a process detached from this one and let it go. Resolves once the
     process has survived `SPAWN_GRACE_MS` without reporting that it could not
     start at all; rejects with what it reported if it does. */
  readonly launch: (cmd: string, args: ReadonlyArray<string>, shell: boolean) => Promise<void>;
  /* Every running process's command, one per line, as `ps -Ao comm=` prints it. */
  readonly processes: () => string;
  readonly osascript: (script: string) => string;
}

export class Desktop extends Context.Service<Desktop, DesktopShape>()('@spiega/server/Desktop') {
  static readonly make = (desktop: DesktopShape): Layer.Layer<Desktop> => Layer.succeed(Desktop, desktop);

  static readonly live: Layer.Layer<Desktop> = Desktop.make({
    platform: process.platform,
    exists: (file) => fs.existsSync(file),
    onPath: (bin) => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0,
    launch: (cmd, args, shell) => new Promise((resolve, reject) => {
      const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore', shell });
      // Only this tick's failure is ours to report: once the grace period
      // passes the process is on its own, same as before #186.
      const onError = (cause: Error): void => { clearTimeout(timer); reject(cause); };
      const timer = setTimeout(() => { child.removeListener('error', onError); child.unref(); resolve(); }, SPAWN_GRACE_MS);
      child.once('error', onError);
    }),
    processes: () => execFileSync('ps', ['-Ao', 'comm='],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }),
    // stderr is piped, not inherited: a browser that is half-installed makes
    // osascript complain, and that complaint is not the person's business
    osascript: (script) => execFileSync('osascript', ['-e', script],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }),
  });
}

/* How long to let a spawn announce that it could not start at all. ENOENT and
   EACCES land on the next tick; a browser that is actually starting is still
   running long past this, so waiting longer only delays reporting a real
   failure. */
export const SPAWN_GRACE_MS = 250;

const MAC: Record<string, string> = {
  chrome:   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  brave:    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  edge:     '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
};

const LINUX: Record<string, string[]> = {
  chrome:   ['google-chrome', 'google-chrome-stable'],
  brave:    ['brave-browser', 'brave'],
  chromium: ['chromium', 'chromium-browser'],
  edge:     ['microsoft-edge'],
};

const WIN: Record<string, string> = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge:   'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  brave:  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
};

const ORDER = ['chrome', 'brave', 'chromium', 'edge'];

export type Found = { name: string, cmd: string };

/* Find a Chromium-family browser that can do app mode, or null. */
export const findChromium = (preferred: string | null = null): Effect.Effect<Found | null, never, Desktop> =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    const order = preferred ? [preferred, ...ORDER.filter(n => n !== preferred)] : ORDER;
    for (const name of order) {
      if (desktop.platform === 'darwin') {
        if (MAC[name] && desktop.exists(MAC[name])) return { name, cmd: MAC[name] };
      } else if (desktop.platform === 'win32') {
        if (WIN[name] && desktop.exists(WIN[name])) return { name, cmd: WIN[name] };
      } else {
        for (const bin of LINUX[name] || []) if (desktop.onPath(bin)) return { name, cmd: bin };
      }
    }
    return null;
  });

/* `size` and `pos` are `WxH` and `X,Y`, as they come off the command line. */
export type OpenOptions = {
  app?: boolean,
  size?: string | number | null,
  pos?: string | number | null,
  browser?: string | null,
};
export type Opened = { how: string, app: boolean };

const launch = (cmd: string, args: ReadonlyArray<string>, shell: boolean): Effect.Effect<void, LaunchFailed, Desktop> =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    yield* Effect.tryPromise({ try: () => desktop.launch(cmd, args, shell), catch: (cause) => new LaunchFailed({ cmd, cause }) });
  });

/* Open `url` and say how it was opened, so the caller can say so.
   `app: false`, or no Chromium anywhere, falls back to the default browser. */
export const openBoard = (
  url: string,
  { app = true, size = null, pos = null, browser = null }: OpenOptions = {},
): Effect.Effect<Opened, LaunchFailed, Desktop> =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    const found = app ? yield* findChromium(browser) : null;

    if (found) {
      const args = [`--app=${url}`];
      // No separate profile dir: that would lose the person's session and theme.
      // This attaches to their running browser, and app mode still gets a window
      // of its own.
      if (size) args.push(`--window-size=${String(size).replace(/[x:,]/, ',')}`);
      if (pos) args.push(`--window-position=${String(pos).replace(/[x:,]/, ',')}`);
      yield* launch(found.cmd, args, false);
      return { how: `${found.name} app window`, app: true };
    }

    const cmd = desktop.platform === 'darwin' ? 'open'
      : desktop.platform === 'win32' ? 'start' : 'xdg-open';
    yield* launch(cmd, [url], desktop.platform === 'win32');
    return { how: 'default browser', app: false };
  });

/* ---------- bringing a board to the front ----------

   A board window belongs to a conversation, and with eight tasks in flight the
   window you want is behind seven others. The only handle an operating system
   has on a browser app window is its title, so the page puts the board name
   there and we look for it.

   macOS only for now, through AppleScript. Linux would be wmctrl or xdotool
   and Windows a PowerShell call; rather than pretend, say so and print the URL
   so the person still gets there. */
/* Which Chromium-family browsers are running, from a `ps` listing.

   The app's own binary, not its name anywhere in a path: Microsoft Teams ships
   an Edge Framework, so a loose match reported Edge running on a machine that
   has never had it, and AppleScript was then asked to script an application
   that does not exist — which it reports on stderr, in front of the person. */
export const BROWSER_APPS = ['Google Chrome', 'Brave Browser', 'Chromium', 'Microsoft Edge'];

export function runningBrowsers(psOutput?: string | null): string[] {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return BROWSER_APPS.filter(app =>
    new RegExp(`/${esc(app)}\\.app/Contents/MacOS/[^/]+$`, 'm').test(psOutput || ''));
}

export type Raised = { how: string };
export type NotRaised = NoWindowRaising | NoBrowserRunning | NoBoardWindow;

/* Raise the window already showing this board, or say why there is none. */
export const focusBoard = (name: string, url: string): Effect.Effect<Raised, NotRaised, Desktop> =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    if (desktop.platform !== 'darwin') return yield* new NoWindowRaising({ platform: desktop.platform, url });

    /* Which browsers are actually running, decided here rather than in
       AppleScript. Asking AppleScript whether an app it has never heard of is
       running makes it try to resolve the name, which blocks — a five-second
       timeout for a question `ps` answers instantly. */
    const procs = yield* Effect.try(() => desktop.processes()).pipe(Effect.orElseSucceed(() => ''));
    const live = runningBrowsers(procs);
    if (!live.length) return yield* new NoBrowserRunning();

    // the board name is in the window title; see packages/board/src/view/App.tsx
    const tag = `[${name}]`;
    for (const app of live) {
      const script = `tell application ${JSON.stringify(app)}
      repeat with w in windows
        try
          if title of w contains ${JSON.stringify(tag)} then
            set index of w to 1
            activate
            return "ok"
          end if
        end try
      end repeat
    end tell
    return "none"`;
      // a browser that will not answer is not the end: try the next one
      const out = yield* Effect.try(() => desktop.osascript(script).trim()).pipe(Effect.orElseSucceed(() => ''));
      if (out === 'ok') return { how: `raised in ${app}` };
    }
    return yield* new NoBoardWindow({ name });
  });

/* The sentence each reason has always been, for a caller that prints it. */
export const notRaisedHow = (e: NotRaised): string => {
  switch (e._tag) {
    case 'NoWindowRaising': return `no window raising on ${e.platform} yet \u2014 open ${e.url}`;
    case 'NoBrowserRunning': return `no browser running \u2014 \`spiega open\``;
    case 'NoBoardWindow': return `no window showing "${e.name}" \u2014 \`spiega open\` makes one`;
  }
};

/* ---------- what was opened a moment ago ----------

   Across processes, because the repeat caller is often a second `spiega open`
   rather than a second call in one agent. */
const windowsFile = (sessionDir: string): string => path.join(sessionDir, 'windows.json');

/* Board name to when a window was last opened for it. */
const readOpened = (sessionDir: string): Record<string, unknown> => {
  const all: Record<string, unknown> = {};
  try {
    const read: unknown = JSON.parse(fs.readFileSync(windowsFile(sessionDir), 'utf8'));
    if (read !== null && typeof read === 'object') for (const k of Object.keys(read)) all[k] = Reflect.get(read, k);
  } catch { /* none yet */ }
  return all;
};

export const openedAt = (name: string): Effect.Effect<number, never, SpiegaHome> =>
  Effect.gen(function* () {
    const home = yield* SpiegaHome;
    return Number(readOpened(home.sessionDir)[name]) || 0;
  });

export const noteOpened = (name: string, when?: number): Effect.Effect<void, never, SpiegaHome> =>
  Effect.gen(function* () {
    const home = yield* SpiegaHome;
    const at = when ?? (yield* Clock.currentTimeMillis);
    try {
      const all = readOpened(home.sessionDir);
      all[name] = at;
      for (const [k, t] of Object.entries(all)) if (at - Number(t) > 60 * 60_000) delete all[k];
      fs.mkdirSync(home.sessionDir, { recursive: true });
      fs.writeFileSync(windowsFile(home.sessionDir), JSON.stringify(all));
    } catch { /* unwritable state dir: the grace period is a nicety */ }
  });

/* ---------- putting a board in front of the person ---------- */

export interface BoardWindowsShape {
  readonly focus: (name: string, url: string) => Effect.Effect<Raised, NotRaised>;
  readonly open: (url: string, opts: OpenOptions) => Effect.Effect<Opened, LaunchFailed>;
  readonly opened: (name: string) => Effect.Effect<number>;
  readonly note: (name: string) => Effect.Effect<void>;
}

/* The four halves as this machine does them. */
export const liveWindows: Effect.Effect<BoardWindowsShape, never, Desktop | SpiegaHome> = Effect.gen(function* () {
  const desktop = yield* Desktop;
  const home = yield* SpiegaHome;
  return {
    focus: (name, url) => focusBoard(name, url).pipe(Effect.provideService(Desktop, desktop)),
    open: (url, opts) => openBoard(url, opts).pipe(Effect.provideService(Desktop, desktop)),
    opened: (name) => openedAt(name).pipe(Effect.provideService(SpiegaHome, home)),
    note: (name) => noteOpened(name).pipe(Effect.provideService(SpiegaHome, home)),
  };
});

export class BoardWindows extends Context.Service<BoardWindows, BoardWindowsShape>()('@spiega/server/BoardWindows') {
  static readonly make = (windows: BoardWindowsShape): Layer.Layer<BoardWindows> => Layer.succeed(BoardWindows, windows);

  static readonly live: Layer.Layer<BoardWindows, never, Desktop | SpiegaHome> = Layer.effect(BoardWindows, liveWindows);
}

/* How long a window may take to show its own title. Generous: the cost of
   waiting is one call reporting "opening", and the cost of not waiting is a
   duplicate window that looks like a second board. */
export const OPENING_MS = 10_000;

export type Shown =
  | { readonly url: string, readonly raised: true, readonly how: string }
  | { readonly url: string, readonly raised: false, readonly how: string, readonly app: boolean };

/* Put this board in front of the person: raise the window it is already in,
   or make one. Yields the board's URL and how it got there.

   A second window of the same board is not a second board, but it looks
   exactly like one — both stream the same ops and draw in lockstep. Reported
   as "one agent, two boards being drawn": three windows, every one of them
   titled [skills-2]. The tool description says to call this once, early, and
   prose does not hold; a model that calls it again at the next chapter, or
   retries it, used to get another window every time.

   Raising is also what a repeat call means. "Open the board" from an agent
   that has one open is "put it where I can see it", and that is what this
   does — the window the person already has, with their scroll and zoom, not a
   fresh one on top of it. */
export const showBoard = (
  url: string,
  name: string,
  { app = true, size = null, pos = null, browser = null }: OpenOptions = {},
): Effect.Effect<Shown, LaunchFailed, BoardWindows> =>
  Effect.gen(function* () {
    const windows = yield* BoardWindows;
    if (name) {
      const raised = yield* windows.focus(name, url).pipe(Effect.option);
      if (raised._tag === 'Some') return { url, raised: true, how: raised.value.how };
      /* A window that was opened a moment ago has no title to match yet: the
         tag goes in when the page renders. Two calls in the same second then
         both find nothing and both open one, which is how three windows of one
         board turned up. Within the grace period, believe the record instead of
         the window server. */
      const since = (yield* Clock.currentTimeMillis) - (yield* windows.opened(name));
      if (since < OPENING_MS) return { url, raised: true, how: 'opening' };
    }
    const r = yield* windows.open(url, { app, size, pos, browser });
    if (name) yield* windows.note(name);
    return { url, raised: false, how: r.how, app: r.app };
  });
