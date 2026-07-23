#!/usr/bin/env node
/**
 * Sign a release manifest (SPEC §19 — signed Electron build infra).
 *
 *   npx tsx scripts/sign-release.ts <manifest.json> [--gen-key]
 *
 * - If `keys/ed25519-private.pem` doesn't exist (or --gen-key), generate an
 *   Ed25519 keypair: write the PRIVATE key to keys/ed25519-private.pem
 *   (gitignored — keep secret) and print the PUBLIC key (base64) to embed in
 *   the binary via QUIVER_UPDATE_PUBKEY / DEFAULT_PUBKEY.
 * - Reads <manifest.json>, signs it, writes <manifest.json>.signed with the
 *   base64 signature appended as `signature`.
 *
 * The verify side (`src/updates.ts: verifyEd25519Signature`) checks this
 * signature against the committed public key. Rotate the key by re-running
 * with --gen-key and updating the embedded pubkey.
 *
 * Illustrative — the PRODUCTION release signing key is the owner's secret.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { generateEd25519KeyPair, signEd25519 } from "../src/updates.js";

const KEYS_DIR = path.join(process.cwd(), "keys");
const PRIV_KEY = path.join(KEYS_DIR, "ed25519-private.pem");

function ensureKey(gen: boolean): string {
  if (!gen && fs.existsSync(PRIV_KEY)) return fs.readFileSync(PRIV_KEY, "utf8");
  const { privateKeyPem, publicKeyBase64 } = generateEd25519KeyPair();
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(PRIV_KEY, privateKeyPem, { mode: 0o600 });
  console.log("Generated Ed25519 keypair:");
  console.log(`  private key: ${PRIV_KEY} (gitignored — keep secret)`);
  console.log(`  public key (base64, embed via QUIVER_UPDATE_PUBKEY): ${publicKeyBase64}`);
  return privateKeyPem;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find((a) => !a.startsWith("--"));
  const gen = args.includes("--gen-key");
  if (!manifestPath) {
    console.error("Usage: npx tsx scripts/sign-release.ts <manifest.json> [--gen-key]");
    process.exit(1);
  }
  const priv = ensureKey(gen);
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const signature = signEd25519(manifest, priv);
  const parsed = JSON.parse(manifest);
  parsed.signature = signature;
  const out = manifestPath + ".signed";
  fs.writeFileSync(out, JSON.stringify(parsed, null, 2));
  console.log(`Signed manifest written: ${out} (signature: ${signature.slice(0, 16)}…)`);
}

main().catch((e) => { console.error(e); process.exit(1); });