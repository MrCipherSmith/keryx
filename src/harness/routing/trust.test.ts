// Flow 305 AC11 — project routing-table trust: content-hash approval keyed
// by project root, in the operator's own config directory. Mirrors
// `src/mcp-servers/trust.ts`'s design (see this module's own header).

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveProjectRouting,
  describeTableForApproval,
  isProjectRoutingApproved,
  loadRoutingTrustStore,
  revokeProjectRouting,
  routingTableFingerprint,
  routingTrustKey,
} from "./trust";
import type { RoutingTable } from "./table";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const TABLE: RoutingTable = { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } };

test("an empty table needs no approval — nothing for an operator to have seen", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  expect(isProjectRoutingApproved(cwd, {}, configDir)).toBe(true);
});

test("a non-empty table is unapproved until `approveProjectRouting` records it", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(false);
  const result = await approveProjectRouting(cwd, TABLE, configDir);
  expect(result.ok).toBe(true);
  expect(isProjectRoutingApproved(cwd, TABLE, configDir)).toBe(true);
});

test("editing the table (an actual category/assignment change) voids the approval", async () => {
  const cwd = await tempDir("keryx-routing-trust-cwd-");
  const configDir = await tempDir("keryx-routing-trust-cfg-");
  await approveProjectRouting(cwd, TABLE, configDir);
  const edited: RoutingTable = { review: { kind: "model", providerId: "anthropic", modelId: "claude-y" } };
  expect(isProjectRoutingApproved(cwd, edited, configDir)).toBe(false);
});

test("a pure reformat (key order) does NOT void the approval — fingerprint is over the VALIDATED table, not raw bytes", () => {
  const a = routingTableFingerprint({ review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } });
  // Same content, different construction order.
  const reordered: RoutingTable = { review: { modelId: "claude-x", kind: "model", providerId: "anthropic" } as never };
  const b = routingTableFingerprint(reordered);
  expect(a).toBe(b);
});

test("two categories in a different insertion order still fingerprint identically", () => {
  const a = routingTableFingerprint({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
  });
  const b = routingTableFingerprint({
    quick: { kind: "provider-default", providerId: "deepseek" },
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
  });
  expect(a).toBe(b);
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

test("describeTableForApproval: one readable line per category, sorted", () => {
  const lines = describeTableForApproval({
    review: { kind: "model", providerId: "anthropic", modelId: "claude-x" },
    quick: { kind: "provider-default", providerId: "deepseek" },
  });
  expect(lines).toEqual(["quick: deepseek (provider default)", "review: anthropic/claude-x"]);
});
