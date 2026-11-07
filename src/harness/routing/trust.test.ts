// Flow 305 AC11 — project routing-table trust: content-hash approval keyed
// by project root, in the operator's own config directory. Mirrors
// `src/mcp-servers/trust.ts`'s design (see this module's own header).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveProjectRouting,
  describeLayerForApproval,
  isProjectRoutingApproved,
  loadRoutingTrustStore,
  revokeProjectRouting,
  routingLayerFingerprint,
  routingTrustKey,
} from "./trust";
import type { RoutingConfigLayer } from "./config";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const TABLE: RoutingConfigLayer = { schemaVersion: 2, categories: { review: { mode: "model", target: { providerId: "anthropic", modelId: "claude-x" } } } };

test("an empty layer needs no approval — nothing for an operator to have seen", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  expect(isProjectRoutingApproved(cwd, { schemaVersion: 2 }, configDir)).toBe(true);
  expect(isProjectRoutingApproved(cwd, undefined, configDir)).toBe(true);
});

test("a non-empty table is unapproved until `approveProjectRouting` records it", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(false);
  const result = await approveProjectRouting(cwd, TABLE, configDir);
  expect(result.ok).toBe(true);
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(true);
});

test("editing the layer (a category, class, provider or execution change) voids the approval", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  await approveProjectRouting(cwd, TABLE, configDir);
  const edited: RoutingConfigLayer = { schemaVersion: 2, categories: { review: { mode: "model", target: { providerId: "anthropic", modelId: "claude-y" } } } };
  expect(isProjectRoutingApproved(cwd, edited, configDir)).toBe(false);
  expect(isProjectRoutingApproved(cwd, { ...TABLE, execution: { maxAttempts: 1, selectionTimeoutMs: 1000, maxEstimatedCostUsd: null, unknownCost: "allow" } }, configDir)).toBe(false);
  expect(isProjectRoutingApproved(cwd, { ...TABLE, providers: { scope: "allowlist", allowlist: ["x"], preferSessionProvider: false } }, configDir)).toBe(false);
});

test("a pure reformat (key order) does NOT void the approval — fingerprint is over the VALIDATED layer, not raw bytes", () => {
  const a = routingLayerFingerprint(TABLE);
  const reordered = { categories: { review: { target: { modelId: "claude-x", providerId: "anthropic" }, mode: "model" } }, schemaVersion: 2 } as unknown as RoutingConfigLayer;
  expect(routingLayerFingerprint(reordered)).toBe(a);
});

test("approval is keyed by PROJECT ROOT — two different projects with the same table content are independently approved", async () => {
  const cwdA = await tempDir("keryx-routing-trust-a-");
  const cwdB = await tempDir("keryx-routing-trust-b-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  await approveProjectRouting(cwdA, TABLE, configDir);
  expect(isProjectRoutingApproved(cwdA, TABLE, configDir)).toBe(true);
  expect(isProjectRoutingApproved(cwdB, TABLE, configDir)).toBe(false);
});

test("routingTrustKey normalizes to an absolute path — a relative cwd and its absolute form key the same", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  expect(routingTrustKey(cwd)).toBe(path.resolve(cwd));
});

test("revokeProjectRouting withdraws approval", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  await approveProjectRouting(cwd, TABLE, configDir);
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(true);
  await revokeProjectRouting(cwd, configDir);
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(false);
});

test("loadRoutingTrustStore: an unreadable/corrupt store grants nothing (fail closed)", async () => {
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(configDir, "routing-config-trust.json"), "not json", "utf8");
  expect(loadRoutingTrustStore(configDir)).toEqual({});
});

test("describeLayerForApproval: one readable line per category, sorted, then every other setting", () => {
  const lines = describeLayerForApproval({
    schemaVersion: 2,
    categories: {
      review: { mode: "model", target: { providerId: "anthropic", modelId: "claude-x" } },
      quick: { mode: "class", modelClass: "light" },
    },
    providers: { scope: "session-only", allowlist: [], preferSessionProvider: true },
  });
  expect(lines).toEqual([
    "quick: class light",
    "review: anthropic/claude-x",
    'providers: {"scope":"session-only","allowlist":[],"preferSessionProvider":true}',
  ]);
});
