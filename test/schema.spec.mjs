/* Harness only: schema.mjs is the suite and it runs unchanged. This gives it a
   name of its own in the run. See vitest.config.ts. */
import { test } from 'vitest';

test('schema.mjs', () => import('./schema.mjs'));
