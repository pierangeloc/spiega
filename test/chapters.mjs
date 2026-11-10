/* One explanation, several surfaces (#51).

   Run with `node test/chapters.mjs`. Its own process because the state
   directory is read once, at import, from HOME.

   What is being protected: a chapter break keeps what was taught. Four
   chapters of one explanation used to be four `clear`s and four orphan files
   in ~/Downloads, with the person asking, reasonably, where the other three
   were. So the checks here are about *nothing being lost* — the drawing, the
   script, the steps and the step attribution of a chapter that is no longer
   the one being drawn on, through a restore, a compaction and a reload. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spiega-chapters-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { createServer } = await import('../src/board/server.js');
const { emptyBoard, applyOps, boardOps } = await import('../src/board/state.js');
const { scriptSteps } = await import('../src/board/script.js');
const { renderSVG } = await import('../src/render/render.js');
const { audit } = await import('../src/render/audit.js');
const { specToOps } = await import('../src/spec.js');

let n = 0;
const test = async (name, fn) => {
  try {
    await fn();
    n++;
    console.log('  ok  ' + name);
  } catch (e) {
    process.exitCode = 1;
    console.log('  FAIL  ' + name + '\n        ' + (e.stack || e.message).split('\n').join('\n        '));
  }
};

/* Two chapters of one explanation, each with its own box called `fat`: the
   same word for different things is what chapters are for. */
const taught = [
  { op: 'title', text: 'De stof van het leven' },
  { op: 'chapter', title: 'Nutrients' },
  { op: 'node', id: 'fat', label: 'Fat' },
  { op: 'node', id: 'energy', label: 'Energy' },
  { op: 'edge', from: 'fat', to: 'energy', label: '38 kJ/g' },
  { op: 'step', edge: 'fat>energy', step: 'Fat is the dense one' },
  { op: 'focus', step: 0 },
  { op: 'say', text: 'Fat carries twice what sugar does.' },
  { op: 'chapter', title: 'Enzymes' },
  { op: 'node', id: 'fat', label: 'Fat' },
  { op: 'node', id: 'lipase', label: 'Lipase' },
  { op: 'edge', from: 'fat', to: 'lipase', label: 'substrate' },
  { op: 'say', text: 'The same fat, taken apart.' },
];

const drawn = ops => { const b = emptyBoard(); applyOps(b, ops); return b; };

await test('the first chapter names the surface rather than setting an empty one aside', async () => {
  const b = drawn([{ op: 'chapter', title: 'Nutrients' }]);
  assert.equal(b.chapter, 'Nutrients');
  assert.deepEqual(b.chapters, [], 'an empty surface is named, not filed');
  applyOps(b, [{ op: 'chapter', title: 'Still nothing drawn' }]);
  assert.deepEqual(b.chapters, [], 'and renaming it again does not file it either');
});

await test('a break keeps the chapter whole and starts a clean surface', async () => {
  const b = drawn(taught);
  assert.equal(b.chapter, 'Enzymes');
  assert.deepEqual(b.chapters.map(c => c.title), ['Nutrients']);
  const first = b.chapters[0];
  assert.deepEqual(first.nodes.map(x => x.id), ['fat', 'energy'], 'its drawing is still there');
  assert.equal(first.flow.length, 1, 'and its steps');
  assert.equal(first.transcript.length, 1, 'and its script');
  assert.deepEqual(b.nodes.map(x => x.id), ['fat', 'lipase'], 'the live surface is its own');
});

/* A chapter is its own namespace. If it were not, the `fat` of chapter two
   would silently edit the `fat` of chapter one — a board changing behind the
   reader's back, in a part of the explanation nobody is looking at. */
await test('the same id in two chapters is two boxes', async () => {
  const b = drawn([...taught, { op: 'node', id: 'fat', label: 'Fat, broken up' }]);
  assert.equal(b.chapters[0].nodes.find(x => x.id === 'fat').label, 'Fat');
  assert.equal(b.nodes.find(x => x.id === 'fat').label, 'Fat, broken up');
});

/* The rail works out which line goes with which step partly by walking the log
   and counting `say` ops. One log, several chapters: without the reset that
   walk files this chapter's lines under the last chapter's steps. */
await test('a finished chapter keeps its step tags, and the live one borrows none', async () => {
  const b = drawn(taught);
  assert.deepEqual(b.chapters[0].transcript.map(l => l.step), [0],
    'said while step 1 was lit, and frozen that way when the chapter closed');
  assert.deepEqual(scriptSteps(b.chapters[0]), [0], 'so it reads without the log at all');
  assert.deepEqual(scriptSteps(b), [null],
    'the live chapter has no steps, and must not inherit the previous chapter\'s focus');
});

await test('chapters survive a restore and a compaction', async () => {
  const b = drawn(taught);
  const strip = x => JSON.stringify(x, (k, v) => (k === 'at' ? undefined : v));
  const restored = drawn(b.log.map(({ at, ...op }) => op));
  assert.equal(strip(restored.chapters), strip(b.chapters), 'replayed from its own log');
  assert.equal(strip(restored.nodes), strip(b.nodes));
  const compact = drawn(boardOps(b));
  assert.equal(strip(compact.chapters), strip(b.chapters), 'rebuilt from the minimal op set');
  assert.equal(compact.chapter, 'Enzymes');
  assert.equal(strip(compact.nodes), strip(b.nodes));
});

await test('clear takes the chapters with it, because it is a different explanation', async () => {
  const b = drawn([...taught, { op: 'clear' }]);
  assert.deepEqual(b.chapters, []);
  assert.equal(b.chapter, '');
  assert.deepEqual(b.nodes, []);
});

/* #56's report measures what is being drawn on now. That is what makes
   "this board is crowded, start a chapter" an instruction with an effect:
   the number it complained about goes away with the surface it was about. */
await test('the audit measures the live chapter, so a break clears it', async () => {
  const fan = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/boards/issue-56-arrow-under-box.json'), 'utf8'));
  const b = drawn(specToOps(fan));
  assert.equal(audit(b, renderSVG(b, { margin: 16 })).buried.length, 2, 'crowded as one surface');
  applyOps(b, [{ op: 'chapter', title: 'The budgets' },
    { op: 'node', id: 'cost' }, { op: 'node', id: 'risk' }, { op: 'edge', from: 'cost', to: 'risk' }]);
  assert.deepEqual(audit(b, renderSVG(b, { margin: 16 })).buried, [],
    'and clean on the one being drawn on now');
  assert.equal(b.chapters[0].nodes.length, 14, 'while the crowded chapter is still there to read');
});

/* ---------- going back to a chapter already taught ---------- */

/* Aimed, never entered. An agent that could *move* to chapter one would have
   to remember to come back, and the turn it forgot would put the rest of the
   explanation in the wrong chapter with nothing on screen to say so. */
await test('an amendment lands in the chapter it names and nowhere else', async () => {
  const b = drawn(taught);
  const r = applyOps(b, [{ op: 'amend', chapter: 1, ops: [
    { op: 'node', id: 'protein', label: 'Protein' },
    { op: 'edge', from: 'protein', to: 'energy', label: '17 kJ/g' },
    { op: 'say', text: 'Protein too, in a pinch.' },
  ] }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.fresh.nodes, ['protein'], 'what is new is reported as new, so the page can draw it on');
  assert.deepEqual(b.chapters[0].nodes.map(x => x.id), ['fat', 'energy', 'protein']);
  assert.equal(b.chapters[0].transcript.length, 2);
  assert.deepEqual(b.nodes.map(x => x.id), ['fat', 'lipase'], 'the chapter being drawn on is untouched');
  assert.equal(b.chapter, 'Enzymes', 'and still the one being drawn on');
});

await test('a chapter can be named by its title, and corrected by drawing it again', async () => {
  const b = drawn(taught);
  applyOps(b, [{ op: 'amend', chapter: 'Nutrients', ops: { op: 'node', id: 'fat', label: 'Fat (38 kJ/g)' } }]);
  assert.equal(b.chapters[0].nodes.find(x => x.id === 'fat').label, 'Fat (38 kJ/g)');
  assert.equal(b.chapters[0].nodes.length, 2, 'corrected, not added a second time');
  assert.equal(b.nodes.find(x => x.id === 'fat').label, 'Fat',
    'the box of the same name in the live chapter is a different box, and keeps its own label');
});

/* An agent cannot look at the board to find the number it got wrong. */
await test('a chapter that is not there is answered with the ones that are', async () => {
  const b = drawn(taught);
  const { errors } = applyOps(b, [{ op: 'amend', chapter: 9, ops: [] }]);
  assert.match(errors[0], /there is no chapter 9/);
  assert.match(errors[0], /1 Nutrients, 2 Enzymes \(being drawn\)/);
  assert.match(applyOps(b, [{ op: 'amend', chapter: 'Spoilage', ops: [] }]).errors[0],
    /no chapter is called "Spoilage"/);
});

await test('what is about the whole explanation is refused inside an amendment', async () => {
  const b = drawn(taught);
  for (const op of ['clear', 'chapter', 'title', 'amend']) {
    const { errors } = applyOps(b, [{ op: 'amend', chapter: 1, ops: [{ op }] }]);
    assert.match(errors[0] || '', new RegExp(`"${op}" is about the whole explanation`), `${op} should be refused`);
  }
  assert.equal(b.chapters.length, 1, 'and none of them did anything');
  assert.deepEqual(b.chapters[0].nodes.map(x => x.id), ['fat', 'energy']);
});

/* One entry in the log, carrying what landed — not a handful of loose ops that
   would replay into whichever chapter happened to be live at the time. */
await test('an amendment replays and compacts back into the same chapter', async () => {
  const b = drawn([...taught,
    { op: 'amend', chapter: 1, ops: { op: 'node', id: 'protein', label: 'Protein' } }]);
  const entry = b.log[b.log.length - 1];
  assert.equal(entry.op, 'amend');
  assert.equal(entry.chapter, 1);
  assert.equal(entry.ops.length, 1);

  const restored = drawn(b.log.map(({ at, ...op }) => op));
  assert.deepEqual(restored.chapters[0].nodes.map(x => x.id), ['fat', 'energy', 'protein']);
  assert.deepEqual(restored.nodes.map(x => x.id), ['fat', 'lipase'], 'and not into the live chapter');

  const compact = drawn(boardOps(b));
  assert.deepEqual(compact.chapters[0].nodes.map(x => x.id), ['fat', 'energy', 'protein']);
});

/* Aiming at the chapter being drawn on is not an amendment at all: the ops are
   simply drawn, and they log and replay as the drawing they are. */
await test('aiming at the live chapter just draws', async () => {
  const b = drawn(taught);
  applyOps(b, [{ op: 'amend', chapter: 2, ops: { op: 'node', id: 'bile', label: 'Bile' } }]);
  assert.deepEqual(b.nodes.map(x => x.id), ['fat', 'lipase', 'bile']);
  assert.equal(b.log[b.log.length - 1].op, 'node', 'logged as the draw it is');
});

/* ---------- over HTTP ---------- */

await test('a chapter op lands over POST /op and the state carries every chapter', async () => {
  const app = createServer({ name: 'ch', persist: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const U = `http://127.0.0.1:${app.server.address().port}/b/ch`;
  try {
    const post = ops => fetch(U + '/op', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }),
    }).then(r => r.json());
    const r = await post(taught);
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.nodes, 2, 'the counts are the live chapter\'s, which is the one being drawn');
    const state = await (await fetch(U + '/state')).json();
    assert.deepEqual(state.chapters.map(c => c.title), ['Nutrients']);
    assert.equal(state.chapter, 'Enzymes');

    /* An amendment was aimed at a chapter, so the reply is about that chapter.
       Counting the one being drawn on would answer a question nobody asked in
       the same breath as the answer to the one they did. */
    const back = await post([{ op: 'amend', chapter: 1, ops: { op: 'node', id: 'protein' } }]);
    assert.deepEqual(back.amended, { chapter: 1, title: 'Nutrients', nodes: 3, edges: 1, steps: 1 });
    assert.equal(back.nodes, 2, 'the live counts are still there for anything that wants them');

    const plain = await post([{ op: 'node', id: 'bile' }]);
    assert.equal(plain.amended, undefined, 'and an ordinary draw says nothing about chapters');
  } finally {
    await new Promise(r => { app.server.close(r); app.server.closeAllConnections?.(); });
  }
});

console.log(`  ${n} chapter checks passed`);
fs.rmSync(HOME, { recursive: true, force: true });
