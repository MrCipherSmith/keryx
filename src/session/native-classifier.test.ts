import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeRoutingClassifier } from "./native-classifier";
import { scriptedProvider } from "../commands/agent.test-helpers";
import { saveRoutingConfig } from "../harness/routing/config";
import type { Control } from "../remote-control/protocol";
const digest = "a".repeat(64);
const standard = "claude-sonnet-5"; const deep = "claude-opus-4-8";
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [standard, deep].map((modelId) => ({ candidateId: modelId, providerId: "anthropic", modelId,
  available: true, reason: "none", reasoningEfforts: ["none"], privacyClass: "approved-egress", costClass: "metered" })) };
const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: standard, reasoningEffort: "none", policyDigest: digest, capabilityDigest: digest,
  routing: { enabled: true, profileId: "local", candidateIds: [standard, deep], fallbackCandidateId: standard } };
const bindings = () => [standard, deep].map((modelId) => ({ providerId: "anthropic", modelId, actualProviderId: "anthropic", actualModelId: modelId }));

test("production classifier composition uses the actual shared service with owned provider selection and reported usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-")); const script = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "usage_update", usage: { inputTokens: 7, outputTokens: 1 } }, { kind: "model_end" }]]);
  try { await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: deep } });
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: (providerId, modelId) => { expect(providerId).toBe("anthropic"); expect(modelId).toBe(standard); return script.provider; } });
    const effects: string[] = []; const usage: unknown[] = [];
    expect(await classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async (provider) => { effects.push(provider.candidateId); }, onUsage: (_provider, value) => usage.push(value) })).toBe(deep);
    expect(script.requests).toHaveLength(1); expect(effects).toEqual([standard]); expect(usage).toEqual([{ inputTokens: 7, outputTokens: 1 }]);
    expect(script.requests[0]?.budget.maxOutputTokens).toBe(16);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("shared classifier catch-all cannot turn authority refusal into a baseline provider effect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-deny-")); const script = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "model_end" }]]);
  try { const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings, providerFactory: () => script.provider });
    await expect(classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => { throw new Error("actor-revoked"); }, onUsage() {} })).rejects.toThrow("classifier-authority-refused");
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a cooperative real provider timeout falls back only after its classifier stream actually stops", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-timeout-")); let started = 0; let stopped = 0;
  const base = scriptedProvider([]).provider;
  try { const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: {}, timeoutMs: 20, availability: () => availability, bindings,
    providerFactory: () => ({ ...base, stream: (_request, options) => (async function* () { started++; try { await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }); if (options.signal?.aborted) resolve(); }); } finally { stopped++; } })() }) });
    expect(await classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} })).toBeUndefined();
    expect(started).toBe(1); expect(stopped).toBe(1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a classifier stream that cannot prove termination refuses admission instead of falling back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-unknown-")); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const base = scriptedProvider([]).provider;
  try { const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: {}, timeoutMs: 10, availability: () => availability, bindings,
    providerFactory: () => ({ ...base, stream: () => (async function* () { await held; })() }) });
    await expect(classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} })).rejects.toThrow("classifier-stop-unconfirmed");
  } finally { release(); await rm(cwd, { recursive: true, force: true }); }
});
