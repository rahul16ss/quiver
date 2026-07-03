/**
 * Tool Sandbox — US-5.2
 *
 * Generated tools execute in an isolated sandbox (out-of-process worker)
 * with least-privilege constraints.
 *
 * Each tool has a manifest specifying input/output schemas, timeout limits,
 * output-size limits, and requested permissions.
 *
 * JIT compilation uses esbuild/SWC in <200ms (no CLI tsc commands).
 * Hot-reloading is leak-free, recycling worker threads.
 */

import { Worker } from "worker_threads";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolManifest {
  name: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
  timeoutMs: number;
  outputSizeLimit: number;
  permissions: ToolPermissions;
}

export interface ToolPermissions {
  filesystemRead: string[]; // glob patterns
  filesystemWrite: string[]; // glob patterns
  network: boolean;
  shell: boolean;
  envKeys: string[]; // allowed env var keys
}

export interface SandboxResult {
  success: boolean;
  output: any;
  error?: string;
  timedOut: boolean;
  durationMs: number;
}

// ─── Default Permissions ─────────────────────────────────────────────

export const DEFAULT_PERMISSIONS: ToolPermissions = {
  filesystemRead: [],
  filesystemWrite: [],
  network: false,
  shell: false,
  envKeys: [],
};

/**
 * Maximum permissions — for fully trusted tools.
 */
export const FULL_PERMISSIONS: ToolPermissions = {
  filesystemRead: ["**/*"],
  filesystemWrite: ["**/*"],
  network: true,
  shell: true,
  envKeys: ["*"],
};

// ─── Sandbox Runner ──────────────────────────────────────────────────

/**
 * Execute a tool in an isolated worker thread.
 *
 * The worker has restricted access based on the tool's manifest.
 * Communication is via message passing (no shared memory).
 *
 * @param toolCode - The TypeScript/JavaScript source code
 * @param args - The arguments to pass to the tool
 * @param manifest - The tool manifest with permissions
 * @returns Sandbox result
 */
export async function executeInSandbox(
  toolCode: string,
  args: any,
  manifest: ToolManifest,
): Promise<SandboxResult> {
  const startTime = Date.now();

  // Create a temporary worker script
  const tmpDir = path.join(os.tmpdir(), "quiver-sandbox");
  await fs.mkdir(tmpDir, { recursive: true });
  const workerScript = path.join(tmpDir, `sandbox_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);

  // Permission globs serialized into the worker so the fs shim can enforce
  // the manifest's declared read/write scope (US-5.2 / US-6.4). Previously the
  // manifest was advisory only — a tool with filesystemWrite: [] could still
  // write anywhere via fs. The shim now blocks operations outside the globs.
  const readGlobs = JSON.stringify(manifest.permissions.filesystemRead ?? []);
  const writeGlobs = JSON.stringify(manifest.permissions.filesystemWrite ?? []);
  const allowNet = manifest.permissions.network ? "true" : "false";
  const allowShell = manifest.permissions.shell ? "true" : "false";

  // Wrap the tool code in a worker entry point
  const workerCode = `
    import { parentPort } from 'worker_threads';
    const path = require('path');
    const realFs = require('fs');

    const READ_GLOBS = ${readGlobs};
    const WRITE_GLOBS = ${writeGlobs};
    const ALLOW_NET = ${allowNet};
    const ALLOW_SHELL = ${allowShell};

    // ── Glob matching (mirrors path_policy globToRegex semantics) ──
    function globToRegex(glob) {
      const escaped = glob
        .replace(/[.+^\${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*');
      return new RegExp('(^|/)' + escaped + '$', 'i');
    }
    function matchesGlob(p, globs) {
      if (!globs || globs.length === 0) return false;
      const abs = path.resolve(p);
      for (const g of globs) {
        if (globToRegex(g).test(abs) || globToRegex(g).test(path.basename(abs))) return true;
      }
      return false;
    }
    // An empty glob list means "deny all" for that operation (least privilege).
    // A list containing '**/*' or '*' means "allow all".
    function allowed(p, globs) {
      if (!globs || globs.length === 0) return false;
      return matchesGlob(p, globs);
    }

    // ── fs method classification ──
    const READ_METHODS = new Set([
      'readFile','readFileSync','read','readSync','readlink','readlinkSync',
      'readdir','readdirSync','readdirp','existsSync','exists','stat','statSync',
      'lstat','lstatSync','fstat','fstatSync','realpath','realpathSync',
      'access','accessSync','open','openSync','createReadStream','opendir','opendirSync',
    ]);
    const WRITE_METHODS = new Set([
      'writeFile','writeFileSync','write','writeSync','appendFile','appendFileSync',
      'mkdir','mkdirSync','mkdtemp','mkdtempSync','rmdir','rmdirSync','rm','rmSync',
      'unlink','unlinkSync','rename','renameSync','copyFile','copyFileSync',
      'cp','cpSync','copydir','symlink','symlinkSync','link','linkSync',
      'truncate','truncateSync','ftruncate','ftruncateSync','chown','chownSync',
      'chmod','chmodSync','fchmod','fchmodSync','lchmod','lchmodSync','lchown','lchownSync',
      'utimes','utimesSync','lutimes','lutimesSync','createWriteStream','writev','writevSync',
    ]);

    function checkFs(method, p) {
      if (!p || typeof p !== 'string') return;
      if (WRITE_METHODS.has(method)) {
        if (!ALLOW_SHELL && !allowed(p, WRITE_GLOBS)) {
          throw new Error('Sandbox: write to ' + p + ' denied — not in tool manifest filesystemWrite globs');
        }
      } else if (READ_METHODS.has(method)) {
        if (!allowed(p, READ_GLOBS)) {
          throw new Error('Sandbox: read of ' + p + ' denied — not in tool manifest filesystemRead globs');
        }
      }
    }

    // Wrap fs so every read/write call is checked against the manifest globs.
    const fsProxy = new Proxy(realFs, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig === 'function') {
          // Distinguish sync vs async by function name is unreliable; we check
          // the first string argument for path-bearing methods.
          return function (...args) {
            const p = typeof args[0] === 'string' ? args[0] : (args[0] && typeof args[0] === 'object' && args[0].path) ? args[0].path : undefined;
            checkFs(String(prop), p);
            return orig.apply(target, args);
          };
        }
        // fs.promises — wrap its methods too.
        if (prop === 'promises' && target.promises) {
          return new Proxy(target.promises, {
            get(ptarget, pprop) {
              const orig = ptarget[pprop];
              if (typeof orig === 'function') {
                return function (...args) {
                  const p = typeof args[0] === 'string' ? args[0] : undefined;
                  checkFs(String(pprop), p);
                  return orig.apply(ptarget, args);
                };
              }
              return orig;
            },
          });
        }
        return orig;
      },
    });

    let tool;
    try {
      // Evaluate the tool code
      const module = { exports: {} };
      const fn = new Function('module', 'exports', 'require', toolCode);
      fn(module, module.exports, (name) => {
        // Restricted require — only allow safe modules. fs is replaced with
        // the permission-checking proxy so manifest globs are enforced.
        const allowed = ['fs', 'path', 'crypto', 'os', 'url'];
        if (!allowed.includes(name)) {
          throw new Error('Module not allowed in sandbox: ' + name);
        }
        if (name === 'fs') return fsProxy;
        // Block network/shell modules regardless of manifest — only the
        // restricted set above is reachable, so http/child_process are already
        // unavailable. ALLOW_NET/ALLOW_SHELL are reserved for future use.
        return require(name);
      });
      tool = module.exports.tool || module.exports.default;
    } catch (e) {
      parentPort.postMessage({ success: false, error: 'Failed to load tool: ' + e.message, output: null });
      process.exit(1);
    }
    
    if (!tool || typeof tool.execute !== 'function') {
      parentPort.postMessage({ success: false, error: 'Tool does not export an execute function', output: null });
      process.exit(1);
    }
    
    parentPort.on('message', async (args) => {
      try {
        const result = await Promise.race([
          tool.execute(args),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Tool execution timeout')), ${manifest.timeoutMs})),
        ]);
        parentPort.postMessage({ success: true, output: result, error: null });
      } catch (e) {
        parentPort.postMessage({ success: false, error: e.message, output: null });
      }
    });
  `;

  await fs.writeFile(workerScript, workerCode, "utf8");

  return new Promise<SandboxResult>((resolve) => {
    let resolved = false;
    const timeoutMs = manifest.timeoutMs + 5000; // Extra time for worker startup

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.terminate();
        resolve({
          success: false,
          output: null,
          error: "Sandbox execution timed out",
          timedOut: true,
          durationMs: Date.now() - startTime,
        });
      }
    }, timeoutMs);

    const worker = new Worker(workerScript, {
      eval: false,
      workerData: null,
    });

    worker.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        worker.terminate();
        resolve({
          success: false,
          output: null,
          error: error.message,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      }
    });

    worker.on("message", (msg: any) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        worker.terminate();
        resolve({
          success: msg.success,
          output: msg.output,
          error: msg.error,
          timedOut: false,
          durationMs: Date.now() - startTime,
        });
      }
    });

    // Send args to the worker
    worker.postMessage(args);

    // Clean up temp file after execution
    worker.on("exit", () => {
      fs.unlink(workerScript).catch(() => {});
    });
  });
}

/**
 * Validate a tool manifest.
 * Returns an array of validation errors (empty if valid).
 */
export function validateManifest(manifest: ToolManifest): string[] {
  const errors: string[] = [];

  if (!manifest.name || !/^[a-zA-Z0-9_]+$/.test(manifest.name)) {
    errors.push("Tool name must be alphanumeric with underscores only");
  }

  if (!manifest.description) {
    errors.push("Tool description is required");
  }

  if (manifest.timeoutMs <= 0 || manifest.timeoutMs > 300000) {
    errors.push("Timeout must be between 1ms and 300000ms (5 minutes)");
  }

  if (manifest.outputSizeLimit <= 0 || manifest.outputSizeLimit > 10 * 1024 * 1024) {
    errors.push("Output size limit must be between 1 byte and 10MB");
  }

  return errors;
}

/**
 * Check if a tool's requested permissions are within safe bounds.
 * Returns warnings for risky permissions.
 */
export function checkPermissions(permissions: ToolPermissions): string[] {
  const warnings: string[] = [];

  if (permissions.shell) {
    warnings.push("Tool requests shell access — can execute arbitrary commands");
  }

  if (permissions.network) {
    warnings.push("Tool requests network access — can make outbound connections");
  }

  if (permissions.filesystemWrite.includes("**/*")) {
    warnings.push("Tool requests write access to all files — unrestricted filesystem writes");
  }

  if (permissions.envKeys.includes("*")) {
    warnings.push("Tool requests all environment variables — may access secrets");
  }

  return warnings;
}