# The migration, as rounds of work

[migration-effect-react.md](migration-effect-react.md) says *what* is being
migrated and in what phases. This says *what to pick up next*, in what order,
and what each one costs — the plan read as a queue rather than as a design.

It is written to be picked up cold, in a session that knows none of this. Read
it top to bottom once; then re-derive the status, because this file is a
snapshot and the tracker is not.

```sh
# where phase 1 actually stands
gh issue list --label migration --state open  --json number,title,labels \
  --template '{{range .}}#{{.number}} {{.title}}{{"\n"}}{{end}}'
gh issue list --label migration --state closed --limit 40 \
  --template '{{range .}}#{{.number}} {{.title}}{{"\n"}}{{end}}'

# is this one startable? an empty list means yes
gh issue view <n> --json blockedBy \
  --jq '[.blockedBy.nodes[] | select(.state=="OPEN") | .number]'
```

## Where it stands

**Phase 0 is closed** (#130–#134, #166): pnpm workspace, strict tsconfigs,
tsdown + Vitest, the browser rule as lint, the conventions rewritten, and the
two holes phase 0 left — lint that could not parse TypeScript, and a build
that did not compile `packages/`.

**Phase 1 is closed but for one human task.** Round 1 (#135), all three tracks
of Round 2 (#137, #138, #139) and #140 have landed: `packages/core/src/schema/`
holds the op union, the board Schema and the versioned log decoder, `state.ts`,
`script.ts`, `tape.ts`, `map.ts`, `camera.ts`, `spec.ts` and `settle.ts` are all
strict TypeScript, and `vendor/` is gone (`@dagrejs/dagre@3.1.3` comes from
npm). What remains in phase 1 is #136 (real MCP tool schemas,
`ready-for-human`).

**Phases 2, 3 and 4 have all started:**
- **Phase 2 (render):** #141 (`theme.ts`, `math.ts`, `geom.ts`), #142
  (`ink.ts`, `glyphs.ts`), #143 (`edges.ts`, `callout.ts`) and #144
  (`layout.ts`, `floating.ts`) landed. One issue left in the phase: #145
  (`render`, `audit`, and closing `packages/render`), unblocked now.
- **Phase 3 (server):** #147 (Effect HTTP read routes, loopback/origin
  middleware, `SpiegaHome`/`SpiegaConfig`/`BoardStore` services in
  `packages/server/`), #149 (the event stream as a `Stream` over a bounded
  `PubSub`) and #148 (`POST /op`, `/settle` and `/close` on the Effect router,
  the log flushed by a fiber off the request path) landed; #150 (snapshot,
  export and the board window) is unblocked and is the last of the phase.
- **Phase 4 (board app):** #152 (framework-free `Model`, `Msg`, `Cmd`, pure
  `update`, and fixture store in `packages/board/src/app/`) landed; #153 (React
  board beside the old one) waits on #145 finishing the render port.

## The decision the whole of phase 1 rests on

`board.html` imports its modules **off disk, unbundled**. The moment a module
the page reaches imports `effect`, the page dies the way `AGENTS.md` opens
with: empty board, no error anywhere, green suite.

So, for all of phase 1: **the runtime Schema stays out of the page's import
graph.** This is §D6's fallback ("keep Schema decoding server-side") promoted
from a contingency to a rule.

- The op union and the board Schema live in `packages/core/src/schema/`, and
  their only *runtime* importers are the server at `POST /op`, the MCP tool
  schemas, and the tests. That directory is named as an exception in
  `eslint.config.js`, and the walk in `smoke.mjs` that keeps the page away from
  dagre keeps it away from there too.
- A module the page *does* reach — the reducer above all — names the typed
  domain through `import type`, which is erased, costs nothing at runtime, and
  is allowed by the browser rule on purpose.
- The reducer is therefore ported **in place**, as `src/board/state.ts`: same
  URL for the page, compiled by the existing build. It moves physically into
  `packages/core` when #153 brings Vite, which is the first point at which a
  bundler can resolve `@spiega/core` for a browser at all.

The alternative — pulling the board's bundle step forward out of phase 4 — is a
much larger change, and it arrives before the model/update split that is meant
to shape it.

## The rounds

Dependencies are what make this an order rather than a list. Within a round the
tracks do not touch each other's files and can run in parallel.

### Round 0 — done

| | |
|---|---|
| #163 | the shape gallery joins the byte-checked picture sets |
| #166 | lint parses TypeScript; the build compiles `packages/` into `dist/` |

Both were cheap and both widen the oracle everything after them is judged by.

### Round 1 — done

**#135, the op union** (#169). Everything else in phase 1 reads the shape it
defines, and it established both conventions: `effect` as the package's first
runtime dependency, and the browser-rule exemption for
`packages/core/src/schema/`.

### Round 2 — done

| | | status / notes |
|---|---|---|
| #137 | the reducer in TypeScript | **done** (#171) — `src/board/state.ts`, `packages/core/src/schema/board.ts`, and the property suite in `test/reducer.mjs` |
| #138 | script, tape, map, camera, spec | **done** (#172) — all five ported in place |
| #139 | dagre from npm, settle ported | **done** (#174) — `@dagrejs/dagre@3.1.3` from npm, `src/board/settle.ts`, `vendor/` deleted |

### Round 3 — done but for #136

| | | status / watch |
|---|---|---|
| #141 | render leaves (`theme`, `math`, `geom`) | **done** (#173) — unblocks #142 |
| #147 | Effect HTTP server (read routes + security middleware) | **done** (#176) — unblocks #149 |
| #152 | board app model, messages, pure update, fixture store | **done** (#175) — `packages/board/src/app/` + `test/board-app.mjs` |
| #140 | old op logs restore through the Schema | **done** (#177) — `packages/core/src/schema/log.ts` with versioned `MIGRATIONS`, goldens in `test/fixtures/logs/`; unblocks #148 |
| #136 | `board_draw` advertises a real schema | **unblocked** — `ready-for-human` (needs four real MCP clients) |

### Round 4 — done

| | | status / unblocks |
|---|---|---|
| #142 | Port `ink` and `glyphs` (Phase 2) | **done** (#179) — all 22 `docs/shapes/*.svg` plus the gallery, example and regression sets byte-identical; unblocks #143 → #144 → #145 → #153 |
| #149 | Event stream as a `Stream` over a `PubSub` (Phase 3) | **done** (#178) — `packages/server/src/events.ts`, `PubSub.sliding(16)`, Node `pipeline` backpressure, heartbeat on a `TestClock`; unblocks #150 → #158 (and #156) |

### Round 5 — done

| | | status / unblocks |
|---|---|---|
| #143 | Port `edges` and `callout` (Phase 2) | **done** (#181) — unblocks #144 |
| #148 | `POST /op` on Effect, still off the hot path (Phase 3) | **done** (#180) — draw, settle and close on the Effect router; `Queue` + flush fiber in `packages/server/src/oplog.ts`; p99 budget held |

#150 was pulled from this round and held: it collides with #148 on
`src/board/server.js`, and the `POST /op` diff is the one whose benchmark has
to be read against a clean `main`. That collision is now resolved.

The round also turned up #182, which is not a migration issue and matters more
than either: the harness was not reading every suite's exit code, so some of
them could fail silently. Two suites were — one of them `restore.mjs`, which
had been broken for every pre-#74 log on disk since #177, through a review and
a green CI run. **Every round before Round 6 was judged on a signal that could
not fail.** The behavioural claims in the table above are worth a skim when
there is a quiet moment; the pictures and the type checks were never affected.

### Round 6 — done

| | | status / unblocks |
|---|---|---|
| #144 | Port `layout` and `floating` (Phase 2) | **done** (#183) — every gallery, example, regression and shape SVG byte-identical; unblocks #145 |

One issue, run alone: with #150 held there was no second track that did not
collide with it, and a port gated on byte-identical pictures needs no help.

### Round 7 — done

| | | status / unblocks |
|---|---|---|
| #145 | Port `render` and `audit`, and close the render package (Phase 2) | **done** (#184) — **phase 2 is finished**; `src/render` has no JavaScript left. Every gallery, example, regression and shape SVG byte-identical. Unblocks #153, and with it the whole of phase 4 |
| #150 | Snapshot, export and the board window on Effect (Phase 3) | **done** (#185) — the three render routes on the Effect router, `snapshot`/`export`/`open` in strict TypeScript, and `open` itself on Effect. Unblocks #158 → #159 → #160 |

Run in parallel, as planned; they never touched each other's code. They did
collide on two config files — `tsconfig.json` and `eslint.config.js`, which
every port edits — so the second PR needed a rebase after the first merged.
Worth expecting rather than avoiding: parallel ports always meet in the
manifest.

**#150 was closed on macOS verification alone, knowingly.** `spiega open` was
checked there — AppleScript confirmed one app-mode window and a second call
raising it rather than opening another — and the Linux path is ported
faithfully with its *decision* covered by a test that runs on macOS. Nobody has
watched a window appear on Linux, and a test of what a launcher would run says
nothing about that; CI here is push-only on macOS. That gap is accepted rather
than closed. If a Linux board ever opens wrong, start here, and note that #158
touches the same boundary next.

The criterion that could have failed silently did not: a snapshot written, the
server stopped, the file opened from disk with networking blocked — drawing,
transcript and numbered steps intact, at full and narrow width. Its new suite
carries a negative control, so the offline check cannot pass vacuously. That is
the shape to copy; a snapshot that opens empty passes every other test in the
repo.

**`open` moved onto Effect here rather than in #158**, decided mid-round: the
port was already open in the same files. #158 is correspondingly narrower —
`serve`, plus the `open` *command* wired to Effects that now exist. The round
also turned up #186: a browser that vanishes between the check and the launch
throws uncaught, which in the MCP server takes every tool down with it. It is
old behaviour, carried across faithfully rather than fixed in a port.

### Round 8 — unblocked now

| | | unblocks |
|---|---|---|
| #153 | A React board, served beside the old one (Phase 4) | #154 → #155 → #156 → #157 |
| #158 | `serve` and the `open` command on the Effect CLI (Phase 3) | #159 → #160 |

They do not touch each other: #153 is a new app served alongside, #158 is the
CLI. #186 belongs with #158 or just after it — the error channel it needs is
already there, and fixing it anywhere else means touching the same boundary
twice.

**#153 is the first round of phase 4**, and the first that is not a port: a
second board, served beside the old one, judged on whether it draws the same
thing rather than on byte-identical output. Expect it to want more review
rounds than a port did, and brief it with that in mind.

### The human track, startable now

**#146, the MCP spike**, and **#136** (`board_draw` advertises a real schema,
which needs four real MCP clients). #151 waits on both.

**#146** is Effect's MCP module versus the official SDK wrapped, decided on
cold start. It is gated on nothing, it is the one unstable-module risk in the
plan, and it produces the ADR that de-risks #151 long before phase 3 arrives.
The best use of your own hands while agents port the core.

## What to check before calling any of these done

The oracle is not the suite alone.

```sh
pnpm test          # 18 suites, inside dist/
pnpm run lint      # the browser rule, over the source tree
pnpm run typecheck # root plus every package, strict
pnpm run pack      # the tarball npm would publish
```

And, per round:

- **Pictures byte-identical.** Gallery, examples, regressions and now shapes are
  all byte-checked by `smoke.mjs`. An intended change goes in its own PR.
- **The p99.** Any change touching the server or the reducer re-runs
  `persist.mjs`, which asserts the per-op work on `POST /op` stays under 0.2 ms.
- **Cold start.** An MCP client times out on a slow server. `node -e
  "import('./dist/src/mcp/server.js')"` is ~0.03 s; keep it there. Effect
  loaded eagerly in `board/server.js` costs 70 ms on a path that decodes
  nothing, which is why the Schema is imported at `listen`.
- **The browser, which the suite barely sees.** A green run does not mean a
  working board. Anything reachable from the page gets looked at, in a browser,
  at a narrow width too.
- **That the suite ran at all.** Since #182 the harness reads every suite's
  exit code, so a failure is a failure. Before it, two of them were failing
  into a green run. Read the count: 18 passed, not "no output".

## Two things this queue keeps getting right by accident

Written down so they stay deliberate.

**Replace, don't duplicate.** A JavaScript module is deleted in the same PR
that adds its TypeScript replacement. There is never a period with two
implementations, and never a long-lived migration branch.

**Refuse what would draw nothing; describe the rest.** The reducer draws a kind
it has no glyph for as a service box and warns, because a wrong outline
mid-sentence beats a missing box and there is no second chance to ask. The
Schema follows that: it refuses types, describes values, and tightens only
where an op used to answer `ok` and draw nothing at all.
