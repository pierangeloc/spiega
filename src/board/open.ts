/* ============================================================
   spiega open — put the board in a real window.

   The work is in packages/server/src/window.ts, as Effects. This is the door
   the CLI and the MCP server still walk through: plain functions, with the
   signatures they have always had, each running its Effect synchronously
   against this machine. When those callers move onto Effect (#158 for the
   CLI), they call window.ts directly and this file goes.

   A throw stays a throw. A browser that cannot be started was an exception
   from `spawn` before, and it is the same exception now, not an Effect
   wrapper around it.
   ============================================================ */

import { Effect, Layer } from 'effect';
import { SpiegaHome } from '../../packages/server/src/config.js';
import { LaunchFailed, NoBoardWindow } from '../../packages/server/src/errors.js';
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
  type Opened,
} from '../../packages/server/src/window.js';

export { BROWSER_APPS, runningBrowsers } from '../../packages/server/src/window.js';
export type { Found, OpenOptions, Opened } from '../../packages/server/src/window.js';

const machine = Layer.mergeAll(Desktop.live, SpiegaHome.layer);

const run = <A>(effect: Effect.Effect<A, LaunchFailed, Desktop | SpiegaHome>): A =>
  Effect.runSync(effect.pipe(
    Effect.catchTag('LaunchFailed', (e) => Effect.die(e.cause)),
    Effect.provide(machine),
  ));

/* Find a Chromium-family browser that can do app mode, or null. */
export const findChromium = (preferred: string | null = null): Found | null =>
  run(findChromiumEffect(preferred));

/* Open `url` and return how it was opened, so the caller can say so.
   `app: false`, or no Chromium anywhere, falls back to the default browser. */
export const openBoard = (url: string, opts: OpenOptions = {}): Opened =>
  run(openBoardEffect(url, opts));

export type Focused = { ok: boolean, how: string };

export const focusBoard = (name: string, url: string): Focused =>
  run(focusBoardEffect(name, url).pipe(
    Effect.map((r): Focused => ({ ok: true, how: r.how })),
    Effect.catch((e) => Effect.succeed({ ok: false, how: notRaisedHow(e) })),
  ));

export const openedAt = (name: string): number => run(openedAtEffect(name));

export function noteOpened(name: string, when: number = Date.now()): void {
  run(noteOpenedEffect(name, when));
}

export type ShowOptions = OpenOptions & {
  focus?: (name: string, url: string) => Focused,
  open?: (url: string, opts: OpenOptions) => Opened,
  opened?: (name: string) => number,
  note?: (name: string) => void,
};
export type Shown = (Focused & { raised: true }) | (Opened & { raised: false });

/* Raise the window this board is already in, or make one — see showBoard in
   window.ts for why. The halves can be handed in, so the decision can be
   tested without a browser or a window server (test/smoke.mjs); each one
   handed in replaces its live counterpart and goes through the same Effect. */
export function showBoard(url: string, name: string, { app = true, size = null, pos = null, browser = null,
                                                       focus, open, opened, note }: ShowOptions = {}): Shown {
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
  const shown = run(showBoardEffect(url, name, { app, size, pos, browser }).pipe(Effect.provide(windows)));
  return shown.raised
    ? { ok: true, how: shown.how, raised: true }
    : { how: shown.how, app: shown.app, raised: false };
}
