// electron-builder `mac.sign` hook for the fork's self-signed certificate.
//
// electron-builder only discovers identities that `security find-identity -v` reports
// as valid, which excludes an untrusted self-signed certificate. On arm64 it then
// silently falls back to an ad-hoc signature, whose designated requirement is a
// per-build cdhash, so every update would fail Squirrel.Mac's signature check.
// This hook names the identity by SHA-1 and skips the trust lookup instead.
const path = require("node:path");

exports.default = async function signWithForkIdentity(opts) {
  const identity = process.env.FORK_SIGN_IDENTITY ?? "";
  const keychain = process.env.FORK_SIGN_KEYCHAIN ?? "";
  if (!/^[0-9A-F]{40}$/.test(identity)) {
    throw new Error("FORK_SIGN_IDENTITY must be the signing certificate's uppercase SHA-1");
  }
  if (!path.isAbsolute(keychain)) {
    throw new Error("FORK_SIGN_KEYCHAIN must be the absolute path of the signing keychain");
  }

  // Resolve from the desktop package being built, not from this file's directory.
  const { signAsync } = require(require.resolve("@electron/osx-sign", { paths: [process.cwd()] }));
  await signAsync({ ...opts, identity, keychain, identityValidation: false });
};
