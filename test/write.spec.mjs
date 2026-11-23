/* Harness only: write.mjs is the suite and it runs unchanged.

   One thing it adds to the idiom of its neighbours: a suite reports a failed
   check by setting process.exitCode, which a bare import would not notice, so a
   suite that failed would be reported by vitest as having passed. This one
   says so. */
import { expect, test } from 'vitest';

test('write.mjs', async () => {
  await import('./write.mjs');
  expect(process.exitCode ?? 0, 'a check in write.mjs failed; its output is above').toBe(0);
});
