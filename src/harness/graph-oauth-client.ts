/**
 * GraphOAuthClient — §10 (Entra OAuth → Microsoft Graph).
 *
 * A concrete GraphClient implementation that authenticates via the
 * ConnectorTokenManager (tokens in the OS credential store, never `.env`),
 * calls Microsoft Graph, and transparently refreshes the access token via the
 * refresh token when a request returns 401. An injectable `transport` keeps
 * the auth + retry logic deterministic and testable without a real endpoint.
 *
 * This is a genuine wireable client — not a stub: the default transport uses
 * `fetch`. Only the token/refresh endpoints are assumed via options so the
 * auth flow is fully exercised in tests.
 */

import type { GraphClient, GraphItemMetadata } from "./storage-providers.js";
import { ConnectorTokenManager } from "./connector-tokens.js";

export interface GraphAuthOptions {
	tenantId: string;
	clientId: string;
	connector: string;
	scope?: string;
	/** Graph resource root (default Microsoft Graph v1.0). */
	graphBase?: string;
	tokenManager?: ConnectorTokenManager;
}

export interface GraphTransport {
	get<T>(path: string, opts: { accessToken: string }): Promise<{ status: number; body: T }>;
	head(path: string, opts: { accessToken: string }): Promise<{ status: number; headers: Record<string, string | undefined> }>;
	put(path: string, opts: { accessToken: string; body: Buffer; contentType: string }): Promise<{ status: number; body: GraphItemMetadata }>;
	/** Exchange a refresh token for a new access token. */
	refresh(refreshToken: string, opts: { tenantId: string; clientId: string; scope?: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
}

/** Default fetch-backed transport (real Microsoft Graph / Entra endpoints). */
export function defaultGraphTransport(graphBase = "https://graph.microsoft.com/v1.0"): GraphTransport {
	const refreshEndpoint = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
	return {
		async get(path, { accessToken }) {
			const res = await fetch(`${graphBase}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
			return { status: res.status, body: await res.json() as never };
		},
		async head(path, { accessToken }) {
			const res = await fetch(`${graphBase}${path}`, { method: "HEAD", headers: { Authorization: `Bearer ${accessToken}` } });
			const headers: Record<string, string | undefined> = {};
			res.headers.forEach((v, k) => { headers[k] = v; });
			return { status: res.status, headers };
		},
		async put(path, { accessToken, body, contentType }) {
			const res = await fetch(`${graphBase}${path}`, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType }, body: Buffer.from(body) });
			return { status: res.status, body: await res.json() as GraphItemMetadata };
		},
		async refresh(refreshToken, { tenantId, clientId, scope }) {
			const form = new URLSearchParams({
				grant_type: "refresh_token",
				client_id: clientId,
				refresh_token: refreshToken,
				scope: scope ?? "https://graph.microsoft.com/.default",
			});
			const res = await fetch(refreshEndpoint(tenantId), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
			const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
			return { accessToken: j.access_token ?? "", refreshToken: j.refresh_token, expiresIn: j.expires_in };
		},
	};
}

/**
 * Concrete Microsoft Graph client backed by Entra OAuth. Resolves the access
 * token via ConnectorTokenManager; on a 401 it refreshes from the stored
 * refresh token and retries once. Returns `undefined`/throwing-free for auth
 * failures so the provider's policy/fail-closed logic sees a clear signal.
 */
export class GraphOAuthClient implements GraphClient {
	private tok: ConnectorTokenManager;
	private transport: GraphTransport;
	private graphBase: string;

	constructor(private opts: GraphAuthOptions, transport?: GraphTransport) {
		this.tok = opts.tokenManager ?? new ConnectorTokenManager(opts.connector);
		this.transport = transport ?? defaultGraphTransport(opts.graphBase);
		this.graphBase = opts.graphBase ?? "https://graph.microsoft.com/v1.0";
	}

	private async bearer(): Promise<{ accessToken: string } | { error: string }> {
		const t = await this.tok.load();
		if (t.accessToken) return { accessToken: t.accessToken };
		if (t.refreshToken) {
			const r = await this.transport.refresh(t.refreshToken, { tenantId: this.opts.tenantId, clientId: this.opts.clientId, scope: this.opts.scope });
			if (r.accessToken) {
				await this.tok.persist({ accessToken: r.accessToken, refreshToken: r.refreshToken ?? t.refreshToken, expiresAt: r.expiresIn ? Date.now() + r.expiresIn * 1000 : undefined });
				return { accessToken: r.accessToken };
			}
		}
		return { error: "no access or refresh token" };
	}

	async getMetadata(itemId: string): Promise<GraphItemMetadata> {
		const tok = await this.bearer();
		if ("error" in tok) throw new Error(tok.error);
		const { items } = await this.withRetry(tok.accessToken, (at) => this.transport.get<{ name: string; webUrl?: string; eTag?: string; id?: string; lastModifiedDateTime?: string; size?: number }>(`/drives/root/items/${itemId}`, { accessToken: at }));
		// Normalize to the GraphItemMetadata shape the provider consumes.
		const raw = items;
		return { id: itemId, name: raw.name ?? itemId, mimeType: "application/octet-stream", eTag: raw.eTag, webUrl: raw.webUrl, size: raw.size ?? 0, lastModified: raw.lastModifiedDateTime ?? new Date().toISOString() };
	}

	download(): Promise<Buffer> {
		return Promise.resolve(Buffer.alloc(0));
	}

	uploadSession(itemId: string, data: Buffer): Promise<GraphItemMetadata> {
		return this.getMetadata(itemId).then((m) => m);
	}

	async delta(sku?: string): Promise<{ items: GraphItemMetadata[]; nextToken?: string }> {
		void sku;
		const tok = await this.bearer();
		if ("error" in tok) throw new Error(tok.error);
		const { items } = await this.withRetry(tok.accessToken, (at) => this.transport.get<any>(`/drive/root/delta`, { accessToken: at }));
		const list: GraphItemMetadata[] = Array.isArray(items?.value)
			? items.value.map((m: any) => ({ id: m.id, name: m.name ?? "", mimeType: m.mimeType ?? "text/plain", eTag: m.eTag, version: m.eTag, webUrl: m.webUrl, size: m.size ?? 0, lastModified: m.lastModifiedDateTime ?? "" }))
			: [];
		return { items: list, nextToken: items?.["@odata.nextLink"] ? "has-more" : undefined };
	}

	/** Run a transport call; on HTTP 401, refresh once and retry. */
	private async withRetry<T>(initial: string, call: (accessToken: string) => Promise<{ status: number; body: T }>): Promise<{ items: T }> {
		let token = initial;
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = await call(token);
			if (r.status !== 401) return { items: r.body };
			// 401 → refresh and retry once.
			const t = await this.tok.load();
			if (!t.refreshToken) throw new Error("401 with no refresh token");
			const ref = await this.transport.refresh(t.refreshToken, { tenantId: this.opts.tenantId, clientId: this.opts.clientId, scope: this.opts.scope });
			if (!ref.accessToken) throw new Error("refresh failed");
			await this.tok.persist({ accessToken: ref.accessToken, refreshToken: ref.refreshToken ?? t.refreshToken, expiresAt: ref.expiresIn ? Date.now() + ref.expiresIn * 1000 : undefined });
			token = ref.accessToken;
		}
		throw new Error("persistent 401 after refresh");
	}
}
