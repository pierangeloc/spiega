# @spiega/render

`renderSVG` and everything under it: layout, glyphs, ink, edges, maths,
callouts, the audit. Plain strict TypeScript, no Effect — geometry does not
need it — and browser-safe for the same reason as `core`.

Empty today. The JavaScript it will own still runs from `src/render/`, and
moves in here with the render port: the leaves in #141, ink and glyphs in
#142, edges and callout in #143, layout and floating in #144, render and
audit in #145.

Byte-identical pictures are the oracle for every one of those, so the risk
here is never logic — it is float formatting, iteration order and string
building.
