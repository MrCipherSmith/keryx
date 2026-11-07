import { expect, test } from "bun:test";
import Ajv from "ajv";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLargeReviewConfig } from "./config";

async function published(): Promise<{ config: Record<string, unknown>; plan: Record<string, unknown>; state: Record<string, unknown> }> {
  const root = path.resolve("docs/requirements/keryx-revview-v3/schemas");
  const read = async (name: string) => JSON.parse(await readFile(path.join(root, name), "utf8")) as Record<string, unknown>;
  return { config: await read("review-agents-config.schema.json"), plan: await read("review-agents-plan.schema.json"), state: await read("review-agents-state.schema.json") };
}

test("published schemas validate versioned config, plan and state contracts", async () => {
  const schema = await published(); const ajv = new Ajv(); ajv.addSchema(schema.config);
  const config = createLargeReviewConfig({ allowedAdapters: ["fake"] });
  expect(ajv.getSchema("https://keryx.dev/schemas/review-agents-config.schema.json")?.(config)).toBe(true);
  const plan = {
    planHash: "a".repeat(64), planVersion: 1, revision: "abc", waves: [{ waveId: "wave-1", reviewRound: 1 }],
    assignments: [{ taskId: "task", entity: "review-worker", role: "worker", scopeIds: ["scope"], waveId: "wave-1", coverage: [{ scopeId: "scope", aspect: "logic" }] }],
  };
  expect(ajv.compile(schema.plan)(plan)).toBe(true);
  const state = {
    schemaVersion: 1, runId: "run", revision: "abc", config, status: "active",
    createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z",
    controllerLease: { ownerId: "owner", fencingToken: "token", expiresAt: "2026-11-05T00:01:00.000Z" },
    activePlan: null, highestReviewRound: 0, usedLaunches: 0, outsideWaveLaunches: 0,
    usedActiveAgentTimeMs: 0, reservedAgentTimeMs: 0, waveLaunches: {}, registeredWaves: {}, assignments: {}, idempotency: {}, results: {}, coverage: {},
  };
  expect(ajv.compile(schema.state)(state)).toBe(true);
});

test("published schemas reject malformed artifacts", async () => {
  const schema = await published(); const ajv = new Ajv(); ajv.addSchema(schema.config);
  const invalidConfig = structuredClone(createLargeReviewConfig());
  (invalidConfig.roleCeilings.worker as { elapsedMs: number }).elapsedMs = -1;
  expect(ajv.getSchema("https://keryx.dev/schemas/review-agents-config.schema.json")?.(invalidConfig)).toBe(false);
  expect(ajv.compile(schema.plan)({ planHash: "bad", planVersion: 1, revision: "abc", waves: [], assignments: [] })).toBe(false);
  expect(ajv.compile(schema.state)({ schemaVersion: 1 })).toBe(false);
});
