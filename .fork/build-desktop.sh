#!/usr/bin/env bash
# Build the patched macOS arm64 desktop app, signed with the fork certificate and
# pointed at the fork's GitHub releases, then verify what was produced.
#
#   FORK_SIGN_KEYCHAIN=<keychain from signing-keychain.sh> .fork/build-desktop.sh <repo-dir> <out-dir>
#
# Optional: FORK_EXPECTED_VERSION (fail unless packages/desktop is that version),
# FORK_PUBLISH_OWNER / FORK_PUBLISH_REPO (default Vincent-Leon/paseo).
# <out-dir> receives exactly the files a release needs: dmg, zip, their blockmaps and
# latest-mac.yml.
set -euo pipefail

fork_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${1:?usage: build-desktop.sh <repo-dir> <out-dir>}" && pwd)"
out_dir="${2:?usage: build-desktop.sh <repo-dir> <out-dir>}"
: "${FORK_SIGN_KEYCHAIN:?FORK_SIGN_KEYCHAIN is required}"
owner="${FORK_PUBLISH_OWNER:-Vincent-Leon}"
repo="${FORK_PUBLISH_REPO:-paseo}"

identity="$(openssl x509 -in "$fork_dir/signing-cert.crt" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'a-f' 'A-F')"
leaf_hash="$(printf '%s' "$identity" | tr 'A-F' 'a-f')"
# The app id comes from packages/desktop/electron-builder.yml. Changing it changes the
# app's identity, so a mismatch here must stop the release rather than adapt.
requirement="identifier \"sh.paseo.desktop\" and certificate leaf = H\"$leaf_hash\""

version="$(node -p "require('$repo_dir/packages/desktop/package.json').version")"
if [ -n "${FORK_EXPECTED_VERSION:-}" ] && [ "$version" != "$FORK_EXPECTED_VERSION" ]; then
  echo "error: packages/desktop is $version, expected $FORK_EXPECTED_VERSION" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
mount_dir="$work_dir/dmg"
cleanup() {
  if [ -d "$mount_dir" ]; then
    hdiutil detach -quiet "$mount_dir" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

# Without a Team ID, hardened runtime's library validation refuses to map Electron
# Framework ("mapping process and mapped file (non-platform) have different Team
# IDs") and the app aborts at launch. Upstream's notarized build has a Team ID.
for name in entitlements.mac.plist entitlements.mac.inherit.plist; do
  cp "$repo_dir/packages/desktop/build/$name" "$work_dir/$name"
  /usr/libexec/PlistBuddy -c "Delete :com.apple.security.cs.disable-library-validation" "$work_dir/$name" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$work_dir/$name"
done

release_dir="$repo_dir/packages/desktop/release"
rm -rf "$release_dir"

(
  cd "$repo_dir"
  # Auto-discovery off: never pick up an identity from the login keychain.
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    FORK_SIGN_IDENTITY="$identity" \
    FORK_SIGN_KEYCHAIN="$FORK_SIGN_KEYCHAIN" \
    npm run build:desktop -- \
    --publish never --mac --arm64 \
    "-c.publish.owner=$owner" \
    "-c.publish.repo=$repo" \
    -c.publish.releaseType=release \
    -c.publish.channel=latest \
    -c.mac.notarize=false \
    "-c.mac.sign=$fork_dir/mac-sign.cjs" \
    "-c.mac.entitlements=$work_dir/entitlements.mac.plist" \
    "-c.mac.entitlementsInherit=$work_dir/entitlements.mac.inherit.plist"
)

echo "--- verifying build output"
fail() {
  echo "error: $*" >&2
  exit 1
}

verify_app() {
  local app="$1" label="$2"
  codesign --verify --deep --strict -R="$requirement" "$app" ||
    fail "$label does not satisfy $requirement"
  local designated
  designated="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^#* *designated => //p')"
  [ "$designated" = "$requirement" ] || fail "$label designated requirement is '$designated'"
  codesign -d --entitlements - --xml "$app" 2>/dev/null | grep -q "com.apple.security.cs.disable-library-validation" ||
    fail "$label is missing the disable-library-validation entitlement"
  local update_config="$app/Contents/Resources/app-update.yml"
  grep -qx "owner: $owner" "$update_config" || fail "$label app-update.yml owner is not $owner"
  grep -qx "repo: $repo" "$update_config" || fail "$label app-update.yml repo is not $repo"
  grep -qx "provider: github" "$update_config" || fail "$label app-update.yml provider is not github"
  echo "ok: $label is signed by the fork certificate and updates from $owner/$repo"
}

base="Paseo-$version-arm64"
artifacts=("$base.dmg" "$base.dmg.blockmap" "$base.zip" "$base.zip.blockmap" "latest-mac.yml")
for file in "${artifacts[@]}"; do
  [ -f "$release_dir/$file" ] || fail "missing build output $file"
done

verify_app "$release_dir/mac-arm64/Paseo.app" "unpacked app"

# The zip is what electron-updater installs; the dmg is what a person installs.
ditto -x -k "$release_dir/$base.zip" "$work_dir/zip"
verify_app "$work_dir/zip/Paseo.app" "zip"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" "$release_dir/$base.dmg"
verify_app "$mount_dir/Paseo.app" "dmg"
hdiutil detach -quiet "$mount_dir"

manifest="$release_dir/latest-mac.yml"
grep -qx "version: $version" "$manifest" || fail "latest-mac.yml is not version $version"
zip_sha512="$(openssl dgst -sha512 -binary "$release_dir/$base.zip" | base64 | tr -d '\n')"
grep -q "url: $base.zip" "$manifest" || fail "latest-mac.yml does not list $base.zip"
grep -qF "sha512: $zip_sha512" "$manifest" || fail "latest-mac.yml sha512 does not match $base.zip"
echo "ok: latest-mac.yml lists $base.zip with a matching sha512"

mkdir -p "$out_dir"
for file in "${artifacts[@]}"; do
  cp "$release_dir/$file" "$out_dir/"
done
echo "artifacts in $out_dir:"
ls -l "$out_dir"
