/* ============================================================
   The stage: the drawing, and the things laid over it.

   The SVG arrives from `renderSVG` as a string and goes in as-is — the same
   string board.html mounts, which the suite checks byte for byte. The pan
   wrapper carries the camera's transform, exactly as `applyView()` does.

   The camera itself belongs to the model. This measures two things the model
   cannot know — how big the stage is, and how big the drawing came out — and
   reports them; `update` does the fit arithmetic board.html's `fit()` does.

   Export and the narration caption belong to the remaining board work.
   ============================================================ */

import { useEffect, useMemo, useRef } from 'react';
import { litKeys } from '../../../../src/board/camera.js';
import { animateIn, seedOf } from '../../../../src/board/draw-on.js';

import { currentSurface, unsavedWarning, type Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';
import { Steps } from './Steps.js';
import { panTransform, panTransition, stageRender } from './drawing.js';

export function Stage({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const stage = useRef<HTMLDivElement>(null);
  const pan = useRef<HTMLDivElement>(null);
  const ink = useRef(new Map<string, Set<string>>());
  const drag = useRef<{ x: number, y: number, lastX: number, lastY: number, node: string | null, moved: boolean } | null>(null);
  const hasSteps = (currentSurface(model)?.flow.length ?? 0) > 0;

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
    const bar = el.querySelector<HTMLElement>('.steps');
    const report = (): void => {
      dispatch({ type: 'stageResized', size: { w: el.clientWidth, h: el.clientHeight }, stepsBarHeight: bar?.offsetHeight ?? 0 });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, [dispatch, hasSteps]);

  // React's delegated wheel listener is passive in Chrome, so it cannot stop
  // the page scrolling while the reader zooms the drawing.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      dispatch({ type: 'zoom', factor: 1 - e.deltaY * .0016, origin: { x: e.clientX - r.left, y: e.clientY - r.top } });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
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

  // Keep the ink by surface: revisiting a chapter does not redraw it, but an
  // amendment to that chapter still arrives stroke by stroke.
  useEffect(() => {
    const el = pan.current;
    if (!el) return;
    const key = model.replay.active ? `replay-${model.replay.chapterAt ?? 'live'}` : `chapter-${model.viewing ?? 'live'}`;
    let seen = ink.current.get(key);
    if (!seen) { seen = new Set(); ink.current.set(key, seen); }
    if (!drawing) { seen.clear(); return; }
    const leads = new Set((currentSurface(model)?.flow ?? []).flatMap(step => litKeys(step)));
    el.querySelectorAll<SVGGElement>('g[data-node]').forEach(g => g.classList.toggle('go', leads.has(g.dataset.node ?? '')));
    const groups = [...el.querySelectorAll<SVGGElement>('[data-node],[data-boundary],[data-edge]')]
      .sort((a, b) => rank(a) - rank(b));
    const pending = groups.filter(g => !seen.has(groupKey(g)));
    const pace = pending.length > 6 ? .22 : pending.length > 2 ? .38 : .6;
    let clock = 0;
    for (const g of pending) {
      const name = groupKey(g);
      const duration = animateIn(g, clock, seedOf(name));
      clock += Math.min(duration * pace, 480);
      seen.add(name);
    }
  }, [drawing, model.viewing, model.replay.active, model.replay.chapterAt]);

  const unsaved = unsavedWarning(model);

  return (
    <div className="stage" id="stage" ref={stage}
      onPointerDown={e => {
        const target = e.target as Element;
        if (target.closest('.steps, .blank code, .warnings, .caption, .tools')) return;
        drag.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, node: target.closest<SVGGElement>('g[data-node]')?.dataset.node ?? null };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const d = drag.current;
        if (!d) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) d.moved = true;
        if (d.moved) dispatch({ type: 'pan', dx: e.clientX - d.lastX, dy: e.clientY - d.lastY });
        d.lastX = e.clientX; d.lastY = e.clientY;
      }}
      onPointerUp={() => {
        const d = drag.current;
        if (d?.node && !d.moved) dispatch({ type: 'clickNode', nodeId: d.node });
        drag.current = null;
      }}
      onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={e => { if (!(e.target as Element).closest('.tools')) dispatch({ type: 'fit', smooth: true }); }}>
      <div
        className="pan"
        id="pan"
        ref={pan}
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
      <div className="tools" id="tools">
        <button className="btn tool" id="fit" title="fit the whole board in view (f)" aria-label="fit the whole board in view" onClick={() => dispatch({ type: 'fit', smooth: true })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg></button>
        <button className={`btn tool${model.camera.following ? ' on' : ''}`} id="follow" title="keep the lit boxes in view while walking the flow" aria-label="follow the flow" aria-pressed={model.camera.following} onClick={() => dispatch({ type: 'toggleFollow' })}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15"/></svg></button>
      </div>
    </div>
  );
}

function groupKey(g: SVGGElement): string { return g.dataset.node ?? g.dataset.boundary ?? g.dataset.edge ?? ''; }
function rank(g: SVGGElement): number { return g.dataset.node ? 0 : g.dataset.boundary ? 1 : 2; }
