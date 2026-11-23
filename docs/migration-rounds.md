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

**Phase 1 is the queue below.** The five workspace packages exist as stubs
whose `index.ts` names the issue that fills each one, and every board still
draws from the JavaScript in `src/`.

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

### Round 1 — the keystone, alone

**#135, the op union.** Everything else in phase 1 reads the shape it defines,
so a second agent writing against a moving union is rework. It also carries the
two conventions the change has to earn: `effect` as the package's first runtime
dependency, and the browser-rule exemption above.

### Round 2 — three tracks, in parallel

| | | watch |
|---|---|---|
| #137 | the reducer in TypeScript | the biggest module in the repo, and already `@ts-check`ed, so it is JSDoc → real types plus the fallout. Keep it **mutable**: that is why `POST /op` fits its budget. Gate on `persist.mjs`'s 0.2 ms p99, and do not let the new property tests argue it into immutability |
| #138 | script, tape, map, camera, spec | five modules, ~760 lines, mostly `@ts-check`ed already. The lowest-risk track in the phase |
| #139 | dagre from npm, settle ported | the version question is already answered: `vendor/README.md` pins `@dagrejs/dagre` **3.1.3** with a SHA-256, and the bundle is unmodified, so the `customOrder` hook settle relies on is in the package. The `smoke.mjs` test asserting the page never reaches `vendor/` or `settle.js` gets **updated**, not deleted. `AGENTS.md` still says dagre stays vendored — that sentence is this issue's to rewrite |

### Round 3

| | |
|---|---|
| #140 | old op logs restore through the Schema. Needs #135 and #137. One input only a human can supply: **copies of real op logs out of `~/.spiega`, anonymised**, as goldens — collect them during round 2 so the work is not blocked on it |
| #136 | `board_draw` advertises a real schema. Needs #135, and four real MCP clients, so it is `ready-for-human` |

### The human track, startable now

**#146, the MCP spike.** Effect's MCP module versus the official SDK wrapped,
decided on cold start. It is gated on nothing, it is the one unstable-module
risk in the plan, and it produces the ADR that de-risks #151 long before phase
3 arrives. The best use of your own hands while agents port the core.

## What to check before calling any of these done

The oracle is not the suite alone.

```sh
pnpm test          # 11 suites, inside dist/
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
