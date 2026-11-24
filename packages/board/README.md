# @spiega/board

The page. A model, a message union and a pure `update` (#152), a React view
over them (#153–#156), narration (#155), and the single-file offline export
(#157). Vite is the build tool here, and it arrives with the app rather than
ahead of it.

`src/app` is the app without a framework: `Model`, `Msg`, `Cmd`, `update`, and
a store shaped for `useSyncExternalStore`. `src/view` is React over exactly
that — no state of its own, every gesture a `Msg` — which is what makes the
later swap to Foldkit a rewrite of one directory.

The page the view draws is served at **`/next`**, beside `src/board/board.html`
rather than instead of it. It draws a fixture board baked in at build time, not
a board this server holds: #156 is the cutover, and until it lands the old page
is the one a live board opens. `pnpm run build` assembles both — see
`tools/next.js` — and `test/react-board.mjs` renders this view under
`react-dom/server` to check the stage mounts the same SVG string the old page
mounts, byte for byte.

React, React DOM and Vite are devDependencies and stay that way: the view is
bundled into an asset that ships inside `dist/`, so the published package still
declares the two runtime dependencies it has always declared.
