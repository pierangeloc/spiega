/* ============================================================
   A tiny store and a server-free fixture store for the board app.

   `createStore` is deliberately shaped for React's `useSyncExternalStore`
   (`getSnapshot`, `subscribe`, `dispatch`) without importing React, so the
   same store works in Node tests, in a React view, or swapped for Foldkit.

   `createFixtureStore` drives the model/update loop in memory with no HTTP
   server, no SSE stream, and no wall-clock timers. When `update` emits a
   `postOps` command, the fixture store applies those ops to its local board
   through the real `applyOps` reducer and feeds the resulting snapshot back
   as `stateReceived`. Everything else is recorded in `cmds` so tests can
   assert on every command the app emitted.
   ============================================================ */

import { applyOps, emptyBoard, type Board, type Op } from '../../../../src/board/state.js';
import type { Cmd } from './cmd.js';
import { cloneBoard, init, type InitOptions, type Model } from './model.js';
import type { Msg } from './msg.js';
import { update } from './update.js';

export type CmdRunner = (cmd: Cmd, dispatch: (msg: Msg) => readonly Cmd[]) => void;

export type BoardStore = {
  getSnapshot(): Model,
  subscribe(listener: () => void): () => void,
  dispatch(msg: Msg): readonly Cmd[],
};

export function createStore(initial: Model, runCmd?: CmdRunner): BoardStore {
  let model = initial;
  const listeners = new Set<() => void>();

  const dispatch = (msg: Msg): readonly Cmd[] => {
    const [next, cmds] = update(model, msg);
    if (next !== model) {
      model = next;
      for (const listener of listeners) listener();
    }
    if (runCmd) {
      for (const cmd of cmds) runCmd(cmd, dispatch);
    }
    return cmds;
  };

  return {
    getSnapshot: () => model,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch,
  };
}

export type FixtureStoreOptions = {
  readonly board?: Board,
  readonly ops?: readonly Op[],
  readonly init?: InitOptions,
  readonly hash?: string,
  readonly runCmd?: CmdRunner,
};

export type FixtureStore = BoardStore & {
  /** Every command emitted since creation (or since the last `clearCmds`). */
  readonly cmds: readonly Cmd[],
  clearCmds(): void,
  /** Simulate ops arriving from an agent over SSE. */
  apply(ops: readonly Op[], options?: { readonly amended?: readonly number[] }): void,
  /** Deterministically advance the silent flow timer by one tick. */
  stepFlow(): readonly Cmd[],
  /** Deterministically advance replay by one entry. */
  stepReplay(): readonly Cmd[],
  /** Simulate the narrator starting and finishing the current section. */
  completeCurrentSection(): void,
};

export function createFixtureStore(options: FixtureStoreOptions = {}): FixtureStore {
  const fixtureBoard: Board = options.board ? cloneBoard(options.board) : emptyBoard();
  if (options.ops?.length) {
    applyOps(fixtureBoard, [...options.ops]);
  }

  const emitted: Cmd[] = [];
  const store = createStore(init(options.init), (cmd, dispatch) => {
    emitted.push(cmd);
    if (cmd.type === 'postOps') {
      const result = applyOps(fixtureBoard, [...cmd.ops]);
      dispatch({
        type: 'stateReceived',
        board: cloneBoard(fixtureBoard),
        fresh: result.fresh,
      });
    }
    options.runCmd?.(cmd, dispatch);
  });

  if (options.board || options.ops) {
    store.dispatch({
      type: 'stateReceived',
      board: cloneBoard(fixtureBoard),
      full: true,
      hash: options.hash,
    });
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    dispatch: store.dispatch,
    get cmds() { return emitted; },
    clearCmds() { emitted.length = 0; },

    apply(ops, applyOptions) {
      const result = applyOps(fixtureBoard, [...ops]);
      store.dispatch({
        type: 'stateReceived',
        board: cloneBoard(fixtureBoard),
        fresh: result.fresh,
        amended: applyOptions?.amended,
      });
    },

    stepFlow: () => store.dispatch({ type: 'flowTick' }),
    stepReplay: () => store.dispatch({ type: 'replayStep' }),

    completeCurrentSection() {
      const m = store.getSnapshot();
      const i = m.playback.tapeIndex;
      if (i < 0 || i >= m.playback.tape.length) return;
      store.dispatch({ type: 'narrateSectionStarted', index: i });
      store.dispatch({ type: 'narrateSectionEnded', index: i });
      const after = store.getSnapshot();
      if (after.playback.tapePlaying && i + 1 < after.playback.tape.length) {
        store.dispatch({ type: 'narrateSectionStarted', index: i + 1 });
      }
    },
  };
}
