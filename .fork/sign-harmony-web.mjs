#!/usr/bin/env node
// Signs <dir>/harmony-web.json with the Ed25519 key in FORK_HARMONY_WEB_SIGNING_KEY (PEM) and
// writes <dir>/harmony-web.json.sig, the signature in base64.
//
// Fails unless the signature verifies against .fork/harmony-web-signing.pub, the key the
// HarmonyOS shell pins: a secret that does not match would publish bundles every installed
// shell rejects.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const pem = process.env.FORK_HARMONY_WEB_SIGNING_KEY;
if (!dir) {
  console.error("usage: sign-harmony-web.mjs <dir>");
  process.exit(2);
}
if (!pem) {
  console.error("FORK_HARMONY_WEB_SIGNING_KEY is not set");
  process.exit(1);
}

const manifest = readFileSync(join(dir, "harmony-web.json"));
const signature = sign(null, manifest, createPrivateKey(pem));
const pinned = createPublicKey(readFileSync(new URL("harmony-web-signing.pub", import.meta.url)));
if (!verify(null, manifest, pinned, signature)) {
  console.error("The signing key is not the one in .fork/harmony-web-signing.pub");
  process.exit(1);
}
writeFileSync(join(dir, "harmony-web.json.sig"), `${signature.toString("base64")}\n`);
console.log("Signed harmony-web.json");
