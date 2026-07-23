/**
 * Auto-Update System — signed update checking with Ed25519 verification.
 *
 * Inspired by os-june's auto-update system which uses a signed JSON manifest
 * (latest.json) with Ed25519 signatures hosted on a separate public releases
 * repo. The updater checks the manifest, verifies the signature, and
 * downloads the update if a newer version is available.
 *
 * This module provides:
 *   1. Version comparison (semver-aware)
 *   2. Update manifest fetching and Ed25519 signature verification
 *   3. Download verification (SHA-256 checksum)
 *   4. Non-blocking update notifications (never interrupts the user's session)
 *
 * License note: This implementation is original Quiver code (Apache-2.0).
 * The concept of signed update manifests is standard practice.
 * os-june (MIT) uses a similar approach with Ed25519 signatures.
 */

import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────

export interface UpdateManifest {
  version: string;
  releaseDate: string;
  notes: string;
  platforms: {
    darwin?: {
      url: string;
      signature: string;
      sha256: string;
      arch: string[];
    };
    linux?: {
      url: string;
      signature: string;
      sha256: string;
      arch: string[];
    };
    win32?: {
      url: string;
      signature: string;
      sha256: string;
      arch: string[];
    };
  };
  /** Ed25519 public key used to verify the manifest signature. */
  minQuiverVersion?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  downloadUrl?: string;
  sha256?: string;
  signature?: string;
  error?: string;
}

// ─── Version Comparison ──────────────────────────────────────────────

/**
 * Parse a semver string into [major, minor, patch].
 * Returns [0, 0, 0] for unparseable strings.
 */
export function parseSemver(version: string): [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [
    parseInt(match[1], 10),
    parseInt(match[2], 10),
    parseInt(match[3], 10),
  ];
}

/**
 * Compare two semver strings.
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPatch] = parseSemver(a);
  const [bMaj, bMin, bPatch] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

// ─── Ed25519 Signature Verification ──────────────────────────────────

/**
 * The Ed25519 public key for verifying update manifests.
 * This is the Quiver release signing key. In production, this would be
 * embedded in the binary and rotated with each major release.
 *
 * For now, we use a placeholder that can be overridden via QUIVER_UPDATE_PUBKEY env var.
 */
const DEFAULT_PUBKEY = process.env.QUIVER_UPDATE_PUBKEY || "";

/**
 * Verify an Ed25519 signature against a message using the public key.
 *
 * @param message - The raw message bytes (or string)
 * @param signature - The base64-encoded signature
 * @param publicKey - The base64-encoded Ed25519 public key
 * @returns true if the signature is valid
 */
export function verifyEd25519Signature(
  message: string | Buffer,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const msgBuf =
      typeof message === "string" ? Buffer.from(message, "utf8") : message;
    const sigBuf = Buffer.from(signature, "base64");
    const keyBuf = Buffer.from(publicKey, "base64");

    // Node.js crypto.verify with Ed25519
    // The key must be in raw format (32 bytes) for Ed25519
    if (keyBuf.length !== 32) {
      // Try as DER-encoded SPKI
      const keyObj = crypto.createPublicKey({
        key: keyBuf,
        format: "der",
        type: "spki",
      });
      return crypto.verify(null, msgBuf, keyObj, sigBuf);
    }

    // Raw 32-byte key — wrap in PKCS8 SPKI
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 OID prefix (SPKI format)
        Buffer.from("302a300506032b6570032100", "hex"),
        keyBuf,
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, msgBuf, keyObj, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Sign a message with an Ed25519 private key (the counterpart to
 * verifyEd25519Signature). Used by `scripts/sign-release.ts` to produce signed
 * update manifests. The private key is the release signing key — keep it
 * secret; only the public key is embedded in the binary / committed.
 */
export function signEd25519(message: string | Buffer, privateKeyPem: string): string {
  const msgBuf = typeof message === "string" ? Buffer.from(message, "utf8") : message;
  const keyObj = crypto.createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  return crypto.sign(null, msgBuf, keyObj).toString("base64");
}

/**
 * Generate an Ed25519 keypair. Returns { privateKeyPem, publicKeyBase64 }.
 * The owner runs this once to mint the release signing key; the private key
 * is written to a gitignored file, the public key is committed/embedded.
 */
export function generateEd25519KeyPair(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // Extract the raw 32-byte public key from the SPKI DER (last 32 bytes).
  const publicKeyBase64 = publicKeyDer.subarray(-32).toString("base64");
  return { privateKeyPem, publicKeyBase64 };
}

/**
 * Verify a SHA-256 checksum.
 */
export function verifySha256(
  filePath: string,
  expectedSha256: string,
): boolean {
  try {
    const fileBuf = fs.readFileSync(filePath);
    const hash = crypto.createHash("sha256").update(fileBuf).digest("hex");
    return hash === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

// ─── Update Manifest Fetching ────────────────────────────────────────

/**
 * The default update manifest URL. Can be overridden via QUIVER_UPDATE_URL env var.
 * In production, this would point to a CDN or GitHub releases page.
 */
const DEFAULT_UPDATE_URL =
  process.env.QUIVER_UPDATE_URL ||
  "https://raw.githubusercontent.com/rahul16ss/quiver/main/releases/latest.json";

/**
 * Fetch and verify the update manifest from the update server.
 *
 * The manifest is a JSON file signed with Ed25519. The signature is
 * provided in a companion file (latest.json.sig) or in a header.
 *
 * @param url - The manifest URL (defaults to DEFAULT_UPDATE_URL)
 * @param publicKey - The Ed25519 public key (defaults to DEFAULT_PUBKEY)
 * @returns The verified manifest, or null if verification fails
 */
export async function fetchUpdateManifest(
  url: string = DEFAULT_UPDATE_URL,
  publicKey: string = DEFAULT_PUBKEY,
): Promise<UpdateManifest | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const manifestText = await response.text();

    // Signature verification is mandatory when a public key is configured.
    // When no public key is configured, reject the manifest entirely —
    // an unsigned manifest from a MITM could contain an attacker downloadUrl.
    if (!publicKey) {
      console.error("Update manifest rejected — no public key configured for signature verification");
      return null;
    }

    // Fetch the signature from a companion URL
    const sigUrl = url + ".sig";
    let signature = "";
    try {
      const sigResponse = await fetch(sigUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (sigResponse.ok) {
        signature = (await sigResponse.text()).trim();
      }
    } catch {
      // Signature fetch failed
    }

    if (!signature) {
      console.error("Update manifest rejected — no signature found but public key is configured");
      return null;
    }

    if (!verifyEd25519Signature(manifestText, signature, publicKey)) {
      console.error("Update manifest signature verification failed");
      return null;
    }

    const manifest = JSON.parse(manifestText) as UpdateManifest;
    return manifest;
  } catch (err: any) {
    return null;
  }
}

// ─── Update Check ────────────────────────────────────────────────────

/**
 * Get the current Quiver version from package.json.
 */
export function getCurrentVersion(): string {
  try {
    const pkgPath = path.resolve(
      import.meta.dirname ?? ".",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Check for updates. This is a non-blocking operation that fetches the
 * update manifest and compares versions.
 *
 * @returns Update check result with download info if an update is available
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();

  const manifest = await fetchUpdateManifest();
  if (!manifest) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      error: "Could not fetch update manifest",
    };
  }

  const latestVersion = manifest.version;
  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

  if (!updateAvailable) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion,
    };
  }

  // Get platform-specific download info
  const platform = process.platform as "darwin" | "linux" | "win32";
  const platformInfo = manifest.platforms[platform];
  if (!platformInfo) {
    return {
      updateAvailable: true,
      currentVersion,
      latestVersion,
      releaseNotes: manifest.notes,
      error: `No update available for platform ${platform}`,
    };
  }

  return {
    updateAvailable: true,
    currentVersion,
    latestVersion,
    releaseNotes: manifest.notes,
    downloadUrl: platformInfo.url,
    sha256: platformInfo.sha256,
    signature: platformInfo.signature,
  };
}

/**
 * Format an update notification for display to the user.
 * Returns null if no update is available.
 */
export function formatUpdateNotification(
  result: UpdateCheckResult,
): string | null {
  if (!result.updateAvailable) return null;

  const lines = [
    `  ┌─ Update available: v${result.latestVersion} (current: v${result.currentVersion})`,
  ];
  if (result.releaseNotes) {
    // Truncate release notes to first 3 lines
    const notes = result.releaseNotes.split("\n").slice(0, 3).join("\n");
    lines.push(`  │ ${notes}`);
  }
  if (result.downloadUrl) {
    lines.push(`  │ Download: ${result.downloadUrl}`);
  }
  lines.push("  └─ Run `quiver --update` to install");
  return lines.join("\n");
}

/**
 * Perform a non-blocking update check at startup.
 * If an update is available, prints a notification.
 * Never throws — update check failures are silently ignored.
 */
export async function silentUpdateCheck(): Promise<void> {
  try {
    // Only check once per day (cache in ~/.quiver/update-check.json)
    const cachePath = path.join(os.homedir(), ".quiver", "update-check.json");
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const lastCheck = new Date(cache.lastCheck);
      const hoursSince = (Date.now() - lastCheck.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) return; // Checked recently
    } catch {
      // No cache or invalid — proceed with check
    }

    const result = await checkForUpdates();

    // Update cache
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          lastCheck: new Date().toISOString(),
          latestVersion: result.latestVersion,
          updateAvailable: result.updateAvailable,
        }),
        { mode: 0o600 },
      );
    } catch {
      // Best-effort cache
    }

    if (result.updateAvailable) {
      const notification = formatUpdateNotification(result);
      if (notification) {
        console.log(notification);
      }
    }
  } catch {
    // Silent failure — never interrupt the user's session for an update check
  }
}
