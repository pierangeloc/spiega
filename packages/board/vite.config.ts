/* ============================================================
   The React board's build — two of them, from one set of sources.

   `vite build` writes the page people open: one self-contained file, assembled
   by tools/next.js out of what lands in dist/src/next. `vite build --ssr`
   writes dist/support/board-view.js, which is how the Node suite renders the
   same components with react-dom/server and reads the stage's SVG back out.
   A suite that imported the view's source could not: the suites run inside
   dist/ under plain node, with no transform in front of them (ADR 0002), and
   node does not read JSX.

   Three things here are load-bearing rather than taste:

   The stylesheet is the old page's stylesheet, lifted out of board.html at
   build time instead of copied into this directory. Two boards served side by
   side have to look the same, and this repository's rule is replace, don't
   duplicate — a second copy of 330 lines of CSS would start drifting the first
   time either page was touched. #156 inverts this when board.html goes.

   The fixture board arrives as ops, baked in at build time. The page draws a
   board with no server behind it, so something has to carry one; `specToOps`
   is not what carries it, because that module imports settle.js and would pull
   @dagrejs/dagre into a page that never settles anything.

   The whole of React is a devDependency, and stays one: it is bundled into an
   asset that ships inside dist/, so the published package still declares the
   two runtime dependencies it has always declared.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

import { specToOps } from '../../src/spec.js';
import type { BoardSpec } from '../../src/spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

/** The board the page draws. Any spec under examples/ or test/boards/ works. */
const FIXTURE = 'examples/kalman.json';

const read = (file: string): string => fs.readFileSync(path.join(repo, file), 'utf8');

/* The one cast in this file. A spec on disk is unknown data, and the board it
   describes is checked the only way that matters here: the page draws it, and
   the suite renders the same ops through the same reducer. */
const fixtureOps = (): string => JSON.stringify(specToOps(JSON.parse(read(FIXTURE)) as BoardSpec));

const MARKER = '<!--spiega:stylesheet-->';

/* board.html's <style> block, injected into this page's <head>. `order: 'pre'`
   so the style lands before Vite rewrites the document's script and link tags.
   It runs in dev too, which is the point of doing it as a transform rather
   than as a step after the build: a dev server showing unstyled markup would
   be no use for the comparison this page exists to make. */
const inheritedStylesheet = (): Plugin => ({
  name: 'spiega:inherited-stylesheet',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      const style = /<style>[\s\S]*?<\/style>/.exec(read('src/board/board.html'));
      if (!style) throw new Error('src/board/board.html has no <style> block to inherit');
      if (!html.includes(MARKER)) throw new Error(`index.html has no ${MARKER} to replace`);
      return html.replace(MARKER, style[0]);
    },
  },
});

export default defineConfig(({ isSsrBuild }) => ({
  root: here,
  /* Relative, so the built page works from a file:// URL as well as from the
     server's /next route. The screenshots that judge this issue are taken off
     disk with no server running at all. */
  base: './',
  // Vite's dev server refuses to read above its root without being told.
  server: { fs: { allow: [repo] } },
  define: { __SPIEGA_FIXTURE_OPS__: fixtureOps() },
  plugins: isSsrBuild ? [] : [inheritedStylesheet()],
  build: isSsrBuild
    ? {
        ssr: 'src/view/ssr.tsx',
        outDir: path.join(repo, 'dist/support'),
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: 'board-view.js' } },
      }
    : {
        outDir: path.join(repo, 'dist/src/next'),
        emptyOutDir: true,
        // One stylesheet and one chunk: tools/next.js inlines both, and fails
        // loudly rather than quietly shipping a page that fetches what it lost.
        cssCodeSplit: false,
        modulePreload: false,
        assetsDir: '.',
        rollupOptions: { output: { entryFileNames: 'board.js' } },
      },
}));
