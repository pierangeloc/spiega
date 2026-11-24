# @spiega/board

The page. A model, a message union and a pure `update` (#152), a React view
over them (#153–#156), narration (#155), and the single-file offline export
(#157). Vite is the build tool here, and it arrives with the app rather than
ahead of it.

`src/app` is the app without a framework: `Model`, `Msg`, `Cmd`, `update`, and
a store shaped for `useSyncExternalStore`. `src/view` is React over exactly
that — no state of its own, every gesture a `Msg` — which is what makes the
later swap to Foldkit a rewrite of one directory.

This is the board page: every board at `/b/<name>/` is served this app, built
into one self-contained file (stylesheet and bundle inline, nothing fetched) by
`tools/board.js` during `pnpm run build`. `src/view/browser.ts` connects it to
the board's event stream; an export is the same file with the board's state in
front of the bundle (`src/board/export.ts`). `test/react-board.mjs` renders the
view under `react-dom/server` against a fixture board to check, among other
things, that the stage mounts the renderer's SVG string byte for byte.

React, React DOM and Vite are devDependencies and stay that way: the view is
bundled into an asset that ships inside `dist/`, so the published package still
declares the two runtime dependencies it has always declared.
