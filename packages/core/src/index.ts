/* The typed domain, for the modules that may not run the Schema.

   Types only, and that is the point: `board.html` imports the reducer off disk
   and a browser cannot fetch `effect`, so a module the page reaches names the
   domain through `import type { Board } from '@spiega/core'` — erased at
   compile time, nothing fetched, no board left blank. The Schemas themselves
   are imported by path, by the server and the tests, which are allowed to
   have a runtime (see eslint.config.js).

   Values go in here only once something browser-safe needs one. */

export type {
  Op,
} from './schema/op.js';

export type {
  Board,
  Boundary,
  Callout,
  Chapter,
  Edge,
  FlowStep,
  LogEntry,
  Node,
  Placed,
  Placement,
  Stop,
  TranscriptLine,
} from './schema/board.js';
