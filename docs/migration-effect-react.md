# Migration plan: TypeScript + Effect + React

> What to pick up next, in what order, and what each one costs:
> [migration-rounds.md](migration-rounds.md). This page is the design; that one
> is the queue.

**Status:** proposal. No code has changed yet.
**Decision taken:** the "no dependencies, no build step" convention in `AGENTS.md` is dropped. Users still get a zero-setup `npx spiega`, because npm ships a built `dist/`. Contributors run `pnpm install`.
**Decision taken:** pnpm workspaces; Vite + Vitest for the board; tsdown or tsup for the node packages; **Node as the only runtime**. Bun is something a contributor may reach for ad hoc — `bun install` and `bunx vite` work — but CI and the published artefact never depend on it.
**Later:** the board UI is structured so React can be swapped for Foldkit once Foldkit reaches 1.0 and its licence is clear.

---

## 1. Goals and non-goals

**Goals**

- A typed domain, **Schema first**: every op, the board, chapters and steps are defined once as Effect Schema. Types, decoders, MCP tool schemas and test generators all derive from that definition.
- Effect for everything that has effects: HTTP server, SSE, op log persistence, MCP, CLI, install/doctor.
- React for the board page (`board.html` today).
- Every board renders **byte-identical** to today throughout the migration.
- `npx spiega` and every MCP client integration keep working at every step.

**Non-goals (during the migration)**

- No rendering, layout or behaviour changes. Look-and-feel work (see the improvement proposal) happens *after* the board page is on React, not twice.
- No Effect inside the pure renderer. Geometry and layout stay plain, strict TypeScript.
- No Foldkit yet.

---

## 2. What is being migrated

| Layer | Modules (lines) | Runs in | Notes |
|---|---|---|---|
| **Domain** (pure) | `board/state.js` (941), `script.js` (251), `settle.js` (184), `tape.js` (181), `map.js` (151), `camera.js` (103), `draw-on.js` (95), `spec.js` (74) | node + browser | `state`, `script`, `settle`, `map`, `tape` already `// @ts-check`. `applyOp` **mutates** the board, and that's deliberate (see the POST /op budget). |
| **Render** (pure) | `render.js` (280), `layout.js` (713), `glyphs.js` (705), `edges.js` (436), `math.js` (391), `floating.js` (375), `ink.js` (341), `audit.js` (304), `callout.js` (228), `theme.js` (93), `geom.js` (66) | node + browser | `render`, `layout`, `floating`, `geom` checked. `theme`, `ink`, `glyphs`, `edges`, `callout`, `math` carry ~234 strict errors. `renderSVG` returns `{ svg: string, width, height, boxes, … }`. |
| **Node I/O** | `board/server.js` (1023), `mcp/server.js` (424), `board/open.js` (203), `log.js` (175), `snapshot.js` (116), `export.js` (52), `home.js` | node | Routes: `/src/*` static, `POST /op`, `/settle`, `/close`, `/state`, `/whoami`, SSE `/events`. MCP is hand-rolled newline-delimited JSON-RPC with 13 `board_*` tools. Origin checks covered by `test/origin.mjs`. |
| **CLI / setup** | `cli.js` (1038), `install.js` (674), `doctor.js` (651), `migrate.js` (271), `bench.js` (246), `pi.js`, `toml.js`, `agents-block.js`, `term.js` | node | Writes agent configs. Tests run with an isolated HOME. |
| **Board page** | `board/board.html` (1756, ~226 top-level functions), `narrate.js` (334) | browser | Imports domain + render modules unbundled. Uses `speechSynthesis`. Exported pages inline modules as `data:` URLs via an import map (`export.js`). |
| **Vendored** | `vendor/dagre.esm.js` | node | Used once, at `settle`. |
| **Tests** | `test/smoke.mjs` (4783) + 10 suites + `test/boards/*.json` | node | Byte-checked `docs/gallery`, `docs/examples`, `docs/regressions` SVGs. `POST /op` added latency < 0.2 ms p99 (`test/persist.mjs`). |

---

## 3. Principles

1. **Always shippable.** Every phase ends with a green suite and a releasable package. No long-lived migration branch.
2. **The pictures are the oracle.** Gallery, examples and regression SVGs must regenerate byte-identical. Any diff fails the PR unless it's intended, and an intended change goes in a separate PR.
3. **Migration PRs don't change behaviour.** Port first, improve later.
4. **Replace, don't duplicate.** A JS module is deleted in the same PR that adds its TypeScript replacement. There's never a period with two implementations.
5. **Effect at the edges, pure TS in the middle.** Effect for I/O, concurrency, resources, config and errors. Plain functions for geometry, layout and the reducer.
6. **The browser rule survives.** `core` and `render` must stay browser-safe. This becomes a package boundary plus a lint rule (no `node:` imports, no Node-only deps), replacing today's graph-walk test.
7. **Strict stays strict.** No `any`, no `@ts-ignore`, no loosened flags. That's the existing rule, carried over.
8. **The hot path stays hot.** `POST /op` does no I/O and no awaiting on writes. The p99 benchmark stays in the suite and is re-run after every server change.
9. **Node is the only runtime.** One engine, as load-bearing as the browser rule: CI runs Node and the published artefact runs on Node, so no code, script or test may require another runtime to pass. A contributor is welcome to reach for Bun locally — `bun install`, `bunx vite` — and nothing may come to depend on their having done so.

---

## 4. Target architecture

```
spiega/
├─ packages/
│  ├─ core/        Schema: Op, Board, Surface, Chapter, Step, Line
│  │               reducer (applyOps), script, tape, map, camera, settle
│  │               deps: effect (Schema), @dagrejs/dagre       ← browser-safe
│  ├─ render/      renderSVG, layout, glyphs, ink, edges, math, callout, audit
│  │               deps: core                                  ← browser-safe, pure
│  ├─ server/      Effect HttpServer, SSE, op buffer + flush, op log,
│  │               snapshot/export, origin/token middleware, MCP server
│  │               deps: core, render, effect, @effect/platform-node
│  ├─ board/       React + Vite app (today's board.html), narrate
│  │               deps: core, render, react
│  └─ cli/         @effect/cli: serve, install, doctor, migrate, bench
│                  deps: server, effect
└─ spiega (published) = cli + server + built board assets, bundled into dist/
```

- **Workspace:** pnpm workspaces with TypeScript project references.
- **Build:** `tsdown` or `tsup` for the node packages; Vite for `board`. One publish artefact: `spiega` with a `bin`.
- **Data flow is unchanged:** agent → MCP tool → `POST /op` → reducer → SSE → board page → `renderSVG`.

---

## 5. Key design decisions

### D1. Ops as a Schema union (the centrepiece)

Today `board_draw` declares `ops` as a bare `object` (or an array of them), and op shapes live only in prose and in `applyOne`'s `switch`. Define them once:

```ts
// packages/core/src/Op.ts
import { Schema } from "effect"

export const NodeKind = Schema.Literal(
  "client", "gateway", "service", "compute", "datastore", "cache", "queue",
  "external", "note", "formula", "blob", "vessel", "particle", "source",
)

export const NodeOp = Schema.Struct({
  op: Schema.Literal("node"),
  id: Schema.optional(Schema.String),
  kind: NodeKind,
  label: Schema.String,
  sub: Schema.optional(Schema.String),
})

export const EdgeOp = Schema.Struct({
  op: Schema.Literal("edge"),
  from: Schema.String,
  to: Schema.String,
  label: Schema.optional(Schema.String),
  async: Schema.optional(Schema.Boolean),
})

export const SayOp = Schema.Struct({
  op: Schema.Literal("say"),
  text: Schema.String,
  step: Schema.optional(Schema.NullOr(Schema.Int)),
})

// … title, tag, note, callout, boundary, step, group, flow, focus,
//   settle, remove, clear, chapter, amend

export const Op = Schema.Union(NodeOp, EdgeOp, SayOp /* , … */)
export type Op = typeof Op.Type
```

> Each struct is discriminated by a literal on the existing `op` field (not Effect's default `_tag`), so the wire format and every existing op log stay valid.

From this single definition:

| Derived | Used for |
|---|---|
| `typeof Op.Type` | Reducer, render and board types; replaces the JSDoc typedefs |
| `Schema.decodeUnknownEither(Op)` | `POST /op` validation, with path-precise errors returned to the agent instead of today's `notAnOp` strings |
| `JSONSchema.make(Op)` | The MCP `inputSchema` for `board_draw` / `board_amend`: a real `oneOf` per op instead of `object` |
| `Arbitrary.make(Op)` | Property tests that fuzz `applyOps` (no throws, invariants hold, replay = state) |
| Board Schema | Decoding op logs on restore; versioned transformations for old logs instead of `migrate.js` ad hoc fixes |

**Watch:** MCP clients differ in how much JSON Schema they understand (`oneOf`, `const` discriminators). Test the generated schema in Claude Code, Claude Desktop, Cursor and opencode. If one chokes, emit a flattened variant for that client.

### D2. The reducer stays pure-ish and mutable

`applyOp` mutates the board and sweeps removals. That's part of why `POST /op` fits in 0.2 ms p99. Keep the mutation **inside** the reducer and keep its signature. Don't introduce immutable copying on the hot path without the benchmark proving it's free. Its public contract (board in, result out, log appended) is what gets typed.

### D3. Server on `@effect/platform`

- `HttpRouter` routes mirror today's exactly (`/op`, `/settle`, `/close`, `/state`, `/whoami`, `/events`, static assets).
- **Op buffer:** `POST /op` applies ops and offers them to a `Queue`. A scheduled fiber flushes to the op log on the existing timer. No I/O on the request path, as `AGENTS.md` requires.
- **SSE:** a `Stream` per subscriber from a `PubSub` of state revisions.
- **Origin / token checks:** middleware. `test/origin.mjs` is ported first and must pass unchanged.
- **Errors:** tagged errors (`BoardNotFound`, `BadOp`, `LogWriteFailed`) mapped to the current HTTP responses.
- **Config & paths:** `Config` + a `SpiegaHome` service (replaces `home.js`). Tests provide a temp HOME via a layer instead of mutating `process.env`.

### D4. MCP server

Two options, decided by a one-day spike at the start of phase 3:

1. **Effect's `McpServer`** (`effect/unstable/ai` in v4, `@effect/ai` in v3). Tools are defined from Schema and the stdio transport comes from `@effect/platform-node`. Risk: it's marked *unstable*.
2. **The official TypeScript MCP SDK wrapped in Effect.** More stable, and slightly more glue.

Either way, keep the MCP layer a thin adapter over the board HTTP API, as it is today, so an agent on MCP and a human on the CLI still share one board. Keep `claimSession()` semantics (opencode's shared daemon). Measure **cold-start time**: MCP clients time out on slow servers, and an Effect runtime plus bundle must start as fast as today's dependency-free script.

### D5. Board page in React, shaped for a later Foldkit swap

- **Model** = a Schema (board + view state: active step, chapter, follow/fit, playback, voice).
- **Msg** = a tagged union of everything that can happen (SSE revision, key press, click step/node, play/pause…).
- **update** = a pure function `(Model, Msg) => [Model, Command[]]`, living in `board/src/app/` with no React imports.
- **React** only renders the model and dispatches messages (`useSyncExternalStore` over a tiny store). Moving to Foldkit later means rewriting only the view layer.
- **First iteration is byte-identical:** `renderSVG` still returns an SVG string, inserted into the stage. Componentising the SVG comes later, if ever.
- `camera`, `draw-on` and `narrate` become hooks/commands around the existing pure modules.
- The SSE hang that breaks headless screenshots today is avoided in tests by running the app against a **fixture store** (no server).

### D6. Standalone export

Today `export.js` inlines the module graph as `data:` URLs in an import map. In the new setup, Vite builds the board as a **single-file bundle** (e.g. `vite-plugin-singlefile`), and export injects the state JSON. Track bundle size: React plus Effect Schema in the browser is new weight for files people email around. If it's too heavy, keep Schema decoding server-side and ship plain types to the page.

### D7. dagre

Replace the vendored ESM with `@dagrejs/dagre` pinned to the same version. Verify settled boards stay byte-identical before deleting `vendor/`.

### D8. Tests

- **Runner:** Vitest, run under Node. The existing `.mjs` suites first run unchanged against built output, then get ported file by file.
- **Kept as-is:** byte-checked pictures, the p99 budget, isolated-HOME install tests, origin tests, regression boards.
- **New:**
  - property tests from `Arbitrary.make(Op)`
  - op-log golden tests using copies of real boards (anonymised) to prove restore round-trips
  - **Playwright** on the React board against fixture boards at 3 widths (520, 1024, 1440), compared with screenshots of today's page. This closes the gap `AGENTS.md` calls out ("the browser is a second consumer with almost no coverage").

---

## 6. Phases

Estimates are focused working days, AI-assisted, rough.

| Phase | Scope | Exit criteria | Est. |
|---|---|---|---|
| **0. Tooling** | pnpm workspace, strict `tsconfig`, tsdown/tsup + Vite, Vitest, lint rule "no `node:` in core/render", CI. Rewrite `AGENTS.md` conventions: dependencies allowed, build step, how agents run things, and **the runtime target is Node, single-engine** — a convention as load-bearing as the browser rule, and today only implied by `engines`. Existing JS keeps running via `allowJs`. | Suite green; `pnpm pack` → `npx spiega serve` works from the tarball on a clean machine; MCP starts in Claude Code; nothing in CI or the artefact needs a runtime other than Node. | 2–3 |
| **1. Core domain** | `Op`/`Board` Schemas; port `state`, `script`, `settle`, `map`, `tape`, `camera`, `spec`. MCP `board_draw` gets a generated `inputSchema`. dagre to npm. | All suites green; pictures byte-identical; p99 holds; real op logs round-trip; generated tool schema accepted by 4 clients. | 4–6 |
| **2. Render** | Port `theme`, `ink`, `glyphs`, `edges`, `callout`, `math` (the ~234 errors), then `render`, `layout`, `floating`, `audit`, `geom`. | Every gallery / example / regression SVG byte-identical. | 5–8 |
| **3. Server + MCP** | Effect HTTP server, SSE, buffer/flush, op log, snapshot/export, origin middleware, MCP (after the D4 spike), `open`. | Route contract tests identical; `test/origin.mjs` and p99 pass; MCP smoke test in Claude Code, Claude Desktop, Cursor, opencode; cold start ≤ today + 100 ms. | 5–8 |
| **4. Board page** | React app per D5; narrate; single-file export per D6. | Playwright fixture screenshots match today's page at 3 widths; exported HTML works offline; bundle size reported. | 8–10 |
| **5. CLI** | `@effect/cli` for `serve`, `install`, `doctor`, `migrate`, `bench`; identical commands and flags. | Install/doctor tests green with isolated HOME; `spiega --help` output unchanged except formatting. | 3–5 |
| **Later** | Swap the phase 4 view layer to Foldkit. | Foldkit ≥ 1.0, licence confirmed, a spike on step mode + camera passes. | — |

**Total: roughly 27–40 focused days.**

---

## 7. Ordering against the validation plan

- **Phases 0–1 help validation directly.** A typed `board_draw` schema means fewer malformed ops from weaker models, which is the "quality depends on the driving model" risk. Do these now.
- **Phases 2, 3 and 5 don't move validation.** Schedule them after the week-12 decision, or when there's spare time.
- **Phase 4 overlaps with the look-and-feel work** (LF-1 to LF-8). If validation passes, do phase 4 and the L&F changes together, porting first and then improving, so the board page is only rebuilt once.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Effect's MCP module is `unstable`; Effect v3 → v4 churn | Pin versions; isolate MCP behind an adapter; the D4 spike decides; the official SDK is the fallback |
| Cold start of the MCP process grows (runtime + bundle) | Measure in phase 0 and phase 3; bundle and minify the node entry; lazy-load server pieces the MCP path doesn't need |
| Standalone export gets heavy | Single-file build with tree-shaking; report size in CI; keep Schema decode server-side if needed |
| Byte-identical pictures break on innocent refactors (float formatting, iteration order) | Port module by module with the picture suite on every commit; never mix ports with fixes |
| The mutating reducer fights immutable instincts | Keep it mutable internally (D2); type the contract, not the implementation |
| Agents working in the repo follow outdated rules | Rewrite `AGENTS.md` in phase 0, before any code moves |
| Migration drags and stalls feature work | Replace-don't-duplicate; one phase at a time; phases 2–5 gated on validation |

---

## 9. Open questions

1. ~~**Effect v3 or v4?**~~ Settled: v4 — [ADR 0001](adr/0001-effect-v4.md). Whether its MCP module is the one we use is a separate question, spiked in #146.
2. ~~**Port `test/smoke.mjs` wholesale, or gradually?**~~ Settled: gradually, against the built output — [ADR 0002](adr/0002-port-the-suite-gradually.md).
3. **Does the hosted viewer** (from the product proposal) reuse `packages/board` directly? If so, design phase 4's store to work with both SSE (local) and a static, saved board (hosted).
