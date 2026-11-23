/* ============================================================
   The reducer, as the server reaches it.

   The reducer and the settle pass still live in src/board, where the board
   page imports them off disk, so this package names them in one place rather
   than reaching into src/ from every file. The day they move, this is the only
   file that changes. Reached by relative path because the artefact has no
   resolution of its own: dist/ keeps the repository's layout, and every module
   finds its neighbours by walking up from itself.
   ============================================================ */

export { LOG_CAP, applyOps, boardOps } from '../../../src/board/state.js';
export type { Board, Chapter, Fresh, Op } from '../../../src/board/state.js';
export { applySettlingOps, settleOp } from '../../../src/board/settle.js';
