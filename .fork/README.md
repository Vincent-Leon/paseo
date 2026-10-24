# Fork patched release

This fork (`Vincent-Leon/paseo`) republishes each stable release of `getpaseo/paseo` for macOS arm64 and Windows x64 with a small set of local patches. The patched desktop app updates from this fork's GitHub releases instead of upstream's.

| Path                                         | Purpose                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `.github/workflows/fork-patched-release.yml` | The pipeline                                                                    |
| `.fork/patches/`                             | `git format-patch` files, applied in name order                                 |
| `.fork/apply-patches.sh`                     | Applies the patches to an upstream checkout, skipping ones upstream already has |
| `.fork/prepare-source.sh`                    | Applies the patches, drops upstream's workflows, prints the tree hash           |
| `.fork/tests.txt`                            | The test files that cover the patches                                           |
| `.fork/signing-cert.crt`                     | Public half of the signing certificate. Pins which key may sign                 |
| `.fork/signing-keychain.sh`                  | Creates and deletes the throwaway keychain that holds the key                   |
| `.fork/mac-sign.cjs`                         | electron-builder `mac.sign` hook                                                |
| `.fork/build-desktop.sh`                     | Builds, signs and verifies the dmg, zip, blockmaps and `latest-mac.yml`         |
| `.fork/build-desktop-windows.sh`             | Builds, signs and verifies the Windows installer, its blockmap and `latest.yml` |

## How a release flows

Every three hours, and on manual dispatch, the workflow runs these jobs:

1. **resolve** reads `repos/getpaseo/paseo/releases/latest`. It accepts only a `vX.Y.Z` tag that is a published, non-prerelease upstream release. It stops if this fork already has a release with that tag, or if the tag is listed in the `FORK_SKIP_TAGS` repository variable. A build-only dispatch (`publish` off) skips both checks and also accepts a published upstream prerelease.
2. **build** checks out the upstream tag, applies the patches, installs dependencies and runs the tests in `tests.txt`. It has no secrets and a read-only token.
3. **sign-macos** and **sign-windows** wait for a reviewer to approve the `fork-release` environment; one approval covers both. Each rebuilds the same source tree, verified by tree hash, then signs the app, launches it once against an isolated daemon (packaged smoke test) and verifies the output.
4. **publish** uploads the eight files to a release with the upstream tag name and marks it latest. It runs no upstream code, and a build-only run skips it.
5. **report** opens or updates an issue named `Patched release blocked: vX.Y.Z` when a run fails, and closes it after that tag publishes.

The release tag is created with `GITHUB_TOKEN`. GitHub does not start workflows for events caused by that token, so the new `v*` tag cannot trigger upstream's tag-driven workflows (desktop, Android, Docker, app deploy) in this fork.

The sign jobs rebuild instead of re-signing the build job's output. electron-builder signs before it writes the installers and their sha512 in `latest-mac.yml` and `latest.yml`, so re-signing later would mean regenerating all of them outside electron-builder.

To get installers without publishing, for a stable release or an upstream prerelease, dispatch a build-only run and download its artifacts once you have approved it:

```bash
gh workflow run fork-patched-release.yml -R Vincent-Leon/paseo -f upstream_tag=v0.13.0-beta.1 -f publish=false
gh run download <run-id> -R Vincent-Leon/paseo -n fork-release-windows -n fork-release-macos
```

The Windows build runs on a Windows runner because `npm ci` installs only the host's platform packages: a Windows installer packaged on a Mac lacks the Windows builds of sharp, sherpa-onnx and msgpackr-extract.

Versions are upstream's, unchanged. The updater has `allowDowngrade=false` and installs only a strictly newer version. If you republish an existing version (`force` on dispatch), installed apps do not update. Install that build by hand from the release.

## Signing

Squirrel.Mac installs an update only if the new app satisfies the running app's designated requirement (DR). An ad-hoc signature's DR is `cdhash H"..."`, which changes with every build, so ad-hoc builds download updates and then fail to install them. A fixed self-signed certificate gives `identifier "sh.paseo.desktop" and certificate leaf = H"<sha1>"`, which every build signed with the same key satisfies. `build-desktop.sh` fails the build unless the unpacked app, the zip and the dmg all satisfy exactly that requirement.

Two gotchas shape the scripts:

- electron-builder only looks for identities that `security find-identity -v` reports as valid. An untrusted self-signed certificate is not valid, so on arm64 electron-builder quietly falls back to ad-hoc signing. `mac-sign.cjs` names the identity by SHA-1 and calls `@electron/osx-sign` with `identityValidation: false`.
- A self-signed certificate has no Team ID. Under hardened runtime, library validation then refuses to load `Electron Framework` ("mapping process and mapped file (non-platform) have different Team IDs") and the app aborts at launch. The fork build adds `com.apple.security.cs.disable-library-validation` to copies of upstream's entitlement files. Upstream's files stay untouched.

The build is not notarized. Gatekeeper blocks the first launch of a downloaded copy until you allow it in System Settings → Privacy & Security, or run `xattr -dr com.apple.quarantine /Applications/Paseo.app`.

### Windows

The same certificate signs the Windows installer and `Paseo.exe` through Authenticode; its `codeSigning` key usage covers both platforms. electron-builder records the certificate's common name as `publisherName` in `app-update.yml`, and electron-updater installs an update only when `Get-AuthenticodeSignature` reports it `Valid` and signed by that name. A self-signed certificate is `Valid` only on a machine that trusts it, so do this once on each Windows PC, in an administrator PowerShell:

```powershell
Import-Certificate -FilePath .\signing-cert.crt -CertStoreLocation Cert:\LocalMachine\Root
Import-Certificate -FilePath .\signing-cert.crt -CertStoreLocation Cert:\LocalMachine\TrustedPublisher
```

Without it the app downloads updates and refuses to install them. SmartScreen still warns on the first manual install of a downloaded installer; choose More info → Run anyway.

## Security model

Publishing a release here is equivalent to running code on every machine that has the patched app installed. Two things are required to ship an update: a release in this repository, and a signature from the pinned key. The pipeline separates them:

- The key exists only as `fork-release` environment secrets (`FORK_SIGNING_P12_BASE64`, `FORK_SIGNING_P12_PASSWORD`). Only the sign job can read them, and only after a required reviewer approves the run. Restrict the environment to the default branch so a workflow on another branch cannot use it.
- The sign job's token is read-only. The job that can write releases runs no upstream code.
- The key is imported non-extractable, into a keychain on macOS and into the user certificate store on Windows, and both are removed at the end of the job. The secret is present only in the import step's environment.
- Every job has explicit permissions under a top-level `permissions: {}`. Third-party actions are pinned to full commit SHAs. No job uses a dependency cache, so a lower-trust job cannot poison what the sign job installs.
- Every job requires `github.repository == 'Vincent-Leon/paseo'`.

Remaining risks:

- **Upstream and its dependencies are trusted.** The sign job runs upstream's build with the key usable in the same session. A compromised upstream release or npm dependency could sign other code during that job. Hosted runners give jobs passwordless sudo, so non-extractable import raises the bar for stealing the key but does not rule it out. If you suspect a leak, rotate the key: generate a new certificate, replace `signing-cert.crt` and the secrets, and reinstall by hand (the DR changes, so updates across the rotation fail).
- **Your GitHub account is the root of trust.** Anyone who controls it can edit the workflow, approve the environment and publish. Use two-factor authentication. Protect the default branch: require a pull request, block force pushes and deletion, and include administrators.
- **The local copy of the key** in `~/.paseo/fork-signing/` can sign updates for this machine. Keep that directory private. Keep an offline backup of `signing.p12` and its password.
- **Library validation is off** for the fork build. Hardened runtime still blocks `DYLD_*` injection and debugger attachment.
- **No staged rollout.** A fork release reaches the app on its next update check.
- **Trusting the certificate on Windows trusts the key.** Anything signed with it runs as a trusted publisher on that PC, not only Paseo. Remove both entries when you stop using the fork build.

## Repository setup

- The default branch holds only the workflow and `.fork/`. Scheduled workflows run only from the default branch, and a default branch without upstream's workflows keeps them from running here.
- Do not push upstream's `main` or upstream `v*` tags to this fork while Actions is enabled. Upstream workflows trigger on `main` pushes and `v*` tags, and they would run from the commit you push. Feature branches trigger nothing.
- Issues must be enabled for failure reports.
- GitHub disables scheduled workflows in public repositories after 60 days without repository activity. If that happens, run `gh workflow enable fork-patched-release.yml -R Vincent-Leon/paseo`.
- Keep the desktop app on the Stable channel. The fork publishes only stable releases.

## Patches

Patches are `git format-patch` files. Each one keeps its author and message.

To add a patch, commit it on a branch based on the newest upstream tag, then export it with the next number:

```bash
git format-patch -1 <commit> -o .fork/patches --start-number 3
```

Add the tests that cover it to `.fork/tests.txt`. Then check it against the release it will ship on:

```bash
git worktree add --detach /tmp/fork-check v0.12.0
.fork/apply-patches.sh /tmp/fork-check
git worktree remove --force /tmp/fork-check
```

To remove a patch, delete its file and its lines in `tests.txt`. Patch numbers do not need to be contiguous.

When upstream merges a patch unchanged, `apply-patches.sh` reports it as `already upstream` and the run continues. Delete the file afterwards. A series that upstream merged together is detected as a stack, newest patch first. If upstream merged a modified version, the patch shows up as a conflict.

## When a run fails

The issue names the stage and includes the patch log.

- **A patch conflicts.** Check out the new upstream tag, apply the patches with `git am -3 .fork/patches/*.patch`, and resolve the conflict. Then regenerate every patch from the result so the next run starts clean:

  ```bash
  git format-patch <upstream-tag>..HEAD -o .fork/patches
  ```

  Commit the new patch files to the default branch and run the workflow manually. If upstream now covers the change, delete the patch instead.

- **The patch tests failed.** Treat it like a conflict. Upstream changed the code the patch relies on.
- **Building, signing or verifying failed.** Read the run log. `build-desktop.sh` stops on the first property that does not hold: signer, DR, entitlement, update feed, file set or manifest hash. `build-desktop-windows.sh` does the same for the signer thumbprint, update feed, `publisherName`, file set and manifest hash. A smoke-test failure uploads a `desktop-smoke-macos` or `desktop-smoke-windows` artifact.
- **You rejected the approval.** Nothing is reported. To stop being asked about a version, add its tag to the `FORK_SKIP_TAGS` repository variable (space-separated).

## Building locally

On an Apple Silicon Mac, with the key in `~/.paseo/fork-signing/`:

```bash
git worktree add --detach /tmp/paseo-fork v0.12.0
.fork/prepare-source.sh /tmp/paseo-fork
(cd /tmp/paseo-fork && npm ci)
keychain=/tmp/paseo-fork-signing.keychain-db
FORK_SIGN_P12_PASSWORD="$(cat ~/.paseo/fork-signing/p12-password.txt)" \
  .fork/signing-keychain.sh create ~/.paseo/fork-signing/signing.p12 "$keychain"
FORK_SIGN_KEYCHAIN="$keychain" FORK_EXPECTED_VERSION=0.12.0 \
  .fork/build-desktop.sh /tmp/paseo-fork "$PWD/artifacts/fork-v0.12.0"
.fork/signing-keychain.sh delete "$keychain"
```

npm 11 skips dependency install scripts that are not listed in `allowScripts`. If it reports skipped scripts, pass an allow list through a throwaway user config (`--userconfig`), leaving out `lefthook`, whose postinstall rewrites the shared git hooks.

Do not set `PASEO_DESKTOP_SMOKE=1` on a machine where Paseo is running. The smoke test launches the packaged app.

The HarmonyOS app is built outside this workflow. Its HAP has to be signed with a developer's own AppGallery Connect profile, so it is built on that developer's machine: prepare a checkout as above, run `npm ci` in it, and hand it to `scripts/sync-web.sh` in the paseo-harmony project, which builds the web app with `PASEO_WEB_PLATFORM=harmony` (patch 0007).

## Switching back to official updates

Download the official dmg from <https://github.com/getpaseo/paseo/releases/latest> and drag Paseo into Applications, replacing the fork build. The official app's `app-update.yml` points at `getpaseo/paseo` and it updates from there again. Your data in `~/.paseo` and `~/Library/Application Support/Paseo` is kept. Changing between the official and the fork signature resets macOS privacy permissions granted to the app, so expect those prompts again.

On Windows, install the official setup from the same page over the fork build, then remove the fork certificate from `Cert:\LocalMachine\Root` and `Cert:\LocalMachine\TrustedPublisher`.
