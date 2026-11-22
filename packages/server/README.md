# @spiega/server

The HTTP server, the event stream, the op buffer and its flush, the op log,
snapshot and export, the origin middleware, and the MCP adapter.

Empty today. The JavaScript it will own still runs from `src/board/` and
`src/mcp/`, and moves in here across #147–#151.

Two things that are not negotiable when it does: `POST /op` does no file I/O
and awaits no write, and `test/origin.mjs` passes unchanged.
