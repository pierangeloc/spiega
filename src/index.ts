/* spiega — the public surface.
 *
 * It re-exports and nothing else. It was the first module here to be
 * TypeScript, compiled into the artefact beside JavaScript that was copied
 * into it, so that the arrangement every later port relied on was exercised
 * before any of them did. The JavaScript has all gone since (#160). */
export { renderSVG, indexFlow } from './render/render.js';
export { emptyBoard, applyOp, applyOps } from './board/state.js';
export { snapshotHTML } from './board/snapshot.js';
export { createServer, listen, startBoard, findBoard, findServer, resolveBoard, SESSION_FILE } from './board/server.js';
export * as theme from './render/theme.js';
export { KINDS } from './render/glyphs.js';
