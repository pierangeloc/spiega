/* Harness only: persist.mjs is the suite and it runs unchanged. This gives it a
   name of its own in the run and, because vitest forks per file, the process
   it has always needed. See vitest.config.ts. */
import { test } from 'vitest';

test('persist.mjs', () => import('./persist.mjs'));
