// @ts-check
/* The browser rule, as a property of the files that have to satisfy it.

   `src/board/board.html` imports the renderer off disk, unbundled, so every
   module it can reach has to resolve in a browser. A `node:` builtin or a bare
   specifier in one of them takes the whole page down silently: the module graph
   never evaluates, no handler registers, and the board reads as empty while the
   server streams ops at a page that is not listening. Nothing throws, and node
   resolves `node:fs` perfectly well, so the suite stayed green through it once.

   This used to be a graph walk from board.html in test/smoke.mjs. It is a lint
   rule now because membership in a browser-safe package *is* reachability —
   there is no walk to do, only a question about each file — and because the
   walk ran over dist/, which is a copy. Two properties the walk also asserted
   are not about any one file and stayed in the suite: that the page's root
   imports exist on disk, and that nothing it reaches is vendor/ or settle.js. */

// Exactly the test the walk applied to every specifier it found: anything that
// does not start with `.` or `/` is something the page cannot fetch. That is
// `node:fs` and `dagre` alike, and one expression is why both are still caught
// by one rule — including `lodash/merge`, which a glob of bare names misses.
const UNFETCHABLE = '^[^./]';

// Said as a trailing clause so it reads either way round: the two rules below
// each put their own sentence in front of it.
const WHY = 'the board page loads these modules off disk, unbundled, so keep node-only code in a node-only module (see src/board/log.js)';

// `no-restricted-imports` reads static `import` and `export … from`, which is
// everything the walk looked at, but it does not see `import()`. A lazy
// `import('node:fs')` blanks the board exactly the same way, so the second rule
// reaches the one place the first cannot.
const browserSafe = {
  'no-restricted-imports': ['error', {
    patterns: [{ regex: UNFETCHABLE, message: `a browser cannot resolve this — ${WHY}` }],
  }],
  'no-restricted-syntax': ['error', {
    selector: `ImportExpression > Literal.source[value=/${UNFETCHABLE}/]`,
    message: `this dynamic import names something a browser cannot resolve — ${WHY}`,
  }],
};

const nodeSide = { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' };

export default [
  {
    // dist/ is a copy — the JavaScript is assembled into it byte-for-byte — so
    // linting it says nothing the source tree has not already said, and a stale
    // build would report a file you have already fixed. vendor/ is a
    // checked-in bundle nobody here edits.
    ignores: ['dist/**', 'vendor/**', '.agents/**'],
  },
  {
    // The typed packages are browser-safe by definition: they are what the
    // render port is moving src/render into, and the page will import them.
    files: ['packages/core/**/*.{js,mjs,ts}', 'packages/render/**/*.{js,mjs,ts}'],
    rules: browserSafe,
  },
  {
    // All of src/render — every file there is pure today, audit.js included,
    // even though the page does not reach it.
    files: ['src/render/**/*.js'],
    rules: browserSafe,
  },
  {
    // src/board is covered wholesale rather than by a list of the seven modules
    // board.html imports, so that the next browser-side module is covered by
    // having been written. The cost is that a new node-side one fails until it
    // is named below, which is the direction worth failing in.
    files: ['src/board/**/*.js'],
    rules: browserSafe,
  },
  {
    // The node side. These run only in the server process, and the board page
    // must never reach them — a test in smoke.mjs still asserts that for
    // settle.js, which is the one that evaluates dagre.
    files: [
      'src/board/export.js',
      'src/board/log.js',
      'src/board/open.js',
      'src/board/server.js',
      'src/board/settle.js',
      'src/board/snapshot.js',
    ],
    rules: nodeSide,
  },
];
