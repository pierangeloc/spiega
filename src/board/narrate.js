/* ============================================================
   The transcript as a tape.

   Modelled on effect.institute, which gets the feel right: the words are read
   aloud, the word being spoken is lit as it is said, space plays and pauses,
   and you move between sections rather than clicking through a stepper. It
   plays like a film rather than like a slide deck, and the difference is
   almost entirely about who is in charge of time — the tape, not the reader.

   A section here is one line of the script. When that line is tagged with a
   step, the board walks to that step as the line begins, so the picture and
   the words move together without either leading the other.

   It is synthesised, not recorded. The reference does the same — no audio
   files, just per-word spans and the browser's own voice — which is what
   makes this possible with no key, no network and no dependency.

   The machinery that makes the highlight work is `onboundary`: as the
   synthesiser speaks it reports the character offset it has reached, and
   since the spans were built from the very string handed to it, an offset
   maps straight to a word.

   Three traps in the Web Speech API, each worth an afternoon:

   1. `getVoices()` is empty on the first call in Chrome; the list arrives
      later on `voiceschanged`.
   2. Chrome stops after roughly fifteen seconds of one utterance. Splitting
      into sentences avoids it, and reads better anyway — but the offsets then
      need rebasing onto the whole line.
   3. `cancel()` and an immediate `speak()` race in Chrome and the new
      utterance is dropped. A tick between them is the usual remedy.
   ============================================================ */

/* Wrap every word of an element in its own span, numbered by the character
   offset it starts at. The offsets index into `el.textContent`, which is also
   exactly the string given to the synthesiser, so the two cannot drift. */
export function wrapWords(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);

  let at = 0;
  for (const node of texts) {
    const frag = document.createDocumentFragment();
    // keep the whitespace: it carries the offsets, and the layout
    for (const part of node.nodeValue.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        frag.appendChild(document.createTextNode(part));
      } else {
        const s = document.createElement('span');
        s.className = 'w';
        s.dataset.at = String(at);
        s.textContent = part;
        frag.appendChild(s);
      }
      at += part.length;
    }
    node.parentNode.replaceChild(frag, node);
  }
  return at;
}

/* Which word is being spoken, given the offset the synthesiser reports.

   It says how far it has got, not which word it chose, so the answer is the
   last word that starts at or before that offset. Words are in order, so this
   is a scan rather than a search, and an offset before the first word — which
   happens when a sentence starts with punctuation — means no word yet rather
   than the first one. */
export function wordAt(starts, offset) {
  let found = -1;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) found = i; else break;
  }
  return found;
}

const GOOD = /siri|samantha|alex|daniel|serena|karen|moira|google (uk|us)/i;

export function createNarrator({ onState = () => {} } = {}) {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

  let voice = null;
  let rate = 1;
  let playing = false;          // the tape is running
  let index = -1;               // which section
  let sections = [];            // [{ text, el, step }]
  let token = 0;                // invalidates callbacks from an abandoned run

  /* Every English voice the browser offers, likely-good ones first.

     A Mac has around 180 installed and most are novelties — Boing, Bells,
     Jester, Organ — so an alphabetical list buries the handful anyone would
     narrate with. Ordering is a courtesy, not a filter: everything is still
     in the list, because which voice sounds right is not mine to decide. */
  function listVoices() {
    if (!synth) return [];
    return synth.getVoices()
      .filter(v => /^en(-|$)/i.test(v.lang))
      .map(v => ({ name: v.name, lang: v.lang, local: v.localService }))
      .sort((a, b) => (GOOD.test(b.name) - GOOD.test(a.name))
        || (b.local - a.local)
        || a.name.localeCompare(b.name));
  }

  function chooseVoice() {
    if (!synth) return;
    const all = synth.getVoices().filter(v => /^en(-|$)/i.test(v.lang));
    if (!all.length) return;
    // a chosen voice outranks the guess, and survives a reload
    let want = null;
    try { want = localStorage.getItem('spiega.voiceName'); } catch { /* private window */ }
    voice = (want && all.find(v => v.name === want))
      || all.find(v => v.localService && GOOD.test(v.name))
      || all.find(v => GOOD.test(v.name))
      || all.find(v => v.localService) || all[0];
  }
  if (synth) {
    chooseVoice();
    synth.addEventListener?.('voiceschanged', chooseVoice);
  }

  const announce = () => onState({ playing, index, total: sections.length, rate });

  function stop() {
    token++;
    playing = false;
    try { synth?.cancel(); } catch { /* nothing to stop */ }
    announce();
  }

  /* Speak one section, lighting each word as it is said, and resolve when it
     is finished rather than when it was started. */
  function speak(section, mine) {
    return new Promise(resolve => {
      if (!synth) return resolve(false);
      const text = section.text;
      /* Sentences, for Chrome's fifteen-second limit. Each piece reports
         offsets from its own start, so it carries the offset of its start
         within the line to put them back on the same scale. */
      const parts = [];
      let cursor = 0;
      for (const piece of text.split(/(?<=[.!?:;])\s+/)) {
        if (!piece) continue;
        const start = text.indexOf(piece, cursor);
        parts.push({ piece, start });
        cursor = start + piece.length;
      }

      let i = 0;
      const next = () => {
        if (mine !== token) return resolve(false);
        if (i >= parts.length) return resolve(true);
        const { piece, start } = parts[i++];
        const u = new SpeechSynthesisUtterance(piece);
        if (voice) u.voice = voice;
        u.rate = rate;
        u.onboundary = ev => {
          if (mine !== token || ev.name === 'sentence') return;
          section.onWord?.(start + (ev.charIndex || 0));
        };
        u.onend = next;
        u.onerror = () => resolve(false);
        synth.speak(u);
      };
      setTimeout(next, 30);     // Chrome races cancel() with speak()
    });
  }

  async function run(from) {
    const mine = ++token;
    playing = true;
    for (let k = from; k < sections.length; k++) {
      if (mine !== token) return;
      index = k;
      announce();
      sections[k].onStart?.();
      const finished = await speak(sections[k], mine);
      if (mine !== token) return;
      if (!finished) break;
      sections[k].onDone?.();
    }
    if (mine === token) { playing = false; announce(); }
  }

  return {
    get available() { return Boolean(synth); },
    get playing() { return playing; },
    get index() { return index; },
    get voiceName() { return voice?.name || null; },
    get rate() { return rate; },
    voices: listVoices,

    /* Pick one. Remembered, and applied to whatever is said next — changing
       voice mid-sentence would mean cutting the sentence off. */
    setVoice(name) {
      if (!synth) return null;
      const found = synth.getVoices().find(v => v.name === name);
      if (!found) return voice?.name || null;
      voice = found;
      try { localStorage.setItem('spiega.voiceName', name); } catch { /* private window */ }
      announce();
      return name;
    },

    /* A sentence in the chosen voice, so you can hear it before committing.
       Stops the tape: two voices at once is nobody's idea of a preview. */
    sample(text = 'This is how the board will read your explanation.') {
      if (!synth) return;
      stop();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.rate = rate;
      setTimeout(() => synth.speak(u), 30);
    },

    /* The tape's contents. Replacing it keeps the position if it still
       exists, so a line arriving mid-session does not rewind anything. */
    load(next) {
      sections = next;
      if (index >= sections.length) index = sections.length - 1;
      announce();
    },

    setRate(v) {
      rate = Math.max(0.5, Math.min(2.5, Number(v) || 1));
      if (playing) { const at = index; stop(); run(at); } else announce();
    },

    play(from = index < 0 ? 0 : index) {
      if (!synth || !sections.length) return;
      stop();
      run(Math.max(0, Math.min(from, sections.length - 1)));
    },

    pause() { if (playing) stop(); },

    toggle(from) {
      if (playing) this.pause();
      else this.play(from);
    },

    /* Move the tape. Playing follows you; paused, it just marks the place. */
    go(to) {
      const k = Math.max(0, Math.min(to, sections.length - 1));
      if (playing) this.play(k);
      else { index = k; announce(); sections[k]?.onStart?.(); }
    },

    next() { this.go(index + 1); },
    prev() { this.go(index - 1); },
    restart() { this.go(index < 0 ? 0 : index); },
    stop,
  };
}
