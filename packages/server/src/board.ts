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

/* The board as a file: the interactive export, the still, and the bare SVG.
   Pure assembly, with no server in it, which is why it lives beside the board
   and is tested there; the routes are only the way in over HTTP. Loaded the
   first time one is asked for rather than with the server, as the old routes
   loaded them: most boards are never exported. */
export type { ExportOptions } from '../../../src/board/export.js';
export type { Measured } from '../../../src/render/audit.js';
export const pictures = () =>
  Promise.all([
    import('../../../src/board/export.js'),
    import('../../../src/board/snapshot.js'),
    import('../../../src/render/render.js'),
  ]).then(([e, s, r]) => ({
    exportHTML: e.exportHTML,
    snapshotHTML: s.snapshotHTML,
    renderSVG: r.renderSVG,
  }));
