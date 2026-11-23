/* ============================================================
   The op log's writer: a queue on the request path, a fiber off it.

   `POST /op` is on the critical path of somebody talking. What it does with an
   op that has landed is `push`, which puts it in an in-process queue and
   returns; nothing on the way is awaited and nothing touches the disk. A
   separate fiber wakes when the first op arrives, waits out the debounce so a
   burst becomes one write, and appends the batch. A hard crash may lose the
   last tick of ops, which is the trade a whiteboard is allowed to make.

   The file itself — the lock, the append, the compaction — is `LogFile`, which
   src/board/log.js provides. This module decides when to call it and what to do
   when it throws, and never does I/O of its own.

   A write that fails does not fail anything that asked for it. The batch is
   kept and tried again on the next tick, so the board keeps drawing, and the
   failure is said on the board by `onStatus` — the CLI cannot carry it, since
   by the time anyone runs a command the explanation is already gone.
   ============================================================ */

import { Effect, Fiber, Queue, Semaphore } from 'effect';
import { LOG_CAP, type Op } from './board.js';
import { LogWriteError, messageOf } from './errors.js';

export interface LogFile {
  readonly file: string;
  /** Whether this process holds the board's file; a second server must not write beside it. */
  readonly owner: boolean;
  /** Lines in the file now, which is what compaction is decided on. */
  readonly lines: number;
  readonly append: (ops: ReadonlyArray<Op>) => Promise<void>;
  readonly compact: () => Promise<void>;
  readonly release: () => void;
}

export interface OpLogOptions {
  readonly debounce?: number;
  /** Called when writing starts failing and when it recovers; read `failure` for which. */
  readonly onStatus?: () => void;
}

export interface OpLogHandle {
  readonly file: string;
  readonly owner: boolean;
  /** Why the last write failed, until one succeeds. */
  readonly failure: string | null;
  /** The request path. Synchronous, and the only thing a request may call. */
  readonly push: (ops: ReadonlyArray<Op>) => void;
  /** Write what is queued now, rather than when the timer gets to it. */
  readonly flush: Effect.Effect<void>;
  /** Flush, stop the fiber and let go of the lock. */
  readonly close: Effect.Effect<void>;
}

export const makeOpLog = (
  file: LogFile,
  { debounce = 100, onStatus }: OpLogOptions = {},
): Effect.Effect<OpLogHandle> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Op>();
    const turn = yield* Semaphore.make(1);
    // Ops taken off the queue and not yet written: the batch a failed write retries.
    let held: Array<Op> = [];
    let failure: string | null = null;
    let closed = false;
    let warnedCompact = false;

    const setFailure = (next: string | null) =>
      Effect.sync(() => {
        const changed = (failure === null) !== (next === null);
        failure = next;
        if (!changed) return;
        if (next !== null) console.error(`spiega: could not write ${file.file}: ${next}`);
        else console.error(`spiega: writing ${file.file} again`);
        try {
          onStatus?.();
        } catch (e) {
          console.error(`spiega: could not announce the log's state: ${messageOf(e)}`);
        }
      });

    const write = (batch: ReadonlyArray<Op>) =>
      Effect.tryPromise({
        try: () => file.append(batch),
        catch: (e) => new LogWriteError({ file: file.file, message: messageOf(e) }),
      });

    const compact = Effect.tryPromise({
      try: () => file.compact(),
      catch: (e) => new LogWriteError({ file: file.file, message: messageOf(e) }),
    }).pipe(
      Effect.catchTag('LogWriteError', (e) =>
        Effect.sync(() => {
          if (warnedCompact) return;
          warnedCompact = true;
          console.error(`spiega: could not compact ${e.file}: ${e.message}`);
        }),
      ),
    );

    const drain = turn.withPermits(1)(
      Effect.gen(function* () {
        const more = yield* Queue.clear(queue);
        if (more.length) held = held.length ? held.concat(more) : more;
        if (!held.length) return;
        const batch = held;
        const wrote = yield* write(batch).pipe(
          Effect.as(true),
          Effect.catchTag('LogWriteError', (e) => setFailure(e.message).pipe(Effect.as(false))),
        );
        if (!wrote) return;
        held = [];
        yield* setFailure(null);
        // Only when the file has passed the cap and nothing is waiting: a
        // snapshot taken while ops are still queued would write them twice.
        if (file.lines > LOG_CAP && Queue.sizeUnsafe(queue) === 0) yield* compact;
      }),
    );

    /* The fiber. Parked on the queue while there is nothing to write, so an
       idle board costs no timer; the first op wakes it, the debounce batches
       what follows, and a failed batch is retried on the same beat. */
    const loop = Effect.forever(
      Effect.gen(function* () {
        if (!held.length) {
          const got = yield* Queue.takeAll(queue);
          held = held.concat(got);
        }
        yield* Effect.sleep(debounce);
        // Not interruptible: a write that is interrupted still lands, and the
        // batch that was kept to retry would then be written twice.
        yield* Effect.uninterruptible(drain);
      }),
    );
    const fiber = yield* Effect.forkDetach(loop);

    const close = Effect.gen(function* () {
      if (closed) return yield* turn.withPermits(1)(Effect.void);
      closed = true;
      yield* Fiber.interrupt(fiber);
      yield* Effect.uninterruptible(drain);
      file.release();
    });

    return {
      get file() {
        return file.file;
      },
      get owner() {
        return file.owner;
      },
      get failure() {
        return failure;
      },
      push(ops) {
        if (closed || !file.owner) return;
        Queue.offerAllUnsafe(queue, ops);
      },
      flush: Effect.uninterruptible(drain),
      close,
    };
  });

/* The same thing for a caller that is not in an Effect, which is every
   caller in src/board/server.js: a log is made the moment a board is held. */
export interface OpLog {
  readonly file: string;
  readonly owner: boolean;
  readonly failure: string | null;
  readonly push: (ops: ReadonlyArray<Op>) => void;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export const createOpLog = (file: LogFile, options: OpLogOptions = {}): OpLog => {
  const log = Effect.runSync(makeOpLog(file, options));
  return {
    get file() {
      return log.file;
    },
    get owner() {
      return log.owner;
    },
    get failure() {
      return log.failure;
    },
    push: log.push,
    flush: () => Effect.runPromise(log.flush),
    close: () => Effect.runPromise(log.close),
  };
};
