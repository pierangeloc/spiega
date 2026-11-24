/* The narrator's tape and its transport (#121, #122).

   Run with `node test/tape.mjs`.

   What is being protected, in the order it went wrong:

   Narrating from the map read the chapter hidden behind it, because the tape
   was always one chapter's and the map is an overlay rather than a view. So
   there is now a tape that is the whole board's, and the first thing worth
   pinning is that the outline at the head of it comes from the map's cards and
   never from — or into — the transcript, which is a record of what the agent
   said.

   The second is the narrator itself, driven against a stand-in voice: a chapter
   change gets a longer silence than a step change, a section that moves the
   board is waited for before its words, a finished tape starts again from the
   top and a paused one does not. None of that needs a browser, and all of it is
   invisible when it is wrong — the board just narrates the wrong thing, or
   talks over a picture that has not arrived. */
import assert from 'node:assert/strict';

const { emptyBoard, applyOps } = await import('../src/board/state.js');
const { boardMap } = await import('../src/board/map.js');
const { tapeOf, wholeTape, worthAnOutline, locate, railMarks, plain, ledeText, nextRate, rateLabel, RATES } =
  await import('../src/board/tape.js');
const { gapBefore, createNarrator } = await import('../src/board/narrate.js');

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

/* Three chapters, the last of them live. The first has two steps and says
   things about them; the second says nothing at all; the third has one line. */
const explained = () => {
  const b = emptyBoard();
  const r = applyOps(b, [
    { op: 'title', text: 'Checkout' },
    { op: 'chapter', title: 'the happy path' },
    { op: 'node', id: 'a', label: 'API' }, { op: 'node', id: 'b', label: 'DB' },
    { op: 'edge', from: 'a', to: 'b' },
    { op: 'step', edge: 'a>b', step: 'API writes the order' },
    { op: 'say', text: 'A request arrives and **the API** writes it.', step: 0 },
    { op: 'say', text: 'Then we `commit`.' },
    { op: 'chapter', title: 'the silent one' },
    { op: 'node', id: 'c', label: 'cache' },
    { op: 'chapter', title: 'when it fails' },
    { op: 'node', id: 'd', label: 'DLQ' },
    { op: 'say', text: 'Three tries, then it is parked.' },
  ]);
  assert.deepEqual(r.errors, []);
  return b;
};

await test('from the map the tape is the whole board, not the chapter behind it (#122)', () => {
  const b = explained();
  const chapter = tapeOf(b, { whole: false, surface: b.chapters[0], viewing: 0 });
  const whole = tapeOf(b, { whole: true, surface: b.chapters[0], viewing: 0 });
  assert.deepEqual(chapter.map(s => s.kind), ['line', 'line'], 'inside a chapter it is that chapter and nothing else');
  assert.ok(chapter.every(s => s.chapter === 0));
  assert.equal(whole[0].kind, 'outline', 'from the map it starts with the overview');
  assert.notDeepEqual(whole.slice(0, chapter.length), chapter,
    'the chapter that happens to be open behind the map is not what gets read');
  assert.deepEqual(whole.filter(s => s.kind === 'line').map(s => s.chapter), [0, 0, null],
    'the dive visits each chapter that has something said in it, in order; the live one is null');
});

await test('the outline is the map cards read aloud, in order', () => {
  const b = explained();
  const { cards } = boardMap(b);
  const out = wholeTape(b).filter(s => s.kind === 'outline');
  assert.equal(out[0].part, 'lede');
  assert.equal(out[0].text, ledeText('Checkout', 3));
  assert.equal(out[0].text, 'Checkout — 3 chapters');
  assert.deepEqual(out.slice(1).map(s => [s.card, s.part, s.text]), [
    [1, 'title', 'the happy path'],
    [1, 'line', 'A request arrives and the API writes it.'],
    [2, 'title', 'the silent one'],          // nothing said in it: a name and no line
    [3, 'title', 'when it fails'],
    [3, 'line', 'Three tries, then it is parked.'],
  ], 'a chapter\u2019s title, then the line the card shows under it');
  assert.deepEqual(out.filter(s => s.part === 'line').map(s => s.text),
    cards.filter(c => c.line).map(c => plain(c.line)), 'and it is what the cards hold, not a second opinion');
});

/* The rail is what was said. The outline is the board talking. If the two ever
   share a list, a transcript shows a sentence nobody said. */
await test('building the tape never writes the outline into the transcript', () => {
  const b = explained();
  const before = structuredClone({ t: b.transcript, c: b.chapters.map(c => c.transcript), log: b.log });
  wholeTape(b);
  tapeOf(b, { whole: true, surface: b, viewing: null });
  assert.deepEqual({ t: b.transcript, c: b.chapters.map(c => c.transcript), log: b.log }, before);
  assert.ok(![...b.transcript, ...b.chapters.flatMap(c => c.transcript)]
    .some(l => /chapters$|the happy path$/.test(l.text)), 'no synthesised line is among the transcripts');
});

await test('a board with one chapter has no outline worth reading, and narrates the chapter', () => {
  const b = emptyBoard();
  applyOps(b, [{ op: 'title', text: 'Solo' }, { op: 'node', id: 'a' }, { op: 'say', text: 'Only this.' }]);
  assert.equal(worthAnOutline(b), false);
  const t = tapeOf(b, { whole: true, surface: b, viewing: null });
  assert.deepEqual(t.map(s => [s.kind, s.text]), [['line', 'Only this.']]);
  assert.equal(worthAnOutline(explained()), true);
});

await test('lines carry their step, and which chapter they belong to', () => {
  const b = explained();
  const t = wholeTape(b).filter(s => s.kind === 'line');
  assert.deepEqual(t.map(s => [s.chapter, s.card, s.line, s.step]),
    [[0, 1, 0, 0], [0, 1, 1, null], [null, 3, 0, null]]);
  assert.equal(t[0].text, 'A request arrives and the API writes it.', 'spoken as printed, without the markdown');
  assert.equal(plain('a `b` **c**'), 'a b c');
});

await test('a rail row is found on the whole tape by chapter and line, and marked against the playhead', () => {
  const t = wholeTape(explained());
  const first = t.findIndex(s => s.kind === 'line');
  assert.equal(locate(t, 0, 1), first + 1);
  assert.equal(locate(t, null, 0), first + 2);
  assert.equal(locate(t, 1, 0), -1, 'the silent chapter has no rows on the tape');
  assert.equal(locate(t, 0, 7), -1);

  assert.deepEqual(railMarks(t, -1, 0, 2), [null, null], 'a tape nobody has started marks nothing');
  assert.deepEqual(railMarks(t, first + 1, 0, 2), ['heard', 'now']);
  assert.deepEqual(railMarks(t, 2, 0, 2), ['ahead', 'ahead'], 'still in the outline: every line is yet to come');
  assert.deepEqual(railMarks(t, first + 2, 0, 2), ['heard', 'heard'],
    'once the dive has moved on, an earlier chapter is all heard');
  assert.deepEqual(railMarks(t, first, null, 1), ['ahead'], 'and a later one is not');
});

await test('the speed dial steps through the ones worth stopping on, and wraps', () => {
  let r = 1; const seen = [];
  for (let i = 0; i < RATES.length; i++) { r = nextRate(r); seen.push(r); }
  assert.deepEqual(seen, [1.25, 1.5, 2, 0.75, 1]);
  assert.equal(nextRate(1.1), 1.25, 'a rate set from the keyboard moves up to the next stop');
  assert.equal(nextRate(2.5), 0.75);
  assert.equal(rateLabel(1), '1×');
  assert.equal(rateLabel(1.25), '1.25×');
  assert.equal(rateLabel(0.1 + 0.2 + 0.7), '1×', 'a rate nudged by tenths does not print its float error');
});

await test('a chapter change is a longer silence than a step change, which is longer than a breath', () => {
  const line = (chapter, step, card) => ({ kind: 'line', chapter, step, card });
  const breath = gapBefore(line(0, 1), line(0, 1));
  const turn = gapBefore(line(0, 1), line(0, 2));
  const chapter = gapBefore(line(0, 2), line(1, 2));
  assert.ok(breath < turn && turn < chapter, `${breath} < ${turn} < ${chapter}`);
  assert.equal(gapBefore(line(0, null), line(0, null)), breath, 'untagged lines are one thought');
  assert.equal(gapBefore(line(0, null), line(0, 3)), turn);
  const out = (card, part) => ({ kind: 'outline', card, part });
  assert.equal(gapBefore(out(undefined, 'lede'), out(1, 'title')), turn, 'the next chapter being described');
  assert.equal(gapBefore(out(1, 'title'), out(1, 'line')), breath, 'its name and its line are one description');
  assert.equal(gapBefore(out(3, 'line'), line(0, 0, 1)), chapter, 'from the overview into the first chapter');
  assert.equal(gapBefore(line(0, 0, 1), line(null, 0, 3)), chapter, 'to the live chapter, whose index is null');
});

/* ---- the narrator, against a voice that speaks instantly ---- */

/* `speechSynthesis` is a browser global, so a stand-in is installed for the
   narrator to find. It ends every utterance a moment after it starts, which is
   all the narrator needs from it to run a tape. */
function fakeVoice() {
  const spoken = [];
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = {
    getVoices: () => [],
    cancel() {},
    speak(u) { spoken.push(u.text); setTimeout(() => u.onend?.(), 5); },
  };
  return spoken;
}
const section = (log, name, extra = {}) => ({
  text: name, onStart: () => { log.push(`start ${name}`); }, onDone: () => { log.push(`done ${name}`); }, ...extra,
});
const settled = ms => new Promise(r => setTimeout(r, ms));
const until = async cond => { for (let i = 0; i < 400 && !cond(); i++) await settled(10); assert.ok(cond(), 'timed out'); };

await test('the board moves, and is waited for, before its words are spoken', async () => {
  const spoken = fakeVoice();
  const log = [];
  const nar = createNarrator();
  nar.setRate(2.5);
  nar.load([
    section(log, 'one', { chapter: 0 }),
    section(log, 'two', { chapter: 1, async onStart() {
      log.push('start two');
      await settled(60);                     // a chapter opening from the map
      log.push('two is open');
    } }),
  ]);
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['one', 'two']);
  assert.deepEqual(log, ['start one', 'done one', 'start two', 'two is open', 'done two']);
});

await test('a section can see whether it is still wanted once it has been read', async () => {
  fakeVoice();
  let wanted = null, reading = false;
  const nar = createNarrator();
  nar.setRate(2.5);
  nar.load([{ text: 'last', onDone: async alive => { reading = true; await settled(80); wanted = alive(); } }]);
  nar.play();
  await until(() => reading);
  nar.pause();                                // paused during the beat after the last line
  await settled(120);
  assert.equal(wanted, false, 'so a tour that was paused does not take you back to the map');

  nar.load([{ text: 'last', onDone: async alive => { await settled(20); wanted = alive(); } }]);
  nar.play();
  await until(() => !nar.playing);
  assert.equal(wanted, true);
});

await test('a finished tape plays from the top; a paused one carries on', async () => {
  const spoken = fakeVoice();
  const nar = createNarrator();
  nar.setRate(2.5);
  nar.load(['a', 'b', 'c'].map(text => ({ text })));
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['a', 'b', 'c']);
  spoken.length = 0;
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['a', 'b', 'c'], 'it ran off the end, so this is a new listen');

  spoken.length = 0;
  nar.go(1);                                   // paused, placed on the second
  assert.equal(nar.index, 1);
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['b', 'c'], 'but a tape that was only placed resumes from the place');
});

await test('the playhead can be parked, and rewound when the tape is about something else', async () => {
  const spoken = fakeVoice();
  const log = [];
  const seen = [];
  const nar = createNarrator({ onState: s => seen.push(s.index) });
  nar.setRate(2.5);
  nar.load(['a', 'b', 'c'].map(name => section(log, name)));
  nar.park(2);
  assert.equal(nar.index, 2);
  assert.deepEqual(log, [], 'parking moves the playhead and nothing else');
  assert.deepEqual(spoken, []);
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['c']);

  nar.rewind();
  assert.equal(nar.index, -1);
  nar.load([{ text: 'x' }]);
  nar.play();
  await until(() => !nar.playing);
  assert.equal(spoken.at(-1), 'x', 'a replaced tape starts at its own beginning');
});

await test('a cancelled voice sample cannot start after the tape has restarted', async () => {
  const spoken = fakeVoice();
  const nar = createNarrator();
  nar.load([{ text: 'the script' }]);
  nar.sample('sample');
  nar.play();
  await until(() => !nar.playing);
  assert.deepEqual(spoken, ['the script']);
});

await test('changing speed restarts the sentence at the new speed, and is clamped', async () => {
  fakeVoice();
  const nar = createNarrator();
  nar.setRate(9);
  assert.equal(nar.rate, 2.5);
  nar.setRate(0);
  assert.equal(nar.rate, 1, 'nonsense falls back to normal speed rather than to zero');
  nar.setRate(0.1);
  assert.equal(nar.rate, 0.5);
});

console.log(`\n  ${n} checks on the tape and its transport`);
