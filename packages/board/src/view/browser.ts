import type { Cmd } from '../app/cmd.js';

/* Both operations can fail in a private window or an exported file. The board
   must still draw and respond even when the browser refuses persistence. */
type Browser = Pick<Window, 'localStorage' | 'location' | 'history'>;

export function readFollow(browser: Browser): boolean {
  try { return browser.localStorage.getItem('spiega.follow') !== 'off'; }
  catch { return true; }
}

export function runBrowserCommand(browser: Browser, cmd: Cmd): void {
  try {
    if (cmd.type === 'persistFollow') {
      browser.localStorage.setItem('spiega.follow', cmd.following ? 'on' : 'off');
    } else if (cmd.type === 'setHash' && browser.location.hash !== cmd.hash) {
      browser.history.replaceState(null, '', browser.location.pathname + browser.location.search + cmd.hash);
    }
  } catch { /* The view still works without a saved preference or address. */ }
}
