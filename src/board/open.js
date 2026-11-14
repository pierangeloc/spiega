/* ============================================================
   spiega open — put the board in a real window.

   A terminal pane has to encode every frame and push it through the TTY, so
   panning and zooming there cost far more than the drawing itself ever does.
   A browser window runs the same board at the display's refresh rate.

   App mode (`--app=URL`) is the point: a chromeless window with no tabs and no
   address bar, with its own entry in the Dock or taskbar, which sits beside a
   terminal like a native sidecar instead of competing with your other tabs.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { SESSION_DIR } from './server.js';

const MAC = {
  chrome:   '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  brave:    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  edge:     '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
};

const LINUX = {
  chrome:   ['google-chrome', 'google-chrome-stable'],
  brave:    ['brave-browser', 'brave'],
  chromium: ['chromium', 'chromium-browser'],
  edge:     ['microsoft-edge'],
};

const WIN = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge:   'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  brave:  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
};

const onPath = bin => spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;

const ORDER = ['chrome', 'brave', 'chromium', 'edge'];

/* Find a Chromium-family browser that can do app mode, or null. */
export function findChromium(preferred = null) {
  const order = preferred ? [preferred, ...ORDER.filter(n => n !== preferred)] : ORDER;
  for (const name of order) {
    if (process.platform === 'darwin') {
      if (MAC[name] && fs.existsSync(MAC[name])) return { name, cmd: MAC[name] };
    } else if (process.platform === 'win32') {
      if (WIN[name] && fs.existsSync(WIN[name])) return { name, cmd: WIN[name] };
    } else {
      for (const bin of LINUX[name] || []) if (onPath(bin)) return { name, cmd: bin };
    }
  }
  return null;
}

/* Open `url` and return how it was opened, so the caller can say so.
   `app: false`, or no Chromium anywhere, falls back to the default browser. */
export function openBoard(url, { app = true, size = null, pos = null, browser = null } = {}) {
  const found = app ? findChromium(browser) : null;

  if (found) {
    const args = [`--app=${url}`];
    // No separate profile dir: that would lose the person's session and theme.
    // This attaches to their running browser, and app mode still gets a window
    // of its own.
    if (size) args.push(`--window-size=${String(size).replace(/[x:,]/, ',')}`);
    if (pos) args.push(`--window-position=${String(pos).replace(/[x:,]/, ',')}`);
    spawn(found.cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return { how: `${found.name} app window`, app: true };
  }

  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], {
    detached: true, stdio: 'ignore', shell: process.platform === 'win32',
  }).unref();
  return { how: 'default browser', app: false };
}

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

export function runningBrowsers(psOutput) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return BROWSER_APPS.filter(app =>
    new RegExp(`/${esc(app)}\\.app/Contents/MacOS/[^/]+$`, 'm').test(psOutput || ''));
}

/* Put this board in front of the person: raise the window it is already in,
   or make one.

   A second window of the same board is not a second board, but it looks
   exactly like one — both stream the same ops and draw in lockstep. Reported
   as "one agent, two boards being drawn": three windows, every one of them
   titled [skills-2]. The tool description says to call this once, early, and
   prose does not hold; a model that calls it again at the next chapter, or
   retries it, used to get another window every time.

   Raising is also what a repeat call means. "Open the board" from an agent
   that has one open is "put it where I can see it", and that is what this now
   does — the window the person already has, with their scroll and zoom, not a
   fresh one on top of it.

   The two halves are injected so the decision can be tested without a browser
   or a window server; see test/smoke.mjs. */
export function showBoard(url, name, { app = true, size = null, pos = null, browser = null,
                                       focus = focusBoard, open = openBoard,
                                       opened = openedAt, note = noteOpened } = {}) {
  if (name) {
    const r = focus(name, url);
    if (r.ok) return { ...r, raised: true };
    /* A window that was opened a moment ago has no title to match yet: the
       tag goes in when the page renders. Two calls in the same second then
       both find nothing and both open one, which is how three windows of one
       board turned up. Within the grace period, believe the record instead of
       the window server. */
    const since = Date.now() - opened(name);
    if (since < OPENING_MS) return { ok: true, how: 'opening', raised: true };
  }
  const r = open(url, { app, size, pos, browser });
  if (name) note(name);
  return { ...r, raised: false };
}

/* How long a window may take to show its own title. Generous: the cost of
   waiting is one call reporting "opening", and the cost of not waiting is a
   duplicate window that looks like a second board. */
const OPENING_MS = 10_000;
const windowsFile = () => path.join(SESSION_DIR, 'windows.json');
const readOpened = () => { try { return JSON.parse(fs.readFileSync(windowsFile(), 'utf8')); } catch { return {}; } };

export const openedAt = name => Number(readOpened()[name]) || 0;

/* Across processes, because the repeat caller is often a second `spiega open`
   rather than a second call in one agent. */
export function noteOpened(name, when = Date.now()) {
  try {
    const all = readOpened();
    all[name] = when;
    for (const [k, t] of Object.entries(all)) if (when - Number(t) > 60 * 60_000) delete all[k];
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(windowsFile(), JSON.stringify(all));
  } catch { /* unwritable state dir: the grace period is a nicety */ }
}

export function focusBoard(name, url) {
  if (process.platform !== 'darwin') {
    return { ok: false, how: `no window raising on ${process.platform} yet \u2014 open ${url}` };
  }

  /* Which browsers are actually running, decided here rather than in
     AppleScript. Asking AppleScript whether an app it has never heard of is
     running makes it try to resolve the name, which blocks — a five-second
     timeout for a question `ps` answers instantly. */
  let procs = '';
  try {
    procs = execFileSync('ps', ['-Ao', 'comm='],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* none */ }
  const live = runningBrowsers(procs);
  if (!live.length) return { ok: false, how: `no browser running \u2014 \`spiega open\`` };

  // the board name is in the window title; see board.html
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
    try {
      // stderr is piped, not inherited: a browser that is half-installed makes
      // osascript complain, and that complaint is not the person's business
      const out = execFileSync('osascript', ['-e', script],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (out === 'ok') return { ok: true, how: `raised in ${app}` };
    } catch { /* try the next browser */ }
  }
  return { ok: false, how: `no window showing "${name}" \u2014 \`spiega open\` makes one` };
}
