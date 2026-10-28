import { expect, test } from "bun:test";
import { createCommandCatalogue } from "./catalogue";
import { sessionConfigProposal } from "./session-settings";
import { tasksIntegrationsCommands } from "./tasks-integrations";
import type { Control } from "../../remote-control/protocol";

const digest = "a".repeat(64);
const entry = (name: string) => createCommandCatalogue(digest).entries.find((row) => row.commandName === name);

test("the shipped native catalogue lists no implementation gap: every required owner is attached and every non-domain command is a cited boundary", () => {
  expect(createCommandCatalogue(digest).entries.filter((row) => row.availability === "implementation-gap").map((row) => row.commandName)).toEqual([]);
});
test("/think only changes how reasoning is displayed, so it is a client presentation concern like /theme", () => {
  // specification.md 3.1: "Pure terminal display functions are client concerns."
  expect(entry("think")).toMatchObject({ availability: "policy-denied", reason: "client-presentation", mutationClass: "read" });
});
test("/delegate and /external-diff run or read external-vendor agent work, which this Flow does not admit", () => {
  // specification.md 3.1: "unimplemented vendor adapters are explicit capability boundaries" and "external-vendor execution [is] not admitted by this Flow".
  for (const name of ["delegate", "external-diff"]) expect(entry(name)).toMatchObject({ availability: "policy-denied", reason: "external-vendor-execution-not-admitted" });
});
test("Telegram remote control is an explicit unsupported delegated-principal adapter, never missing setup", () => {
  for (const name of ["remote-control", "remote-control.name", "remote-control.off"]) expect(entry(name)).toMatchObject({ availability: "policy-denied", reason: "telegram-delegated-principal-adapter-unsupported" });
});
test("/connect, its probe and its selection are attached because every production session constructs the provider driver and the host config transaction", () => {
  for (const name of ["connect", "connect.test"]) expect(entry(name)).toMatchObject({ availability: "available" });
  expect(entry("connect.select")).toMatchObject({ availability: "available", reason: "exact-session-config-transaction" });
  // A runtime without the provider driver still says so truthfully.
  expect(tasksIntegrationsCommands().find((row) => row.entry.commandName === "connect.select")?.entry.availability).toBe("implementation-gap");
});
test("connect.select is the same idle-boundary session config transaction as a manual model pick", () => {
  const config: Control["SessionConfig"] = { configVersion: 3, baselineCandidateId: "a", reasoningEffort: "low", routing: { enabled: false, profileId: "local", candidateIds: ["a"], fallbackCandidateId: "a" }, policyDigest: digest, capabilityDigest: digest };
  const request = (commandName: string, args: Control["BoundedJson"]): Control["CommandInvoke"] => ({ expectedSessionVersion: 1, controller: { controllerLeaseId: "c", expectedControllerVersion: 1 }, expectedConfigVersion: 3, catalogueDigest: digest, commandName, arguments: args, busyPolicy: "reject" });
  expect(sessionConfigProposal(request("connect.select", { id: "b" }), config)).toEqual(sessionConfigProposal(request("model", { candidateId: "b" }), config));
  expect(sessionConfigProposal(request("connect.select", { id: "b" }), config)).toMatchObject({ baselineCandidateId: "b", reasoningEffort: "low" });
});
test("autoreview start and stop are attached to the locally supervised native review owner", () => {
  for (const name of ["autoreview.start", "autoreview.stop"]) expect(entry(name)).toMatchObject({ availability: "available", confirmation: "human", mutationClass: "workspace" });
});

test("connect.select applies through the host's serialized session config transaction with a receipt naming the new configuration version", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { assembleNativeSessionRuntime } = await import("../native-runtime-production");
  const { createSessionHost } = await import("../host");
  const { resolveLocalProfile } = await import("../../harness/policy/profiles");
  const { scriptedProvider, okReply } = await import("../../commands/agent.test-helpers");
  const { canonicalDigest } = await import("../../remote-control/protocol");
  const root = await mkdtemp(join(tmpdir(), "native-connect-select-"));
  try {
    const cwd = join(root, "checkout"); await mkdir(cwd); const configDir = join(root, "config"); await mkdir(configDir);
    Bun.spawnSync(["git", "init", "-q", cwd], { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    await Bun.write(join(configDir, "llm-providers.json"), JSON.stringify({ schemaVersion: 1, providers: { local: { name: "fixture-local", label: "Fixture local", baseUrl: "http://127.0.0.1:9", requiresApiKey: false, models: ["m1", "m2"] } } }));
    const profile = resolveLocalProfile("monitored-trusted-local"); const policy = profile.fingerprint;
    const candidate = (id: string, modelId: string): Control["RoutingCandidate"] => ({ candidateId: id, providerId: "fixture-local", modelId, reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" });
    const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: policy, capabilityDigest: policy, profileIds: ["local"], candidates: [candidate("first", "m1"), candidate("second", "m2")] };
    const assembled = await assembleNativeSessionRuntime({ cwd, configDir, sessionId: "select", profile, providerId: "fixture-local", modelId: "m1", availability, allowedTools: ["read_file"], maxToolCalls: 5, maxRounds: 5,
      modelBindings: [{ providerId: "fixture-local", modelId: "m2", actualProviderId: "fixture-local", actualModelId: "m2" }], providerFactory: () => scriptedProvider([okReply]).provider });
    if (!assembled.ok) throw new Error(assembled.error.code);
    const record: Control["SessionRecord"] = { sessionId: "select-session", projectId: "project", machineId: "machine", checkoutId: "checkout", agentProfileId: "native", title: "Select", version: 1, historyVersion: 1, state: "idle",
      config: { configVersion: 1, baselineCandidateId: "first", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["first"], fallbackCandidateId: "first" }, policyDigest: policy, capabilityDigest: policy },
      controller: { controllerLeaseId: "controller", sessionId: "select-session", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "held" },
      activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: policy, forkedFromSessionId: null,
      capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
    const host = await createSessionHost({ cwd, dataDir: join(root, "state"), configDir, record, runtime: assembled.value, workspace: { verify: async () => ({ ok: true, baseline: policy }), checkpoint: async () => ({ ok: true, baseline: policy }) },
      authorizeController: async () => true, authorizeInspection: async () => true });
    try {
      const catalogue = await host.catalogue();
      expect(catalogue.entries.find((row) => row.commandName === "connect.select")).toMatchObject({ availability: "available", reason: "exact-session-config-transaction" });
      const request: Control["CommandInvoke"] = { expectedSessionVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName: "connect.select", arguments: { id: "second" }, busyPolicy: "reject" };
      const outcome = await host.apply({ kind: "command", operationId: "select-second", payloadDigest: canonicalDigest(request), actorId: "human", request });
      // A metered candidate change has spend/privacy consequences: the same exact human confirmation as any config change, nothing applied yet.
      expect(outcome).toMatchObject({ commandName: "connect.select", status: "confirmation-required", errorCode: null });
      expect((await host.inspect()).config).toMatchObject({ configVersion: 1, baselineCandidateId: "first" });
      if (!("confirmation" in outcome) || outcome.confirmation === null) throw new Error("missing confirmation card");
      const answer: Control["CommandConfirmation"] = { expectedSessionVersion: (await host.inspect()).version, controller: request.controller, confirmationId: outcome.confirmation.confirmationId,
        operationDigest: outcome.confirmation.operationDigest, policyDigest: outcome.confirmation.policyDigest, decision: "allow-once" };
      expect(await host.apply({ kind: "confirm-command", operationId: "confirm-select", payloadDigest: canonicalDigest(answer), actorId: "human", request: answer })).toMatchObject({ status: "applied", configVersion: 2 });
      expect((await host.inspect()).config).toMatchObject({ configVersion: 2, baselineCandidateId: "second" });
      // An unknown candidate is refused by the same transaction; nothing changes.
      const unknown: Control["CommandInvoke"] = { ...request, expectedConfigVersion: 2, expectedSessionVersion: (await host.inspect()).version, arguments: { id: "not-local" } };
      expect(await host.apply({ kind: "command", operationId: "select-unknown", payloadDigest: canonicalDigest(unknown), actorId: "human", request: unknown })).toMatchObject({ status: "rejected" });
      expect((await host.inspect()).config.baselineCandidateId).toBe("second");
    } finally { await host.dispose("test"); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
