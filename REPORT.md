# Issue #78 — columns that no boundary touches lose their centring once separation runs

PR: https://github.com/pierangeloc/spiega/pull/83

## What was broken

#58 (PR #76) made `separate()` in `src/render/layout.js` stand a non-member box
wholly above or below a boundary's enclosure. It did that with a longest path
over "this box is at least so far below that one" constraints, and a longest
path yields each box's *earliest* position — which packs the whole board to the
top. `layout()` centres every column against the tallest one when no separation
is needed, so on any board where separation ran, the columns a boundary never
touched lost that centring and sat at the top edge.

On the repro board, `Client` and `Payments` were top-aligned with `Auth` and
`Events`, even though the boundary only ever asked about `Auth` and `Events`.

## What I changed

### `src/render/layout.js`

One addition, entirely inside `separate()`, after the longest path has computed
the earliest position of every box:

- A box is **free** if none of its constraint edges touches a box in a different
  column. Within a column the boxes are already chained (by the ordering edges),
  so they move as one; the edge that crosses a column boundary is what pins a
  column.
- A column whose boxes are all free is re-centred against the board's full
  content height — exactly the centring `layout()` gives every column before
  separation, so the look is restored, not reinvented.
- Centring can never grow the board: a single column's height is at most the
  tallest column's, so a centred column's bottom never passes the current
  bottom. And a box with no cross-column edge is a box no group's rectangle
  reaches, so it can neither become an intruder nor drag a wall over one. The
  guarantee from #76 holds by construction, and the new test asserts it instead
  of taking that for granted.

Nothing else in the renderer changed. The change is 34 lines of comment plus
plain computation; no new dependency, no import, no renames.

### `test/smoke.mjs`

Added `intruders` to the existing `layout.js` import and one new test,
`a boundary separates, and a column it never touched stays centred`, which:

- renders the issue's repro board,
- asserts `intruders()` is empty for both boundaries *after* the centring,
- asserts `Client` and `Payments` are centred (within 2px of the board's midpoint),
- asserts `Auth` and `Events` stay above `Client`, where the boundary put them.

This is the natural "fails before, passes after" test: on the old code it fails
with `Client is 70px off centre`.

### `test/boards/issue-78-centre-within-slack.json` + `manifest.json`

The repro spec, committed as a regression board named for the issue, with a
manifest entry describing what broke and what changed.

### `docs/regressions/issue-78-centre-within-slack.svg` and `-before.svg`

The fixed picture and a frozen picture of the buggy (top-aligned) state, so the
SVG two-up diff is the before/after. `docs/regressions.md` was regenerated.

## How I verified it

Rendered the board and read the geometry (the model in this session cannot view
PNGs, so I verified coordinates rather than eyeballing a raster):

| node | before (bug) | after (fixed) |
| --- | --- | --- |
| Client (col 0) | y 64 → bottom 156 (top-aligned) | y 134 → bottom 226 (centred) |
| Payments (col 5) | y 64 → bottom 160 (top-aligned) | y 132 → bottom 228 (centred) |
| Auth (col 2) | y 64 | y 64 (unchanged) |
| Events (col 3) | y 64 | y 64 (unchanged) |
| `ours` / `data` intruders | — | `[]` / `[]` |

Only the two untouched columns moved; the boundary's members and the boxes it
moved stayed put, and no enclosure re-swallowed a non-member.

Screenshots (rasterised with `rsvg-convert -z 2`):

- `/tmp/issue-78-before.png` — the top-aligned state (bug)
- `/tmp/issue-78-after.png` — the centred state (fix)

Committed pictures, the ones the reviewer's eyes actually land on:

- `docs/regressions/issue-78-centre-within-slack-before.svg`
- `docs/regressions/issue-78-centre-within-slack.svg`

## Committed pictures that moved

None of the pre-existing committed pictures changed byte-for-byte. `npm test`
byte-checks the gallery, `docs/examples` and `docs/regressions/*.svg`, and it
passed with no drift. That is correct and expected:

- The two boards where separation actually runs are
  `issue-58-boundary-members` and `issue-58-boundary-impossible`. On both, every
  column participates in a cross-column constraint (in the impossible board a
  boundary is given up and drawn as pieces), so no column is free to centre —
  the new code leaves those boards exactly as #76 drew them.
- Every other committed board never runs separation at all, so the centring
  branch is never reached.

So no existing picture should move, and none did. The only new committed
pictures are the two for this issue itself.

## What I did not do

- Did not change any code outside `separate()` in `layout.js`, and did not touch
  the renderer (`render.js`) or `boundaryShapes()`.
- Did not change how many rectangles a boundary is drawn as. The #77 concern
  ("separation impossible, boundary drawn as several rectangles") is untouched:
  `boundaryShapes()` is unchanged, and the `issue-58-boundary-impossible` board
  still draws the same pieces (its test still passes).
- Did not add a dependency, reformat anything, or rename anything.
- Did not freeze `-before.svg` files for any *other* board, because no other
  committed picture moved (per Done #3, that freeze applies only to a regression
  board whose bug this change touches, and this change improves none of the
  existing boards — it leaves them all byte-identical).

## What I am unsure about

- The fixed centring uses the board's full *content* height (post-separation
  bottom minus top padding) as "the tallest one". That is the natural reading of
  "centred against the tallest one" once separation has stretched the board. An
  alternative would be to centre against the tallest *column* height alone, but
  that would leave untouched columns slightly out of line with the stretched
  board. I chose the full content height and matched the issue's own
  before/after expectation for `Client` and `Payments`.
- I verified the geometry by coordinates rather than by looking at a raster,
  because the model running this session cannot load image files. The SVGs are
  committed and rich-diff cleanly, so the reviewer can see the before/after
  directly.

## Checks (verbatim)

### `npm test`

```
> spiega@0.3.0 test
> node test/smoke.mjs

  ok  an op list builds a board, and ids come from labels
  ok  redrawing an id updates it instead of adding a second
  ok  an unknown op is reported, not thrown
  ok  a boundary whose members is not an array of string ids is refused, not stored
  ok  a step whose lights is not an array of string ids is refused, on both routes in
  ok  a value that is not an op is refused, not thrown
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
  ok  a board that cannot be drawn says so with a 500, and the server stays up
  ok  a malformed POST /op costs the request, not the server
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
  ok  a line leaves below the words written under a box
  ok  no back edge runs through a box that is not one of its ends
  ok  a back edge with nothing below either end still runs along the floor
  ok  back edges leaving one column by the same gutter each get a lane
  ok  every gutter is wide enough for the widest tag that crosses it
  ok  a boundary does not enclose a box that is not its member
  ok  a boundary that cannot be one true rectangle is drawn as true pieces
  ok  no random board draws an enclosure around a non-member
  ok  a boundary separates, and a column it never touched stays centred
  ok  no tag is drawn under a node
  ok  a sentence of sub does not make a wide box, and the box grows to hold it
  ok  the spoken offset maps to the right word
  ok  a callout points at a node or an edge, and the canvas grows to hold it
  ok  a callout can be set at a corner, as far out as at a face
  ok  a callout gives way to a routed line, and stays put when nothing is in its way
  ok  no shipped callout has words over a routed line
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
  ok  a log written before the door was guarded still opens, and draws
  ok  two servers cannot interleave writes into one board file
  ok  below LOG_CAP nothing is compacted: the said/drawn interleaving stays
  ok  past LOG_CAP the file is rewritten from current state as a minimal op set
  ok  POST /op does no file I/O and does not wait for the flush
  ok  the per-op work on POST /op stays under 0.2 ms p99
  ok  restore of a typical session and of a capped one stay quick
  ok  a tidy shutdown leaves no lock behind
  ok  removes, then updates and additions, still land correctly
  ok  a batch of removes costs about what the batch is worth

12 passed
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

113 passed
```

### `npm run typecheck`

```
> spiega@0.3.0 typecheck
> tsc --noEmit

```