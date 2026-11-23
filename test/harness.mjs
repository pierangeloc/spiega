/* What a `.spec.mjs` is, in one place.

   ADR 0002 keeps the suites as they are: each `test/*.mjs` asserts with
   node:assert and still runs on its own under plain node. A spec beside it
   gives it a name in the run and, because vitest forks per file, the process it
   has always needed.

   The part that is not just a name: **a suite reports a failed check by setting
   `process.exitCode`, not by throwing.** A bare `import()` resolves anyway, so
   for most of this project's life vitest reported a failing suite as passing —
   fifteen of sixteen specs were blind, and a real failure in persist.mjs sat on
   main through several green CI runs. Reading the exit code is the whole
   difference, and it lives here so that a new suite cannot be wired up without
   it.

   This module asserts nothing itself and is not collected: `include` in
   vitest.config.ts is `*.spec.mjs`. */
import { expect, test } from 'vitest';

/** Collect one node:assert suite as a vitest test, exit code and all. */
export const suite = name =>
  test(name, async () => {
    await import(`./${name}`);
    expect(process.exitCode ?? 0, `a check in ${name} failed; its output is above`).toBe(0);
  });
