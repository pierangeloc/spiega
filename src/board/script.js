/* ============================================================
   Which line of the script belongs to which step.

   The board has two halves and they were only loosely joined: stepping the
   flow lit one hop of the drawing while the whole transcript stayed equally
   bright, so the reader still had to find the matching sentence themselves.
   This maps each line said to a step, so the rail can light the part of the
   script the current step is about.

   Two ways a line gets attributed, and neither of them guesses:

     1. It says so. `{"op":"say","text":"…","step":3}` — the number as it
        appears on the board — or `{"op":"say","text":"…","edge":"gw>db"}`,
        which survives steps being added or reordered later.

     2. It was said while a step was lit. Walking the flow as you talk is the
        documented way to use the board, and a `focus` op in the log is an
        unambiguous record of which step was on screen when a line landed.

   Everything else is left unattributed, on purpose. A spec that arrives in one
   batch declares all its steps before any narration, so "the newest step at
   the time" would file every line under the last one — confidently wrong, and
   worse than a rail that simply does not highlight. Unattributed lines never
   dim either: an opening sentence is about the whole board, not about step 4.
   ============================================================ */

/* Per transcript entry, the step index it belongs to, or null.
   Returns a plain array, parallel to board.transcript. */
export function scriptSteps(board) {
  const t = board?.transcript || [];
  if (!t.length) return [];
  const flow = board?.flow || [];
  const byEdge = new Map();
  flow.forEach((s, i) => { if (s.edge && !byEdge.has(s.edge)) byEdge.set(s.edge, i); });

  const clamp = i => (Number.isInteger(i) && i >= 0 && i < flow.length ? i : null);

  // What was lit when each line was said, in log order. The log holds `say`
  // ops in the same order as the transcript, so the two line up by counting.
  const whileLit = [];
  let lit = null;
  for (const e of board?.log || []) {
    if (e.op === 'focus') lit = e.step == null ? null : Number(e.step);
    else if (e.op === 'say') whileLit.push(lit);
  }

  return t.map((e, i) => {
    if (e.step != null) return clamp(Number(e.step));
    if (e.edge != null && byEdge.has(e.edge)) return byEdge.get(e.edge);
    return clamp(whileLit[i]);
  });
}

/* The lines belonging to a step, as indices into board.transcript. */
export function linesFor(board, step) {
  if (step == null) return [];
  const at = scriptSteps(board);
  return at.map((s, i) => (s === step ? i : -1)).filter(i => i >= 0);
}

/* How each line of the script should look at the board's current step.

     on    the step being walked is about this line
     off   this line belongs to a different step, so it recedes
     free  this line belongs to no step — an opening or closing remark, which
           is about the whole board and never dims
     idle  no step is lit, or no line is tied to the lit one: the plain rail

   Kept here rather than in the page so it can be tested without a DOM, and so
   the live rail and a snapshot cannot drift apart. */
export function lineStates(board) {
  const at = scriptSteps(board);
  const active = board?.active;
  const anyHere = active != null && at.some(s => s === active);
  return at.map(step => ({
    step,
    state: !anyHere ? 'idle' : step === active ? 'on' : step == null ? 'free' : 'off',
  }));
}

/* Clicking a line of the script walks the step it explains.

   A second click on the step already lit clears it, so the same gesture gets
   you back out — otherwise the only way to leave a step is a different
   control, and the reader has to learn two things instead of one.

   Returns the step to focus, or null to clear. Lives here, with the rest of
   the script-to-step reasoning, so it can be tested without a DOM. */
export function clickStep(board, step) {
  if (!Number.isInteger(step) || step < 0 || step >= (board?.flow?.length || 0)) return undefined;
  return board?.active === step ? null : step;
}
