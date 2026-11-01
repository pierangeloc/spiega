/* ============================================================
   spiega spec — a whole board as one object, mapped to the ops that build it.

   Two things need this mapping: `spiega draw spec.json` / `spiega render`, and
   the tools that generate the pictures in the docs. It lived in src/cli.js and
   was copied into tools/example.js, because importing the CLI runs it. The
   copy promptly fell behind: callouts were added to one and not the other, so
   every worked example in the README was published without the sentences that
   said why its boxes mattered — and the test that regenerates those pictures
   passed, because it compared the buggy tool against its own output.

   One copy, imported by both. A spec field that is not listed here is drawn by
   nobody, which is the kind of mistake that shows up in a picture.
   ============================================================ */

/**
 * @param {any} spec a board as a single object
 * @returns {any[]} the ops that draw it, in drawing order
 */
export function specToOps(spec) {
  const ops = [];
  if (spec.title) ops.push({ op: 'title', text: spec.title });
  for (const n of spec.nodes || []) ops.push({ op: 'node', ...n });
  for (const e of spec.edges || []) ops.push({ op: 'edge', ...e });
  for (const b of spec.boundaries || []) ops.push({ op: 'boundary', ...b });
  for (const c of spec.callouts || []) ops.push({ op: 'callout', ...c });
  if (spec.flow?.length) ops.push({ op: 'flow', steps: spec.flow });
  for (const t of spec.transcript || []) ops.push({ op: 'say', text: t.text ?? t });
  return ops;
}

/* What the board is made of, counted the way an agent draws it: one op per
   box, per line, per enclosure, per callout, per step. Sending the same board
   as a single spec file is cheaper — a whole flow travels as one op — so both
   numbers exist, and the per-element one is what the picture cost to say.

   Notes are counted apart from boxes because a note is writing in the margin,
   not a thing in the system, and a tally that says "nine boxes" when one of
   them is a sentence is a tally nobody can check against the picture. */
/** @param {any} spec */
export function measure(spec) {
  const nodes = spec.nodes || [];
  const parts = {
    title: spec.title ? 1 : 0,
    nodes: nodes.filter(n => n.kind !== 'note').length,
    notes: nodes.filter(n => n.kind === 'note').length,
    edges: (spec.edges || []).length,
    boundaries: (spec.boundaries || []).length,
    callouts: (spec.callouts || []).length,
    steps: (spec.flow || []).length,
    said: (spec.transcript || []).length,
  };
  const ops = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, ops, asFile: specToOps(spec).length };
}
