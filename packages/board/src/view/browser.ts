/* The fixture's browser host. It executes commands, never decisions made by a
   React render. #156 will replace the fixture's in-memory board transport. */
import { createNarrator } from '../../../../src/board/narrate.js';
import { narrationRunner } from '../app/narration.js';
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
  const runNarration = narrationRunner(narrator, () => store.getSnapshot());
  store = fixtureStore(railOpen, {
    narratorAvailable: narrator.available,
    voice: narrator.voiceName,
    voices: narrator.voices(),
  }, (cmd, dispatch) => {
    runningCommand++;
    try {
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
  });
  if (narrator.available) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      store.dispatch({ type: 'voicesChanged', voices: narrator.voices(), selected: narrator.voiceName });
    });
  }
  return store;
}
