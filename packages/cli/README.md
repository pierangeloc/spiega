# @spiega/cli

`serve`, `open`, `install`, `doctor`, `migrate`, `bench` — on
`@effect/cli`, with the same commands and the same flags.

`serve`, `open`, `install` and `doctor` read their flags here (#158–#159);
`src/cli.ts` stays the entry point and keeps the command table, and `migrate`
and `bench` still run from `src/`.
