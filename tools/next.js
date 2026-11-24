#!/usr/bin/env node
/* The React board's half of the build (#153).
 *
 * Two Vite builds out of packages/board, and then one file.
 *
 * The page people open is dist/src/next/index.html, and it is self-contained:
 * stylesheet in a <style>, bundle in an inline <script type="module">, nothing
 * fetched. That is not tidiness. A board has to be screenshottable with no
 * server behind it — that is how this issue is judged, and how the snapshot
 * path verified in #150 works — and a browser on a file:// URL refuses to
 * fetch an external module script. An inline one it runs happily, which is the
 * same trick the old page's export has always used.
 *
 * The second build is for the Node suite: dist/support/board-view.js renders
 * the same components under react-dom/server, because the suites run inside
 * dist/ under plain node and node does not read JSX. It is not in the
 * manifest's `files`, so it never reaches npm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist/src/next');
const CONFIG = 'packages/board/vite.config.ts';

const die = (msg) => {
  console.error('spiega next: ' + msg);
  process.exit(1);
};

function vite(args) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  if (!fs.existsSync(bin)) die('vite is not installed — run `pnpm install` first.');
  const r = spawnSync(bin, [...args, '--config', CONFIG, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/* Fold what Vite wrote into index.html, and refuse anything that would leave
 * the page fetching something. A page that quietly loses its script renders a
 * blank board and says nothing — the failure this repository knows best — so
 * every branch here exits rather than warns.
 */
function fold() {
  const index = path.join(OUT, 'index.html');
  if (!fs.existsSync(index)) die('the client build wrote no index.html');
  let html = fs.readFileSync(index, 'utf8');

  const assets = fs.readdirSync(OUT).filter(f => f !== 'index.html');
  const scripts = assets.filter(f => f.endsWith('.js'));
  const sheets = assets.filter(f => f.endsWith('.css'));
  const rest = assets.filter(f => !scripts.includes(f) && !sheets.includes(f));
  if (scripts.length !== 1) {
    die(`expected one bundle, got ${scripts.length || 'none'}: ${assets.join(', ') || '(nothing)'}`);
  }
  if (rest.length) die(`these would have to be fetched at runtime: ${rest.join(', ')}`);

  for (const sheet of sheets) {
    const css = fs.readFileSync(path.join(OUT, sheet), 'utf8');
    const link = new RegExp(`<link[^>]+href="[^"]*${sheet}"[^>]*>`);
    if (!link.test(html)) die(`${sheet} is not linked from index.html`);
    // A replacer function, not a string: `$&` and `$1` in a stylesheet or a
    // bundle are replacement patterns, and one of them put the tag this is
    // removing back into the page.
    html = html.replace(link, () => `<style>${css}</style>`);
  }

  const code = fs.readFileSync(path.join(OUT, scripts[0]), 'utf8');
  // An inline script ends at the first `</script`, wherever it appears.
  if (/<\/script/i.test(code)) die('the bundle contains a </script and cannot be inlined');
  const tag = new RegExp(`<script[^>]+src="[^"]*${scripts[0]}"[^>]*></script>`);
  if (!tag.test(html)) die(`${scripts[0]} is not loaded from index.html`);
  html = html.replace(tag, () => `<script type="module">${code}</script>`);

  const fetched = [...html.matchAll(/\s(?:src|href)="(?!data:)([^"]+)"/g)].map(m => m[1]);
  if (fetched.length) die(`the page is not self-contained, it still asks for: ${fetched.join(', ')}`);

  fs.writeFileSync(index, html);
  for (const asset of assets) fs.rmSync(path.join(OUT, asset));
  return { bytes: Buffer.byteLength(html), script: Buffer.byteLength(code) };
}

export function buildNextBoard() {
  vite(['build']);
  /* The entry is in vite.config.ts and is named here again on purpose: a bare
   * `--ssr` is a boolean, and it overrides the configured entry with `true` —
   * at which point Vite falls back to index.html and refuses it. */
  vite(['build', '--ssr', 'src/view/ssr.tsx']);
  return fold();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bytes, script } = buildNextBoard();
  console.log(`spiega next: dist/src/next/index.html, ${Math.round(bytes / 1024)} KB` +
    ` (${Math.round(script / 1024)} KB of it the bundle)`);
}
