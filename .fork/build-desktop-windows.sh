#!/usr/bin/env bash
# Build the patched Windows x64 installer, signed with the fork certificate from the current
# user's certificate store and pointed at the fork's GitHub releases, then verify the output.
# Runs in Git Bash on a Windows runner; the fork certificate must already be in Cert:\CurrentUser\My.
#
#   .fork/build-desktop-windows.sh <repo-dir> <out-dir>
#
# Optional: FORK_EXPECTED_VERSION (fail unless packages/desktop is that version),
# FORK_PUBLISH_OWNER / FORK_PUBLISH_REPO (default Vincent-Leon/paseo).
# <out-dir> receives exactly the files a release needs: the installer, its blockmap and latest.yml.
set -euo pipefail

fork_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${1:?usage: build-desktop-windows.sh <repo-dir> <out-dir>}" && pwd)"
out_dir="${2:?usage: build-desktop-windows.sh <repo-dir> <out-dir>}"
owner="${FORK_PUBLISH_OWNER:-Vincent-Leon}"
repo="${FORK_PUBLISH_REPO:-paseo}"

thumbprint="$(openssl x509 -in "$fork_dir/signing-cert.crt" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'a-f' 'A-F')"
# electron-updater refuses an update unless its Authenticode signer has this common name and the
# signature validates, which needs the certificate trusted on the installing machine.
publisher="$(openssl x509 -in "$fork_dir/signing-cert.crt" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= *//p')"

version="$(cd "$repo_dir" && node -p "require('./packages/desktop/package.json').version")"
if [ -n "${FORK_EXPECTED_VERSION:-}" ] && [ "$version" != "$FORK_EXPECTED_VERSION" ]; then
  echo "error: packages/desktop is $version, expected $FORK_EXPECTED_VERSION" >&2
  exit 1
fi

release_dir="$repo_dir/packages/desktop/release"
rm -rf "$release_dir"

(
  cd "$repo_dir"
  # Upstream's target lists x64 and arm64, which --x64 does not narrow; that build also emits a
  # two-architecture installer that latest.yml points at. A bare nsis target takes the CLI arch.
  npm run build:desktop -- \
    --publish never --win --x64 \
    -c.win.target=nsis \
    "-c.publish.owner=$owner" \
    "-c.publish.repo=$repo" \
    -c.publish.releaseType=release \
    -c.publish.channel=latest \
    "-c.win.signtoolOptions.certificateSha1=$thumbprint" \
    "-c.win.signtoolOptions.publisherName=$publisher"
)

echo "--- verifying build output"
fail() {
  echo "error: $*" >&2
  exit 1
}

# The runner does not trust the self-signed root, so the status is not Valid here; the signer is
# what has to match. The installing machine trusts the certificate and gets a Valid status.
signer_of() {
  powershell.exe -NoProfile -Command \
    "(Get-AuthenticodeSignature -FilePath '$(cygpath -w "$1")').SignerCertificate.Thumbprint" | tr -d '\r'
}

installer="Paseo-Setup-$version-x64.exe"
artifacts=("$installer" "$installer.blockmap" "latest.yml")
for file in "${artifacts[@]}"; do
  [ -f "$release_dir/$file" ] || fail "missing build output $file"
done

for binary in "$release_dir/$installer" "$release_dir/win-unpacked/Paseo.exe"; do
  [ "$(signer_of "$binary")" = "$thumbprint" ] || fail "$(basename "$binary") is not signed by $thumbprint"
done
echo "ok: installer and Paseo.exe are signed by the fork certificate"

update_config="$release_dir/win-unpacked/resources/app-update.yml"
grep -qx "owner: $owner" "$update_config" || fail "app-update.yml owner is not $owner"
grep -qx "repo: $repo" "$update_config" || fail "app-update.yml repo is not $repo"
grep -qx "provider: github" "$update_config" || fail "app-update.yml provider is not github"
grep -qF "$publisher" "$update_config" || fail "app-update.yml does not pin publisherName $publisher"
echo "ok: app-update.yml updates from $owner/$repo and requires signer $publisher"

manifest="$release_dir/latest.yml"
grep -qx "version: $version" "$manifest" || fail "latest.yml is not version $version"
installer_sha512="$(openssl dgst -sha512 -binary "$release_dir/$installer" | base64 | tr -d '\n')"
grep -qx "path: $installer" "$manifest" || fail "latest.yml does not point the updater at $installer"
grep -qF "sha512: $installer_sha512" "$manifest" || fail "latest.yml sha512 does not match $installer"
echo "ok: latest.yml lists $installer with a matching sha512"

mkdir -p "$out_dir"
for file in "${artifacts[@]}"; do
  cp "$release_dir/$file" "$out_dir/"
done
echo "artifacts in $out_dir:"
ls -l "$out_dir"
