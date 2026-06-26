/**
 * Google Drive sync for Quiver — OAuth 2.0 + file upload/download.
 *
 * Flow:
 *   1. `quiver gdrive-auth` — starts local HTTP callback server, opens browser
 *      to Google consent screen, exchanges auth code for tokens, saves
 *      refresh token to .gdrive-token.json
 *   2. `quiver gdrive-sync` — uploads memory/ and .sessions/ to a Drive folder
 *      called "Quiver", downloads remote files that are newer
 *
 * Config (.env):
 *   GDRIVE_CLIENT_ID     — OAuth client ID from Google Cloud Console
 *   GDRIVE_CLIENT_SECRET — OAuth client secret
 *   GDRIVE_FOLDER_NAME   — Drive folder name (default: "Quiver")
 *
 * The redirect URI is http://localhost:30034/callback (fixed port).
 * User must add this to "Authorized redirect URIs" in Google Cloud Console.
 */

import { google } from "googleapis";
import { createServer, type Server } from "http";
import { URL } from "url";
import { promises as fs } from "fs";
import * as path from "path";
import { createReadStream, createWriteStream, existsSync } from "fs";
import { config } from "./config.js";

const REDIRECT_PORT = 30034;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata",
];
const TOKEN_FILE = path.resolve(".gdrive-token.json");
const DRIVE_FOLDER_NAME = config.gdriveFolderName || "Quiver";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// ─── Token management ────────────────────────────────────────────────

interface StoredToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope: string;
  token_type: string;
}

export function hasStoredToken(): boolean {
  return existsSync(TOKEN_FILE);
}

async function loadStoredToken(): Promise<StoredToken | null> {
  try {
    const content = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(content) as StoredToken;
  } catch {
    return null;
  }
}

async function saveStoredToken(token: StoredToken): Promise<void> {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), "utf8");
}

export function isGdriveConfigured(): boolean {
  return (
    config.gdriveClientId.length > 0 && config.gdriveClientSecret.length > 0
  );
}

// ─── OAuth client ────────────────────────────────────────────────────

function createOAuth2Client(): OAuth2Client {
  if (!isGdriveConfigured()) {
    throw new Error(
      "Google Drive not configured. Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env. " +
        "See: https://developers.google.com/drive/api/quickstart/nodejs",
    );
  }

  return new google.auth.OAuth2(
    config.gdriveClientId,
    config.gdriveClientSecret,
    REDIRECT_URI,
  );
}

/**
 * Get an authenticated OAuth2 client with a valid access token.
 * Refreshes the token automatically if expired.
 */
export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  const token = await loadStoredToken();
  if (!token) {
    throw new Error(
      "Not authenticated with Google Drive. Run 'quiver gdrive-auth' first.",
    );
  }

  const client = createOAuth2Client();
  client.setCredentials(token);

  // Auto-refresh if expired
  if (token.expiry_date && token.expiry_date <= Date.now() + 60000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      const newToken: StoredToken = {
        access_token: credentials.access_token!,
        refresh_token: credentials.refresh_token || token.refresh_token,
        expiry_date: credentials.expiry_date!,
        scope: credentials.scope || token.scope,
        token_type: credentials.token_type || "Bearer",
      };
      await saveStoredToken(newToken);
      client.setCredentials(newToken);
    } catch (err: any) {
      throw new Error(
        `Failed to refresh Google Drive token: ${err.message}. Run 'quiver gdrive-auth' to re-authenticate.`,
      );
    }
  }

  return client;
}

// ─── OAuth flow ──────────────────────────────────────────────────────

/**
 * Run the full OAuth 2.0 authorization code flow:
 * 1. Start a local HTTP server on REDIRECT_PORT
 * 2. Generate the consent URL and open it in the browser
 * 3. Wait for the callback with the auth code
 * 4. Exchange the code for access + refresh tokens
 * 5. Save tokens to .gdrive-token.json
 */
export async function runOAuthFlow(): Promise<void> {
  if (!isGdriveConfigured()) {
    throw new Error(
      "Google Drive not configured.\n" +
        "  1. Go to https://console.cloud.google.com/apis/credentials\n" +
        "  2. Create an OAuth 2.0 Client ID (type: Web application)\n" +
        `  3. Add redirect URI: ${REDIRECT_URI}\n` +
        "  4. Enable Google Drive API\n" +
        "  5. Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in .env\n" +
        "  6. Run 'quiver gdrive-auth' again",
    );
  }

  const client = createOAuth2Client();

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force consent to always get a refresh token
  });

  // Start local callback server
  const codePromise = waitForAuthCallback(REDIRECT_PORT);

  // Open browser
  console.log(`\n  Opening browser for Google sign-in...`);
  console.log(`  If it doesn't open, visit:\n  ${authUrl}\n`);

  try {
    const { exec } = await import("child_process");
    const open =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${open} "${authUrl}"`);
  } catch {
    // Browser didn't open — user can copy the URL manually
  }

  // Wait for the callback
  const code = await codePromise;
  if (!code) {
    throw new Error("OAuth flow failed — no auth code received.");
  }

  // Exchange code for tokens
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. " +
        "Revoke access at https://myaccount.google.com/permissions and try again.",
    );
  }

  const stored: StoredToken = {
    access_token: tokens.access_token!,
    refresh_token: tokens.refresh_token!,
    expiry_date: tokens.expiry_date!,
    scope: tokens.scope!,
    token_type: tokens.token_type || "Bearer",
  };

  await saveStoredToken(stored);
  console.log("  ✅ Google Drive authentication successful!");
  console.log(`  Token saved to ${path.basename(TOKEN_FILE)}`);
  console.log(`  You can now run 'quiver gdrive-sync' to sync your data.\n`);
}

/**
 * Start a local HTTP server and wait for the OAuth callback.
 * Returns the authorization code, or null on error/timeout.
 */
function waitForAuthCallback(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    let server: Server;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          server.close();
        } catch {
          // ignore
        }
        resolve(null);
      }
    }, 120000); // 2 minute timeout

    server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (code && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>✅ Authorization successful!</h2>" +
            "<p>You can close this tab and return to Quiver.</p></body></html>",
        );
        try {
          server.close();
        } catch {
          // ignore
        }
        resolve(code);
      } else if (error && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>❌ Authorization failed: ${error}</h2></body></html>`,
        );
        try {
          server.close();
        } catch {
          // ignore
        }
        resolve(null);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, () => {
      console.log(`  Listening for OAuth callback on port ${port}…`);
    });

    server.on("error", (err: any) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
        console.error(`  OAuth callback server error: ${err.message}`);
      }
    });
  });
}

// ─── Drive operations ────────────────────────────────────────────────

/**
 * Find or create the Quiver folder in Google Drive.
 * Returns the folder ID.
 */
async function ensureQuiverFolder(client: OAuth2Client): Promise<string> {
  const drive = google.drive({ version: "v3", auth: client });

  // Search for existing folder
  const res = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }

  // Create the folder
  const created = await drive.files.create({
    requestBody: {
      name: DRIVE_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  return created.data.id!;
}

/**
 * List all files in the Quiver Drive folder.
 */
async function listRemoteFiles(
  client: OAuth2Client,
  folderId: string,
): Promise<Map<string, { id: string; modifiedTime: string; size: string }>> {
  const drive = google.drive({ version: "v3", auth: client });
  const result = new Map<
    string,
    { id: string; modifiedTime: string; size: string }
  >();

  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name, modifiedTime, size)",
      pageToken,
      pageSize: 100,
    });

    for (const file of res.data.files || []) {
      if (file.name && file.id) {
        result.set(file.name, {
          id: file.id,
          modifiedTime: file.modifiedTime || "",
          size: file.size || "0",
        });
      }
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return result;
}

/**
 * Upload a single file to the Drive folder. If a file with the same name
 * exists, it will be updated (new revision).
 */
async function uploadFile(
  client: OAuth2Client,
  folderId: string,
  localPath: string,
  fileName: string,
): Promise<void> {
  const drive = google.drive({ version: "v3", auth: client });

  // Check if file already exists
  const existing = await drive.files.list({
    q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });

  const fileId = existing.data.files?.[0]?.id;

  if (fileId) {
    // Update existing file
    await drive.files.update({
      fileId,
      media: {
        body: createReadStream(localPath),
      },
    });
  } else {
    // Create new file
    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        body: createReadStream(localPath),
      },
    });
  }
}

/**
 * Download a file from Drive to a local path.
 */
async function downloadFile(
  client: OAuth2Client,
  fileId: string,
  localPath: string,
): Promise<void> {
  const drive = google.drive({ version: "v3", auth: client });
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );

  return new Promise((resolve, reject) => {
    const dest = createWriteStream(localPath);
    res.data.on("error", reject);
    dest.on("error", reject);
    dest.on("finish", resolve);
    res.data.pipe(dest);
  });
}

// ─── Sync logic ──────────────────────────────────────────────────────

interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  errors: { file: string; error: string }[];
}

/**
 * Collect all files from a local directory (non-recursive for now).
 */
async function listLocalFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        files.push(entry);
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Sync memory/ and .sessions/ to Google Drive.
 * Uploads local files, downloads remote files that don't exist locally.
 */
export async function syncToGdrive(): Promise<SyncResult> {
  const client = await getAuthenticatedClient();
  const folderId = await ensureQuiverFolder(client);

  const result: SyncResult = {
    uploaded: [],
    downloaded: [],
    errors: [],
  };

  // Directories to sync
  const dirs = [
    { local: path.resolve(config.memoryDir), prefix: "memory" },
    { local: path.resolve(".sessions"), prefix: "sessions" },
  ];

  for (const dir of dirs) {
    const localFiles = await listLocalFiles(dir.local);

    for (const fileName of localFiles) {
      const localPath = path.join(dir.local, fileName);
      const remoteName = `${dir.prefix}/${fileName}`;

      try {
        await uploadFile(client, folderId, localPath, remoteName);
        result.uploaded.push(remoteName);
      } catch (err: any) {
        result.errors.push({
          file: remoteName,
          error: err.message,
        });
      }
    }
  }

  // Download remote files that don't exist locally
  const remoteFiles = await listRemoteFiles(client, folderId);

  for (const [remoteName, meta] of remoteFiles) {
    // Parse prefix/filename
    const slashIdx = remoteName.indexOf("/");
    if (slashIdx === -1) continue;
    const prefix = remoteName.substring(0, slashIdx);
    const fileName = remoteName.substring(slashIdx + 1);

    const dirEntry = dirs.find((d) => d.prefix === prefix);
    if (!dirEntry) continue;

    const localPath = path.join(dirEntry.local, fileName);

    if (!existsSync(localPath)) {
      try {
        await fs.mkdir(dirEntry.local, { recursive: true });
        await downloadFile(client, meta.id, localPath);
        result.downloaded.push(remoteName);
      } catch (err: any) {
        result.errors.push({
          file: remoteName,
          error: err.message,
        });
      }
    }
  }

  return result;
}

/**
 * Get the Google Drive auth status for display.
 */
export function getGdriveStatus(): {
  configured: boolean;
  authenticated: boolean;
  folderName: string;
} {
  return {
    configured: isGdriveConfigured(),
    authenticated: hasStoredToken(),
    folderName: DRIVE_FOLDER_NAME,
  };
}
