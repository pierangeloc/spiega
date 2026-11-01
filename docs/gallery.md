# The gallery

What an agent can put on a spiega board, drawn by the renderer itself. Every
picture here comes out of `node tools/gallery.js`, which calls the same
`renderSVG` the live board calls — so it cannot drift from what you will see.
Change a glyph, run the script, and the page is current.

The field-by-field reference is [vocabulary.md](vocabulary.md). The
one-shape-per-kind catalogue, with every kind at full size, is
[shapes.md](shapes.md). This page is the tour.

## The fourteen node kinds

Eight kinds are software's furniture: a browser, a gateway, a service, a
replica set, durable storage, a copy of it, a queue, and something you do not
own.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-software.svg" width="820" alt="client, gateway, service, compute, datastore, cache, queue and external nodes">

| kind | use it for |
|---|---|
| `client` | a browser, an app, whoever is calling |
| `gateway` | an API gateway, a load balancer, an ingress |
| `service` | an ordinary service or module |
| `compute` | a replica set, a worker pool — `replicas` sets how many |
| `datastore` | a database, a bucket, anything durable |
| `cache` | a cache, a read replica, a copy of truth |
| `queue` | a topic, a queue, a stream — `depth` fills slots |
| `external` | a third party, something you do not own |

Two more are writing on the board rather than boxes in it: a `note` is a
torn-off scrap for a keyword or a caveat, and a `formula` sets a small subset of
LaTeX — fractions, roots, vectors, Greek — with hand-drawn rules.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-writing.svg" width="440" alt="a note and a formula">

The last four carry no infrastructure meaning at all, so a figure that is not
about software does not have to lie: water is not a database, and a gas is not
a queue. `blob` is a body or a region, `vessel` holds something, `particle` is
one small thing, and `source` is wherever something comes from.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/kinds-neutral.svg" width="540" alt="blob, vessel, particle and source nodes">

Colour is assigned by kind, not chosen: a datastore is always mint, a queue
always tomato. That is what makes two boards of the same system look like the
same system.

```json
{"op":"node","id":"orders","kind":"service","label":"Orders","sub":"Kotlin"}
{"op":"node","id":"workers","kind":"compute","label":"Workers","replicas":3}
{"op":"node","id":"events","kind":"queue","label":"orders.created","depth":3}
```

## Lines between them

An edge can be plain or carry a label:

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/edges.svg" width="520" alt="a plain edge and a labelled edge">

It can be dashed because the caller does not wait for it, or carry the number of
a flow step. The number and the label travel as one tag, so they can never land
on top of each other.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/edges-async.svg" width="520" alt="an async dashed edge and an edge carrying a numbered flow step">

```json
{"op":"edge","from":"orders","to":"postgres"}
{"op":"edge","from":"orders","to":"postgres","label":"SQL"}
{"op":"edge","from":"orders","to":"events","label":"publish","async":true}
```

An edge pointing back at something upstream is a loop, and is routed under the
row rather than back through it — feedback, retries, a control loop.

```json
{"op":"edge","from":"sampler","to":"filter","label":"x[n]"}
{"op":"edge","from":"filter","to":"sampler","label":"feedback"}
```

## The flow, and the rail beside it

A flow is what makes a board an explanation rather than a diagram. A `step`
names one hop and gives it a number; `focus` lights that hop — its line turns
orange, both ends get a halo, everything else dims. The number rides on the
line, and a snapshot lays the same numbered hops out as a list beside the
drawing, so there is something to read down.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/flow.svg" width="820" alt="a three-step flow with step one lit, and the numbered list beside the drawing">

```json
{"op":"flow","steps":[
  {"edge":"gateway>orders","step":"Authenticate, then forward"},
  {"edge":"orders>cache","step":"Claim the idempotency key"},
  {"edge":"orders>db","step":"Write the order row"}]}
{"op":"focus","step":0}
```

`lights` adds nodes that are part of the step without being either end of its
edge. A `note` never dims: the one sentence explaining why a step matters
should not fade out exactly when that step is being explained.

A `say` puts a line of the explanation in the transcript rail beside the
drawing, and `step` or `edge` ties it to a hop, so walking the flow lights the
words that go with it. An untagged line is an opening or a closing remark and
never dims.

```json
{"op":"say","text":"A request starts in the browser.","step":1}
{"op":"say","text":"That is the whole path."}
```

## Grouping and annotating

A `boundary` draws a dashed enclosure around named members — a VPC, a process,
a bounded context, a trust boundary. It does not contain them and it does not
nest; it is a visual group, not a partition.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/boundary.svg" width="700" alt="a dashed boundary around Orders and Postgres">

```json
{"op":"boundary","id":"vpc","label":"private subnet","members":["orders","db"]}
```

A `callout` says something *about* a thing without crowding it. The words sit
in clear space and a thin leader line points at the node or edge they are about.
`at` is a node id or an edge written `from>to`; `side` is `below`, `above`,
`left` or `right`.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/callout.svg" width="500" alt="a callout pointing at an edge">

```json
{"op":"callout","at":"orders>stripe","label":"retried 3 times, then dead-lettered"}
```

A `note` has no edges, so it goes in a margin column of its own, to the left of
the path. That is where an aside belongs: it is something you read beside the
diagram, not a box in the flow.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/note.svg" width="700" alt="a note in the left margin beside a path from Orders to Postgres">

```json
{"op":"note","label":"at most once\nper tenant"}
```

## The title

`title` sets the board's name, which sits in the bar above the drawing beside
the live indicator. It is not a node and it does not take part in the layout.

<img src="https://raw.githubusercontent.com/pierangeloc/spiega/main/docs/gallery/title.svg" width="480" alt="the board title bar above a gateway and a datastore">

```json
{"op":"title","text":"Placing an order"}
```

---

Nothing here takes coordinates. Columns come from the edges, rows from what
would otherwise collide, and the canvas grows to fit whatever falls outside —
see [*Where things go*](vocabulary.md#where-things-go) for why that is not
negotiable.
