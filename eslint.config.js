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
   imports exist on disk, and that nothing it reaches is settle.js or dagre. */

// Brought in for its parser, not for its rule sets: nothing here extends
// typescript-eslint's recommended configs. ESLint has no TypeScript of its own,
// and a rule asked of a file it cannot parse is a rule that is not running.
import tseslint from 'typescript-eslint';

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

/* The same rule, said in the one dialect that can tell a type import from a
   value one. `import type { Op } from '@spiega/core'` is erased at compile
   time: nothing is fetched, so it cannot blank the board, and it is what lets
   a browser-side module speak the typed domain while `effect` stays out of the
   page's import graph. Core ESLint cannot see the distinction — it has no
   TypeScript to look at — and would fail every ported module for naming a type
   it is allowed to name. `allowTypeImports` is the whole reason this duplicate
   exists; a value import of the same specifier still fails, identically. */
const browserSafeTs = {
  'no-restricted-imports': 'off',
  '@typescript-eslint/no-restricted-imports': ['error', {
    patterns: [{ regex: UNFETCHABLE, allowTypeImports: true, message: `a browser cannot resolve this — ${WHY}` }],
  }],
  'no-restricted-syntax': browserSafe['no-restricted-syntax'],
};

/* Where the browser rule applies, as directories rather than as globs, because
   it is now asked twice of the same places: of the JavaScript by the core rule,
   and of the TypeScript it is being ported into by the rule above. Two lists
   would drift, and the half that drifted would be the one nobody notices — a
   directory silently outside the rule reads exactly like one inside it. */
const BROWSER_SAFE = [
  // The typed packages are browser-safe by definition: they are what the render
  // port is moving src/render into, and the page will import them.
  'packages/core/**', 'packages/render/**',
  // All of src/render — every file there is pure today, audit.ts included, even
  // though the page does not reach it.
  'src/render/**',
  // src/board is covered wholesale rather than by a list of the seven modules
  // board.html imports, so that the next browser-side module is covered by
  // having been written. The cost is that a new node-side one fails until it is
  // named below, which is the direction worth failing in.
  'src/board/**',
];

// One glob per directory per extension. A brace list would read better and
// would be wrong: `*.{ts}`, with a single alternative, matches nothing at all
// through ESLint's matcher, and a block that matches nothing turns every rule
// in it off without saying so.
/** @param {...string} exts */
const files = (...exts) => BROWSER_SAFE.flatMap(dir => exts.map(e => `${dir}/*.${e}`));

export default [
  {
    // dist/ is a copy — the JavaScript is assembled into it byte-for-byte — so
    // linting it says nothing the source tree has not already said, and a stale
    // build would report a file you have already fixed.
    ignores: ['dist/**', '.agents/**'],
  },
  {
    /* Every .ts file in the repository, browser-safe or not, so that one is
       parsed as TypeScript at all. Without this the rules below do not fail on
       a bad import — they fail on `Parsing error: Unexpected token`, which is
       the rule not running, dressed as the rule running. No rules are turned on
       here: this block exists to make the ones that follow legible to it. */
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
  },
  {
    files: files('js', 'mjs'),
    rules: browserSafe,
  },
  {
    // Last of the browser-safe blocks, so it replaces the core rule for the
    // ported modules wherever both would match.
    files: files('ts'),
    rules: browserSafeTs,
  },
  {
    // The node side (JavaScript). These run only in the server process, and the
    // board page must never reach them.
    files: [
      'src/board/log.js',
      'src/board/server.js',
    ],
    rules: nodeSide,
  },
  {
    // The node side (TypeScript). `settle.ts` imports `@dagrejs/dagre`, which
    // runs only in the server process — a test in smoke.mjs still asserts that
    // the board page never reaches settle.js or dagre. The other three read
    // files and start processes: the export reads the page and its modules off
    // disk, the snapshot inlines the icon, and open runs the window Effects in
    // packages/server/src/window.ts, which start a browser.
    files: ['src/board/settle.ts', 'src/board/export.ts', 'src/board/open.ts', 'src/board/snapshot.ts'],
    rules: { ...nodeSide, '@typescript-eslint/no-restricted-imports': 'off' },
  },
  {
    /* The Schema, which is the one thing in a browser-safe package that the
       browser must not reach — not because it is node-only code, but because
       `import { Schema } from 'effect'` is a bare specifier, and the page
       fetches what it imports off disk. The schema union is defined once and
       read by the server at POST /op and by MCP when it advertises its tools,
       both of which are node; the page speaks the same domain through type
       imports, which cost nothing at runtime.

       This is the deliberate naming the config asks for rather than a widened
       glob, and it is bounded by a test: the walk in smoke.mjs that keeps the
       page away from dagre keeps it away from here too. When the board is
       bundled (#153) the bundler resolves `effect` and this block goes. */
    files: ['packages/core/src/schema/**/*.ts'],
    // Both spellings off: the TypeScript rule is the one in force for a `.ts`
    // file, and the core one is what the blocks above it left behind.
    rules: { ...nodeSide, '@typescript-eslint/no-restricted-imports': 'off' },
  },
];
