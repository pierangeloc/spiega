/* ============================================================
   handwave open — put the board in a real window.

   A terminal pane has to encode every frame and push it through the TTY, so
   panning and zooming there cost far more than the drawing itself ever does.
   A browser window runs the same board at the display's refresh rate.

   App mode (`--app=URL`) is the point: a chromeless window with no tabs and no
   address bar, with its own entry in the Dock or taskbar, which sits beside a
   terminal like a native sidecar instead of competing with your other tabs.
   ============================================================ */

import fs from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

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
export function focusBoard(name, url) {
  if (process.platform !== 'darwin') {
    return { ok: false, how: `no window raising on ${process.platform} yet \u2014 open ${url}` };
  }

  /* Which browsers are actually running, decided here rather than in
     AppleScript. Asking AppleScript whether an app it has never heard of is
     running makes it try to resolve the name, which blocks — a five-second
     timeout for a question `ps` answers instantly. */
  const APPS = {
    'Google Chrome': /Google Chrome/,
    'Brave Browser': /Brave Browser/,
    Chromium: /Chromium/,
    'Microsoft Edge': /Microsoft Edge/,
  };
  let procs = '';
  try { procs = execFileSync('ps', ['-Ao', 'comm='], { encoding: 'utf8', timeout: 3000 }); } catch { /* none */ }
  const live = Object.keys(APPS).filter(a => APPS[a].test(procs));
  if (!live.length) return { ok: false, how: `no browser running \u2014 \`handwave open\`` };

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
      const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 }).trim();
      if (out === 'ok') return { ok: true, how: `raised in ${app}` };
    } catch { /* try the next browser */ }
  }
  return { ok: false, how: `no window showing "${name}" \u2014 \`handwave open\` makes one` };
}
