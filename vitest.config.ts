/* The runner, and nothing else. ADR 0002 decided the suites are not rewritten
 * for it: every `test/*.mjs` beside this still asserts with node:assert and
 * still runs on its own with `node dist/test/settle.mjs`. What vitest adds is
 * a name per suite, a summary, and a process per file.
 *
 * Three decisions worth keeping:
 *
 * The files under test are the built ones. `include` points at dist/ because
 * that is the package people install — the same reason `pnpm test` builds
 * first. The `.spec.mjs` files in the repository's own test/ are the sources
 * of those; they are never collected, because vitest treats a filename on the
 * command line as a filter over `include` rather than as another file to run.
 * There is therefore no way to run one of these against src/ by accident.
 *
 * Suites are not run in parallel. Each one reassigns HOME at import and the
 * state directory is read from it once, so they already needed a process each
 * — that part vitest gives us for nothing, one worker per file. But two of
 * them are clocks: persist.mjs holds POST /op to a p99 budget and audit.mjs to
 * a median, and a budget measured while three other suites render boards on
 * the same machine is measuring the machine. Serial is how they passed before
 * this change, so serial is what they keep.
 *
 * The timeout is per suite, not per assertion. A suite is one vitest test
 * here, and smoke.mjs alone is a few seconds of rendering, child processes and
 * git repositories in temp directories; five seconds would fail the harness
 * rather than the code.
 *
 * test/readable.mjs has no spec beside it on purpose: it asserts nothing. It
 * is the terminal end of the audit and a module smoke.mjs imports. A suite
 * that does assert and loses its spec is caught in smoke.mjs, which checks
 * that every file in test/ importing node:assert has one.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['dist/test/**/*.spec.mjs'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ['verbose'],
    /* A suite narrates itself — an `ok` line per check and a count at the end
       — and 258 of those is not a test report. Kept for a suite that fails,
       where the line before the error is which board it had got to. */
    silent: 'passed-only',
    /* Everything in dist/ is loaded by node, not put through the runner's
       transform. The artefact is finished code — it is what a user's node
       imports — and transforming it on the way in would mean the suite asserts
       against something nobody installs. */
    server: { deps: { external: [/[\\/]dist[\\/]/] } },
  },
});
