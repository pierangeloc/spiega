/* ============================================================
   The board, defined once.

   op.ts says what an agent may send. This says what the reducer holds after it
   has been sent: one explanation, its finished chapters beside it, and the log
   that can rebuild either. The two are not the same document — an op is a
   sentence and a board is what the sentences have added up to — but they share
   a vocabulary, so what they share is imported rather than said twice.

   Two decisions worth knowing before changing anything here.

   **Mutable, deliberately.** `applyOp` writes to the board in place and sweeps
   removals, because `POST /op` is on the critical path of somebody talking and
   there is a benchmark holding it to 0.2 ms per op. Effect hands out readonly
   types, which would describe a board nobody here has, so the types below are
   mapped through `Mutable` — see mutable.ts for why that is one named type and
   not a readonly stripped off at each use.

   **As permissive as the reducer, and no more.** A node is spread onto the
   board with whatever fields its op carried — the renderer reads some this
   file does not name, and `col` arrives as `"3"` often enough that the op
   schema accepts it — so the structs here describe the fields that are read
   and let the rest travel. Nothing in this file is a filter either.

   Its runtime importers are the tests and whatever decodes a board from
   outside the process. The reducer names these types through `import type`,
   which is erased: `effect` must never reach the board page's import graph.
   ============================================================ */

import { Schema } from 'effect';

import { Cell, Num } from './op.js';
import type { Mutable } from './mutable.js';

const Ids = Schema.Array(Schema.String);
const Waypoints = Schema.Array(Cell);

const str = Schema.optionalKey(Schema.String);

/* A number, and a number on the board specifically.

   op.ts accepts `"3"` where a number is wanted, because an agent writing JSON
   by hand sends one and losing a box to pedantry is the worse failure. What it
   does not do is convert it — nothing in a validator should — so the reducer
   does, as the op lands. The board therefore holds the number it has always
   claimed to hold, which is what the layout needs: it does arithmetic on these
   fields, and `"3" + 1` is `"31"`. */
const num = Schema.optionalKey(Schema.Finite);

/* Where a settled board has frozen each box. Sticky: a node redrawn later
   keeps the column it was given, which is what stops a board reflowing under
   the person reading it. */
export const Placed = Schema.Record(Schema.String, Cell);

/* A thing drawn on the board. Only `id` is always there: the reducer fills it
   in from the label when the op left it out. `kind` it also always sets, but
   the type does not insist — settle.js builds node-shaped values of its own to
   hand to dagre, and a layout does not need to know what a box looks like. */
export const Node = Schema.Struct({
  id: Schema.String,
  kind: str,
  label: str,
  sub: str,
  body: str,
  col: num,
  row: num,
  place: str,
  w: num,
  h: num,
  lines: Schema.optionalKey(Ids),
  slots: num,
  depth: num,
  replicas: num,
  notch: str,
  members: Schema.optionalKey(Ids),
  tint: str,
});

/* A hop an arrow carries after its first: its words and its badge. */
export const Stop = Schema.Struct({
  label: str,
  step: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

/* Keyed by its two ends, and still only by them: a conversation between two
   boxes over time — request, then poll, then write back — is one arrow
   carrying several stops (#113). `label` and `step` are the first hop, as
   they always were, so anything that has never heard of stops still reads
   the arrow it always read; `then` is every hop after it, in order. */
export const Edge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  label: str,
  step: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  then: Schema.optionalKey(Schema.Array(Stop)),
  async: Schema.optionalKey(Schema.Boolean),
  style: str,
  bend: str,
  via: Schema.optionalKey(Waypoints),
});

export const Boundary = Schema.Struct({
  id: Schema.String,
  label: str,
  members: Schema.optionalKey(Ids),
  tint: str,
});

export const Callout = Schema.Struct({
  id: Schema.String,
  at: str,
  label: str,
  side: str,
  wrap: num,
});

/* A hop of the flow. The step names its group and never the other way round:
   the log is append-only and step indices renumber the moment one is inserted,
   while a key does not.

   `_n` and `_i` are the renderer's own, written onto the live flow as it
   numbers the hops. They are here because a compacted board re-emits them
   inside a `flow` op, so a log this file has to read back carries them. */
export const FlowStep = Schema.Struct({
  edge: str,
  lights: Schema.optionalKey(Ids),
  label: str,
  group: str,
  /* Not an index: what is drawn in the tag, and a hop numbered `2a` is
     somebody's perfectly good explanation. */
  step: Schema.optionalKey(Num),
  _n: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  _i: num,
});

/* A line of the script. `step` counts from 0 here; the op vocabulary counts
   from 1, because that is the number shown on the board. */
export const TranscriptLine = Schema.Struct({
  text: Schema.String,
  at: Schema.Finite,
  step: Schema.optionalKey(Schema.Finite),
  edge: str,
});

/* The log is the ops themselves, plus the moment they arrived. Loose on
   purpose: anything an op carries has to survive a replay back to the board,
   so the fields the walk in script.js reads are named and everything else
   rides along untouched. */
export const LogEntry = Schema.StructWithRest(
  Schema.Struct({
    op: Schema.String,
    at: Schema.optionalKey(Schema.Finite),
    step: Schema.optionalKey(Schema.Union([Num, Schema.Null, Schema.Boolean])),
    edge: str,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/* One drawing surface: everything a board held before chapters existed. A
   finished chapter is exactly this, set aside whole, which is why the renderer
   and the rail take one without knowing chapters are a thing. */
const surface = {
  nodes: Schema.Array(Node),
  edges: Schema.Array(Edge),
  boundaries: Schema.Array(Boundary),
  flow: Schema.Array(FlowStep),
  callouts: Schema.Array(Callout),
  transcript: Schema.Array(TranscriptLine),
  /* group id -> the name to show for it. A phase of the explanation is named
     by its own op, which may land before or after the steps that join it, so
     the names live beside the flow rather than inside it. */
  groups: Schema.Record(Schema.String, Schema.String),
  active: Schema.NullOr(Schema.Finite),
  placed: Placed,
  settled: Schema.Boolean,
};

export const Chapter = Schema.Struct({ title: Schema.String, ...surface });

/* The board is one explanation. Its current chapter lives directly on it —
   `nodes`, `edges` and the rest, where they have always been — and the
   chapters it has finished sit beside it in `chapters`, in the order they were
   taught. One title names the explanation; `chapter` names the surface being
   drawn on now. */
export const Board = Schema.Struct({
  title: Schema.String,
  chapter: Schema.String,
  chapters: Schema.Array(Chapter),
  ...surface,
  /* Every op, in the order it arrived. A board is a session, not a diagram, so
     the order the explanation went in is part of what it holds. */
  log: Schema.Array(LogEntry),
  rev: Schema.Finite,
});

export type Placed = Mutable<typeof Placed.Type>;
export type Placement = Mutable<typeof Cell.Type>;
export type Node = Mutable<typeof Node.Type>;
export type Stop = Mutable<typeof Stop.Type>;
export type Edge = Mutable<typeof Edge.Type>;
export type Boundary = Mutable<typeof Boundary.Type>;
export type Callout = Mutable<typeof Callout.Type>;
export type FlowStep = Mutable<typeof FlowStep.Type>;
export type TranscriptLine = Mutable<typeof TranscriptLine.Type>;
export type LogEntry = Mutable<typeof LogEntry.Type>;
export type Chapter = Mutable<typeof Chapter.Type>;
export type Board = Mutable<typeof Board.Type>;

/* Is this still a board? The question the property tests ask after a few
   hundred generated ops, and the reason this file is a Schema rather than a
   page of interfaces: the invariant is checked against the same definition the
   types come from, so a board that drifts from its own shape cannot pass by
   having been described twice. */
export const isBoard = Schema.is(Board);
