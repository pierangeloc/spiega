#!/bin/sh
# Bring this task's board to the front, starting one if there is none: pressing
# a key and being told "no board" is a worse answer than simply getting one.
set -e
. "$(dirname "$0")/_pane-cwd.sh"
cwd="$(pane_cwd)"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

if handwave focus 2>/dev/null; then exit 0; fi
handwave open >/dev/null 2>&1 || true
sleep 1
handwave focus >/dev/null 2>&1 || true
