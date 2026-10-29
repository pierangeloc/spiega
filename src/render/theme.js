/* ============================================================
   spiega theme — paper, ink, body colours, the hand filter.

   The palette and the hand-drawn filter follow Colorfigures / ISO-GLOW
   by April Zhu (MIT), itself built on iso-figure by Tolga Cohce (MIT).
   ============================================================ */

export const PAPER  = '#f2efe7';
export const PANEL  = '#f8f6f0';
export const INK    = '#231e16';
export const MUTED  = '#857d6e';
export const RULE   = '#ddd6c8';
export const SOFT   = '#ebe6da';
export const ACCENT = '#ef6a4c';
export const SHADOW = '#41538f';

/* Body colours. Each is a flat three-band material: no gradients, ever.
   l = the lit face, m = the thickness band under it, d = deep ink-tinted detail. */
export const BODIES = {
  tomato:  { l: '#ef6a4c', m: '#cf5038', d: '#4a2219' },
  mustard: { l: '#f4b829', m: '#d49c1f', d: '#4e4a18' },
  mint:    { l: '#93d3b0', m: '#71b693', d: '#1f4034' },
  cobalt:  { l: '#76a0e2', m: '#5a82c6', d: '#1c2948' },
  blush:   { l: '#f3a6bb', m: '#d8869c', d: '#4b2430' },
  slate:   { l: '#c9c3b4', m: '#aaa392', d: '#3d3935' },
  paper:   { l: '#f8f6f0', m: '#e3dfd2', d: '#857d6e' },
};
export const BODY_NAMES = Object.keys(BODIES);

/* Body colour carries meaning on a board, so it is assigned by role, not at random.
   An agent that says nothing gets a sensible colour for the kind of thing it drew. */
export const BODY_FOR_KIND = {
  client:    'paper',
  external:  'paper',
  gateway:   'mustard',
  service:   'cobalt',
  datastore: 'mint',
  queue:     'tomato',
  cache:     'blush',
  compute:   'cobalt',
  note:      'paper',
  boundary:  'slate',
};

export const bodyOf = (name, kind = 'service') =>
  BODIES[name] || BODIES[BODY_FOR_KIND[kind] || 'cobalt'];

export const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

/* mix two hex colours, t = 0 gives a, t = 1 gives b */
export const mix = (a, b, t) =>
  '#' + [1, 3, 5].map(i =>
    Math.round(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t)
      .toString(16).padStart(2, '0')).join('');

/* The hand-drawn filter. Three things happen at once:
   a displacement map pushes every edge off true (the wobble), then two
   multiply-blended noise layers lay grain and blotting over the result, so
   flat fills read as ink on paper rather than as vector shapes.
   k scales with the viewBox so a big board wobbles as much as a small one. */
export const handFilter = (k = 1) => `<filter id="hand" x="-4%" y="-4%" width="108%" height="108%" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="${(0.03 / k).toFixed(4)}" numOctaves="2" seed="4" result="warp"/>
  <feDisplacementMap in="SourceGraphic" in2="warp" scale="${(1.8 * k).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="wob"/>
  <feTurbulence type="fractalNoise" baseFrequency="${(0.9 / k).toFixed(4)}" numOctaves="3" seed="11" result="n1"/>
  <feColorMatrix in="n1" type="matrix" values=".26 0 0 0 .86  .26 0 0 0 .86  .26 0 0 0 .86  0 0 0 0 1" result="grain"/>
  <feTurbulence type="fractalNoise" baseFrequency="${(0.012 / k).toFixed(4)}" numOctaves="2" seed="7" result="n2"/>
  <feColorMatrix in="n2" type="matrix" values=".3 0 0 0 .87  .3 0 0 0 .87  .3 0 0 0 .87  0 0 0 0 1" result="blot"/>
  <feBlend in="wob" in2="grain" mode="multiply" result="g1"/>
  <feBlend in="g1" in2="blot" mode="multiply" result="g2"/>
  <feComposite in="g2" in2="wob" operator="in"/>
</filter>`;

/* The same fibrous noise the page background uses, as a data URI. */
export const paperTexture =
  `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>` +
  `<filter id='p'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/>` +
  `<feColorMatrix values='0 0 0 0 .42  0 0 0 0 .39  0 0 0 0 .33  .14 0 0 0 0'/></filter>` +
  `<rect width='100%' height='100%' filter='url(%23p)'/></svg>")`;
