/* ============================================================
   What can go wrong on the write routes and the routes that draw a board, and
   the response each one has always been.

   Each failure is a tagged error so the route can say once, in one place,
   which status and which body a client gets — the old server answered these
   inline, and its clients parse the answers, so the shapes below are not
   ours to improve. `reply` is that mapping.
   ============================================================ */

import { Data } from 'effect';
import { HttpServerResponse } from 'effect/http';
import { EXPECTED_JSON_ERROR } from './security.js';

export class BoardNotFound extends Data.TaggedError('BoardNotFound')<{
  readonly name: string;
}> {}

export class NotJson extends Data.TaggedError('NotJson') {}

/* The body was not JSON, or was not allowed to be read at all. */
export class InvalidJson extends Data.TaggedError('InvalidJson')<{
  readonly message: string;
}> {}

/* A throw out of the reducer, the settle pass, or the log handing-off.
   `applyOps` refuses everything it can see is wrong, so what reaches here is
   what it could not — and costs one request rather than the process. */
export class ApplyFailed extends Data.TaggedError('ApplyFailed')<{
  readonly message: string;
}> {}

/* A board that could not be drawn, on a route that draws one. One bad board
   must not stop the others: a render costs its own render, a 500 with the
   reason, while the rest of the server carries on. The door refuses the
   malformed ops a model actually writes (see state.ts), but state can also
   arrive from a log written before that, and this is what keeps it a broken
   picture rather than a dead server. */
export class RenderFailed extends Data.TaggedError('RenderFailed')<{
  readonly message: string;
}> {}

/* An export asked for a chapter the board does not have. */
export class NoSuchChapter extends Data.TaggedError('NoSuchChapter') {}

/* The log could not be written. Never a response: the ops are already on the
   board and the agent is mid-sentence, so this one is raised on the board
   itself (see oplog.ts) and never in reply to the request that happened to
   precede the flush. */
export class LogWriteError extends Data.TaggedError('LogWriteError')<{
  readonly file: string;
  readonly message: string;
}> {}

export const messageOf = (e: unknown): string => {
  const message = e !== null && typeof e === 'object' && 'message' in e ? e.message : undefined;
  return message ? String(message) : String(e);
};

type RouteError = BoardNotFound | NotJson | InvalidJson | ApplyFailed | RenderFailed | NoSuchChapter;

export const reply = (e: RouteError): HttpServerResponse.HttpServerResponse => {
  switch (e._tag) {
    case 'BoardNotFound':
      // "Gone", not "broken": it is what sends a client off to start a board.
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: `no board named "${e.name}"` },
        { status: 404 },
      );
    case 'NotJson':
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: EXPECTED_JSON_ERROR },
        { status: 415 },
      );
    case 'InvalidJson':
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: `invalid JSON: ${e.message}` },
        { status: 400 },
      );
    case 'ApplyFailed':
      // Its callers parse the answer, so a failed batch answers in the shape
      // they expect rather than as plain text they would choke on.
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: `spiega could not apply these ops: ${e.message}` },
        { status: 500 },
      );
    case 'RenderFailed':
      return HttpServerResponse.text(`spiega could not draw this board: ${e.message}\n`, {
        status: 500,
        contentType: 'text/plain; charset=utf-8',
      });
    case 'NoSuchChapter':
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: 'no such chapter' },
        { status: 400 },
      );
  }
};
