/* ============================================================
   The numbered steps, over the bottom of the drawing.

   The strip the flow is walked with: where you are, what this hop is, and the
   two arrows. It is not here when the board has no flow, which is what
   board.html's `hidden` says.

   The silent timer is available only when the narrator cannot drive the board,
   so the steps and the script never compete as two simultaneous players.
   ============================================================ */

import { currentSurface, narratorDrives, type Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';

export function Steps({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const surface = currentSurface(model);
  const flow = surface?.flow ?? [];
  if (!flow.length) return null;

  const at = surface?.active ?? null;
  const here = at == null ? undefined : flow[at];
  // The strip is one line and ellipsises, so the whole of a long step is in
  // the title attribute as well.
  const text = at == null
    ? 'press → to walk the flow'
    : String(here?.step || here?.edge || '');

  return (
    <div className="steps" id="steps">
      <button
        className="btn"
        id="prev"
        disabled={at == null || at <= 0}
        onClick={() => dispatch({ type: 'stepPrev' })}
      >&larr;</button>
      <span className="n" id="stepn">
        {at == null ? `${flow.length} steps` : `${at + 1}/${flow.length}`}
      </span>
      <span className="txt" id="steptxt" title={text}>{text}</span>
      {!narratorDrives(model) ? <button className="btn" id="play" onClick={() => dispatch({ type: 'flowPlayToggle' })}>{model.playback.flowPlaying ? 'stop' : 'play'}</button> : null}
      <button
        className="btn"
        id="next"
        disabled={at != null && at >= flow.length - 1}
        onClick={() => dispatch({ type: 'stepNext' })}
      >&rarr;</button>
    </div>
  );
}
