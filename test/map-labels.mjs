import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mapLinks from '../src/board/map-links.js';

const cards = [
  { x: 0, y: 60, w: 200, h: 120 }, { x: 244, y: 60, w: 200, h: 96 },
  { x: 488, y: 60, w: 200, h: 120 }, { x: 0, y: 290, w: 200, h: 150 },
  { x: 244, y: 290, w: 200, h: 90 }, { x: 488, y: 290, w: 200, h: 120 },
];
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// The actual narrow gutter in #211, and a label large enough to read as a pill.
const ink = mapLinks.linkInk(cards[0], cards[1], { from: 1, to: 2, shared: ['orders api'] });
const label = { mid: ink.mid, w: 84, h: 20 };
const placed = mapLinks.placeMapLabels([label], cards)[0];
assert.ok(cards.every(card => !overlap(placed, card)), 'the orders api label must clear every card');

// A tall neighbouring card reaches the midpoint of the right-hand bow.
const tallCards = cards.map((r, i) => i === 2 ? { ...r, h: 190 } : r);
const bow = mapLinks.linkInk(tallCards[1], tallCards[4], { from: 2, to: 5, shared: ['orders table'] });
const bowLabel = { mid: bow.mid, w: 84, h: 20 };
const labels = mapLinks.placeMapLabels([bowLabel, bowLabel], tallCards);
assert.equal(labels.length, 2);
assert.ok(labels.every(r => tallCards.every(card => !overlap(r, card))), 'bowed labels clear all cards, not just their endpoints');
assert.ok(!overlap(labels[0], labels[1]), 'decluttering does not put labels on each other');
const free = mapLinks.placeMapLabels([{ mid: [100, 100], w: 40, h: 20 }], []);
assert.deepEqual(free, [{ x: 80, y: 90, w: 40, h: 20 }], 'an unobstructed pill stays on its line');

// The regression picture must paint opaque pills after the lines, like the page.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-map-labels-'));
try {
  const out = path.join(dir, 'map.svg');
  execFileSync(process.execPath, [path.join(root, 'tools/example.js'), path.join(root, 'test/boards/issue-211-map-labels.json'), out]);
  const svg = fs.readFileSync(out, 'utf8');
  assert.match(svg, /<rect class="maplabel"[^>]*fill="#f8f6f0"/, 'shared labels knock the line out');
  assert.match(svg, /<rect class="maplabel"[^>]*fill="#f2efe7"/, 'then labels knock the line out');
  assert.ok(svg.lastIndexOf('<path ') < svg.indexOf('<rect class="maplabel"'), 'all pills paint over all links');
  const pills = [...svg.matchAll(/<rect class="maplabel"([^>]*)\/>((?:<text\b[^>]*>.*?<\/text>)+)/g)];
  const warehouse = pills.find(([, , texts]) => />warehouse<\/text>/.test(texts));
  assert.ok(warehouse, 'warehouse stays a whole word even when it is wider than the gutter');
  const attr = name => Number(warehouse[1].match(new RegExp(`\\b${name}="([^"]+)"`))[1]);
  const warehouseBox = { x: attr('x'), y: attr('y'), w: attr('width'), h: attr('height') };
  assert.ok(warehouseBox.w >= 'warehouse'.length * 5.4, 'the pill has room for the whole word');
  assert.ok(cards.every(card => !overlap(warehouseBox, card)), 'the whole word clears every card');

  // The normal 92px page gutter can also be narrower than a single long name.
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'test/boards/issue-211-map-labels.json'), 'utf8'));
  spec.map.width = 816;
  spec.map.gap[0] = 92;
  const longName = 'unbrokenwarehouseidentifier';
  for (const chapter of spec.map.chapters) chapter.nodes = chapter.nodes.map(s => s === 'warehouse' ? longName : s);
  const longSpec = path.join(dir, 'long.json');
  fs.writeFileSync(longSpec, JSON.stringify(spec));
  execFileSync(process.execPath, [path.join(root, 'tools/example.js'), longSpec, out]);
  const longSvg = fs.readFileSync(out, 'utf8');
  assert.match(longSvg, new RegExp(`<rect class="maplabel"[^>]*/><text\\b[^>]*>${longName}</text>`),
    'a long single word also stays whole in a normal same-row gutter');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('  ok  map labels clear cards');
