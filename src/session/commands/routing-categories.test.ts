import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Control } from "../../remote-control/protocol";
import { ROUTING_CATEGORIES } from "../../harness/routing/table";
import { executeRoutingCategories, routingCategoryCommands, sessionRoutingProviders } from "./routing-categories";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = "a".repeat(64);
const candidate = (candidateId: string, providerId: string, modelId: string, available = true): Control["RoutingAvailability"]["candidates"][number] => ({ candidateId, providerId, modelId,
  reasoningEfforts: ["none"], available, reason: available ? "none" : "not-connected", privacyClass: "approved-egress", costClass: "metered" });
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"],
  candidates: [candidate("c1", "fixture-local", "fixture-model"), candidate("c2", "openrouter", "vendor-model-x"), candidate("c3", "gone", "m", false)] };
const bindings = [{ providerId: "fixture-local", modelId: "fixture-model", actualProviderId: "fixture-local", actualModelId: "fixture-model" },
  { providerId: "openrouter", modelId: "vendor-model-x", actualProviderId: "openrouter", actualModelId: "vendor/model-x" }];

test("the session's reachable providers are its available candidates under their actual identities; the baseline is the session model", () => {
  expect(sessionRoutingProviders(availability, bindings, "c2")).toEqual({ providers: [{ name: "fixture-local", models: ["fixture-model"] }, { name: "openrouter", models: ["vendor/model-x"] }],
    session: { providerId: "openrouter", modelId: "vendor/model-x" } });
});

test("routing.categories resolves every category through the shared layers, a pinned user entry against what the session can reach", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "native-routing-categories-")); roots.push(cwd); const configDir = path.join(cwd, "config");
  const result = await executeRoutingCategories({ cwd, configDir, availability, bindings, baselineCandidateId: "c1" }, {});
  expect(result.ok).toBe(true); if (!result.ok) return;
  const data = result.data as { categories: { category: string; source: string }[]; lines: string[]; derivedFrom: string };
  expect(data.categories.map((row) => row.category)).toEqual([...ROUTING_CATEGORIES]);
  expect(data.derivedFrom).toBe("fixture-local"); expect(data.lines).toHaveLength(ROUTING_CATEGORIES.length);
  // A user-layer pin to a provider the session cannot reach is rejected and falls back, with the CLI's notice.
  const { mkdir } = await import("node:fs/promises"); await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "auth.json"), JSON.stringify({ routing: { review: { kind: "model", providerId: "elsewhere", modelId: "m" } } }));
  const pinned = await executeRoutingCategories({ cwd, configDir, availability, bindings, baselineCandidateId: "c1" }, {});
  expect(pinned.ok && (pinned.data as { categories: { category: string; rejected?: unknown }[] }).categories.find((row) => row.category === "review")?.rejected).toMatchObject({ source: "user" });
  expect(await executeRoutingCategories({ cwd, availability, bindings, baselineCandidateId: "c1" }, { extra: 1 })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(routingCategoryCommands()[0]!.entry).toMatchObject({ commandName: "routing.categories", mutationClass: "read", busyPolicy: "read-only", availability: "available" });
});
