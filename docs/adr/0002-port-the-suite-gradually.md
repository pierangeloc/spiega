# 0002: Port the test suite gradually, against the built output

**Status:** accepted · 2026-11-20 · decided in #130

## Context

`test/smoke.mjs` and the ten suites beside it are what makes this migration
safe to attempt at all. They byte-check every gallery, example and regression
picture, they hold `POST /op` to its p99 budget, they install into an isolated
HOME, and they refuse a board server that would answer a page on the internet.

Two ways to carry them across: rewrite them for the new runner up front, or
keep them running as they are — against the built output — and port them file
by file behind the code they cover.

## Decision

Gradually. The existing suites run unchanged against the build, under Vitest
on Node, and each one is ported when there is a reason to touch it.

## Consequences

- A migration PR is read against the same assertions that passed before it.
  When a picture moves, the test that noticed is the one that has been
  watching that picture all along, not a fresh transcription of it that might
  have lost a case in translation.
- Tests therefore exercise the package's built artefact, which is also what
  users get. A build that breaks packaging fails the suite rather than
  surfacing after publish.
- For a while there are two idioms in `test/`: ported suites and original
  `.mjs` ones. That is accepted, and it is the smaller cost — a rewritten
  suite that silently drops an assertion is invisible exactly when it matters,
  because everything stays green.
- The suite can no longer run on a bare checkout with nothing installed. That
  promise is dropped deliberately as part of this migration, and `AGENTS.md`
  is rewritten in #134 to stop making it.
