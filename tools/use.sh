#!/usr/bin/env bash
#
# Switch the `spiega` on your PATH between this checkout and the published
# package, and leave every copy that records a path pointing at the new one.
#
#   tools/use.sh status      what is active now
#   tools/use.sh local       this checkout  (npm link)
#   tools/use.sh release     the latest npm release
#   tools/use.sh release 0.3.0
#
# Why this is a script and not two npm commands.
#
# `npm link` swaps the CLI, and that is the part people remember. It is not the
# part that bites. The skills and the six MCP configs record an absolute path
# to the copy that wrote them — `src/install.js` builds MCP_ENTRY from the root
# of whichever package is running — so after a swap they all still point at the
# copy you just left. The CLI is new, every agent is still on the old one, and
# nothing says so until `spiega doctor` is run on purpose.
#
# That is the trap this repo already knows about: a machine can sit two
# releases behind while everything looks installed and fine. So a switch here
# is three things, always in this order — stop the old server, swap the
# package, re-run `spiega install` from the new one — and then doctor, printed
# whether or not you asked.

set -euo pipefail

CLONE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-status}"
WANT="${2:-latest}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

# Where the global package actually lives, following the bin symlink. Printed
# rather than inferred: the whole point is to stop guessing which copy answers.
#
# node does the resolving rather than readlink, for two reasons: the link npm
# writes is relative, so resolving it against the working directory lands
# nowhere, and there is usually more than one hop — ~/.local/bin/spiega to the
# nvm bin to the package. realpathSync follows the whole chain, and node is by
# definition present.
resolve() {
  local bin pkg
  bin="$(command -v spiega || true)"
  [ -z "$bin" ] && { echo "none"; return; }
  pkg="$(node -e 'const p=require("path"),f=require("fs");
    try { console.log(p.dirname(p.dirname(f.realpathSync(process.argv[1])))); } catch {}' "$bin" 2>/dev/null || true)"
  echo "${pkg:-unknown}"
}

status() {
  local pkg ver
  pkg="$(resolve)"
  if [ "$pkg" = "none" ]; then
    bold "spiega is not on your PATH."
    return
  fi
  ver="$(node -p "require('$pkg/package.json').version" 2>/dev/null || echo '?')"
  if [ -d "$pkg/.git" ]; then
    bold "active: LOCAL — $pkg"
    dim   "        $ver, at $(git -C "$pkg" rev-parse --short HEAD) on $(git -C "$pkg" rev-parse --abbrev-ref HEAD)"
    [ -n "$(git -C "$pkg" status --porcelain)" ] && dim "        with uncommitted changes"
  else
    bold "active: RELEASE — $ver"
    dim   "        $pkg"
    dim   "        latest on npm is $(npm view spiega version 2>/dev/null || echo '?')"
  fi
  dim "        this checkout is $CLONE"
}

# The old copy owns the running board server and it is the one that can still
# find it. Stopping before the swap is not tidiness: a server left running
# keeps serving the code it started with, on the port the new copy wants.
stop_old() {
  if command -v spiega >/dev/null 2>&1; then
    spiega stop --all >/dev/null 2>&1 || true
  fi
}

# There is no `npm rm -g spiega` step before the swap, and that is deliberate.
# Removing first looks tidier and is strictly worse: npm replaces a linked
# package with an installed one and the reverse by itself (`npm link --dry-run`
# over an install reports a plain `change spiega 0.1.2 => 0.3.0`), so the
# removal buys nothing — while a swap that fails after it has run leaves the
# machine with no spiega at all, and `set -e` stops before putting one back.
# Letting npm do the replacement in one step means a failure changes nothing.

finish() {
  echo
  bold "re-pointing the skills and MCP configs at it"
  spiega install
  echo
  spiega doctor || true
}

# There is deliberately no "now start a fresh agent session" line after that
# doctor run, though a switch is exactly when you need one. There used to be,
# and it said its own slightly different version of what doctor's own fix line
# says. One edit to doctor's wording was enough to leave the two contradicting
# each other on the same screen — the script still advertising the sentence
# doctor had just stopped printing. Doctor knows which processes are actually
# stale and this script does not, so it is the one that gets to say so.

case "$MODE" in
  status)
    status
    ;;

  local)
    bold "switching to the checkout at $CLONE"
    stop_old
    (cd "$CLONE" && npm link)
    echo
    status
    finish
    ;;

  release)
    bold "switching to spiega@$WANT from npm"
    stop_old
    npm install -g "spiega@$WANT"
    echo
    status
    finish
    ;;

  -h|--help|help)
    sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;

  *)
    echo "unknown mode \"$MODE\" — try: status, local, release [version]" >&2
    exit 1
    ;;
esac
