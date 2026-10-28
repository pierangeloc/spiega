#!/bin/sh
# The popup body: every board, and which task it belongs to.
. "$(dirname "$0")/_pane-cwd.sh"
cwd="$(pane_cwd)"
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"
handwave boards || echo "no boards running"
printf '\n[any key to close]'
# shellcheck disable=SC2034
read -r _dummy
