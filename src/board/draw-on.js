/* ============================================================
   spiega draw-on — making a box look drawn rather than revealed.
   ============================================================ */

/* A hand does not draw at a constant speed. It accelerates out of a corner,
   runs fast down a long straight, slows as it comes back round, and pauses a
   beat before starting the next stroke. A dashoffset transition on one easing
   curve gives none of that — it reads as a machine tracing a path, which is
   exactly what it is. These three functions put the hand back in.

   Everything stays additive: `fill: backwards` holds the start state during the
   delay, and every animation ends on the element's natural value, so if
   animations never run (a background tab, reduced motion, a headless capture)
   the board is simply already drawn. */

const prefersStill = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* A small seeded generator, so a given stroke always draws the same way. */
function rnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Keyframes whose progress runs ahead of and behind the clock: the pen covers
   more ground in some stretches than others. Per-keyframe easing smooths each
   change of pace so it reads as a wrist, not as stuttering. */
function penFrames(L, r) {
  const steps = 5;
  const frames = [{ strokeDashoffset: L, offset: 0, easing: 'ease-in-out' }];
  let p = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    p = Math.min(0.95, Math.max(p + 0.05, t + (r() - 0.5) * 0.3));
    frames.push({ strokeDashoffset: L * (1 - p), offset: t, easing: 'ease-in-out' });
  }
  frames.push({ strokeDashoffset: 0, offset: 1 });
  return frames;
}

/* Returns how long the whole group takes, so the caller can start the next one
   when this one is actually finished rather than on a fixed grid. */
export function animateIn(group, delay = 0, seed = 1) {
  const strokes = [...group.querySelectorAll('path.s')];
  const fills = [...group.querySelectorAll('path.f')];
  const texts = [...group.querySelectorAll('text')];
  const was = el => el.getAttribute('opacity') || 1;
  if (prefersStill) return 0;

  const r = rnd(seed);
  const appear = (el, to, opts) =>
    el.animate([{ opacity: 0 }, { opacity: to }], { fill: 'backwards', easing: 'ease-out', ...opts });

  // A running clock rather than a fixed stagger: each stroke starts when the
  // one before it is nearly done, plus a short, uneven pause while the hand
  // moves to where the next one begins.
  let t = delay;
  for (const p of strokes) {
    if (p.getAttribute('stroke-dasharray')) {
      // a dashed line cannot be drawn on without losing its dashes, so it fades
      appear(p, was(p), { duration: 240, delay: t });
      t += 150 + r() * 70;
      continue;
    }
    let L = 0;
    try { L = p.getTotalLength(); } catch { L = 0; }
    if (!L) continue;
    const dur = Math.min(1000, Math.max(220, L * (0.75 + r() * 0.4)));
    p.style.strokeDasharray = L;             // with offset 0 this draws the whole line
    p.animate(penFrames(L, r), { duration: dur, delay: t, fill: 'backwards' })
      .finished.then(() => { p.style.strokeDasharray = ''; }, () => {});
    // Start the next stroke before this one has quite finished, and cap the
    // wait: a glyph with eight strokes should not take eight strokes' time.
    t += Math.min(dur * (0.62 + r() * 0.2), 240) + 30 + r() * 60;
  }

  // Colour goes on after the outline is closed, the way you fill a shape in
  // once you have drawn it — not underneath while it is still being drawn.
  const inked = Math.max(delay, t - 120);
  fills.forEach(p => appear(p, was(p), { duration: 260, delay: inked }));
  texts.forEach(el => appear(el, was(el), { duration: 220, delay: inked + 130 + r() * 90 }));
  return (inked + 350) - delay;
}


/* A stable seed for a board key, so a box always draws itself the same way. */
export function seedOf(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
