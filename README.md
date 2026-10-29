# spiega

A hand-drawn board an AI agent draws on **while it explains**.

*spiega* is Italian for *explain* — and for *unfold*, which is what this does
to a long document: spreads it out until you can see the whole shape at once.

You ask how something works. The agent answers in the terminal, as usual — and
beside it, a board fills in: boxes for the services, labelled arrows for the
calls, a dashed enclosure round the VPC, a note where the gotcha is. Then it
walks the request through, one numbered hop at a time.

It is meant for the thing a terminal is bad at: holding six nouns and the
arrows between them in your head while you read a paragraph about them.

![a finished board, saved as a snapshot, with step 3 lit](docs/board.png)

## Why not Miro, or Mermaid

Miro is a place you go. This is a pane beside the conversation that the agent
is already having, and the board is gone when you are done unless you keep it.

Mermaid renders a finished diagram. This is drawn incrementally, in the order
the explanation goes, which is most of what makes it followable — and it looks
drawn, not generated, so it reads as somebody thinking rather than a document.

## Install

Node 20 or newer. No dependencies and no build step, so there is nothing to
compile and nothing to wait for.

### 1. Get it on your PATH

```bash
gh repo clone pierangeloc/spiega
cd spiega
npm link                  # puts `spiega` on your PATH, pointing at this checkout
```

`npm link` rather than a copy on purpose: everything below — the CLI, the MCP
server, the agent skill — resolves to this directory, so `git pull` updates all
of it at once. (Not on npm yet, hence the clone.)

Check it:

```bash
spiega help
```

### 2. Wire it into your agents

```bash
spiega install --detect     # what it would do, touching nothing
spiega install              # do it
```

`install` with no arguments does only what it finds on this machine, because
writing a config for a harness you do not use is how you end up with a file you
never asked for. `--list` shows every target and what it writes.

| target | what it gets |
|---|---|
| `claude` | the skill, linked into `~/.claude/skills/` |
| `codex` | the skill, an `AGENTS.md` block, an `mcp_servers` table |
| `gemini` | the skill, a `GEMINI.md` block, an `mcpServers` entry |
| `opencode` | `mcp.spiega` in `opencode.json`, and an `AGENTS.md` block |
| `copilot` `cursor` `windsurf` `zed` `vscode` `claude_desktop` | the MCP server, in each one's own config shape |
| `herdr` | a plugin: reach this task's board from its pane |
| `project` | an `AGENTS.md` block in the repo you are in — ask for it by name |

Everything is idempotent and backs up what it rewrites. Skills are
**symlinked**, so they track the checkout instead of going stale. Instruction
files get a delimited `SPIEGA_START`/`SPIEGA_END` block that leaves your own
text alone. For a harness nothing here knows about, `spiega mcp-config`
prints the entry to paste.

### 3. See that it works

```bash
spiega draw '[{"op":"title","text":"Hello"},
                {"op":"node","id":"gw","kind":"gateway","label":"API Gateway"},
                {"op":"node","id":"db","kind":"datastore","label":"Postgres"},
                {"op":"edge","from":"gw","to":"db","label":"SQL"}]'
spiega open             # a window of its own
```

Two boxes and a line, drawn on. If you see them, every layer is working: the
board, the renderer and the CLI.

### 4. Restart your agent

A running agent session holds the MCP process it started, and that process has
the code it was launched with. **Start a fresh session after installing**, or
the agent will be reading an older spiega than the one on disk. The symlink
keeps files current; it cannot do anything about processes already running.

Then ask for something architectural — "walk me through how X talks to Y, on
the board" — and watch the pane.

### Coming from handwave

This was called `handwave` until it wasn't — the word means *baseless, skipping
the hard part*, which is the opposite of the point. One command moves a machine
over, and it is safe to run twice:

```bash
spiega migrate     # old state dir, skills, MCP entries, AGENTS.md blocks
spiega install     # register under the new name
npm unlink -g handwave
```

`HANDWAVE_BOARD`, `HANDWAVE_URL` and `HANDWAVE_SESSION` still work alongside
their `SPIEGA_` equivalents, and `~/.handwave` is left as a link to
`~/.spiega`, because a process that started before the rename has the old path
compiled into it — an MCP server from a session that began minutes ago would
otherwise register boards where the new command cannot see them. Run
`spiega migrate` again once those sessions have ended and it removes the link.
**Restart your agent sessions**: they also hold the old command name, which is
gone from PATH. If you
bound a herdr key to `handwave.board.focus`, change it to `spiega.board.focus`
— `migrate` says so rather than editing your config. `spiega doctor` reports
anything the old name left behind.

### Updating, and checking that it took

```bash
cd spiega && git pull && npm test
spiega install          # only the copies need this: AGENTS.md blocks, the Cursor rule
spiega doctor           # is what is running the thing that is on disk?
```

spiega reaches an agent through four kinds of thing, and they go stale
differently:

| | goes stale when |
|---|---|
| the CLI, via `npm link` | never — it is this checkout |
| a skill, symlinked | never — but the agent loaded it when its session started |
| an `AGENTS.md` block, a Cursor rule | the wording changes — re-run `spiega install` |
| **a running process** | **immediately — it holds the code it was launched with** |

The last one is the trap, and it is the one that looks like a feature that was
never built. `spiega doctor` finds it:

```
 spiega doctor ──────────────────────────────────────────

  ✓ spiega on PATH     ~/.nvm/…/spiega → this checkout
  ✓ claude skill         linked — tracks the checkout
  ✓ opencode AGENTS.md   block is current
  ✗ agent MCP server     16 running, 16 started before the current commit

  To fix
    → start a fresh agent session — a running one keeps the server it launched
```

It exits non-zero when something is wrong, so it can go in a shell prompt or a
pre-flight check. It makes no network calls and changes nothing.

### If you use herdr

```bash
spiega install herdr
```

Then bind a key, in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+h"
type = "plugin_action"
command = "spiega.board.focus"
```

`herdr server reload-config`, and that key brings the board for whatever pane
you are in to the front — starting one if there is none.

## Use it yourself

```bash
spiega draw '{"op":"title","text":"Placing an order"}'   # starts a board, prints its URL
spiega draw '{"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}'
spiega draw '{"op":"node","id":"orders","kind":"service","label":"Orders"}'
spiega draw '{"op":"edge","from":"gw","to":"orders","label":"gRPC"}'
spiega say  "The gateway does **authn** and rate limiting, then hands off."
```

Give the board a window of its own — chromeless, no tabs, its own Dock entry,
so it sits beside your terminal like a native panel:

```bash
spiega open --size 1200x900 --pos 60,60
```

Render a whole spec with no server, or keep what is on the board:

```bash
spiega render examples/order-flow.json -o order-flow.html
spiega snapshot -o docs/board.html
```

`spiega help` lists the rest.

**Replay.** A board holds the order it was drawn in, not just its final state,
so press **replay** (or `r`) and the session plays back as it happened: the
line that was said, then the thing it was about being drawn, with the camera
moving to wherever the work is and the words captioned over the picture. On
anything complex the finished board is a wall; the replay is the explanation.
It ends on a wide shot of the whole thing.

The log lives on the board, so a replay can also be asked for from outside —
`spiega replay`, or `board_replay` over MCP. An agent that has just finished
an explanation can offer to play it back without thinking the drawing out a
second time, and nothing is re-sent: it is the same session, run again.

**Clicking the script.** A line tagged with a step is a way into that step:
click it and the board walks there, so you can read a sentence and go straight
to the hop it describes rather than hunting for the number. Clicking the step
already lit clears it, so one gesture goes both ways. Lines tied to no step are
not clickable and do not pretend to be.

**Keys on the board:** `←` `→` walk the flow, `space` plays it, `r` replays the
session, `+` `-` zoom a step at a time, `0` or `f` fits, `esc` stops.

**Where to put the board.** `spiega open` gives it a real window and is the
right answer for anything interactive. A terminal pane (`terminal-browser
open "$(spiega url)"`) is good for *glancing* while you work and for stepping
a flow with the arrow keys — those repaint once per keypress. It is poor at
continuous zoom and dragging, because every frame has to be encoded and pushed
through the TTY however fast the page itself is. Both can watch the same board
at once.

## One board per conversation

A board belongs to an explanation, and people hold more than one at a time. Two
agents drawing on the same board interleave two explanations into one picture,
which is worse than either having none — so boards have names.

```bash
spiega boards                      # every board, and which one this shell uses
spiega focus                       # bring this session's board window forward
spiega --board api draw '...'      # or SPIEGA_BOARD=api
spiega stop --all
```

A board names itself after the task: the working directory's own name, which
for a worktree is the thing you called it — `domain-modeling-for-rights`, not a
uuid. A session keeps the board it already has, matched on whichever identity
its harness exposes (the conversation id, else the terminal pane, else the
directory). Two conversations about one repo get `name` and `name-2`, and
`spiega boards` prints each board's directory so they can be told apart.

Not per harness, per task: four opencode sessions and four Claude Code sessions
at once is the normal case, and a board per harness would put four
explanations on one drawing. Note that an MCP server started by a long-lived
daemon inherits that daemon's environment, so the CLI — which runs in the pane
— resolves the session correctly where MCP may not.

A board is registered by the process serving it and pruned when that process is
gone, so a name never resolves to a socket nobody is listening on.

If you run your sessions in [herdr](https://herdr.dev), `spiega install herdr`
links a plugin that goes from the pane you are working in to that task's board —
bind a key to **spiega: show this task's board**. It reads the pane's working
directory rather than the conversation, so it needs nothing from the agent.
See [`integrations/herdr/`](integrations/herdr/).

## Compare how models use it

```bash
spiega bench --list                     # models you can reach right now
spiega bench "how a write-through cache works" \
  --models github-copilot/claude-opus-5.5,github-copilot/gpt-6-sol
```

Runs the same brief through each model via `opencode run`, parses the ops out of
whatever it replied with, renders each board, and writes `bench/index.html`
comparing them side by side — boxes, lines, steps, how many edges it bothered to
label, how many kinds it reached for. Each model's raw reply is kept next to its
board. Runs are isolated and never touch a live board.



A Claude skill, a Cursor rule and an MCP server, all driving the same board —
see [`integrations/`](integrations/). The agent needs no new vocabulary: it
emits small JSON ops as it talks.

Every op, every node kind and every layout hint is in
[`docs/vocabulary.md`](docs/vocabulary.md), along with what the board does
*not* model — worth reading before asking for a sequence diagram. The
instructions the agent itself reads are in [`docs/skill.md`](docs/skill.md).

```jsonc
{"op":"node","id":"db","kind":"datastore","label":"Postgres","sub":"orders"}
{"op":"edge","from":"orders","to":"bus","label":"publish","async":true}
{"op":"note","label":"idempotency key\nlives 24h"}
{"op":"boundary","label":"our VPC","members":["gw","orders","db"]}
{"op":"step","edge":"gw>orders","step":"Gateway authenticates and forwards"}
{"op":"say","text":"The gateway checks the token first.","step":2}
```

A board has two halves, and a `say` can name the step it explains. Walking the
flow then lights the matching lines of the script while the others recede, so
the words and the picture move together. Lines about the board as a whole carry
no step and never dim; a line said while a step was lit is attributed for free.
Nothing is inferred beyond that — an untagged script does not highlight rather
than highlighting the wrong thing.

Which lines went with which step is often clear only afterwards, so tags can be
set on lines already said. The board keeps them; nothing is drawn again.

```bash
spiega script                              # the lines, numbered, and what each is tied to
spiega tag --match "Flyway V25" --step 6
spiega tag 1 --step off                    # an opening remark belongs to no step
```

The rail shows what was said, in the order it was said. So a script narrated
topic by topic, with each line tagged by whichever step it touches, comes out
`2, 1, 3, 3, 4, 3, 6` — which looks like a sort gone wrong, though nothing
sorted anything. `spiega script` says so when it happens, because from the
board you cannot tell the difference between that and a bug.

Nothing is ever placed by hand. Columns are derived from the edges — a node
sits one column right of whatever points at it — so the agent draws a box, then
the arrow into it, and the layout follows.

## How it is put together

| | |
|---|---|
| `src/render/ink.js` | seeded wobble: the geometry that makes a line look drawn |
| `src/render/glyphs.js` | one drawing per kind — service, cylinder, queue, cloud, note |
| `src/render/edges.js` | gutter routing, fan-out anchors, numbered tags |
| `src/render/layout.js` | columns from the flow, order-stable so nothing jumps |
| `src/board/state.js` | the board as an op log |
| `src/board/server.js` | HTTP + SSE; serves the renderer to the browser as plain ES modules |
| `src/board/board.html` | the pane: transcript rail, step strip, pan and zoom |
| `src/board/draw-on.js` | the hand: variable pen speed, uneven pauses, ink then colour |
| `src/mcp/server.js` | the same board as MCP tools |

Two separate things make it look hand-drawn, and both are needed. The geometry
is off true — `waver()` in `ink.js` pushes every point around a seeded wobble,
so a line bows rather than buzzing. And the *motion* is off true: a stroke is
drawn with keyframes whose progress runs ahead of and behind the clock, so the
pen hurries down a straight and slows coming round a corner, strokes start
before the one before has finished, and the colour only goes on once the
outline is closed. A constant-speed dashoffset tween reads as a machine tracing
a path, which is exactly what it is.

The wobble lives in the path data rather than in an SVG filter, so the board can
animate without recomputing a filter every frame. Snapshots, which are rendered
once and never animate, do get the full ink-and-paper filter on top.

## Credits

The look — warm paper, flat three-band bodies, the cobalt cast shadow, the
ink-and-grain filter — follows [Colorfigures](https://april-zhu.com/colorfigures)
by April Zhu (MIT), which is built on ISO-GLOW by April Zhu and
[iso-figure](https://github.com/MrBongoC/ai-iso-skill) by Tolga Cohce, both MIT.
Colorfigures draws machines in isometric 3D; spiega borrows its palette and
its hand, and points them at software architecture in 2D.

## License

MIT.
