/* The browser host. It executes commands and feeds server events into the
   model; rendering never owns the connection or performs I/O.

   Two transports, one runner. A board served at /b/<name>/ holds the server's
   event stream; a board exported to a file carries its state in
   `window.__SPIEGA_EXPORT__` and has nothing to connect to. Everything that is
   not transport — narration, timers, the address bar — is the same for both. */
import { createNarrator } from '../../../../src/board/narrate.js';
import type { Board } from '../../../../src/board/state.js';
import { narrationRunner } from '../app/narration.js';
import type { Cmd } from '../app/cmd.js';
import { init } from '../app/model.js';
import type { Msg, SettleGated } from '../app/msg.js';
import { createStore, type BoardStore } from '../app/store.js';

/* What `src/board/export.ts` writes into an exported file. */
export type ExportConfig = {
  readonly board: Board,
  readonly viewing: number | 'live' | 'map' | null,
  readonly active: number | null,
  readonly chapterOnly: boolean,
};

declare global {
  interface Window { __SPIEGA_EXPORT__?: ExportConfig }
}

/* How long the dot stays lit after the agent drew something. */
const LIVE_MS = 2500;

export function browserStore(railOpen: boolean, exported: ExportConfig | null = window.__SPIEGA_EXPORT__ ?? null): BoardStore {
  let store: BoardStore;
  let runningCommand = 0;
  let flowTimer: ReturnType<typeof setInterval> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const narrator = createNarrator({ onState: ({ playing }) => {
    if (!runningCommand && !playing && store?.getSnapshot().playback.tapePlaying) {
      store.dispatch({ type: 'narrateStopped' });
    }
  } });
  const runNarration = narrationRunner(narrator, () => store.getSnapshot(), () => new Promise(resolve => setTimeout(resolve, 1600)));
  const api = location.pathname.replace(/\/?$/, '/');
  store = createStore(init({
    railOpen,
    exported: exported !== null,
    chapterOnly: exported?.chapterOnly ?? false,
    narratorAvailable: narrator.available,
    voice: narrator.voiceName,
    voices: narrator.voices(),
    following: readFollow(window),
  }), (cmd, dispatch) => {
      runningCommand++;
      try {
        runBrowserCommand(window, cmd);
        runNarration(cmd, dispatch);
        switch (cmd.type) {
          case 'postOps':
            void fetch(api + 'op', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: cmd.ops }) });
            break;
          case 'settleBoard':
            void settleBoard(fetch, api, cmd.then, dispatch);
            break;
          case 'exportBoard': {
            const params = new URLSearchParams({ scope: cmd.scope });
            if (cmd.scope === 'chapter') params.set('chapter', String(cmd.chapter));
            else params.set('viewing', String(cmd.viewing));
            if (cmd.step != null) params.set('step', String(cmd.step));
            const link = document.createElement('a');
            link.href = api + 'export?' + params;
            link.click();
            break;
          }
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
    });
  if (exported) openExported(store, exported);
  else connectLive(store, api);
  if (narrator.available) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      store.dispatch({ type: 'voicesChanged', voices: narrator.voices(), selected: narrator.voiceName });
    });
  }
  return store;
}

/* The file is a reader's private copy, opened where its exporter was looking. */
function openExported(store: BoardStore, exported: ExportConfig): void {
  const { board, viewing, active } = exported;
  const hash = typeof viewing === 'number' && board.chapters?.[viewing] ? `#${viewing + 1}`
    : viewing === 'live' ? '#live'
      : viewing === 'map' ? '#map'
        : location.hash;
  store.dispatch({ type: 'stateReceived', board, full: true, hash });
  if (active != null && store.getSnapshot().viewing != null) {
    store.dispatch({ type: 'focusStep', step: Number(active) });
  }
}

/* The stream is the only thing keeping this page true. If it dies — the server
   restarted, the machine slept, the network blinked — a board that silently
   keeps showing its last state is worse than no board, because it looks like an
   answer. So: reconnect with backoff, say so while disconnected, and re-sync
   whenever the window is looked at again. */
export function connectLive(store: BoardStore, api: string): void {
  let events: EventSource | null = null;
  let retry = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const received = (msg: Msg) => {
    store.dispatch(msg);
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => store.dispatch({
      type: 'linkChanged', status: events?.readyState === EventSource.OPEN ? 'idle' : 'down',
    }), LIVE_MS);
  };
  const connect = () => {
    clearTimeout(retryTimer);
    events?.close();
    const stream = events = new EventSource(api + 'events');
    stream.addEventListener('open', () => { retry = 0; store.dispatch({ type: 'linkChanged', status: 'idle' }); });
    stream.addEventListener('state', event => received({ type: 'stateReceived', board: JSON.parse(event.data), full: true, hash: location.hash }));
    stream.addEventListener('patch', event => {
      const patch = JSON.parse(event.data);
      received({ type: 'stateReceived', board: patch.board, fresh: patch.fresh, amended: patch.amended });
    });
    stream.addEventListener('saving', event => store.dispatch({ type: 'savingChanged', status: JSON.parse(event.data) }));
    // `spiega replay`, or the agent's own tool, asking for the movie again.
    stream.addEventListener('replay', () => store.dispatch({ type: 'replayStart' }));
    stream.addEventListener('error', () => {
      if (stream.readyState === EventSource.OPEN) return;
      store.dispatch({ type: 'linkChanged', status: 'down' });
      // EventSource retries on its own, but not after the server refuses the
      // connection outright, which is the case that actually bites here.
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(connect, Math.min(800 * retry, 5000));
    });
  };
  connect();
  fetch(api + 'whoami').then(response => response.json()).then(who => {
    if (typeof who?.name === 'string') store.dispatch({ type: 'boardTagged', tag: who.name });
  }).catch(() => {});
  /* Coming back to the window is the moment a stale board is most misleading. */
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!events || events.readyState !== EventSource.OPEN) { connect(); return; }
    void fetch(api + 'state').then(response => response.ok ? response.json() : null).then(board => {
      if (board && board.rev !== store.getSnapshot().board?.rev) store.dispatch({ type: 'stateReceived', board, full: true, hash: location.hash });
    }).catch(() => {});
  });
}

/* Ask the server to tidy the board, then let the gesture that waited go on.
   Any failure — refused, offline, unreadable — becomes a caption, never a
   rejected promise and never a tape spoken over a layout about to move. */
export async function settleBoard(
  fetcher: (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>,
  api: string,
  then: SettleGated,
  dispatch: (msg: Msg) => unknown,
): Promise<void> {
  try {
    const response = await fetcher(api + 'settle', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    if (!response.ok) throw new Error('settle request failed');
    const result: { board?: Board } = await response.json();
    dispatch({ type: 'settled', board: result.board ?? null, then });
  } catch {
    dispatch({ type: 'settleFailed' });
  }
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
