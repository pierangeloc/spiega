# Wiring handwave into an agent

All three surfaces drive the same board, so an agent on MCP and a human in a
terminal can draw on it at the same time.

## Claude Code / claude.ai — skill

```bash
mkdir -p ~/.claude/skills/handwave
cp integrations/claude-skill/SKILL.md ~/.claude/skills/handwave/
```

Needs `handwave` on PATH (`npm link`, or `npm i -g handwave`).

## Cursor — project rule

```bash
mkdir -p .cursor/rules
cp integrations/cursor/handwave.mdc .cursor/rules/
```

`alwaysApply: false` — Cursor loads it when the description matches what is
being asked. Set it to `true` if you want the board considered on every turn.

## MCP — any client

```jsonc
// claude_desktop_config.json, .mcp.json, or your client's equivalent
{
  "mcpServers": {
    "handwave": {
      "command": "node",
      "args": ["/absolute/path/to/handwave/src/mcp/server.js"]
    }
  }
}
```

Tools: `board_say`, `board_draw`, `board_step`, `board_clear`,
`board_snapshot`, `board_url`. The descriptions carry the same guidance as the
skill, so a client that only reads tool descriptions still behaves.

## Anything else

It is an HTTP endpoint. Find the board with `handwave url`, then:

```bash
curl -s -X POST "$(handwave url)/op" -H 'content-type: application/json' \
  -d '{"ops":[{"op":"node","id":"gw","kind":"gateway","label":"API Gateway"}]}'
```

`GET /state` is the board as JSON, `GET /events` is an SSE stream of it, and
`GET /snapshot` is the standalone file.
