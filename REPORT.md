# Report: #53 the gutter is a constant and the labels are not

## What I changed

- `src/render/ink.js` — new shared measures, so the code that draws text and the
  code that makes room for it cannot disagree.
  - `nodeText(label, sub)`: wraps a node's title (22 chars) and sub (30 chars) to
    at most 3 lines each, and says how much taller than the one-title-one-sub
    box that makes the block.
  - `tagLines(label, step)`, `pillSize(lines)`: a tag is wrapped at 16 chars
    (3 lines max) with the step number on the first line; its width/height come
    from the same formula `pill` draws with.
- `src/render/layout.js`
  - `sizeOf`: a box is as wide as its *wrapped* text, and taller by what the
    wrapping added (for a queue, the strip under the slots grows instead). `note`,
    `formula` and `blob` set their own text and are untouched.
  - `layout`: after columns are known and before anything is placed, each
    boundary between adjacent columns gets `gutterFor(widest tag crossing it)`,
    never less than the old `COL_GAP`. Per boundary, not global. Back edges
    (loop returns) run on the floor and ask for nothing. `layout` takes a
    `stepFor` so the step number counts toward the tag's width.
  - `gutterFor`: sized for the side of the tag with least room (tags hang on the
    run into the target, ~71% across the gutter), plus 10px of air.
  - exports `EDGE_GAP` and `KNEE` (the 8 and the 0.42 that were literals in
    `edges.js`) so the router and the gutter sizing share them.
- `src/render/edges.js` — `pill` draws multi-line tags; `tagBox` measures with
  `tagLines`/`pillSize` and lifts by half its real height (identical to the old
  13px for a one-line tag). Uses `KNEE`/`EDGE_GAP`. `planTags` is untouched.
- `src/render/glyphs.js` — `labelBlock` and the queue's label draw the wrapped
  lines; one title + one sub lands exactly where it did before.
- `src/render/render.js` — flow is indexed before layout so layout can see step
  numbers.
- `test/smoke.mjs` — three tests (below).
- `docs/gallery/{flow,edges-async}.svg`, `docs/examples/{kalman,kalman-compare,webhook-retry,webhook-retry-compare}.svg`
  — regenerated. The suite has a test ("the generated pictures match the specs
  they come from") that regenerates them and fails until the committed copies
  match, so they had to change.

## Tests

1. `every gutter is wide enough for the widest tag that crosses it` — the
   layout-level check from the issue, on the repro and on every `examples/*.json`.
   **Confirmed failing on the old code** (src/render + docs stashed back to HEAD,
   new test file kept):
   `AssertionError: columns 0 and 1: a 235px tag has a 132px gutter`
   (the exact numbers in the issue). Passes now. It also asserts the boundary
   with short tags keeps its narrow gutter (per-boundary).
2. `no tag is drawn under a node` — the #48-style assertion (no placed tag box
   intersects any node box), on the repro and the examples. Passes now. I did not
   run this one against the old code separately; the gutter test failed first
   there and halted the suite.
3. `a sentence of sub does not make a wide box, and the box grows to hold it`.

## Checks, verbatim

`npm install && npm run typecheck`:

```
up to date, audited 2 packages in 600ms

found 0 vulnerabilities

> spiega@0.3.0 typecheck
> tsc --noEmit
```

`npm test` (exit 0):

```

> spiega@0.3.0 test
> node test/smoke.mjs

  ok  an op list builds a board, and ids come from labels
  ok  redrawing an id updates it instead of adding a second
  ok  an unknown op is reported, not thrown
  ok  columns come from the edges
  ok  a node added later does not move the ones already placed
  ok  a node drawn before its edge is relayered when the edge arrives
  ok  every kind renders, and the same board draws the same strokes
  ok  focusing a step lights one edge and dims the rest, but never a note
  ok  a snapshot is standalone: no scripts, no outside requests
  ok  the shipped example renders
  ok  the board page module parses
  ok  the browser-side modules parse
  ok  the play control stops when told to, from any step
  ok  the play control runs the flow to the end and stops itself
  ok  a line says which step it belongs to, by number or by hop
  ok  a line said while a step was lit belongs to that step
  ok  an untagged batch attributes nothing rather than guessing
  ok  an out-of-range or stale step link is dropped, not rendered
  ok  walking a step lights its lines, recedes the others, and spares the asides
  ok  a snapshot marks the lit step in the script, not just the drawing
  ok  clicking a line walks its step, and clicking it again comes back out
  ok  tags that run backwards are reported, not quietly reordered
  ok  a line already said can be tied to a step, by number or by its words
  ok  a wrong tag can be taken back, and a bad one is reported not thrown
  ok  tagging a board drawn before the feature existed makes it light up
  ok  every install target copies a file that exists
  ok  the block is added once, updated in place, and never duplicated
  ok  removing the block leaves the rest of the file untouched
  ok  a half-edited block is refused rather than guessed at
  ok  an empty or missing file just gets the block
  ok  every install target names a real file or directory, and detection is honest
  ok  a backup never lands inside a directory the harness scans
  ok  a browser is detected by its own binary, not its name in any path
  ok  doctor reports what is stale, and every problem comes with a way out
  ok  a stale shared server is not fixed one board at a time
  ok  colour and glyphs stay out of piped output
  ok  drawing a spec keeps everything rendering it would show
  ok  every file the docs point at is actually there
  ok  the README counts the node kinds it actually has
  ok  every anchor the docs link to is a heading that exists
  ok  every file a README command names is actually there
  ok  the numbers the README quotes are the numbers the tools produce
  ok  every published picture names its own font
  ok  the generated pictures match the specs they come from
  ok  --version says which copy it is, from a checkout and from an install
  ok  doctor does not mistake an enclosing repo for its own checkout
  ok  edge tags from the same box do not land on top of each other
  ok  the herdr plugin declares the actions it ships, and its scripts are runnable
  ok  the skill the installers link to exists, with the frontmatter a harness reads
  ok  a replay can be asked for remotely, and re-sends nothing
  ok  one server holds several boards and keeps them apart
  ok  a board can be asked for and dropped while the server keeps serving
  ok  the port is the lock: a second server joins the first instead of starting
  ok  the say and tag commands reach the board, and a bad tag fails loudly
  ok  a command still takes every flag it advertises, long, short or with an =
  ok  an unknown flag stops the command before it runs, and names the one it meant
  ok  a misspelt --keep-title costs no title, and clear says which it did
  ok  the MCP server exits when its client closes the pipe
  ok  board_draw and board_tag take their list as a JSON string, as some clients send it
  ok  boards are found by name, kept apart, and pruned when their server dies
  ok  a board is named after the task, and a session keeps the one it has
  ok  a process from a previous location is found, not reported as absent
  ok  a wrapped MCP server carries its wrapper as parent, and both are found
  ok  every relative link in docs/ points at something that exists
  ok  the documented vocabulary matches what the board accepts
  ok  a formula is measured, drawn, and honest about what it cannot do
  ok  a formula node renders on the board, and the snapshot stays standalone
  ok  a cycle keeps its order, and the closing edge goes round
  ok  every gutter is wide enough for the widest tag that crosses it
  ok  no tag is drawn under a node
  ok  a sentence of sub does not make a wide box, and the box grows to hold it
  ok  the spoken offset maps to the right word
  ok  a callout points at a node or an edge, and the canvas grows to hold it
  ok  removing a node takes its callouts with it
  ok  a run of removes sweeps once and keeps what survived in order
  ok  anything drawn after a removal is new, not a survivor of the sweep
  ok  a TOML table is edited without disturbing its neighbours
  ok  migrating from the old name clears every trace it left
  ok  a step frames the boxes it lights, both ends of its edge included
  ok  the camera holds still when the whole board is already in view
  ok  and when the subject is on screen with room around it
  ok  a subject off screen is brought in, without zooming in
  ok  it pulls back only as far as it must, and never past the paper
  ok  a subject reached by a zoomed-in reader keeps that reader zoomed in
  ok  the camera refuses to frame anything in a pane with no room
  ok  the old name counts only where servers are registered
  ok  capitals, except where the spelling is the information
  ok  a note keeps every line it was given, up to a cap it is hard to reach
  ok  past the cap the cut is at a line boundary and the ellipsis stands alone
  ok  a caller with its own line budget is never handed more lines than it asked for
  ok  ops survive a board being dropped and reopened, in their original order
  ok  a corrupt or half-written last line is skipped, and the next op still lands on its own line
  ok  two servers cannot interleave writes into one board file
  ok  below LOG_CAP nothing is compacted: the said/drawn interleaving stays
  ok  past LOG_CAP the file is rewritten from current state as a minimal op set
  ok  POST /op does no file I/O and does not wait for the flush
  ok  the per-op work on POST /op stays under 0.2 ms p99
  ok  restore of a typical session and of a capped one stay quick
  ok  a tidy shutdown leaves no lock behind
  ok  removes, then updates and additions, still land correctly
  ok  a batch of removes costs about what the batch is worth

11 passed
  ok  boards persist across a restart, and POST /op keeps its latency budget
  ok  install links the command once, and moves it rather than leaving a second
  ok  install never edits a shell file without being told yes
  ok  install pi writes a skill, a direct MCP server and the instruction file pi reads
  ok  nothing the browser imports reaches for a node builtin
  ok  the CLI, the MCP server and curl send no Origin, and still draw
  ok  the board page, on this origin, still draws
  ok  a page on the web cannot read a board
  ok  a page on the web cannot write to, or close, a board
  ok  another server on loopback is a different origin, not a friend
  ok  no response carries a CORS header for anyone to lean on
  ok  a preflight is told nothing, rather than which methods exist
  ok  a name rebound to 127.0.0.1 is refused on the Host header
  ok  a simple cross-origin POST cannot slip past as text/plain

9 passed
  ok  the board server belongs to this machine, not to the web
  ok  the server that owns the file says it is saving
  ok  a second server on the same board says it is not, and why
  ok  the warning is on the stream before anything is drawn
  ok  the losing server really does not write, so the warning is true
  ok  an in-memory board is not a warning
  ok  the board raises the banner for exactly the boards that are not saved

6 passed
  ok  a board that is not being saved says so

97 passed
```

## Screenshots

Headless Chrome on a static rendered file; `rsvg-convert` for the docs SVGs.

- `/tmp/crowd-before.png` — repro on the old code. `READ SAME MET…` is cut off
  behind the `API` box and `1 FINALIZE RUN + TRIGGE…` behind
  `endpointsDocumentation`, exactly as in the issue. Boxes are ~300px wide.
- `/tmp/crowd-after.png` — same spec. Subs wrap to two lines, boxes are 190–240px,
  the tags are two short lines (`READ DECLARED / ACCESS`, `READ SAME / METADATA`,
  `1 FINALIZE RUN + / TRIGGERING USER`) and each sits wholly inside its gutter
  with the arrow visible. Nothing clipped. (Numbers: tag x-ranges end 27, 33 and
  21px before the box they point at.)
- `/tmp/cmp/webhook-retry-before.png` / `-after.png` — a normal board. Wider
  (gutters grew where tags are long), `1 POST /HOOKS/PAYMENTS` is now two lines
  inside its gutter, `2 SETNX event_id` clears the Redis box by 10px. Nothing
  worse that I could see.
- `/tmp/cmp/flow-before.png` / `-after.png` — short tags (`1 gRPC`); visually
  identical, gutters stay at the old 132.
- `/tmp/cmp/kalman-before.png` / `-after.png` — wider gutters, no clipped tags.
  Tag/line/callout *placement* is still messy (e.g. the `the whole decision is
  this one ratio` callout runs over an edge, `4 HOW FAR` sits low); that was
  already so and is #48/#40 territory.

## What I did not do / unsure

- Did not touch `planTags` ordering or where a tag is anchored: that's the
  placement pass (#48/#40).
- `gutterFor` encodes where today's router hangs a tag (KNEE and the 71% point).
  If the placement pass moves tags, this should be revisited; the layout test
  only checks the weaker "tag fits in the gap", the intersection test checks the
  real thing.
- Ordinary boards with a ≥16-character tag get a wider gutter (≈200px vs 132px).
  That is the cost of fitting the tag; shorter tags keep 132.
- A tag crossing several columns widens every boundary it crosses, though its
  pill sits in only one. Conservative on purpose.
- A single word longer than the wrap measure is not broken, so a very long
  unbroken label still makes a wide box.
- `blob`, `note` and `formula` still size from their own text; a long `sub` on a
  blob is not wrapped (blob wasn't wrapping it before either).
- Second thing I noticed, not fixed: the test suite's regenerate-docs test
  rewrites tracked SVGs as a side effect of failing, so a first run after any
  render change fails and the second passes.

## PR

PR_URL_PLACEHOLDER
