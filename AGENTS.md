# Working on spiega

This is the one instructions file. `CLAUDE.md` is a stub that imports it, and
`spiega install project` appends its own marker block below — put instructions
here, not in either of those.

Read this before changing anything. It is short on purpose: it holds the things
that have actually gone wrong here, not general advice.

## What runs is `dist/`, not what you edited

There are dependencies and there is a build step. A pnpm workspace, TypeScript
compiled by tsdown, JavaScript copied across untouched, and the assembled
result in `dist/` — which is not a folder inside the published package, it *is*
the published package, manifest and all.

```sh
pnpm install
pnpm run build       # assembles dist/
pnpm test            # builds, then runs the suites inside dist/, under vitest
pnpm run lint        # the browser rule, over the source tree
pnpm run typecheck   # root plus every package, strict
pnpm run pack        # the tarball npm would publish
```

The layout inside `dist/` is the repository's own, deliberately: the board page
imports the renderer off disk as `/src/render/render.js`, and every module here
finds its neighbours by walking up from its own file. Flattening the artefact
would move all of those at once.

**The thing to internalise: nothing you edit runs until it is built.** The
suite runs inside `dist/` (ADR 0002 — `docs/adr/0002-port-the-suite-gradually.md`),
`bin/spiega` prefers `dist/src/cli.js`, and after `spiega install` the agents on
your machine are wired to `dist/` too. `pnpm test` builds first, so the suite is
safe. These are not:

```sh
node dist/test/settle.mjs          # one suite alone — build first, or it is stale
pnpm run build && node dist/test/settle.mjs
pnpm run build && pnpm vitest run dist/test/settle.spec.mjs   # the same, named
```

Vitest is the runner, not the idiom: the suites still assert with
`node:assert` and still run on their own under plain node. What it collects is
one `test/*.spec.mjs` per suite, which is the only reason a suite has a name
in the output — a suite that loses its spec stops running, so `smoke.mjs`
refuses any file in `test/` that asserts and has no spec beside it.

A `git pull` does not build either, which is the shape this fails in: your
agents keep running the previous build, and nothing anywhere says so. A
`post-merge` hook in `.git/hooks` that runs `node tools/build.js` costs two
lines and removes the whole class.

The picture tools that draw a board run from the build now, because the reducer
is TypeScript and no longer exists in the source tree: `pnpm run shapes` and
`pnpm run gallery` build first and pass `docs/shapes` and `docs/gallery` on the
command line so the built copies write back into the repository rather than
into `dist/docs`, and `node dist/tools/example.js` takes its paths from the
command line. `tools/regressions.js` imports no board code and still runs from
the root as `node tools/regressions.js`.

## Node is the only runtime

CI runs Node, the published artefact runs on Node, the floor is Node 24 and
`engines` says so. **No code, script, test or tool here may require another
runtime to pass.** Reach for Bun on your own machine if you like it; the moment
anything in this repository depends on your having done so, a contributor
without it has a repo that does not build, and the failure is theirs to debug
rather than yours.

The floor is 24 rather than 22 for a reason worth keeping: node strips types
unflagged from 23.6, so from 24 a `.ts` file runs with no loader and no build
in front of it. `tsdown.config.ts` already relies on it.

## The browser is a consumer, and the test suite barely sees it

`src/board/board.html` imports the renderer **off disk, unbundled**:

```js
import { renderSVG }        from '/src/render/render.js';
import { emptyBoard, applyOps } from '/src/board/state.js';
```

So every module reachable from that page must run in a browser. **Never import
a `node:` builtin, or any bare specifier, into one of them.** If you need the
filesystem, put that half in a node-only module — `src/board/log.js` exists
because persistence put `import fs from 'node:fs'` into `state.js` and took
every board down with it.

The failure mode is what makes this worth a rule: nothing throws where you can
see it. The module graph never evaluates, no handler is registered, and the
board renders `THE BOARD IS EMPTY` while the server happily holds the nodes and
streams them to a page that is not listening. No terminal error. No failing
test — `node:fs` resolves fine in the test runner.

`pnpm run lint` enforces that, and fails naming the file and the specifier. It
is `eslint.config.js`, and it is a rule per file rather than a walk from the
page, because membership in a browser-safe package *is* reachability: it covers
`packages/core`, `packages/render`, all of `src/render`, and all of `src/board`
except the handful of node-side modules named in the config. So a new
browser-side module is covered by having been written, and a new node-side one
fails until you add it to that list — say which it is, deliberately, rather
than widening a glob. Do not route around it, and note that lint reads the
source tree while the suite reads `dist/`.

One thing the rule does allow, and the ports depend on it: a **type-only**
import of a bare specifier. `import type { Op } from '@spiega/core'` is erased
at compile time, so nothing is fetched and no board goes dark; that is how a
browser-side module speaks the typed domain while `effect` stays out of the
page's import graph. Drop the `type` and it fails, as it should.

Two things the page-walk asserted are not about any one file, so they are still
tests in `smoke.mjs`: that the page's root imports exist on disk, and that
nothing it reaches is `settle.js` or `@dagrejs/dagre` — an unsettled board must
not fetch dagre.

**A green suite does not mean a working board.** The suite runs in node. The
browser is a second consumer with almost no coverage, and it is the one that
matters for a board.

## Look at visual changes. Actually look

Rendering is most of what this project does, and judgement about how a shape or
a banner *reads* cannot be done by reasoning about the code. Twice now a change
was called finished on the strength of its own source — a glyph whose comment
claimed it was distinct from the datastore cylinder while reading as a flat
tray, and a warning banner that ran off the edge of the pane mid-sentence.

If you changed a glyph, the layout, or anything in `board.html`'s stylesheet,
render it and put your eyes on it before saying it works.

### A board that broke once is kept

`test/boards/*.json` are the specs from reported rendering bugs and
`docs/regressions/*.svg` are their pictures, regenerated and byte-checked by
the suite like the gallery is. A board goes in whether or not its bug is fixed
yet: a committed picture of a board that is still wrong is the thing the fix
will be read against.

Fixing a rendering bug means adding its repro spec there, named for its issue,
and committing the picture alongside your change. The picture is the point:
GitHub rich-diffs an SVG two-up, so the diff *is* the before-and-after of the
board, and the next person to touch the renderer sees what they did to every
board that has ever been wrong. A screenshot pasted into a PR says the same
thing once and then rots.

```sh
pnpm run build && node dist/tools/example.js test/boards/issue-53-crowding.json \
  docs/regressions/issue-53-crowding.svg
node tools/regressions.js        # rewrites docs/regressions.md
```

Describe the board in `test/boards/manifest.json` — what broke, and what the
fix changed. `tools/regressions.js` refuses to write the page for a board that
is not in there, because a picture of a board nobody explains is a puzzle.

**When you fix one, freeze the wrong picture first:**

```sh
cp docs/regressions/issue-52-fan-out.svg \
   docs/regressions/issue-52-fan-out-before.svg
```

`<board>-before.svg` is the state the bug was reported in. Nothing regenerates
it, ever. That is the whole point: a before-and-after made of two commits on
one file is destroyed the moment its pull request is squashed, and the first
time that happened the comparison survived only as a URL into a closed PR. Two
files in the tree survive any merge strategy anyone picks later.

Do not put these in `examples/`. Those three are the showcase and are meant to
look good; these are meant to be the boards that once looked wrong.

### Glyphs

```sh
pnpm run shapes                                  # regenerates docs/shapes/*.svg
rsvg-convert -z 2 docs/shapes/vessel.svg -o /tmp/v.png
```

Compare a new shape against the one it could be confused with — a neutral
`vessel` next to `datastore`, not on its own.

The gallery is byte-checked by the suite, like `docs/gallery`,
`docs/examples` and `docs/regressions`: if you touch a glyph, run it and commit
what comes out, or the suite fails naming the files you did not regenerate. It
is checked because it drifted once while nothing was watching — the committed
glyphs had been drawn by an older renderer, and `docs/vocabulary.md` points at
them instead of describing them.

### The board's own CSS

Headless Chrome **hangs** on a live board: the SSE stream never goes idle, so
`--virtual-time-budget` never resolves and `--screenshot` writes nothing. Do
not conclude from that that the page is broken.

Instead build a standalone page from the real stylesheet and the real markup,
with the banners unhidden and no server behind it, and shoot that at several
widths:

```sh
# extract <style> and the markup you changed into /tmp/x.html, then:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --screenshot=/tmp/x-520.png --window-size=520,220 file:///tmp/x.html
```

Check the narrow width. A board is often a split pane, and a message that fits
in a full window loses its second half in one — which is the half that carries
the consequence.

## Types are strict, and checked on their own

`pnpm run typecheck` runs `tsc` over the root and then over every package.
Strict means strict: **never buy a green check with `any`, `@ts-ignore` or a
loosened flag.** That rule predates the migration and is the only reason the
modules that opted in early are worth having opted in.

The JavaScript that has not been ported is checked file by file. `checkJs` is
off; a module opts in by saying `// @ts-check` and being listed in
`tsconfig.json` — do both, or it is checked by nobody. Turning `checkJs` on
would pull in the render modules it imports, which together still carry ~234
strict errors; annotating those is the render port's job (#141–#145).

It is a separate job from `pnpm test` on purpose. The suite answers "does it
work", the checker answers "do the types hold", and a run that cannot tell you
which of the two broke is worth less than two runs that can.

## POST /op is on the critical path of somebody talking

An agent draws mid-sentence. `POST /op` pushes ops into an in-process buffer
and returns: **no file I/O, no `await` on a write.** The flush is on a timer.
There is a benchmark asserting the p99 budget so that a change putting a write
back on the hot path fails the suite.

Losing the last tick of ops in a hard crash is fine. This is a whiteboard, not
a ledger.

## A board that cannot do its job has to say so on the board

The CLI cannot carry a warning that matters: by the time anyone runs a command,
the explanation is already gone. A board that is not being saved draws exactly
like one that is, which is why it carries its own banner. Hold to that shape
for anything similar.

## Conventions

- **A runtime dependency is a decision, not a convenience.** `npx spiega` on a
  machine with nothing on it is the point of the thing, and every dependency is
  something that has to arrive before a board can be drawn. The package has
  two, both pinned: `effect`, because the ops are defined once as a Schema and
  the server decodes against it at `POST /op` (ADR 0001, #135), and
  `@dagrejs/dagre`, which orders a finished board once, at `settle` (the live
  layout and the ink stay ours). The build has as many dev dependencies as it
  needs; that is what they are for.
- The op log is append-only. Restore is `applyOps` over the lines read back,
  so there is no second representation to keep in step.
- Below `LOG_CAP`, never compact: compaction loses the interleaving between
  what was said and what was drawn, which is what makes a replay worth having.
- Comments say *why*, in prose, in the voice already in these files. If a
  comment only restates the line under it, delete it.

## Agent skills

### Issue tracker

Track this repo's issues on GitHub (`pierangeloc/spiega`) using `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/` when they exist. See `docs/agents/domain.md`.
