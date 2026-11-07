import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Control } from "../../remote-control/protocol";
import { ROUTING_CATEGORIES } from "../../harness/routing/table";
import { normalizeRoutingConfig } from "../../harness/routing/config";
import { executeRoutingCategories, previewNativeRoutingCategories, routingCategoryCommands, sessionRoutingProviders } from "./routing-categories";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = "a".repeat(64);
const candidate = (candidateId: string, providerId: string, modelId: string, available = true): Control["RoutingAvailability"]["candidates"][number] => ({ candidateId, providerId, modelId,
  reasoningEfforts: ["none"], available, reason: available ? "none" : "not-connected", privacyClass: "approved-egress", costClass: "metered" });
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"],
  candidates: [candidate("c1", "fixture-local", "fixture-model"), candidate("c2", "openrouter", "vendor-model-x"), candidate("c3", "gone", "m", false)] };
const bindings = [{ providerId: "fixture-local", modelId: "fixture-model", actualProviderId: "fixture-local", actualModelId: "fixture-model" },
  { providerId: "openrouter", modelId: "vendor-model-x", actualProviderId: "openrouter", actualModelId: "vendor/model-x" }];
const sessionConfig: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: "c1", reasoningEffort: "none",
  routing: { enabled: true, profileId: "local", candidateIds: ["c2"], fallbackCandidateId: "c1" }, policyDigest: digest, capabilityDigest: digest };

test("the session's reachable providers are its available candidates under their actual identities; the baseline is the session model", () => {
  expect(sessionRoutingProviders(availability, bindings, "c2")).toEqual({ providers: [{ name: "fixture-local", models: ["fixture-model"] }, { name: "openrouter", models: ["vendor/model-x"] }],
    session: { providerId: "openrouter", modelId: "vendor/model-x" } });
});

test("routing.categories resolves every category through the routing settings; a user pin the session cannot reach is refused, never silently replaced", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "native-routing-categories-")); roots.push(cwd); const configDir = path.join(cwd, "config");
  const result = await executeRoutingCategories({ cwd, configDir, availability, bindings, baselineCandidateId: "c1", sessionConfig }, {});
  expect(result.ok).toBe(true); if (!result.ok) return;
  const data = result.data as { categories: { category: string; decision: { status: string; assignmentSource: string } }[]; lines: string[] };
  expect(data.categories.map((row) => row.category)).toEqual([...ROUTING_CATEGORIES]);
  expect(data.lines).toHaveLength(ROUTING_CATEGORIES.length);
  for (const row of data.categories) expect(row.decision.assignmentSource).toBe("builtin");
  // A user-layer pin (here still in the legacy table shape) to a provider the session cannot reach is refused.
  const { mkdir } = await import("node:fs/promises"); await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "auth.json"), JSON.stringify({ routing: { review: { kind: "model", providerId: "elsewhere", modelId: "m" } } }));
  const pinned = await executeRoutingCategories({ cwd, configDir, availability, bindings, baselineCandidateId: "c1", sessionConfig }, {});
  expect(pinned.ok).toBe(true); if (!pinned.ok) return;
  const review = (pinned.data as { categories: { category: string; decision: { status: string; assignmentSource: string } }[] }).categories.find((row) => row.category === "review");
  expect(review?.decision).toMatchObject({ status: "blocked", assignmentSource: "user" });
  // Malformed settings are a read failure, not a baseline preview.
  await writeFile(path.join(configDir, "auth.json"), JSON.stringify({ modelRouting: { schemaVersion: 2, categories: { review: { mode: "sideways" } } } }));
  expect(await executeRoutingCategories({ cwd, configDir, availability, bindings, baselineCandidateId: "c1", sessionConfig }, {})).toMatchObject({ ok: false, error: { code: "read-failed" } });
  expect(await executeRoutingCategories({ cwd, availability, bindings, baselineCandidateId: "c1" }, { extra: 1 })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(routingCategoryCommands()[0]!.entry).toMatchObject({ commandName: "routing.categories", mutationClass: "read", busyPolicy: "read-only", availability: "available" });
});

test("category preview resolves every row through one frozen native snapshot", () => {
  const config = normalizeRoutingConfig({ user: { schemaVersion: 2, categories: {
    review: { mode: "model", target: { providerId: "openrouter", modelId: "vendor/model-x" } },
  } } });
  const data = previewNativeRoutingCategories({ availability, bindings, sessionConfig }, config) as {
    snapshotDigest: string;
    categories: Array<{ category: string; decision: { status: string; selection?: { providerId: string; modelId: string } } }>;
    lines: string[];
  };
  expect(data).not.toHaveProperty("engineVersion");
  expect(data.snapshotDigest).toHaveLength(64);
  expect(data.categories).toHaveLength(ROUTING_CATEGORIES.length);
  expect(data.categories.find((row) => row.category === "review")?.decision).toMatchObject({
    status: "selected",
    selection: { providerId: "openrouter", modelId: "vendor/model-x" },
  });
  expect(data.lines.find((line) => line.startsWith("review"))).toContain("openrouter/vendor/model-x");
});
