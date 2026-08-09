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
import { fileURLToPath } from "node:url";
import type { ProcessAdapter } from "../executor";
import type { SandboxProfile } from "./profile";
import { SANDBOX_EXEC_PATH } from "./seatbelt";
import { BWRAP_PROGRAM } from "./bwrap";
import { SandboxedProcessAdapter } from "./adapter";
import type { SandboxLayer } from "./probe";

export interface SandboxLauncherInfo {
  available: boolean;
  platform: string;
  /** Absolute launcher path when resolved (bwrap on Linux). */
  path?: string;
  /** Why the launcher is unavailable (when `available` is false). */
  reason?: string;
  /**
   * The layer that would serve a run here, as far as *presence* can tell.
   *
   * `available` stays beside it rather than being replaced by it: six call sites
   * read the boolean, none of them would gain a boundary from being rewritten,
   * and specification §9 says the callers are unchanged. What the boolean cannot
   * say — and what this field exists for — is *which* mechanism answered.
   *
   * Presence is still all this module knows: `probe.ts` answers "does it work
   * here", and the final layer choice is per profile, in `wrap.ts`.
   */
  layer: SandboxLayer;
  /** The kernel's Landlock ABI, when the caller measured one. */
  landlockAbi?: number;
  /** Absolute path of the applier, resolved for source and bundled runs. */
  landlockExecPath?: string;
}

export interface DetectOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  existsSync?: (p: string) => boolean;
  /**
   * The kernel's Landlock ABI, measured by the caller.
   *
   * Not read here, and deliberately not defaulted: measuring it needs `bun:ffi`,
   * and this module is the one that must stay offline and injectable. Absent
   * means "nobody measured", which selects bubblewrap — never an assumption in
   * either direction about a kernel nobody asked.
   */
  landlockAbi?: number;
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
      return { available: true, platform, layer: "seatbelt", path: SANDBOX_EXEC_PATH };
    }
    return { available: false, platform, layer: "none", reason: `${SANDBOX_EXEC_PATH} not found` };
  }

  if (platform === "linux") {
    const env = opts.env ?? process.env;
    const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    let bwrap: string | undefined;
    for (const dir of dirs) {
      const candidate = path.join(dir, BWRAP_PROGRAM);
      if (exists(candidate)) {
        bwrap = candidate;
        break;
      }
    }

    // Landlock needs nothing installed — only a kernel that has it and an
    // applier to spawn. It is reported first because it is the default layer
    // (ADR-0010), and it is reported as *present* rather than as *selected*:
    // whether a given profile can use it is `wrap.ts`'s decision, per profile.
    const applier = landlockExecPath(exists);
    const abi = opts.landlockAbi;
    if (abi !== undefined && abi >= LANDLOCK_MINIMUM_ABI && applier !== undefined) {
      return {
        available: true,
        platform,
        layer: "landlock",
        landlockAbi: abi,
        landlockExecPath: applier,
        ...(bwrap !== undefined ? { path: bwrap } : {}),
      };
    }

    if (bwrap !== undefined) {
      return {
        available: true,
        platform,
        layer: "bwrap",
        path: bwrap,
        ...(abi !== undefined ? { landlockAbi: abi } : {}),
        ...(applier !== undefined ? { landlockExecPath: applier } : {}),
      };
    }
    return {
      available: false,
      platform,
      layer: "none",
      ...(abi !== undefined ? { landlockAbi: abi } : {}),
      reason:
        abi !== undefined && abi > 0
          ? `this kernel reports Landlock ABI ${abi}, below the ABI ${LANDLOCK_MINIMUM_ABI} a write boundary needs, and bubblewrap (bwrap) is not on PATH. ${BWRAP_INSTALL_HINT}`
          : `bubblewrap (bwrap) not found on PATH. ${BWRAP_INSTALL_HINT}`,
    };
  }

  return {
    available: false,
    platform,
    layer: "none",
    reason: `OS sandbox unsupported on platform "${platform}"`,
  };
}

/**
 * Lowest Landlock ABI at which a write boundary is faithful.
 *
 * `truncate` is ABI 3 and `refer` is ABI 2; handling write without `truncate`
 * would leave truncation unrestricted everywhere. Dropping it to reach Ubuntu
 * 22.04 was rejected twice in review and stays rejected.
 */
const LANDLOCK_MINIMUM_ABI = 3;

/**
 * Resolve the applier for BOTH execution modes, exactly as `proxyWorkerUrl`
 * resolves the proxy worker: running from source it is the sibling `.ts`, and in
 * a bundled build it is the `.js` emitted beside `cli.js` as its own build entry
 * — `bun build` does not follow a path that is only ever passed as an argument.
 *
 * `undefined` when neither exists, which selects bubblewrap rather than
 * producing a command whose first argument is a file that is not there.
 */
export function landlockExecPath(exists: (p: string) => boolean = realExistsSync): string | undefined {
  for (const sibling of ["./landlock-exec.ts", "./landlock-exec.js"]) {
    try {
      const candidate = fileURLToPath(new URL(sibling, import.meta.url));
      if (exists(candidate)) {
        return candidate;
      }
    } catch {
      // not a file: URL — try the next shape
    }
  }
  return undefined;
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
  const env = opts.env ?? process.env;
  const adapter = new SandboxedProcessAdapter({
    profile,
    inner,
    platform: info.platform,
    launcherAvailable: info.available,
    ...(info.path !== undefined ? { bwrapPath: info.path } : {}),
    // The Landlock branch of `wrap.ts` needs all three, or it falls back — so
    // they travel together and none of them is defaulted here.
    ...(info.landlockAbi !== undefined ? { landlockAbi: info.landlockAbi } : {}),
    ...(info.landlockExecPath !== undefined ? { landlockExecPath: info.landlockExecPath } : {}),
    bunPath: process.execPath,
    ...(env.HOME !== undefined ? { home: env.HOME } : {}),
    // The Bun install directory: the applier is Bun, and a contained command
    // that is itself Bun needs to read its own runtime. Measured, not assumed —
    // it is where `process.execPath` says it is.
    extraReadRoots: [path.dirname(process.execPath)],
    ...(opts.failIfUnavailable !== undefined ? { failIfUnavailable: opts.failIfUnavailable } : {}),
  });
  return { adapter, info };
}
