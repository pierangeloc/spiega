// @ts-check
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

import { litKeys } from './camera.js';

/** @typedef {import('./state.js').Board} Board */

/** @typedef {{step: number|null, state: 'on'|'off'|'free'|'idle'}} LineState */
/** @typedef {{line: number, step: number, after: number}} BackwardsTag */
/** @typedef {{
 *   lines: number, tagged: number, steps: number,
 *   backwards: BackwardsTag[], ordered: boolean
 * }} TagReport */

/* Per transcript entry, the step index it belongs to, or null.
   Returns a plain array, parallel to board.transcript. */
/**
 * @param {Board} [board]
 * @returns {(number|null)[]}
 */
export function scriptSteps(board) {
  const t = board?.transcript || [];
  if (!t.length) return [];
  const flow = board?.flow || [];
  /** @type {Map<string, number>} */
  const byEdge = new Map();
  flow.forEach((s, i) => { if (s.edge && !byEdge.has(s.edge)) byEdge.set(s.edge, i); });

  /** @param {number|null} i @returns {number|null} */
  const clamp = i => (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < flow.length ? i : null);

  /* What was lit when each line was said, in log order. The log holds `say`
     ops in the same order as the transcript, so the two line up by counting.

     One log, several chapters: the transcript is the current chapter's and the
     log is the whole explanation's, so counting from the top would file this
     chapter's lines under the steps of the one before it. Every chapter break
     starts the count again, and a chapter already set aside carries its own
     answer and never reaches this walk (see closeChapter in state.js). */
  /** @type {(number|null)[]} */
  let whileLit = [];
  /** @type {number|null} */
  let lit = null;
  for (const e of board?.log || []) {
    if (e.op === 'chapter') { whileLit = []; lit = null; }
    else if (e.op === 'focus') lit = e.step == null ? null : Number(e.step);
    else if (e.op === 'say') whileLit.push(lit);
  }

  return t.map((e, i) => {
    if (e.step != null) return clamp(Number(e.step));
    if (e.edge != null && byEdge.has(e.edge)) return byEdge.get(e.edge) ?? null;
    return clamp(whileLit[i]);
  });
}

/* The lines belonging to a step, as indices into board.transcript. */
/**
 * @param {Board|undefined} board
 * @param {number|null} step
 * @returns {number[]}
 */
export function linesFor(board, step) {
  if (step == null) return [];
  const at = scriptSteps(board);
  return at.map((s, i) => (s === step ? i : -1)).filter(i => i >= 0);
}

/* The phases of the explanation, as runs of lines in the rail.

   A long explanation has parts — four steps that are all one reaction — and
   the rail gives them no more relation to each other than to the remarks
   above them. A step says which phase it belongs to; this turns that into the
   thing a header can span: where a run of lines about one phase starts and
   where it stops.

   A phase whose lines are interrupted gets one run per stretch, with the same
   name over each. The alternative is a header spanning lines that are not
   about it, which would be a claim about somebody's transcript that nobody
   made — and the rail is in the order things were said, which no grouping
   gets to reorder. */
/** @typedef {{id: string, label: string, from: number, to: number}} GroupRun */
/**
 * @param {Board} [board]
 * @returns {GroupRun[]}
 */
export function groupRuns(board) {
  const at = scriptSteps(board);
  const flow = board?.flow || [];
  const names = board?.groups || {};
  /** @type {GroupRun[]} */
  const runs = [];
  at.forEach((step, line) => {
    const id = step == null ? null : (flow[step]?.group || null);
    if (!id) return;
    const last = runs[runs.length - 1];
    // a group nobody declared is shown as its own id: an undeclared phase is
    // a missing label, not a mistake worth dropping the header over
    if (last && last.id === id && last.to === line - 1) last.to = line;
    else runs.push({ id, label: names[id] ?? id, from: line, to: line });
  });
  return runs;
}

/* How each line of the script should look at the board's current step.

     on    the step being walked is about this line
     off   this line belongs to a different step, so it recedes
     free  this line belongs to no step — an opening or closing remark, which
           is about the whole board and never dims
     idle  no step is lit, or no line is tied to the lit one: the plain rail

   Kept here rather than in the page so it can be tested without a DOM, and so
   the live rail and a snapshot cannot drift apart. */
/**
 * @param {Board} [board]
 * @returns {LineState[]}
 */
export function lineStates(board) {
  const at = scriptSteps(board);
  const active = board?.active;
  const anyHere = active != null && at.some(s => s === active);
  return at.map(step => {
    /** @type {'on'|'off'|'free'|'idle'} */
    const state = !anyHere ? 'idle' : step === active ? 'on' : step == null ? 'free' : 'off';
    return { step, state };
  });
}

/* Clicking a line of the script walks the step it explains.

   A second click on the step already lit clears it, so the same gesture gets
   you back out — otherwise the only way to leave a step is a different
   control, and the reader has to learn two things instead of one.

   Returns the step to focus, or null to clear. Lives here, with the rest of
   the script-to-step reasoning, so it can be tested without a DOM. */
/**
 * @param {Board|undefined} board
 * @param {number} step
 * @returns {number|null|undefined}
 */
export function clickStep(board, step) {
  if (!Number.isInteger(step) || step < 0 || step >= (board?.flow?.length || 0)) return undefined;
  return board?.active === step ? null : step;
}

/* Clicking a box walks the steps that light it.

   A box is not bound to one step, and cannot be: both ends of an edge are lit
   by it, so in any chain a → b → c the middle box is lit twice — once as the
   target of one hop and once as the source of the next — and that is the
   normal shape of a flow, not an edge case. A step can also name a box through
   `lights` that is on no edge at all, so the relation is many-to-many by
   design and "the step this box belongs to" does not exist for most boxes.

   So the gesture walks the steps that do light it: the first, then the next,
   and past the last the board is lit again. For a box in exactly one step —
   a datastore read once, a terminal output — that collapses to one click in
   and one click out. For a box in the middle of a chain it answers the
   question the board had no gesture for: what are all the hops this box is
   in?

   `from` is the step lit now. When that step lights the box the walk carries
   on from it, so a second click goes to the next hop rather than back to the
   first; when it lights something else the walk starts at the beginning, and
   the reader gets the first hop that touches the box.

   Returns the step to focus, null to clear, or undefined when the box is in
   no step at all — nothing to walk to, so nothing happens. */
/**
 * @param {Board|undefined} board
 * @param {string} id
 * @param {number|null} [from]
 * @returns {number|null|undefined}
 */
export function clickNode(board, id, from = board?.active ?? null) {
  const flow = board?.flow || [];
  /** @type {number[]} */
  const steps = [];
  flow.forEach((s, i) => { if (litKeys(s).includes(id)) steps.push(i); });
  if (!steps.length) return undefined;
  const at = from == null ? -1 : steps.indexOf(from);
  if (at < 0) return steps[0];
  return at + 1 < steps.length ? steps[at + 1] : null;
}

/* Do the tags run forwards?

   The rail shows what was said, in the order it was said, because that is what
   a transcript is. So when a script is tagged 2, 1, 3, 3, 4, 3, 6 the step
   numbers appear to jump — and nothing is sorting them wrongly; that is the
   order the lines were spoken.

   It means one of two things, and both are worth seeing. Either the
   explanation is organised by topic while the flow is organised by time, in
   which case the flow is not really the spine of it. Or lines are being tagged
   because they mention something a step touches, rather than because they are
   about that hop.

   Reported, not corrected: reordering someone's transcript would be a lie
   about the session, and the untagged lines have no place in step order
   anyway. */
/**
 * @param {Board} [board]
 * @returns {TagReport}
 */
export function tagReport(board) {
  const at = scriptSteps(board);
  /** @type {{step: number, line: number}[]} */
  const tagged = [];
  at.forEach((step, line) => { if (step != null) tagged.push({ step, line }); });
  /** @type {BackwardsTag[]} */
  const backwards = [];
  for (let k = 1; k < tagged.length; k++) {
    if (tagged[k].step < tagged[k - 1].step) {
      backwards.push({ line: tagged[k].line + 1, step: tagged[k].step + 1, after: tagged[k - 1].step + 1 });
    }
  }
  return {
    lines: at.length,
    tagged: tagged.length,
    steps: board?.flow?.length || 0,
    backwards,
    ordered: backwards.length === 0,
  };
}
