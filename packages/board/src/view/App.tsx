/* ============================================================
   The board page, as React reads the model.

   `useSyncExternalStore` over the store from #152 is the whole of the binding:
   no state lives here, every gesture leaves as a `Msg`, and the view is a
   function of the model. That is what makes the later swap to Foldkit a rewrite
   of this directory and nothing else.

   The panes are the body grid's rows in board.css: the bar, the chapter
   strip's row, and `main` as a grid of the rail and the stage.

   ============================================================ */

import { useEffect, useSyncExternalStore } from 'react';

import { type Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';
import type { BoardStore } from '../app/store.js';
import { Rail } from './Rail.js';
import { Stage } from './Stage.js';
import { Transport } from './Transport.js';
import { Chapters } from './Chapters.js';
import { MapView } from './Map.js';

const LINK_TITLE = {
  live: 'the agent just drew something',
  idle: 'connected, waiting',
  down: 'not connected to the board server',
};

export function Board({ model, dispatch }: {
  readonly model: Model,
  readonly dispatch: (msg: Msg) => unknown,
}) {
  const title = model.board?.title;
  const tag = model.boardTag;

  /* What the window is called. The board's own name rides in brackets because
     the window title is the only handle an OS has on a browser app window:
     `spiega focus` finds the window by it. */
  useEffect(() => {
    document.title = (title ? `${title} · spiega` : 'spiega') + (tag ? ` [${tag}]` : '');
  }, [title, tag]);

  return (
    <>
      <div className="bar">
        <span
          className={`dot${model.link === 'live' ? '' : ` ${model.link}`}`}
          id="live"
          title={model.exported ? 'standalone copy' : LINK_TITLE[model.link]}
        />
        <h1 id="title">{title || 'spiega'}</h1>
        <span className="spacer" />
        <button
          className={`btn rail-button${model.railOpen ? ' on' : ''}`}
          id="rail-toggle"
          title="show or hide transcript"
          aria-label={model.railOpen ? 'hide transcript' : 'show transcript'}
          aria-controls="rail"
          aria-expanded={model.railOpen}
          onClick={() => dispatch({ type: 'toggleRail' })}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2" y="3" width="16" height="14" rx="2" />
            <path d="M6 7h8M6 10h8M6 13h5" />
          </svg>
        </button>
        <Transport model={model} dispatch={dispatch} />
        {model.chapterOnly ? null : <button className={`btn${model.replay.active ? ' on' : ''}`} id="replay" title="play the session back as it happened" onClick={() => dispatch({ type: 'replayToggle' })}>{model.replay.active ? 'stop' : 'replay'}</button>}
      </div>
      <Chapters model={model} dispatch={dispatch} />
      <main id="main" className={model.railOpen ? undefined : 'norail'}>
        <Rail model={model} dispatch={dispatch} />
        <Stage model={model} dispatch={dispatch} />
        <MapView model={model} dispatch={dispatch} />
      </main>
    </>
  );
}

export function App({ store }: { readonly store: BoardStore }) {
  /* The third argument is the model as a server render sees it. There is no
     server render of this page in production — but the Node suite renders the
     app with react-dom/server to read the stage's SVG back out, and
     `useSyncExternalStore` refuses to run there without one. The fixture store
     is synchronous, so the snapshot it would hand a client is the right
     answer for both. */
  const model = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return <Board model={model} dispatch={store.dispatch} />;
}
