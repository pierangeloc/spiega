/* Harness only: server.mjs is the suite and it runs unchanged. */
import { test } from 'vitest';

test('server.mjs', () => import('./server.mjs'));
