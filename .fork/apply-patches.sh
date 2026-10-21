#!/usr/bin/env bash
# Apply the fork's patches on top of an upstream checkout, one `git am -3` per patch.
#
# Usage: .fork/apply-patches.sh [<repo-dir>] [<patch-dir>]
#
#   <repo-dir>   clean checkout of an upstream tag (default: current directory)
#   <patch-dir>  directory of `git format-patch` files (default: .fork/patches next to this script)
#
# A patch whose changes are already in the tree (upstream merged it) is skipped and
# reported as "already upstream". Exit status: 0 = every patch applied or skipped,
# 1 = a patch conflicts (named in the output, tree left clean), 2 = usage error.
# Works with the bash 3.2 that ships with macOS.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="${1:-.}"
patch_dir="${2:-$script_dir/patches}"

if [ ! -d "$patch_dir" ]; then
  echo "error: patch directory not found: $patch_dir" >&2
  exit 2
fi
patch_dir="$(cd "$patch_dir" && pwd)"
cd "$repo_dir"

if [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
  echo "error: a git am or rebase is already in progress in $(pwd)" >&2
  exit 2
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean: $(pwd)" >&2
  exit 2
fi

# git am needs a committer identity; CI runners have none configured.
if [ -z "$(git config user.email || true)" ]; then
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-paseo-fork-bot}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-paseo-fork-bot@users.noreply.github.com}"
fi

shopt -s nullglob
patches=("$patch_dir"/*.patch)
if [ "${#patches[@]}" -eq 0 ]; then
  echo "error: no *.patch files in $patch_dir" >&2
  exit 2
fi
shopt -u nullglob

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
am_log="$work_dir/am.log"

# True when patches[$1..end] are all in HEAD: reversing them newest-first on a scratch
# index succeeds. A later patch that edits an earlier one's lines makes the earlier
# patch fail to reverse on its own, so a merged series has to be checked as a stack.
suffix_is_upstream() {
  local index="$work_dir/index.$1"
  GIT_INDEX_FILE="$index" git read-tree HEAD
  local j
  for ((j = ${#patches[@]} - 1; j >= $1; j--)); do
    if ! GIT_INDEX_FILE="$index" git apply --cached --reverse "${patches[j]}" >/dev/null 2>&1; then
      return 1
    fi
  done
  return 0
}

upstream_from="${#patches[@]}"
for ((i = 0; i < ${#patches[@]}; i++)); do
  if suffix_is_upstream "$i"; then
    upstream_from="$i"
    break
  fi
done

echo "base: $(git describe --tags --always HEAD) ($(git rev-parse --short HEAD))"
applied=0
skipped=0

for ((i = 0; i < ${#patches[@]}; i++)); do
  patch="${patches[i]}"
  name="$(basename "$patch")"

  # A single patch reverses cleanly only when its post-image is already in the tree.
  if [ "$i" -ge "$upstream_from" ] || git apply --check --reverse "$patch" >/dev/null 2>&1; then
    echo "skip     $name (already upstream)"
    skipped=$((skipped + 1))
    continue
  fi

  before="$(git rev-parse HEAD)"
  if ! git am -3 "$patch" >"$am_log" 2>&1; then
    echo "conflict $name"
    git diff --name-only --diff-filter=U | sed 's/^/  conflicted file: /'
    sed 's/^/  git am: /' "$am_log"
    git am --abort >/dev/null 2>&1 || true
    exit 1
  fi

  # git am -3 records nothing when a 3-way merge finds the change already present.
  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    echo "skip     $name (already upstream, merged with changes)"
    skipped=$((skipped + 1))
  else
    echo "apply    $name"
    applied=$((applied + 1))
  fi
done

echo "result: $applied applied, $skipped already upstream"
