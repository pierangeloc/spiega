# 0002: Port the test suite gradually, against the built output

**Status:** accepted · 2026-11-20 · #130 · amended 2026-11-25 · #170

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

## Amendment: the suites stay `.mjs` (#170, 2026-11-25)

The migration is finished — `src/` and `packages/` are TypeScript, strict,
`allowJs` off (#160) — so "ported when there is a reason to touch it" has run
its course, and it is worth reading what it did.

It ported nothing. There is not one TypeScript test in this repository, in
`test/` or in any package. The ten rounds between this decision and #160 moved
every module the suites cover, and #160 itself edited `smoke.mjs` and
`persist.mjs` without either becoming TypeScript — because editing a suite
never required porting it. The trigger could not fire.

So the cost this ADR accepted, two idioms in `test/` for a while, never
arrived. `test/` has exactly one idiom, and a port would not end a split state;
it would open one. That changes the question from "finish what was started" to
"start something", and the answer to that is no:

- **Types buy least where these suites work hardest.** They assert on rendered
  SVG, child processes, temp HOMEs, git repositories in temp directories and
  the shape of a packed tarball. Very little of that surface is typed.
- **The drift they would catch is already caught, later the same day.** Every
  suite runs against `dist/` on every push, so a signature that moved in `src/`
  fails CI at once. Types would move that failure earlier, not surface one that
  is currently missed.
- **The risk is the one this ADR was written about**, now at 10,692 lines —
  4,983 of them in `smoke.mjs` alone. A rewritten assertion that quietly drops
  a case is invisible exactly when it matters, because everything stays green.
- **"Runs alone" would get worse.** `node dist/test/settle.mjs` is unambiguous
  about which tree it is testing. A `.ts` suite run from source under node's
  type stripping runs against the source tree — the one nobody installs.

`tools/*.js` stays JavaScript for the same reasons and is covered by the same
decision. `eslint.config.js` has a reason of its own: ESLint reads a TypeScript
config only behind an unstable flag.

What would reopen this: a suite becoming hard to navigate rather than hard to
type — `smoke.mjs` is the candidate — in which case the move is that one
file, deliberately, with the second idiom accepted and written down, and not
a sweep of the other twenty.
