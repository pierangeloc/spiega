/* ============================================================
   A small amount of mathematics, drawn in the board's own hand.

   Not a typesetter. Enough LaTeX for the formulas people actually put on a
   whiteboard while explaining something — superscripts, subscripts,
   fractions, roots, Greek, and a couple of dozen operators. Bernoulli, not a
   paper.

   Two decisions shape the whole thing.

   **It renders to SVG, here, offline.** A board is drawn in four places and
   only one of them is a browser with a network: the standalone snapshot has a
   test forbidding both scripts and outside requests, because a snapshot is
   meant to be pasteable into a PR and readable in five years. So KaTeX and
   MathJax are out, whatever their merits.

   **Glyphs stay crisp, rules get the wobble.** The board's text is already
   monospace and sharp — the hand-drawn quality lives in the shapes, not the
   lettering. Distorting glyph outlines reads as corruption rather than
   handwriting, because letterforms are tuned and a wobbly "a" just looks
   broken. A fraction bar is a line, and lines are exactly what waver() makes
   look drawn. So a formula here is crisp monospace with hand-drawn rules,
   which is the same grammar as a crisp label inside a wavering box.

   Measuring is arithmetic rather than font metrics, because the face is
   monospace: every glyph advances 0.602 of the font size, Greek and math
   symbols included. Measured, not assumed.
   ============================================================ */

import { text, stroke, roughLine, waver, smooth } from './ink.js';
import { INK } from './theme.js';

type AccentKind = 'vec' | 'hat' | 'bar';

type MathNode =
  | { t: 'ch', s: string }
  | { t: 'op', s: string }
  | { t: 'fn', s: string }
  | { t: 'unknown', s: string }
  | { t: 'spacer', em: number }
  | { t: 'row', items: MathNode[] }
  | { t: 'sup', base: MathNode, script: MathNode }
  | { t: 'sub', base: MathNode, script: MathNode }
  | { t: 'frac', num: MathNode, den: MathNode }
  | { t: 'sqrt', body: MathNode }
  | { t: 'accent', kind: AccentKind, body: MathNode }
  | { t: 'bold', body: MathNode }
  | { t: 'text', body: MathNode };

type Metrics = { w: number, a: number, d: number };

export type MathBox = { w: number, a: number, d: number, h: number };
export type MathPart = { math: string } | { literal: string };
export type DrawMathOpts = {
  size?: number,
  color?: string,
  anchor?: 'start' | 'middle' | 'end',
  seed?: number,
};

/* Advance per character, as a fraction of font size. Measured in the browser
   against ui-monospace/SF Mono/Menlo, for Latin, Greek and math symbols
   alike — a monospace face gives all three the same advance. */
export const ADV = 0.602;

const ASCENT = 0.74;        // top of a capital, above the baseline
const DESCENT = 0.22;       // bottom of a descender, below it
const SCRIPT = 0.72;        // superscripts and subscripts, relative size

/* What `\rho` and friends turn into. A whiteboard needs the letters and the
   dozen operators that actually come up, not the whole of unicode-math. */
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡', propto: '∝',
  sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
  infty: '∞', deg: '°', ldots: '…', cdots: '⋯',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', implies: '⇒',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
  cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
  oint: '∮', iint: '∬', iiint: '∭', oplus: '⊕', otimes: '⊗',
  perp: '⊥', parallel: '∥', angle: '∠', sim: '∼', simeq: '≃',
  ll: '≪', gg: '≫', varepsilon: 'ε', varphi: 'φ', varrho: 'ϱ',
  ell: 'ℓ', hbar: 'ℏ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  neg: '¬', land: '∧', lor: '∨', therefore: '∴',
  quad: '  ', qquad: '    ', ' ': ' ',
};

/* Set upright, as LaTeX does: log n, not l times o times g times n. */
const FUNCTIONS: readonly string[] = ['log', 'ln', 'exp', 'sin', 'cos', 'tan', 'min', 'max',
  'det', 'dim', 'deg', 'arg', 'gcd', 'lim', 'mod'];

/* LaTeX's spacing macros, in eighteenths of an em as LaTeX counts them. They
   are widths, not characters: a thin space is a sixth of an em and a monospace
   cell is three and a half times that, so there is no glyph that can stand in
   for one.

   They are named here because of what happens when they are not. A backslash
   before a non-letter yields that character, which is right for `\$` and `\{`
   and silently wrong for these: `v\,dp` set as `v,dp`, putting a comma in the
   middle of a formula. A thin space that does not appear is a blemish; a comma
   nobody wrote changes what the formula says. */
const SPACERS: Record<string, number> = { ',': 3 / 18, ':': 4 / 18, ';': 5 / 18, '!': -3 / 18 };

/* Spacing is derived, not copied. A space typed in the source is not what a
   reader sees in a formula — LaTeX ignores it and spaces around operators
   instead, which is why `a+b` and `a + b` set identically. Monospace makes
   the difference stark: a literal space is a full character wide, so copying
   the source gives "ρv²+  ρgh" with the gaps in the wrong places. */
const RELATIONS = new Set(['=', '\u2248', '\u2260', '\u2264', '\u2265', '\u2261', '\u221d',
  '\u2192', '\u2190', '\u21d2', '\u2208', '\u2282', '<', '>']);
const BINARIES = new Set(['+', '\u2212', '-', '\u00d7', '\u00b7', '\u00f7', '\u00b1', '\u2213']);
const gapFor = (node: MathNode): number => {
  if (node.t === 'fn') return 0.2;              // n log n, not nlogn
  if (node.t !== 'op') return 0;
  return RELATIONS.has(node.s) ? 0.34 : BINARIES.has(node.s) ? 0.22 : 0;
};

/* ---------- reading it ---------- */

/* A tiny recursive-descent parser. It returns a row of atoms; an atom is a
   run of characters, or one of the four constructions below, and anything it
   does not recognise comes back as literal text rather than as a guess. An
   unrendered `\begin{pmatrix}` on the board is honest; half a matrix is not. */
function parse(src: string): MathNode {
  let i = 0;
  const s = String(src);

  const skipSpace = (): void => { while (s[i] === ' ') i++; };

  const group = (): MathNode => {            // {...} or a single token
    skipSpace();
    if (s[i] === '{') {
      i++;
      const r = row('}');
      if (s[i] === '}') i++;
      return r;
    }
    if (s[i] === '\\') return { t: 'row', items: [command()] };
    const ch = s[i++];
    return { t: 'row', items: ch == null ? [] : [{ t: 'ch', s: ch }] };
  };

  function command(): MathNode {
    i++;                                     // the backslash
    let name = '';
    while (i < s.length && /[a-zA-Z]/.test(s[i])) name += s[i++];
    if (!name) {
      const c = s[i++];
      if (c != null && c in SPACERS) return { t: 'spacer', em: SPACERS[c] };
      return { t: 'ch', s: c ?? '\\' };
    }

    if (name === 'frac' || name === 'tfrac' || name === 'dfrac') {
      return { t: 'frac', num: group(), den: group() };
    }
    if (name === 'sqrt') return { t: 'sqrt', body: group() };
    if (name === 'vec' || name === 'hat' || name === 'bar' || name === 'overline') {
      return { t: 'accent', kind: name === 'overline' ? 'bar' : name, body: group() };
    }
    if (name === 'mathbf' || name === 'bf' || name === 'boldsymbol') {
      return { t: 'bold', body: group() };
    }
    if (name === 'text' || name === 'mathrm' || name === 'operatorname') {
      return { t: 'text', body: group() };
    }
    if (FUNCTIONS.includes(name)) return { t: 'fn', s: name };
    if (name in SYMBOLS) {
      // a relation written as a command spaces like one written as a character:
      // `a \approx b` and `a = b` must set the same way
      const ch = SYMBOLS[name];
      return { t: RELATIONS.has(ch) || BINARIES.has(ch) ? 'op' : 'ch', s: ch };
    }
    return { t: 'unknown', s: '\\' + name };  // shown as written
  }

  function row(stop: string | null): MathNode {
    const items: MathNode[] = [];
    const last = (): MathNode | undefined => items[items.length - 1];
    while (i < s.length && s[i] !== stop) {
      const c = s[i];
      if (c === '^' || c === '_') {
        i++;
        /* `a_i` must put the i under the a, not under everything typed before
           it. A run is merged characters, so the last one is split off. */
        let base: MathNode = items.pop() || { t: 'ch', s: '' };
        if (base.t === 'ch' && base.s.length > 1) {
          items.push({ t: 'ch', s: base.s.slice(0, -1) });
          base = { t: 'ch', s: base.s.slice(-1) };
        }
        const script = group();
        items.push({ t: c === '^' ? 'sup' : 'sub', base, script });
        continue;
      }
      if (c === '\\') { items.push(command()); continue; }
      if (c === '{') { items.push(group()); continue; }
      if (c === '}') break;
      i++;
      if (c === ' ') continue;                 // spacing is derived; see gapFor
      if (RELATIONS.has(c) || BINARIES.has(c)) { items.push({ t: 'op', s: c }); continue; }
      // runs of plain characters stay together, so one <text> covers a word
      const prev = last();
      if (prev?.t === 'ch') prev.s += c; else items.push({ t: 'ch', s: c });
    }
    return { t: 'row', items };
  }

  return row(null);
}

/* ---------- measuring it ---------- */

/* Every node reports a width, an ascent above the baseline and a descent
   below it. The caller needs the box; layout.js sizes a node from it. */
function measure(node: MathNode, size: number): Metrics {
  const em = size;
  switch (node.t) {
    case 'ch':
    case 'op':
    case 'fn':
    case 'unknown':
      return { w: String(node.s).length * ADV * em, a: ASCENT * em, d: DESCENT * em };

    // a gap carries no ink, so it must not stretch the line it sits on
    case 'spacer':
      return { w: node.em * em, a: 0, d: 0 };

    case 'text': {
      const m = measure(node.body, em);
      return { w: m.w, a: m.a, d: m.d };
    }

    case 'row': {
      let w = 0, a = ASCENT * em * 0.6, d = DESCENT * em * 0.6;
      node.items.forEach((it, k) => {
        const m = measure(it, em);
        const gap = gapFor(it);
        // no leading gap on an operator that opens the row, where it is a sign
        if (gap && k > 0) w += gap * em;
        w += m.w;
        if (gap && k > 0 && k < node.items.length - 1) w += gap * em;
        a = Math.max(a, m.a); d = Math.max(d, m.d);
      });
      return { w, a, d };
    }

    case 'sup':
    case 'sub': {
      const b = measure(node.base, em);
      const s = measure(node.script, em * SCRIPT);
      const shift = em * (node.t === 'sup' ? 0.42 : -0.26);
      return {
        w: b.w + s.w,
        a: Math.max(b.a, s.a + shift),
        d: Math.max(b.d, s.d - shift),
      };
    }

    case 'frac': {
      const n = measure(node.num, em * 0.92), dd = measure(node.den, em * 0.92);
      const w = Math.max(n.w, dd.w) + em * 0.3;
      return { w, a: n.a + n.d + em * 0.22, d: dd.a + dd.d + em * 0.06 };
    }

    case 'sqrt': {
      const b = measure(node.body, em);
      return { w: b.w + em * 0.72, a: Math.max(b.a, ASCENT * em) + em * 0.16, d: b.d };
    }

    case 'accent': {
      const b = measure(node.body, em);
      return { w: b.w, a: b.a + em * 0.2, d: b.d };   // the mark sits above
    }

    case 'bold':
      return measure(node.body, em);
  }
}

/* ---------- drawing it ---------- */

/* x is the left edge, y the baseline. Returns SVG, and the geometry it used,
   so a caller can place something beside it. */
function draw(node: MathNode, x: number, y: number, size: number, color: string, seed: number): string {
  const em = size;
  const t = (s: string, xx: number, yy: number, sz: number): string =>
    text(xx, yy, s, { size: sz, color, weight: 600, anchor: 'start', spacing: 0 });

  switch (node.t) {
    case 'ch':
    case 'op':
    case 'fn':
      return t(node.s, x, y, em);

    case 'spacer':
      return '';

    case 'unknown':
      // shown as written, dimmed, so it is obvious nothing was understood
      return text(x, y, node.s, { size: em, color, weight: 600, anchor: 'start', spacing: 0, opacity: 0.55 });

    case 'text':
      return draw(node.body, x, y, em, color, seed);

    case 'row': {
      let out = '', cx = x;
      node.items.forEach((it, k) => {
        const gap = gapFor(it);
        if (gap && k > 0) cx += gap * em;
        out += draw(it, cx, y, em, color, seed + k);
        cx += measure(it, em).w;
        if (gap && k > 0 && k < node.items.length - 1) cx += gap * em;
      });
      return out;
    }

    case 'sup':
    case 'sub': {
      const b = measure(node.base, em);
      const shift = em * (node.t === 'sup' ? 0.42 : -0.26);
      return draw(node.base, x, y, em, color, seed) +
        draw(node.script, x + b.w, y - shift, em * SCRIPT, color, seed + 1);
    }

    case 'frac': {
      /* The rule is the one hand-drawn thing in a formula, and the reason this
         sits on a board at all rather than looking pasted on. */
      const sz = em * 0.92;
      const n = measure(node.num, sz), d = measure(node.den, sz);
      const w = Math.max(n.w, d.w);
      const mid = y - em * 0.26;
      const bar = roughLine([x + em * 0.1, mid], [x + em * 0.1 + w + em * 0.1, mid],
        { seed, amp: 0.55, step: 9 });
      return draw(node.num, x + em * 0.15 + (w - n.w) / 2, mid - n.d - em * 0.14, sz, color, seed + 2) +
        stroke(bar, { w: Math.max(1.3, em * 0.075), color }) +
        draw(node.den, x + em * 0.15 + (w - d.w) / 2, mid + d.a + em * 0.16, sz, color, seed + 3);
    }

    case 'sqrt': {
      const b = measure(node.body, em);
      const top = y - b.a - em * 0.12;
      /* The radical drawn rather than typed: a tick, a rising stroke, and the
         overline carried across the top of what is under the root. */
      const hook = waver([[x, y - b.a * 0.45], [x + em * 0.16, y + em * 0.06],
        [x + em * 0.42, top], [x + em * 0.56, top]], { seed: seed + 5, amp: 0.5, step: 7 });
      return stroke(smooth(hook, false), { w: Math.max(1.3, em * 0.08), color }) +
        stroke(roughLine([x + em * 0.54, top], [x + em * 0.64 + b.w, top],
          { seed: seed + 6, amp: 0.5, step: 9 }), { w: Math.max(1.2, em * 0.07), color }) +
        draw(node.body, x + em * 0.64, y, em, color, seed + 7);
    }

    case 'accent': {
      /* The mark is a stroke, so it wavers like every other line on the board.
         This is the construction that fits here best: a vector arrow drawn by
         hand is what someone actually puts over an E. */
      const b = measure(node.body, em);
      const top = y - b.a - em * 0.1;
      const x0 = x + em * 0.06, x1 = x + b.w - em * 0.06;
      const w = Math.max(1.1, em * 0.07);
      let mark = '';
      if (node.kind === 'vec') {
        mark = stroke(roughLine([x0, top], [x1, top], { seed: seed + 11, amp: 0.4, step: 6 }),
          { w, color }) +
          stroke(smooth([[x1 - em * 0.14, top - em * 0.1], [x1, top], [x1 - em * 0.14, top + em * 0.1]], false),
            { w, color });
      } else if (node.kind === 'bar') {
        mark = stroke(roughLine([x0, top], [x1, top], { seed: seed + 12, amp: 0.4, step: 7 }), { w, color });
      } else {
        const mid = (x0 + x1) / 2;
        mark = stroke(smooth([[mid - em * 0.16, top + em * 0.1], [mid, top - em * 0.05],
          [mid + em * 0.16, top + em * 0.1]], false), { w, color });
      }
      return draw(node.body, x, y, em, color, seed) + mark;
    }

    case 'bold': {
      // the other convention for a vector: heavier, not decorated
      const inner = draw(node.body, x, y, em, color, seed);
      return inner.replace(/font-weight="\d+"/g, 'font-weight="800"');
    }
  }
}

/* ---------- what the rest of the renderer uses ---------- */

/* Does this string contain any inline mathematics? */
export const hasMath = (s?: string | null): boolean => /\$[^$]+\$/.test(String(s ?? ''));

/* Split a string into literal and `$...$` parts, in order. */
export function splitMath(s?: string | null): MathPart[] {
  return String(s ?? '').split(/(\$[^$]+\$)/).filter(Boolean).map(part =>
    part.startsWith('$') && part.endsWith('$') && part.length > 2
      ? { math: part.slice(1, -1) }
      : { literal: part });
}

/* The box a formula needs: width, and its height split around the baseline. */
export function measureMath(src: string, size = 14): MathBox {
  const m = measure(parse(src), size);
  return { w: m.w, a: m.a, d: m.d, h: m.a + m.d };
}

/* Draw one, with `anchor` deciding what x means. Returns a string of SVG. */
export function drawMath(x: number, y: number, src: string, { size = 14, color = INK, anchor = 'start', seed = 1 }: DrawMathOpts = {}): string {
  const tree = parse(src);
  const m = measure(tree, size);
  const left = anchor === 'middle' ? x - m.w / 2 : anchor === 'end' ? x - m.w : x;
  return draw(tree, left, y, size, color, seed);
}
