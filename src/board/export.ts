/* The live page, with its browser modules and state folded into one file.
   Import maps keep the modules unbundled in the source tree while giving an
   exported page no dependency on the server or the path it was saved under. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Board } from './state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = (): string => fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
const specifier = /\b(?:from\s*|import\s*\()\s*(['"])(\.{1,2}\/[^'"]+)\1/g;

function modules(source: string): Record<string, string> {
  const imports: Record<string, string> = {};
  const visit = (name: string): void => {
    if (imports[`spiega:${name}`]) return;
    const file = path.join(ROOT, name.slice(1));
    let code = fs.readFileSync(file, 'utf8');
    const children: string[] = [];
    code = code.replace(specifier, (match: string, quote: string, relative: string) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), relative));
      children.push(target);
      return match.replace(relative, `spiega:${target}`);
    });
    imports[`spiega:${name}`] = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    for (const child of children) visit(child);
  };
  for (const match of source.matchAll(/from\s*['"](\/src\/[^'"]+)['"]/g)) visit(match[1]);
  return imports;
}

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
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!source) throw new Error('board page has no module');
  const imports = modules(source);
  const config = { board: state, viewing: chapter === null ? viewing : null, active, chapterOnly: chapter !== null };
  return html
    .replace('<link rel="icon" type="image/svg+xml" href="/icon.svg">', '')
    .replace('<script type="module">', `<script>window.__SPIEGA_EXPORT__=${safeJSON(config)}</script>\n<script type="importmap">${safeJSON({ imports })}</script>\n<script type="module">`)
    .replaceAll(/from '([^']*\/src\/[^']+)'/g, (_, spec: string) => `from 'spiega:${spec}'`);
}
