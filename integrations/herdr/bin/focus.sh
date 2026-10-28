#!/bin/sh
# Bring this task's board to the front.
#
# `handwave focus` covers all three shapes of "I have lost my board": buried
# window, closed window, no board yet. So this only has to put us in the right
# directory first — that is what names the board.
set -e
. "$(dirname "$0")/_pane-cwd.sh"
cwd="$(pane_cwd)"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"
exec handwave focus
