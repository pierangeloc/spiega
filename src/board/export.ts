/* The board page, with the board's state folded in: one file that opens off
   disk. The page the build writes is already self-contained — stylesheet and
   bundle inline, nothing fetched — so all an export adds is the state, in
   front of the bundle that reads it. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board } from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = (): string => fs.readFileSync(path.join(ROOT, 'src/board/index.html'), 'utf8');

const safeJSON = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/* Which part of the board, and which view of it, the file opens on. `viewing`
   is a chapter's index or one of the page's own tabs; `active` is the lit
   step, counting from 0. */
export type ExportOptions = {
  chapter?: number | null,
  viewing?: number | 'live' | 'map' | null,
  active?: number | null,
};

export function exportHTML(board: Board, { chapter = null, viewing = null, active = null }: ExportOptions = {}): string {
  if (chapter !== null && (!Number.isInteger(chapter) || chapter < 0 || chapter > (board.chapters?.length || 0))) {
    throw new Error('no such chapter');
  }
  const surface = chapter === null ? board : chapter === board.chapters?.length ? board : board.chapters[chapter];
  // A chapter export is a board in its own right: no tabs into other chapters,
  // but its flow, transcript, camera, narration and step controls still work.
  const state = chapter === null ? board : { ...surface, chapters: [], chapter: null, log: [] };
  const selected = active === null ? null : Number(active);
  if (chapter !== null && Number.isInteger(selected)) state.active = selected;
  const html = page();
  const bundle = '<script type="module">';
  if (!html.includes(bundle)) throw new Error('board page has no inline bundle');
  const config = { board: state, viewing: chapter === null ? viewing : null, active, chapterOnly: chapter !== null };
  // A replacer function, not a string: `$&` in a board's text is a pattern.
  return html.replace(bundle, () => `<script>window.__SPIEGA_EXPORT__=${safeJSON(config)}</script>\n${bundle}`);
}
