#!/bin/sh
# A window for this task's board, whether or not one is already running.
set -e
. "$(dirname "$0")/_pane-cwd.sh"
cwd="$(pane_cwd)"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"
spiega open
