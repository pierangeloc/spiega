#!/usr/bin/env node
/* Assembles dist/ — the package people install.
 *
 * dist/ is not a folder inside the published package; it IS the published
 * package, root manifest and all, and `pnpm run pack` packs that directory.
 * The reason is the shape of the code it holds: every module finds its
 * neighbours by walking up from its own file — the server reads
 * `<root>/docs/logo/spiega-mark.svg` and serves `<root>/src/**` to the board
 * page, install copies `<root>/skills/spiega`, the CLI reads
 * `<root>/package.json` for its version. A build that dropped compiled modules
 * into a subdirectory of the package would move every one of those targets.
 * Keeping the artefact's layout identical to the repository's is what lets the
 * existing JavaScript, and the page's unbundled imports, carry on untouched.
 *
 * Two things this build deliberately does not do:
 *
 * It does not bundle. The board page imports modules off disk by URL, so they
 * have to stay separate files at their own paths.
 *
 * It does not put the JavaScript through the compiler. A module that already
 * runs on the engines floor has nothing to gain from being transpiled, and
 * plenty to lose: the compiler rewrites quotes, indentation and the order of
 * declarations, and parts of the suite read these files as text — which ops
 * the reducer's switch accepts, which paths install copies. Compiling them
 * bought nothing and broke those, so JavaScript is copied, byte for byte, and
 * only TypeScript is compiled. `allowJs` is what lets the two live together:
 * a ported module keeps importing the JavaScript it has not replaced yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const say = msg => { if (!process.argv.includes('--quiet')) console.log(msg); };

/* Copied as they are, because they are not code the build has an opinion
 * about: assets the server and the installer read at runtime, and the suite
 * and the picture tools, which run against the built artefact rather than
 * against src/ — see ADR 0002. What reaches npm is decided by `files` in the
 * manifest, not by this list.
 *
 * `packages/` is absent because there is nothing in it to copy: it is
 * TypeScript and the manifests of five workspace packages that are never
 * published on their own. compile() writes what the artefact needs.
 */
const ASSETS = [
  'src',           // minus the TypeScript, which is compiled over the top below
  'bin',           // the launcher; it execs src/cli.js next to it
  'skills',        // install copies these into agent config directories
  'integrations',
  'examples',
  'docs',          // the logo and the .md pages ship; the pictures the suite checks do not
  'test',
  'tools',
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CLAUDE.md',
];

/* The manifest the published package carries. Every field is taken from the
 * repository's own, so the two cannot drift: the version, the engines floor
 * that bin/spiega reads, the file list. What is dropped is what only a
 * contributor needs — scripts, dev dependencies, the workspace's privacy.
 */
function manifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const keep = ['name', 'version', 'description', 'type', 'bin', 'exports', 'files',
    'engines', 'license', 'keywords', 'repository', 'bugs', 'homepage', 'author',
    'publishConfig', 'dependencies'];
  const out = {};
  for (const k of keep) if (k in pkg) out[k] = pkg[k];
  return JSON.stringify(out, null, 2) + '\n';
}

/* The TypeScript, from wherever it has reached: src/, as modules are ported in
 * place, and packages/<name>/src, as the typed domain fills up. Both land in dist/
 * at the path they have here, which is what lets a compiled module find its
 * neighbours — ported or not, in its own package or another — by walking up
 * from its own file, exactly as every other module in this artefact does.
 */
function compile() {
  const entries = fs.globSync(['src/**/*.ts', 'packages/*/src/**/*.ts'], { cwd: ROOT });
  if (!entries.length) return say('spiega build: nothing ported to TypeScript yet');

  const bin = path.join(ROOT, 'node_modules', '.bin', 'tsdown');
  if (!fs.existsSync(bin)) {
    console.error('spiega build: tsdown is not installed — run `pnpm install` first.');
    process.exit(1);
  }
  const r = spawnSync(bin, ['--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);

  /* An unbundled build writes relative to the deepest directory holding all of
   * its inputs, so where a module lands is inferred rather than declared —
   * tsdown.config.ts gives each source root its own build to keep that
   * inference honest, and this is the check that it was. A module compiled to
   * the wrong path is not a build error: it is a board that imports a URL
   * which 404s, or a suite that imports the module it replaced, and neither
   * says why.
   */
  const astray = entries
    .map(e => e.replace(/\.ts$/, '.js'))
    .filter(js => !fs.existsSync(path.join(DIST, js)));
  if (astray.length) {
    console.error('spiega build: these did not compile to the path they are imported from:\n  ' +
      astray.join('\n  '));
    process.exit(1);
  }
}

/* A board that cannot find its renderer renders empty and says nothing, which
 * is the failure this repository has been bitten by most often. An artefact
 * missing one of these would do exactly that, so the build refuses to call
 * itself finished.
 */
const REQUIRED = [
  'package.json',
  'bin/spiega',
  'src/cli.js',
  'src/index.js',
  'src/mcp/server.js',
  'src/board/server.js',
  'src/board/board.html',
  'src/render/render.js',
  'docs/logo/spiega-mark.svg',
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const name of ASSETS) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(DIST, name), {
    recursive: true,
    // The TypeScript source is not shipped; its compiled output is.
    filter: src => !src.endsWith('.ts'),
  });
}

compile();

fs.writeFileSync(path.join(DIST, 'package.json'), manifest());

const missing = REQUIRED.filter(f => !fs.existsSync(path.join(DIST, f)));
if (missing.length) {
  console.error('spiega build: dist/ is missing files the package cannot run without:\n  ' +
    missing.join('\n  '));
  process.exit(1);
}

say('spiega build: dist/ assembled');
