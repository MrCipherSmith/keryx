// Flow 338, AC6/AC8. Hermetic: fake `fetch` for Jev, a temp dir for the
// routing config layers, no real network.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRoutingClassifierForTurn, renderRoutingFallbackLine, renderRoutingTagLine, renderRoutingSidebarValue, renderRoutingUsageLine } from "./routing-classifier-source";
import { approveProjectRouting } from "../harness/routing/trust";
import { saveRoutingConfig } from "../harness/routing/config";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-routing-classifier-source-"));
}

const ENV_WITH_KEY = { ANTHROPIC_API_KEY: "test-only", OPENROUTER_API_KEY: "sk-or-test" } as const;

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

test("runRoutingClassifierForTurn: disabled routing never classifies", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: false,
    jevEnabled: true,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: ENV_WITH_KEY,
    userConfigDir: cwd,
  });
  expect(result).toBeUndefined();
});

test("runRoutingClassifierForTurn: a deterministic 'review' shortcut resolves through the routing table to the configured model", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "anthropic", modelId: "claude-strong" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x", "claude-strong"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: { ANTHROPIC_API_KEY: "test-only" },
    userConfigDir: cwd,
  });
  expect(result?.category).toBe("review");
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-strong" });
  const tag = result !== undefined ? renderRoutingTagLine(result) : undefined;
  expect(tag).toBe("[review -> anthropic/claude-strong] (deterministic 100%)");
});

test("runRoutingClassifierForTurn: no project/user config AND no derivable profile data (unknown model ids, no curated/stored profile) resolves to session-default — nothing routed", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true,
    jevEnabled: false,
    cwd,
    // Two UNKNOWN ids (not in the curated seed, nothing stored) — the
    // `derived` layer's `comparable` filter (`deriveDefaultTable`) drops
    // both for having no profile, so it derives nothing and resolution
    // still falls all the way through to `default`. A single detected
    // model would instead hit `deriveDefaultTable`'s "one model" branch and
    // derive a same-as-session assignment — see the dedicated test below.
    detected: [{ name: "anthropic", models: ["claude-x", "claude-y"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: { ANTHROPIC_API_KEY: "test-only" },
    userConfigDir: cwd,
  });
  expect(result?.category).toBe("review");
  expect(result?.routed).toBeUndefined();
  expect(result !== undefined ? renderRoutingTagLine(result) : undefined).toBeUndefined();
});

test("runRoutingClassifierForTurn: an unconfigured operator (no project/user routing config, no stored model profiles) still routes 'quick' to the derived LIGHT model — flow 327's derived layer, not just project/user", async () => {
  const cwd = tmpDir();
  // No saveRoutingConfig call at all (project/user both empty) and `cwd` as
  // `userConfigDir` has no stored model-profile file either — `loadModelProfiles`
  // falls back to the curated seed alone (`model-profile.ts`'s
  // `CURATED_SEED.anthropic`: claude-opus-4-8 = deep, claude-sonnet-5 =
  // standard, claude-haiku-4-5 = light). This is exactly the "operator has
  // configured nothing" case the derived layer exists for.
  const result = await runRoutingClassifierForTurn("hi", {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-opus-4-8",
    env: { ANTHROPIC_API_KEY: "test-only" },
    userConfigDir: cwd,
  });
  // "hi" is the deterministic chit-chat shortcut ("quick") — no Jev/network call.
  expect(result?.category).toBe("quick");
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-haiku-4-5" });
  const tag = result !== undefined ? renderRoutingTagLine(result) : undefined;
  expect(tag).toBe("[quick -> anthropic/claude-haiku-4-5] (deterministic 100%)");
});

test("runRoutingClassifierForTurn: Jev enabled and credentialed drives the resolution", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: "claude-code" } });
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 40, output_tokens: 0, cost: 0.0012 },
  });
  const result = await runRoutingClassifierForTurn("add a retry loop to the fetch call in providers.ts", {
    enabled: true,
    jevEnabled: true,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-x", "claude-code"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    env: ENV_WITH_KEY,
    userConfigDir: cwd,
    fetch: fetchFn,
  });
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-code" });
  const usage = result?.classification.result.ok ? result.classification.result.usage : undefined;
  expect(renderRoutingUsageLine(usage)).toBe("usage: ↑40 ↓0 $0.0012");
});

test("renderRoutingSidebarValue: off/on text", () => {
  expect(renderRoutingSidebarValue(false, 0)).toBe("off");
  expect(renderRoutingSidebarValue(true, 3, "quick")).toBe("on · 3 routed (last: quick)");
  expect(renderRoutingSidebarValue(true, 0)).toBe("on · 0 routed");
});

test("flow 406: the Russian smoke greeting routes to configured quick without a classifier request", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, {
    quick: { kind: "model", providerId: "anthropic", modelId: "claude-quick" },
  });
  const result = await runRoutingClassifierForTurn("Привет! Ответь одним словом.", {
    enabled: true,
    jevEnabled: false,
    cwd,
    detected: [{ name: "anthropic", models: ["claude-session", "claude-quick"] }],
    sessionProvider: "anthropic",
    sessionModel: "claude-session",
    env: { ANTHROPIC_API_KEY: "test-only" },
    userConfigDir: cwd,
    fetch: (async () => { throw new Error("unexpected classifier request"); }) as unknown as typeof fetch,
  });
  expect(result?.category).toBe("quick");
  expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-quick" });
  expect(result && renderRoutingTagLine(result)).toBe("[quick -> anthropic/claude-quick] (deterministic 100%)");
});

function recordingClassifier(calls: string[]): import("../harness/provider/single-turn").ProviderFactory {
  return (provider, model) => ({
    describe: () => ({ descriptor: { providerId: provider }, capabilities: {
      streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false,
      reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
    } }),
    async *stream(_request, opts) {
      calls.push(`${provider}/${model}`);
      yield { kind: "text_delta" as const, sequence: 0, attemptId: opts.attemptId, text: "coding" };
      yield { kind: "model_end" as const, sequence: 1, attemptId: opts.attemptId };
    },
  });
}
test("flow 411: baseline changes neither classifier nor configured executor", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: "claude-opus-4-8" } });
  const calls: string[] = [];
  for (const sessionModel of ["claude-haiku-4-5", "claude-opus-4-8"]) {
    const result = await runRoutingClassifierForTurn("add a retry loop to the fetch call", {
      enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" },
      detected: [{ name: "anthropic", models: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"] }],
      sessionProvider: "anthropic", sessionModel, providerFactory: recordingClassifier(calls),
    });
    expect(result?.routed).toEqual({ providerId: "anthropic", modelId: "claude-opus-4-8" });
  }
  expect(calls).toEqual(["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5"]);
});
test("flow 411: Jev success skips fallback; failure uses sufficient classifier", async () => {
  const cwd = tmpDir();
  const calls: string[] = [];
  const opts = {
    enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
    detected: [{ name: "anthropic", models: ["claude-sonnet-5", "claude-haiku-4-5"] }],
    sessionProvider: "anthropic", sessionModel: "claude-haiku-4-5", providerFactory: recordingClassifier(calls),
  };
  const ok = await runRoutingClassifierForTurn("add a retry loop to the fetch call", { ...opts, fetch: fakeFetch({ answers: { category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.9 } }, usage: {} }) });
  expect(ok?.classification.result).toMatchObject({ ok: true, source: "jev" });
  expect(calls).toEqual([]);
  const failed = await runRoutingClassifierForTurn("add a retry loop to the fetch call", { ...opts, fetch: fakeFetch({}, 500) });
  expect(failed?.classification.trace.map(t => t.source)).toEqual(["jev", "main-model"]);
  expect(calls).toEqual(["anthropic/claude-sonnet-5"]);
});
test("flow 411: absent or denied sufficient models never revert to baseline", async () => {
  const cwd = tmpDir();
  const calls: string[] = [];
  for (const models of [["claude-haiku-4-5"], ["claude-sonnet-5"]]) {
    const result = await runRoutingClassifierForTurn("add a retry loop to the fetch call", {
      enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" },
      detected: [{ name: "anthropic", models }], sessionProvider: "anthropic", sessionModel: models[0]!,
      providerFactory: recordingClassifier(calls), classifierAllowed: () => false,
    });
    expect(result?.routed).toBeUndefined();
    expect(result?.fallbackReason).toContain("no available authorized sufficient classifier");
  }
  expect(calls).toEqual([]);
});


// Flow 411: provider-default is a concrete executor, not a baseline alias.
import { resolveProviderDefaultModelId } from "../harness/routing/provider-default";
import { refreshModelProfiles } from "../harness/routing/model-profile";
import { runModelTurn } from "../harness/provider/single-turn";

test("flow 411: provider-default dispatch remains independent of baseline", async () => {
  const cwd = tmpDir();
  const modelId = resolveProviderDefaultModelId("ollama")!;
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "provider-default", providerId: "ollama" } });
  const calls: string[] = [];
  for (const sessionModel of ["baseline-a", "baseline-b"]) {
    const result = await runRoutingClassifierForTurn("please review this PR", {
      enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" },
      detected: [{ name: "ollama", models: ["not-the-default", modelId] }],
      sessionProvider: "anthropic", sessionModel,
    });
    expect(result?.assignment).toEqual({ kind: "provider-default", providerId: "ollama" });
    expect(result?.routed).toEqual({ providerId: "ollama", modelId });
    expect(result?.fallbackReason).toBeUndefined();
    expect(result && renderRoutingTagLine(result)).toBe(`[review -> ollama/${modelId}] (deterministic 100%)`);
    // Execute a normalized request on the returned target using a fake port;
    // this does not claim to exercise the live TTY shell.
    await runModelTurn({ provider: result!.routed!.providerId, model: result!.routed!.modelId,
      system: "Review", user: "PR", env: { ANTHROPIC_API_KEY: "test-only" }, providerFactory: (provider, model, options) => {
        const port = recordingClassifier(calls)(provider, model, options);
        return { ...port, async *stream(request, streamOptions) {
          expect(request.providerId).toBe("ollama");
          expect(request.modelId).toBe(modelId);
          yield* port.stream(request, streamOptions);
        } };
      },
    });
  }
  expect(calls).toEqual([`ollama/${modelId}`, `ollama/${modelId}`]);
});

for (const scenario of ["unknown", "disconnected", "missing-model", "unavailable", "denied"] as const) {
  test(`flow 411: rejected provider-default (${scenario}) has a reason, no success tag`, async () => {
    const cwd = tmpDir();
    const modelId = resolveProviderDefaultModelId("ollama")!;
    const providerId = scenario === "unknown" ? "no-default-provider" : "ollama";
    const table = { review: { kind: "provider-default" as const, providerId } };
    await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
    expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
    if (scenario === "unavailable") {
      await refreshModelProfiles("ollama", [modelId], {}, { dir: cwd });
      await refreshModelProfiles("ollama", [], {}, { dir: cwd });
    }
    const result = await runRoutingClassifierForTurn("please review this PR", {
      enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" },
      detected: scenario === "disconnected" ? [] : [{ name: providerId, models: scenario === "missing-model" ? ["other-model"] : [modelId] }],
      sessionProvider: "anthropic", sessionModel: "baseline",
      executorAllowed: () => scenario !== "denied",
    });
    const reasons = { unknown: "no documented provider default", disconnected: "provider not connected",
      "missing-model": "default model not connected", unavailable: "default model unavailable", denied: "executor policy denied" };
    expect(result?.assignment).toEqual({ kind: "session-default" });
    expect(result?.routed).toBeUndefined();
    expect(result?.fallbackReason).toBe(`${providerId} (provider default): ${reasons[scenario]}`);
    expect(result && renderRoutingTagLine(result)).toBeUndefined();
    expect(renderRoutingFallbackLine(result)).toContain(reasons[scenario]);
  });
}

test("flow 411: missing provider-default credentials falls through to user", async () => {
  const cwd = tmpDir();
  const modelId = resolveProviderDefaultModelId("deepseek")!;
  const table = { review: { kind: "provider-default" as const, providerId: "deepseek" } };
  await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
  expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "ollama", modelId: "user-review" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { DEEPSEEK_API_KEY: "" },
    detected: [{ name: "deepseek", models: [modelId] }, { name: "ollama", models: ["user-review"] }],
    sessionProvider: "anthropic", sessionModel: "baseline",
  });
  expect(result?.routed).toEqual({ providerId: "ollama", modelId: "user-review" });
  expect(result?.fallbackReason).toBe("deepseek (provider default): credentials unavailable");
  expect(result && renderRoutingTagLine(result)).toContain("fallback: deepseek (provider default): credentials unavailable");
});

test("flow 411: project default wins over user; no catalogue cannot refute its model", async () => {
  const cwd = tmpDir();
  const table = { review: { kind: "provider-default" as const, providerId: "ollama" } };
  await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
  expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "ollama", modelId: "user-review" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" }, detected: [{ name: "ollama" }],
    sessionProvider: "anthropic", sessionModel: "baseline",
  });
  expect(result?.routed).toEqual({ providerId: "ollama", modelId: resolveProviderDefaultModelId("ollama")! });
  expect(result?.fallbackReason).toBeUndefined();
});


test("flow411: cancelled classifier returns no executor even after late JEV success", async () => {
  const cwd = tmpDir();
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  let calls = 0;
  const fallbackCalls: string[] = [];
  const promise = runRoutingClassifierForTurn("implement a retry loop", {
    enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
    detected: [{ name: "anthropic", models: ["claude-sonnet-5"] }],
    sessionProvider: "anthropic", sessionModel: "claude-sonnet-5",
    signal: controller.signal, timeoutMs: 1000,
    providerFactory: recordingClassifier(fallbackCalls),
    fetch: ((_: unknown, init?: RequestInit) => {
      calls += 1;
      expect(init?.signal).toBeDefined();
      controller.abort();
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch,
  });
  expect(await promise).toBeUndefined();
  expect(calls).toBe(1);
  finish(new Response(JSON.stringify({ answers: {
    category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.9 },
  }, usage: {} })));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(await promise).toBeUndefined();
  expect(fallbackCalls).toEqual([]);
});


test("flow411 review: concrete executor policy denial preserves layer fallback", async () => {
  const cwd = tmpDir();
  const table = { review: { kind: "model" as const, providerId: "ollama", modelId: "denied" } };
  await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
  expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "ollama", modelId: "allowed" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { ANTHROPIC_API_KEY: "test-only" },
    detected: [{ name: "ollama", models: ["denied", "allowed"] }],
    sessionProvider: "ollama", sessionModel: "baseline", executorAllowed: (_, model) => model !== "denied",
  });
  expect(result?.routed?.modelId).toBe("allowed");
  expect(result?.fallbackReason).toContain("denied: executor policy denied");
});

test("flow411 review: caller can deny JEV separately while permitting sufficient fallback", async () => {
  const cwd = tmpDir();
  const calls: string[] = [];
  const result = await runRoutingClassifierForTurn("implement a retry loop", {
    enabled: true, jevEnabled: true, jevAllowed: false, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
    detected: [{ name: "anthropic", models: ["claude-sonnet-5", "claude-haiku-4-5"] }],
    sessionProvider: "anthropic", sessionModel: "claude-haiku-4-5",
    providerFactory: recordingClassifier(calls), fetch: (async () => { throw new Error("denied JEV fetched"); }) as unknown as typeof fetch,
  });
  expect(calls).toEqual(["anthropic/claude-sonnet-5"]);
  expect(result?.classification.result).toMatchObject({ ok: true, source: "main-model" });
  expect(result?.fallbackReason).toContain("jev: caller policy denied");
  expect(renderRoutingFallbackLine(result)).toContain("classifier: fallback");
  if (result) expect(renderRoutingTagLine({ ...result, routed: { providerId: "anthropic", modelId: "claude-sonnet-5" } })).toContain("(fallback ");
});

test("flow411 review: failure retains sanitized source/reason and actual baseline without success tag", async () => {
  const cwd = tmpDir();
  const result = await runRoutingClassifierForTurn("implement a retry loop", {
    enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
    detected: [], sessionProvider: "ollama", sessionModel: "latest-baseline",
    fetch: fakeFetch({ answers: {}, usage: {} }),
  });
  expect(result?.routed).toBeUndefined();
  expect(result?.category).toBeUndefined();
  expect(result && renderRoutingTagLine(result)).toBeUndefined();
  expect(result?.classification.result.ok).toBe(false);
  expect(renderRoutingFallbackLine(result)).toContain("classifier: none");
  expect(renderRoutingFallbackLine(result)).toContain("jev:");
  expect(renderRoutingFallbackLine(result)).toContain("ollama/latest-baseline");
  expect(renderRoutingFallbackLine(result)).not.toContain(ENV_WITH_KEY.OPENROUTER_API_KEY);
});

for (const fallback of [false, true]) {
  test(`flow411 review: real secret-shaped JEV failure is redacted (fallback=${fallback})`, async () => {
    const cwd = tmpDir();
    const secret = "sk-or-v1-" + "a".repeat(64);
    const calls: string[] = [];
    const result = await runRoutingClassifierForTurn("implement a retry loop", {
      enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
      detected: fallback ? [{ name: "anthropic", models: ["claude-sonnet-5"] }] : [],
      sessionProvider: "ollama", sessionModel: "latest-baseline",
      ...(fallback ? { providerFactory: recordingClassifier(calls) } : {}),
      fetch: fakeFetch({ answers: {
        category: { type: "choice", choice: secret }, confidence: { type: "noul", noul: 0.99 },
      }, usage: {} }),
    });
    expect(result?.classification.result.ok).toBe(fallback);
    expect(result?.fallbackReason).toContain("jev:");
    expect(result?.fallbackReason).toContain("out-of-vocabulary");
    expect(result?.fallbackReason).not.toContain(secret);
    const rendered = result?.routed !== undefined ? renderRoutingTagLine(result) : renderRoutingFallbackLine(result);
    expect(rendered).toContain("jev:");
    expect(rendered).not.toContain(secret);
    expect(calls).toEqual(fallback ? ["anthropic/claude-sonnet-5"] : []);
  });
}


test("live picker catalog overrides stale startup ids; successful JEV and executor denial", async () => {
  const cwd = tmpDir();
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, {
    docs: { kind: "model", providerId: "openai-codex", modelId: "gpt-6.1-sol" },
  });
  const opts = {
    enabled: true, jevEnabled: true, cwd, userConfigDir: cwd,
    detected: [{ name: "openai-codex", models: ["startup-only"] }],
    sessionProvider: "openai-codex", sessionModel: "gpt-6.1-sol", env: ENV_WITH_KEY,
    providerFactory: recordingClassifier([]),
    fetch: fakeFetch({ answers: { category: { type: "choice", choice: "docs" }, confidence: { type: "noul", noul: 0.9 } }, usage: {} }),
    providers: async () => [{ name: "openai-codex", models: ["gpt-6.1-sol"] }],
  };
  const result = await runRoutingClassifierForTurn("Compare event logs and snapshots", opts);
  expect(result?.classification.result).toMatchObject({ ok: true, source: "jev", category: "docs" });
  expect(result?.routed).toEqual({ providerId: "openai-codex", modelId: "gpt-6.1-sol" });
  expect(result && renderRoutingTagLine(result)).toContain("(JEV 90%)");
  const denied = await runRoutingClassifierForTurn("Compare event logs and snapshots", { ...opts, executorAllowed: () => false });
  expect(denied?.routed).toBeUndefined();
  expect(denied?.fallbackReason).toContain("executor policy denied");
  expect(renderRoutingFallbackLine(denied)).toContain("classifier: JEV");
  const missing = await runRoutingClassifierForTurn("Compare event logs and snapshots", { ...opts, providers: async () => [] });
  expect(missing?.routed).toBeUndefined();
  expect(missing?.fallbackReason).toContain("model not connected");
});

for (const mode of ["abort", "timeout"] as const) {
  test(`live catalog preparation settles on ${mode} without classification or dispatch`, async () => {
    const cwd = tmpDir();
    const controller = new AbortController();
    let finish!: (providers: readonly import("../harness/routing/table").FlatPickerProvider[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const promise = runRoutingClassifierForTurn("Compare event logs and snapshots", {
      enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
      detected: [], sessionProvider: "ollama", sessionModel: "baseline",
      signal: controller.signal, timeoutMs: mode === "timeout" ? 30 : 1000,
      providers: () => { started(); return new Promise(resolve => { finish = resolve; }); },
      fetch: (async () => { calls++; throw new Error("must not classify"); }) as unknown as typeof fetch,
    });
    await ready;
    if (mode === "abort") controller.abort();
    const sentinel = Symbol("still pending");
    let timer!: ReturnType<typeof setTimeout>;
    const result = await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(sentinel), 200); })]);
    clearTimeout(timer);
    expect(result).toBeUndefined();
    finish([{ name: "ollama", models: ["late"] }]);
    expect(await promise).toBeUndefined();
    expect(calls).toBe(0);
  });
}

import { writeUserExternalSetting } from "../lib/external-switch";

test("external policy denial of concrete executor falls through project to authorized user", async () => {
  const cwd = tmpDir();
  writeUserExternalSetting("off", cwd);
  const table = { review: { kind: "model" as const, providerId: "openrouter", modelId: "deepseek/blocked" } };
  await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
  expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "ollama", modelId: "allowed" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
    detected: [{ name: "openrouter", models: ["deepseek/blocked"] }, { name: "ollama", models: ["allowed"] }],
    sessionProvider: "ollama", sessionModel: "baseline", executorAllowed: () => true,
  });
  expect(result?.routed?.modelId).toBe("allowed");
  expect(result?.fallbackReason).toContain("external policy denied");
});

test("missing concrete executor credentials falls through project to authorized user", async () => {
  const cwd = tmpDir();
  const table = { review: { kind: "model" as const, providerId: "deepseek", modelId: "missing-key" } };
  await saveRoutingConfig("project", { cwd, userConfigDir: cwd }, table);
  expect(approveProjectRouting(cwd, table, cwd).ok).toBe(true);
  await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { review: { kind: "model", providerId: "ollama", modelId: "allowed" } });
  const result = await runRoutingClassifierForTurn("please review this PR", {
    enabled: true, jevEnabled: false, cwd, userConfigDir: cwd, env: { DEEPSEEK_API_KEY: "" },
    detected: [{ name: "deepseek", models: ["missing-key"] }, { name: "ollama", models: ["allowed"] }],
    sessionProvider: "ollama", sessionModel: "baseline",
  });
  expect(result?.routed?.modelId).toBe("allowed");
  expect(result?.fallbackReason).toContain("credentials unavailable");
});

for (const scope of ["user", "project"] as const) {
  test(`turn-scoped ${scope} external denial prevents credentialed JEV network calls`, async () => {
    const cwd = tmpDir();
    if (scope === "user") writeUserExternalSetting("off", cwd);
    else {
      mkdirSync(path.join(cwd, ".metaproject"), { recursive: true });
      writeFileSync(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ external: "off" }));
      writeUserExternalSetting("on", cwd);
    }
    let calls = 0;
    const result = await runRoutingClassifierForTurn("Compare event logs and snapshots", {
      enabled: true, jevEnabled: true, cwd, userConfigDir: cwd, env: ENV_WITH_KEY,
      detected: [], sessionProvider: "ollama", sessionModel: "baseline",
      fetch: (async () => { calls++; throw new Error("must not send to JEV"); }) as unknown as typeof fetch,
    });
    expect(calls).toBe(0);
    expect(result?.classification.trace.some(stage => stage.source === "jev")).toBe(false);
    expect(result?.fallbackReason).toContain("jev: external policy denied");
  });
}
