/* ============================================================
   Is the picture readable? The suite's end of the audit.

   The measurement itself moved to src/render/audit.js when #56 made it
   something the agent is told and not only something the suite asserts. It is
   the same code and the same wording; what lives here is the part that is only
   ever wanted from a terminal: load a spec off disk, render it, print what the
   audit found.

   Run `node test/readable.mjs <spec.json>...` to print what it finds.
   ============================================================ */

import fs from 'node:fs';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import { audit, report, measureDrawing, overprints } from '../src/render/audit.js';

export { measureDrawing, overprints };

export function drawnBoard(ops) {
  const b = emptyBoard();
  const { errors } = applyOps(b, ops);
  if (errors.length) throw new Error(errors.join('; '));
  return b;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { specToOps } = await import('../src/spec.js');
  for (const file of process.argv.slice(2)) {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = renderSVG(drawnBoard(specToOps(spec)));
    const found = audit(spec, r);
    const { lines } = overprints(spec, r);
    console.log(`${file}: ${found.over.length} over text, ${lines.length} over lines, ` +
      `${found.buried.length} arrows through a box, ${found.crossings} crossings`);
    for (const s of found.over) console.log(`  TEXT  ${s}`);
    for (const s of lines) console.log(`  line  ${s}`);
    for (const b of found.buried) console.log(`  BOX   ${b.edge} through ${b.box}`);
    // what of all that would actually ride back to the agent
    for (const s of report(found)) console.log(`  said  ${s}`);
  }
}
