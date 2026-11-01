<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/logo/spiega-mark.svg" alt="" width="72" align="left" hspace="12">

# spiega

A hand-drawn board an AI agent draws on **while it explains**.

> *spiega* is Italian for *explain* — and for *unfold*, which is what this does to a long document: spreads it out until you can see the whole shape at once.
> 
> Say it **SPYEH-ga** (/ˈspjɛɡa/): two syllables, stress on the first. It is the sound English keeps missing in *piano*, which Italian says the same way.

You ask how something works. The agent answers in the terminal, as usual — and
beside it, a board fills in: boxes for the services, labelled arrows for the
calls, a dashed enclosure round the VPC, a note where the gotcha is. Then it
walks the request through, one numbered hop at a time.

It is meant for the thing a terminal is bad at: holding six nouns and the
arrows between them in your head while you read a paragraph about them.

![a finished board, saved as a snapshot, with step 3 lit](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/board.png)

**[Install](#install)** · **[What it can draw](#what-it-can-draw)** · **[Examples](#two-examples)**

## Why not Miro, or Mermaid

Miro is an external platform. This is a pane beside the conversation the agent is
already having. The board is kept — its log lives at
`~/.spiega/boards/<name>.jsonl` and comes back the next time that board is
opened, so you can close the window and pick the explanation up later.
`spiega clear` empties it.

Mermaid renders a finished diagram. This is drawn incrementally, in the order
the explanation goes, which is most of what makes it followable — and it looks
drawn, not generated. The notes are synchronized with the elements being put in evidence, so it reads as somebody thinking along with you.

## What it can draw

Fourteen node kinds, each with its own drawing. Eight are classic software UML-ish boxes —
a browser, a gateway, a service, a replica set, a database, a cache, a queue,
and something you do not own. Two are writing on the board: a note and a
formula. Four carry no infrastructure meaning, so a figure about a cell or a
gas does not have to borrow software's nouns.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-software.svg" width="760" alt="client, gateway, service, compute, datastore, cache, queue and external nodes">

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-neutral.svg" width="540" alt="blob, vessel, particle and source nodes">

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-writing.svg" width="510" alt="a note and a formula written on the board">

<p/>

An arrow can be plain, carry a label, be dashed because the caller does not
wait for it, or carry the number of a flow step:

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/edges.svg" width="520" alt="a plain edge and a labelled edge">

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/edges-async.svg" width="520" alt="an async dashed edge and an edge carrying a numbered flow step">

<p/>

A `boundary` groups boxes, a `callout` points at something without crowding it,
and a `note` sits in the margin:

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/boundary.svg" width="700" alt="a dashed boundary around Orders and Postgres">

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/callout.svg" width="460" alt="a callout pointing at an edge">

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/note.svg" width="700" alt="a note in the left margin beside a path from Orders to Postgres">

<p/>

A flow numbers the hops, lights one at a time, and dims the rest — with the
numbered hops also laid out as a list beside the drawing:

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/flow.svg" width="760" alt="a three-step flow with step one lit, and the numbered list beside the drawing">

<p/>

Every picture is rendered by the board's own renderer and regenerated with
`node tools/gallery.js`, so it cannot drift from what you will see. The full
tour — all fourteen kinds, the title bar, and the code for each — is in
[the gallery](https://github.com/pierangeloc/spiega/blob/main/docs/gallery.md).

## Two examples

Let's show 2 practical examples of what Spiega can give us when we ask a model for an explanation. Both answers are mostly *relationships between named things* — the case a long
paragraph is often too verbose and convoluted. 

One is a bug in a running system; the other is a piece of mathematics that
happens to be running on a robot. Each is shown twice: the answer a capable model gives in prose, written
out in full, and the same answer as a board.

### 1. Software: the webhooks that never update an order

**The question.**

> We take Stripe webhooks. The endpoint checks the signature, claims `event_id`
> in Redis with `SETNX`, and only if the claim is new does it add the event to
> `webhook-events` and return `202`. A worker consumes it and updates the
> order. Last week three orders never moved to `paid`, even though Stripe shows
> those events as delivered, and one customer was charged twice after a retry.
> Stripe says it retried. Where do the events go?

**The answer a model gives without a board.** It names the right bug, gives the
right fixes, and would be enough to act on.

<!-- prose:webhook:start -->
> Both symptoms come from the same shape: this path writes to two stores that cannot commit together, and it acknowledges work before the work is durable.
>
> **The loss is between the claim and the enqueue.** `SETNX event_id` in Redis and `XADD` to `webhook-events` are two independent writes. If the process dies, the pod is evicted, or the produce times out after Redis has said "new", the event is marked seen and no message exists. Stripe sees the failure and retries — and the retry makes it worse: `SETNX` returns 0, the endpoint returns 202, and the second attempt is discarded *because the first one failed*. No error, no DLQ row, and Stripe correctly reports delivery.
>
> Make the claim and the message durable together. The cheap fix: do not return 202 until the produce has succeeded, and make the claim two-phase — `pending` before the produce, `done` after — so a retry that finds `pending` republishes instead of deduping. The thorough fix removes Redis from the ack path: insert the raw event into an inbox table and publish from a poller, so the claim and the intent to publish are one commit. An outbox written by the transaction that changes the order is the same idea with the order as the source of truth.
>
> **The duplicates are the same problem one hop later.** If the consumer commits its Kafka offset before the Postgres commit lands — or auto-commits on a timer — a crash in between redelivers the message. That is harmless only if the handler is idempotent: `UPDATE orders SET status = 'paid' WHERE id = $2 AND status <> 'paid'` is; `balance = balance + amount`, or a capture call to Stripe, is not. Key the effect on `event_id`, not on delivery count, and ack after `COMMIT` with manual commit.
>
> **The third window is the DLQ.** An event that fails three times is parked, but the endpoint already returned 202 and the `event_id` is seen, so no retry brings it back. The DLQ needs an alarm and a replay command, or it is where events go to be forgotten.
>
> The rule that ties it together: the dedupe record must live in the same durability domain as the effect it guards, and the ack must come after the durable effect, not after the attempt.
<!-- prose:webhook:end -->

The same answer, on the board:

![the webhook path, its two commit points, and the numbers of the walk-through](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/examples/webhook-retry.svg)

Side by side, at the size each is actually read:

![the model's answer as a column of text beside the same answer as a board](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/examples/webhook-retry-compare.svg)

384 words against 23 ops — one op per box, per line, per handwritten note, per
numbered hop, which is what an agent emits while it talks. Neither number is
the point on its own. The point is what you have to do with either column.

The prose is serial. To agree with it you hold seven names — Stripe, the
endpoint, Redis, the topic, the worker, Postgres, the DLQ — and the windows
between the writes in your head at once, then work out which store is written
when, which one holds the acknowledgement, and where a crash has to land to
lose the event. The answer tells you all of it, and a careful reader can
rebuild the picture. That rebuilding is the cost.

The board hands the picture over, and then says three things on top of it: the
two writes with no transaction, written under the endpoint; redelivery, written
on the consume hop where it happens; the ack, written under the worker. The
shapes carry weight too — the queue and the Redis cylinder are drawn
differently because one is a log you replay and the other is a copy you can
afford to lose, and the DLQ branch is visibly a dead end.

The board is worse at what prose is good at: you can grep a sentence, quote it
in a postmortem, paste it into a ticket. The honest claim is narrower than "a
drawing beats a wall of text" — for a system with several named parts and the
arrows between them, the drawing removes the reconstruction, and the prose
still carries the argument. Which is why the agent does both.

Neither picture was drawn by hand. The board is generated from
[`examples/webhook-retry.json`](examples/webhook-retry.json), and the
comparison from that spec plus the very paragraphs printed above, so the word
count is a count of them and the board cannot show something the renderer no
longer draws.

A board this wide is close to the limit of what a README column can show. Open
the [full-size SVG](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/examples/webhook-retry.svg)
if the labels are small at this width — or just run it, where the board gets a
whole pane and `spiega step 3` lights one hop at a time.

### 2. Engineering: which sensor should the robot believe?

**The question.**

> I am fusing GPS with wheel odometry on a small robot. The GPS jitters by a
> couple of metres but never drifts; the odometry is smooth but walks away
> within a minute. The Kalman filter mostly works and I can follow the algebra,
> but I do not understand what it is actually deciding. And why does the
> estimate lurch when the wheels slip?

**The answer a model gives without a board.**

<!-- prose:kalman:start -->
> The filter is not choosing between your two sensors. Every step it decides how far to move its current belief towards the new measurement, and that distance is a ratio of two uncertainties.
>
> **It tracks how wrong it expects to be.** Alongside the position estimate the filter carries a covariance, P, which is its own claim about how unsure it is. Prediction steps the state forward with the odometry and adds process noise Q, so P grows: every second without a fix, the filter knows less. The measurement arrives with its own noise, R. In the scalar case the gain is K = P-/(P- + R), model uncertainty over total uncertainty. If the prediction is ten times less certain than the fix, K is near 1 and the estimate jumps most of the way to the GPS. If the fix is the noisy one, K is near 0 and the estimate barely moves. Nothing in there asks which sensor is better in general, only which is less sure right now.
>
> **What gets corrected is the disagreement.** The correction is K times the innovation, the difference between the fix and what the model expected. That is why the two failure modes you describe cancel: GPS jitter is zero-mean, so repeated small corrections average out rather than accumulating, while odometry drift is a steady bias that the innovation sees as a growing disagreement and keeps pulling back. Each sensor covers the other's weakness, and the gain is what decides the balance moment by moment.
>
> **The lurch is Q being wrong, not the filter.** Q is a claim about how far the motion model can be off in one step. Wheel slip violates it: the odometry reports travel that did not happen, and the error is far larger than Q admits. The filter has no way to know. It still believes its prediction is good, so P- stays small, K stays small, the GPS fix is discounted as noise, and the estimate follows a prediction that is simply wrong. It recovers, but slowly, because it has to accumulate enough innovation to overcome its own confidence.
>
> The fix is not a larger Q everywhere, which throws away the odometry's real precision between slips. It is to notice the slip and inflate Q for those steps, from a wheel-encoder disagreement, an IMU, or a current spike. Failing that, gate on the innovation itself: if it is much larger than the square root of P- + R, the filter's own numbers say something it believes cannot be true, and that is the moment to stop trusting the model.
<!-- prose:kalman:end -->

**The same answer, on the board.**

![a hand-drawn board: a prediction and a GPS fix meeting at an innovation, a gain formula weighing one uncertainty against the other, both feeding an update that produces an estimate, and a dashed line carrying that estimate back round to become the next prediction](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/examples/kalman.svg)

Side by side, at the size each is actually read:

![the model's answer as a column of text beside the same answer as a board](https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/examples/kalman-compare.svg)

432 words against 23 ops. Six boxes, seven lines. The prediction and the fix converge on one place, the
gain hangs off the prediction because that is the only input the filter
controls, and the dashed line running back underneath is the thing the algebra
hides: the output of one step is the input to the next, which is why a textbook
derivation keeps saying "at time k" and a reader keeps losing track of which k.

The formula is on the board rather than in the margin because here the equation
*is* the explanation. One ratio decides everything the filter does, and
everything else on the board is what feeds it or what it produces.

This is the example where the prose keeps the most. The reason jitter and drift
cancel is an argument about zero-mean versus bias, and that is reasoning, not
structure: no arrangement of boxes shows it. What the board holds still is where
the loop closes and what the gain is weighing, so the paragraph next to it has
somewhere to land.

## Install

Node 20 or newer. No dependencies and no build step, so there is nothing to
compile and nothing to wait for.

Everything runs on your machine: a local server on `127.0.0.1:4777`, no
account, no sign-up, no network calls. The board is an ordinary web page —
`spiega open` gives it a chromeless window of its own if you have Chrome,
Brave, Edge or Chromium, and otherwise opens a tab in your default browser.
State is written under `~/.spiega`.

Developed and used on **macOS**, and tested on macOS and Linux across Node 20,
22 and 24. Windows paths are in the code and nobody has run them in anger — if
you are on Windows, expect to file the first issue, and say so and it will get
fixed.

### 1. Get it on your PATH

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

### 2. Wire it into your agents

This step needs a coding agent that can run an MCP server or read a skill file —
the table below lists the ones spiega knows about. **MCP** (Model Context
Protocol) is the standard those agents use to call external tools; a **skill**
is a markdown file an agent loads as instructions. If you have neither, skip to
[Use it yourself](#use-it-yourself): drawing from a shell needs nothing wired in
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

Anything but yes is no. Where there is nobody to ask — a script, CI, an agent's
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

### Updating, and checking that it took

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

### Developing on spiega, or just using it

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
spiega render my-spec.json -o my-spec.html    # a spec file you wrote
spiega snapshot -o my-board.html              # whatever is on the board now
```

The specs under [`examples/`](examples/) ship inside the package as well as the
repo, so to render one of those, point at where it actually is — from a clone,
`spiega render examples/order-flow.json -o out.html`.

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

## What the agent actually draws

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
{"op":"callout","at":"orders","side":"below","label":"two writes, no transaction"}
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

## One board per conversation

A board belongs to an explanation, and people hold more than one at a time. Two
agents drawing on the same board interleave two explanations into one picture,
which is worse than either having none — so boards have names.

```bash
spiega boards                      # every board, and which one this shell uses
spiega focus                       # bring this session's board window forward
spiega --board api draw '...'      # or SPIEGA_BOARD=api
spiega stop                        # drop this board; the others keep drawing
spiega stop --all                  # all of them, and the server with them
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

## One server, all the boards

They all live in one process, on port 4777, each under `/b/<name>`. It used to
be a process and a port per board, and the arithmetic was indefensible: the
Node runtime is 55-70 MB and a board with nine boxes is a few KB of state, so
eight parallel tasks spent ~600 MB holding a few hundred KB of drawing.

The second reason is staleness, and it is the one that actually bit. A server
per board meant a board started before an update kept serving the old page for
as long as it lived — one of them 404'd on a route the code on disk had — while
the isolation that a process per board bought had never once been needed.

So: one port, no scanning upward, one copy of the renderer served to every
board, and every board running the code that is on disk. Starting a board is a
map entry on a process that is almost certainly already up; the port itself is
the lock, so two agents drawing at the same moment do not end up with two
servers. `spiega stop` drops one board and leaves the rest drawing;
`spiega stop --server` ends the process and everything on it.

`spiega serve --solo` gives a board its own process and its own port if an
isolation case ever turns up. Clients cannot tell the difference: the url shape
is the same either way, and `spiega boards` says which boards are on their own.

If you run your sessions in [herdr](https://herdr.dev), `spiega install herdr`
links a plugin that goes from the pane you are working in to that task's board —
bind a key to **spiega: show this task's board**. It reads the pane's working
directory rather than the conversation, so it needs nothing from the agent.
See [`integrations/herdr/`](integrations/herdr/).

## Compare how models use it

```bash
spiega bench --list                     # models you can reach right now
spiega bench "how a write-through cache works" \
  --models github-copilot/claude-opus-5,github-copilot/gpt-6-sol
```

Runs the same brief through each model via `opencode run`, parses the ops out of
whatever it replied with, renders each board, and writes `bench/index.html`
comparing them side by side — boxes, lines, steps, how many edges it bothered to
label, how many kinds it reached for. Each model's raw reply is kept next to its
board. Runs are isolated and never touch a live board.

## How it is put together

| | |
|---|---|
| `src/render/ink.js` | seeded wobble: the geometry that makes a line look drawn |
| `src/render/glyphs.js` | one drawing per kind — service, cylinder, queue, cloud, note |
| `src/render/edges.js` | gutter routing, fan-out anchors, numbered tags |
| `src/render/layout.js` | columns from the flow, order-stable so nothing jumps |
| `src/board/state.js` | the board as an op log |
| `src/board/server.js` | one process, every board; HTTP + SSE, and the renderer as plain ES modules |
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
