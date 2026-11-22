# @spiega/board

The page. A model, a message union and a pure `update` (#152), a React view
over them (#153–#156), narration (#155), and the single-file offline export
(#157). Vite is the build tool here, and it arrives with the app rather than
ahead of it.

Empty today. The page it will replace is `src/board/board.html`, which the
server still serves and which still imports the renderer off disk, unbundled.
