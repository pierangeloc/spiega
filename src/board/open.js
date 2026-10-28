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
import { spawn, spawnSync } from 'node:child_process';

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
