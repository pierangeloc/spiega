# Wiring handwave into an agent

```bash
handwave install            # whatever is on this machine
handwave install --detect   # what that would be, without doing it
```

Every surface drives the same board, so an agent on MCP and a human in a
terminal can draw on it at the same time.

## What `install` writes, and where

| target | what it gets |
|---|---|
| `claude` | the skill, linked into `~/.claude/skills/` |
| `codex` | the skill, an `~/.codex/AGENTS.md` block, an `mcp_servers` table |
| `gemini` | the skill, a `GEMINI.md` block, `mcpServers` in `settings.json` |
| `opencode` | `mcp.handwave` in `opencode.json`, and an `AGENTS.md` block |
| `copilot` | `mcpServers` in `~/.copilot/mcp-config.json` |
| `cursor` | `mcpServers` in `~/.cursor/mcp.json`, and a rule |
| `windsurf` | `mcpServers` in `~/.codeium/windsurf/mcp_config.json` |
| `zed` | `context_servers` in Zed's `settings.json` |
| `vscode` | `servers` in VS Code's `mcp.json` |
| `claude_desktop` | `mcpServers` in `claude_desktop_config.json` |
| `herdr` | a plugin: reach this task's board from its pane — see [herdr/](herdr/) |
| `project` | an `AGENTS.md` block in the current repo — opt in by name |

No board name is pinned in the registration, deliberately: boards are per task,
not per harness, and the name is worked out per session. See the README.

Two decisions worth knowing:

**Skills are symlinked, not copied.** A copy goes stale the moment the source
changes, and a stale skill is worse than none: the agent reads it, believes it,
and never mentions the thing you shipped an hour ago. The link means the skill
is whatever the checkout currently says. MCP entries point at the checkout for
the same reason — though a *running* agent session holds the process it
started, so restart the session after changing handwave.

**Instruction files get a delimited block**, `<!-- HANDWAVE_START -->` to
`<!-- HANDWAVE_END -->`. Your own text is never touched, a second install
replaces the block in place rather than appending another copy, and the file is
backed up first. If the two markers are ever out of step — someone edited one
away — the install refuses rather than guessing where your text ends.

Why a block at all, when the MCP tool descriptions already carry guidance: a
tool description can say what a tool does, but not whether the board is worth
reaching for, how much belongs on it, or why a half-tagged script is worse than
an untagged one. That judgement lives in the skill, and most harnesses never
read a skill file. `AGENTS.md` is the one instruction file the field has
converged on.

## MCP — any client

For a harness `install` does not know, print the entry and paste it:

```bash
handwave mcp-config                  # {"mcpServers": {...}}  — the common shape
handwave mcp-config --shape servers  # VS Code
handwave mcp-config --shape opencode # opencode
handwave mcp-config --shape zed      # Zed
handwave mcp-config --shape toml     # Codex
```

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

Tools: `board_say`, `board_draw`, `board_step`, `board_tag`, `board_script`,
`board_replay`, `board_clear`,
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
