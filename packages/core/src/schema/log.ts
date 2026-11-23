/* ============================================================
   Reading an op log back.

   A board is its log, and the logs on people's disks were written by every
   version of spiega there has been. Restore used to hand them straight to the
   reducer, which is forgiving enough that a shape the Schema now refuses still
   drew — and the day the Schema is put in front of restore, every such log
   would stop restoring and the explanation in it would be gone.

   So an old shape is *upgraded*, in one place, before it is judged. Each entry
   of MIGRATIONS takes an op as one version wrote it and returns it as the next
   reads it; the Schema then says whether what comes out is an op at all. A log
   has no version header — appended lines cannot carry one without every
   writer agreeing on it — so a migration has to be safe to run on an op that
   is already current, and returns it untouched when there is nothing to do.

   What is not an upgrade is a failure. An op nothing here knows how to read is
   most likely from a spiega newer than this one, and skipping it would draw a
   board with a hole in it that nobody was told about. It stops the restore,
   with a sentence naming the board and the field.

   Node-side, with the rest of the Schema: it imports `op.ts`, which imports
   effect.
   ============================================================ */

import { reasonFor, type Op } from './op.js';

type Raw = Record<string, unknown>;

export interface Migration {
  /** What the next version reads. Only ever appended to. */
  readonly version: number;
  readonly name: string;
  readonly up: (op: Raw) => Raw;
}

/* A `node` or `note` that says `sub: null`. Some earlier writer sent null for
   "no subtitle" and the reducer spread it onto the board, where the renderer
   treats it as absent — so it is absent here, which draws the same board. */
const dropNullSub = (op: Raw): Raw => {
  if ((op.op !== 'node' && op.op !== 'note') || op.sub !== null) return op;
  const { sub: _sub, ...rest } = op;
  return rest;
};

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'a null sub is no sub', up: dropNullSub },
];

/** The shape this build writes, and the newest it can read. */
export const LOG_VERSION = MIGRATIONS.length;

const isRaw = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/* Amendments carry ops of their own, written in the same years as the log
   around them. */
const upgrade = (op: Raw): Raw => {
  let out = op;
  for (const m of MIGRATIONS) out = m.up(out);
  if (out.op === 'amend' && out.ops != null) {
    const inner = out.ops;
    if (Array.isArray(inner)) {
      const next = inner.map(o => (isRaw(o) ? upgrade(o) : o));
      if (next.some((o, i) => o !== inner[i])) out = { ...out, ops: next };
    } else if (isRaw(inner)) {
      const next = upgrade(inner);
      if (next !== inner) out = { ...out, ops: next };
    }
  }
  return out;
};

/** A log that cannot be read, said so a person can act on it. */
export class LogError extends Error {
  readonly board: string;
  readonly index: number;
  constructor(board: string, index: number, total: number, why: string) {
    super(
      `the log for board "${board}" cannot be read: op ${index + 1} of ${total} — ${why}. ` +
      'It may have been written by a newer spiega; upgrade spiega, or move the log aside to start the board afresh.',
    );
    this.name = 'LogError';
    this.board = board;
    this.index = index;
  }
}

/** The ops of a log, upgraded to the current shape and checked against the Schema. */
export const decodeLog = (board: string, ops: ReadonlyArray<Raw>): Op[] => {
  const out: Op[] = [];
  for (const [i, raw] of (ops as ReadonlyArray<unknown>).entries()) {
    // `reasonFor` leaves a value with no string `op` to the reducer, whose
    // errors a restore throws away — so here it would draw nothing, silently.
    if (!isRaw(raw)) throw new LogError(board, i, ops.length, 'it is not an object');
    if (typeof raw.op !== 'string') throw new LogError(board, i, ops.length, 'missing a string "op" field');
    const op = upgrade(raw);
    const why = reasonFor(op);
    if (why) throw new LogError(board, i, ops.length, why);
    // The Schema validates and the original object goes on, because extra
    // fields survive (see op.ts).
    out.push(op as unknown as Op);
  }
  return out;
};
