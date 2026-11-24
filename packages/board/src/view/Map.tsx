/* The map is an overview over both panes, not another drawing surface. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { boardMap, linkLabel, type MapLink } from '../../../../src/board/map.js';
import { ledeText } from '../../../../src/board/tape.js';
import { renderSVG } from '../../../../src/render/render.js';
import { arrowHead, hashSeed, roughLine, stroke } from '../../../../src/render/ink.js';
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
    return a && b && Math.abs(a.y - b.y) < 8 && link.to !== link.from + 1;
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
    const seed = hashSeed(`${link.from}>${link.to}`);
    const shared = link.shared.length > 0;
    const style = { w: shared ? 1.7 : 1.3, dash: shared ? null : '7 6', opacity: shared ? 1 : 0.5 };
    const row = Math.abs(a.y - b.y) < 8, next = link.to === link.from + 1;
    let mid: number[];
    if (row && next) {
      const p = [a.x + a.w, a.y + a.h / 2], q = [b.x, b.y + b.h / 2];
      d += stroke(roughLine(p, q, { seed }), style) + arrowHead(q, 0, { seed, w: style.w, size: 10 });
      mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    } else if (!row && next) {
      const p = [a.x + a.w / 2, a.y + a.h], q = [b.x + b.w / 2, b.y];
      d += stroke(roughLine(p, q, { seed }), style) + arrowHead(q, Math.PI / 2, { seed, w: style.w, size: 10 });
      mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    } else {
      const p = row ? [a.x + a.w / 2, a.y] : [a.x + a.w, a.y + a.h / 2];
      const q = row ? [b.x + b.w / 2, b.y] : [b.x + b.w, b.y + b.h / 2];
      const lift = row ? Math.min(84, Math.max(38, Math.abs(q[0] - p[0]) * 0.16)) : Math.min(96, 44 + (link.to - link.from) * 14);
      const c1 = row ? [p[0], p[1] - lift] : [p[0] + lift, p[1]];
      const c2 = row ? [q[0], q[1] - lift] : [q[0] + lift, q[1]];
      d += stroke(`M${p[0]} ${p[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${q[0]} ${q[1]}`, style);
      d += arrowHead(q, Math.atan2(q[1] - c2[1], q[0] - c2[0]), { seed, w: style.w, size: 10 });
      mid = [(p[0] + 3 * c1[0] + 3 * c2[0] + q[0]) / 8, (p[1] + 3 * c1[1] + 3 * c2[1] + q[1]) / 8];
    }
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
