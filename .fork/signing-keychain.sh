#!/usr/bin/env bash
# Create or delete the throwaway keychain that holds the fork's signing key.
#
#   FORK_SIGN_P12_PASSWORD=... .fork/signing-keychain.sh create <p12-file> <keychain-path>
#   .fork/signing-keychain.sh delete <keychain-path>
#
# `create` imports the key as non-extractable, so code that runs later in the same
# session can use it to sign but cannot export it. The keychain is added to the user
# search list because codesign ignores --keychain for keychains that are not on it;
# `delete` removes it from the list again. The login keychain is never touched.
set -euo pipefail

fork_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command="${1:-}"

case "$command" in
  create)
    p12="${2:?usage: signing-keychain.sh create <p12-file> <keychain-path>}"
    keychain="${3:?usage: signing-keychain.sh create <p12-file> <keychain-path>}"
    : "${FORK_SIGN_P12_PASSWORD:?FORK_SIGN_P12_PASSWORD is required}"
    case "$keychain" in
      /*) ;;
      *) echo "error: keychain path must be absolute" >&2; exit 2 ;;
    esac
    if [ -e "$keychain" ]; then
      echo "error: keychain already exists: $keychain" >&2
      exit 2
    fi

    keychain_password="$(openssl rand -hex 32)"
    security create-keychain -p "$keychain_password" "$keychain"
    # No -t: the keychain must not auto-lock during a long build.
    security set-keychain-settings "$keychain"
    security unlock-keychain -p "$keychain_password" "$keychain"
    security import "$p12" -k "$keychain" -P "$FORK_SIGN_P12_PASSWORD" -x -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null

    search_list=()
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line#\"}"
      line="${line%\"}"
      [ -n "$line" ] && search_list+=("$line")
    done < <(security list-keychains -d user)
    security list-keychains -d user -s "$keychain" ${search_list[@]+"${search_list[@]}"}

    expected="$(openssl x509 -in "$fork_dir/signing-cert.crt" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'a-f' 'A-F')"
    if ! security find-identity -p codesigning "$keychain" | grep -q "$expected"; then
      echo "error: the p12 does not contain the certificate pinned in .fork/signing-cert.crt ($expected)" >&2
      security delete-keychain "$keychain"
      exit 1
    fi
    echo "signing identity $expected ready in $keychain"
    ;;
  delete)
    keychain="${2:?usage: signing-keychain.sh delete <keychain-path>}"
    if [ -e "$keychain" ]; then
      security delete-keychain "$keychain"
    fi
    ;;
  *)
    echo "usage: signing-keychain.sh create <p12-file> <keychain-path> | delete <keychain-path>" >&2
    exit 2
    ;;
esac
