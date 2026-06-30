import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { config } from "./config.js";
import { findBinary } from "./utils/find_binary.js";

export interface OllamaIdentity {
  /** true if the `ollama` binary is installed on this machine */
  hasBinary: boolean;
  /** path to the ollama binary, if found */
  binaryPath: string | null;
  /** true if the user has run `ollama signin` (Ed25519 keypair exists) */
  hasSignedIn: boolean;
  /** the public key fingerprint, if available */
  publicKeyFingerprint: string | null;
  /** true if OLLAMA_API_KEY env var is set for programmatic access */
  hasApiKey: boolean;
  /** ollama.com username if we can determine it (currently not exposed by API) */
  username: string | null;
  /** the ~/.ollama directory path */
  ollamaDir: string;
}

/**
 * Locate the ollama binary on the system.
 * Checks common locations and PATH.
 */
function findOllamaBinary(): string | null {
  const candidates: string[] = [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    "/usr/bin/ollama",
    path.join(os.homedir(), ".local", "bin", "ollama"),
  ];

  // macOS app bundle
  if (process.platform === "darwin") {
    candidates.push("/Applications/Ollama.app/Contents/Resources/ollama");
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // Try PATH lookup (cross-platform via findBinary)
  const found = findBinary("ollama");
  if (found && existsSync(found)) return found;

  return null;
}

/**
 * Read the Ed25519 public key and return a short fingerprint.
 */
function readPublicKeyFingerprint(ollamaDir: string): string | null {
  const pubKeyPath = path.join(ollamaDir, "id_ed25519.pub");
  if (!existsSync(pubKeyPath)) return null;

  try {
    const content = readFileSync(pubKeyPath, "utf8").trim();
    // The key file is an SSH-style public key. Create a short fingerprint.
    // Format: "ssh-ed25519 AAAAC3Nz..." — take last 8 chars of the base64 part.
    const parts = content.split(/\s+/);
    if (parts.length >= 2) {
      const b64 = parts[1];
      return b64.slice(-8);
    }
    return content.slice(-8);
  } catch {
    return null;
  }
}

/**
 * Detect the user's Ollama identity status.
 *
 * Ollama uses two auth mechanisms:
 * 1. `ollama signin` — interactive browser-based OAuth that stores an
 *    Ed25519 keypair in ~/.ollama/. The local daemon then auto-authenticates
 *    requests to ollama.com (cloud models, web search, etc.)
 * 2. `OLLAMA_API_KEY` — a bearer token for direct programmatic API access
 *    to ollama.com/api/*
 *
 * Quiver can use either or both. This function detects what's available.
 */
export function detectOllamaIdentity(): OllamaIdentity {
  const ollamaDir = path.join(os.homedir(), ".ollama");
  const binaryPath = findOllamaBinary();
  const hasBinary = binaryPath !== null;

  const privKeyPath = path.join(ollamaDir, "id_ed25519");
  const hasSignedIn = existsSync(privKeyPath);

  const publicKeyFingerprint = hasSignedIn
    ? readPublicKeyFingerprint(ollamaDir)
    : null;

  const hasApiKey = config.ollamaApiKey.length > 0;

  return {
    hasBinary,
    binaryPath,
    hasSignedIn,
    publicKeyFingerprint,
    hasApiKey,
    username: null, // Ollama doesn't expose username via local API
    ollamaDir,
  };
}

/**
 * Initiate `ollama signin` — opens a browser for the user to authenticate.
 * Returns true if the command was launched, false if ollama binary is missing.
 */
export function startOllamaSignin(binaryPath: string): boolean {
  try {
    execFileSync(binaryPath, ["signin"], {
      stdio: "inherit",
      timeout: 120000, // 2 minutes for browser flow
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Human-readable summary of the Ollama identity for display.
 */
export function formatOllamaIdentity(id: OllamaIdentity): string {
  if (!id.hasBinary && !id.hasApiKey) {
    return "Not configured";
  }

  const parts: string[] = [];

  if (id.hasSignedIn) {
    const fp = id.publicKeyFingerprint
      ? ` (key: …${id.publicKeyFingerprint})`
      : "";
    parts.push(`Signed in${fp}`);
  }

  if (id.hasApiKey) {
    parts.push("API key set");
  }

  if (id.hasBinary && !id.hasSignedIn && !id.hasApiKey) {
    parts.push("Binary installed (not signed in)");
  }

  return parts.join(" · ") || "Binary installed (not signed in)";
}
