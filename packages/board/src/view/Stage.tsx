/* ============================================================
   The stage: the drawing, and the things laid over it.

   The SVG arrives from `renderSVG` as a string and goes in as-is — the same
   string board.html mounts, which the suite checks byte for byte. The pan
   wrapper carries the camera's transform, exactly as `applyView()` does.

   The camera itself belongs to the model. This measures two things the model
   cannot know — how big the stage is, and how big the drawing came out — and
   reports them; `update` does the fit arithmetic board.html's `fit()` does.

   Not here, and deliberately: the pan and zoom gestures, the fit/follow/export
   tools in the top right, and replay's caption. Those are subsequent page work.
   ============================================================ */

import { useEffect, useMemo, useRef } from 'react';

import { unsavedWarning, type Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';
import { Steps } from './Steps.js';
import { panTransform, panTransition, stageRender } from './drawing.js';

export function Stage({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const stage = useRef<HTMLDivElement>(null);

  /* Memoised on what the drawing is of, not on the model: the camera moves far
     more often than the board changes, `renderSVG` is the most expensive thing
     this page does, and a drawing that was re-rendered on every frame of a
     fitted camera would also re-report its layout and fit again, forever. The
     board object is replaced wholesale whenever a revision arrives, so its
     identity is the signal. */
  const drawing = useMemo(
    () => stageRender(model),
    [model.board, model.viewing, model.chapterStep, model.replay.board, model.replay.chapterAt],
  );

  // A board usually lives in a pane someone is dragging wider or narrower.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const report = (): void => {
      dispatch({ type: 'stageResized', size: { w: el.clientWidth, h: el.clientHeight } });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dispatch]);

  // How big the drawing came out, and where its boxes landed: the camera needs
  // both to fit the board and to frame a step's boxes.
  useEffect(() => {
    if (!drawing) return;
    dispatch({
      type: 'layoutMeasured',
      canvas: { w: drawing.width, h: drawing.height },
      boxes: drawing.boxes,
      offset: drawing.offset,
    });
  }, [dispatch, drawing]);

  const unsaved = unsavedWarning(model);

  return (
    <div className="stage" id="stage" ref={stage}>
      <div
        className="pan"
        id="pan"
        style={{
          transform: panTransform(model.camera.view),
          transition: panTransition(model.camera.smooth),
        }}
        dangerouslySetInnerHTML={{ __html: drawing?.svg ?? '' }}
      />
      {drawing ? null : (
        <div className="blank" id="blank">
          <div className="k">the board is empty</div>
          <div><code>{`spiega draw '{"op":"node","label":"API Gateway","kind":"gateway"}'`}</code></div>
        </div>
      )}
      <div className="warnings">
        {model.link === 'down' ? (
          <div className="offline" id="offline">
            <span className="k">not connected</span>
            <span className="msg">this board may be out of date &mdash; reconnecting&hellip;</span>
          </div>
        ) : null}
        {unsaved ? (
          <div className="offline unsaved" id="unsaved">
            <span className="k">not being saved</span>
            <span className="msg" id="unsavedwhy">{unsaved}</span>
          </div>
        ) : null}
      </div>
      <Steps model={model} dispatch={dispatch} />
    </div>
  );
}
