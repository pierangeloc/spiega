# 0003: Keep the hand-rolled MCP server

**Status:** accepted · 2026-11-25 · #146, and #151 declined

## Context

ADR 0001 left one question open, and named it the piece whose stability
mattered most to us: whether Effect's MCP module is the one we use. #146 was
the spike — Effect's `McpServer` against the official TypeScript SDK wrapped
in Effect — and #151 was the port that would follow from it. The plan's §D4
framed it as two options and said cold start decides, because an MCP client
that waits too long for a server simply does without its tools.

What is there today is `src/mcp/server.ts`: 465 lines, newline-delimited
JSON-RPC over stdio, thirteen tools, no dependencies, and — the fact the
rest of this turns on — **no import of Effect anywhere in its graph**. Every
tool is a `fetch` to the board's own `POST /op`, which is why an agent on MCP
and a human on the CLI draw on one board.

Two things changed since the plan was written. Effect's MCP module moved from
`effect/unstable/ai` to `effect/ai`, inside the `effect` package we already
depend on — so adopting it adds no dependency at all, and the official-SDK
option became the only one of the two that does. And the module is still marked
`@stability unstable`, as is the `Stdio` service `layerStdio` requires.

## The measurements

A minimal `McpServer` — one tool, `layerStdio`, `NodeStdio.layer` — stood up
and timed against today's server. `initialize` sent on stdin, reply read off
stdout, median of 5–7 runs, same machine, Node 26:

| | median `initialize` | |
| --- | --- | --- |
| today, hand-rolled, 13 tools | **38.2 ms** | the baseline |
| Effect `McpServer`, unbundled | **228.6 ms** | 6×, and ~90 ms past the budget |
| Effect `McpServer`, bundled and minified | **38.7 ms** | 317 KB, 1259 modules collapsed |

The budget in the plan's phase 3 is today plus 100 ms, so 138 ms. Unbundled,
the module misses it by itself: `import("effect/ai/McpServer")` alone costs
95–108 ms before a single layer is built, and that is the same cost
`src/board/server.ts` already routes around with a lazy `require` — whose
comment puts eager Effect at 70 ms on a path that "never decodes one" op.

Bundled, the module is free. That is the real finding: **Effect's MCP server is
affordable, and only in a shape we do not otherwise build.** The TypeScript
build here is deliberately unbundled, because the board page imports the
renderer off disk as plain modules; a bundled MCP entry is a second build
output, in the shape `tools/board.js` already uses for the React view.

## Decision

Neither option. **Keep the hand-rolled server.**

Both of #146's options were asked on the assumption that the MCP layer must be
rebuilt and only the means was open. The spike's own number removes the reason:
there is no performance case, there is no dependency case now that the module
ships inside `effect`, and what the module would buy on top — five protocol
revisions, resources, prompts, completions, notifications, `outputSchema`,
an HTTP transport, cache hints — is not asked for by any issue we have.

So #151 is declined rather than deferred. The adapter it describes is what
`src/mcp/server.ts` already is.

The schema work in #136 is unaffected and goes ahead: generating the tool
`inputSchema` from the op union needs `Schema.toJsonSchemaDocument`, which is
`@stability stable`, and nothing about which transport serves it. It is done at
build time precisely so the server stays Effect-free — generating costs 2 ms,
and importing `effect` in order to generate costs 115 ms.

## Consequences

- The migration ends with one module deliberately not ported.
  `src/mcp/server.ts` is TypeScript and strict like everything else — #160 saw
  to that — but its JSON-RPC loop stays hand-written, and that is a decision
  rather than an oversight. ADR 0001's open question is now closed, in the
  direction neither of its options expected.
- **The thing to protect is the import graph, not the line count.** 38 ms is a
  property of importing no Effect. Anything added to this server, or to anything
  it reaches, has to keep that true, and the cheapest way to lose it is an
  innocent `import { Schema } from 'effect'` for a validation that `POST /op`
  already does on the other side of a `fetch`.
- What we give up, said plainly: the protocol revision is pinned at 2024-11-05
  and newer ones are work rather than an upgrade; resources, prompts and
  structured output would each be hand-written; and the `initialize` handler
  echoed whatever `protocolVersion` a client asked for, which the module would
  have got right for free. These are worth revisiting if a client ever needs
  one of them — not before.

  The echo was the cheapest of the three to lose, and it is fixed (#203): the
  handler answers `2024-11-05` whatever is asked for, which is what the spec
  asks of a server that does not speak the client's revision, and makes the
  pin above a thing the server says rather than a thing it hides. The other
  two stand as written. Worth noting for the next person weighing this ADR:
  the decision cost a handful of lines here, not a feature — which is roughly
  the exchange rate the rest of it should be judged at.
- **What would reopen this:** an MCP feature we actually want that the
  hand-rolled loop makes awkward — resources, or a second transport — or the
  module reaching stable while we happen to be bundling that entry anyway. The
  numbers above are the test to re-run, and the bundled column says the answer
  would be affordable when it comes.
