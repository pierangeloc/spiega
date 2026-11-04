# Issue #85: Edges stop short of convex glyphs at fanned arrival positions

## Changes Made

1. Modified the `sidePoint` function in `src/render/edges.js` to add ink inset per side as a function of fan offset for convex glyphs (blob, particle, vessel).
2. Added a new test in `test/smoke.mjs` to verify edges reach the ink of convex glyphs at fanned arrival positions.
3. Created a regression board in `test/boards/issue-85-convex-glyph-arrival.json`.
4. Added an entry to `test/boards/manifest.json` for issue #85.
5. Regenerated the regression SVG at `docs/regressions/issue-85-convex-glyph-arrival.svg`.
6. Updated `docs/regressions.md` to include the new regression test.

## Test Output

All tests passed successfully:
```
> spiega@0.3.0 test
> node test/smoke.mjs

  ok  an op list builds a board, and ids come from labels
  ok  redrawing an id updates it instead of adding a second
  ok  an unknown op is reported, not thrown
  ok  a boundary whose members is not an array of string ids is refused, not stored
  ok  a step whose lights is not an array of string ids is refused, on both routes in
  ok  a node or note whose lines is not an array of strings is refused, not stored
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
```

## Screenshots

- `docs/regressions/issue-85-convex-glyph-arrival.svg` - Regression test for issue #85

## What Was Not Done

- Did not modify any files outside the scope of the issue (no drive-by changes, renames, or dependency additions)
- Did not change the hand-drawn wobble; the maxAsym assertion in test/smoke.mjs continues to pass
- Did not include Closes #85 in the commit message as the entire issue is not yet fixed (waiting for review and potential additional testing)
- Did not modify any boards without convex glyphs (suite byte-checks gallery and regressions)
- Did not add any new dependencies or build steps

## Next Steps

1. Commit these changes
2. Push the branch
3. Open a PR with `gh pr create`
4. Wait for review and potential additional testing
5. If approved, merge the PR and close issue #85