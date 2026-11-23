/* ============================================================
   The ops, defined once.

   Until now an op's shape lived in two places that could not check each other:
   prose in docs/vocabulary.md, and the reducer's switch. An agent that got one
   wrong was told `not an op` or nothing at all, mid-sentence, with no path to
   the field that was wrong — and the thing about being mid-sentence is that
   there is no second chance to ask. This is the definition both the server and
   the MCP tool schemas read, so what an agent is told and what the board
   accepts cannot drift.

   Three decisions worth knowing before changing anything here.

   **Discriminated on `op`, not on `_tag`.** Effect's default would have been a
   second spelling of the same field, and every op log already on disk, every
   skill, every example and every integration says `op`. The wire format does
   not move.

   **Refuse what would draw nothing; describe the rest.** The reducer
   deliberately draws a kind it has no glyph for as a service box and warns,
   rather than refusing an op in the middle of somebody talking — a wrong
   outline beats a missing one, and there is no second chance to ask. So `kind`
   is a string with the known kinds in its description, where a model will read
   them, and not a literal union that would turn today's warning into a
   refusal. Numeric strings are accepted wherever the reducer reads a number
   through `Number()`, for the same reason.

   Three things are refused here that the board used to accept and then do
   nothing about, which is the failure this file exists to end: an `edge`
   missing either end, a `remove` naming nothing, and a `flow` whose `steps`
   are not a list — that last one emptied the flow in silence. Each of them
   returned `ok` to an agent that had drawn nothing.

   **Extra fields survive.** `node` and `edge` spread whatever they are given
   onto the board, and the renderer reads fields this file does not name.
   Decoding would strip them, so the server validates and passes the original
   object on. Nothing here is a filter.
   ============================================================ */

import { Schema } from 'effect';

/* A cell, as a settled board freezes it. Finite rather than Int: the reducer
   asks only for finiteness, and a half-column is a layout the renderer can
   draw. */
const Cell = Schema.Struct({ col: Schema.Finite, row: Schema.Finite });

/* The waypoints a settled long edge keeps, so a restore and a browser replay
   show the same lanes without loading dagre. */
const Waypoints = Schema.Array(Cell);

const Ids = Schema.Array(Schema.String);

const str = Schema.optionalKey(Schema.String);

/* A number, or the string an agent sends instead of one. The reducer reads
   these through `Number()`, so `"3"` has always worked and a schema that
   refused it would lose a line of somebody's script to pedantry. */
const Num = Schema.Union([Schema.Finite, Schema.String]).annotate({
  description: 'a number; a numeric string is accepted',
});
const num = Schema.optionalKey(Num);

/* The step a line or a hop is about. `null` is how a tag is taken back, and
   the rail reads it as "tied to nothing". */
const StepRef = Schema.optionalKey(Schema.NullOr(Num));

const KINDS = 'service, gateway, datastore, queue, cache, client, external, ' +
  'compute, note, formula, field, blob, vessel, particle, source';

/* One struct per op, in the order docs/vocabulary.md lists them, because that
   table and this file are the same document said twice and a reader will have
   one of them open beside the other. */

const NodeFields = {
  id: str,
  label: str,
  sub: str,
  /* Any string. A kind with no glyph is drawn as a service and warned about,
     which is the reducer's decision and not this file's to overturn. */
  kind: Schema.optionalKey(Schema.String.annotate({ description: `one of: ${KINDS}` })),
  lines: Schema.optionalKey(Ids.annotate({ description: 'lines of text, not ids' })),
  body: Schema.optionalKey(Schema.String.annotate({
    description: 'body colour: tomato, mustard, mint, cobalt, blush, slate, linen or paper',
  })),
  // Layout hints. `col` and `row` win over everything; `place` is relative.
  col: num,
  row: num,
  place: Schema.optionalKey(Schema.String.annotate({
    description: 'relative placement: right-of:<id>, left-of:<id>, above:<id>, below:<id>',
  })),
  // Measured from the words unless given. Undocumented, and real.
  w: num,
  h: num,
  // Per-kind decoration: stacked boxes, slots and how many are filled, the
  // notched corner of a field, the colour of the body.
  replicas: num,
  slots: num,
  depth: num,
  notch: Schema.optionalKey(Schema.String.annotate({ description: 'left or right' })),
  tint: str,
};

const NodeOp = Schema.Struct({ op: Schema.Literal('node'), ...NodeFields });

/* Handwriting in the margin. The same fields: the reducer runs both through
   one branch and forces the kind, so a `note` carrying a `kind` is not an
   error, it is simply overruled. */
const NoteOp = Schema.Struct({ op: Schema.Literal('note'), ...NodeFields });

const EdgeOp = Schema.Struct({
  op: Schema.Literal('edge'),
  /* Required, where the rest of this file is permissive. An edge missing
     either end used to be dropped in silence — no error, no line, and nothing
     to tell the agent which of its arrows never arrived. */
  from: Schema.String,
  to: Schema.String,
  label: str,
  async: Schema.optionalKey(Schema.Boolean),
  // The older spelling of `async: true`, and the only value read.
  style: Schema.optionalKey(Schema.String.annotate({ description: 'async' })),
  /* A badge number written on this arrow, overriding the flow's own
     numbering. Undocumented, and the renderer reads it. */
  step: StepRef,
  via: Schema.optionalKey(Waypoints),
  bend: Schema.optionalKey(Schema.String.annotate({ description: 'straight, to route it as drawn' })),
});

const BoundaryOp = Schema.Struct({
  op: Schema.Literal('boundary'),
  id: str,
  label: str,
  members: Schema.optionalKey(Ids),
});

const CalloutOp = Schema.Struct({
  op: Schema.Literal('callout'),
  id: str,
  at: str,
  label: str,
  /* A preference, not a command: the renderer may put it somewhere else, and
     an unrecognised side becomes `below` rather than an error. */
  side: Schema.optionalKey(Schema.String.annotate({
    description: 'above, below, left, right, above-left, above-right, below-left, below-right — ' +
      'or the compass letters n, s, e, w, ne, nw, se, sw',
  })),
  wrap: num,
});

/* A hop of the flow. `step` is what is drawn in the tag, which is a label and
   not an index — a hop numbered `2a` is somebody's perfectly good
   explanation. */
const StepFields = {
  edge: str,
  step: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  lights: Schema.optionalKey(Ids),
  group: str,
  label: str,
  /* Written onto the live flow by the renderer as it numbers the hops, and
     re-emitted inside a `flow` op when a long board is compacted — so a log
     this schema has to read back carries them. */
  _n: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  _i: num,
};

const StepOp = Schema.Struct({ op: Schema.Literal('step'), ...StepFields });

const GroupOp = Schema.Struct({
  op: Schema.Literal('group'),
  id: Schema.String,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const FlowOp = Schema.Struct({
  op: Schema.Literal('flow'),
  /* A flow replaces every hop at once. Anything but a list of them used to
     empty the flow quietly, which is the loudest thing on the board
     disappearing without a word. */
  steps: Schema.optionalKey(Schema.Array(Schema.Struct(StepFields))),
});

const SayOp = Schema.Struct({
  op: Schema.Literal('say'),
  text: str,
  step: StepRef,
  edge: str,
});

const TagOp = Schema.Struct({
  op: Schema.Literal('tag'),
  // Which line: counted from 1 as the rail shows them, or found by its words.
  line: num,
  match: str,
  /* `null`, `false` and `"off"` all take a tag back. Three spellings because
     the op is a correction and a correction is typed in a hurry. */
  step: Schema.optionalKey(Schema.Union([Num, Schema.Null, Schema.Boolean]).annotate({
    description: 'the step, counting from 1; null, false or "off" unties the line',
  })),
  edge: str,
});

const TitleOp = Schema.Struct({ op: Schema.Literal('title'), text: str });

const FocusOp = Schema.Struct({ op: Schema.Literal('focus'), step: StepRef });

const RemoveOp = Schema.Struct({
  op: Schema.Literal('remove'),
  // Required for the reason edge's ends are: a remove with no id removed
  // nothing and said nothing.
  id: Schema.String,
});

const ClearOp = Schema.Struct({
  op: Schema.Literal('clear'),
  keepTitle: Schema.optionalKey(Schema.Boolean),
});

const ChapterOp = Schema.Struct({ op: Schema.Literal('chapter'), title: str });

const SettleOp = Schema.Struct({
  op: Schema.Literal('settle'),
  /* Optional, because the two spellings arrive at the same route. An agent
     asks for a settle with a bare `{"op":"settle"}` and never writes
     coordinates; `applySettlingOps` resolves that into the recorded answer
     before the reducer sees it, which is why a log carries positions and a
     request does not. The reducer refuses a bare one for exactly that reason,
     and it is right to — by then it should have been resolved. */
  positions: Schema.optionalKey(Schema.Record(Schema.String, Cell)),
  routes: Schema.optionalKey(Schema.Record(Schema.String, Waypoints)),
});

/* Ops aimed at a chapter already taught.

   The ops it carries are checked one at a time rather than as a union here,
   and `reasonFor` below is where that happens. Two reasons, and both are about
   what the agent is told. A union's complaint about one bad inner op is a list
   of the sixteen members it is not, which is a wall of JSON where a field name
   was wanted. And an inner op that is *shaped* perfectly well may still be
   refused for being the wrong kind of thing to put in an amendment — `title`
   and `clear` are about the whole explanation — which is the reducer's rule,
   stated there in a sentence worth keeping. So this says only what an
   amendment looks like from the outside; its contents are somebody else's
   sentence to finish. */
const Payload = Schema.Record(Schema.String, Schema.Unknown);

const AmendOp = Schema.Struct({
  op: Schema.Literal('amend'),
  chapter: Schema.optionalKey(Schema.Union([Num, Schema.String]).annotate({
    description: 'the chapter: its number on the strip, counting from 1, or its exact title',
  })),
  ops: Schema.optionalKey(Schema.Union([Payload, Schema.Array(Payload)])),
});

/* The members by the name they go by on the wire. One table rather than a
   bare union, because an op that names itself can be checked *as that op*: a
   union mismatch can only list every member it is not, which for seventeen
   members is a wall of JSON where a model needed one field name. */
export const OPS = {
  node: NodeOp,
  note: NoteOp,
  edge: EdgeOp,
  boundary: BoundaryOp,
  callout: CalloutOp,
  step: StepOp,
  group: GroupOp,
  flow: FlowOp,
  say: SayOp,
  tag: TagOp,
  title: TitleOp,
  focus: FocusOp,
  remove: RemoveOp,
  chapter: ChapterOp,
  amend: AmendOp,
  clear: ClearOp,
  settle: SettleOp,
} as const;

export const OP_NAMES = Object.keys(OPS) as (keyof typeof OPS)[];

/** Every op there is. The type the board, the reducer and the tools all speak. */
export const Op = Schema.Union(Object.values(OPS));
export type Op = typeof Op.Type;

/* Compiled once, here, rather than per request: these are on the critical path
   of somebody talking. A guard is ~0.1 µs, against a 200 µs budget for the
   whole of POST /op, and the message — which allocates and formats — is built
   only for an op that is actually wrong. */
const guards = new Map(OP_NAMES.map(name => [name, Schema.is(OPS[name])] as const));
const decoders = new Map(OP_NAMES.map(name => [name, Schema.decodeUnknownResult(OPS[name])] as const));

/* Why an op cannot be drawn, or null when it can.

   Silent about anything that is not an op at all: a value with no string `op`
   is the reducer's to refuse, and it says it well — `applyOps` promises never
   to throw on input and that promise is where the sentence belongs. This
   answers the question the reducer cannot: which field, and what was expected
   there instead. */
export const reasonFor = (op: unknown): string | null => {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return null;
  const name = (op as { op?: unknown }).op;
  if (typeof name !== 'string') return null;

  const guard = guards.get(name as keyof typeof OPS);
  if (!guard) return `unknown op "${name}": the vocabulary has ${OP_NAMES.join(', ')}`;

  /* An amendment's own shape says nothing about the ops it carries — see
     Payload — so each of them is asked the same question here, before the
     amendment is judged as a whole. An inner op the Schema has no complaint
     about may still be refused by the reducer for being the wrong kind of
     thing to amend with, and that sentence is the reducer's to say. */
  if (name === 'amend') {
    const inner = (op as { ops?: unknown }).ops;
    const list = inner == null ? [] : Array.isArray(inner) ? inner : [inner];
    for (const [i, one] of list.entries()) {
      const why = reasonFor(one);
      if (why) return `amend: ops[${i}] — ${why}`;
    }
  }

  if (guard(op)) return null;

  const result = decoders.get(name as keyof typeof OPS)!(op);
  // Effect puts the path on its own indented line. One line, because this ends
  // up in a JSON array an agent reads in a terminal.
  const why = result._tag === 'Failure'
    ? result.failure.message.replace(/\s*\n\s*/g, ' ')
    : 'it does not match its own shape';
  return `${name}: ${why}`;
};
