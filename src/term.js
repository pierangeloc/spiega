/* ============================================================
   Terminal dressing.

   handwave's whole argument is that a picture beside the words beats a wall of
   text, so its own output should not be a wall of text either. This is the
   small amount of machinery needed to lay a terminal out in columns and mark
   things with a glyph rather than a word.

   Two rules it follows, both of which exist because breaking them is rude:

   - Colour only to a terminal. Piped into a file, a pager, or an agent reading
     the output, escape codes are noise at best and corrupt the data at worst.
     NO_COLOR is honoured; FORCE_COLOR overrides in the other direction.
   - Unicode only where the locale suggests it will render. A box-drawing
     character that lands as a question mark is worse than the hyphen it
     replaced.
   ============================================================ */

const env = process.env;

export const colourful = () => {
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY) && env.TERM !== 'dumb';
};

export const fancy = () => {
  if (env.HANDWAVE_ASCII) return false;
  const l = `${env.LC_ALL || ''}${env.LC_CTYPE || ''}${env.LANG || ''}`;
  return /UTF-?8/i.test(l) || Boolean(process.stdout.isTTY);
};

/* The palette is the board's: ink, a muted grey for anything secondary, the
   accent for the one thing that wants reading. */
const CODES = {
  reset: 0, bold: 1, dim: 2,
  ink: 39, muted: 90, accent: 31, good: 32, warn: 33, cool: 36,
};

const wrap = name => s => (colourful() ? `\u001b[${CODES[name]}m${s}\u001b[0m` : String(s));

export const c = {
  bold: wrap('bold'), dim: wrap('muted'), muted: wrap('muted'),
  accent: wrap('accent'), good: wrap('good'), warn: wrap('warn'), cool: wrap('cool'),
  plain: String,
};

export const sym = () => (fancy()
  ? { ok: '✓', bad: '✗', warn: '!', idle: '·', arrow: '→', dot: '·' }
  : { ok: 'ok', bad: 'XX', warn: '!', idle: '-', arrow: '->', dot: '-' });

export const cols = () => process.stdout.columns || 80;

/* Visible width: what the terminal will give the string, ignoring escapes. */
export const visible = s => String(s).replace(/\u001b\[[0-9;]*m/g, '').length;

export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visible(s)));

/* A path shortened from the left, because the end of a path is the part that
   identifies it and the beginning is usually your home directory. */
export function shortPath(p, max = 48) {
  const home = process.env.HOME || '';
  let s = home ? String(p).replace(home, '~') : String(p);
  if (s.length <= max) return s;
  const parts = s.split('/');
  while (parts.length > 2 && parts.join('/').length > max) parts.splice(1, 1);
  s = parts.join('/');
  return s.length <= max ? s.replace(/^(~?)\//, '$1/…/') : '…' + s.slice(-(max - 1));
}

export const rule = (n = cols() - 2) => c.dim((fancy() ? '─' : '-').repeat(Math.max(4, n)));

/* A title with a rule running off to the right of it, which reads as a heading
   without costing three lines. */
export function heading(text) {
  const t = ` ${c.bold(text)} `;
  const n = cols() - visible(t) - 3;
  return `\n${t}${c.dim((fancy() ? '─' : '-').repeat(Math.max(2, n)))}\n`;
}
