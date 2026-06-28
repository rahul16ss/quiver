import picocolors from "picocolors";
import * as path from "path";
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
        `  Sync is opt-in and encrypted (AES-256-GCM). Raw logs, screenshots,\n  tool binaries, and credentials are never synced.\n`,
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

  console.log(picocolors.gray(`\n  Syncing inspectable memory (encrypted, opt-in)…\n`));

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

    if (result.conflicts && result.conflicts.length > 0) {
      console.log(picolorempty());
      console.log(picocolors.yellow(`  ⚠️  Conflicts (${result.conflicts.length}) — both versions preserved:`));
      for (const c of result.conflicts) console.log(picocolors.gray(`     • ${c}`));
      console.log(picocolors.gray(`     Resolve with: keep_local / keep_cloud / keep_both\n`));
    }

    if (result.uploaded.length === 0 && result.downloaded.length === 0 && !(result.conflicts && result.conflicts.length)) {
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

/**
 * Consent-gated cleanup of leaked plaintext artifacts (US-4.4 P0).
 * Enumerates leaked files in the cloud Quiver folder, shows the list, and
 * deletes ONLY after an explicit y/N confirmation. Every removal is logged to
 * the tamper-evident audit chain. Never automatic.
 */
export async function runCleanupLeaks(rl?: import("readline").Interface): Promise<void> {
  const t = theme();
  const { enumerateLeakedArtifacts, cleanupLeakedArtifacts, detectCloudFolder } = await import("./cloud_sync.js");

  console.log(
    t.cyan(`
  ┌────────────────────────────────────────────┐
  │  🧹  Leaked-Plaintext Cleanup (consent-gated) │
  └────────────────────────────────────────────┘`),
  );

  const folder = detectCloudFolder();
  if (!folder) {
    console.log(picocolors.yellow(`\n  ⚠️  No cloud sync folder detected — nothing to clean.\n`));
    return;
  }

  const leaked = await enumerateLeakedArtifacts();
  if (leaked.length === 0) {
    console.log(picocolors.green(`\n  ✅ No leaked plaintext artifacts found in ${path.join(folder, "Quiver")}.\n`));
    return;
  }

  console.log(picolorempty());
  console.log(picocolors.yellow(`  Found ${leaked.length} leaked plaintext artifact(s) in ${path.join(folder, "Quiver")}:`));
  console.log(picocolors.gray(`  (these are user-owned files — nothing is deleted without your confirmation)\n`));
  for (const a of leaked) {
    console.log(picocolors.gray(`    • ${a.relPath}  [${a.reason}, ${Math.max(1, Math.round(a.sizeBytes / 1024))}KB]`));
  }
  console.log("");

  const confirm = await askYesNo(rl, "  Delete these leaked artifacts? (y/N): ");
  if (!confirm) {
    console.log(picocolors.gray(`\n  Skipped — no files were deleted.\n`));
    await cleanupLeakedArtifacts(false);
    return;
  }

  const result = await cleanupLeakedArtifacts(true);
  console.log(picocolors.green(`\n  ✅ Removed ${result.removed.length} artifact(s).`));
  for (const f of result.removed) console.log(picocolors.gray(`     ✓ ${f}`));
  if (result.skipped.length) {
    console.log(picolorempty());
    console.log(picocolors.yellow(`  ⚠️  Skipped ${result.skipped.length} (could not remove):`));
    for (const f of result.skipped) console.log(picocolors.gray(`     • ${f}`));
  }
  console.log(picocolors.gray(`\n  Removals logged to the audit chain (~/.quiver/sync_audit.json).\n`));
}

function picolorempty(): string { return ""; }

async function askYesNo(rl: import("readline").Interface | undefined, prompt: string): Promise<boolean> {
  if (!rl) {
    // Non-interactive: default to safe (no deletion) unless --json/CI sets a flag.
    return false;
  }
  return new Promise((resolve) => {
    rl.question(prompt, (ans: string) => {
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}
