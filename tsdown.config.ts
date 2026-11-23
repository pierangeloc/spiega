import fs from 'node:fs';
import { defineConfig } from 'tsdown';

/* The TypeScript half of the build. tools/build.js assembles the package and
 * calls this for whatever has been ported.
 *
 * TypeScript, and nothing had to be installed to read it: node strips types
 * on its own from 23.6, and the engines floor is 24. Below that tsdown falls
 * back to `unrun`, a loader it does not ship — which is one of the reasons
 * the floor is where it is.
 *
 * It is an *unbundled* build, and that is not a style preference. The board
 * page imports the renderer off disk as plain modules — `/src/render/render.js`
 * — and the server hands those files to the browser one at a time, so a
 * bundle would leave the page importing a URL that no longer exists. Every
 * module therefore comes out as its own file, at the path it has in the
 * repository, with its import specifiers intact.
 *
 * `.js` specifiers are left alone for the same reason the JavaScript is copied
 * rather than compiled: a ported module sits beside the modules it has not
 * replaced yet, and it must find them exactly where they have always been.
 */

/* One build per source root, rather than one build over every `.ts` in the
 * repository, because an unbundled build writes its outputs relative to the
 * deepest directory that contains all of its inputs. That root is inferred
 * from whichever files happen to exist, so a single build spanning src/ and
 * packages/ would write to different places on the day a port moves the last
 * file out of one of them — and the day the first module lands in packages/
 * would flatten everything already compiled under src/. A root per build
 * makes the mapping a property of the configuration instead of a property of
 * the file list. tools/build.js checks the paths that come out, because an
 * inference is still an inference.
 *
 * `packages/*` is read off disk: the five workspace packages are stubs today,
 * and a build for a package with no TypeScript in it yet is a build that
 * fails for having no entry.
 */
const roots = ['src', ...fs.globSync('packages/*/src')]
  .filter(dir => fs.globSync(`${dir}/**/*.ts`).length > 0);

export default defineConfig(roots.map(root => ({
  entry: [`${root}/**/*.ts`],
  outDir: `dist/${root}`,
  format: 'esm' as const,
  platform: 'node' as const,
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
})));
