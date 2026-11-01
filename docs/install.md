# Installing spiega

The short version is three commands, and it is in
[the README](../README.md#install). This is the rest: what gets written where,
how to update it, and what to do when an agent turns out to be reading a
different spiega than the one you think.

Spiega runs on Node 20 or newer, with no dependencies and no build step. The
board is an ordinary web page: `spiega open` gives it a chromeless window of
its own if you have Chrome, Brave, Edge or Chromium, and otherwise a tab in
your default browser.

Developed and used on **macOS**, and tested on macOS and Linux across Node 20,
22 and 24. Windows paths are in the code and nobody has run them in anger — if
you are on Windows, expect to file the first issue, and say so and it will get
fixed.

## 1. Get it on your PATH

```bash
npm install -g spiega
```

Or from a clone, if you want to change it:

```bash
git clone https://github.com/pierangeloc/spiega.git
cd spiega
npm link                  # `spiega` now points at this checkout
```

`npm link` rather than a copy on purpose: the CLI, the MCP server and the agent
skill all resolve to that directory, so `git pull` updates every one of them at
once.

Check it:

```bash
spiega help
```

## 2. Wire it into your agents

This step needs a coding agent that can run an MCP server or read a skill file —
the table below lists the ones spiega knows about. **MCP** (Model Context
Protocol) is the standard those agents use to call external tools; a **skill**
is a markdown file an agent loads as instructions. If you have neither, skip to
[Use it yourself](../README.md#use-it-yourself): drawing from a shell needs nothing wired in
at all.

```bash
spiega install --detect     # what it would do, touching nothing
spiega install              # do it
```

`install` with no arguments does only what it finds on this machine, because
writing a config for a harness you do not use is how you end up with a file you
never asked for. `--list` shows every target and what it writes.

It also links the command into a directory an agent's shell can see. That link
is the one write it makes outside a config file of its own, and when
`~/.local/bin` is not already on a non-interactive `PATH` it **asks** before
adding a line to your `~/.zshenv`:

```
  spiega needs to be where an agent can find it.
  ~/.local/bin is not on the PATH a non-interactive shell gets.

  This would add one line to ~/.zshenv, after backing it up:
      export PATH="$HOME/.local/bin:$PATH"

  Add it? [y/N]
```

N.B. Where there is nobody to ask — a script, CI, an agent's
own tool call — the answer is no and the line is printed instead, so an install
never hangs on a prompt and never edits a shell file unattended. `--path` and
`--no-path` answer in advance.

**Saying no withholds nothing else.** The skills and the MCP entries still
install, and MCP runs spiega by its full path, so it works. What you lose is
the fallback: an agent whose MCP server has died cannot find the command, and
writes prose instead of drawing with nothing on screen to say it meant to.
Install says so when you decline, and `spiega doctor` keeps saying so.

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

## 3. See that it works

```bash
spiega draw '[{"op":"title","text":"Hello"},
                {"op":"node","id":"gw","kind":"gateway","label":"API Gateway"},
                {"op":"node","id":"db","kind":"datastore","label":"Postgres"},
                {"op":"edge","from":"gw","to":"db","label":"SQL"}]'
spiega open             # a window of its own
```

Two boxes and a line, drawn on. If you see them, every layer is working: the
board, the renderer and the CLI.

## 4. Restart your agent

A running agent session holds the MCP process it started, and that process has
the code it was launched with. **Start a fresh session after installing**, or
the agent will be reading an older spiega than the one on disk. The symlink
keeps files current; it cannot do anything about processes already running.

Then ask for something architectural — "walk me through how X talks to Y, on
the board" — and watch the pane.

## Updating, and checking that it took

Installed from npm:

```bash
npm install -g spiega@latest
spiega install          # re-point the skills and MCP entries at the new copy
spiega doctor           # is what an agent reads the thing that is on disk?
```

`spiega --version` is the quick version of that question. It prints the number,
then which copy answered — the thing worth knowing once you have both an npm
install and a clone on the same machine:

```console
$ spiega --version
spiega 0.1.2
/Users/you/.nvm/versions/node/v22.14.0/lib/node_modules/spiega — installed from npm
node v22.14.0
```

From a clone:

```bash
cd spiega && git pull
spiega install          # only the copies need this: AGENTS.md blocks, the Cursor rule
spiega doctor
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

## Developing on spiega, or just using it

Installing the package changes the **command**. It does not change the **agent
setup files**, and those are what an agent actually reads. The two move
independently, which is the whole reason this section exists:

| | set by | points at |
|---|---|---|
| the `spiega` command | `npm install -g` / `npm link` | whichever you ran last |
| skills, MCP entries, `AGENTS.md` blocks | **`spiega install`** | wherever spiega was *when you ran it* |

So `npm install -g spiega` on a machine that once had the repo linked leaves
every agent still loading the working tree — uncommitted edits and all — while
`spiega` on your own PATH runs the published copy. Nothing warns you: both work,
and they are different code.

`spiega doctor` is what tells you, and it names the path it found:

```
  ✗ claude skill   linked to ~/Documents/…/spiega/skills/spiega, not this install
  ✗ claude MCP     points at ~/Documents/…/spiega/src/mcp/server.js
```

**To use the published version**, as anyone else would:

```bash
npm install -g spiega
spiega install          # rewires skills and MCP to the installed copy, backing up what it replaces
```

**To go back to developing**, with agents reading your working tree:

```bash
cd spiega && npm link
spiega install
```

Two things that bite:

- **Restart your agent sessions.** A running MCP server holds the code it was
  launched with, so until it restarts it keeps serving the old location
  whatever the config now says. `doctor` counts these.
- **Check `which -a spiega`, not `which spiega`.** An older install may have
  left a launcher in `~/.local/bin` or `/opt/homebrew/bin` with an absolute
  path baked in. Those shadow the npm copy or are shadowed by it depending on
  PATH order — and an agent's non-interactive shell often has a different PATH
  than yours.

## If you use herdr

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
