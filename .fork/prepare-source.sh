#!/usr/bin/env bash
# Turn a clean checkout of an upstream release into the fork's build source:
# apply .fork/patches, drop upstream's workflows, and print the resulting tree hash
# as the last line ("tree: <sha>"). The same inputs always give the same tree, which
# is how the signing job proves it builds exactly what the test job tested.
#
# Usage: .fork/prepare-source.sh <repo-dir>
set -euo pipefail

fork_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="${1:?usage: prepare-source.sh <repo-dir>}"

bash "$fork_dir/apply-patches.sh" "$repo_dir" "$fork_dir/patches"

# Upstream's release workflows react to v* tags and main pushes. Keeping them out of
# the patched tree means it can never start them, even if it is pushed to the fork.
git -C "$repo_dir" rm -rq --ignore-unmatch .github/workflows
git -C "$repo_dir" \
  -c user.name=paseo-fork-bot \
  -c user.email=paseo-fork-bot@users.noreply.github.com \
  commit -q --no-verify --allow-empty -m "fork: drop upstream workflows"

echo "tree: $(git -C "$repo_dir" rev-parse 'HEAD^{tree}')"
