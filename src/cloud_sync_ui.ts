import picocolors from "picocolors";
import { theme } from "./cli_ui.js";
import {
  syncToCloud,
  getCloudSyncStatus,
  CLOUD_APP_LINKS,
} from "./cloud_sync.js";

export async function runCloudSync(): Promise<void> {
  const t = theme();

  const status = getCloudSyncStatus();

  console.log(
    t.cyan(`
  ┌────────────────────────────────────────────┐
  │  ☁️  Cloud Sync                             │
  └────────────────────────────────────────────┘`),
  );

  if (status.active) {
    console.log(picocolors.green(`\n  ✅ Detected: ${status.provider}`));
    console.log(picocolors.gray(`  Quiver folder: ${status.path}`));
    console.log(
      picocolors.gray(
        `  Auto-sync runs silently after every turn — no action needed.\n`,
      ),
    );
  } else {
    console.log(picocolors.yellow(`\n  ⚠️  No cloud sync folder detected.`));
    console.log(
      picocolors.gray(
        `\n  Quiver is saving data locally at:\n    ${status.path}`,
      ),
    );
    console.log(
      picocolors.gray(
        `\n  To sync across machines, install any cloud sync app:\n`,
      ),
    );
    for (const app of CLOUD_APP_LINKS) {
      console.log(picocolors.gray(`    • ${app.name}`));
      console.log(picocolors.blue(`      ${app.url}`));
    }
    console.log(
      picocolors.gray(
        `\n  Or set QUIVER_CLOUD_SYNC_PATH in .env to any synced folder.\n`,
      ),
    );
  }

  console.log(picocolors.gray(`\n  Syncing memory/ and .sessions/ now…\n`));

  try {
    const result = await syncToCloud();

    if (result.uploaded.length > 0) {
      console.log(
        picocolors.green(`  ✅ Uploaded (${result.uploaded.length}):`),
      );
      for (const f of result.uploaded) {
        console.log(picocolors.gray(`     ↑ ${f}`));
      }
    }

    if (result.downloaded.length > 0) {
      console.log(
        picocolors.green(`\n  ✅ Downloaded (${result.downloaded.length}):`),
      );
      for (const f of result.downloaded) {
        console.log(picocolors.gray(`     ↓ ${f}`));
      }
    }

    if (result.errors.length > 0) {
      console.log(
        picocolors.yellow(`\n  ⚠️  Errors (${result.errors.length}):`),
      );
      for (const e of result.errors) {
        console.log(picocolors.red(`     ✗ ${e.file}: ${e.error}`));
      }
    }

    if (result.uploaded.length === 0 && result.downloaded.length === 0) {
      console.log(picocolors.gray(`  Everything is already in sync.\n`));
    } else {
      console.log(
        picocolors.green(
          `\n  Sync complete: ${result.uploaded.length} uploaded, ${result.downloaded.length} downloaded.\n`,
        ),
      );
    }
  } catch (err: any) {
    console.log(picocolors.red(`\n  ❌ Sync failed: ${err.message}\n`));
  }
}
