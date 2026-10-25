#!/usr/bin/env bash
# Builds the HarmonyOS web bundle from a patched checkout, then writes harmony-web.zip and its
# unsigned manifest harmony-web.json into <out-dir>. sign-harmony-web.mjs signs the manifest.
#
#   .fork/build-harmony-web.sh <checkout> <out-dir> <tag> <tree>
#
# The checkout needs its npm dependencies installed. <tree> is the patched tree's hash, which
# names the bundle: two builds of one tree are the same web app.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
tag="$3"
tree="$4"

shell_api="$(tr -d '[:space:]' < "$here/harmony-shell-api")"
if ! [[ "$shell_api" =~ ^[1-9][0-9]*$ ]]; then
  echo "harmony-shell-api does not hold a level: '$shell_api'" >&2
  exit 1
fi
if ! [[ "$tree" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Not a tree hash: '$tree'" >&2
  exit 1
fi

(cd "$src/packages/app" && PASEO_WEB_PLATFORM=harmony npm run build:web)
dist="$src/packages/app/dist"
if [[ ! -f "$dist/index.html" ]]; then
  echo "No index.html in $dist" >&2
  exit 1
fi

revision="${tree:0:12}"
built_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

# The same stamp scripts/sync-web.sh writes, which the shell orders bundles by.
node - "$dist/paseo-bundle.json" "${tag#v}" "$revision" "$tag+$revision" "$built_at" "$shell_api" <<'NODE'
const fs = require("node:fs");
const [file, version, revision, describe, builtAt, shellApi] = process.argv.slice(2);
const stamp = { version, revision, describe, builtAt, shellApi: Number(shellApi) };
fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`);
NODE

rm -f "$out/harmony-web.zip"
(cd "$dist" && zip -q -r -X -9 "$out/harmony-web.zip" .)

node - "$out" "$tag" "$revision" "$built_at" "$shell_api" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [out, tag, revision, builtAt, shellApi] = process.argv.slice(2);
const zip = fs.readFileSync(path.join(out, "harmony-web.zip"));
const manifest = {
  format: 1,
  tag,
  version: tag.replace(/^v/, ""),
  revision,
  builtAt,
  shellApi: Number(shellApi),
  zip: {
    name: "harmony-web.zip",
    size: zip.length,
    sha256: crypto.createHash("sha256").update(zip).digest("hex"),
  },
};
fs.writeFileSync(path.join(out, "harmony-web.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`harmony-web.zip: ${zip.length} bytes, built ${builtAt}, shell API ${shellApi}`);
NODE
