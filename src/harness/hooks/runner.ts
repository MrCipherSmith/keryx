// The hook process runner: the `HookProcessRunner` port + a real
// `node:child_process`-backed implementation (flow 306, W6, T5).
//
// Every hook is spawned with argv only (never shell-interpolated), fed one
// stdin JSON payload, and capped on output/time. Sandboxed by default
// (`runsIn: "sandbox"`) through the existing OS sandbox layer
// (`wrapWithSandbox` + `detectSandboxLauncher`, D2) — an unavailable/refusing
// launcher is a fail-closed `spawnError: "sandbox-unavailable"`, never an
// unsandboxed fallback. `runsIn: "unsandboxed"` is refused (`spawnError:
// "refused"`) whenever EITHER the active `SandboxProfile.required` is true OR
// the caller-supplied `req.isolationRequired` is true (flow 306, W6, fix
// round 1, finding 1) — the latter is the one that actually fires in
// production: every real caller constructs its runner with
// `defaultSandboxProfile`, whose `required` is always `false`, so
// `isolationRequired` (computed by the caller from the active policy's
// `requiredControls.isolation === "required-fail-closed"` — see
// `runtime.ts`'s `isIsolationRequired`, also now reused by `commands/
// hooks.ts`'s `hooks test`/`hooks list`, flow 306 fix round 2 finding F) is
// the check that carries the profile's own isolation requirement through to
// this refusal.
import { spawn } from "node:child_process";
import path from "node:path";
import { detectSandboxLauncher } from "../process/sandbox/detect";
import { defaultSandboxProfile } from "../process/sandbox/profile";
import { wrapWithSandbox } from "../process/sandbox/wrap";
import type { SandboxLauncherInfo } from "../process/sandbox/detect";
import type { SandboxProfile } from "../process/sandbox/profile";

export interface HookRunRequest {
  argv: string[];
  /** Resolved relative to the runner's `projectRoot`; refused if it escapes. */
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  network: "none" | "restricted";
  runsIn: "sandbox" | "unsandboxed";
  /**
   * The EFFECTIVE isolation requirement for this fire (flow 306, W6, fix
   * round 1, finding 1) — `true` when the active policy profile's
   * `requiredControls.isolation === "required-fail-closed"`. Computed by the
   * caller (`runtime.ts`, from the per-fire profile) rather than derived here
   * from a caller-supplied `SandboxProfile`, because every production caller
   * constructs its runner with `defaultSandboxProfile`, whose `required` is
   * always `false` — so a `SandboxProfile.required` check alone never fires
   * in production regardless of the active profile. Absent/`false` preserves
   * the prior behavior (no refusal beyond `SandboxProfile.required`).
   */
  isolationRequired?: boolean;
}

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  durationMs: number;
}

/** The one side-effecting port the rest of this package consumes; a fake in tests. */
export interface HookProcessRunner {
  run(req: HookRunRequest): Promise<HookRunResult>;
}

const INHERITED_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"] as const;

export interface BuildHookEnvOptions {
  /** Injected (never read directly), so this stays pure and testable. */
  processEnv: NodeJS.ProcessEnv;
  commandEnv?: Record<string, string>;
  hookEvent: string;
  hookId: string;
  sessionId: string;
  runId: string;
  projectRoot: string;
  policyProfile: string;
}

/**
 * The fixed env allowlist (D5): a handful of inherited values from the real
 * process environment, plus the fixed `KERYX_*`/`CLAUDE_PROJECT_DIR`
 * identity fields, plus `command.env`. Nothing else passes through — a
 * secret sitting in the ambient shell environment (not on this list and not
 * explicitly in `commandEnv`) is stripped, not merely left unset.
 */
export function buildHookEnv(opts: BuildHookEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = opts.processEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.KERYX_HOOK_EVENT = opts.hookEvent;
  env.KERYX_HOOK_ID = opts.hookId;
  env.KERYX_SESSION_ID = opts.sessionId;
  env.KERYX_RUN_ID = opts.runId;
  env.KERYX_PROJECT_ROOT = opts.projectRoot;
  env.KERYX_POLICY_PROFILE = opts.policyProfile;
  env.CLAUDE_PROJECT_DIR = opts.projectRoot;
  if (opts.commandEnv !== undefined) {
    for (const [key, value] of Object.entries(opts.commandEnv)) {
      env[key] = value;
    }
  }
  return env;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60_000;

function clampTimeout(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

interface SpawnCollectOptions {
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface SpawnCollectResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Grace period after a SIGKILL before `spawnAndCollect` force-resolves even
 * without a `close` event (flow 306, W6, fix round 1, finding 2). `close`
 * only fires once every stdio fd the child held is itself closed — an
 * escaped/detached grandchild (`setsid`-style) that inherited the child's
 * stdout keeps that fd open past the kill, so waiting on `close` alone can
 * hang the caller forever even though the timed-out child is long dead. The
 * grace period bounds that wait; `exit` (which fires as soon as the child
 * process itself terminates, independent of its stdio fds) lets us start
 * counting the grace period from the earliest reliable signal rather than
 * from the kill call itself.
 */
const CLOSE_GRACE_MS = 500;

/** Spawn one command, feed stdin, cap output, and SIGKILL (process-group where possible) on timeout. Never hangs, even past an escaped grandchild holding stdio open. */
function spawnAndCollect(cmdPath: string, args: string[], opts: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let exited = false;
    const isPosix = process.platform !== "win32";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmdPath, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: isPosix,
      });
    } catch (err) {
      // A synchronous throw from `spawn()` itself (e.g. a NUL byte in argv,
      // or an ENOENT the platform raises synchronously) must never reject
      // this promise — a rejection here propagates as an unhandled throw
      // through `runCommandHook`/`fire()`, which upstream callers (finding
      // 3) were treating as "hook not present" and failing OPEN instead of
      // running gate failure semantics. Resolve with `spawnError` instead,
      // exactly like the async `child.on("error", ...)` path below.
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      // Best-effort: unblock anything still holding these fds so the
      // process itself doesn't linger on our account.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    const killChild = (): void => {
      try {
        if (isPosix && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Already exited; nothing to kill.
      }
    };

    const armGraceTimer = (): void => {
      if (settled) return;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => finish(exitCode), CLOSE_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
      armGraceTimer();
    }, opts.timeoutMs);

    child.on("error", (err) => {
      spawnError = err.message;
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") < opts.maxOutputBytes) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf8") < opts.maxOutputBytes) {
        stderr += chunk.toString("utf8");
      }
    });
    // A child that exits before stdin is fully written raises EPIPE on the
    // write stream; the `close` handler below still fires and resolves.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin, "utf8");

    // Fires as soon as the child process itself terminates, regardless of
    // whether its inherited stdio fds are still open elsewhere (e.g. a
    // detached grandchild). Once we know the process is gone, re-arm the
    // grace timer from here so a timeout that raced the kill still bounds
    // the wait even when `exit` arrives after the timer above already fired.
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      if (timedOut) armGraceTimer();
    });

    child.on("close", (code) => {
      if (!exited) exitCode = code;
      finish(code);
    });
  });
}

export interface CreateRealHookRunnerOptions {
  projectRoot: string;
  /** `process.platform` override (tests). */
  platform?: string;
  /** Pre-resolved sandbox launcher detection (tests); defaults to a real `detectSandboxLauncher` call. */
  launcher?: SandboxLauncherInfo;
  /** The active OS-sandbox profile (its `network` is overridden per-request from `req.network`). */
  sandboxProfile?: SandboxProfile;
  /** Per-stream output cap. Defaults to 1 MiB. */
  maxOutputBytes?: number;
  /** Injectable wall clock (tests); defaults to `Date.now`. */
  now?: () => number;
}

/** Build a real `HookProcessRunner` that spawns hook commands as OS processes. */
export function createRealHookRunner(opts: CreateRealHookRunnerOptions): HookProcessRunner {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    async run(req: HookRunRequest): Promise<HookRunResult> {
      const startedAt = now();
      const fail = (spawnError: string): HookRunResult => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError,
        durationMs: now() - startedAt,
      });

      const resolvedCwd = path.resolve(opts.projectRoot, req.cwd);
      const relative = path.relative(opts.projectRoot, resolvedCwd);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return fail("refused");
      }

      if (req.argv.length === 0) {
        return fail("refused");
      }

      let spawnPath = req.argv[0] as string;
      let spawnArgs = req.argv.slice(1);

      const baseProfile = opts.sandboxProfile ?? defaultSandboxProfile(resolvedCwd, resolvedCwd);

      if (req.runsIn === "unsandboxed") {
        if (baseProfile.required || req.isolationRequired === true) {
          return fail("refused");
        }
      } else {
        const launcher = opts.launcher ?? detectSandboxLauncher({ platform });
        if (!launcher.available) {
          return fail("sandbox-unavailable");
        }
        const effectiveProfile: SandboxProfile = {
          ...baseProfile,
          network: req.network === "restricted" ? "restricted" : "off",
        };
        const wrapped = wrapWithSandbox(
          { path: spawnPath, argv: req.argv, env: req.env, cwd: resolvedCwd },
          effectiveProfile,
          { platform, ...(launcher.path !== undefined ? { bwrapPath: launcher.path } : {}) },
        );
        if (!wrapped.ok) {
          return fail("sandbox-unavailable");
        }
        spawnPath = wrapped.command.path;
        spawnArgs = wrapped.command.argv.slice(1);
      }

      const timeoutMs = clampTimeout(req.timeoutMs);
      const collected = await spawnAndCollect(spawnPath, spawnArgs, {
        cwd: resolvedCwd,
        env: req.env,
        stdin: req.stdin,
        timeoutMs,
        maxOutputBytes,
      });
      return {
        exitCode: collected.exitCode,
        stdout: collected.stdout,
        stderr: collected.stderr,
        timedOut: collected.timedOut,
        ...(collected.spawnError !== undefined ? { spawnError: collected.spawnError } : {}),
        durationMs: now() - startedAt,
      };
    },
  };
}
