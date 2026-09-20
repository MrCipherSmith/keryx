import { describe, expect, test } from "bun:test";
import { leaveBusThenRelease, performSlateExit, type SlateExitSteps } from "./shell-exit";

// Flow 277 (P2). The TUI exit sequence used to be four hand-maintained copies
// inside `launchTuiAgentShell`, each pinned by a source-text audit that
// searched `tui-shell.ts` for the calls and compared their character offsets.
//
// Offsets cannot express the thing that actually matters — that the steps
// RUN in that order — and they cannot tell a justified difference between two
// copies from a regression in one of them. These do both.

/** Records the order steps actually run in, so the assertions are about sequence. */
function recordingSteps(log: string[], overrides: Partial<SlateExitSteps> = {}): SlateExitSteps {
  return {
    closeSlate: async () => {
      log.push("closeSlate");
    },
    sweepJobs: async () => {
      log.push("sweepJobs");
    },
    purgeJobList: () => log.push("purgeJobList"),
    leaveBus: () => log.push("leaveBus"),
    releaseLease: () => log.push("releaseLease"),
    detachRenderer: () => log.push("detachRenderer"),
    destroyRenderer: () => log.push("destroyRenderer"),
    ...overrides,
  };
}

describe("leaveBusThenRelease — the rule all four exit paths share (specification §5.4)", () => {
  test("the bus is left before the lease is released", () => {
    const log: string[] = [];
    leaveBusThenRelease({
      leaveBus: () => log.push("leaveBus"),
      releaseLease: () => log.push("releaseLease"),
    });
    expect(log).toEqual(["leaveBus", "releaseLease"]);
  });

  test("BOUNDARY — and the assertion is about order, not about both being called", () => {
    // Without this the test above would pass for an implementation that ran
    // them in either order, since both names would appear either way.
    const log: string[] = [];
    leaveBusThenRelease({
      leaveBus: () => log.push("leaveBus"),
      releaseLease: () => log.push("releaseLease"),
    });
    expect(log.indexOf("leaveBus")).toBeLessThan(log.indexOf("releaseLease"));
  });

  test("a bus that was never joined is not an error — the call is optional at every site", () => {
    // Production passes `() => liveBus?.leave()`. A session that never joined
    // must still release its lease.
    const log: string[] = [];
    leaveBusThenRelease({
      leaveBus: () => {},
      releaseLease: () => log.push("releaseLease"),
    });
    expect(log).toEqual(["releaseLease"]);
  });
});

describe("performSlateExit — the sequence the two command-driven exits share", () => {
  test("runs every step exactly once, in the documented order", async () => {
    const log: string[] = [];
    await performSlateExit(recordingSteps(log));
    expect(log).toEqual([
      "closeSlate",
      "sweepJobs",
      "purgeJobList",
      "leaveBus",
      "releaseLease",
      "detachRenderer",
      "destroyRenderer",
    ]);
  });

  test("the slate is closed before the lease is released (flow 271 AC7)", async () => {
    // The slate's last write has to land while the session is still ours.
    const log: string[] = [];
    await performSlateExit(recordingSteps(log));
    expect(log.indexOf("closeSlate")).toBeLessThan(log.indexOf("releaseLease"));
  });

  test("jobs are swept before the list is purged (flow 173 F-002)", async () => {
    // Reversed, the sweep finds an empty registry and every tracked process
    // group outlives the session as an unsandboxed orphan. That is the defect
    // F-002 was opened for.
    const log: string[] = [];
    await performSlateExit(recordingSteps(log));
    expect(log.indexOf("sweepJobs")).toBeLessThan(log.indexOf("purgeJobList"));
  });

  test("the renderer is torn down last", async () => {
    const log: string[] = [];
    await performSlateExit(recordingSteps(log));
    expect(log.at(-1)).toBe("destroyRenderer");
    expect(log.indexOf("destroyRenderer")).toBeGreaterThan(log.indexOf("releaseLease"));
  });

  test("each async step is AWAITED, not fired and forgotten", async () => {
    // The ordering assertions above would all hold for an implementation that
    // started `closeSlate` and moved on without waiting — the pushes would
    // just land later. This pins the await: a slow `closeSlate` must still
    // have finished before `sweepJobs` starts.
    const log: string[] = [];
    await performSlateExit(
      recordingSteps(log, {
        closeSlate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          log.push("closeSlate");
        },
      }),
    );
    expect(log[0]).toBe("closeSlate");
    expect(log[1]).toBe("sweepJobs");
  });

  test("BOUNDARY — a step that throws stops the sequence rather than silently skipping ahead", async () => {
    // Exit paths that swallow a failure mid-teardown are how a lease survives
    // a crash. If this ever becomes best-effort per step, it should be a
    // deliberate change with its own test, not a silent one.
    const log: string[] = [];
    const boom = new Error("sweep failed");
    await expect(
      performSlateExit(
        recordingSteps(log, {
          sweepJobs: async () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toThrow("sweep failed");
    expect(log).toEqual(["closeSlate"]);
  });
});
