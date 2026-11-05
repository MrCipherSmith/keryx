import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLargeReviewConfig } from "./config";
import { createReviewV3Deadline, reviewV3AbortableDelay, startReviewV3LeaseHeartbeat } from "./lifecycle";
import { acquireReviewV3ControllerLease, createReviewV3State, readReviewV3State } from "./store";
import type { ReviewV3RunState } from "./types";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function tempRoot(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "keryx-v3-lifecycle-")); roots.push(value); return value; }
function state(): ReviewV3RunState {
  return {
    schemaVersion: 1, runId: "run", revision: "rev", config: createLargeReviewConfig({ allowedAdapters: ["fake"] }), status: "active",
    createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z",
    controllerLease: { ownerId: "bootstrap", fencingToken: "bootstrap", expiresAt: "1970-01-01T00:00:00.000Z" },
    usedLaunches: 0, outsideWaveLaunches: 0, usedActiveAgentTimeMs: 0, reservedAgentTimeMs: 0,
    waveLaunches: {}, registeredWaves: {}, activePlan: null, highestReviewRound: 0, assignments: {}, idempotency: {}, results: {}, coverage: {},
  };
}

test("assignment elapsed deadline continues while a coordinator may be waiting", async () => {
  const expired: string[] = [];
  createReviewV3Deadline({ assignmentRemainingMs: 30, runRemainingMs: 100, onExpire: (kind) => { expired.push(kind); } });
  await Bun.sleep(35);
  expect(expired).toEqual(["assignment"]);
});

test("run deadline fires first and stop is idempotent", async () => {
  const expired: string[] = [];
  const deadline = createReviewV3Deadline({ assignmentRemainingMs: 100, runRemainingMs: 10, onExpire: (kind) => { expired.push(kind); } });
  await Bun.sleep(20); deadline.stop(); deadline.stop();
  expect(expired).toEqual(["run"]);
});

test("abortable polling removes listeners after timer and abort", async () => {
  const controller = new AbortController(); const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal); const originalRemove = signal.removeEventListener.bind(signal);
  let adds = 0; let removes = 0;
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => { adds += 1; return originalAdd(...args); }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => { removes += 1; return originalRemove(...args); }) as AbortSignal["removeEventListener"];
  await reviewV3AbortableDelay(1, signal); expect([adds, removes]).toEqual([1, 1]);
  const waiting = reviewV3AbortableDelay(1_000, signal); controller.abort(new Error("stop"));
  await expect(waiting).rejects.toThrow("stop"); expect([adds, removes]).toEqual([2, 2]);
});

test("lease heartbeat renews the same fencing token and reports takeover", async () => {
  const storageDir = await tempRoot(); await createReviewV3State(storageDir, state());
  await acquireReviewV3ControllerLease(storageDir, "owner-a", 100, { now: () => 1_000, token: () => "token-a" });
  let now = 1_010; let renewed = 0; const failures: unknown[] = [];
  const heartbeat = startReviewV3LeaseHeartbeat({
    storageDir, ownerId: "owner-a", fencingToken: "token-a", leaseMs: 100, intervalMs: 90, now: () => now,
    onRenew: () => { renewed += 1; }, onFailure: (error) => { failures.push(error); },
  });
  await heartbeat.renewNow(); expect(renewed).toBe(1); expect((await readReviewV3State(storageDir)).controllerLease.expiresAt).toBe("1970-01-01T00:00:01.110Z");
  await acquireReviewV3ControllerLease(storageDir, "owner-b", 100, { now: () => 1_111, token: () => "token-b" }); now = 1_112;
  await expect(heartbeat.renewNow()).rejects.toThrow("stale"); expect(failures).toHaveLength(1); heartbeat.stop();
});
