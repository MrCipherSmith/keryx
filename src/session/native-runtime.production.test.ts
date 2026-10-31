import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleNativeSessionRuntime } from "./native-runtime-production";
import { resolveLocalProfile } from "../harness/policy/profiles";

test("production native assembly refuses fake/unconnected candidates instead of reporting successful coding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-native-production-"));
  try {
    const result = await assembleNativeSessionRuntime({ cwd: dir, configDir: dir, sessionId: "s", profile: resolveLocalProfile("read-only-review"), providerId: "fake", modelId: "fake", allowedTools: ["read_file"], maxToolCalls: 10, maxRounds: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("provider-not-connected");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production native assembly refuses a provider name that resolves only to the offline replay provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-native-production-unresolved-"));
  try {
    // An unregistered name makes the real factory fall back to its offline FakeProvider (descriptor "fake-provider"), whatever the ambient credentials.
    const result = await assembleNativeSessionRuntime({ cwd: dir, configDir: dir, sessionId: "s", profile: resolveLocalProfile("read-only-review"), providerId: "unregistered-native-provider", modelId: "model", allowedTools: ["read_file"], maxToolCalls: 10, maxRounds: 10 });
    expect(result).toEqual({ ok: false, error: { code: "provider-not-connected", message: "provider-not-connected" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production assembly attaches the configured provider driver for its locally allowed candidate; selection is the host config transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-native-production-providers-")); let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { requests++; return Response.json({ data: [{ id: "fixture-model" }] }); } });
  try {
    await Bun.write(join(dir, "llm-providers.json"), JSON.stringify({ schemaVersion: 1, providers: { local: { name: "fixture-local", label: "Fixture local", baseUrl: `http://127.0.0.1:${server.port}`, requiresApiKey: false, models: ["fixture-model"] } } }));
    const profile = resolveLocalProfile("monitored-trusted-local"); const digest = profile.fingerprint;
    const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [
      { candidateId: "local-candidate", providerId: "fixture-local", modelId: "fixture-model", reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" }] };
    const assembled = await assembleNativeSessionRuntime({ cwd: dir, configDir: dir, sessionId: "provider-session", profile, providerId: "fixture-local", modelId: "fixture-model", availability,
      allowedTools: ["read_file"], maxToolCalls: 5, maxRounds: 5, providerFactory: () => scriptedProvider([okReply]).provider });
    if (!assembled.ok) throw new Error(assembled.error.code); const runtime = assembled.value;
    const config: Control["SessionConfig"] = { configVersion: 1, baselineCandidateId: "local-candidate", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["local-candidate"], fallbackCandidateId: "local-candidate" }, policyDigest: digest, capabilityDigest: digest };
    try {
      expect(runtime.commandContributions().find((row) => row.entry.commandName === "connect")?.entry.availability).toBe("implementation-gap");
      await runtime.attachServices({ configDir: dir, identity: () => ({ nativeSessionId: "10000000-0000-4000-8000-000000000009", projectId: "project", checkoutId: "checkout" }),
        sessionState: () => ({ config, restriction: { enabled: false, configVersion: 1, effectiveFromTurnOrdinal: 1, restrictionDigest: "c".repeat(64) }, permissionMode: "ask", status: "idle" }) });
      const providers = runtime.integrationPort()!.providers!;
      expect(providers.list()).toEqual([{ candidateId: "local-candidate", label: "Fixture local", state: "configured", selected: true }]);
      expect(await providers.test("local-candidate", new AbortController().signal)).toEqual({ source: "live", modelCount: 1 }); expect(requests).toBe(1);
      expect(providers.select).toBeUndefined();
      const entries = Object.fromEntries(runtime.commandContributions().map((row) => [row.entry.commandName, row.entry]));
      expect([entries.connect?.availability, entries["connect.test"]?.availability, entries["connect.select"]?.availability]).toEqual(["available", "available", "available"]);
    } finally { await runtime.closeServices(); await runtime.stop(); }
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

import { createSessionHost } from "./host";
import { canonicalDigest, type Control } from "../remote-control/protocol";
import { scriptedProvider, okReply } from "../commands/agent.test-helpers";
import { saveRoutingConfig } from "../harness/routing/config";

function nativeRoutingRecord(digest: string, standard: string, deep: string): Control["SessionRecord"] { return { sessionId: "production-session", projectId: "project", machineId: "machine", checkoutId: "checkout", agentProfileId: "native", title: "Production routing", version: 1, historyVersion: 1,
      state: "idle", config: { configVersion: 1, baselineCandidateId: standard, reasoningEffort: "none", routing: { enabled: true, profileId: "local", candidateIds: [standard, deep], fallbackCandidateId: standard }, policyDigest: digest, capabilityDigest: digest },
      controller: { controllerLeaseId: "controller", sessionId: "production-session", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60000).toISOString(), state: "held" },
      activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: digest, forkedFromSessionId: null,
      capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } }; }

test("production native factory composes the shared non-shortcut classifier and then calls the actual routed provider", async () => {
  for (const response of ["coding", "unparseable"] as const) {
  const cwd = await mkdtemp(join(tmpdir(), "keryx-native-production-routing-")); const profile = resolveLocalProfile("monitored-trusted-local");
  const classifier = scriptedProvider([[{ kind: "text_delta", text: response }, { kind: "usage_update", usage: { inputTokens: 9, outputTokens: 1 } }, { kind: "model_end" }], okReply]); const executor = scriptedProvider([okReply]);
  const standard = "claude-sonnet-5"; const deep = "claude-opus-4-8"; const digest = profile.fingerprint;
  try { await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: deep } });
    const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [standard, deep].map((modelId) => ({
      candidateId: modelId, providerId: "anthropic", modelId, available: true, reason: "none", reasoningEfforts: ["none"], privacyClass: "approved-egress", costClass: "metered" })) };
    const assembled = await assembleNativeSessionRuntime({ cwd, configDir: cwd, sessionId: "production-session", profile, providerId: "anthropic", modelId: standard,
      availability, allowedTools: ["read_file"], maxToolCalls: 5, maxRounds: 5, providerFactory: (_provider, model) => model === standard ? classifier.provider : executor.provider });
    expect(assembled.ok).toBe(true); if (!assembled.ok) throw new Error(assembled.error.code);
    const record = nativeRoutingRecord(digest, standard, deep);
    const phases: string[] = []; const observations: import("./host-types").NativeTurnObservation[] = [];
    const host = await createSessionHost({ cwd, dataDir: join(cwd, "native-state"), runtime: assembled.value, record,
      workspace: { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) }, authorizeAction: async () => true,
      authorizeSelection: async (action) => { phases.push(action.phase); return true; } }); const off = host.subscribeTurnOutcome((event) => observations.push(event));
    try { const request: Control["StartTurnRequest"] = { sessionId: record.sessionId, expectedSessionVersion: 1, expectedConfigVersion: 1, expectedHistoryVersion: 1,
      expectedWorkspaceBaseline: digest, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, association: { mode: "ad-hoc", profileConsentVersion: 1 }, messageId: "production-message", text: "Help me handle this situation carefully" };
      expect((await host.apply({ kind: "message", operationId: "production-message", payloadDigest: canonicalDigest(request), actorId: "human", runId: "production-run", turnId: "production-turn", request })).status).toBe("admitted");
      for (let i = 0; i < 100 && (await host.inspect()).state === "busy"; i++) await Bun.sleep(5);
      expect(classifier.requests).toHaveLength(response === "coding" ? 1 : 2); expect(executor.requests).toHaveLength(response === "coding" ? 1 : 0);
      expect(observations.some((event) => event.kind === "usage" && event.usage.inputTokens === 9)).toBe(true);
      expect(observations.some((event) => event.kind === "running" && event.snapshot.effectiveCandidateId === (response === "coding" ? deep : standard) && event.snapshot.routingDecision === (response === "coding" ? "classified" : "classifier-fallback"))).toBe(true);
      expect(observations.some((event) => event.kind === "terminal" && event.outcome === "succeeded")).toBe(true);
      expect(phases).toContain("admission"); expect(assembled.value.routingPolicy().jevEnabled).toBe(false);
    } finally { off(); await host.dispose(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

test("production classifier authorization expiry and revocation never become a second coding provider effect", async () => {
  for (const scenario of ["revoked-before-io", "revoked-before-admission", "expired-before-admission"] as const) {
    const cwd = await mkdtemp(join(tmpdir(), "keryx-native-production-routing-refuse-")); const profile = resolveLocalProfile("monitored-trusted-local"); const digest = profile.fingerprint;
    const standard = "claude-sonnet-5"; const deep = "claude-opus-4-8";
    const classifier = scriptedProvider([[{ kind: "text_delta", text: "coding" }, { kind: "usage_update", usage: { inputTokens: 4, outputTokens: 1 } }, { kind: "model_end" }]]); const executor = scriptedProvider([okReply]); let clock = Date.now();
    try { await saveRoutingConfig("user", { cwd, userConfigDir: cwd }, { coding: { kind: "model", providerId: "anthropic", modelId: deep } });
      const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [standard, deep].map((modelId) => ({ candidateId: modelId, providerId: "anthropic", modelId,
        available: true, reason: "none", reasoningEfforts: ["none"], privacyClass: "approved-egress", costClass: "metered" })) };
      const assembled = await assembleNativeSessionRuntime({ cwd, configDir: cwd, sessionId: "production-session", profile, providerId: "anthropic", modelId: standard, availability,
        allowedTools: ["read_file"], maxRounds: 5, maxToolCalls: 5, providerFactory: (_provider, model) => model === standard ? classifier.provider : executor.provider }); if (!assembled.ok) throw new Error(assembled.error.code);
      const record = nativeRoutingRecord(digest, standard, deep); const observed: import("./host-types").NativeTurnObservation[] = [];
      const host = await createSessionHost({ cwd, dataDir: join(cwd, "state"), record, runtime: assembled.value, now: () => clock,
        workspace: { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) }, authorizeAction: async () => true,
        authorizeSelection: async (action) => {
          if (scenario === "revoked-before-io") return false;
          if (action.phase === "admission") { if (scenario === "expired-before-admission") clock += 6000; else return false; }
          return true;
        } }); const off = host.subscribeTurnOutcome((event) => observed.push(event));
      try { const request: Control["StartTurnRequest"] = { sessionId: record.sessionId, expectedSessionVersion: 1, expectedConfigVersion: 1, expectedHistoryVersion: 1, expectedWorkspaceBaseline: digest,
        controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, association: { mode: "ad-hoc", profileConsentVersion: 1 }, messageId: "refused", text: "Help me handle this situation carefully" };
        expect((await host.apply({ kind: "message", operationId: "refused", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-refused", turnId: "turn-refused", request })).status).toBe("rejected");
        expect(classifier.requests).toHaveLength(scenario === "revoked-before-io" ? 0 : 1); expect(executor.requests).toHaveLength(0);
        expect((await host.events()).events.some((event) => event.kind === "turn-admitted")).toBe(false);
        if (scenario !== "revoked-before-io") expect(observed.some((event) => event.kind === "usage" && event.source === "routing-classifier" && event.usage.inputTokens === 4)).toBe(true);
      } finally { off(); await host.dispose(); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
});

describe("production assembly binds session MCP and bus owners only from local approval", () => {
  const sessionState = (digest: string) => () => ({ config: { configVersion: 1, baselineCandidateId: "c", reasoningEffort: "none" as const, routing: { enabled: false, profileId: "local", candidateIds: ["c"], fallbackCandidateId: "c" }, policyDigest: digest, capabilityDigest: digest },
    restriction: { enabled: false, configVersion: 1, effectiveFromTurnOrdinal: 1, restrictionDigest: "c".repeat(64) }, permissionMode: "ask" as const, status: "idle" as const });
  const gitEnv = { PATH: process.env.PATH ?? "", HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  async function assembled(dir: string, extra: Partial<Parameters<typeof assembleNativeSessionRuntime>[0]> = {}) {
    const cwd = join(dir, "checkout"); Bun.spawnSync(["git", "init", "-q", cwd], { env: gitEnv });
    const profile = resolveLocalProfile("monitored-trusted-local");
    const result = await assembleNativeSessionRuntime({ cwd, configDir: dir, sessionId: "services", profile, providerId: "fixture-local", modelId: "fixture-model", allowedTools: ["read_file"], maxToolCalls: 5, maxRounds: 5,
      providerFactory: () => scriptedProvider([okReply]).provider, ...extra });
    if (!result.ok) throw new Error(result.error.code);
    await result.value.attachServices({ configDir: dir, identity: () => ({ nativeSessionId: "10000000-0000-4000-8000-00000000000a", projectId: "project", checkoutId: "checkout" }), sessionState: sessionState(profile.fingerprint) });
    return { cwd, runtime: result.value };
  }
  test("an operator-configured HTTP server is bound; an untrusted project server and a stdio server are not; nothing approved stays setup-required", async () => {
    const { startMockHttpMcpServer } = await import("../../fixtures/mcp-servers/http-server");
    const dir = await mkdtemp(join(tmpdir(), "keryx-native-production-mcp-")); const approved = await startMockHttpMcpServer(); const untrusted = await startMockHttpMcpServer();
    try {
      await Bun.write(join(dir, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers: { approved: { url: approved.url }, launcher: { command: "sh", args: ["-c", "exit 1"] } } }));
      await Bun.write(join(dir, "checkout", ".keryx", "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers: { cloned: { url: untrusted.url } } }));
      const { runtime } = await assembled(dir);
      try {
        expect(runtime.integrationPort()?.mcp?.status()).toEqual([{ name: "approved", status: "connected", toolCount: 2 }]);
        expect(untrusted.requests()).toHaveLength(0);
        expect(runtime.commandContributions().find((row) => row.entry.commandName === "mcp")?.entry.availability).toBe("available");
      } finally { await runtime.closeServices(); await runtime.stop(); }
      const bare = await mkdtemp(join(tmpdir(), "keryx-native-production-mcp-none-"));
      try {
        const { runtime: none } = await assembled(bare);
        try { expect(none.integrationPort()?.mcp).toBeUndefined(); expect(none.commandContributions().find((row) => row.entry.commandName === "mcp")?.entry.availability).toBe("setup-required"); }
        finally { await none.closeServices(); await none.stop(); }
      } finally { await rm(bare, { recursive: true, force: true }); }
    } finally { await approved.stop(); await untrusted.stop(); await rm(dir, { recursive: true, force: true }); }
  });
  test("an explicitly approved bus binds the real local bus scoped to allowed peers; a foreign peer is never listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keryx-native-production-bus-"));
    const peers: Bun.Subprocess<"ignore", "pipe", "inherit">[] = [];
    try {
      const cwd = join(dir, "checkout"); Bun.spawnSync(["git", "init", "-q", cwd], { env: gitEnv });
      // A bus instance is per process, so each peer is a real separate process on the same local bus.
      for (const sessionId of ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"]) {
        const script = `const { joinBus } = await import(${JSON.stringify(new URL("../bus/client.ts", import.meta.url).pathname)}); const peer = await joinBus({ cwd: ${JSON.stringify(cwd)}, sessionId: ${JSON.stringify(sessionId)}, surface: "headless", env: {}, status: () => ({ status: "idle", activity: "fixture peer" }), onEvent: () => {}, onPeers: () => {} }); if ("disabled" in peer) process.exit(3); console.log("joined"); setInterval(() => {}, 1000);`;
        const peer = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env: gitEnv, stdout: "pipe", stderr: "inherit" }); peers.push(peer);
        const reader = peer.stdout.getReader(); const first = await reader.read(); reader.releaseLock(); expect(new TextDecoder().decode(first.value)).toContain("joined");
      }
      const { runtime } = await assembled(dir, { locallyApprovedBus: { allowedCheckoutPaths: [cwd], allowedPeerSessionIds: ["20000000-0000-4000-8000-000000000001"] } });
      try {
        const bus = runtime.integrationPort()?.bus; expect(bus).toBeDefined();
        for (let attempt = 0; attempt < 100 && (bus?.peers().length ?? 0) === 0; attempt++) await Bun.sleep(20);
        expect(bus?.peers().map((peer) => peer.record.sessionId)).toEqual(["20000000-0000-4000-8000-000000000001"]);
      } finally { await runtime.closeServices(); await runtime.stop(); }
    } finally { for (const peer of peers) { peer.kill(); await peer.exited; } await rm(dir, { recursive: true, force: true }); }
  });
});
