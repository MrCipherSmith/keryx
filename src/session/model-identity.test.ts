import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireCandidateId, wireModelIdentity } from "./model-identity";
import { createNativeSessionRuntime } from "./native-runtime";
import { okReply, scriptedProvider } from "../commands/agent.test-helpers";
import { validateControl, type Control } from "../remote-control/protocol";

test("safe wire identities preserve actual local model selection and distinguish slash from punctuation", async () => {
  const first = wireModelIdentity("openrouter", "anthropic/claude-sonnet-4.5");
  const second = wireModelIdentity("openrouter", "anthropic.claude-sonnet-4.5");
  expect(first.modelId).not.toBe(second.modelId); expect(first.modelId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
  expect(wireModelIdentity("scripted", "m")).toEqual({ providerId: "scripted", modelId: "m" });
  const cwd = await mkdtemp(join(tmpdir(), "keryx-wire-model-")); const provider = scriptedProvider([okReply]); const digest = "a".repeat(64);
  const runtime = createNativeSessionRuntime({ cwd, provider: provider.provider, providerId: "openrouter", modelId: "anthropic/claude-sonnet-4.5" });
  const candidateId = wireCandidateId("openrouter", "anthropic/claude-sonnet-4.5");
  const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: candidateId, reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: [candidateId], fallbackCandidateId: candidateId }, policyDigest: digest, capabilityDigest: digest };
  try {
    const routing = runtime.routing(config); expect(validateControl("RoutingAvailability", routing.availability()).ok).toBe(true);
    const result = await runtime.run({ write() {} }, [], "hello", await routing.select("hello", config), {});
    expect(result.outcome).toBe("succeeded"); expect(provider.requests[0]?.modelId).toBe("anthropic/claude-sonnet-4.5");
    expect(runtime.modelBindings().some((binding) => binding.actualModelId === "anthropic/claude-sonnet-4.5" && binding.modelId === first.modelId)).toBe(true);
  } finally { await runtime.stop(); await rm(cwd, { recursive: true, force: true }); }
});

test("normalized alternate candidates require a retained local binding before they become selectable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-model-bindings-")); const primary = scriptedProvider([okReply]); const child = scriptedProvider([okReply]); const digest = "b".repeat(64);
  const alternate = wireModelIdentity("openrouter", "vendor/alternate");
  const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: "alternate", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["alternate"], fallbackCandidateId: "alternate" }, policyDigest: digest, capabilityDigest: digest };
  const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [{ candidateId: "alternate", ...alternate, reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" }] };
  const options = { cwd, provider: primary.provider, providerId: "openrouter", modelId: "vendor/primary", availability, resolveProvider: (_providerId: string, modelId: string) => { expect(modelId).toBe("vendor/alternate"); return child.provider; } };
  const unbound = createNativeSessionRuntime(options);
  const bound = createNativeSessionRuntime({ ...options, modelBindings: [{ actualProviderId: "openrouter", actualModelId: "vendor/alternate" }] });
  try {
    expect(unbound.routing(config).availability().candidates[0]?.available).toBe(false);
    expect(bound.routing(config).validate(config)).toBe(true);
    await bound.run({ write() {} }, [], "hello", await bound.routing(config).select("hello", config), {});
    expect(child.requests[0]?.modelId).toBe("vendor/alternate");
  } finally { await unbound.stop(); await bound.stop(); await rm(cwd, { recursive: true, force: true }); }
});
