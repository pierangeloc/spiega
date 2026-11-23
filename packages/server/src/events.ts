import { Effect, PubSub, Stream } from 'effect';
import type { BoardSnapshot, SavingStatus } from './store.js';

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface Revision {
  readonly seq: number;
  readonly frame: string;
}

export interface BoardEvents {
  readonly viewers: number;
  readonly pending: number;
  readonly publish: (event: 'patch' | 'replay', data: unknown) => void;
  readonly close: () => void;
  readonly stream: (
    board: () => BoardSnapshot,
    saving: () => SavingStatus,
  ) => Stream.Stream<Uint8Array>;
}

export const createBoardEvents = (): BoardEvents => {
  // A slow tab must not hold up POST /op or leave an unbounded backlog of
  // full board snapshots. If it falls behind, let EventSource reconnect.
  const revisions = Effect.runSync(PubSub.sliding<Revision | null>(16));
  let seq = 0;
  let viewers = 0;
  const encoder = new TextEncoder();

  return {
    get viewers() { return viewers; },
    get pending() { return PubSub.sizeUnsafe(revisions); },
    publish(event, data) {
      if (viewers === 0) return;
      // The reducer mutates the board in place. Freeze the wire payload now,
      // not when a subscriber catches up and the board has moved on.
      // The sliding strategy never waits; publishUnsafe would bypass it.
      Effect.runSync(PubSub.publish(revisions, { seq: ++seq, frame: frame(event, data) }));
    },
    close() { PubSub.endUnsafe(revisions, null); },
    stream: (board, saving) => Stream.unwrap(Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => { viewers++; }),
        () => Effect.sync(() => { viewers--; }),
      );
      const subscription = yield* PubSub.subscribe(revisions);

      // Subscribe before reading the snapshot so there is no gap at connect.
      // Every connection starts fresh; old patch and replay events aren't replayed.
      const initial = seq;
      const stateFrame = frame('state', board());
      const savingFrame = frame('saving', saving());
      let expected = initial + 1;
      const updates = Stream.fromSubscription(subscription).pipe(
        Stream.filter((item) => item === null || item.seq > initial),
        Stream.takeWhile((item): item is Revision => item !== null && item.seq === expected++),
        Stream.map((item) => item.frame),
        Stream.merge(
          Stream.tick('25 seconds').pipe(Stream.drop(1), Stream.as(': ping\n\n')),
          { haltStrategy: 'left' },
        ),
      );
      return Stream.make(stateFrame, savingFrame).pipe(
        Stream.concat(updates),
        Stream.map((text) => encoder.encode(text)),
      );
    })),
  };
};
