/* spiega — the public surface.
 *
 * TypeScript, and the only module here that is: it re-exports and nothing
 * else, which makes it the one place a port carries no risk. It is here to
 * keep the build's TypeScript half honest — a module compiled into the
 * artefact, importing JavaScript that was copied into it, with `allowJs`
 * holding the two together. That is the arrangement every port after this one
 * relies on, and an arrangement nothing exercises is an arrangement nobody
 * finds out about until it fails. */
export { renderSVG, indexFlow } from './render/render.js';
export { emptyBoard, applyOp, applyOps } from './board/state.js';
export { snapshotHTML } from './board/snapshot.js';
export { createServer, listen, startBoard, findBoard, findServer, resolveBoard, SESSION_FILE } from './board/server.js';
export * as theme from './render/theme.js';
export { KINDS } from './render/glyphs.js';
