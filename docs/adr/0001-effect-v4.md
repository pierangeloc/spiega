# 0001: Effect v4

**Status:** accepted · 2026-11-20 · decided in #130

## Context

The migration to TypeScript + Effect makes Schema the centrepiece: ops, the
board, chapters and steps are defined once, and the types, the decoder at
`POST /op`, the MCP tool schemas and the test generators all derive from that
one definition. Schema's API differs between Effect v3 and v4, so the version
is not an implementation detail of one module — it is the shape of the thing
every later phase is written against. Choosing late, or changing our mind
after phase 1, means rewriting the definition that everything else reads.

## Decision

Effect v4.

It was released a few months ago, it has taken over v3's share of downloads,
and the major Effect projects are on it. Picking v3 now would mean migrating
twice: once from JavaScript, and again from v3 to v4 while the whole domain is
already expressed in it.

## Consequences

- The op union, the board Schema and every derived artefact are written
  against v4's Schema API. Examples and answers written for v3 need
  translating, and there are more of those in circulation.
- Effect's MCP module is the one piece whose stability still matters most to
  us, because an agent-facing server that will not start is worse than one
  with a hand-rolled JSON-RPC loop. That question is not settled by this ADR:
  #146 spikes it against the official TypeScript MCP SDK wrapped in Effect and
  measures cold start both ways, and the fallback stays available.
- Versions are pinned. Churn in a fast-moving major is absorbed deliberately,
  in its own change, not picked up by a lockfile refresh in the middle of a
  port whose oracle is byte-identical pictures.
