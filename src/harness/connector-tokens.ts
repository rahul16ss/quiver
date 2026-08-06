/**
 * ConnectorTokenManager — §10 / §7 (OAuth token storage for storage connectors).
 *
 * The brief mandates OAuth refresh tokens live in the OS credential store, not
 * `.env`. This provides a durable token store seam (keychain-backed by default)
 * and a per-connector manager that persists access + refresh tokens keychain-
 * first and resolves them, so a Graph/Drive connector is never configured via a
 * plaintext `.env` secret.
 *
 * A `TokenStore` is injectable so tests use an in-memory seam (no real keychain
 * dependency) while production uses the keychain-backed default. resolve() is
 * used by an OAuth client to obtain a token to attach to a request.
 */

import { getCredential, setCredential, deleteCredential } from "../secrets/keychain.js";

/** Durable token/secret store seam (OS credential store in production). */
export interface TokenStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<boolean>;
	delete(key: string): Promise<void>;
}

/** In-memory store for tests/ambient use (not durable across process). */
export class InMemoryTokenStore implements TokenStore {
	private m = new Map<string, string>();
	async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
	async set(k: string, v: string): Promise<boolean> { this.m.set(k, v); return true; }
	async delete(k: string): Promise<void> { this.m.delete(k); }
}

/**
 * OS credential-store-backed token store — refresh/access tokens live in the
 * keychain (macOS Keychain / Windows Credential Manager / Linux Secret
 * Service), never `.env`. Wraps the existing keychain module under the seam.
 */
export class KeychainTokenStore implements TokenStore {
	constructor(private prefix = "quiver:connector:") {}
	private key(name: string): string { return this.prefix + name; }
	async get(name: string): Promise<string | null> { return getCredential(this.key(name)); }
	async set(name: string, value: string): Promise<boolean> { return setCredential(this.key(name), value); }
	async delete(name: string): Promise<void> { return deleteCredential(this.key(name)); }
}

/** Per-connector OAuth token holder (access + refresh) resolved keychain-first. */
export interface ConnectorTokens {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
}

const ACCESS = "oauthtoken:access";
const REFRESH = "oauthtoken:refresh";
const EXPIRES = "oauthtoken:expires";

/**
 * Manages a single connector's OAuth tokens through a TokenStore. Never uses
 * `.env`; resolving reads the OS credential store (or the injected test seam).
 */
export class ConnectorTokenManager {
	constructor(
		private connector: string,
		private store: TokenStore = new KeychainTokenStore(),
	) {}

	private k(suffix: string): string { return `${this.connector}:${suffix}`; }

	/** Persist a full token set (access + refresh + expiry) for the connector. */
	async persist(tokens: ConnectorTokens): Promise<void> {
		if (tokens.accessToken) await this.store.set(this.k(ACCESS), tokens.accessToken);
		if (tokens.refreshToken) await this.store.set(this.k(REFRESH), tokens.refreshToken);
		if (tokens.expiresAt !== undefined) await this.store.set(this.k(EXPIRES), String(tokens.expiresAt));
	}

	/** Load the stored token set (or empty if none / expired). */
	async load(): Promise<ConnectorTokens> {
		const accessToken = (await this.store.get(this.k(ACCESS))) ?? undefined;
		const refreshToken = (await this.store.get(this.k(REFRESH))) ?? undefined;
		const raw = await this.store.get(this.k(EXPIRES));
		const expiresAt = raw ? Number(raw) : undefined;
		// An access token that has expired is not usable — the caller must refresh.
		if (expiresAt !== undefined && Date.now() > expiresAt) {
			return { refreshToken };
		}
		return { accessToken, refreshToken, expiresAt };
	}

	/** True when a usable (non-expired) access token is stored. */
	async hasValidAccess(): Promise<boolean> {
		const t = await this.load();
		return !!t.accessToken;
	}

	/** Clear a connector's stored tokens (log-out / revocation). */
	async clear(): Promise<void> {
		await this.store.delete(this.k(ACCESS));
		await this.store.delete(this.k(REFRESH));
		await this.store.delete(this.k(EXPIRES));
	}
}
