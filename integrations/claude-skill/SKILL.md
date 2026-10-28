---
name: handwave
description: Draw on a live hand-drawn board while explaining software architecture — services, queues, datastores, boundaries, and a numbered request flow you can walk through step by step. Use whenever you are explaining how a system works, comparing designs, tracing a request, reviewing an architecture, or answering "how does X talk to Y" — anything where a picture beside the words would help. Also use when the user says board, draw it, sketch it, show me the architecture, or diagram this.
---

# handwave

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
handwave draw '{"op":"title","text":"Placing an order"}'
```

That starts a board if none is running and prints its URL.

Then give it a window, once, at the start:

```bash
handwave open --size 1200x900
```

That is a chromeless window of its own, which is where panning and zooming are
comfortable. Mention it in a few words and move on — do not read the URL out.

If the person prefers the board inside their terminal, `terminal-browser open
"$(handwave url)" --split right --size 0.5` puts it in a pane. Good for
glancing and for stepping a flow; poor at zooming, since the pane pushes every
frame through the TTY. Offer it, do not default to it.

## Drawing

One op at a time, as the thing comes up in what you are saying.

```bash
handwave draw '{"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn + rate limit"}'
handwave draw '{"op":"edge","from":"gw","to":"orders","label":"gRPC"}'
handwave say  "The gateway does **authn** and rate limiting, then hands off."
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

Other ops:

```bash
# a keyword or an aside, stuck on the board
handwave draw '{"op":"note","label":"idempotency key\nlives 24h"}'

# an enclosure around things that share a trust zone or a deployment
handwave draw '{"op":"boundary","label":"our VPC","members":["gw","orders","db"]}'

# an async hop: drawn as a dashed line
handwave draw '{"op":"edge","from":"orders","to":"bus","label":"publish","async":true}'

# several at once, when they really are one thought
handwave draw '[{"op":"node","id":"db","kind":"datastore","label":"Postgres"},
                 {"op":"edge","from":"orders","to":"db","label":"INSERT"}]'
```

Ids are optional — a label becomes one (`"API Gateway"` → `api-gateway`). Pass
`id` when you will refer to it in an edge, which is most of the time.

You never place anything. Columns come from the edges: a node sits one column
right of whatever points at it. Draw the node, then the edge into it, and it
lands where it belongs. Nodes already on the board keep their lane.

## Walking a flow

When the point is the *order things happen in*, add steps, then walk them.

```bash
handwave draw '[{"op":"step","edge":"browser>gw","step":"Browser posts the order"},
                 {"op":"step","edge":"gw>orders","step":"Gateway authenticates and forwards"},
                 {"op":"step","edge":"orders>db","step":"Write the order row"}]'
handwave step 1     # that hop turns orange, both ends halo, the rest dims
handwave step next
```

Each step's number appears on its line, so the board and your prose share one
numbering. Walk a step as you explain it, not all at once — the person can also
walk them with the arrow keys.

## Finishing

```bash
handwave snapshot -o docs/order-flow.html
```

One standalone file: the drawing with its full ink-and-paper texture, what was
said, and the numbered steps. Good in a PR or a doc. Offer it when the
explanation was worth keeping; do not save one every time.

## Judgement

- **A board earns its place or it does not get drawn.** Three boxes and two
  arrows that make a dependency obvious: yes. A restatement of a list you just
  wrote: no. If the words are already clear, skip the board and say so.
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
- Starting a new explanation? `handwave clear` first. A board holding two
  unrelated systems is worse than no board.

## When something is wrong

Drawing the same `id` again updates it instead of adding a second one, so a
correction is just the op again with the right fields. `handwave draw
'{"op":"remove","id":"gw"}'` takes a thing off. Nothing you draw is permanent
and nothing needs to be right first time — correcting the board out loud is
what a real whiteboard session looks like.
