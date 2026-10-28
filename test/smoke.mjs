/* A smoke test over the whole path: ops in, board state, SVG out, snapshot out.
   Run with `node test/smoke.mjs`. No framework, no network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyBoard, applyOps } from '../src/board/state.js';
import { renderSVG } from '../src/render/render.js';
import { snapshotHTML } from '../src/board/snapshot.js';
import { KINDS } from '../src/render/glyphs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

test('an op list builds a board, and ids come from labels', () => {
  const b = emptyBoard();
  const { errors } = applyOps(b, [
    { op: 'title', text: 'T' },
    { op: 'node', kind: 'gateway', label: 'API Gateway' },
    { op: 'node', id: 'orders', kind: 'service', label: 'Orders' },
    { op: 'edge', from: 'api-gateway', to: 'orders', label: 'gRPC' },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(b.title, 'T');
  assert.deepEqual(b.nodes.map(x => x.id), ['api-gateway', 'orders']);
});

test('redrawing an id updates it instead of adding a second', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'a', label: 'A', sub: 'two' }]);
  assert.equal(b.nodes.length, 1);
  assert.equal(b.nodes[0].sub, 'two');
});

test('an unknown op is reported, not thrown', () => {
  const b = emptyBoard();
  const { errors } = applyOps(b, [{ op: 'nope' }]);
  assert.equal(errors.length, 1);
});

test('columns come from the edges', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'node', id: 'c', label: 'C' },
    { op: 'edge', from: 'a', to: 'b' }, { op: 'edge', from: 'b', to: 'c' },
  ]);
  const { boxes } = renderSVG(b);
  assert.equal(boxes.a.col, 0);
  assert.equal(boxes.b.col, 1);
  assert.equal(boxes.c.col, 2);
  assert.ok(boxes.a.x < boxes.b.x && boxes.b.x < boxes.c.x);
});

test('a node added later does not move the ones already placed', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'edge', from: 'a', to: 'b' }]);
  const before = renderSVG(b).boxes;
  applyOps(b, [{ op: 'node', id: 'c', label: 'C' }, { op: 'edge', from: 'a', to: 'c' }]);
  const after = renderSVG(b).boxes;
  assert.equal(before.a.col, after.a.col);
  assert.equal(before.b.col, after.b.col);
});

test('every kind renders, and the same board draws the same strokes', () => {
  const b = emptyBoard();
  applyOps(b, KINDS.map((k, i) => ({ op: 'node', id: 'k' + i, kind: k, label: k, sub: 'x' })));
  const a1 = renderSVG(b).svg, a2 = renderSVG(b).svg;
  assert.equal(a1, a2, 'wobble must be seeded, not random');
  for (const k of KINDS) assert.ok(a1.includes(k.toUpperCase()) || a1.includes(k), k);
});

test('focusing a step lights one edge and dims the rest, but never a note', () => {
  const b = emptyBoard();
  applyOps(b, [
    { op: 'node', id: 'a', label: 'A' }, { op: 'node', id: 'b', label: 'B' },
    { op: 'note', id: 'n', label: 'aside' },
    { op: 'edge', from: 'a', to: 'b' },
    { op: 'step', edge: 'a>b', step: 'a calls b' },
    { op: 'focus', step: 0 },
  ]);
  const svg = renderSVG(b).svg;
  assert.ok(svg.includes('#ef6a4c'), 'the lit path should use the accent');
  const note = svg.slice(svg.indexOf('data-node="n"'));
  assert.ok(note.startsWith('data-node="n" opacity="1"'), 'a note must not dim');
});

test('a snapshot is standalone: no scripts, no outside requests', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'title', text: 'S' }, { op: 'node', id: 'a', kind: 'service', label: 'A' },
    { op: 'say', text: 'hello' }]);
  const html = snapshotHTML(b);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(html), 'a snapshot must carry no scripts');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), 'a snapshot must fetch nothing');
  assert.ok(html.includes('<svg') && html.includes('hello'));
});

test('the shipped example renders', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/order-flow.json'), 'utf8'));
  const { svg, width } = renderSVG(spec);
  assert.ok(width > 400 && svg.length > 10000);
});

/* The board page is half the product and none of the tests above touch it: a
   syntax error in its inline module silently stops the whole page — no event
   stream, no drawing — while the server goes on happily collecting ops. That
   failure is invisible to every test that only exercises the renderer. */
import vm from 'node:vm';

const parses = (src, what) => {
  // strip module syntax so the rest can be parsed as a plain script, and the
  // browser globals that run at module top level
  const body = src
    .replace(/^\s*import\s[^;]*;?$/gm, '')
    .replace(/^\s*export\s+(?=(function|const|let|class))/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?$/gm, '')
    .replace(/matchMedia\([^)]*\)\.matches/g, 'false');
  try { new vm.Script(body, { filename: what }); }
  catch (e) { throw new Error(`${what} does not parse: ${e.message}`); }
};

test('the board page module parses', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/board/board.html'), 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'board.html should have a module script');
  parses(m[1], 'board.html <script type=module>');
});

test('the browser-side modules parse', () => {
  for (const f of ['src/board/draw-on.js', 'src/render/render.js', 'src/render/ink.js',
                   'src/render/glyphs.js', 'src/render/edges.js', 'src/render/layout.js']) {
    parses(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
  }
});

console.log(`\n${n} passed`);
