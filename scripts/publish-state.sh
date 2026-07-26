#!/usr/bin/env bash
#
# Publishes files to the orphan `state` branch without destroying what other
# workflows put there.
#
# The `state` branch is shared: Health Scan writes `health.json`, EPG Grab
# writes `epg/*`. An earlier version of these workflows each did
# `git init` + `push --force`, so whichever ran last silently wiped the
# other's data — the health history that makes scoring meaningful would
# vanish every time the guide refreshed. This script clones the existing
# branch, overlays only the caller's files, and pushes normally.
#
# Usage:
#   scripts/publish-state.sh <message> <src:dest> [<src:dest> ...]
#
# Example:
#   scripts/publish-state.sh "health: $(date -u +%FT%TZ)" .data/health.json:health.json
#   scripts/publish-state.sh "epg: nightly" guides/:epg/
#
# Requires GITHUB_TOKEN and GITHUB_REPOSITORY in the environment.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <commit-message> <src:dest> [<src:dest> ...]" >&2
  exit 2
fi

MESSAGE="$1"
shift

: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Start from the existing branch when there is one; otherwise create it.
if git clone --quiet --depth 1 --branch state "$REMOTE" "$WORKDIR" 2>/dev/null; then
  echo "Cloned existing state branch"
else
  echo "No state branch yet — creating it"
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR"
  git -C "$WORKDIR" init --quiet -b state
  git -C "$WORKDIR" remote add origin "$REMOTE"
fi

git -C "$WORKDIR" config user.name  "github-actions[bot]"
git -C "$WORKDIR" config user.email "41898282+github-actions[bot]@users.noreply.github.com"

copied=0
for pair in "$@"; do
  src="${pair%%:*}"
  dest="${pair#*:}"

  if [ ! -e "$src" ]; then
    echo "skip: $src does not exist"
    continue
  fi

  if [ -d "$src" ]; then
    # Directory: replace the destination directory wholesale so files removed
    # upstream do not linger, but leave every sibling path untouched.
    rm -rf "${WORKDIR:?}/${dest%/}"
    mkdir -p "$WORKDIR/${dest%/}"
    cp -R "$src"/. "$WORKDIR/${dest%/}/"
  else
    mkdir -p "$(dirname "$WORKDIR/$dest")"
    cp "$src" "$WORKDIR/$dest"
  fi
  copied=$((copied + 1))
  echo "staged: $src -> $dest"
done

if [ "$copied" -eq 0 ]; then
  echo "Nothing to publish"
  exit 0
fi

cd "$WORKDIR"
git add -A
if git diff --cached --quiet; then
  echo "State branch already up to date"
  exit 0
fi

git commit --quiet -m "$MESSAGE"

# Retry once: a concurrent workflow may have pushed between our clone and now.
if ! git push --quiet origin state 2>/dev/null; then
  echo "Push rejected, rebasing onto the latest state and retrying"
  git fetch --quiet origin state
  git rebase --quiet origin/state || {
    echo "Rebase failed; keeping our version of conflicting files"
    git checkout --ours . 2>/dev/null || true
    git add -A
    git rebase --continue || git rebase --abort
  }
  git push origin state
fi

echo "Published to state branch: $MESSAGE"
