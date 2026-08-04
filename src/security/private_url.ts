/**
 * SSRF private/internal URL guard — shared by scrape_url and browser_control.
 *
 * Fail-closed: malformed URLs, non-http(s) schemes, private hostnames,
 * IPv4-mapped IPv6, bracketed loopback, and DNS that resolves to private
 * addresses are all blocked. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.
 */
import * as dns from "dns/promises";
import * as net from "net";

function normalizeHostname(hostname: string): string {
  // URL.hostname for IPv6 may include brackets: [::1]
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1).toLowerCase();
  }
  return hostname.toLowerCase();
}

/** Extract IPv4 from ::ffff:x.x.x.x (with or without leading zeros forms). */
function ipv4FromMapped(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m) return m[1];
  // Hex form ::ffff:7f00:1 → 127.0.0.1
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateIpAddress(ip: string): boolean {
  const raw = normalizeHostname(ip);
  if (!raw) return true;

  if (raw === "::1" || raw === "0:0:0:0:0:0:0:1") return true;

  const mapped = ipv4FromMapped(raw);
  const v4 = mapped || (net.isIP(raw) === 4 ? raw : null);
  if (v4) {
    if (
      v4 === "0.0.0.0" ||
      v4.startsWith("127.") ||
      v4.startsWith("10.") ||
      v4.startsWith("192.168.") ||
      v4.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)
    ) {
      return true;
    }
    return false;
  }

  // IPv6 ULA fc00::/7 and link-local fe80::/10
  if (net.isIP(raw) === 6) {
    if (raw.startsWith("fc") || raw.startsWith("fd") || raw.startsWith("fe80:")) {
      return true;
    }
  }

  return false;
}

function hostnameLooksPrivate(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  // Literal IP in hostname
  if (net.isIP(host) || host.includes(":")) {
    return isPrivateIpAddress(host);
  }
  if (
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true when the URL must be blocked (private/internal/unsafe).
 * Resolves DNS when the hostname is not a literal IP so names like
 * localtest.me cannot bypass the gate.
 */
export async function isPrivateUrl(urlStr: string): Promise<boolean> {
  if (process.env.QUIVER_BLOCK_PRIVATE_IPS === "0") return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = normalizeHostname(parsed.hostname);
    if (!host) return true;
    if (hostnameLooksPrivate(host)) return true;

    // Literal public IP — already checked above via net.isIP path.
    if (net.isIP(host)) return false;

    // Resolve hostname and block if ANY address is private.
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      if (!records.length) return true; // fail closed: no resolution
      for (const rec of records) {
        if (isPrivateIpAddress(rec.address)) return true;
      }
      return false;
    } catch {
      // DNS failure → fail closed (do not fetch).
      return true;
    }
  } catch {
    // Malformed URL → fail closed.
    return true;
  }
}

const MAX_REDIRECTS = 5;

/**
 * fetch() that refuses private/internal URLs on the initial request and on
 * every redirect hop (Location). Default fetch follow would otherwise let a
 * public host 302 into loopback and bypass isPrivateUrl.
 */
export async function fetchPublicUrl(
  urlStr: string,
  init: RequestInit = {},
): Promise<Response> {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (await isPrivateUrl(current)) {
      throw new Error(
        `URL '${current}' points to a private/internal network address. Blocked for security.`,
      );
    }
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect from '${current}' missing Location header.`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) fetching '${urlStr}'.`);
}
