/* ============================================================
   The view, as the Node suite sees it.

   `vite build --ssr` writes this to dist/support/board-view.js, which is how
   test/react-board.mjs renders these components without a browser: the suites
   run inside dist/ under plain node, with no transform in front of them (ADR
   0002), and node does not read JSX.

   The stage mounts a string, so the string the page would mount can be
   compared — byte for byte — with what the renderer draws for the same board
   and the same options. Everything else about a board looking right is a
   screenshot and an opinion; this part is an equality.
   ============================================================ */

import { renderToStaticMarkup } from 'react-dom/server';

import type { BoardStore } from '../app/store.js';
import { App } from './App.js';

export { fixtureStore } from './fixture.js';
export { connectLive, readFollow, runBrowserCommand, settleBoard } from './browser.js';
export { InkMemory } from './ink-memory.js';
export { STAGE_MARGIN, stageRender } from './drawing.js';

export const renderBoard = (store: BoardStore): string =>
  renderToStaticMarkup(<App store={store} />);
