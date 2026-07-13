// RED tests for a NOT-YET-EXISTING pure classifier (review-hardening fix #3,
// flow 027, T5).
//
// `src/harness/process/real-process-adapter.ts`'s `spawn()` currently inlines
// the spawnSync-result -> `ProcessObservation` classification logic directly
// inside the (gated, real-spawning) `RealProcessAdapter.spawn` method. This
// suite targets a pure, exported `classifyProcessResult(result, ctx)` the T6
// fix must extract that logic into — so the classification rules (ETIMEDOUT ->
// deadline-exceeded, ENOBUFS -> output-overflow, a bare/external signal with no
// deadline hit -> a distinct crash observation, clean status -> clean-exit)
// can be unit-tested WITHOUT constructing a `RealProcessAdapter` and WITHOUT
// spawning anything real.
//
// `classifyProcessResult` does not exist yet — the import below fails today
// ("Cannot find module './real-process-adapter'" export), which is the
// expected RED failure for the WHOLE file (every test fails identically at
// import time — this is NOT a per-test bug).
//
// PINNED SIGNATURE (T6 implements exactly this surface):
//   export function classifyProcessResult(
//     result: {
//       status: number | null;
//       signal: string | null;
//       error?: NodeJS.ErrnoException;
//       stdout?: string | Buffer | null;
//       stderr?: string | Buffer | null;
//       pid?: number;
//     },
//     ctx: { observedHash: string; deadlineHit?: boolean },
//   ): ProcessObservation;
//
// PINNED CONTRACT this suite locks:
//   - `error.code === "ETIMEDOUT"` -> `kind: "deadline-exceeded"` (real
//     `spawnSync` timeout signal).
//   - `signal` is set AND `ctx.deadlineHit === true` -> `kind:
//     "deadline-exceeded"` (the adapter's OWN deadline fired and killed the
//     child with this signal — e.g. the `killSignal: "SIGKILL"` the adapter
//     configures).
//   - `signal` is set but `ctx.deadlineHit` is NOT true (no falsy/undefined) ->
//     NEVER `deadline-exceeded` and NEVER a `clean-exit`-equivalent — this is
//     an externally/self-inflicted signal (crash or external kill), reported
//     as a distinct `spawn-error`-kind observation whose `errorMessage` names
//     the signal (so callers can tell "the command crashed/was killed" apart
//     from "our own deadline killed it"). Covers both a genuine crash signal
//     (`SIGSEGV`) and an external termination signal (`SIGTERM`) — today's
//     inline logic in `real-process-adapter.ts` conflates ANY non-null
//     `signal` with `deadline-exceeded`, which is the bug this classifier
//     fixes.
//   - `error.code === "ENOBUFS"` -> `kind: "output-overflow"` (adapter's own
//     `maxBuffer` cap tripped).
//   - clean (`status` a number, `signal: null`, `error` undefined) -> `kind:
//     "clean-exit"` with `exitCode` === `status` (0 AND a non-zero in-bounds
//     status both surface faithfully — never fabricated).
//
// PURITY: this function must cause NO spawn at import, and must not trip the
// `RealProcessAdapter` capability gate (`allowRealSubprocess` /
// `KERYX_ALLOW_REAL_SUBPROCESS`) — it is imported here with NEITHER set, and
// with no `RealProcessAdapter` ever constructed anywhere in this file.
import { describe, expect, test } from "bun:test";

// PINNED API under test (RED: does not exist yet on real-process-adapter.ts).
import { classifyProcessResult } from "./real-process-adapter";
import type { ProcessObservation } from "./executor";

/** The subset of Node's `SpawnSyncReturns<Buffer>` the classifier consumes. */
interface SpawnSyncLikeResult {
  status: number | null;
  signal: string | null;
  error?: NodeJS.ErrnoException;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  pid?: number;
}

/** A clean, fully-populated baseline result — overridden per test case. */
function makeResult(overrides: Partial<SpawnSyncLikeResult> = {}): SpawnSyncLikeResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    pid: 4242,
    ...overrides,
  };
}

/** An errno-shaped Error, mirroring what `child_process` attaches as `result.error`. */
function errnoError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

const OBSERVED_HASH = "0".repeat(64);

describe("classifyProcessResult — pure spawnSync-result -> ProcessObservation classifier (fix #3)", () => {
  test("error.code ETIMEDOUT -> deadline-exceeded", () => {
    const result = makeResult({ status: null, signal: "SIGTERM", error: errnoError("ETIMEDOUT") });

    const observation: ProcessObservation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).toBe("deadline-exceeded");
  });

  test("signal SIGKILL + ctx.deadlineHit:true -> deadline-exceeded", () => {
    const result = makeResult({ status: null, signal: "SIGKILL" });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH, deadlineHit: true });

    expect(observation.kind).toBe("deadline-exceeded");
  });

  test("signal SIGSEGV with NO deadline hit -> a distinct crash observation, NOT deadline-exceeded, NOT clean-exit", () => {
    const result = makeResult({ status: null, signal: "SIGSEGV" });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).not.toBe("deadline-exceeded");
    expect(observation.kind).not.toBe("clean-exit");
    expect(observation.kind).toBe("spawn-error");
    expect(observation.errorMessage ?? "").toContain("SIGSEGV");
  });

  test("an external signal SIGTERM with NO deadline hit -> a distinct crash observation, NOT deadline-exceeded", () => {
    const result = makeResult({ status: null, signal: "SIGTERM" });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).not.toBe("deadline-exceeded");
    expect(observation.kind).not.toBe("clean-exit");
    expect(observation.kind).toBe("spawn-error");
    expect(observation.errorMessage ?? "").toContain("SIGTERM");
  });

  test("error.code ENOBUFS -> output-overflow", () => {
    const result = makeResult({ error: errnoError("ENOBUFS") });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).toBe("output-overflow");
  });

  test("clean status:0, signal:null, error:undefined -> clean-exit with exitCode:0", () => {
    const result = makeResult({ status: 0, signal: null });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).toBe("clean-exit");
    expect(observation.exitCode).toBe(0);
  });

  test("clean status:3 (non-zero, in-bounds) -> clean-exit with exitCode:3, never fabricated to 0", () => {
    const result = makeResult({ status: 3, signal: null });

    const observation = classifyProcessResult(result, { observedHash: OBSERVED_HASH });

    expect(observation.kind).toBe("clean-exit");
    expect(observation.exitCode).toBe(3);
  });

  test("the observedHash from ctx is carried through verbatim onto every observation kind", () => {
    const clean = classifyProcessResult(makeResult(), { observedHash: OBSERVED_HASH });
    const timeout = classifyProcessResult(makeResult({ error: errnoError("ETIMEDOUT") }), {
      observedHash: OBSERVED_HASH,
    });

    expect(clean.observedHash).toBe(OBSERVED_HASH);
    expect(timeout.observedHash).toBe(OBSERVED_HASH);
  });
});
