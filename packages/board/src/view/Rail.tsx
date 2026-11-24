/* ============================================================
   The transcript rail: what was said while it was drawn.

   One card per line, in the order they were said, with the phases of the
   explanation as headings over the runs of lines they cover. Which line
   belongs to which step, and how it should look, is `script.ts`'s answer
   (`lineStates`, `groupRuns`) — the same answer the snapshot paints.

   The old page appended to this rail rather than rebuilding it, because
   rebuilding restarts every card's fade-in and walking 1/6 … 6/6 would make
   the whole script flicker. React does that for free: a step change rewrites
   the className of cards that are already mounted and touches nothing else, so
   the animation does not restart.
   ============================================================ */

import { Fragment, useEffect, useRef } from 'react';

import {
  activeStep,
  currentGroupRuns,
  currentLineStates,
  currentRailMarks,
  currentSurface,
  type Model,
} from '../app/model.js';
import type { Msg } from '../app/msg.js';
import { mdish } from './text.js';
import { spokenWords } from './SpokenWords.js';

export function Rail({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const rail = useRef<HTMLElement>(null);
  const lines = currentSurface(model)?.transcript ?? [];
  const states = currentLineStates(model);
  const lit = activeStep(model);
  const marks = currentRailMarks(model);

  /* Follow the step, not the tail: while a step is lit, its own lines are what
     the reader needs on screen, and in a long session they are far above the
     bottom. With no step, the newest line is the interesting one. */
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const on = el.querySelector<HTMLElement>('.said.saying') ?? el.querySelector<HTMLElement>('.said.on');
    if (on) {
      const top = on.offsetTop - el.clientHeight / 2 + on.offsetHeight / 2;
      el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [lit, lines.length, model.playback.tapeIndex]);

  if (!lines.length) {
    return (
      <aside className="rail" id="rail" ref={rail}>
        <div className="empty">Nothing said yet.</div>
      </aside>
    );
  }

  // A phase heading goes above the first line of its run.
  const phases = new Map(currentGroupRuns(model).map(run => [run.from, run]));

  return (
    <aside className={`rail${marks.some(Boolean) ? ' scrub' : ''}`} id="rail" ref={rail}>
      {lines.map((line, i) => {
        const run = phases.get(i);
        const { step, state } = states[i] ?? { step: null, state: 'idle' };
        const classes = ['said'];
        if (i === lines.length - 1) classes.push('latest');
        if (state !== 'idle') classes.push(state);
        if (marks[i] === 'heard') classes.push('heard');
        if (marks[i] === 'now') classes.push('saying');
        // A line that names a step is a way into that step: the reader has just
        // read the words, and the hop they are about is one click away.
        if (step != null) classes.push('go');
        return (
          <Fragment key={i}>
            {run ? (
              <div className="phase" data-group={run.id}>
                <span dangerouslySetInnerHTML={{ __html: mdish(run.label) }} />
              </div>
            ) : null}
            <div
              className={classes.join(' ')}
              data-line={i}
              data-step={step == null ? undefined : String(step)}
              title={step == null ? '' : `step ${step + 1} — click to walk it`}
              onClick={() => dispatch({ type: 'clickLine', line: i, step })}
            >
              {step == null ? null : <span className="tag">step {step + 1}</span>}
              {marks[i] === 'now' && model.playback.wordOffset != null
                ? <span className="said-body">{spokenWords(line.text, model.playback.wordOffset)}</span>
                : <span className="said-body" dangerouslySetInnerHTML={{ __html: mdish(line.text) }} />}
            </div>
          </Fragment>
        );
      })}
    </aside>
  );
}
