/**
 * Shared child-process isolation primitives.
 *
 * The checker and user-facing subagent have different jobs, but both must
 * follow the same process boundary: no ambient parent environment, disposable
 * HOME/state, and no shell interpolation.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

export function createIsolatedEnv(
  allowedKeys: readonly string[],
  options: {
    scratchDir: string;
    protectedDir?: string;
    overrides?: Record<string, string | undefined>;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(
    env,
    Object.fromEntries(
      Object.entries(options.overrides || {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );

  // Remap HOME so child state cannot pollute the parent. Preserve Vertex ADC
  // when GOOGLE_APPLICATION_CREDENTIALS is unset — default ADC lives under
  // the real home (~/.config/gcloud/...), which would otherwise disappear.
  const realHome = process.env.HOME || process.env.USERPROFILE || "";
  env.HOME = options.scratchDir;
  if (process.platform === "win32") env.USERPROFILE = options.scratchDir;
  if (realHome && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    const adcPath = path.join(
      realHome,
      ".config",
      "gcloud",
      "application_default_credentials.json",
    );
    if (existsSync(adcPath)) {
      env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
    }
  }

  if (options.protectedDir) env.QUIVER_PROTECTED_DIR = options.protectedDir;
  return env;
}

/**
 * Spawn an isolated child using an argument array, never `/bin/sh -c`.
 * Callers own timeout and output parsing because checker and subagent have
 * different completion protocols.
 */
export function spawnIsolatedProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
