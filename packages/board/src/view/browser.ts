/* The fixture's browser host. It executes commands, never decisions made by a
   React render. #156 will replace the fixture's in-memory board transport. */
import { createNarrator } from '../../../../src/board/narrate.js';
import { narrationRunner } from '../app/narration.js';
import type { Cmd } from '../app/cmd.js';
import type { FixtureStore } from '../app/store.js';
import { fixtureStore } from './fixture.js';

export function browserStore(railOpen: boolean): FixtureStore {
  let store: FixtureStore;
  let runningCommand = 0;
  let flowTimer: ReturnType<typeof setInterval> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const narrator = createNarrator({ onState: ({ playing }) => {
    if (!runningCommand && !playing && store?.getSnapshot().playback.tapePlaying) {
      store.dispatch({ type: 'narrateStopped' });
    }
  } });
  const runNarration = narrationRunner(narrator, () => store.getSnapshot(), () => new Promise(resolve => setTimeout(resolve, 1600)));
  store = fixtureStore(railOpen, {
    narratorAvailable: narrator.available,
    voice: narrator.voiceName,
    voices: narrator.voices(),
    following: readFollow(window),
    hash: location.hash,
    runCmd: (cmd, dispatch) => {
      runningCommand++;
      try {
        runBrowserCommand(window, cmd);
        runNarration(cmd, dispatch);
        switch (cmd.type) {
          case 'startFlowTimer':
            clearInterval(flowTimer);
            flowTimer = setInterval(() => dispatch({ type: 'flowTick' }), cmd.intervalMs);
            break;
          case 'stopFlowTimer': clearInterval(flowTimer); break;
          case 'scheduleReplayStep':
            clearTimeout(replayTimer);
            replayTimer = setTimeout(() => dispatch({ type: 'replayStep' }), cmd.delayMs);
            break;
          case 'cancelReplay': clearTimeout(replayTimer); break;
        }
      } finally { runningCommand--; }
    },
  });
  if (narrator.available) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      store.dispatch({ type: 'voicesChanged', voices: narrator.voices(), selected: narrator.voiceName });
    });
  }
  return store;
}

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
