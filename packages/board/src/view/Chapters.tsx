import { useEffect, useRef } from 'react';
import type { Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';

export function Chapters({ model, dispatch }: { readonly model: Model, readonly dispatch: (msg: Msg) => unknown }) {
  const selected = useRef<HTMLButtonElement>(null);
  const chapters = model.board?.chapters ?? [];
  useEffect(() => { selected.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [model.viewing, model.mapOpen]);
  if (!chapters.length) return null;
  const here = model.replay.active
    ? (model.replay.chapterAt ?? model.replay.board?.chapters.length ?? chapters.length)
    : model.mapOpen ? -1 : model.viewing ?? chapters.length;
  return <nav className="chapters" id="chapters">
    <button className={`${here === -1 ? 'here ' : ''}tab maptab`} title="all the chapters at once, and what they have in common" onClick={() => dispatch({ type: 'openMap' })}><span className="num">⊞</span><span>map</span></button>
    {[...chapters.map((chapter, i) => ({ title: chapter.title, index: i })), { title: model.board?.chapter, index: null }].map(({ title, index }) => {
      const at = index ?? chapters.length;
      const marked = !model.replay.active && model.changed.includes(index);
      return <button key={at} ref={at === here ? selected : undefined} className={`${at === here ? 'here ' : ''}tab`}
        title={index == null ? 'the chapter being drawn now' : marked ? `chapter ${at + 1} — something was added to it` : `chapter ${at + 1}`}
        onClick={() => dispatch({ type: 'selectChapter', chapter: index })}>
        <span className="num">{at + 1}</span><span>{title || 'untitled'}</span>{marked ? <span className="growing" /> : null}
      </button>;
    })}
  </nav>;
}
