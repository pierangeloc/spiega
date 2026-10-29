---
name: spiega
description: Draw on a live hand-drawn board while explaining software architecture — services, queues, datastores, boundaries, and a numbered request flow you can walk through step by step. Use whenever you are explaining how a system works, comparing designs, tracing a request, reviewing an architecture, or answering "how does X talk to Y" — anything where a picture beside the words would help. Also use when the user says board, draw it, sketch it, show me the architecture, or diagram this.
---

# spiega

A board in a browser pane that you draw on **while you are talking**, the way
someone explains a system at a whiteboard. You keep answering in the terminal;
the board carries the boxes, the arrows and the keywords.

## The one rule

**Draw as you talk, not after.** Say a sentence, draw the thing that sentence is
about, say the next one. Never compose the whole diagram and push it in one
call — that is a picture, and the person loses the thread it was supposed to
carry. Small ops, interleaved with your prose, are the entire point.

Your terminal answer stays the explanation. The board is not a transcript of it
and not a summary of it: it holds the few nouns and arrows that are hard to keep
in your head while reading.

## Starting

```bash
spiega draw '{"op":"title","text":"Placing an order"}'
```

That starts a board if none is running and prints its URL.

Then give it a window, once, at the start:

```bash
spiega open --size 1200x900
```

That is a chromeless window of its own, which is where panning and zooming are
comfortable. Mention it in a few words and move on — do not read the URL out.

If the person prefers the board inside their terminal, `terminal-browser open
"$(spiega url)" --split right --size 0.5` puts it in a pane. Good for
glancing and for stepping a flow; poor at zooming, since the pane pushes every
frame through the TTY. Offer it, do not default to it.

## Drawing

One op at a time, as the thing comes up in what you are saying.

```bash
spiega draw '{"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn + rate limit"}'
spiega draw '{"op":"edge","from":"gw","to":"orders","label":"gRPC"}'
spiega say  "The gateway does **authn** and rate limiting, then hands off."
```

`node` kinds, each with its own drawing:

| kind | use it for |
|---|---|
| `client` | a browser, an app, whoever is calling |
| `gateway` | an API gateway, a load balancer, an ingress |
| `service` | an ordinary service or module |
| `compute` | a replica set, a worker pool (`"replicas": 3`) |
| `datastore` | a database, a bucket, anything durable |
| `cache` | a cache, a read replica, a copy of truth from elsewhere |
| `queue` | a topic, a queue, a stream (`"depth": 4` fills slots) |
| `external` | a third party, drawn as a cloud |
| `note` | your own handwriting: a keyword, a caveat, a number |
| `formula` | an equation that *is* the explanation |

Other ops:

```bash
# a keyword or an aside, stuck on the board
spiega draw '{"op":"note","label":"idempotency key\nlives 24h"}'

# an enclosure around things that share a trust zone or a deployment
spiega draw '{"op":"boundary","label":"our VPC","members":["gw","orders","db"]}'

# a remark about one thing, on a leader line pointing at it
spiega draw '{"op":"callout","at":"gw>orders","label":"retried 3 times"}'

# an async hop: drawn as a dashed line
spiega draw '{"op":"edge","from":"orders","to":"bus","label":"publish","async":true}'

# several at once, when they really are one thought
spiega draw '[{"op":"node","id":"db","kind":"datastore","label":"Postgres"},
                 {"op":"edge","from":"orders","to":"db","label":"INSERT"}]'
```

Ids are optional — a label becomes one (`"API Gateway"` → `api-gateway`). Pass
`id` when you will refer to it in an edge, which is most of the time.

You never place anything. Columns come from the edges: a node sits one column
right of whatever points at it. Draw the node, then the edge into it, and it
lands where it belongs. Nodes already on the board keep their lane.

## When the mathematics is the point

Some explanations are an equation. Write it rather than describing it:

```bash
spiega draw '{"op":"node","kind":"formula","id":"bernoulli",
  "label":"p + \\tfrac{1}{2}\\rho v^2 + \\rho g h = \\text{const}"}'
```

A small LaTeX subset: `^` `_`, `\frac`, `\sqrt`, `\vec{}`, Greek, the common
operators including `\nabla` `\partial` `\oint`, `\text{}` for words, and
function names like `\log`. Spacing is derived as in LaTeX, so `a+b` and
`a + b` are the same. Enough for vector calculus — Maxwell's equations render
in either form.

Anything outside the subset — matrices, aligned environments, limits above and
below a sum — appears on the board **as you typed it**, dimmed. That is
deliberate, and it means you should not reach for them: rewrite the idea as
something a person would actually put on a whiteboard, or say it in a line of
the script instead.

## Walking a flow

When the point is the *order things happen in*, add steps, then walk them.

```bash
spiega draw '[{"op":"step","edge":"browser>gw","step":"Browser posts the order"},
                 {"op":"step","edge":"gw>orders","step":"Gateway authenticates and forwards"},
                 {"op":"step","edge":"orders>db","step":"Write the order row"}]'
spiega step 1     # that hop turns orange, both ends halo, the rest dims
spiega step next
```

Each step's number appears on its line, so the board and your prose share one
numbering. Walk a step as you explain it, not all at once — the person can also
walk them with the arrow keys.

### Tag the line with the step it explains

**Whenever a line you say is about one step, say which step.** The board has two
halves: the script on the left, the drawing on the right. Stepping the flow
lights one hop of the drawing — and if your lines are tagged, the matching
sentences light with it and the rest of the script recedes. Untagged, the
reader is left matching sentence to picture by hand, which on a six-step flow
is most of the work.

```bash
spiega say "The browser **POSTs** the order; nothing is trusted yet." --step 1
spiega say "The gateway checks the token, then forwards over \`gRPC\`." --step 2
spiega say "Only after the commit does it publish \`order.placed\`." --step 4
```

`--step N` is the number as it appears on the board. `--edge browser>gw` names
the hop instead, which survives steps being added or reordered later.

Three rules, and they are easy:

0. **Say the lines in step order, when the flow is the spine.** The rail shows
   what you said, in the order you said it. Explain the change topic by topic
   while tagging each line with whatever step it touches, and the numbers come
   out 2, 1, 3, 3, 4, 3, 6 — which reads as a sorting fault, though nothing
   sorted anything. Walk the flow in order and narrate as you go.

- A line about one hop of the flow gets that step's number. Do this for every
  such line, not some of them — a half-tagged script highlights unevenly.
- **Tag a line because it is about that hop, not because it mentions something
  the hop touches.** "Roles changed: only administrators may link now" is about
  the change, not about the step where the link is written. An over-tagged
  script is as unhelpful as an untagged one, and it is how tags end up out of
  order.
- An opening or closing remark — "six hops from the browser to the ledger",
  "the whole path is idempotent" — gets **no** tag. It is about the board as a
  whole and should never dim.
- If you narrate *while* walking (`spiega step 2`, then say the line for it),
  the link is recorded for you and the tag is optional. Tagging is still
  better: it survives the person walking the steps themselves afterwards.

Nothing is guessed. A board whose lines carry no tags simply does not
highlight, so an untagged explanation is a worse explanation, not a broken one.

### Fixing it afterwards

You will sometimes finish an explanation and only then see which lines went
with which step — or be asked why the script does not light up. Tag it then;
the board keeps the lines, so nothing has to be drawn or said again.

```bash
spiega script                              # the lines, numbered, and what each is tied to
spiega tag 4 --step 3                      # by number
spiega tag --match "Flyway V25" --step 6   # by its words, which is what you actually have
spiega tag 1 --step off                    # an opening remark belongs to no step
```

`spiega script` is also the honest check on your own work. If it says most
lines are tied to nothing, the person is reading an unlit rail; if it says the
tags run backwards, the script and the flow are telling two different stories
and the reader has to reconcile them.

## Playing it back

A board keeps the order it was drawn in, so the explanation can be run again
for nothing:

```bash
spiega replay
```

Every box, line and spoken word in sequence, camera following, captions over
the picture. **Never re-draw an explanation in order to show it again** — the
log is already there. Offer a replay when a long explanation lands all at once,
or when someone asks to see it once more; it is the cheapest thing in the tool.

## Finishing

```bash
spiega snapshot -o docs/order-flow.html
```

One standalone file: the drawing with its full ink-and-paper texture, what was
said, and the numbered steps. Good in a PR or a doc. Offer it when the
explanation was worth keeping; do not save one every time.

## Judgement

- **A board earns its place or it does not get drawn.** Three boxes and two
  arrows that make a dependency obvious: yes. A restatement of a list you just
  wrote: no. If the words are already clear, skip the board and say so.
- **You do not wait to be asked.** The test is a countable one — three or more
  named things and the relationships between them — and it is yours to apply
  while you are writing the answer, not the person's to apply before it. If
  drawing genuinely is a detour, say so in one line and offer: *want this on
  the board?* A silent skip decides for them, and they cannot decide
  otherwise, because nothing on their screen says a board was an option.
- **Fewer boxes.** Eight or ten is a board someone can hold in their head.
  Twenty is a map, and a map is a different, worse answer to "how does this
  work". Draw the part under discussion, not the system.
- **Label the arrows.** `gRPC`, `INSERT`, `publish` — an unlabelled arrow only
  says that two things are connected, which the person already knew.
- **`sub` is for the thing that changes the design**: `3 replicas`,
  `authn + rate limit`, `idempotency`. Not a restatement of the label.
- **Use `note` for the sentence the diagram cannot hold** — the constraint, the
  gotcha, the reason the order matters.
- Colour is assigned by kind and means something across the whole board. Only
  pass `body` (`tomato` `mustard` `mint` `cobalt` `blush` `slate` `paper`) when
  you are deliberately grouping things that the kinds do not already group.
- Starting a new explanation? `spiega clear` first. A board holding two
  unrelated systems is worse than no board.

## When something is wrong

Drawing the same `id` again updates it instead of adding a second one, so a
correction is just the op again with the right fields. `spiega draw
'{"op":"remove","id":"gw"}'` takes a thing off. Nothing you draw is permanent
and nothing needs to be right first time — correcting the board out loud is
what a real whiteboard session looks like.
