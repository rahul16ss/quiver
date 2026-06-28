/**
 * Secret Detection & Redaction — US-9.3
 *
 * Detects common secret formats and redacts them from logs, diagnostics,
 * session history, and tool output before writing to disk or sending to
 * remote providers.
 *
 * This is the canonical standalone module. src/session_logger.ts re-exports
 * from here for backward compatibility.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface DetectedSecret {
  type: string;
  match: string;
  index: number;
}

// ─── Secret Patterns ─────────────────────────────────────────────────

interface SecretPattern {
  type: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "env_secret",
    pattern:
      /^(LLM_API_KEY|PARALLEL_API_KEY|OLLAMA_API_KEY|GITHUB_TOKEN|CONTEXT7_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY)\s*=\s*.+$/gim,
  },
  {
    type: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9_\-\.]+/gi,
  },
  {
    type: "github_token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/gi,
  },
  {
    type: "openrouter_key",
    pattern: /sk-or-v1-[A-Za-z0-9]+/gi,
  },
  {
    type: "openai_key",
    pattern: /sk-[A-Za-z0-9]{20,}/gi,
  },
  {
    type: "ollama_key",
    pattern: /[a-f0-9]{32}\.[A-Za-z0-9_\-]+/gi,
  },
  {
    type: "parallel_key",
    pattern: /[A-Za-z0-9]{8}-[A-Za-z0-9_\-]{20,}/gi,
  },
  {
    type: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    type: "aws_secret_key",
    pattern: /aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}/gi,
  },
  {
    type: "private_key_block",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gi,
  },
  {
    type: "generic_long_key",
    pattern: /(?=[A-Za-z0-9_\-]{40,})(?=.*[a-zA-Z])(?=.*\d)[A-Za-z0-9_\-]{40,}/g,
  },
];

const REDACTED = "[REDACTED_SECRET]";

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Detect all secrets in a text string.
 * Returns an array of detected secrets with their type, match, and position.
 */
export function detectSecrets(text: string): DetectedSecret[] {
  const results: DetectedSecret[] = [];

  for (const { type, pattern } of SECRET_PATTERNS) {
    // Reset lastIndex for reused regex
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      results.push({
        type,
        match: match[0],
        index: match.index,
      });
      // Prevent infinite loop on zero-length matches
      if (match.index === pattern.lastIndex) {
        pattern.lastIndex++;
      }
    }
  }

  return results;
}

/**
 * Redact all secrets from a text string.
 * Replaces detected secrets with [REDACTED_SECRET].
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/**
 * Check if a text contains secrets and warn before sending to a remote provider.
 *
 * @param text - The text to check
 * @param isRemote - Whether the destination is a remote provider
 * @returns Warning message if secrets detected and isRemote, null otherwise
 */
export function warnIfRemote(text: string, isRemote: boolean): string | null {
  if (!isRemote) return null;

  const secrets = detectSecrets(text);
  if (secrets.length === 0) return null;

  const types = [...new Set(secrets.map((s) => s.type))];
  return (
    `Warning: ${secrets.length} potential secret(s) detected ` +
    `(${types.join(", ")}). These will be sent to a remote provider. ` +
    `Review the content before proceeding.`
  );
}

/**
 * Check if a text contains secrets (boolean check).
 */
export function hasSecrets(text: string): boolean {
  return detectSecrets(text).length > 0;
}

/**
 * Redact secrets from an object's string values (deep).
 */
export function redactSecretsDeep(obj: any): any {
  if (typeof obj === "string") {
    return redactSecrets(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(redactSecretsDeep);
  }
  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = redactSecretsDeep(obj[key]);
    }
    return result;
  }
  return obj;
}