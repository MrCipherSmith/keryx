// Flag-gated LIVE smoke test for a REAL `node:child_process`-backed
// `ProcessAdapter` (flow 026, dispatch 026-T5, task-T5; T6 implements
// `./real-process-adapter.ts`, not-yet-existing at RED time).
//
// This suite is EXCLUDED FROM CI: it only runs when an explicit env flag,
// `KERYX_ALLOW_REAL_SUBPROCESS === "1"`, is set (mirrors the W14
// `allowRealSubprocess`/real-provider live-testing precedent — an opt-in
// gate that keeps a real side-effecting adapter out of the default/CI run).
// Under a normal `bun test` (no flag), every test in this file is SKIPPED via
// `describe.skipIf` — zero real processes are spawned, and the not-yet-
// existing `./real-process-adapter` module is never imported (the dynamic
// `import()` lives INSIDE each skipped test body, so a missing module never
// breaks collection).
//
// What this smoke test asserts (only when explicitly run locally with the
// flag set, never in CI):
//   1. a trivial real command runs via `node:child_process` and completes
//      (`ProcessObservation.kind === "clean-exit"`);
//   2. a real timeout kills the contained child — `ProcessObservation.kind ===
//      "deadline-exceeded"`. The synchronous `spawnSync` real adapter kills and
//      reaps the DIRECT child (`terminationMode === "leader-only"`); a full
//      process-GROUP kill of grandchildren would require an async adapter (see
//      the DESIGN CONSTRAINT in `real-process-adapter.ts`). The offline core
//      still models the full process-group no-orphan contract via the fake
//      adapter in `executor.test.ts`.
//
// These two properties cannot be proven by the fully-offline fake-adapter
// suite in `executor.test.ts` (which never touches a real process); they are
// exactly what T7's review greps for ("real adapter unreachable without the
// flag AND not exercised by the offline suite").
import { describe, expect, test } from "bun:test";

const REAL_SUBPROCESS_FLAG = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";

describe.skipIf(!REAL_SUBPROCESS_FLAG)(
  "real-process-adapter smoke (flag-gated via KERYX_ALLOW_REAL_SUBPROCESS=1, excluded from CI)",
  () => {
    test("a real command runs via node:child_process and completes", async () => {
      // Dynamic import INSIDE the (conditionally-skipped) test body: the
      // not-yet-existing `./real-process-adapter` module must never break
      // collection when the flag is unset (describe.skipIf still parses this
      // file, but never executes the body below in that case).
      const { RealProcessAdapter } = await import("./real-process-adapter");
      const adapter = new RealProcessAdapter();

      const observation = adapter.spawn({
        path: "/bin/echo",
        argv: ["echo", "keryx-real-subprocess-smoke"],
        env: {},
        cwd: process.cwd(),
      });

      expect(observation.kind).toBe("clean-exit");
    });

    test("a real timeout terminates the contained child (deadline enforced)", async () => {
      const { RealProcessAdapter } = await import("./real-process-adapter");
      // A short deadline far shorter than the command's sleep, so the real
      // adapter must terminate it before it naturally exits.
      const adapter = new RealProcessAdapter({ timeoutMs: 500 });

      const observation = adapter.spawn({
        path: "/bin/sh",
        argv: ["sh", "-c", "sleep 30"],
        env: {},
        cwd: process.cwd(),
      });

      expect(observation.kind).toBe("deadline-exceeded");
      // `spawnSync` kills and reaps the DIRECT child (leader-only); a full
      // process-group kill of grandchildren is a documented async follow-up.
      expect(observation.terminationMode).toBe("leader-only");
    });
  },
);

// Always-running guard (never skipped): PROVES (rather than asserts
// tautologically) that without the explicit opt-in flag no real adapter can
// ever be constructed — an OBSERVABLE capability-gate check, not a
// self-comparison. (Review-polish item G, flow 028/T5: the prior version of
// this guard compared `REAL_SUBPROCESS_FLAG` — itself defined as
// `process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1"` — against that exact same
// expression, so it always passed regardless of `RealProcessAdapter`'s actual
// behavior.) This dynamically imports `./real-process-adapter` (safe: by the
// time T6 lands, the module exists and importing it performs no spawn at
// import time — see that module's own header) and asserts the constructor's
// capability gate actually throws with no allow flag, proving zero real
// adapters are reachable. This is the assertion T7 (and CI) can rely on
// without needing to special-case bun's own skip-reporting output.
test("without KERYX_ALLOW_REAL_SUBPROCESS=1, RealProcessAdapter refuses to construct (capability gate proves inertness)", async () => {
  if (process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1") {
    // Explicit opt-in local/live run: the capability gate is intentionally
    // OPEN in this case, so the "must refuse" guard below does not apply.
    return;
  }
  const { RealProcessAdapter } = await import("./real-process-adapter");
  expect(() => new RealProcessAdapter({})).toThrow();
});
