/* ============================================================
   @spiega/board — the board app, independent of any view framework.

   Model, messages, commands, pure update, and a server-free fixture store.
   ============================================================ */

export type { Cmd } from './app/cmd.js';
export {
  activeStep,
  chapterFromHash,
  clampRate,
  cloneBoard,
  computeTape,
  currentGroupRuns,
  currentLineStates,
  currentMap,
  currentRailMarks,
  currentSurface,
  FLOW_TICK_MS,
  init,
  MAX_RATE,
  MAX_ZOOM,
  MIN_RATE,
  MIN_ZOOM,
  narratorDrives,
  replayEntries,
  unsavedWarning,
  visibleArea,
  type CameraState,
  type Caption,
  type ChapterRef,
  type InitOptions,
  type LinkStatus,
  type Model,
  type PlaybackState,
  type ReplayState,
  type SavingStatus,
  type VoiceInfo,
} from './app/model.js';
export type { Msg } from './app/msg.js';
export {
  createFixtureStore,
  createStore,
  type BoardStore,
  type CmdRunner,
  type FixtureStore,
  type FixtureStoreOptions,
} from './app/store.js';
export { update, type UpdateResult } from './app/update.js';
