import { defineConfig } from 'tsdown';

/* The TypeScript half of the build. tools/build.js assembles the package and
 * calls this for whatever under src/ has been ported.
 *
 * It is an *unbundled* build, and that is not a style preference. The board
 * page imports the renderer off disk as plain modules — `/src/render/render.js`
 * — and the server hands those files to the browser one at a time, so a
 * bundle would leave the page importing a URL that no longer exists. Every
 * module therefore comes out as its own file, at the path it has in src/, with
 * its import specifiers intact.
 *
 * `.js` specifiers are left alone for the same reason the JavaScript is copied
 * rather than compiled: a ported module sits beside the modules it has not
 * replaced yet, and it must find them exactly where they have always been.
 */
export default defineConfig({
  entry: ['src/**/*.ts'],
  outDir: 'dist/src',
  format: 'esm',
  platform: 'node',
  unbundle: true,
  deps: {
    // The JavaScript that has not been ported, and dagre, which is vendored
    // outside src/ and used once at settle. Both are files in the artefact
    // already; the specifier pointing at them is correct as written.
    neverBundle: [/\.js$/],
  },
  // The page asks for `.js`. rolldown would otherwise write `.mjs`.
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  sourcemap: false,
  // tools/build.js owns dist/ and has already emptied it and copied the assets
  // in by the time this runs.
  clean: false,
  report: false,
});
