// REAL `node:child_process`-backed `ProcessAdapter` (flow 026, T6 / R2-5).
//
// This is the ONLY module in the harness that spawns a real OS process, and it
// is unreachable without an explicit opt-in capability: the constructor REFUSES
// to build unless `allowRealSubprocess` is true (defaulting to the
// `KERYX_ALLOW_REAL_SUBPROCESS === "1"` live-testing flag, mirroring the W14
// real-provider gate). The offline executor suite never imports this file — it
// is exercised only by the flag-gated `real-process-adapter.smoke.test.ts`,
// whose dynamic `import()` lives inside a `describe.skipIf` block — so under a
// normal `bun test` nothing here ever runs and zero real processes are spawned.
//
// `node:child_process` is a Node builtin (stdlib), not a package dependency, so
// `dependencies` in package.json stays `{}`. It is imported for its type/function
// reference only; no child process is spawned at import time — a spawn happens
// solely inside `spawn()`, which is unreachable until the capability gate passes.
//
// Enforcement (the runtime half of SC_R04_SHELL_CONTAINMENT). Because the
// `ProcessAdapter.spawn` port is SYNCHRONOUS (the offline decision core is a
// pure, deterministic function), the command is run via `spawnSync`, which is
// the only Node primitive that synchronously RUNS, REAPS, and observes a child:
//   - `cwd`      — the command runs in the approved worktree.
//   - `timeout` + `killSignal: "SIGKILL"` — a deadline breach kills the child;
//     the real exit `signal`/`ETIMEDOUT` maps to a `deadline-exceeded`
//     observation with `terminationMode: "leader-only"`.
//   - `maxBuffer` — output past the adapter's hard cap aborts the child
//     (`ENOBUFS`) → an `output-overflow` observation; otherwise the REAL
//     captured stdout+stderr byte count is reported as `outputBytes`, which the
//     executor compares against the run's finer `outputLimitBytes`.
//   - the REAL exit status is reported as `exitCode` (never fabricated), so a
//     non-zero exit is recorded faithfully.
//
// DESIGN CONSTRAINT (disclosed, not hidden). A synchronous adapter cannot both
// (a) spawn `detached` and group-kill via `process.kill(-pid)` AND (b) reap the
// child to read its real exit/output — an earlier detached+poll attempt left the
// exited child a ZOMBIE that `kill(pid, 0)` still reports as alive, so a clean
// exit was never observed (every fast command falsely timed out). `spawnSync`
// (which cannot take `detached`) is therefore used, and the deadline kill is
// leader-only: the direct contained child is killed and reaped, but a grandchild
// that the command itself spawned is not group-reaped. The offline core still
// models the full process-GROUP no-orphan contract via the fake adapter (which
// reports `terminationMode: "process-group"`); a full live group kill would
// require an ASYNC real adapter and is left as a follow-up.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ContainedCommand, ProcessAdapter, ProcessObservation } from "./executor";

/** Options for {@link RealProcessAdapter}. */
export interface RealProcessAdapterOptions {
  /**
   * The explicit capability that unlocks real subprocess spawning. Defaults to
   * the `KERYX_ALLOW_REAL_SUBPROCESS === "1"` live-testing flag; when it is not
   * true the constructor throws and no real process can ever be spawned.
   */
  allowRealSubprocess?: boolean;
  /** Deadline (ms) after which the child is killed. */
  timeoutMs?: number;
  /**
   * The adapter's own hard output cap (bytes) for memory safety — output past it
   * aborts the child with `ENOBUFS` → an `output-overflow` observation. A
   * ceiling; the run's finer `outputLimitBytes` is enforced by the executor from
   * the reported `outputBytes`.
   */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Byte length of a `spawnSync` stdout/stderr buffer (Buffer or string or null). */
function byteLength(chunk: string | Buffer | null): number {
  if (chunk === null) return 0;
  return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
}

/**
 * A real `node:child_process`-backed {@link ProcessAdapter}. Gated: it cannot be
 * constructed unless `allowRealSubprocess` is true. Runs each command
 * synchronously (`spawnSync`) in the approved `cwd`, enforcing a deadline and an
 * output cap, and reporting the REAL exit status and output size.
 */
export class RealProcessAdapter implements ProcessAdapter {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: RealProcessAdapterOptions = {}) {
    const allow = options.allowRealSubprocess ?? process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
    if (!allow) {
      throw new Error(
        "RealProcessAdapter refuses to construct without the explicit allowRealSubprocess capability " +
          "(set KERYX_ALLOW_REAL_SUBPROCESS=1 or pass { allowRealSubprocess: true }); failing closed.",
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  spawn(command: ContainedCommand): ProcessObservation {
    // `argv[0]` is the program name by convention; the real args follow it.
    const result = spawnSync(command.path, command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
      timeout: this.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: this.maxOutputBytes,
    });

    const observedHash = sha256Hex(`${command.path}\n${command.argv.join(" ")}`);
    const err = result.error as NodeJS.ErrnoException | undefined;

    // Output past the adapter's hard cap aborted the child — a bounded overflow.
    if (err?.code === "ENOBUFS") {
      return { kind: "output-overflow", terminationMode: "leader-only", observedHash };
    }

    // Deadline breach: `spawnSync` killed the child (`ETIMEDOUT`, or a kill
    // signal on the result). The direct child is killed and reaped (leader-only;
    // see the DESIGN CONSTRAINT header).
    if (err?.code === "ETIMEDOUT" || result.signal !== null) {
      return { kind: "deadline-exceeded", terminationMode: "leader-only", observedHash };
    }

    // Any other error (e.g. ENOENT) means no effect boundary was crossed. Report
    // only the errno CODE — never a message that could echo argv/env.
    if (err !== undefined || result.pid === undefined) {
      return { kind: "spawn-error", observedHash, errorMessage: err?.code ?? "spawn produced no pid" };
    }

    // Clean termination within all bounds — report the REAL exit status and the
    // REAL captured output size (the executor compares it to `outputLimitBytes`).
    const observation: ProcessObservation = {
      kind: "clean-exit",
      outputBytes: byteLength(result.stdout) + byteLength(result.stderr),
      terminationMode: "none",
      observedHash,
    };
    if (result.status !== null) observation.exitCode = result.status;
    return observation;
  }
}
