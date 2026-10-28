/* ============================================================
   handwave snapshot — one self-contained file you can keep.

   A board is a thing you talked over; a snapshot is the thing you paste into
   the PR afterwards. It carries the drawing, what was said, and the numbered
   steps, with no server, no scripts and no outside requests.
   ============================================================ */

import { renderSVG } from '../render/render.js';
import { PAPER, PANEL, INK, MUTED, RULE, SOFT, ACCENT, MONO, paperTexture } from '../render/theme.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mdish = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

export function snapshotHTML(board, { active = null, title = null } = {}) {
  const step = active == null || active === '' ? board.active : Number(active);
  // The texture is worth the cost here: a snapshot is rendered once and never
  // animates, so it gets the full ink-on-paper filter the live board skips.
  const { svg, steps } = renderSVG(board, {
    margin: 20, active: Number.isFinite(step) ? step : null, placed: board.placed, hand: true,
  });
  const heading = title || board.title || 'Board';
  const said = (board.transcript || []).map(t => `<li>${mdish(t.text)}</li>`).join('');
  const flow = (steps || []).map((s, i) =>
    `<li${i === step ? ' class="on"' : ''}><span class="n">${s._n ?? '·'}</span>${esc(s.step || s.edge || '')}</li>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)}</title>
<style>
  :root{--paper:${PAPER};--panel:${PANEL};--ink:${INK};--muted:${MUTED};--rule:${RULE};--soft:${SOFT};--accent:${ACCENT}}
  *{box-sizing:border-box}
  body{margin:0;background:${PAPER};background-image:${paperTexture};color:${INK};
    font:13px/1.6 ${MONO};padding:32px 24px 64px}
  .wrap{max-width:1180px;margin:0 auto}
  header{display:flex;align-items:center;gap:10px;margin:0 0 22px}
  header .dot{width:9px;height:9px;border-radius:50%;background:${ACCENT}}
  h1{font-size:19px;letter-spacing:.02em;margin:0;text-transform:uppercase}
  .card{position:relative;background:${PANEL};border:1.5px solid ${INK};border-radius:16px;
    box-shadow:5px 5px 0 ${INK};overflow:hidden;padding:10px}
  .card::after{content:"";position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.4;
    background-size:180px 180px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .18  0 0 0 0 .15  0 0 0 0 .11  .5 0 0 0 0'/></filter><rect width='100%' height='100%' filter='url(%23g)' opacity='.55'/></svg>")}
  .card svg{display:block;margin:0 auto;max-width:100%;height:auto}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:26px}
  @media (max-width:860px){.cols{grid-template-columns:1fr}}
  h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${MUTED};margin:0 0 10px;font-weight:700}
  ol,ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}
  li{background:${PANEL};border:1.5px solid ${INK};border-radius:11px;padding:8px 11px;font-size:12.5px}
  li.on{box-shadow:3px 3px 0 ${ACCENT}}
  li .n{display:inline-block;min-width:19px;height:19px;line-height:18px;text-align:center;border:1.4px solid ${INK};
    border-radius:50%;font-size:11px;font-weight:700;margin-right:9px}
  code{background:${SOFT};padding:1px 4px;border-radius:4px}
  footer{margin-top:30px;color:${MUTED};font-size:11px;letter-spacing:.06em}
</style></head>
<body><div class="wrap">
  <header><span class="dot"></span><h1>${esc(heading)}</h1></header>
  <div class="card">${svg}</div>
  <div class="cols">
    ${flow ? `<section><h2>The flow</h2><ol>${flow}</ol></section>` : ''}
    ${said ? `<section><h2>What was said</h2><ul>${said}</ul></section>` : ''}
  </div>
  <footer>drawn with handwave</footer>
</div></body></html>`;
}
