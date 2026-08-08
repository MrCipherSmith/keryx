// Sandbox launcher detection + adapter factory (flow 093, T5).
//
// Consults the filesystem to learn whether the platform launcher (sandbox-exec
// on macOS, bwrap on Linux) is present. Detection is injectable
// (existsSync/env/platform) so it stays deterministic and offline in tests. It
// performs NO spawn — `probe.ts` is the module that does, and it answers a
// different question: not "is a launcher present" but "does containment work
// here". Presence is what this module knows, and presence is all `available`
// below means. Specification §2 of keryx-linux-containment replaces that
// boolean with a layer choice in step 3, when there is more than one layer to
// choose between.

import { existsSync as realExistsSync } from "node:fs";
import path from "node:path";
import type { ProcessAdapter } from "../executor";
import type { SandboxProfile } from "./profile";
import { SANDBOX_EXEC_PATH } from "./seatbelt";
import { BWRAP_PROGRAM } from "./bwrap";
import { SandboxedProcessAdapter } from "./adapter";

export interface SandboxLauncherInfo {
  available: boolean;
  platform: string;
  /** Absolute launcher path when resolved (bwrap on Linux). */
  path?: string;
  /** Why the launcher is unavailable (when `available` is false). */
  reason?: string;
}

export interface DetectOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  existsSync?: (p: string) => boolean;
}

/**
 * How to install bubblewrap, in one place.
 *
 * `keryx sandbox status` prints this too, and the two wordings had already
 * drifted — one listed Arch and the other did not, two lines apart in the same
 * output. One constant, one list.
 */
export const BWRAP_INSTALL_HINT =
  "Install it: apt install bubblewrap (Debian/Ubuntu) | dnf install bubblewrap (Fedora) | pacman -S bubblewrap (Arch)";

/** Detect the platform OS-sandbox launcher. */
export function detectSandboxLauncher(opts: DetectOptions = {}): SandboxLauncherInfo {
  const platform = opts.platform ?? process.platform;
  const exists = opts.existsSync ?? realExistsSync;

  if (platform === "darwin") {
    if (exists(SANDBOX_EXEC_PATH)) {
      return { available: true, platform, path: SANDBOX_EXEC_PATH };
    }
    return { available: false, platform, reason: `${SANDBOX_EXEC_PATH} not found` };
  }

  if (platform === "linux") {
    const env = opts.env ?? process.env;
    const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, BWRAP_PROGRAM);
      if (exists(candidate)) {
        return { available: true, platform, path: candidate };
      }
    }
    return {
      available: false,
      platform,
      reason: `bubblewrap (bwrap) not found on PATH. ${BWRAP_INSTALL_HINT}`,
    };
  }

  return { available: false, platform, reason: `OS sandbox unsupported on platform "${platform}"` };
}

export interface ResolveSandboxOptions extends DetectOptions {
  /** Default true (prod-safe): unavailable launcher ⇒ fail closed. */
  failIfUnavailable?: boolean;
}

/**
 * Build a {@link SandboxedProcessAdapter} for `profile` wrapping `inner`,
 * resolving launcher availability via {@link detectSandboxLauncher}. The
 * returned `info` lets callers surface a clear message (or fail closed) before
 * running when the launcher is missing and the profile requires it.
 */
export function resolveSandboxAdapter(
  profile: SandboxProfile,
  inner: ProcessAdapter,
  opts: ResolveSandboxOptions = {},
): { adapter: SandboxedProcessAdapter; info: SandboxLauncherInfo } {
  const info = detectSandboxLauncher(opts);
  const adapter = new SandboxedProcessAdapter({
    profile,
    inner,
    platform: info.platform,
    launcherAvailable: info.available,
    ...(info.path !== undefined ? { bwrapPath: info.path } : {}),
    ...(opts.failIfUnavailable !== undefined ? { failIfUnavailable: opts.failIfUnavailable } : {}),
  });
  return { adapter, info };
}
