/* ============================================================
   spiega open — put the board in a real window.

   The work is in packages/server/src/window.ts, as Effects. This is the door
   the CLI and the MCP server still walk through: plain functions, with the
   signatures they have always had but for one change (#186, below), each
   running its Effect against this machine.

   A browser that cannot be started used to throw whatever `spawn` threw. It
   no longer does: `openBoard` and `showBoard` report a failed launch as
   `{ ok: false, how }`, the same shape `focusBoard` already answered with for
   "no window to raise", so every caller already has one pattern to check
   rather than two. The CLI and MCP server are those callers (#186's "command
   boundary"); each decides for itself how to say `how` and what to exit with.
   The fix itself — not crashing on a browser that vanishes between the check
   and the launch — lives in `Desktop.live.launch` (window.ts), underneath
   both halves here, so `focusBoard`'s callers (unchanged by #158) get it too.

   `Effect.runPromise`, not `Effect.runSync`, because launching is: see the
   comment on `Desktop.live.launch` in window.ts.
   ============================================================ */

import { Effect, Layer } from 'effect';
import { SpiegaHome } from '../../packages/server/src/config.js';
import { LaunchFailed, NoBoardWindow, messageOf } from '../../packages/server/src/errors.js';
import {
  BoardWindows,
  Desktop,
  findChromium as findChromiumEffect,
  focusBoard as focusBoardEffect,
  liveWindows,
  noteOpened as noteOpenedEffect,
  notRaisedHow,
  openBoard as openBoardEffect,
  openedAt as openedAtEffect,
  showBoard as showBoardEffect,
  type BoardWindowsShape,
  type Found,
  type OpenOptions,
} from '../../packages/server/src/window.js';

export { BROWSER_APPS, runningBrowsers } from '../../packages/server/src/window.js';
export type { Found, OpenOptions } from '../../packages/server/src/window.js';

const machine = Layer.mergeAll(Desktop.live, SpiegaHome.layer);

const run = <A>(effect: Effect.Effect<A, never, Desktop | SpiegaHome>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(machine)));

/* What a caller says when the browser it tried is the one gone — named, so
   the CLI and the MCP tool report the same sentence rather than each writing
   their own. */
export const launchFailedHow = (e: LaunchFailed): string => `could not start ${e.cmd}: ${messageOf(e.cause)}`;

/* Find a Chromium-family browser that can do app mode, or null. Never
   launches anything, so it cannot hit #186 and stays on `Effect.runSync`. */
export const findChromium = (preferred: string | null = null): Found | null =>
  Effect.runSync(findChromiumEffect(preferred).pipe(Effect.provide(Desktop.live)));

export type Opened = { ok: true, how: string, app: boolean } | { ok: false, how: string };

/* Open `url` and report how — or that the browser it tried is gone (#186),
   rather than throwing. `app: false`, or no Chromium anywhere, falls back to
   the default browser. */
export const openBoard = (url: string, opts: OpenOptions = {}): Promise<Opened> =>
  run(openBoardEffect(url, opts).pipe(
    Effect.map((r): Opened => ({ ok: true, how: r.how, app: r.app })),
    Effect.catchTag('LaunchFailed', (e) => Effect.succeed<Opened>({ ok: false, how: launchFailedHow(e) })),
  ));

export type Focused = { ok: boolean, how: string };

export const focusBoard = (name: string, url: string): Promise<Focused> =>
  run(focusBoardEffect(name, url).pipe(
    Effect.map((r): Focused => ({ ok: true, how: r.how })),
    Effect.catch((e) => Effect.succeed({ ok: false, how: notRaisedHow(e) })),
  ));

export const openedAt = (name: string): Promise<number> => run(openedAtEffect(name));

export function noteOpened(name: string, when: number = Date.now()): Promise<void> {
  return run(noteOpenedEffect(name, when));
}

export type ShowOptions = OpenOptions & {
  focus?: (name: string, url: string) => Focused,
  open?: (url: string, opts: OpenOptions) => { how: string, app: boolean },
  opened?: (name: string) => number,
  note?: (name: string) => void,
};
export type Shown =
  | (Focused & { raised: true })
  | { ok: true, how: string, app: boolean, raised: false }
  | { ok: false, how: string, raised: false };

/* Raise the window this board is already in, or make one — see showBoard in
   window.ts for why. The halves can be handed in, so the decision can be
   tested without a browser or a window server (test/smoke.mjs); each one
   handed in replaces its live counterpart and goes through the same Effect.
   A thrown `open` half is still a defect here (`Effect.try`), not a #186
   case: it is a test double standing in for the window server, not the real
   `child_process.spawn`. */
export function showBoard(url: string, name: string, { app = true, size = null, pos = null, browser = null,
                                                       focus, open, opened, note }: ShowOptions = {}): Promise<Shown> {
  const windows = Layer.effect(BoardWindows, Effect.map(liveWindows, (live): BoardWindowsShape => ({
    focus: focus
      ? (n, u) => Effect.suspend(() => {
        const r = focus(n, u);
        return r.ok ? Effect.succeed({ how: r.how }) : Effect.fail(new NoBoardWindow({ name: n }));
      })
      : live.focus,
    open: open
      ? (u, o) => Effect.try({ try: () => open(u, o), catch: (cause) => new LaunchFailed({ cmd: 'open', cause }) })
      : live.open,
    opened: opened ? (n) => Effect.sync(() => opened(n)) : live.opened,
    note: note ? (n) => Effect.sync(() => note(n)) : live.note,
  })));
  return run(showBoardEffect(url, name, { app, size, pos, browser }).pipe(
    Effect.provide(windows),
    Effect.map((r): Shown => r.raised
      ? { ok: true, how: r.how, raised: true }
      : { ok: true, how: r.how, app: r.app, raised: false }),
    Effect.catchTag('LaunchFailed', (e) => Effect.succeed<Shown>({ ok: false, how: launchFailedHow(e), raised: false })),
  ));
}
