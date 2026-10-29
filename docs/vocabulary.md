# What an agent can draw

Every handle the agent has over the board, and — further down — what the board
does not model, because that is the part you find out the hard way.

All of it is small JSON objects sent with `spiega draw`, or the `board_draw`
MCP tool. Ops are applied in order and the board is their accumulation.

## The ops

| op | what it does | fields |
|---|---|---|
| `node` | a box on the board | `id` `label` `kind` `sub` and the layout hints below |
| `note` | your own handwriting, in the left margin | `label` (`\n` for line breaks) |
| `edge` | a labelled line between two boxes | `from` `to` `label` `async` |
| `boundary` | a dashed enclosure around several boxes | `label` `members[]` |
| `callout` | a label joined to a point by a leader line | `at` `label` `side` |
| `step` | one numbered hop of the flow | `edge` `step` `lights[]` |
| `flow` | replace the whole flow at once | `steps[]` |
| `say` | a line of the script, beside the drawing | `text` `step` \| `edge` |
| `tag` | tie a line already said to a step | `line` \| `match`, `step` \| `edge` |
| `title` | the board's title | `text` |
| `focus` | light one step; `null` clears | `step` (0-based) |
| `remove` | delete a node and everything touching it | `id` |
| `clear` | wipe the board | `keepTitle` |

`id` is optional — a label becomes one, so `"API Gateway"` is `api-gateway`.
Pass it when you will refer to the node in an edge, which is most of the time.
Drawing the same `id` twice updates it rather than adding a second.

## Node kinds

Nine, each with its own drawing. An unknown kind falls back to `service`.
[shapes.md](shapes.md) shows what each one looks like.

| kind | drawn as | use it for |
|---|---|---|
| `client` | a window with a title bar | a browser, an app, whoever is calling |
| `gateway` | a box with a thick left edge | an API gateway, a load balancer, an ingress |
| `service` | a plain rounded box | an ordinary service or module |
| `compute` | stacked boxes | a replica set, a worker pool |
| `datastore` | a cylinder | a database, a bucket, anything durable |
| `cache` | a cylinder, lighter | a cache, a read replica, a copy of truth |
| `queue` | a row of slots | a topic, a queue, a stream |
| `external` | a cloud | a third party, something you do not own |
| `note` | a torn-off scrap | a keyword, a caveat, a number |
| `formula` | set mathematics, underlined | an equation that *is* the explanation |

Three fields only some kinds read:

| field | kinds | effect |
|---|---|---|
| `sub` | all but `note` | a second, smaller line under the label |
| `replicas` | `compute` | how many boxes are stacked |
| `depth` | `queue` | how many slots are drawn filled |

## Saying something *about* a thing

Every other label is attached to what it names — inside a box, or riding on an
edge. A `callout` is the exception: the words sit in clear space and a thin
line points at what they are about.

```json
{"op":"callout","at":"gw>orders","label":"retried 3 times, then dead-lettered"}
{"op":"callout","at":"db","side":"below","label":"the only durable thing here"}
```

`at` is a node id or an edge (`from>to`). `side` is `below` (the default),
`above`, `left` or `right`. There are **no coordinates** — the point is
derived, and the canvas grows if a label falls outside the board.

Use it for the caveat that would otherwise be crammed into an edge label, or
exiled to a note that points at nothing. A callout dims with its target when
another step is lit, because it is part of what that step means.

## Mathematics

A `formula` node sets a small subset of LaTeX. It is drawn, not typeset by a
library: the glyphs are the board's own monospace and the rules — fraction
bars, radicals — are hand-drawn with the same wobble as the boxes, so a
formula sits on the board rather than on top of it.

```json
{"op":"node","kind":"formula","id":"bernoulli",
 "label":"p + \\tfrac{1}{2}\\rho v^2 + \\rho g h = \\text{const}"}
```

| supported | |
|---|---|
| superscripts, subscripts | `v^2`, `a_i`, `x^{n+1}` |
| fractions | `\frac{a}{b}`, `\tfrac`, `\dfrac` |
| roots | `\sqrt{x^2 + y^2}` |
| Greek | `\rho` `\theta` `\Sigma` … upper and lower case |
| operators | `\cdot` `\times` `\approx` `\leq` `\neq` `\pm` `\sum` `\prod` `\int` `\oint` `\iint` `\partial` `\nabla` `\infty` `\to` `\Rightarrow` `\in` `\cup` `\cap` `\perp` … |
| vectors | `\vec{E}` — an arrow drawn over it; `\mathbf{E}` for the bold convention |
| accents | `\hat{n}`, `\bar{x}`, `\overline{}` |
| upright words | `\text{const}`, `\mathrm{}` |
| function names | `\log` `\ln` `\sin` `\exp` `\min` `\max` … |

Spacing is derived, not copied: as in LaTeX, a space in the source is ignored
and spacing comes from the operators, so `a+b` and `a + b` set identically.

Enough for vector calculus — all four of Maxwell's equations render, in
differential or integral form:

```
\nabla \times \vec{E} = -\frac{\partial \vec{B}}{\partial t}
\oint \vec{E} \cdot d\vec{A} = \frac{Q}{\varepsilon_0}
```

The arrow over a vector is *drawn*, not a character, so it wavers like every
other stroke. `\mathbf` works but SF Mono shows little between weight 600 and
800 — prefer `\vec`.

**Anything else is shown as written, dimmed.** `\begin{pmatrix}` appears
literally on the board rather than as half a matrix, because a formula that is
silently wrong is worse than one that visibly did not render. Matrices,
aligned environments, limits set above and below a sum, and stretchy
delimiters are all outside the subset — this is for the formulas people put on
a whiteboard while explaining something, not for a paper.

## Where things go

**You never place anything.** Columns come from the edges: a node sits one
column to the right of whatever points at it. Draw the box, then the edge into
it, and it lands where it belongs. Nodes already on the board keep their lane,
so a board drawn incrementally does not reshuffle under the reader.

Notes are the exception — they have no edges, so they go in a margin column of
their own, left of everything.

**Loops work, and need nothing special.** Point an edge back at a node already
drawn — `{"from":"sensor","to":"sum"}` — and that *is* the statement "the same
one, not a new one". The edge that closes the cycle is set aside when columns
are worked out, so the signal path still reads left to right, and it is routed
below the row and up into its target, which is what a loop looks like. Retries,
reconciliation, sagas and control loops all come out this way.

When the derived layout is wrong, three escape hatches exist, in the order the
layout consults them:

| field | meaning |
|---|---|
| `col`, `row` | absolute position. Wins over everything |
| `place: "right-of:gw"` | also `left-of`, `above`, `below` |
| *(nothing)* | derived from the edges, which is almost always right |

Reach for these last. A layout you pinned by hand stops adapting as the board
grows, and the common reason for wanting them — "this box is in the wrong
place" — is usually an edge that has not been drawn yet.

## The flow, and the script

These two are what make a board an explanation rather than a diagram.

A `step` names one hop: `{"op":"step","edge":"gw>orders","step":"Gateway
forwards the call"}`. Steps are numbered in the order they were added, each
number appears on its line, and `focus` lights one — its line turns orange,
both ends get a halo, everything else dims. `lights` adds nodes that should
light with it but are not its endpoints.

A `say` puts a line of the explanation in the rail beside the drawing. Give it
a `step` and walking that step lights those words with that hop; leave it
untagged and it never dims, which is right for an opening or closing remark.

An edge is named `from>to`, which is how `step` and `tag` refer to one.

## What the board does not model

The board draws **a system, and a path through it**. Not every diagram is that
shape, and the ones that are not come out as something else rather than as an
error.

| you may want | what you get | why |
|---|---|---|
| a UML **sequence diagram** | the same topology with numbered hops | there is no time axis. Participants are boxes in space, not lifelines down a page, so ordering is a label on an edge, not a position |
| a **state machine** | boxes and arrows, no semantics | no notion of a state versus a transition, no guards, no initial or final markers |
| an **ER diagram** | boxes and labelled lines | no cardinality, no keys, no attribute lists |
| a **class diagram** | boxes with one sub-line | no members, no inheritance arrows |
| **swimlanes** | one grid | no lane concept; `boundary` groups visually but does not partition |
| a **gantt** or timeline | nothing useful | no dates, no durations |
| **nesting** | a dashed enclosure | `boundary` draws around boxes; it does not contain them, and does not nest |
| **self-calls**, loops on one box | nothing | an edge needs two distinct ends |
| **styling** | the palette's choice | colour comes from `kind`. There is no per-node colour, and that is deliberate |

### The sequence-diagram question specifically

A sequence diagram puts **time on the vertical axis**: participants are
lifelines, and a message's position *is* its ordering. spiega puts **structure
on the page** and expresses ordering as a numbered flow laid over it — you walk
the same picture rather than reading down a page.

So the two express overlapping things differently: both can say "A calls B,
then B calls C". A sequence diagram shows the ordering as geometry; spiega
shows it as steps 1 and 2 that you step through. What spiega cannot express at
all is what the geometry buys you: activation bars, nested calls, a return
arrow distinct from a call, messages crossing, duration.

If the request is genuinely about the order of messages in time, say so and
draw the topology with a flow over it — that is the honest translation. Do not
emit a picture that looks like a sequence diagram and is not one.

### What it is good at

Worth naming, since the list above is all negatives: a request path across
services, what talks to what and how, where a trust boundary falls, which hop
is synchronous and which is not, where the durable state lives, what changed
between two designs, and walking any of it one step at a time while you talk.
