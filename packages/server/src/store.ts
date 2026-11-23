/* ============================================================
   Board store service — what the read routes read from.

   Keeping the store behind an Effect service lets the read routes run against
   the live board map in src/board/server.js today, against an Effect-native
   store once #148 lands, and against a lightweight in-memory store with a
   temp SpiegaHome layer in tests.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { SpiegaConfig, SpiegaHome } from './config.js';
import { createBoardEvents, type BoardEvents } from './events.js';

export interface BoardSnapshot {
  readonly rev: number;
  readonly nodes: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
}

export interface BoardEntry {
  readonly name: string;
  readonly board: BoardSnapshot;
  readonly viewers: number;
  readonly events: BoardEvents;
}

export interface SavedBoardInfo {
  readonly name: string;
  readonly file: string;
  readonly written: number;
}

export type SavingStatus =
  | { readonly saving: false; readonly why: 'memory' }
  | { readonly saving: false; readonly why: 'unwritable'; readonly file: string }
  | { readonly saving: false; readonly why: 'other-server'; readonly file: string }
  | { readonly saving: true; readonly file: string };

export interface BoardStoreShape {
  readonly get: (name: string) => BoardEntry | undefined;
  readonly reopen: (name: string, boardUrl: string) => BoardEntry | undefined;
  readonly listOpen: () => ReadonlyArray<BoardEntry>;
  readonly listSaved: () => ReadonlyArray<SavedBoardInfo>;
  readonly saving: (name: string) => SavingStatus;
}

/* Every persisted board log on disk, newest first. Deliberately only a
   readdir and a stat each — no board is restored by being listed. */
export const savedBoardsIn = (boardsDir: string): ReadonlyArray<SavedBoardInfo> => {
  let files: Array<string>;
  try {
    files = fs.readdirSync(boardsDir);
  } catch {
    return [];
  }
  const saved: Array<SavedBoardInfo> = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const file = path.join(boardsDir, f);
    let written = 0;
    try {
      written = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    saved.push({ name: f.slice(0, -'.jsonl'.length), file, written });
  }
  return saved.sort((a, b) => b.written - a.written);
};

export class BoardStore extends Context.Service<BoardStore, BoardStoreShape>()(
  '@spiega/server/BoardStore',
) {
  static readonly make = (store: BoardStoreShape): Layer.Layer<BoardStore> =>
    Layer.succeed(BoardStore, store);

  /* An in-memory store backed by SpiegaHome for saved-board discovery.
     Useful for tests that want to exercise the Effect read routes against a
     temp home layer without mutating process.env. */
  static readonly memory = (
    initial: Readonly<Record<string, BoardSnapshot>> = {},
  ): Layer.Layer<BoardStore, never, SpiegaHome | SpiegaConfig> =>
    Layer.effect(
      BoardStore,
      Effect.gen(function* () {
        const home = yield* SpiegaHome;
        const config = yield* SpiegaConfig;
        const entries = new Map<string, BoardEntry>();
        for (const [name, board] of Object.entries(initial)) {
          const events = createBoardEvents();
          entries.set(name, { name, board, get viewers() { return events.viewers; }, events });
        }
        return BoardStore.of({
          get: (name) => entries.get(name),
          reopen: () => undefined,
          listOpen: () => [...entries.values()],
          listSaved: () =>
            config.persist
              ? savedBoardsIn(home.boardsDir).filter((s) => !entries.has(s.name))
              : [],
          saving: (name) =>
            config.persist
              ? { saving: true, file: home.boardFile(name) }
              : { saving: false, why: 'memory' },
        });
      }),
    );
}
