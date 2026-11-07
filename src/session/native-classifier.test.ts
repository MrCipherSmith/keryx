import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeRoutingClassifier, type NativeRoutingSelection } from "./native-classifier";
import { scriptedProvider } from "../commands/agent.test-helpers";
import { approveProjectRouting, loadRouting, replaceRoutingLayer } from "../harness/routing/settings";
import type { RoutingConfigLayer } from "../harness/routing/config";
import type { Control } from "../remote-control/protocol";
const digest = "a".repeat(64);
const standard = "claude-sonnet-5"; const deep = "claude-opus-4-8";
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [standard, deep].map((modelId) => ({ candidateId: modelId, providerId: "anthropic", modelId,
  available: true, reason: "none", reasoningEfforts: ["none"], privacyClass: "approved-egress", costClass: "metered" })) };
const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: standard, reasoningEffort: "none", policyDigest: digest, capabilityDigest: digest,
  routing: { enabled: true, profileId: "local", candidateIds: [standard, deep], fallbackCandidateId: standard } };
const bindings = () => [standard, deep].map((modelId) => ({ providerId: "anthropic", modelId, actualProviderId: "anthropic", actualModelId: modelId }));

async function configureProjectRouting(cwd: string, override?: RoutingConfigLayer) {
  const project: RoutingConfigLayer = override ?? { schemaVersion: 2 as const,
    categories: { review: { mode: "class" as const, modelClass: "expert" as const } },
    classes: { expert: { selection: "priority" as const, fallbackClasses: [], candidates: [{ target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 }] } } };
  await replaceRoutingLayer("project", { cwd, configDir: cwd }, project);
  approveProjectRouting({ cwd, configDir: cwd });
}

/** A project that classifies every turn with the session model as classifier, and proven model facts. */
const AUTO_LAYER = { schemaVersion: 2 as const,
  categories: { default: { mode: "auto" as const }, coding: { mode: "auto" as const } },
  classes: { expert: { selection: "priority" as const, fallbackClasses: [], candidates: [{ target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 }] } },
  classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: standard } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" as const } } };
const PROVEN_FACTS = () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools" as const], contextLength: 200_000, cooldown: false, estimatedCostUsd: 0, observedLatencyMs: null });

test("production classifier composition uses the actual shared service with owned provider selection and reported usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-")); const script = scriptedProvider([[{ kind: "text_delta", text: "coding|expert|0.95|tools" }, { kind: "usage_update", usage: { inputTokens: 7, outputTokens: 1 } }, { kind: "model_end" }]]);
  try { await configureProjectRouting(cwd, AUTO_LAYER);
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings, modelFacts: PROVEN_FACTS, outputTokensReserved: 100,
      // The classifier runs on the session model; the selected executor is prepared but never streamed here.
      providerFactory: (providerId, modelId) => { expect(providerId).toBe("anthropic"); expect([standard, deep]).toContain(modelId); return script.provider; } });
    const effects: string[] = []; const usage: unknown[] = [];
    const result = await classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async (provider) => { effects.push(provider.candidateId); }, onUsage: (_provider, value) => usage.push(value) });
    expect(result).toMatchObject({ candidateId: deep });
    expect(script.requests).toHaveLength(1); expect(effects).toEqual([standard]); expect(usage).toEqual([{ inputTokens: 7, outputTokens: 1 }]);
    expect(script.requests[0]?.budget.maxOutputTokens).toBe(16);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("routing classifies once and preserves the classifier receipt in the journaled decision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-auto-"));
  const response = "coding|expert|0.95|tools";
  const script = scriptedProvider([[{ kind: "text_delta", text: response }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd, { schemaVersion: 2,
      categories: { default: { mode: "auto" }, coding: { mode: "auto" } },
      classes: { expert: { selection: "priority", fallbackClasses: [], candidates: [{ target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 }] } },
      classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: standard } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" } } });
    let authorizations = 0;
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider, outputTokensReserved: 100,
      modelFacts: () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools"], contextLength: 200_000, cooldown: false, estimatedCostUsd: 0, observedLatencyMs: null }) });
    const result = await classifier("Implement a difficult change", config, { signal: new AbortController().signal, beforeIo: async () => { authorizations++; }, onUsage() {} });
    expect(result).toEqual({ candidateId: deep, selectionReceiptId: expect.any(String), classifierReceiptId: expect.any(String) });
    expect(authorizations).toBe(1);
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]?.budget.maxOutputTokens).toBe(16);
    const journalDir = join(cwd, "routing", "journal");
    const entries = (await Promise.all((await readdir(journalDir)).map((file) => readFile(join(journalDir, file), "utf8")))).flatMap((body) => body.trim().split("\n"));
    expect(entries).toHaveLength(1);
    const selection = result as NativeRoutingSelection;
    expect(JSON.parse(entries[0]!)).toMatchObject({ kind: "dispatch", recommendationSource: "classifier",
      classifierReceiptId: selection.classifierReceiptId, decisionId: selection.selectionReceiptId });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test.each([
  ["zero cost cap", { maxAttempts: 3, selectionTimeoutMs: 3_000, maxEstimatedCostUsd: 0, unknownCost: "allow" as const }, 0.01, "routing-budget-exceeded"],
  ["unknown-cost denial", { maxAttempts: 3, selectionTimeoutMs: 3_000, maxEstimatedCostUsd: null, unknownCost: "deny" as const }, null, "routing-cost-unknown"],
])("routing refuses classifier I/O under %s", async (_label, execution, estimatedCostUsd, expectedCode) => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-budget-"));
  const response = "coding|expert|0.95|tools";
  const script = scriptedProvider([[{ kind: "text_delta", text: response }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd, { schemaVersion: 2,
      categories: { default: { mode: "auto" }, coding: { mode: "auto" } },
      classes: { expert: { selection: "priority", fallbackClasses: [], candidates: [{ target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 }] } },
      classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: standard } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" } },
      execution });
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider, outputTokensReserved: 100,
      modelFacts: () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools"], contextLength: 200_000, cooldown: false, estimatedCostUsd, observedLatencyMs: null }) });
    await expect(classifier("Implement a difficult change", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} }))
      .rejects.toMatchObject({ code: expectedCode, fatal: true });
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("routing charges classifier spend before admitting the selected model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-combined-budget-"));
  const script = scriptedProvider([[{ kind: "text_delta", text: "coding|expert|0.95|tools" }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd, { schemaVersion: 2,
      categories: { default: { mode: "auto" }, coding: { mode: "auto" } },
      classes: { expert: { selection: "priority", fallbackClasses: [], candidates: [{ target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 }] } },
      classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: standard } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" } },
      execution: { maxAttempts: 3, selectionTimeoutMs: 3_000, maxEstimatedCostUsd: 0.15, unknownCost: "allow" } });
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider, outputTokensReserved: 100,
      modelFacts: () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools"], contextLength: 200_000, cooldown: false, estimatedCostUsd: 0.1, observedLatencyMs: null }) });
    await expect(classifier("Implement a difficult change", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} }))
      .rejects.toMatchObject({ code: "routing-budget-exceeded", fatal: true });
    expect(script.requests).toHaveLength(1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("routing honors an explicit default assignment without classifier I/O", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-default-"));
  const script = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd, { schemaVersion: 2,
      categories: { default: { mode: "baseline" } },
      classifier: { chain: [{ adapterId: "model", target: { providerId: "anthropic", modelId: deep } }], timeoutMs: 2500, minConfidence: 0.7, onFailure: { mode: "baseline" } } });
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider, outputTokensReserved: 100,
      modelFacts: () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools"], contextLength: 200_000, cooldown: false, estimatedCostUsd: 0, observedLatencyMs: null }) });
    const result = await classifier("A task without a deterministic category", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} });
    expect(result).toEqual({ candidateId: standard, selectionReceiptId: expect.any(String) });
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("routing uses the shared resolver and returns its canonical selection receipt", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-"));
  const script = scriptedProvider([[{ kind: "text_delta", text: "review" }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd);
    expect(loadRouting(cwd, cwd)?.categories.review).toEqual({ mode: "class", modelClass: "expert" });
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider, outputTokensReserved: 100,
      modelFacts: () => ({ connected: true, credentialsAvailable: true, capabilities: ["tools"], contextLength: 200_000, cooldown: false, estimatedCostUsd: 0, observedLatencyMs: null }) });
    const result = await classifier("Review PR", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} });
    expect(result).toEqual({ candidateId: deep, selectionReceiptId: expect.any(String) });
    expect((result as { selectionReceiptId: string }).selectionReceiptId).toHaveLength(64);
    expect(script.requests).toHaveLength(0);
    const journalDir = join(cwd, "routing", "journal");
    const entries = (await Promise.all((await readdir(journalDir)).map((file) => readFile(join(journalDir, file), "utf8")))).flatMap((body) => body.trim().split("\n"));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toMatchObject({ kind: "dispatch", decisionId: (result as { selectionReceiptId: string }).selectionReceiptId });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Hub native routing admits the replacement when the preferred model cannot be prepared", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-fallback-"));
  const script = scriptedProvider([]);
  try {
    await configureProjectRouting(cwd, {
      schemaVersion: 2,
      categories: { review: { mode: "class", modelClass: "expert" } },
      classes: { expert: { selection: "priority", fallbackClasses: [], candidates: [
        { target: { providerId: "anthropic", modelId: deep }, enabled: true, priority: 10 },
        { target: { providerId: "anthropic", modelId: standard }, enabled: true, priority: 1 },
      ] } },
    });
    const prepared: string[] = [];
    const classifier = createNativeRoutingClassifier({
      cwd, configDir: cwd, env: {}, availability: () => availability, bindings, outputTokensReserved: 100,
      modelFacts: () => ({ capabilities: ["tools"], contextLength: 200_000, estimatedCostUsd: 0 }),
      providerFactory: (_providerId, modelId) => {
        prepared.push(modelId);
        if (modelId === deep) throw new Error("fixture: model unavailable");
        return script.provider;
      },
    });
    const result = await classifier("Review PR", config, {
      signal: new AbortController().signal,
      beforeIo: async () => { throw new Error("unexpected classifier I/O"); },
      onUsage() {},
    });
    expect(result).toEqual({ candidateId: standard, selectionReceiptId: expect.any(String) });
    expect(prepared).toEqual([deep, standard]);
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("an inconsistent routing snapshot fails before classifier I/O and is marked fatal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-routing-invalid-"));
  const script = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "model_end" }]]);
  try {
    await configureProjectRouting(cwd);
    const projectFile = join(cwd, "routing.config.json");
    const raw = JSON.parse(await readFile(projectFile, "utf8")) as Record<string, unknown>;
    await writeFile(projectFile, `${JSON.stringify({ ...raw, modelRouting: { schemaVersion: 2, categories: { review: { mode: "not-valid" } } } })}\n`);
    const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings,
      providerFactory: () => script.provider });
    const failure = classifier("Review PR", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} });
    await expect(failure).rejects.toMatchObject({ code: "routing-config-invalid", fatal: true });
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("shared classifier catch-all cannot turn authority refusal into a baseline provider effect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-deny-")); const script = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "model_end" }]]);
  try { await configureProjectRouting(cwd, AUTO_LAYER); const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, modelFacts: PROVEN_FACTS, env: { ANTHROPIC_API_KEY: "fixture" }, availability: () => availability, bindings, providerFactory: () => script.provider });
    await expect(classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => { throw new Error("actor-revoked"); }, onUsage() {} })).rejects.toThrow("classifier-authority-refused");
    expect(script.requests).toHaveLength(0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a cooperative real provider timeout falls back only after its classifier stream actually stops", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-timeout-")); let started = 0; let stopped = 0;
  const base = scriptedProvider([]).provider;
  try { await configureProjectRouting(cwd, AUTO_LAYER); const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, modelFacts: PROVEN_FACTS, env: {}, timeoutMs: 2500, availability: () => availability, bindings,
    providerFactory: () => ({ ...base, stream: (_request, options) => (async function* () { started++; try { await new Promise<void>((resolve) => { options.signal?.addEventListener("abort", () => resolve(), { once: true }); if (options.signal?.aborted) resolve(); }); } finally { stopped++; } })() }) });
    // The classifier failure falls back to the configured onFailure (the baseline), and only once its stream stopped.
    expect(await classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} })).toMatchObject({ candidateId: standard });
    expect(started).toBe(1); expect(stopped).toBe(1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("a classifier stream that cannot prove termination refuses admission instead of falling back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-classifier-unknown-")); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const base = scriptedProvider([]).provider;
  try { await configureProjectRouting(cwd, AUTO_LAYER); const classifier = createNativeRoutingClassifier({ cwd, configDir: cwd, modelFacts: PROVEN_FACTS, env: {}, timeoutMs: 2500, availability: () => availability, bindings,
    providerFactory: () => ({ ...base, stream: () => (async function* () { await held; })() }) });
    await expect(classifier("Help me handle this situation carefully", config, { signal: new AbortController().signal, beforeIo: async () => {}, onUsage() {} })).rejects.toThrow("classifier-stop-unconfirmed");
  } finally { release(); await rm(cwd, { recursive: true, force: true }); }
});
