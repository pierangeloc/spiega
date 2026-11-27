/* The map is an overview over both panes, not another drawing surface. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { boardMap, linkLabel, type MapLink } from '../../../../src/board/map.js';
import { ledeText } from '../../../../src/board/tape.js';
import { renderSVG } from '../../../../src/render/render.js';
import { linkInk, sameRow } from '../../../../src/board/map-links.js';
import type { Model } from '../app/model.js';
import type { Msg } from '../app/msg.js';
import { mdish } from './text.js';
import { spokenWords } from './SpokenWords.js';

export function MapView({ model, dispatch }: { readonly model: Model, readonly dispatch: (msg: Msg) => unknown }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [going, setGoing] = useState<number | null>(null);
  const board = model.board;
  const map = useMemo(() => boardMap(board), [board]);
  const section = model.playback.tape[model.playback.tapeIndex];
  const outline = section?.kind === 'outline' ? section : undefined;
  const word = model.playback.wordOffset;

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (model.mapOpen) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setGoing(null);
  }, [model.mapOpen]);
  useEffect(() => {
    const el = wrap.current, cards = cardsRef.current, lines = svg.current;
    if (!model.mapOpen || !el || !cards || !lines) return;
    let frame = 0;
    const draw = (): void => {
      frame = 0;
      drawLinks(el, cards, lines, map.links, schedule);
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(schedule);
    observer.observe(cards);
    addEventListener('resize', schedule);
    schedule();
    return () => { observer.disconnect(); removeEventListener('resize', schedule); cancelAnimationFrame(frame); };
  }, [model.mapOpen, map]);
  useEffect(() => {
    if (model.mapOpen && outline?.card != null) {
      cardsRef.current?.querySelector<HTMLElement>(`.mapcard[data-n="${outline.card}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [model.mapOpen, outline?.card]);

  if (!model.mapOpen || !board) return null;
  const enter = (index: number | null, n: number): void => {
    if (timer.current !== null) return;
    setGoing(n);
    timer.current = setTimeout(() => {
      timer.current = null;
      setGoing(null);
      dispatch({ type: 'selectChapter', chapter: index });
    }, 230);
  };

  return <div className={`map${going === null ? '' : ' leaving'}`} id="map">
    <p className="lede" id="maplede">{outline?.part === 'lede' && word != null ? spokenWords(ledeText(board.title, map.cards.length), word) : ledeText(board.title, map.cards.length)}</p>
    <div className="mapwrap" id="mapwrap" ref={wrap}>
      <svg className="maplinks" id="maplinks" ref={svg} />
      <div className="cards" id="mapcards" ref={cardsRef}>
        {map.cards.map(card => {
          const surface = card.i === null ? board : board.chapters[card.i];
          if (!surface) return null;
          const thumbnail = surface.nodes.length
            ? renderSVG({ ...board, ...surface, active: null }, { margin: 10, active: null, hand: false }).svg
            : '<div class="nothing">nothing drawn yet</div>';
          const bits = [`${card.nodes} boxes`, `${card.edges} lines`];
          if (card.steps) bits.push(`${card.steps} steps`);
          return <button key={card.n} data-n={card.n}
            className={`mapcard${card.live ? ' islive' : ''}${card.i === model.viewing ? ' here' : ''}${going === card.n ? ' going' : ''}${outline?.card === card.n ? ' speaking' : ''}`}
            title={card.live ? 'the chapter being drawn now — click to open it' : `chapter ${card.n} — click to open it`}
            onClick={() => enter(card.i, card.n)}>
            <span className="head"><span className="n">{card.n}</span><span className="t">{outline?.card === card.n && outline.part === 'title' && word != null ? spokenWords(card.title, word) : card.title}</span></span>
            <span className="thumb" dangerouslySetInnerHTML={{ __html: thumbnail }} />
            {card.line ? outline?.card === card.n && outline.part === 'line' && word != null
              ? <span className="line">{spokenWords(card.line, word)}</span>
              : <span className="line" dangerouslySetInnerHTML={{ __html: mdish(card.line) }} /> : null}
            <span className="meta">{bits.join(' · ')}</span>
          </button>;
        })}
      </div>
    </div>
  </div>;
}

/* The same hand and routing as the snapshot's map: short hops cross the gutter, while
   links skipping a card bow around it instead of through its picture. */
function drawLinks(wrap: HTMLElement, cards: HTMLElement, svg: SVGSVGElement, links: MapLink[], schedule: () => void): void {
  wrap.querySelectorAll('.maplabel').forEach(el => el.remove());
  const box = (n: number) => {
    const el = cards.querySelector<HTMLElement>(`.mapcard[data-n="${n}"]`);
    return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
  };
  const bowed = links.some(link => {
    const a = box(link.from), b = box(link.to);
    return a && b && sameRow(a, b) && link.to !== link.from + 1;
  });
  if (bowed !== cards.classList.contains('bowed')) {
    cards.classList.toggle('bowed', bowed);
    schedule();
    return;
  }
  svg.setAttribute('width', String(cards.offsetWidth));
  svg.setAttribute('height', String(cards.offsetHeight));
  let d = '';
  for (const link of links) {
    const a = box(link.from), b = box(link.to);
    if (!a || !b) continue;
    const shared = link.shared.length > 0, next = link.to === link.from + 1;
    const ink = linkInk(a, b, link);
    d += ink.d;
    const mid = ink.mid;
    const tag = document.createElement('span');
    tag.className = `maplabel${shared ? '' : ' then'}${next ? '' : ' free'}`;
    tag.textContent = linkLabel(link).replace(/([_./\-])/g, '$1\u200b');
    tag.title = shared ? `chapters ${link.from} and ${link.to} both draw ${link.shared.join(', ')}` : `chapter ${link.to} follows chapter ${link.from}`;
    tag.style.left = `${mid[0]}px`;
    tag.style.top = `${mid[1]}px`;
    wrap.appendChild(tag);
  }
  svg.innerHTML = d;
  declutter(wrap);
}

function declutter(wrap: HTMLElement): void {
  const tags = [...wrap.querySelectorAll<HTMLElement>('.maplabel')];
  const box = (el: HTMLElement) => {
    const t = parseFloat(el.style.top), l = parseFloat(el.style.left);
    return { t: t - el.offsetHeight / 2, b: t + el.offsetHeight / 2, l: l - el.offsetWidth / 2, r: l + el.offsetWidth / 2 };
  };
  const placed: ReturnType<typeof box>[] = [];
  for (const tag of tags) {
    const home = parseFloat(tag.style.top);
    for (let tries = 0; tries < 14; tries++) {
      const r = box(tag);
      if (!placed.some(p => p.l < r.r + 4 && p.r + 4 > r.l && p.t < r.b + 3 && p.b + 3 > r.t)) break;
      const step = Math.ceil((tries + 1) / 2) * (tag.offsetHeight + 7);
      tag.style.top = `${home + (tries % 2 ? -step : step)}px`;
    }
    placed.push(box(tag));
  }
}
