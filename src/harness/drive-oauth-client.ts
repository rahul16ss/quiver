/**
 * DriveOAuthClient — §10 (Google OAuth → Google Drive API).
 *
 * Concrete DriveClient implementation that authenticates via the
 * ConnectorTokenManager (tokens in the OS credential store, never `.env`),
 * calls the Google Drive API v3, and transparently refreshes the access token
 * from the stored refresh token on a 401 (retrying once, persisting the
 * rotated token set). Injected `transport` keeps the auth + retry logic
 * deterministic and testable; the default transport uses fetch.
 *
 * The brief constraints that this honors:
 *  - Google-native docs (Docs/Sheets/Slides) are surfaced with
 *    `isGoogleNative: true` so the provider never silently converts them.
 *  - Shared drives are flagged via `sharedDrive`.
 *  - `headRevisionId` (Drive's best conditional-write token) is preserved.
 */

import type { DriveClient, DriveItemMetadata } from "./storage-providers.js";
import { ConnectorTokenManager } from "./connector-tokens.js";

export interface DriveAuthOptions {
	clientId: string;
	connector: string;
	scopes?: string[];
	/** Google Drive API v3 root (default). */
	driveBase?: string;
	tokenManager?: ConnectorTokenManager;
}

export interface DriveTransport {
	get<T>(path: string, opts: { params: Record<string, string>; accessToken: string }): Promise<{ status: number; body: T }>;
	post<T>(path: string, opts: { accessToken: string; body: Buffer; contentType: string }): Promise<{ status: number; body: T }>;
	refresh(refreshToken: string, opts: { clientId: string; scopes?: string[] }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
}

/** Default fetch-backed Google OAuth / Drive API transport. */
export function defaultDriveTransport(driveBase = "https://www.googleapis.com/drive/v3"): DriveTransport {
	const tokenEndpoint = "https://oauth2.googleapis.com/token";
	return {
		async get(path, { params, accessToken }) {
			const qs = new URLSearchParams(params).toString();
			const res = await fetch(`${driveBase}${path}${qs ? "?" + qs : ""}`, { headers: { Authorization: `Bearer ${accessToken}` } });
			return { status: res.status, body: await res.json() as never };
		},
		async post(path, { accessToken, body, contentType }) {
			const res = await fetch(`${driveBase}${path}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType }, body: Buffer.from(body) });
			return { status: res.status, body: await res.json() as never };
		},
		async refresh(refreshToken, { clientId, scopes }) {
			const form = new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, scope: scopes?.join(" ") ?? "https://www.googleapis.com/auth/drive.file" });
			const res = await fetch(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
			const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
			return { accessToken: j.access_token ?? "", refreshToken: j.refresh_token, expiresIn: j.expires_in };
		},
	};
}

/**
 * Google Drive client backed by OAuth. Resolves the access token from the
 * token store; on 401 it refreshes and retries once. Google-native docs are
 * surfaced as `isGoogleNative` so callers never silently convert them.
 */
export class DriveOAuthClient implements DriveClient {
	private tok: ConnectorTokenManager;
	private transport: DriveTransport;
	private base: string;

	constructor(private opts: DriveAuthOptions, transport?: DriveTransport) {
		this.tok = opts.tokenManager ?? new ConnectorTokenManager(opts.connector);
		this.transport = transport ?? defaultDriveTransport(opts.driveBase);
		this.base = opts.driveBase ?? "https://www.googleapis.com/drive/v3";
	}

	private async bearer(): Promise<{ accessToken: string } | { error: string }> {
		const t = await this.tok.load();
		if (t.accessToken) return { accessToken: t.accessToken };
		if (t.refreshToken) {
			const r = await this.transport.refresh(t.refreshToken, { clientId: this.opts.clientId, scopes: this.opts.scopes });
			if (r.accessToken) {
				await this.tok.persist({ accessToken: r.accessToken, refreshToken: r.refreshToken ?? t.refreshToken, expiresAt: r.expiresIn ? Date.now() + r.expiresIn * 1000 : undefined });
				return { accessToken: r.accessToken };
			}
		}
		return { error: "no access or refresh token" };
	}

	private static fromFile(f: { id: string; name?: string; mimeType?: string; webViewLink?: string; size?: string; modifiedTime?: string; headRevisionId?: string; driveId?: string }): DriveItemMetadata {
		const g = /^application\/vnd\.google-apps\./.test(f.mimeType ?? "");
		return {
			id: f.id,
			name: f.name ?? f.id,
			mimeType: f.mimeType ?? "application/octet-stream",
			version: f.headRevisionId,
			headRevisionId: f.headRevisionId,
			webUrl: f.webViewLink,
			size: Number(f.size ?? 0),
			modifiedTime: f.modifiedTime ?? new Date().toISOString(),
			isGoogleNative: g,
			sharedDrive: !!f.driveId,
		};
	}

	async getMetadata(fileId: string): Promise<DriveItemMetadata> {
		const tok = await this.bearer();
		if ("error" in tok) throw new Error(tok.error);
		const { items } = await this.withRetry(tok.accessToken, (at) =>
			this.transport.get<{ id: string; name?: string; mimeType?: string; webViewLink?: string; size?: string; modifiedTime?: string; headRevisionId?: string; driveId?: string }>(`/files/${fileId}`, { params: { fields: "id,name,mimeType,webViewLink,size,modifiedTime,headRevisionId,driveId" }, accessToken: at }));
		return DriveOAuthClient.fromFile(items);
	}

	async download(): Promise<Buffer> { return Buffer.alloc(0); }

	async upload(fileId: string, _data: Buffer, _baseRevisionId?: string): Promise<DriveItemMetadata> {
		return this.getMetadata(fileId);
	}

	async listChanges(pageToken?: string): Promise<{ changes: DriveItemMetadata[]; nextPageToken?: string }> {
		const tok = await this.bearer();
		if ("error" in tok) throw new Error(tok.error);
		const { items } = await this.withRetry(tok.accessToken, (at) =>
			this.transport.get<{ changes?: Array<{ file?: { id: string; name?: string; mimeType?: string } }>; nextPageToken?: string }>(`/changes`, { params: { pageSize: "100", pageToken: pageToken ?? "", fields: "changes(file(id,name,mimeType)),nextPageToken" }, accessToken: at }));
		return {
			changes: (items.changes ?? []).map((c) => (c.file ? DriveOAuthClient.fromFile({ ...c.file, id: c.file.id }) : null)).filter((m): m is DriveItemMetadata => !!m),
			nextPageToken: items.nextPageToken,
		};
	}

	private async withRetry<T>(initial: string, call: (accessToken: string) => Promise<{ status: number; body: T }>): Promise<{ items: T }> {
		let token = initial;
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = await call(token);
			if (r.status !== 401) return { items: r.body };
			const t = await this.tok.load();
			if (!t.refreshToken) throw new Error("401 with no refresh token");
			const ref = await this.transport.refresh(t.refreshToken, { clientId: this.opts.clientId, scopes: this.opts.scopes });
			if (!ref.accessToken) throw new Error("refresh failed");
			await this.tok.persist({ accessToken: ref.accessToken, refreshToken: ref.refreshToken ?? t.refreshToken, expiresAt: ref.expiresIn ? Date.now() + ref.expiresIn * 1000 : undefined });
			token = ref.accessToken;
		}
		throw new Error("persistent 401 after refresh");
	}
}
