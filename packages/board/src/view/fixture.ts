/* ============================================================
   The board this page draws.

   No server, no stream, no timers: `createFixtureStore` drives the whole
   model/update loop in memory, applying the ops below through the real reducer
   exactly as a live board would. That is what makes this page screenshottable
   off disk, and what makes the Node suite able to render the same thing.

   The ops are baked in at build time — see vite.config.ts, which reads a spec
   from examples/ and converts it there rather than here, because `specToOps`
   reaches settle.ts and would pull @dagrejs/dagre into a page that settles
   nothing.

   Round #156 is what replaces this with the live board.
   ============================================================ */

import type { Op } from '../../../../src/board/state.js';
import { createFixtureStore, type CmdRunner, type FixtureStore } from '../app/store.js';
import type { InitOptions } from '../app/model.js';

declare const __SPIEGA_FIXTURE_OPS__: readonly Op[];

export function fixtureStore(railOpen: boolean, options: InitOptions = {}, runCmd?: CmdRunner): FixtureStore {
  return createFixtureStore({
    ops: __SPIEGA_FIXTURE_OPS__,
    init: {
      /* The truth about this page: there is no server behind it and no stream
         to be disconnected from, so the link dot reads connected-and-waiting
         instead of the board raising its not-connected banner. It is the same
         state an exported board opens in. */
      exported: true,
      railOpen,
      ...options,
    },
    runCmd,
  });
}
