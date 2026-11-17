# spiega — 3 minute demo script

A narrated screencast. Opens on the problem (a wall of prose), then the same
answer as a board being drawn. Voiceover over a real terminal and a real board
window — nothing staged in a mockup.

**Target: 3:00.** Narration is ~430 words, which is slow on purpose: the board
has to be allowed to draw. Where it says *(beat)*, stop talking and let the pen
move.

## Before you record

```bash
spiega stop --all                      # no stale boards in `spiega boards`
spiega open --size 1200x900 --pos 700,60
```

- Terminal left, board window right, both filling the screen. The board window
  is chromeless, so the frame reads as one app, not a browser.
- Terminal font large enough to read at 1080p — the commands are the subtitles.
- Have `docs/examples/webhook-retry-compare.svg` open in a separate viewer for
  shot 1, and `examples/webhook-retry.json` ready for shot 2.
- Dry-run the whole thing once. The drawing animation timing is the only part
  you cannot edit later.

---

## 1 · The problem (0:00 – 0:28)

**On screen.** Full-frame: the left column of
`docs/examples/webhook-retry-compare.svg` — the model's prose answer, 384
words, at the size it is actually read. Slow scroll down. Don't let the board
half enter frame yet.

> You ask your agent where your webhook events are going. This is the answer.
> It is a good answer — it names the right bug and gives the right fixes.
>
> And to agree with it, you have to hold seven names in your head at once —
> Stripe, the endpoint, Redis, the topic, the worker, Postgres, the dead-letter
> queue — and work out which store is written when, and where a crash has to
> land to lose the event.
>
> The answer contains the picture. You have to rebuild it.

**On screen.** Cut — hard, no transition — to the right column: the same answer
as a board. Hold for two full seconds in silence.

> That is the same answer.

---

## 2 · Drawn while it is explained (0:28 – 1:20)

**On screen.** Back to the live setup: terminal left, empty board right. Type
the question into the agent as a normal chat message — no flag, no mode:

```
walk me through how our Stripe webhook path loses events, on the board
```

**Beat.** Let the agent start. Boxes begin landing in the board window, one at
a time, lines appearing in the transcript rail beside them.

> This is the agent answering in the terminal the way it always does. The board
> is the same explanation, drawn as it is said.
>
> *(beat — let three or four boxes land)*
>
> Nothing here was placed by hand. The agent draws a box, then the arrow into
> it, and the columns come from the arrows: a node sits one column right of
> whatever points at it.
>
> The shapes carry weight. The queue and the Redis cylinder are drawn
> differently because one is a log you replay and the other is a copy you can
> afford to lose. There are fifteen of these — and four that mean nothing
> infrastructural, so an explanation about a cell or a gas doesn't have to
> borrow software's nouns.
>
> *(beat)*
>
> And the sentences on the right are not captions. They are what the agent was
> saying at the moment each thing was drawn.

**On screen.** Let it finish. The handwritten callout — *two writes, no
transaction* — should land under the endpoint while you're on that last line.

---

## 3 · Walking the flow (1:20 – 2:05)

**On screen.** Click into the board window. Press `→` once. Step 1 lights
orange, everything else dims, and the matching transcript line lights with it.
Walk through with `→`, pausing on each.

> A finished board is still a wall. So the flow is numbered, and you walk it.
>
> One hop lights, the rest recede — and the line that explains *that* hop
> lights with it.
>
> *(beat — two or three more presses)*
>
> It goes the other way too.

**On screen.** Click a transcript line further down the rail. The board jumps
to that step.

> Read a sentence, click it, and the board walks to the hop it describes. Click
> the step that's already lit and it clears. Lines about the board as a whole
> aren't tied to a step, aren't clickable, and don't pretend to be.

**On screen.** In the terminal:

```bash
spiega script
```

> Which line belonged to which step is usually clear only afterwards — so you
> can tie them up after the fact, without drawing anything a second time.

```bash
spiega tag --match "retry is discarded" --step 4
```

---

## 4 · Replay (2:05 – 2:35)

**On screen.** Focus the board, press `r`. Let the replay run — the camera
moves to wherever the work is, words captioned over the picture, ending on the
wide shot.

> The board keeps the order it was drawn in, not just its final state. So press
> `r`, and the session plays back as it happened: the line that was said, then
> the thing it was about being drawn.
>
> *(beat — let it play, say nothing for five or six seconds)*
>
> On anything complex, the finished board is a wall and the replay is the
> explanation. The agent can offer it too — same session, run again, nothing
> re-sent and nothing thought out twice.

---

## 5 · The rest, fast (2:35 – 2:52)

**On screen.** Quick cuts, one command each, roughly two seconds apiece.

```bash
spiega chapter "the fix"      # set this one aside whole, keep going
spiega chapters               # tabs across the top, with a map pinned first
spiega snapshot -o board.html # one standalone file, no server
spiega boards                 # four agents, four tasks, four boards
```

> Long explanations get chapters, each keeping its own drawing and its own
> script. Any board saves to a single standalone HTML file. And a board belongs
> to one conversation — four parallel agents get four boards, named after the
> task, not one drawing with four explanations on it.

---

## 6 · Close (2:52 – 3:00)

**On screen.** Clean terminal, two lines, typed:

```bash
npm install -g spiega
spiega install
```

Then the finished board, full frame, with step 3 lit. Hold. Cut to the mark and
the repo URL.

> Two commands. It finds the agents on your machine and wires itself in.
> No dependencies, no build step, no account — a local server and a directory
> of your own boards.
>
> Then start a fresh session and ask for something architectural. On the board.

---

## Notes on what got cut, and why

- **`spiega bench`** — comparing how different models draw the same brief is a
  great feature and a terrible thing to put in a first video: it only lands for
  someone who already believes the boards are worth comparing. Make it its own
  60-second clip.
- **The Kalman example** — the stronger *picture* of the two, and the better
  argument that this isn't only for microservices. But the webhook one opens
  better, because the viewer has had that bug. If you want the breadth, put the
  Kalman board on screen under shot 5's narration instead of the command cuts.
- **Why not Mermaid / Miro** — this is an argument, not a shot. It's in the
  README, and the cut in shot 1 makes it without saying it.
- **`spiega draw` from a shell** — useful, but it frames spiega as a drawing
  tool you operate. The video should leave you thinking the agent does this.
