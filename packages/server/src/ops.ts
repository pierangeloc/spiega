/* ============================================================
   What a write does to a board, apart from how it arrives.

   Both functions are synchronous on purpose, and they are what the p99
   benchmark in test/persist.mjs times: the per-op work of `POST /op`, without
   the HTTP in front of it. A write, an await, or a scan put back into either
   one fails that suite. The route in routes.ts wraps them in an Effect; they
   do not need one, and an Effect on a path measured in microseconds would be
   a cost with nothing bought.
   ============================================================ */

import { reasonFor } from '../../core/src/schema/op.js';
import { applyOps, applySettlingOps, settleOp, type Board, type Chapter } from './board.js';
import type { BoardEntry } from './store.js';

/* What the batch is split into: what can be drawn, and why the rest cannot.

   A refused op is dropped rather than passed on: every one of these would have
   been refused by the reducer too, or — the three the Schema is stricter about
   — would have been accepted and drawn nothing. What it must not do is take
   the rest of the batch down with it. Half an explanation on the board beats
   none, and the reply names what is missing.

   Anything that is not an op at all goes through untouched, for the reducer to
   refuse: `applyOps` promises never to throw on input, and it says that one
   well already. */
const screen = (ops: unknown): { ops: Array<unknown>; errors: Array<string> } => {
  const list: ReadonlyArray<unknown> = Array.isArray(ops) ? ops : [ops];
  const kept: Array<unknown> = [];
  const errors: Array<string> = [];
  for (const op of list) {
    const why = reasonFor(op);
    if (why) errors.push(why);
    else kept.push(op);
  }
  /* Always a list, even where one op came in: a single op refused would
     otherwise leave `undefined` in its place, and the reducer would answer a
     question nobody asked by refusing that too. */
  return { ops: kept, errors };
};

const field = (v: unknown, key: string): unknown =>
  v !== null && typeof v === 'object' ? Reflect.get(v, key) : undefined;

/* The chapter a number names, counting from one as the strip does. The last
   number is the chapter being drawn on, which lives on the board itself. */
const surfaceOf = (board: Board, n: unknown): Chapter | null =>
  board.chapters[Number(n) - 1] || null;

export interface Drawn {
  readonly status: 200 | 207;
  readonly reply: Readonly<Record<string, unknown>> & { readonly warnings: ReadonlyArray<string> };
  /** What an audit, if one was asked for, is a measurement of. */
  readonly surface: Board | Chapter;
  /** That surface's number on the strip, counting from one. */
  readonly chapter: number;
  /** Whether the batch cleared the board, so nothing measured before it is
      a measurement of what is on it now. */
  readonly cleared: boolean;
  readonly wantsAudit: boolean;
}

/* Apply a batch to the board, hand what landed to the log and the stream, and
   say what happened. The body is whatever the client sent, `null` included:
   even reading `ops.ops` is here, because applyOps refuses what it can see is
   wrong and this is for what it cannot, so a malformed batch still costs one
   request rather than the process. A throw is the caller's to turn into a
   500. */
export const draw = (entry: BoardEntry, body: unknown): Drawn => {
  const { board } = entry;
  /* Decoded against the op Schema before the reducer sees any of it, so a
     field that is wrong comes back named — `edge: Missing key at ["to"]`, not
     `not an op`. The agent is mid-sentence and gets one reply; it has to be
     able to fix the op from what the reply says.

     The ops that pass go on untouched rather than decoded: node and edge
     spread whatever they carry onto the board, the renderer reads fields the
     Schema does not name, and decoding would quietly strip them. */
  const batch = field(body, 'ops');
  const screened = screen(body && batch ? batch : body);
  const result = applySettlingOps(board, screened.ops as Parameters<typeof applySettlingOps>[1]);
  const { fresh, warnings, applied } = result;
  const errors = [...screened.errors, ...result.errors];
  /* No file I/O and no await here: the ops go into the log's queue and the
     flush happens on its own fiber. This is on the critical path of somebody
     talking. */
  if (applied.length) entry.log?.push(applied);
  /* Which chapters moved, for the windows whose reader is somewhere else: a
     tab that changed quietly behind someone is the thing chapters are meant to
     prevent. */
  const amended = applied.flatMap((o) => (o.op === 'amend' ? [o.chapter] : []));
  entry.events.publish('patch', { board, fresh, amended });
  /* A warning is not a refusal: the op landed, and the status says so. It rides
     back on the same response because the agent that drew the box is listening
     to exactly one thing, and only until its next turn.

     An amendment was aimed at a chapter, so that is the chapter the reply is
     about: counting the one being drawn on would answer a question nobody
     asked, in the same breath as the answer to the one they did. */
  const last = amended[amended.length - 1];
  const aimed = amended.length ? surfaceOf(board, last) : null;
  return {
    status: errors.length ? 207 : 200,
    reply: {
      ok: !errors.length, errors, warnings, rev: board.rev,
      nodes: board.nodes.length, edges: board.edges.length, steps: board.flow.length,
      viewers: entry.events.viewers,
      ...(aimed ? {
        amended: {
          chapter: last, title: aimed.title ?? board.chapter,
          nodes: aimed.nodes.length, edges: aimed.edges.length, steps: aimed.flow.length,
        },
      } : {}),
    },
    surface: aimed || board,
    chapter: aimed ? Number(last) : board.chapters.length + 1,
    cleared: applied.some((o) => o.op === 'clear'),
    wantsAudit: !!(body && field(body, 'audit')),
  };
};

/* Narration begins in the browser, but the handover belongs in the same server
   log as an agent's explicit settle, not just in that one window. */
export const settle = (entry: BoardEntry): void => {
  const { board } = entry;
  if (board.settled || !board.nodes.length) return;
  const { fresh, errors, applied } = applyOps(board, settleOp(board));
  if (errors.length) throw new Error(errors.join('; '));
  entry.log?.push(applied);
  entry.events.publish('patch', { board, fresh });
};
