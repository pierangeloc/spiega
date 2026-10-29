/* ============================================================
   The AGENTS.md block.

   An MCP tool description can say what a tool does. It cannot say when the
   board is worth reaching for at all, how much belongs on it, or why a
   half-tagged script is worse than none — that judgement is what a skill file
   carries, and most harnesses never read one. What they do read is AGENTS.md.

   So the same guidance ships a second way: a short block, delimited, written
   into whichever instruction file the harness reads. Delimited because these
   are files people wrote themselves and have spent a long time on. The
   markers mean an update replaces the block in place instead of appending a
   second copy, and removing it takes the block and nothing else.

   The convention is borrowed rather than invented: codegraph already keeps a
   <!-- CODEGRAPH_START --> block in ~/.codex/AGENTS.md on this machine.
   ============================================================ */

export const START = '<!-- HANDWAVE_START -->';
export const END = '<!-- HANDWAVE_END -->';

/* Short on purpose. This sits in a file the agent reads on every single turn,
   so it buys its place in tokens: when to draw, the two rules that are easy to
   get wrong, and where the detail lives. */
export const BLOCK = `## handwave — draw while you explain

When you are explaining how a system works — a request path, a comparison, a
review, "how does X talk to Y" — draw it on the handwave board as you talk,
rather than writing a wall of prose. Boxes and lines arrive beside your words
and the person watches the picture build.

- \`handwave open\` once, early, so there is something to watch.
- Draw a few things at a time, as you explain them, never the whole diagram in
  one call. A board that appears finished was not explained.
- \`handwave draw '{"op":"node","id":"gw","kind":"gateway","label":"API Gateway"}'\`
  and \`'{"op":"edge","from":"gw","to":"orders","label":"gRPC"}'\`. You never
  place anything: columns come from the edges.
- \`handwave say "..."\` puts a line of your explanation beside the drawing.

Two things that are easy to get wrong and spoil the result:

1. **Tag the lines that explain one step.** \`handwave say "..." --step 3\`, the
   number as it shows on the board. Walking the flow then lights those words
   with that hop, and untagged lines highlight nothing at all. Tag a line
   because it is about that hop, not because it mentions something the hop
   touches; leave opening and closing remarks untagged. When the flow is the
   spine of the explanation, say the lines in step order — the rail shows what
   you said in the order you said it, so narrating by topic makes the step
   numbers read as jumbled. \`handwave script\` checks both, and
   \`handwave tag --match "..." --step N\` fixes it afterwards.
2. **Never re-draw an explanation to show it again.** The board keeps its own
   log: \`handwave replay\` plays the whole session back, words and all.

\`handwave help\` lists the rest. If an MCP server named handwave is available,
its tools do the same things and are cheaper than shelling out.`;

/* Put the block in a file, or update the one already there.

   Returns what happened, so a caller can tell the difference between work and
   a no-op: 'created', 'added', 'updated', or 'unchanged'. Never writes a file
   it did not change. */
export function upsertBlock(fs, file, block = BLOCK) {
  const body = `${START}\n${block}\n${END}`;
  const exists = fs.existsSync(file);
  const before = exists ? fs.readFileSync(file, 'utf8') : '';

  const i = before.indexOf(START);
  const j = before.indexOf(END);

  let after, how;
  if (i >= 0 && j > i) {
    const current = before.slice(i, j + END.length);
    if (current === body) return { how: 'unchanged', changed: false };
    after = before.slice(0, i) + body + before.slice(j + END.length);
    how = 'updated';
  } else if (i >= 0 || j >= 0) {
    // one marker without the other: someone edited by hand, and guessing where
    // the block ends could eat their text
    throw new Error(`${file} has one handwave marker but not the other — fix it by hand`);
  } else if (!before.trim()) {
    after = body + '\n';
    how = 'created';
  } else {
    after = before.replace(/\n*$/, '') + '\n\n' + body + '\n';
    how = 'added';
  }
  return { how, changed: true, text: after };
}

/* Take the block back out, leaving the rest of the file as it was. */
export function removeBlock(text) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i < 0 || j < i) return { changed: false, text };
  const out = (text.slice(0, i) + text.slice(j + END.length)).replace(/\n{3,}/g, '\n\n');
  return { changed: true, text: out.replace(/^\n+/, '') };
}
