# Logo and icon

The **logo** was generated with an image model and lives outside this folder
for now — it is a board with four boxes, three arrows, one of them orange, and
a marker drawing it. Nine shapes: excellent at 160px and a smudge at 16.

The **icon** here is its reduction, for the places a logo has to be small: a
browser tab, an app icon, a GitHub avatar. Most projects need both, and this is
the normal division of labour rather than a compromise.

```bash
node tools/logo.js     # regenerate the SVGs, then open index.html
```

## The reduction

Shrinking the logo showed which two things survive: the **board's outline** and
the **orange box**. Everything else — the other three boxes, the arrows, the
marker — is gone. What is left reads as a board with one thing lit on it, which
is what spiega does.

| candidate | reads as | at 16px |
|---|---|---|
| `icon-frame-box` | a board with one lit box | **clean** — the pick |
| `icon-frame-flow` | a board with a lit box above a plain one | busy, fine from 24px |
| `icon-two-boxes` | two boxes, no board | a vertical smear |

Each exists on paper and on ink (`-dark`), because a mark that works on only
one ground is half a mark.

## PNGs

`png/` holds `icon-frame-box` and `icon-frame-box-dark` at 16, 32, 48, 64, 128,
256 and 512, with transparent backgrounds. To regenerate after changing the
geometry:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for name in icon-frame-box icon-frame-box-dark; do
  for s in 16 32 48 64 128 256 512; do
    printf '<!doctype html><style>html,body{margin:0;width:%spx;height:%spx}img{display:block;width:%spx;height:%spx}</style><img src="file://%s/docs/logo/%s.svg">' \
      "$s" "$s" "$s" "$s" "$PWD" "$name" > /tmp/one.html
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --default-background-color=00000000 --window-size=$s,$s \
      --screenshot="docs/logo/png/$name-$s.png" file:///tmp/one.html
  done
done
```

## What was tried and dropped

Before the image model, four marks were drawn here directly. Three were
dropped: two boxes and a line read as "oo" at 16px; a half-drawn box was an
ambiguous hook; and **a pen, drawn twice — once small, once deliberately large
— never read as a pen** at any size that mattered. That is the same failure as
the hand in issue #2, and the same conclusion: a 16px mark cannot carry a
recognisable object. An image model solved it by making the marker large and
the whole thing detailed, which is exactly why the result needs a reduction.

Two mistakes worth not repeating:

- `stroke()` already emits `stroke-linecap`. Passing it again through `extra`
  produces a duplicate attribute, which makes the SVG invalid XML and renders
  nothing at all. Every file is XML-parsed after generation now.
- Cutting a `roundedPts` path short to leave the frame open puts the gap
  wherever that path happens to start — at the top, where an open rounded
  square stops being a board and becomes a cup. The frame is closed; the wobble
  carries the hand-drawn character on its own.

The 16px column of `index.html` is the test. A mark that needs 48px is an
illustration.
