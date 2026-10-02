#!/usr/bin/env bash
#
# Ship this repo's main to the pi that runs it.
#
# pi loads multi-pass from `git:github.com/joelsb/pi-multi-pass` (settings.json),
# cloned under ~/.pi/agent/git/github.com/joelsb/pi-multi-pass. A commit changes
# nothing pi runs until it is pushed to the fork and `pi update --extension` pulls it.
#
# Never `npm:pi-multi-pass`: on 2026-09-21 a package update replaced the hand-copied
# fork with upstream 1.5.1 and silently dropped every fix here, including the chain
# ring, so failover went anthropic -> anthropic-2 -> codex and never back.
#
#   bash scripts/deploy.sh          push main to fork, pi update, verify
#   bash scripts/deploy.sh --check  report drift only, exit 1 if pi runs other code
set -euo pipefail

source="git:github.com/joelsb/pi-multi-pass"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installed="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/git/github.com/joelsb/pi-multi-pass"

check() {
  [ -d "$installed" ] || { echo "not installed: pi install $source" >&2; return 1; }
  local want have
  want=$(git -C "$repo" rev-parse HEAD)
  have=$(git -C "$installed" rev-parse HEAD)
  [ "$want" = "$have" ] && { echo "up to date: pi runs $(git -C "$repo" rev-parse --short HEAD)"; return 0; }
  echo "DRIFT: pi runs $(git -C "$installed" rev-parse --short HEAD), repo HEAD is $(git -C "$repo" rev-parse --short HEAD)" >&2
  return 1
}

if [ "${1:-}" = "--check" ]; then check; exit; fi

[ -z "$(git -C "$repo" status --porcelain)" ] || { echo "uncommitted changes, commit first" >&2; exit 1; }
git -C "$repo" push fork HEAD:main
(cd /tmp && pi update --extension "$source")
check
echo "Already-running pi sessions keep the old code until restart or /reload."
