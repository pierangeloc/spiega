/* ============================================================
   @spiega/server — the Effect HTTP board server, security middleware,
   and configuration services.
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
  type BoardEntry,
  type BoardSnapshot,
  type BoardStoreShape,
  type SavedBoardInfo,
  type SavingStatus,
} from './store.js';

export { MIME, ReadApp, ReadRoutes } from './routes.js';

export {
  createBoardReadBridge,
  createReadBridge,
  createReadNodeServer,
  createReadWebHandler,
  isReadRoute,
  type ReadAppServices,
  type ReadBridge,
  type WebHandlerHandle,
} from './node.js';
