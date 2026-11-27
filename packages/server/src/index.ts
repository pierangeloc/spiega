/* ============================================================
   @spiega/server — the Effect HTTP board server, security middleware,
   configuration services, and the board's own window.
   ============================================================ */

export {
  DEFAULT_BOARD,
  DEFAULT_PORT,
  DEFAULT_ROOT_DIR,
  SpiegaConfig,
  SpiegaHome,
  boardFileIn,
  makeConfig,
  makeHome,
  resolveHomeDir,
  type SpiegaConfigShape,
  type SpiegaHomeShape,
} from './config.js';

export {
  EXPECTED_JSON_ERROR,
  FOREIGN_ORIGIN_BODY,
  LOOPBACK_HOST,
  NON_LOOPBACK_BODY,
  RequireJsonMiddleware,
  SecurityMiddleware,
  isJsonContentType,
  isLoopbackHost,
  isSameOrAbsentOrigin,
} from './security.js';

export {
  BoardStore,
  savedBoardsIn,
  type Audited,
  type BoardEntry,
  type BoardSnapshot,
  type BoardStoreShape,
  type SavedBoardInfo,
  type SavingStatus,
} from './store.js';

export type { Measured } from './board.js';
export { BoardApp, MIME, ReadApp, ReadRoutes, RenderRoutes, WriteRoutes } from './routes.js';
export {
  ApplyFailed,
  BoardNotFound,
  InvalidJson,
  LaunchFailed,
  LogWriteError,
  NoBoardWindow,
  NoBrowserRunning,
  NoSuchChapter,
  NoWindowRaising,
  NotJson,
  RenderFailed,
} from './errors.js';
export { createOpLog, makeOpLog, type LogFile, type OpLog, type OpLogHandle, type OpLogOptions } from './oplog.js';
export { draw, settle, type Drawn } from './ops.js';
export { createBoardEvents, type BoardEvents } from './events.js';

export {
  BROWSER_APPS,
  BoardWindows,
  Desktop,
  OPENING_MS,
  findChromium,
  focusBoard,
  liveWindows,
  noteOpened,
  notRaisedHow,
  openBoard,
  openedAt,
  runningBrowsers,
  showBoard,
  type BoardWindowsShape,
  type DesktopShape,
  type Found,
  type NotRaised,
  type OpenOptions,
  type Opened,
  type Raised,
  type Shown,
} from './window.js';

export {
  createBoardReadBridge,
  createReadBridge,
  createBoardWebHandler,
  createReadNodeServer,
  createReadWebHandler,
  isReadRoute,
  isRenderRoute,
  isWriteRoute,
  type ReadAppServices,
  type ReadBridge,
  type WebHandlerHandle,
} from './node.js';
