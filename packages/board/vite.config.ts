/* ============================================================
   The board page's build — two of them, from one set of sources.

   `vite build` writes the page every board opens: one self-contained file,
   assembled by tools/board.js out of what lands in dist/src/board. `vite build
   --ssr` writes dist/support/board-view.js, which is how the Node suite renders
   the same components with react-dom/server and reads the stage's SVG back out.
   A suite that imported the view's source could not: the suites run inside
   dist/ under plain node, with no transform in front of them (ADR 0002), and
   node does not read JSX.

   Three things here are load-bearing rather than taste:

   The stylesheet is packages/board/board.css, injected into the page's <head>
   rather than imported from a module, so the page and an export of it carry
   it in a plain <style> that is there before the bundle runs.

   The suite's fixture board arrives as ops, baked in at build time. Only the
   server-side render reads it — the page itself connects to its board — and
   `specToOps` is not what carries it, because that module imports settle.js
   and would pull @dagrejs/dagre into the bundle.

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

/* board.css, injected into the page's <head>. `order: 'pre'` so the style
   lands before Vite rewrites the document's script and link tags. */
const boardStylesheet = (): Plugin => ({
  name: 'spiega:board-stylesheet',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      const style = `<style>${read('packages/board/board.css')}</style>`;
      if (!html.includes(MARKER)) throw new Error(`index.html has no ${MARKER} to replace`);
      return html.replace(MARKER, style);
    },
  },
});

export default defineConfig(({ isSsrBuild }) => ({
  root: here,
  /* Relative, so the built page works from a file:// URL — an export is this
     page opened off disk — as well as from a board's own URL. */
  base: './',
  // Vite's dev server refuses to read above its root without being told.
  server: { fs: { allow: [repo] } },
  define: { __SPIEGA_FIXTURE_OPS__: fixtureOps() },
  plugins: isSsrBuild ? [] : [boardStylesheet()],
  build: isSsrBuild
    ? {
        ssr: 'src/view/ssr.tsx',
        outDir: path.join(repo, 'dist/support'),
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: 'board-view.js' } },
      }
    : {
        outDir: path.join(repo, 'dist/src/board'),
        emptyOutDir: false,
        // One stylesheet and one chunk: tools/board.js inlines both, and fails
        // loudly rather than quietly shipping a page that fetches what it lost.
        cssCodeSplit: false,
        modulePreload: false,
        assetsDir: '.',
        rollupOptions: { output: { entryFileNames: 'board.js' } },
      },
}));
