import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLargeReviewConfig } from "./config";
import {
  REVIEW_V3_STATE_FILE,
  acquireReviewV3ControllerLease,
  createReviewV3State,
  mutateReviewV3State,
  readReviewV3State,
  validateReviewV3State,
} from "./store";
import type { ReviewV3RunState } from "./types";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "keryx-review-v3-store-")); roots.push(value); return value;
}

function state(): ReviewV3RunState {
  return {
    schemaVersion: 1,
    runId: "run-1",
    revision: "deadbeef",
    config: createLargeReviewConfig({ allowedAdapters: ["fake"] }),
    status: "active",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    controllerLease: { ownerId: "bootstrap", fencingToken: "bootstrap-token", expiresAt: "1970-01-01T00:00:00.000Z" },
    usedLaunches: 0,
    outsideWaveLaunches: 0,
    usedActiveAgentTimeMs: 0,
    reservedAgentTimeMs: 0,
    waveLaunches: {},
    registeredWaves: {},
    activePlan: null,
    highestReviewRound: 0,
    assignments: {},
    idempotency: {},
    results: {},
    coverage: {},
  };
}

test("deep validation rejects counter and assignment tampering", () => {
  const negative = structuredClone(state()); negative.usedLaunches = -1;
  expect(() => validateReviewV3State(negative)).toThrow("usedLaunches");

  const mismatched = structuredClone(state()); mismatched.usedLaunches = 1;
  expect(() => validateReviewV3State(mismatched)).toThrow("launch counters");

  const malformed = structuredClone(state());
  malformed.assignments.child = {
    dispatchId: "different", taskId: "task", task: "task", attempt: 1, idempotencyKey: "task\0attempt",
    entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: [], budgetClass: "ordinary",
    depth: 1, status: "queued", children: [], reservationMs: 1, requestedRuntimeMs: 1, selectedModelRounds: 1, usedActiveMs: 0,
    createdAt: malformed.createdAt, updatedAt: malformed.updatedAt,
  };
  expect(() => validateReviewV3State(malformed)).toThrow("dispatchId must match");
});

test("deep validation rejects inconsistent results and coverage", () => {
  const value = structuredClone(state());
  value.assignments.worker = {
    dispatchId: "worker", taskId: "task", task: "task", attempt: 1, idempotencyKey: "task\0attempt",
    entity: "review-worker", role: "worker", adapterId: "fake", scopeIds: ["scope-a"], budgetClass: "ordinary",
    depth: 1, status: "failed", children: [], reservationMs: 0, requestedRuntimeMs: 1, selectedModelRounds: 1, usedActiveMs: 2,
    createdAt: value.createdAt, updatedAt: value.updatedAt, error: "failed",
  };
  value.idempotency["task\0attempt"] = "worker"; value.usedLaunches = 1; value.outsideWaveLaunches = 1; value.usedActiveAgentTimeMs = 2;
  value.coverage["scope-a\0logic"] = {
    key: "scope-a\0logic", scopeId: "scope-a", aspect: "logic", dispatchId: "worker",
    status: "result", evidence: ["claimed"], recordedAt: value.updatedAt,
  };
  expect(() => validateReviewV3State(value)).toThrow("claims a result");
});

test("controller lease fences stale and competing writers", async () => {
  const storageDir = await root(); await createReviewV3State(storageDir, state());
  const first = await acquireReviewV3ControllerLease(storageDir, "owner-a", 100, { now: () => 1_000, token: () => "token-a1" });
  expect(first.fencingToken).toBe("token-a1");
  await expect(acquireReviewV3ControllerLease(storageDir, "owner-b", 100, { now: () => 1_050, token: () => "token-b" })).rejects.toThrow("owned by owner-a");

  const rotated = await acquireReviewV3ControllerLease(storageDir, "owner-a", 100, { now: () => 1_050, token: () => "token-a2" });
  expect(rotated.fencingToken).toBe("token-a2");
  await expect(mutateReviewV3State(storageDir, "token-a1", () => undefined, 1_051)).rejects.toThrow("lease is stale");
  await mutateReviewV3State(storageDir, "token-a2", (current) => { current.updatedAt = "1970-01-01T00:00:01.051Z"; }, 1_051);

  const successor = await acquireReviewV3ControllerLease(storageDir, "owner-b", 100, { now: () => 1_151, token: () => "token-b" });
  expect(successor.state.controllerLease.ownerId).toBe("owner-b");
  await expect(mutateReviewV3State(storageDir, "token-a2", () => undefined, 1_152)).rejects.toThrow("lease is stale");
});

test("invalid mutation never replaces durable state", async () => {
  const storageDir = await root(); await createReviewV3State(storageDir, state());
  await acquireReviewV3ControllerLease(storageDir, "owner", 100, { now: () => 1_000, token: () => "valid-token" });
  const before = await readFile(path.join(storageDir, REVIEW_V3_STATE_FILE), "utf8");
  await expect(mutateReviewV3State(storageDir, "valid-token", (current) => { current.reservedAgentTimeMs = -1; }, 1_001)).rejects.toThrow("reservedAgentTimeMs");
  expect(await readFile(path.join(storageDir, REVIEW_V3_STATE_FILE), "utf8")).toBe(before);
});

test("read refuses malformed state loaded from disk", async () => {
  const storageDir = await root(); await createReviewV3State(storageDir, state());
  const tampered = structuredClone(state()); tampered.idempotency.orphan = "missing";
  await writeFile(path.join(storageDir, REVIEW_V3_STATE_FILE), JSON.stringify(tampered));
  await expect(readReviewV3State(storageDir)).rejects.toThrow("idempotency.orphan");
});
