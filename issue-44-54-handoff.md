# #44 and #54 — notes before delegating

Working notes, not docs. Delete when both are merged.

Board: `issue-44-54-board.html` in this directory — the same material as a
drawing, 8 steps. `spiega replay` plays it back if the server is still up.

Both issues were sequenced behind things that are now done:

- **#62** (board server answered every page on the internet) — closed. Both
  issues name it as a prerequisite. `src/board/server.js:94-137` + `:214-222`
  now require a loopback host, a same-origin-or-absent `Origin`, and
  `content-type: application/json` on the two body routes. No token, no
  `access-control-allow-*` header is ever sent.
- **#53** (label gutter) and **#52** (enclosure over non-members) — closed.
  #54's "wait for a readable board before judging the third tier" no longer
  applies.

---

## #54 — step groups

Two halves with very different cost. They should probably be two PRs.

### Half one: the `group` key and the rail header

Cheap, testable in node, byte-checkable against a regression board. An agent
can finish this unsupervised.

- `group` as a key on the `step` op, handled at `src/board/state.js:441`.
  A step names its group; the group does not list its steps. Indices renumber
  when a step is inserted, a key does not — same reason the existing ops prefer
  `edge` over position.
- A separate op carries the display label:
  `{"op":"group","id":"verbranding","label":"Verbranding"}`. Optional; default
  label is the id.
- Rail header spanning the group's step cards, same shape as `STEP 1` on one
  card today (`src/board/board.html:339-342`, `renderRail`).

**Decision needed, and it must be in the brief:** non-contiguous groups.
My answer: **do not reject them.** An op that errors arrives mid-sentence,
while somebody is talking — the worst possible moment to be pedantic. Let the
group span, and render one header per contiguous run, repeating the label.
If this is left open an agent will invent an answer.

### Half two: the third tier on the drawing

`focusAt` (`src/render/render.js:48`) returns `{nodes, edges}` today, and every
consumer downstream only asks `focus.edges.has(key)` / `focus.nodes.has(id)`.
Adding `context` — the union over the active step's group, minus the step
itself — is a few lines and no new rendering concept.

One correction to the issue's own framing, in its favour. It says "a group
needs a third state, between lit and dim", and then worries three opacity tiers
will read as "slightly broken". But the shape it actually specifies is not
three opacity tiers — it is **two independent axes**:

- opacity says *in the phase, or not*;
- orange + halo says *this is the step*.

Context at full opacity with no orange and no halo is not a middle opacity at
all. That is a better design than the sentence that introduces it, and I think
it will read. But that cannot be settled from the source — `AGENTS.md` is
explicit. Render it and look at it. This is the half an agent does not get to
call finished on its own.

Not taken (and the issue is right): drawing the group as an enclosure. A
group's nodes are not adjacent, and an enclosure over non-contiguous members is
exactly what #52 was about. Revisit later, not now.

---

## #44 — remarks

Bigger, more interesting, and it has a trap in it.

### The trap, which must be in the brief

`src/board/script.js:56-63` reconstructs "what was lit when this line was said"
by walking `board.log` and counting `say` entries **positionally**:

```js
for (const e of board?.log || []) {
  if (e.op === 'focus') lit = e.step == null ? null : Number(e.step);
  else if (e.op === 'say') whileLit.push(lit);
}
```

Any new op that also appends to `transcript` silently desynchronises every
implicit step tag on the board. Not a crash — wrong highlighting, which nobody
notices. Filter that walk by op kind.

Keep remarks in the **same `transcript` array**, with a `by` field. A separate
array throws away the interleaving of what was said and what was drawn, which
`AGENTS.md` names as the thing that makes a replay worth having.

### Related bug found while drawing the board

**You cannot untag a transcript line that was tagged implicitly.** `tag --step
off` deletes `line.step` (`src/board/state.js:385-388`), but `scriptSteps` then
falls back to the `whileLit` log walk and re-ties the line to the same step. The
only way out today is to tag it to a nonexistent step number, where `clamp`
returns null (`script.js:51`).

Same walk, same PR. Whoever fixes the desync will already be in there.

### Don't build new geometry

A remark *is* a callout in a different hand. `callout` already exists
(`src/board/state.js:420`, `src/render/callout.js`, placed by
`src/render/floating.js:266-374`): anchored text, leader line, eight candidate
sides, collision scoring.

So: **new op, no new renderer.** `remark` stays its own op kind because it is
semantically different — it is a reply, not part of the explanation, and the
agent must not be able to `remove` it — but it renders straight through the
callout machinery.

Note while writing one: `callout` wraps at 22 chars and caps at **4 lines**,
ellipsising the rest (`src/render/callout.js:92`). Pass `wrap` for anything
longer. A remark typed by a human will hit this immediately, so decide what a
long remark does before it silently loses its second half.

### The real new thing is UI, and it has never been done here

Every button in `board.html` today is view-state. `post()`
(`src/board/board.html:702-704`) is only ever called with a `focus` op
(`:383`). Clicking a node and typing is the first content-authoring UI in the
project. Two concrete hazards:

1. The SSE `patch` stream (`src/board/server.js:297-310`) re-renders the SVG.
   A text input **inside** the SVG is wiped out mid-sentence by an agent still
   drawing. Put the input in a fixed overlay, outside the re-rendered tree.
2. `AGENTS.md`: you do not get to call a visual change finished from its own
   source. Somebody looks at it, at more than one width.

### `board_remarks` and "unseen"

A new MCP tool is two edits — an entry in `TOOLS` and a `case` in `call()`
(`src/mcp/server.js:36-179`, `:208-285`). No registry, no schema validation.

"Unseen" needs a watermark per board, i.e. server state about who has read
what. Fine for one agent. Return remarks with their indices and advance the
watermark; offer `all: true` for when the person says "look at the board
again". **Do not let `unseen` be something the agent can reset.**

MCP is request/response, so nothing can push. Phase 1 is the pull model, and
the line in the skill ("call `board_remarks` before answering a follow-up about
a board you drew") matters more than the code does.

### Answers to the issue's open questions

- **Does a remark light with its node's step, or stay lit?** Stay lit. It is a
  reply to the explanation, not part of it.
- **Can the agent resolve one?** No — answer only. A board where the agent can
  delete your objections is a worse board. But *you* should be able to delete
  your own remark.
- **Replay ordering.** Wall-clock, so a remark replays where it was made. Right
  as it stands.
- **Phase 2 (regions, rubber-band): cut entirely from this round.**

---

## Delegation

Both touch `src/board/state.js`'s op switch and `src/board/board.html`. Two
agents in two worktrees will both edit both files. Survivable, but each needs to
know the other exists.

Suggested order: **#54 first** — it is days, #44 is weeks, and #54's rail half
is the cleanest unit of work on the board.

Four things to settle before any brief goes out:

1. Non-contiguous groups: span with repeated headers, or reject? (Say span.)
2. #54 as one PR or two? (Say two — the tier cannot be self-certified.)
3. #44 phase-1 scope: remark op + callout rendering + `board_remarks` + the
   skill line. Does `spiega remarks` on the CLI come along?
4. Order, or parallel with a heads-up about the shared files?

Per `AGENTS.md`, each PR that touches rendering must add its repro spec to
`test/boards/`, describe it in `test/boards/manifest.json`, and commit the
regenerated picture.
