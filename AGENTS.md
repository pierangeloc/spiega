# Working on spiega

This is the one instructions file. `CLAUDE.md` is a stub that imports it, and
`spiega install project` appends its own marker block below — put instructions
here, not in either of those.

Read this before changing anything. It is short on purpose: it holds the things
that have actually gone wrong here, not general advice.

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

`npm test` now walks the graph from `board.html` and fails on any `node:`
import reachable from the page. Do not route around it.

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

### Glyphs

```sh
npm run shapes                                   # regenerates docs/shapes/*.svg
rsvg-convert -z 2 docs/shapes/vessel.svg -o /tmp/v.png
```

Compare a new shape against the one it could be confused with — a neutral
`vessel` next to `datastore`, not on its own.

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

## Types are opt-in, and not in `npm test`

Four modules carry `// @ts-check` with JSDoc — `board/state.js`,
`board/script.js`, `render/render.js`, `render/layout.js` — checked by
`npm install && npm run typecheck`.

It is deliberately **not** part of `npm test`, because `tsc` is the repo's only
dependency and a fresh clone must still pass its suite with nothing installed.
Keep it that way. If you add types to another module, add `// @ts-check` to it
and list it in `tsconfig.json`; never buy a green check with `any`,
`@ts-ignore` or a loosened flag, which is the whole reason the four are strict.

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

- No dependencies, no build step. `git clone && node src/cli.js serve` is the
  point of the thing, and the code you read is the code that runs.
- The op log is append-only. Restore is `applyOps` over the lines read back,
  so there is no second representation to keep in step.
- Below `LOG_CAP`, never compact: compaction loses the interleaving between
  what was said and what was drawn, which is what makes a replay worth having.
- Comments say *why*, in prose, in the voice already in these files. If a
  comment only restates the line under it, delete it.
