# @spiega/core

The typed domain: the op union and the board Schema, the reducer, the script,
the tape, the map, the camera and settle. Everything here is pure, and
everything here runs **in a browser as well as in node** — the board page
imports it directly. No `node:` builtin and no node-only dependency may ever
be reachable from this package; #133 turns that into a lint rule.

Empty today. The JavaScript it will own still runs from `src/board/` and
`src/spec.js`, and moves in here as each module is ported: the op Schema in
#135, the reducer in #137, script, tape, map and camera in #138, settle in
#139.
