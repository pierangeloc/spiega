# The skill an agent reads

The instructions that teach an agent to use spiega — when to reach for the
board, how much to put on it, and the two things that are easy to get wrong.

**The skill itself lives at [`skills/spiega/SKILL.md`](../skills/spiega/SKILL.md).**

That link is deliberate, and this page is not a copy of it. A second copy is
exactly what went wrong once already: `~/.claude/skills/spiega/SKILL.md` was a
*copy* for a while, it fell hours behind the source, and the agent reading it
went on insisting that features which had shipped did not exist. Skills are
symlinked now for the same reason this page is a pointer.

## How it reaches each agent

Three different delivery routes, because harnesses do not agree on any one of
them. `spiega install` writes whichever apply.

| route | who reads it | what it carries |
|---|---|---|
| **skill file** | Claude Code, Codex, Gemini CLI | the whole thing — judgement, vocabulary, worked examples |
| **`AGENTS.md` block** | opencode, Codex, Gemini CLI | a condensed version: when to draw, the two rules, where the detail is |
| **MCP tool descriptions** | anything speaking MCP | per-call guidance, attached to the tool it is about |

A skill is linked, not copied, so it tracks the checkout. An `AGENTS.md` block
is text inside a file you wrote, so it sits between `<!-- SPIEGA_START -->` and
`<!-- SPIEGA_END -->` and a reinstall replaces it in place. Tool descriptions
are read from the running MCP server, which is why a stale server shows an
agent stale guidance — see [`spiega doctor`](../README.md#updating-and-checking-that-it-took).

The block is generated from [`src/agents-block.js`](../src/agents-block.js),
and the condensing is the point: it sits in a file the agent reads on *every*
turn, so it buys its place in tokens.

## What the skill actually says

Summarised so you know whether to go and read it, not so you can avoid doing so:

- **When to draw.** Explaining how a system works — a request path, a
  comparison, a review, "how does X talk to Y". Not for everything.
- **Draw a few things at a time**, as you explain them, never the whole diagram
  in one call. A board that appears finished was not explained.
- **You never place anything.** Columns come from the edges.
- **Tag the lines that explain one step**, and only those. A line gets a tag
  because it is about that hop, not because it mentions something the hop
  touches. Over-tagging is how the step numbers end up out of order.
- **Never re-draw an explanation to show it again.** `spiega replay` plays the
  whole session back, words and all.

The vocabulary those instructions draw on — every op, every node kind, every
layout hint, and what the board cannot express — is in
[vocabulary.md](vocabulary.md).

## Changing it

Edit [`skills/spiega/SKILL.md`](../skills/spiega/SKILL.md). Nothing needs
reinstalling: the installed skill is a symlink to it.

If the change is one an agent needs on every turn rather than only when the
skill loads, it belongs in the `AGENTS.md` block too — that one *is* a copy, so
`spiega install` has to run again to update it, and `spiega doctor` reports a
block whose wording has fallen behind.
