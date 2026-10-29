/* ============================================================
   Following the step.

   Walking the flow lights a few boxes and dims the rest. That is enough when
   the whole board is on screen, and useless when it is not: the step you
   asked for can be lit two screens to the right, and the only signal you get
   is that everything you can see went dim.

   So the camera brings the lit boxes into view — but it is deliberately a
   reluctant camera, because an eager one is worse than none:

   - If the whole board is already in view, it does not move. Nothing is
     hidden, so there is nothing to bring into view, and a cut would only cost
     you the overview you chose.
   - If the lit boxes are already in view with room to spare, it does not move
     either. Consecutive steps usually share a neighbourhood, and a camera
     that re-centres on every step turns a walk into a slideshow.
   - It never zooms in. The zoom is the reader's; it pulls back only as far as
     it must to get the subject on screen, and no further.

   Everything here is arithmetic on rectangles, so it is testable without a
   browser — which is the point of it living outside the page.
   ============================================================ */

const PAD = 30;          // breathing room around the subject, in screen pixels

/* The bounding box of some boxes, in canvas coordinates. */
export function unionBox(boxes, keys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of keys) {
    const b = boxes[k];
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* What a step lights: the nodes it names, plus both ends of its edge. The
   same rule render.js uses to decide what is lit, so the camera frames
   exactly what the eye is being pointed at. */
export function litKeys(step) {
  if (!step) return [];
  const keys = new Set(step.lights || []);
  if (step.edge) {
    const [a, b] = String(step.edge).split('>');
    if (a) keys.add(a);
    if (b) keys.add(b);
  }
  return [...keys];
}

const inside = (r, v, pad = 0) =>
  r.x0 >= v.x0 - pad && r.y0 >= v.y0 - pad && r.x1 <= v.x1 + pad && r.y1 <= v.y1 + pad;

/* Where the camera should go, or null for "stay where you are".

   `subject` and `offset` are canvas coordinates; `canvas` is the full canvas
   size; `visible` is the part of the stage a reader can actually see, in
   screen pixels — the steps bar sits over the bottom of it. */
export function frame({ subject, canvas, view, visible, offset = { x: 0, y: 0 }, pad = PAD }) {
  if (!subject) return null;
  const { w: W, h: H } = canvas;
  const availW = visible.x1 - visible.x0, availH = visible.y1 - visible.y0;
  if (availW < 60 || availH < 60) return null;

  const screen = (b, k) => ({
    x0: (b.x + offset.x) * k + view.x, y0: (b.y + offset.y) * k + view.y,
    x1: (b.x + b.w + offset.x) * k + view.x, y1: (b.y + b.h + offset.y) * k + view.y,
  });

  // the whole plan is on screen: hold it
  const whole = { x0: view.x, y0: view.y, x1: view.x + W * view.k, y1: view.y + H * view.k };
  if (inside(whole, visible, 2)) return null;

  // the subject is on screen with room around it: hold that too
  if (inside(screen(subject, view.k), visible, -pad)) return null;

  // pull back only if it will not fit at the zoom the reader chose
  const k = Math.max(0.05, Math.min(view.k,
    (availW - pad * 2) / Math.max(1, subject.w),
    (availH - pad * 2) / Math.max(1, subject.h)));

  /* Centre the subject, but never past the canvas edge: a subject framed
     against empty paper reads as the edge of the world. When an axis fits
     entirely, centre the canvas on it instead. */
  const place = (total, a0, a1, centre) => {
    const avail = a1 - a0;
    if (total * k <= avail) return a0 + (avail - total * k) / 2;
    return Math.min(a0, Math.max(a1 - total * k, a0 + avail / 2 - centre));
  };

  return {
    k,
    x: place(W, visible.x0, visible.x1, (subject.x + subject.w / 2 + offset.x) * k),
    y: place(H, visible.y0, visible.y1, (subject.y + subject.h / 2 + offset.y) * k),
  };
}
