/* ============================================================
   What the stage draws, and where it sits — without React.

   The drawing is a string. `renderSVG` returns one and the stage drops it into
   `.pan` as-is; componentising the SVG is not on anybody's plan. The value of
   keeping that in a module of its own is that the Node suite can ask for the
   string and compare it, byte for byte, with what the renderer draws for the
   same board.

   The camera is not computed here. `update` already works out the fit, pan and
   zoom, so the view's whole
   job is to turn `model.camera` into a transform.
   ============================================================ */

import { renderSVG } from '../../../../src/render/render.js';
import type { Board, Chapter } from '../../../../src/board/state.js';
import type { View } from '../../../../src/board/camera.js';
import { currentSurface, type Model } from '../app/model.js';

/* board.html: `renderSVG(board, { margin: MARGIN, active: board.active, hand: false })`.
   The margin is the old page's MARGIN, and `hand: false` is the live board's
   filter-free drawing. Two boards served side by side have to ask the renderer
   for the same picture, so this is the one number both pages read. */
export const STAGE_MARGIN = 18;

export type StageRender = ReturnType<typeof renderSVG>;

/* The renderer takes a whole board. A finished chapter is a surface — every
   field the renderer reads, and none of the ones it does not — so reading one
   hands it a board carrying the chapter-level fields it never looks at. */
function wholeBoard(surface: Board | Chapter): Board {
  return 'log' in surface
    ? surface
    : { ...surface, chapter: '', chapters: [], log: [], rev: 0 };
}

/**
 * The drawing for whatever surface is on screen, or `null` for a board with
 * nothing on it yet — which is the `.blank` invitation, not an empty drawing.
 */
export function stageRender(model: Model): StageRender | null {
  const surface = currentSurface(model);
  if (!surface || !surface.nodes.length) return null;
  return renderSVG(wholeBoard(surface), {
    margin: STAGE_MARGIN,
    active: surface.active,
    hand: false,
  });
}

/** `model.camera.view`, as the transform board.html's `applyView()` writes. */
export const panTransform = (view: View): string =>
  `translate(${view.x}px,${view.y}px) scale(${view.k})`;

/** The transition `fit()` uses: smooth when the board moved itself, none when
    the reader did. */
export const panTransition = (smooth: boolean): string =>
  smooth ? 'transform .45s cubic-bezier(.3,.7,.3,1)' : 'none';
