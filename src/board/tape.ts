/* ============================================================
   What the narrator reads, and where it is up to.

   The narrator (narrate.js) is a player: it takes a list of sections, speaks
   them in order, and says which one it is on. It has no idea what the sections
   are. What they are is decided here — one chapter's script, or the whole
   board's — kept out of the page so it can be tested without a DOM, the way
   script.js keeps its reasoning.

   The whole board's tape is the part that needs care, because it is made of
   two different things and only one of them was ever said by anyone:

     the outline   the board's own voice. A title, a chapter count, and for
                   each chapter its name and the first thing the agent said in
                   it — which is what the map card already shows. Nothing
                   here is in the transcript and nothing is written to it:
                   the rail is a record of what the agent said, and a line
                   the board made up has no business in it.

     the chapters  each chapter's own script, line by line, exactly as the
                   rail has it, each section remembering which chapter it
                   belongs to so the page can open that chapter as the tape
                   reaches it.

   No `node:` imports, ever — this is loaded by the browser (see state.js).
   ============================================================ */

import { lineStates } from './script.js';
import { boardMap } from './map.js';
import type { Board, Chapter } from './state.js';

/**
 * One thing the narrator speaks.
 *
 * `chapter` is an index into `board.chapters`, null for the live chapter, and
 * absent for the outline, which belongs to no chapter — it is the board talking
 * about all of them. `card` is the chapter's number on the map, which is how
 * the page finds the card to light.
 */
export type Section = {
  kind: 'outline' | 'line',
  /** Which piece of a map card an outline section is. */
  part?: 'lede' | 'title' | 'line',
  chapter?: number | null,
  card?: number,
  /** Index into that chapter's transcript. */
  line?: number,
  text: string,
  step?: number | null,
};

export type RailMark = 'heard' | 'now' | 'ahead' | null;

/* The words as the board prints them. The rail and the map card run a line
   through a small markdown pass before showing it, and what is spoken has to be
   what is shown or the lit word drifts off the spoken one; this is the same
   pass with the tags left out. */
export const plain = (s: string): string => String(s ?? '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1');

/* The map's heading, and the first thing the outline says. One function for
   both, so the sentence that is read is the sentence that is lit. */
export const ledeText = (title: string | undefined, count: number): string =>
  title ? `${title} — ${count} chapters` : `${count} chapters`;

/* One chapter's script as sections, in the order it was said. */
export function chapterSections(
  surface: Chapter | Board,
  chapter: number | null,
  card?: number,
): Section[] {
  const states = lineStates(surface);
  return (surface?.transcript || []).map((e, i) => ({
    kind: 'line', chapter, card, line: i, text: plain(e.text), step: states[i]?.step ?? null,
  }));
}

/* A board's worth of tape is only worth having when there is more than one
   chapter to tell apart. With one, an outline would announce a table of
   contents of a single entry, and the map has nothing to say that the chapter
   does not. */
export const worthAnOutline = (board: Board | null | undefined): boolean =>
  boardMap(board).cards.length >= 2;

/* The 30,000-foot view, then the dive.

   Outline first, built from what the map cards hold; then each chapter's
   script in order. A chapter nobody said anything in contributes nothing to
   the dive — there is no line for the board to open it on — but it is still in
   the outline, where it belongs, with only its name. */
export function wholeTape(board: Board): Section[] {
  const { cards } = boardMap(board);
  const tape: Section[] = [{ kind: 'outline', part: 'lede', text: ledeText(board.title, cards.length) }];
  for (const c of cards) {
    tape.push({ kind: 'outline', part: 'title', card: c.n, text: c.title });
    if (c.line) tape.push({ kind: 'outline', part: 'line', card: c.n, text: plain(c.line) });
  }
  for (const c of cards) {
    const surface: Chapter | Board = c.live || c.i === null ? board : board.chapters[c.i];
    tape.push(...chapterSections(surface, c.i, c.n));
  }
  return tape;
}

/* Which tape to hand the narrator. `whole` is what the reader asked for by
   pressing play on the map; it is honoured only when there is a board's worth
   to read. `surface` is the chapter being looked at, for the other case. */
export function tapeOf(
  board: Board | null | undefined,
  { whole, surface, viewing }: {
    whole: boolean,
    surface: Chapter | Board | null | undefined,
    viewing: number | null,
  },
): Section[] {
  if (whole && board && worthAnOutline(board)) return wholeTape(board);
  return surface ? chapterSections(surface, viewing) : [];
}

/* Where a rail row is on the tape: the section for line `line` of `chapter`,
   or -1 when that line is not on this tape. The rail knows its rows by their
   place in one chapter's transcript; the narrator knows sections by their place
   in the whole tape, and a click has to be turned from one into the other. */
export const locate = (tape: Section[], chapter: number | null, line: number): number =>
  tape.findIndex(s => s.kind === 'line' && s.chapter === chapter && s.line === line);

/* How each row of the rail stands against the playhead, for the rows of one
   chapter: `heard` it has been read, `now` it is being read, `ahead` it is yet
   to come. A row's place is found on the tape rather than assumed, because on
   a whole-board tape a chapter's rows are not at the front of it — and so every
   row of an earlier chapter is heard and every row of a later one is ahead,
   which is the truth about a tape that is part-way through the dive.

   Null for every row before the tape has started: marks that said "all of this
   is ahead" would be noise on a board nobody has pressed play on. */
export function railMarks(
  tape: Section[],
  index: number,
  chapter: number | null,
  rows: number,
): RailMark[] {
  const marks: RailMark[] = [];
  for (let line = 0; line < rows; line++) {
    const at = locate(tape, chapter, line);
    marks.push(index < 0 || at < 0 ? null : at < index ? 'heard' : at === index ? 'now' : 'ahead');
  }
  return marks;
}

/* Speeds, in the order a player cycles through them. The narrator takes
   anything from 0.5 to 2.5; these are the ones worth stopping on, and each
   press is a restart of the sentence, so a slider that sweeps through forty
   values would restart it forty times. */
export const RATES = [0.75, 1, 1.25, 1.5, 2] as const;

/* The next speed on the dial. A rate that is not on it — `[` and `]` step by a
   tenth — moves to the next one above, and the top wraps to the bottom. */
export const nextRate = (rate: number): number =>
  RATES.find(r => r > rate + 1e-9) ?? RATES[0];

export const rateLabel = (rate: number): string => `${Number(rate.toFixed(2))}×`;
