import { afterEach, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionHost } from "./host";
import { createNativeSessionRuntime, type NativeRuntimeOptions } from "./native-runtime";
import { callRound, okReply, scriptedProvider, type Script } from "../commands/agent.test-helpers";
import { canonicalDigest, validateArguments, type Control } from "../remote-control/protocol";
import { readSlate } from "./slate";
import { listSessions } from "./store";
import { sessionDir } from "./paths";
import { sessionLeasePath } from "./lease";
import type { NativeCommandContribution } from "./commands/handlers";
import type { SessionProjectReadPort } from "./commands/effects";
import type { SessionHostOptions, SessionWorkspacePort } from "./host-types";
import { superviseSpawnedProcess } from "../harness/tool/builtin/background-job-registry";
import { tasksIntegrationsCommands } from "./commands/tasks-integrations";
import { readFileSync, readdirSync } from "node:fs";

const digest = "a".repeat(64);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function record(): Control["SessionRecord"] {
  return {
    sessionId: "session-test", projectId: "project-test", machineId: "machine-test", checkoutId: "checkout-test", agentProfileId: "native",
    version: 1, historyVersion: 1, state: "idle", title: "Native fixture",
    config: { configVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" }, policyDigest: digest, capabilityDigest: digest },
    controller: { controllerLeaseId: "controller", sessionId: "session-test", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "held" },
    activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: digest, forkedFromSessionId: null,
    capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true },
  };
}
async function fixture(scripts = [okReply], autoApprove = true, opening = false, now?: () => number, authorizeAction: NonNullable<SessionHostOptions["authorizeAction"]> = async () => true, commandContributions?: NativeCommandContribution[], projectContext?: SessionProjectReadPort, analysis?: NativeRuntimeOptions["analysis"], localOptions: { spawner?: NativeRuntimeOptions["spawner"]; authorizeInspection?: SessionHostOptions["authorizeInspection"]; authorizeOwnedControl?: SessionHostOptions["authorizeOwnedControl"]; privateControlDir?: boolean; allowSubagents?: boolean; providerId?: string; lifecycle?: SessionHostOptions["lifecycle"]; availability?: NativeRuntimeOptions["availability"]; classify?: NativeRuntimeOptions["classify"]; resolveProvider?: NativeRuntimeOptions["resolveProvider"]; onApprove?: () => void; routingEnabled?: boolean; authorizeSelection?: SessionHostOptions["authorizeSelection"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "keryx-native-host-")); roots.push(root);
  const cwd = join(root, "checkout");
  const init = Bun.spawn(["git", "init", cwd], { stdout: "ignore", stderr: "pipe" }); expect(await init.exited).toBe(0);
  const provider = scriptedProvider(scripts);
  const runtime = createNativeSessionRuntime({ cwd, ...(localOptions.availability === undefined ? {} : { availability: localOptions.availability }), ...(localOptions.classify === undefined ? {} : { classify: localOptions.classify }), ...(localOptions.resolveProvider === undefined ? {} : { resolveProvider: localOptions.resolveProvider }), ...(localOptions.allowSubagents ? { allowSubagents: true } : {}), provider: provider.provider, providerId: localOptions.providerId ?? "scripted", modelId: "m", ...(localOptions.spawner === undefined ? {} : { spawner: localOptions.spawner }), ...(analysis === undefined ? {} : { analysis }), ...(commandContributions === undefined ? {} : { commandContributions }), ...(autoApprove ? { approve: async (_name: string, _input: string, meta?: { fingerprint: string }) => { localOptions.onApprove?.(); return { approved: true, ...(meta === undefined ? {} : { fingerprint: meta.fingerprint }) }; } } : {}) });
  const workspace: SessionWorkspacePort = { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) };
  const initial = record(); initial.config.routing.enabled = localOptions.routingEnabled === true; if (localOptions.providerId !== undefined) { initial.config.baselineCandidateId = `${localOptions.providerId}:m`; initial.config.routing.candidateIds = [`${localOptions.providerId}:m`]; initial.config.routing.fallbackCandidateId = `${localOptions.providerId}:m`; }
  const host = await createSessionHost({ cwd, dataDir: join(root, "state"), record: { ...initial, state: opening ? "opening" : "idle" }, runtime,
    ...(localOptions.privateControlDir ? { controlDir: join(root, "hub-control") } : {}),
    workspace,
    ...(localOptions.lifecycle === undefined ? {} : { lifecycle: localOptions.lifecycle }),
    authorizeController: async () => true,
    authorizeQueued: async () => true,
    authorizeAction,
    authorizeSelection: localOptions.authorizeSelection ?? (async () => true),
    ...(localOptions.authorizeInspection === undefined ? {} : { authorizeInspection: localOptions.authorizeInspection }),
    ...(localOptions.authorizeOwnedControl === undefined ? {} : { authorizeOwnedControl: localOptions.authorizeOwnedControl }),
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(now === undefined ? {} : { now }),
  });
  return { cwd, root, runtime, host, provider, workspace };
}
async function message(host: Awaited<ReturnType<typeof createSessionHost>>, id: string, text: string) {
  const current = await host.inspect();
  const request: Control["StartTurnRequest"] = { sessionId: current.sessionId, expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion, expectedHistoryVersion: current.historyVersion, expectedWorkspaceBaseline: current.workspaceBaseline, association: { mode: "ad-hoc", profileConsentVersion: 1 }, messageId: id, text };
  return host.apply({ kind: "message", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", runId: `run-${id}`, turnId: `turn-${id}`, request });
}
async function idle(host: Awaited<ReturnType<typeof createSessionHost>>) {
  for (let n = 0; n < 200; n++) { const current = await host.inspect(); if (!["busy", "paused", "opening"].includes(current.state)) return current; await Bun.sleep(5); }
  throw new Error("native host did not reach idle");
}

test("native coding host applies a real patch, retains own edits/history and never replays a duplicate operation", async () => {
  const patch = "diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+owned edit\n";
  const { host, cwd, provider } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply, callRound("read", "read_file", JSON.stringify({ path: "note.txt" })), okReply]);
  try {
    const first = await message(host, "one", "Create note.txt with an owned edit"); await idle(host);
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("owned edit\n");
    const prior = await host.history({ cursor: 0, limit: 100 });
    expect(prior.messages.some((item) => item.text.includes("Create note.txt"))).toBe(true);
    const second = await message(host, "two", "Read the file from the prior turn"); await idle(host);
    expect(first.status).toBe("admitted"); expect(second.status).toBe("admitted");
    expect(provider.requests[2]?.messages.some((item) => JSON.stringify(item).includes("owned edit"))).toBe(true);
    const calls = provider.requests.length;
    const duplicate = await message(host, "one", "Different payload under the same identity");
    expect(duplicate.status).toBe("rejected"); expect(provider.requests).toHaveLength(calls);
  } finally { await host.dispose("test"); }
});

test("host approval API confirms consumption of the exact active waiter before applying its real tool", async () => {
  const patch = "diff --git a/approved.txt b/approved.txt\nnew file mode 100644\n--- /dev/null\n+++ b/approved.txt\n@@ -0,0 +1 @@\n+approved\n";
  const { host, cwd } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply], false);
  let delivered!: () => void; const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const unsubscribe = host.subscribeApprovals(() => delivered());
  try {
    const applications: string[] = []; const offOutcome = host.subscribeApprovalOutcome((event) => applications.push(`${event.decision}:${event.application}`));
    await message(host, "approval", "Create approved.txt"); await delivery;
    expect(await Bun.file(join(cwd, "approved.txt")).exists()).toBe(false);
    const pending = host.pendingApprovals()[0]!; const current = await host.inspect();
    const applied = await host.answerApproval({ approvalId: pending.approvalId, runId: "run-approval", turnId: "turn-approval", actorId: "human", request: {
      expectedRunVersion: 1, expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      actionFingerprint: pending.fingerprint, policyDigest: digest, decision: "allow-once",
    } });
    expect(applied.status).toBe("applied"); expect(applications).toEqual(["allow-once:applied"]); offOutcome(); await idle(host);
    expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("approved\n");
  } finally { unsubscribe(); await host.dispose("test"); }
});

test("busy config changes queue for the next boundary without changing the admitted snapshot", async () => {
  const { host, provider } = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = provider.provider.stream;
  provider.provider.stream = (request, options) => (async function* () { await blocked; yield* original(request, options); })();
  try {
    await message(host, "one", "hello");
    const current = await host.inspect();
    const request: Control["ConfigChange"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1, baselineCandidateId: "scripted:m", reasoningEffort: "high", routing: current.config.routing, busyPolicy: "queue-at-idle" };
    const card = await host.apply({ kind: "config", operationId: "config-one", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(card.status).toBe("confirmation-required");
    if (!("confirmation" in card) || card.confirmation === null) throw new Error("missing metered effort card");
    const confirmation: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: request.controller,
      confirmationId: card.confirmation.confirmationId, operationDigest: canonicalDigest(request), policyDigest: digest, decision: "allow-once" };
    const queued = await host.apply({ kind: "confirm-command", operationId: "confirm-effort", payloadDigest: canonicalDigest(confirmation), actorId: "human", request: confirmation });
    expect(queued.status).toBe("queued");
    expect((await host.inspect()).config.reasoningEffort).toBe("none");
    expect((await host.queue()).items.some((item) => item.operationId === "config-one")).toBe(true);
    release(); await idle(host);
    expect((await host.inspect()).config.reasoningEffort).toBe("none");
    const idleRecord = await host.inspect();
    const applied = await host.admitQueued("config-one", canonicalDigest(request), { actorId: "human", commandId: "fresh-config-command", commandDigest: digest,
      expectedSessionVersion: idleRecord.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1, expiresAt: new Date(Date.now() + 5000).toISOString() });
    expect(applied.status).toBe("applied"); expect((await host.inspect()).config.reasoningEffort).toBe("high");
    expect((await host.events()).events.some((event) => event.kind === "turn-admitted" && event.snapshot.config.reasoningEffort === "none")).toBe(true);
  } finally { release(); await host.dispose("test"); }
});

test("typed MessageSubmit queues no run and a new immutable grant admits the same operation exactly once", async () => {
  const { host, provider } = await fixture();
  try {
    const before = await host.inspect();
    const request: Control["MessageSubmit"] = { expectedSessionVersion: before.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      text: "/literal slash content", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "enqueue" };
    const queued = await host.apply({ kind: "submit-message", operationId: "queued-input", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(queued.status).toBe("queued"); expect("runId" in queued && queued.runId).toBe(null); expect(provider.requests).toHaveLength(0);
    const current = await host.inspect();
    const authority = { actorId: "human", commandId: "new-delivery", commandDigest: digest, expectedSessionVersion: current.version,
      expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expiresAt: new Date(Date.now() + 5000).toISOString(), runId: "run-input", turnId: "turn-input" };
    expect((await host.admitQueued("queued-input", canonicalDigest(request), authority)).status).toBe("admitted"); await idle(host);
    expect((await host.admitQueued("queued-input", canonicalDigest(request), authority)).status).toBe("admitted"); expect(provider.requests).toHaveLength(1);
  } finally { await host.dispose("test"); }
});

test("native host retains conversation across close/reopen with its real native session lease", async () => {
  const { host, root, cwd, runtime } = await fixture();
  await message(host, "one", "Remember the word lighthouse"); await idle(host);
  const before = await host.inspect(); await host.dispose("test");
  const reopened = await createSessionHost({ cwd, dataDir: join(root, "state"), record: before, runtime,
    workspace: { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) },
  });
  try { expect((await reopened.history({ cursor: 0, limit: 100 })).messages.some((item) => item.text.includes("lighthouse"))).toBe(true); }
  finally { await reopened.dispose("test"); }
});

test("catalogue accounts for every actual native command and terminal adapter executes the shared handler", async () => {
  const { host, provider } = await fixture();
  try {
    const { commandsForMode } = await import("../commands/agent-commands");
    const { createTerminalSessionAdapter } = await import("./commands/terminal-adapter");
    const catalogue = await host.catalogue();
    for (const command of commandsForMode("agent")) {
      const entry = catalogue.entries.find((item) => item.commandName === command.name.slice(1));
      expect(entry).toBeDefined(); expect(entry?.handlerId).toBeTruthy(); expect(entry?.inputSchema).toBeDefined();
    }
    const terminal = createTerminalSessionAdapter(host, { actorId: "human", controllerLeaseId: "controller", controllerVersion: 1 });
    const status = await terminal.execute("/status");
    expect(status.status).toBe("applied");
    const malformed = await terminal.execute("/reasoning impossible");
    expect(malformed.status).toBe("rejected");
    expect(provider.requests).toHaveLength(0);
  } finally { await host.dispose("test"); }
});

test("routing preserves a manual baseline while enabled and falls back with per-turn provenance", async () => {
  const { createSessionRouting } = await import("./routing");
  const routing = createSessionRouting({ config: record().config, availability: { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [{ candidateId: "scripted:m", providerId: "scripted", modelId: "m", reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "local", costClass: "local" }] }, classify: async () => { throw new Error("classifier unavailable"); } });
  const config = { ...record().config, routing: { ...record().config.routing, enabled: true } };
  const snapshot = await routing.select("read file", config);
  expect(snapshot.effectiveCandidateId).toBe("scripted:m");
  expect(snapshot.config.routing.enabled).toBe(true);
  expect(snapshot.fallbackReason).toBeTruthy();
  expect(snapshot.config.configVersion).toBe(1);
});

test("queued message edits persist as input and require fresh explicit authorization before executing", async () => {
  const { host, provider } = await fixture([okReply, okReply]);
  let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
  const original = provider.provider.stream;
  provider.provider.stream = (request, options) => (async function* () { await blocked; yield* original(request, options); })();
  try {
    await message(host, "first", "first");
    await message(host, "queued", "old text");
    const before = await host.inspect(); const queue = await host.queue(); const item = queue.items[0]!;
    const request: Control["QueueEdit"] = { expectedSessionVersion: before.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedQueueVersion: queue.queueVersion, expectedItemVersion: item.version, text: "edited text", queueItemId: item.queueItemId };
    const edited = await host.apply({ kind: "edit-queue", operationId: "edit-one", actorId: "human", payloadDigest: canonicalDigest(request), request });
    expect(edited.status).toBe("applied");
    release(); await idle(host);
    expect(provider.requests).toHaveLength(1);
    expect((await host.queue()).items[0]?.text).toBe("edited text");
    let current = await host.inspect();
    expect((await host.applyController({ receiptId: "queue-owner", sessionVersion: current.version + 1, lease: { ...current.controller!, controllerLeaseId: "controller-new", version: 2 } }, { actorId: "human", commandId: "queue-new-generation", commandDigest: digest })).ok).toBe(true);
    current = await host.inspect(); const currentQueue = await host.queue(); const editedItem = currentQueue.items[0]!;
    expect(editedItem.state).toBe("suspended");
    const authorization: Control["QueueReauthorize"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller-new", expectedControllerVersion: 2 }, expectedQueueVersion: currentQueue.queueVersion, expectedItemVersion: editedItem.version, originalOperationId: "queued", expectedConfigVersion: current.config.configVersion, association: { mode: "ad-hoc", profileConsentVersion: 1 }, queueItemId: item.queueItemId };
    const replacement = await host.apply({ kind: "reauthorize-queue", operationId: "fresh-authorization", actorId: "human", payloadDigest: canonicalDigest(authorization), request: authorization });
    expect(replacement.status).toBe("applied"); expect(provider.requests).toHaveLength(1);
    const afterQueue = await host.queue();
    expect(afterQueue.items[0]?.state).toBe("removed");
    const queued = afterQueue.items.find((entry) => entry.operationId === "fresh-authorization")!;
    expect(queued.state).toBe("queued"); expect(queued.replacesOperationId).toBe("queued"); expect(queued.position).toBe(editedItem.position);
    expect(afterQueue.queueVersion).toBe(currentQueue.queueVersion + 1);
    const ready = await host.inspect();
    const admitted = await host.admitQueued("fresh-authorization", canonicalDigest(authorization), { actorId: "human", commandId: "new-fresh-delivery", commandDigest: digest,
      expectedSessionVersion: ready.version, expectedConfigVersion: ready.config.configVersion, controller: authorization.controller, expiresAt: new Date(Date.now() + 5000).toISOString(), runId: "run-fresh", turnId: "turn-fresh" });
    expect(admitted.status).toBe("admitted"); await idle(host);
    expect(provider.requests[1]?.messages.some((item) => item.content === "edited text")).toBe(true);
  } finally { release(); await host.dispose("test"); }
});

test("routing changes require an exact policy-bound human confirmation and apply once at the next-turn boundary", async () => {
  const { host } = await fixture();
  try {
    const before = await host.inspect();
    const request: Control["ConfigChange"] = { expectedSessionVersion: before.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: before.config.configVersion, baselineCandidateId: before.config.baselineCandidateId, reasoningEffort: before.config.reasoningEffort, routing: { ...before.config.routing, enabled: true }, busyPolicy: "reject" };
    const receipt = await host.apply({ kind: "config", operationId: "routing-on", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(receipt.status).toBe("confirmation-required");
    if (!("confirmation" in receipt) || receipt.confirmation === null) throw new Error("missing confirmation card");
    expect((await host.inspect()).config.routing.enabled).toBe(false);
    const confirmation = receipt.confirmation;
    const answer: Control["CommandConfirmation"] = { expectedSessionVersion: (await host.inspect()).version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, confirmationId: confirmation.confirmationId, operationDigest: confirmation.operationDigest, policyDigest: confirmation.policyDigest, decision: "allow-once" };
    const operation = { kind: "confirm-command" as const, operationId: "confirm-routing", payloadDigest: canonicalDigest(answer), actorId: "human", request: answer };
    expect((await host.apply(operation)).status).toBe("applied");
    const after = await host.inspect(); expect(after.config.routing.enabled).toBe(true); expect(after.config.configVersion).toBe(2);
    expect((await host.apply(operation)).status).toBe("applied"); expect((await host.inspect()).config.configVersion).toBe(2);
  } finally { await host.dispose("test"); }
});

test("host reports an actual failed turn outcome instead of inferring success from idle", async () => {
  const { host } = await fixture([[{ kind: "provider_error", error: { kind: "authentication", message: "denied", retryable: false } }]]);
  const seen: string[] = [];
  const unsubscribe = host.subscribeTurnOutcome((observation) => { if (observation.kind === "terminal") seen.push(observation.outcome); });
  try { await message(host, "failure", "hello"); await idle(host); expect(seen).toEqual(["failed"]); }
  finally { unsubscribe(); await host.dispose("test"); }
});

test("opening host publishes the measured baseline as idle and applies a grant-bound controller projection once", async () => {
  const { host } = await fixture([okReply], true, true);
  try {
    const initial = await host.inspect(); expect(initial.state).toBe("idle"); expect(initial.version).toBe(1);
    const receipt: Control["ControllerReceipt"] = { receiptId: "controller-receipt", sessionVersion: 2, lease: { controllerLeaseId: "new-controller", sessionId: initial.sessionId, version: 2, actorId: "next-human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "held" } };
    const authority = { actorId: "next-human", commandId: "controller-command", commandDigest: digest };
    expect((await host.applyController(receipt, authority)).ok).toBe(true);
    expect((await host.applyController(receipt, authority)).ok).toBe(true);
    const current = await host.inspect(); expect(current.version).toBe(2); expect(current.controller?.actorId).toBe("next-human");
    expect((await message(host, "stale-owner", "old actor cannot mutate")).status).toBe("rejected");
  } finally { await host.dispose("test"); }
});

test("owned tool effects pass through awaited provenance hooks and a refused effect stops subsequent actions", async () => {
  const patch = "diff --git a/owned.txt b/owned.txt\nnew file mode 100644\n--- /dev/null\n+++ b/owned.txt\n@@ -0,0 +1 @@\n+owned\n";
  const { host, runtime, provider, cwd } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply]);
  const seen: string[] = [];
  runtime.bindWorkspace({ verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: false, error: { code: "workspace-conflict", message: "workspace-conflict" } }),
    beforeEffect: async (toolName, input) => { seen.push(toolName); expect(input.patch).toBe(patch); return { ok: true, value: { effectId: "effect-one" } }; },
    afterEffect: async (effectId, result) => { seen.push(effectId); expect(result.isError).toBe(false); expect(await Bun.file(join(cwd, "owned.txt")).exists()).toBe(true); return { ok: false, error: { code: "workspace-conflict", message: "external interference" } }; },
  });
  try {
    await message(host, "provenance", "create owned file"); await idle(host);
    expect(seen).toEqual(["apply_patch", "effect-one"]);
    expect(provider.requests).toHaveLength(1);
  } finally { await host.dispose("test"); }
});

test("stream deltas remain progress while durable public messages receive unique ordered cursors", async () => {
  const { host } = await fixture([[{ kind: "text_delta", text: "first " }, { kind: "text_delta", text: "second" }, { kind: "model_end" }]]);
  try {
    await message(host, "stream", "hello"); await idle(host);
    const messages = (await host.events()).events.filter((event) => event.kind === "message").map((event) => event.message);
    expect(messages.map((item) => item.historyCursor)).toEqual([1, 2]);
    expect(messages.map((item) => item.role)).toEqual(["human", "assistant"]);
    expect(messages[1]?.text).toBe("first second");
    expect((await host.history()).messages).toEqual(messages);
  } finally { await host.dispose("test"); }
});

test("terminal check observations retain actual supervised command exit and output provenance", async () => {
  const { host } = await fixture([callRound("check", "shell_exec", JSON.stringify({ command: "printf 'actual-check-output\\n'" })), okReply]);
  const checks: { output?: string; exitCode?: number; source: string }[] = [];
  const unsubscribe = host.subscribeTurnOutcome((event) => { if (event.kind === "terminal") checks.push(...event.checks); });
  try {
    await message(host, "check-output", "Run the check"); await idle(host);
    expect(checks).toHaveLength(1); expect(checks[0]?.exitCode).toBe(0);
    expect(checks[0]?.output).toContain("actual-check-output"); expect(checks[0]?.source).toBe("native-supervised-shell");
  } finally { unsubscribe(); await host.dispose("test"); }
});

test("an expired human controller pauses the next real tool until an authenticated renewal", async () => {
  let clock = Date.now();
  const patch = "diff --git a/expiry.txt b/expiry.txt\nnew file mode 100644\n--- /dev/null\n+++ b/expiry.txt\n@@ -0,0 +1 @@\n+owned\n";
  const { host, provider, cwd } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply], true, false, () => clock);
  const original = provider.provider.stream; let first = true;
  provider.provider.stream = (request, options) => (async function* () { for await (const event of original(request, options)) { if (first && event.kind === "model_end") { first = false; clock += 120_000; } yield event; } })();
  let paused!: () => void; const pause = new Promise<string>((resolve) => { paused = () => resolve("paused"); });
  let terminal!: () => void; const ended = new Promise<string>((resolve) => { terminal = () => resolve("finished"); });
  const unsubscribe = host.subscribe(0, (event) => { if (event.kind === "session-state" && event.session.state === "paused") paused(); });
  const unsubscribeTurn = host.subscribeTurnOutcome((event) => { if (event.kind === "terminal") terminal(); });
  try {
    await message(host, "expiry", "create expiry.txt"); expect(await Promise.race([pause, ended])).toBe("paused");
    expect(await Bun.file(join(cwd, "expiry.txt")).exists()).toBe(false); expect(provider.requests).toHaveLength(1);
    const current = await host.inspect();
    const renewed = await host.applyController({ receiptId: "renewed", sessionVersion: current.version + 1, lease: { ...current.controller!, version: 2, expiresAt: new Date(clock + 60_000).toISOString() } },
      { actorId: "human", commandId: "renew-command", commandDigest: digest });
    expect(renewed.ok).toBe(true); await idle(host);
    expect(await Bun.file(join(cwd, "expiry.txt")).exists()).toBe(true);
  } finally { unsubscribe(); unsubscribeTurn(); await host.dispose("test"); }
});

test("current human role denial pauses before the provider even while the machine socket is connected", async () => {
  let allowed = false;
  const { host, provider } = await fixture([okReply], true, false, undefined, async () => allowed);
  let paused!: () => void; const pause = new Promise<string>((resolve) => { paused = () => resolve("paused"); });
  let ended!: () => void; const finish = new Promise<string>((resolve) => { ended = () => resolve("finished"); });
  const off = host.subscribe(0, (event) => { if (event.kind === "session-state" && event.session.state === "paused") paused(); });
  const offTurn = host.subscribeTurnOutcome((event) => { if (event.kind === "terminal") ended(); });
  try {
    await message(host, "role", "hello"); expect(await Promise.race([pause, finish])).toBe("paused"); expect(provider.requests).toHaveLength(0);
    allowed = true; host.setConnected(true); await idle(host); expect(provider.requests).toHaveLength(1);
  } finally { off(); offTurn(); await host.dispose("test"); }
});

test("headless coding turns maintain the same native Slate trail used by existing terminal memory commands", async () => {
  const patch = "diff --git a/slate.txt b/slate.txt\nnew file mode 100644\n--- /dev/null\n+++ b/slate.txt\n@@ -0,0 +1 @@\n+memory\n";
  const { host, cwd, root } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply]);
  try {
    await message(host, "slate", "Implement slate.txt"); await idle(host);
    const native = listSessions(cwd, join(root, "state"))[0]!;
    const slate = await readSlate(sessionDir(cwd, native.id, join(root, "state")));
    expect(slate?.trail?.some((entry) => entry.tool === "apply_patch")).toBe(true);
    const catalogue = await host.catalogue(); const current = await host.inspect();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName: "trail", arguments: { tool: "apply_patch" }, busyPolicy: "reject" };
    const outcome = await host.apply({ kind: "command", operationId: "trail-read", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(outcome.status).toBe("applied"); expect("result" in outcome && outcome.result).toContain("apply_patch");
  } finally { await host.dispose("test"); }
});

test("project command dispatch validates arguments and refuses unavailable canonical Hub reads without claiming applied", async () => {
  const { host, provider } = await fixture();
  const invoke = async (name: string, args: Record<string, string>) => {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      expectedConfigVersion: current.config.configVersion, catalogueDigest: catalogue.catalogueDigest, commandName: name, arguments: args, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: `project-${name}-${Object.keys(args).join()}`, payloadDigest: canonicalDigest(request), actorId: "human", request });
  };
  try {
    expect((await host.catalogue()).entries.find((entry) => entry.commandName === "doctor")?.availability).toBe("available");
    const invalid = await invoke("doctor", { unexpected: "tail" }); expect(invalid.status).toBe("rejected");
    const unavailable = await invoke("flows", {}); expect(unavailable.status).toBe("rejected");
    expect("result" in unavailable && unavailable.result).toContain("setup-required");
    expect(provider.requests).toHaveLength(0);
  } finally { await host.dispose("test"); }
});

test("a displaced native lease refuses another turn before the next heartbeat and preserves the new owner's files", async () => {
  const { host, root, cwd, provider } = await fixture();
  try {
    const native = listSessions(cwd, join(root, "state"))[0]!;
    const ownerPath = join(sessionLeasePath(cwd, native.id, join(root, "state")), "owner.json");
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: "different-owner-token", instanceId: "other-owner" }));
    await message(host, "displaced", "hello"); await idle(host);
    expect(provider.requests).toHaveLength(0);
    expect((await host.inspect()).state).toBe("recovery-required");
    expect(JSON.parse(await readFile(ownerPath, "utf8")).instanceId).toBe("other-owner");
  } finally { await host.dispose("test"); }
});

test("authenticated controller renewal extends a live generation without inventing a new one", async () => {
  const { host } = await fixture();
  try {
    const current = await host.inspect(); const lease = current.controller!;
    const renewed = { receiptId: "same-generation-renew", sessionVersion: current.version + 1, lease: { ...lease, expiresAt: new Date(Date.parse(lease.expiresAt) + 1000).toISOString() } };
    expect((await host.applyController(renewed, { actorId: "human", commandId: "same-gen", commandDigest: digest })).ok).toBe(true);
    expect((await host.inspect()).controller?.version).toBe(lease.version);
  } finally { await host.dispose("test"); }
});

test("execution command handlers use actual admitted run lifecycle and owned native checks", async () => {
  const contribution: NativeCommandContribution = { entry: { commandName: "risk", summary: "Local fixture command", handlerId: "native.fixture.risk",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "local-fixture" },
    async execute(context) {
      if (context.effect === undefined) throw new Error("missing admitted effect");
      const result = await context.runtime.run({ write() {}, beforeAction: context.effect.beforeAction }, context.history(), "Run the fixture check", context.effect.snapshot, { signal: context.effect.signal });
      return { ok: result.outcome === "succeeded", data: { runId: context.effect.runId, turnId: context.effect.turnId } };
    } };
  const { host } = await fixture([callRound("check", "shell_exec", JSON.stringify({ command: "printf command-check" })), okReply], true, false, undefined, async () => true, [contribution]);
  const terminal: import("./host-types").NativeTurnObservation[] = []; const off = host.subscribeTurnOutcome((event) => terminal.push(event));
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName: "risk", arguments: {}, busyPolicy: "reject" };
    const receipt = await host.apply({ kind: "command", operationId: "execution-command", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-command", turnId: "turn-command", association: { mode: "ad-hoc", profileConsentVersion: 1 }, request });
    expect(receipt.status).toBe("queued"); await idle(host);
    expect(terminal.some((event) => event.kind === "running" && event.runId === "run-command")).toBe(true);
    const completed = terminal.find((event) => event.kind === "terminal"); expect(completed?.kind === "terminal" && completed.outcome).toBe("succeeded");
    expect(completed?.kind === "terminal" && completed.checks[0]?.output).toContain("command-check");
    expect((await host.events()).events.some((event) => event.kind === "command-outcome" && event.outcome.status === "applied" && event.outcome.runId === "run-command")).toBe(true);
  } finally { off(); await host.dispose("test"); }
});

test("remote reasoning command requires the same one-use metered configuration confirmation", async () => {
  const { host } = await fixture();
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName: "reasoning", arguments: { effort: "high" }, busyPolicy: "reject" };
    const outcome = await host.apply({ kind: "command", operationId: "reasoning-command", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(outcome.status).toBe("confirmation-required"); expect((await host.inspect()).config.reasoningEffort).toBe("none");
    if (!("confirmation" in outcome) || outcome.confirmation === null) throw new Error("missing exact confirmation");
    expect(outcome.confirmation.operationDigest).toBe(canonicalDigest(request));
    const confirmation: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: request.controller, confirmationId: outcome.confirmation.confirmationId,
      operationDigest: canonicalDigest(request), policyDigest: digest, decision: "allow-once" };
    expect((await host.apply({ kind: "confirm-command", operationId: "confirm-command-effort", payloadDigest: canonicalDigest(confirmation), actorId: "human", request: confirmation })).status).toBe("applied");
    expect((await host.inspect()).config.reasoningEffort).toBe("high");
  } finally { await host.dispose("test"); }
});

test("close and resume retain native identity and history while releasing and reacquiring its actual lease", async () => {
  const { host, cwd, root } = await fixture();
  try {
    await message(host, "before-close", "Remember close provenance"); await idle(host);
    const nativeId = listSessions(cwd, join(root, "state"))[0]!.id;
    let current = await host.inspect();
    const close: Control["SessionClose"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, mode: "when-idle" };
    expect((await host.apply({ kind: "close-session", operationId: "close", payloadDigest: canonicalDigest(close), actorId: "human", request: close })).status).toBe("applied");
    expect((await host.inspect()).state).toBe("closed");
    expect(await Bun.file(join(sessionLeasePath(cwd, nativeId, join(root, "state")), "owner.json")).exists()).toBe(false);
    current = await host.inspect();
    const resume: Control["SessionResume"] = { expectedSessionVersion: current.version, controller: close.controller, expectedHistoryVersion: current.historyVersion, expectedWorkspaceBaseline: current.workspaceBaseline };
    expect((await host.apply({ kind: "resume-session", operationId: "resume", payloadDigest: canonicalDigest(resume), actorId: "human", request: resume })).status).toBe("applied");
    expect((await host.inspect()).state).toBe("idle");
    expect(listSessions(cwd, join(root, "state"))[0]!.id).toBe(nativeId);
    expect((await host.history()).messages.some((item) => item.text.includes("close provenance"))).toBe(true);
    expect(await Bun.file(join(sessionLeasePath(cwd, nativeId, join(root, "state")), "owner.json")).exists()).toBe(true);
  } finally { await host.dispose("test"); }
});

test("human-confirmed execution commands preserve exact payload and run association until one-use confirmation", async () => {
  let calls = 0;
  const contribution: NativeCommandContribution = { entry: { commandName: "risk", summary: "Metered local fixture", handlerId: "native.fixture.metered",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "human", availability: "available", reason: "local-fixture" },
    async execute(context) { calls++; expect(context.effect?.runId).toBe("run-card"); return { ok: true }; } };
  const { host } = await fixture([okReply], true, false, undefined, async () => true, [contribution]);
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName: "risk", arguments: {}, busyPolicy: "reject" };
    const operation = { kind: "command" as const, operationId: "metered-command", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-card", turnId: "turn-card", association: { mode: "ad-hoc" as const, profileConsentVersion: 1 }, request };
    const card = await host.apply(operation); expect(card.status).toBe("confirmation-required"); expect(calls).toBe(0);
    if (!("confirmation" in card) || card.confirmation === null) throw new Error("missing execution card");
    const confirm: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: request.controller, confirmationId: card.confirmation.confirmationId,
      operationDigest: operation.payloadDigest, policyDigest: digest, decision: "allow-once" };
    expect((await host.apply({ kind: "confirm-command", operationId: "confirm-execution", payloadDigest: canonicalDigest(confirm), actorId: "human", request: confirm })).status).toBe("queued");
    await idle(host); expect(calls).toBe(1);
    expect((await host.apply(operation)).status).toBe("applied"); expect(calls).toBe(1);
  } finally { await host.dispose("test"); }
});

test("actual model context tools reread each checkout's scoped canonical cache on subsequent turns", async () => {
  let first = "project-one-old"; let second = "project-two-old";
  const port = (read: () => string): SessionProjectReadPort => ({ source: "hub-canonical", listFlows: async () => [], readFlow: async (id) => ({ id }), readContext: async () => ({ body: read() }) });
  const scripts = () => [callRound("context-one", "hub_context", "{}"), okReply, callRound("context-two", "hub_context", "{}"), okReply];
  const a = await fixture(scripts(), true, false, undefined, async () => true, undefined, port(() => first));
  const b = await fixture(scripts(), true, false, undefined, async () => true, undefined, port(() => second));
  try {
    await message(a.host, "context-a1", "Read project context"); await idle(a.host);
    await message(b.host, "context-b1", "Read project context"); await idle(b.host);
    first = "project-one-new"; second = "project-two-new";
    await message(a.host, "context-a2", "Read updated project context"); await idle(a.host);
    await message(b.host, "context-b2", "Read updated project context"); await idle(b.host);
    expect(JSON.stringify(a.provider.requests.at(-1)).includes("project-one-new")).toBe(true);
    expect(JSON.stringify(a.provider.requests.at(-1)).includes("project-two")).toBe(false);
    expect(JSON.stringify(b.provider.requests.at(-1)).includes("project-two-new")).toBe(true);
    const names = a.provider.requests[0]!.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("hub_flows"); expect(names.some((name) => name.startsWith("flow_"))).toBe(false);
  } finally { await a.host.dispose("test"); await b.host.dispose("test"); }
});

test("analysis cache writes await exact owned-effect hooks instead of laundering an arbitrary final checkpoint", async () => {
  const order: string[] = [];
  const contribution: NativeCommandContribution = { entry: { commandName: "risk", summary: "Owned cache fixture", handlerId: "native.fixture.cache",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "local-fixture" },
    async execute(context) { await context.effect!.mutate("analysis-cache", ["cache.json"], async () => { order.push("write"); await writeFile(join(context.cwd, "cache.json"), "owned"); }); return { ok: true }; } };
  const { host, workspace, cwd } = await fixture([okReply], true, false, undefined, async () => true, [contribution]);
  workspace.beforeEffect = async (tool, input) => { expect(tool).toBe("analysis_cache_write"); expect(input.paths).toEqual(["cache.json"]); order.push("before"); return { ok: true, value: { effectId: "cache-effect" } }; };
  workspace.afterEffect = async (effectId, result) => { expect(effectId).toBe("cache-effect"); expect(result.isError).toBe(false); order.push("after"); return { ok: true, value: { baseline: digest } }; };
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      catalogueDigest: catalogue.catalogueDigest, commandName: "risk", arguments: {}, busyPolicy: "reject" };
    await host.apply({ kind: "command", operationId: "owned-cache", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-cache", turnId: "turn-cache", association: { mode: "ad-hoc", profileConsentVersion: 1 }, request });
    await idle(host); expect(order).toEqual(["before", "write", "after"]); expect(await readFile(join(cwd, "cache.json"), "utf8")).toBe("owned");
  } finally { await host.dispose("test"); }
});

test("a project record write is its own owned effect kind, not an analysis cache write, and a readonly session refuses it", async () => {
  const seen: string[] = [];
  const contribution: NativeCommandContribution = { entry: { commandName: "projectctx.set", summary: "Owned project record fixture", handlerId: "native.fixture.record",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "local-fixture" },
    async execute(context) { await context.effect!.mutate("project-record", [".metaproject/tasks.config.json"], async () => { seen.push("write"); }); return { ok: true }; } };
  const { host, workspace } = await fixture([okReply], true, false, undefined, async () => true, [contribution]);
  workspace.beforeEffect = async (tool, input) => { seen.push(`${tool}:${JSON.stringify(input.paths)}`); return { ok: true, value: { effectId: "record-effect" } }; };
  workspace.afterEffect = async () => ({ ok: true, value: { baseline: digest } });
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      catalogueDigest: catalogue.catalogueDigest, commandName: "projectctx.set", arguments: {}, busyPolicy: "reject" };
    await host.apply({ kind: "command", operationId: "owned-record", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-record", turnId: "turn-record", association: { mode: "ad-hoc", profileConsentVersion: 1 }, request });
    await idle(host); expect(seen).toEqual(["project_record_write:[\".metaproject/tasks.config.json\"]", "write"]);
  } finally { await host.dispose("test"); }
});

test("projectctx.set and flow.origin.set run to completion in a real owned checkout: each write becomes the owned baseline and the session stays idle", async () => {
  const { createOwnedWorkspace } = await import("../lib/hub-machine/workspace"); const { renderMetaprojectGitignoreBlock } = await import("../lib/metaproject-gitignore");
  const { createFlowService } = await import("../flow/service"); const { flowServiceDeps } = await import("../commands/flow");
  const { host, workspace, cwd } = await fixture([okReply]);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  await writeFile(join(cwd, ".gitignore"), renderMetaprojectGitignoreBlock()); await createFlowService(flowServiceDeps()).init({ cwd, title: "Owned record" });
  expect(git("add", ".").exitCode).toBe(0); expect(git("commit", "-qm", "fixture").exitCode).toBe(0);
  const owned = createOwnedWorkspace(cwd);
  Object.assign(workspace, { verify: async () => owned.verify(owned.baseline().digest), checkpoint: () => owned.checkpoint(), beforeEffect: owned.beforeEffect, afterEffect: owned.afterEffect });
  const run = async (id: string, commandName: string, args: Control["CommandInvoke"]["arguments"]) => {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion,
      catalogueDigest: catalogue.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" };
    await host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", runId: `run-${id}`, turnId: `turn-${id}`, association: { mode: "ad-hoc", profileConsentVersion: 1 }, request });
    return idle(host);
  };
  try {
    expect(await run("ctx", "projectctx.set", { mode: "block" })).toMatchObject({ state: "idle" });
    expect(JSON.parse(await readFile(join(cwd, ".metaproject", "tasks.config.json"), "utf8"))).toMatchObject({ gdskills: { projectContext: { enforcement: "block" } } });
    expect(await run("origin", "flow.origin.set", { flowId: "001", kind: "agent-finding", reason: "seen in review", source: "review-1" })).toMatchObject({ state: "idle" });
    expect((await createFlowService(flowServiceDeps()).get({ cwd, id: "001" })).origin).toMatchObject({ kind: "agent-finding", source: "review-1" });
    // Both writes are the checkout's owned changes now, never a foreign edit the next turn would be fenced on.
    expect((await owned.verify(owned.baseline().digest)).ok).toBe(true);
    expect(owned.resultChanges().map((change) => change.path).sort()).toEqual([expect.stringMatching(/^\.metaproject\/flows\/001-[\w-]*owned-record\/flow\.json$/), expect.stringMatching(/^\.metaproject\/flows\/001-[\w-]*owned-record\/journal\.md$/), ".metaproject/tasks.config.json"]);
  } finally { await host.dispose("test"); }
});

test("the actual analysis service candidate is receipted before egress without making it a primary chat provider", async () => {
  let selection: Control["SelectionReceipt"] | undefined;
  const fetchFn: typeof fetch = Object.assign(async () => {
    const events = (await host.events()).events;
    selection = events.find((event) => event.kind === "selection-receipt")?.receipt;
    return new Response("{}");
  }, { preconnect() {} });
  const contribution: NativeCommandContribution = { entry: { commandName: "risk", summary: "Service selection fixture", handlerId: "native.fixture.service",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "human", availability: "available", reason: "local-fixture" },
    async execute(context) { await context.effect!.analysis!.fetchFn("https://openrouter.ai/api/v1/systemone", { method: "POST", body: JSON.stringify({ model: "jev-1.13" }) }); return { ok: true }; } };
  const { host } = await fixture([okReply], true, false, undefined, async () => true, [contribution], undefined,
    { enabledCommands: ["risk"], model: "jev-1.13", env: { OPENROUTER_API_KEY: "fixture" }, fetchFn, maxCalls: 1, policyDigest: digest });
  try {
    const availability = await host.routingAvailability();
    expect(availability.candidates.some((candidate) => candidate.modelId === "jev-1.13" && !candidate.available && candidate.reason === "local-policy")).toBe(true);
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      catalogueDigest: catalogue.catalogueDigest, commandName: "risk", arguments: {}, busyPolicy: "reject" };
    const card = await host.apply({ kind: "command", operationId: "service-selection", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-service", turnId: "turn-service", association: { mode: "ad-hoc", profileConsentVersion: 1 }, request });
    if (!("confirmation" in card) || card.confirmation === null) throw new Error("missing service card");
    const confirm: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: request.controller, confirmationId: card.confirmation.confirmationId, operationDigest: canonicalDigest(request), policyDigest: digest, decision: "allow-once" };
    await host.apply({ kind: "confirm-command", operationId: "confirm-service", payloadDigest: canonicalDigest(confirm), actorId: "human", request: confirm }); await idle(host);
    expect(selection?.reason).toBe("provider-fallback"); expect(selection?.confirmedOperationDigest).toBe(canonicalDigest(request));
    expect(selection?.candidateId).toBe(availability.candidates.find((candidate) => candidate.modelId === "jev-1.13")?.candidateId);
  } finally { await host.dispose("test"); }
});

test("Flow-free readonly inspection supervises its fixed GH source and checks current authority without inventing a run", async () => {
  let allowed = false; let spawned = 0; let checks = 0;
  const contribution: NativeCommandContribution = { entry: { commandName: "ci", summary: "Readonly source fixture", handlerId: "native.fixture.inspection",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "read", states: ["idle"], busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "local-fixture" },
    async execute(context) { expect(Object.keys(context.inspection!).sort()).toEqual(["analysisRead", "beforeAction", "signal"]); const value = await context.inspection!.analysisRead!.ciSpawn(["gh", "pr", "view", "--json", "number,title"], context.cwd, context.inspection!.signal); return { ok: true, data: value.stdout }; } };
  // No Jev execution configuration: the read port is the native runtime's own owned-read capture.
  const { host, provider } = await fixture([okReply], true, false, undefined, async () => true, [contribution], undefined, undefined, {
      authorizeInspection: async () => { checks++; return allowed; },
      spawner: async (_command, cwd) => { spawned++; const proc = Bun.spawn(["bun", "-e", 'process.stdout.write("readonly-source-data")'], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
        return superviseSpawnedProcess(proc, { kill(signal) { try { process.kill(-proc.pid, signal); } catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; } } }); },
    });
  const observations: string[] = []; const off = host.subscribeTurnOutcome((event) => observations.push(event.kind));
  try {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      catalogueDigest: catalogue.catalogueDigest, commandName: "ci", arguments: {}, busyPolicy: "reject" };
    expect((await host.apply({ kind: "command", operationId: "inspection-denied", payloadDigest: canonicalDigest(request), actorId: "human", request })).status).toBe("rejected"); expect(spawned).toBe(0);
    allowed = true;
    const result = await host.apply({ kind: "command", operationId: "inspection-allowed", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(result.status).toBe("applied"); expect("result" in result && result.result).toContain("readonly-source-data");
    expect(checks).toBe(2); expect(spawned).toBe(1); expect(observations).toHaveLength(0); expect((await host.inspect()).activeRunId).toBe(null); expect(provider.requests).toHaveLength(0);
  } finally { off(); await host.dispose("test"); }
});

test("actual ci and conform inspection handlers run through the host without Jev configuration, a run, a model call or a workspace write", async () => {
  const commands: string[] = []; let checks = 0;
  const { host, provider, cwd, runtime } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, {
    authorizeInspection: async (request) => { checks++; expect(request.toolName).toBe("analysis:github-read"); return true; },
    spawner: async (command, spawnCwd) => { commands.push(command);
      const stdout = command.includes("'pr' 'view'") ? JSON.stringify({ number: 3, headRefName: "feature", title: "Fixture" }) : "[]";
      const proc = Bun.spawn(["bun", "-e", `process.stdout.write(${JSON.stringify(stdout)})`], { cwd: spawnCwd, stdout: "pipe", stderr: "pipe", detached: true });
      return superviseSpawnedProcess(proc, { kill(signal) { try { process.kill(-proc.pid, signal); } catch (cause) { if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause; } } }); },
  });
  await mkdir(join(cwd, ".metaproject"), { recursive: true }); await writeFile(join(cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { ci_triage: true, conform: true } } }));
  const observations: string[] = []; const off = host.subscribeTurnOutcome((event) => observations.push(event.kind));
  try {
    expect(runtime.commandPolicy(digest).analysis).toBeUndefined();
    const catalogue = await host.catalogue();
    expect(catalogue.entries.filter((entry) => entry.commandName === "ci" || entry.commandName === "conform").map((entry) => [entry.commandName, entry.availability, entry.mutationClass])).toEqual([["ci", "available", "read"], ["conform", "available", "read"]]);
    expect(catalogue.entries.find((entry) => entry.commandName === "ci.triage")?.availability).toBe("setup-required");
    const outcomes: Record<string, string> = {};
    for (const commandName of ["ci", "conform"]) {
      const current = await host.inspect();
      const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
        catalogueDigest: catalogue.catalogueDigest, commandName, arguments: {}, busyPolicy: "reject" };
      const result = await host.apply({ kind: "command", operationId: `inspect-${commandName}`, payloadDigest: canonicalDigest(request), actorId: "human", request });
      expect(result.status).toBe("applied"); outcomes[commandName] = "result" in result ? String(result.result) : "";
      expect("runId" in result && result.runId).toBe(null);
    }
    expect(JSON.parse(outcomes.ci!)).toEqual({ ok: true, source: "native-analysis", data: { items: [], note: "No failed CI runs on feature." } });
    expect(JSON.parse(outcomes.conform!)).toMatchObject({ ok: true, data: { targets: [{ id: "pr:3", kind: "pr" }, { id: "diff:working", kind: "diff" }] } });
    expect(commands.map((command) => command.replace(/^GH_PAGER=cat GH_PROMPT_DISABLED=1 /, "").split(" ").slice(1, 3).join(" "))).toEqual(["'pr' 'view'", "'run' 'list'", "'pr' 'view'"]);
    expect(checks).toBe(3); expect(provider.requests).toHaveLength(0); expect(observations).toHaveLength(0); expect((await host.inspect()).activeRunId).toBe(null);
    expect(runtime.jobs.list().every((job) => job.status === "completed" && job.owner?.kind === "inspection")).toBe(true);
    expect(await Bun.file(join(cwd, ".metaproject/data/review-conform/recent-docs.json")).exists()).toBe(false);
  } finally { off(); await host.dispose("test"); }
});

test("busy task control stops only the exact owned task under a fresh dedicated authority and admits no new work", async () => {
  let authorityChecks = 0;
  const a = await fixture([okReply], true, false, undefined, async () => true, tasksIntegrationsCommands(), undefined, undefined, { authorizeOwnedControl: async () => { authorityChecks++; return true; } });
  const b = await fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const stream = a.provider.provider.stream; a.provider.provider.stream = (request, options) => (async function* () { await gate; yield* stream(request, options); })();
  try {
    const owned = await a.runtime.jobs.start("sleep 60"); const foreign = await b.runtime.jobs.start("sleep 60"); if (!owned.ok || !foreign.ok) throw new Error("task fixture failed");
    await message(a.host, "busy-task", "hello");
    const invoke = async (id: string, commandName: string, args: Record<string, string>, actorId = "human") => {
      const current = await a.host.inspect(); const catalogue = await a.host.catalogue();
      const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
        catalogueDigest: catalogue.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" };
      return a.host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId, request });
    };
    expect((await invoke("wrong-task", "tasks.kill", { taskId: foreign.jobId })).status).toBe("rejected");
    expect((await invoke("wrong-session", "tasks.kill", { taskId: owned.jobId, sessionId: "other" })).status).toBe("rejected");
    expect((await invoke("wrong-machine", "tasks.kill", { taskId: owned.jobId, machineId: "other" })).status).toBe("rejected");
    expect((await invoke("wrong-actor", "tasks.kill", { taskId: owned.jobId }, "attacker")).status).toBe("rejected");
    expect((await invoke("new-busy-work", "compact", {})).status).toBe("rejected");
    expect((await invoke("owned-stop", "tasks.kill", { taskId: owned.jobId })).status).toBe("applied");
    expect(authorityChecks).toBe(1); expect(a.runtime.jobs.get(owned.jobId)?.status).toBe("killed"); expect(b.runtime.jobs.get(foreign.jobId)?.status).toBe("running");
    expect((await a.host.inspect()).activeRunId).toBe("run-busy-task");
  } finally { release(); await idle(a.host); await a.host.dispose("test"); await b.host.dispose("test"); }
});

test("busy approval command consumes only the exact active waiter and keeps the original run identity", async () => {
  let checks = 0;
  const patch = "diff --git a/control.txt b/control.txt\nnew file mode 100644\n--- /dev/null\n+++ b/control.txt\n@@ -0,0 +1 @@\n+reviewed\n";
  const { host, cwd } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply], false, false, undefined, async () => true,
    undefined, undefined, undefined, { authorizeOwnedControl: async (authority) => { checks++; expect(authority.actorId).toBe("human"); expect(authority.session.machineId).toBe("machine-test"); expect(authority.resource.kind).toBe("approval"); return true; } });
  let delivered!: () => void; const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const off = host.subscribeApprovals(() => delivered());
  try {
    await message(host, "approval-control", "Create control.txt"); await delivery;
    const pending = host.pendingApprovals()[0]!;
    const invoke = async (id: string, fingerprint: string) => {
      const current = await host.inspect(); const catalogue = await host.catalogue();
      const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
        catalogueDigest: catalogue.catalogueDigest, commandName: "approvals.allow-once", arguments: { ...pending, fingerprint }, busyPolicy: "reject" };
      return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request });
    };
    expect((await invoke("stale-fingerprint", "c".repeat(64))).status).toBe("rejected"); expect(checks).toBe(0);
    expect(await Bun.file(join(cwd, "control.txt")).exists()).toBe(false);
    expect((await invoke("exact-waiter", pending.fingerprint)).status).toBe("applied"); await idle(host);
    expect(checks).toBe(1); expect(await readFile(join(cwd, "control.txt"), "utf8")).toBe("reviewed\n");
    expect((await host.events()).events.filter((event) => event.kind === "turn-admitted")).toHaveLength(1);
  } finally { off(); await host.dispose("test"); }
});

test("queued input publishes only after its durable receipt and rejects the bounded pending queue overflow", async () => {
  const { host, root, provider } = await fixture(); let durableAtPublication = true;
  const off = host.subscribe(0, (event) => {
    if (event.kind !== "queue-changed") return;
    const saved = JSON.parse(readFileSync(join(root, "state", "remote-sessions", "session-test.json"), "utf8"));
    if (!saved.receipts.some((entry: { id: string }) => entry.id === event.item.operationId)) durableAtPublication = false;
  });
  try {
    let last: Awaited<ReturnType<typeof host.apply>> | undefined;
    for (let i = 0; i <= 100; i++) {
      const current = await host.inspect();
      const request: Control["MessageSubmit"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
        text: `literal-${i}`, interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "enqueue" };
      last = await host.apply({ kind: "submit-message", operationId: `bounded-queue-${i}`, payloadDigest: canonicalDigest(request), actorId: "human", request });
    }
    expect(durableAtPublication).toBe(true); expect(last?.status).toBe("rejected");
    expect((await host.queue({ limit: 100 })).items.filter((entry) => entry.state === "queued")).toHaveLength(100);
    expect(provider.requests).toHaveLength(0);
  } finally { off(); await host.dispose("test"); }
});

test("shared native lease refuses an actual separate-process readline resume while Hub records stay private", async () => {
  const { host, cwd, root } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { privateControlDir: true });
  try {
    const native = listSessions(cwd, join(root, "state"))[0]!;
    expect(await Bun.file(join(root, "hub-control", "remote-sessions", "session-test.json")).exists()).toBe(true);
    expect(await Bun.file(join(root, "state", "remote-sessions", "session-test.json")).exists()).toBe(false);
    const script = `import {runAgentRepl} from ${JSON.stringify(join(import.meta.dir, "../commands/shell.ts"))};
import {makeDeps,scriptedProvider,okReply} from ${JSON.stringify(join(import.meta.dir, "../commands/agent.test-helpers.ts"))};
import {createMetaprojectAdapter} from ${JSON.stringify(join(import.meta.dir, "../harness/tool/metaproject-adapter.ts"))};
const provider=scriptedProvider([okReply]);let refusal="none";
try {await runAgentRepl((async function*(){yield "/exit";})(),{printPrompt(){},safeBoundary:undefined,write(){}},makeDeps(provider.provider),createMetaprojectAdapter(${JSON.stringify(cwd)}),{cwd:${JSON.stringify(cwd)},enabled:true,resumeId:${JSON.stringify(native.id)}},undefined,undefined,undefined,${JSON.stringify(join(root, "cli-config"))});}
catch(error){refusal=error instanceof Error?error.name:"unknown";}
console.log(JSON.stringify({refusal,providerRequests:provider.requests.length}));`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], { cwd,
      env: { PATH: process.env.PATH ?? "", KERYX_DATA_DIR: join(root, "state"), XDG_DATA_HOME: join(root, "isolated-cli"), XDG_CONFIG_HOME: join(root, "isolated-cli"), KERYX_HOOKS: "off" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout)).toEqual({ refusal: "SessionLeasedError", providerRequests: 0 });
  } finally { await host.dispose("test"); }
});

test("real native ask_user is discoverable and answered by exact busy human command without granting tool approval", async () => {
  const input = { question: "Choose a format", options: [{ id: "plain", label: "Plain", description: "Plain text" }, { id: "rich", label: "Rich", description: "Rich text" }], allow_freeform: true };
  const { host, provider } = await fixture([callRound("question", "ask_user", JSON.stringify(input)), okReply], true, false, undefined, async () => true, undefined, undefined, undefined,
    { authorizeOwnedControl: async (action) => action.resource.kind === "question" });
  const invoke = async (commandName: string, args: Control["BoundedJson"], id: string) => {
    const current = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName, arguments: args, catalogueDigest: catalogue.catalogueDigest, expectedSessionVersion: current.version,
      expectedConfigVersion: current.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request });
  };
  try {
    await message(host, "user-question", "Ask me which format");
    let pending: Control["CommandOutcome"] | undefined;
    for (let i = 0; i < 100; i++) { const result = await invoke("questions.list", {}, `list-${i}`); if ("commandName" in result && Array.isArray(result.result) && result.result.length > 0) { pending = result; break; } await Bun.sleep(5); }
    expect(pending?.status).toBe("applied");
    if (pending === undefined || !Array.isArray(pending.result)) throw new Error("no real scoped question");
    const question = pending.result[0] as Record<string, Control["BoundedJson"]>;
    expect((await host.inspect()).state).toBe("busy");
    expect((await host.history()).messages.some((m) => m.role === "assistant" && m.text.includes("Choose a format"))).toBe(true);
    const args = { questionId: question.questionId!, runId: question.runId!, turnId: question.turnId!, fingerprint: question.fingerprint!, answers: { kind: "own", text: "Use literal tabs $HOME" } };
    expect((await invoke("questions.answer", { ...args, fingerprint: "b".repeat(64) }, "bad-answer")).status).toBe("rejected");
    const answered = await invoke("questions.answer", args, "answer"); expect(answered.status).toBe("applied");
    await idle(host); expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Use literal tabs $HOME");
    expect(host.pendingApprovals()).toHaveLength(0);
    expect((await invoke("questions.answer", args, "answer-again")).status).toBe("rejected");
  } finally { await host.dispose(); }
});

test("native child questions use the parent session service and fresh authority while external roster dispatch is refused", async () => {
  const question = { question: "Child needs a choice", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const { host, provider } = await fixture([callRound("spawn", "spawn_subagent", JSON.stringify({ task: "Ask which choice to use", mode: "read_only" })),
    callRound("child-question", "ask_user", JSON.stringify(question)), okReply, okReply], true, false, undefined, async () => true, undefined, undefined, undefined,
    { allowSubagents: true, providerId: "ollama", authorizeOwnedControl: async (action) => action.resource.kind === "question" });
  const invoke = async (name: string, args: Control["BoundedJson"], operationId: string) => {
    const row = await host.inspect(); const catalogue = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: name, arguments: args, catalogueDigest: catalogue.catalogueDigest,
      expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId, payloadDigest: canonicalDigest(request), actorId: "human", request });
  };
  try {
    await message(host, "child", "Delegate a question to a native child");
    let pending: Record<string, Control["BoundedJson"]> | undefined;
    for (let i = 0; i < 100; i++) { const result = await invoke("questions.list", {}, `child-list-${i}`); if ("result" in result && Array.isArray(result.result) && result.result.length) { pending = result.result[0] as Record<string, Control["BoundedJson"]>; break; } await Bun.sleep(5); }
    expect(pending?.question).toBe("Child needs a choice");
    if (pending === undefined) throw new Error("child did not use scoped question service");
    expect((await invoke("questions.answer", { questionId: pending.questionId!, runId: pending.runId!, turnId: pending.turnId!, fingerprint: pending.fingerprint!, answers: { kind: "option", choice: "b" } }, "child-answer")).status).toBe("applied");
    await idle(host); expect(provider.requests).toHaveLength(4);
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain('User selected id=');
  } finally { await host.dispose(); }
  const refused = await fixture([callRound("external", "spawn_subagent", JSON.stringify({ task: "Use external binary", runtime: { kind: "external", agent: "codex" } })), okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { allowSubagents: true, providerId: "ollama" });
  try { await message(refused.host, "external", "Attempt prohibited external adapter"); await idle(refused.host);
    expect(refused.provider.requests).toHaveLength(2); expect(JSON.stringify(refused.provider.requests[1]?.messages)).toContain("external-runtime-not-authorized");
  } finally { await refused.host.dispose(); }
});

test("a native child pauses before its next tool on current authority denial and cancellation removes its question waiter", async () => {
  let allow = false; let childToolChecks = 0;
  const { host, provider } = await fixture([callRound("spawn", "spawn_subagent", JSON.stringify({ task: "Ask a question", mode: "read_only" })),
    callRound("ask", "ask_user", JSON.stringify({ question: "Proceed?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] })), okReply], true, false,
    undefined, async (action) => { if (action.toolName === "ask_user") { childToolChecks++; return allow; } return true; }, undefined, undefined, undefined, { allowSubagents: true, providerId: "ollama" });
  const observations: string[] = []; const unsubscribe = host.subscribeTurnOutcome((event) => observations.push(event.kind === "terminal" ? event.outcome : event.kind));
  try {
    await message(host, "child-cancel", "Ask through a native child");
    for (let i = 0; i < 100 && (await host.inspect()).state !== "paused"; i++) await Bun.sleep(5);
    expect((await host.inspect()).state).toBe("paused"); expect(childToolChecks).toBeGreaterThan(0);
    expect((await host.history()).messages.some((m) => m.text.includes("Proceed?"))).toBe(false);
    allow = true; host.setConnected(true);
    for (let i = 0; i < 100 && !(await host.history()).messages.some((m) => m.text.includes("Proceed?")); i++) await Bun.sleep(5);
    expect((await host.history()).messages.some((m) => m.text.includes("Proceed?"))).toBe(true);
    const current = await host.inspect();
    const result = await host.cancel({ runId: "run-child-cancel", turnId: "turn-child-cancel", actorId: "human", request: { expectedRunVersion: 1, reason: "operator cancellation",
      expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 } } });
    expect(result.status).toBe("stopped"); expect(observations).toContain("cancelled");
    expect(provider.requests).toHaveLength(2);
  } finally { unsubscribe(); await host.dispose(); }
});

test("lifecycle commands delegate immutable child allocation and publish exact receipt without changing the source identity", async () => {
  let calls = 0; let receivedNative = "";
  const child = { ...record(), sessionId: "session-child", controller: null, title: "Child", forkedFromSessionId: "session-test" };
  const { host, root, cwd } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { lifecycle: {
    async apply(input) { calls++; receivedNative = input.sourceNativeSessionId; expect(input.payloadDigest).toBe(canonicalDigest(input.command));
      return { ok: true, value: { receiptId: "receipt-child", operationId: input.operationId, sessionId: child.sessionId, kind: "create-session", status: "applied", observedSessionVersion: child.version, session: child, reason: "none" } }; },
    async list() { return { ok: true, value: [child] }; }, async open() { return { ok: true, value: child }; },
  } });
  const invoke = async (commandName: string, args: Control["BoundedJson"], id: string) => {
    const current = await host.inspect(); const catalogue = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName, arguments: args, catalogueDigest: catalogue.catalogueDigest,
      expectedSessionVersion: current.version, expectedConfigVersion: current.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request });
  };
  try {
    const native = listSessions(cwd, join(root, "state"))[0]!.id;
    const result = await invoke("new", {}, "new-child"); expect(result).toMatchObject({ kind: "create-session", sessionId: "session-child", status: "applied" });
    expect(calls).toBe(1); expect(receivedNative).toBe(native); expect((await host.inspect()).sessionId).toBe("session-test");
    expect((await host.events()).events.some((event) => event.kind === "operation-receipt" && event.receipt.sessionId === "session-child")).toBe(true);
    expect(await invoke("new", {}, "new-child")).toEqual(result); expect(calls).toBe(1);
    const opened = await invoke("sessions.open", { sessionId: child.sessionId, expectedSessionVersion: 1 }, "open-child");
    expect("result" in opened && opened.result).toEqual({ sessionId: "session-child", sessionVersion: 1, machineId: "machine-test", checkoutId: "checkout-test", title: "Child", readOnly: true, controllerGranted: false });
  } finally { await host.dispose(); }
});

test("native lifecycle handoff forks through an executed public cursor into the shared native history namespace", async () => {
  let copiedNative = ""; let copiedCount = 0; let sourceReleased = false; let historySeed: import("./host-lifecycle").NativeForkHistorySeed | undefined;
  const child = { ...record(), sessionId: "fork-child", controller: null, title: "Fork child", forkedFromSessionId: "session-test" };
  const { host, root, cwd } = await fixture([okReply, okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { lifecycle: {
    async apply(input) {
      const fork = await input.forkNative({ throughHistoryCursor: 2, expectedHistoryVersion: input.source.historyVersion, targetCwd: input.sourceCwd, title: "Fork child" });
      copiedNative = fork.nativeSessionId; copiedCount = fork.archiveCount; historySeed = fork.historySeed;
      const closed = await input.releaseSource(); sourceReleased = closed.state === "closed";
      return { ok: true, value: { receiptId: "fork-receipt", operationId: input.operationId, sessionId: child.sessionId, kind: "fork-session", status: "applied", observedSessionVersion: 1, session: child, reason: "none" } };
    }, async list() { return { ok: true, value: [] }; }, async open() { return { ok: true, value: child }; },
  } });
  try {
    await message(host, "fork-first", "First retained native turn"); await idle(host);
    await message(host, "fork-second", "Second excluded native turn"); await idle(host);
    const row = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName: "sessions.fork", arguments: { throughHistoryCursor: 2, expectedHistoryVersion: row.historyVersion,
      targetCheckoutId: row.checkoutId, expectedInventoryVersion: 1, expectedHeadSha: "a".repeat(40), title: "Fork child" }, catalogueDigest: catalogue.catalogueDigest,
      expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    expect((await host.apply({ kind: "command", operationId: "fork-child-op", payloadDigest: canonicalDigest(request), actorId: "human", request })).status).toBe("applied");
    expect(sourceReleased).toBe(true); expect(copiedCount).toBeGreaterThan(0);
    const script = scriptedProvider([okReply]);
    const forkHost = await createSessionHost({ cwd, dataDir: join(root, "state"), nativeSessionId: copiedNative, ...(historySeed === undefined ? {} : { initialHistory: historySeed }), record: { ...record(), forkedFromSessionId: "session-test", sessionId: "fork-child", controller: { ...record().controller!, sessionId: "fork-child" } },
      runtime: createNativeSessionRuntime({ cwd, provider: script.provider, providerId: "scripted", modelId: "m" }), workspace: { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) }, authorizeAction: async () => true });
    try { expect((await forkHost.history()).messages.some((item) => item.text.includes("First retained native turn"))).toBe(true);
      expect((await forkHost.history()).messages.some((item) => item.text.includes("Second excluded native turn"))).toBe(false);
      await message(forkHost, "child-followup", "Continue the fork"); await idle(forkHost);
      expect(JSON.stringify(script.requests[0]?.messages)).toContain("First retained native turn");
      expect(JSON.stringify(script.requests[0]?.messages)).not.toContain("Second excluded native turn");
      expect((await host.history()).messages.some((item) => item.text.includes("Second excluded"))).toBe(true);
    } finally { await forkHost.dispose(); }
  } finally { await host.dispose(); }
});

test("queued workspace commands retain original literal arguments without allocating a run and require fresh FIFO admission", async () => {
  let calls = 0; let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  const contribution: NativeCommandContribution = { entry: { commandName: "fixture.queued", summary: "Queued native fixture", handlerId: "native.fixture.queued",
    inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 200 } }, required: ["text"], additionalProperties: false }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "queue-at-idle", confirmation: "none", availability: "available", reason: "real-native-test-domain" },
    async execute(context, request) { calls++; if (!context.effect) throw new Error("no run"); return context.runtime.run({ write() {}, beforeAction: context.effect.beforeAction }, context.history(),
      (request.arguments as { text: string }).text, context.effect.snapshot, { signal: context.effect.signal }); } };
  const { host, provider } = await fixture([okReply, okReply], true, false, undefined, async () => true, [contribution]);
  const original = provider.provider.stream; let first = true;
  provider.provider.stream = (request, options) => (async function* () { if (first) { first = false; await wait; } yield* original(request, options); })();
  try {
    await message(host, "preceding", "First turn"); const row = await host.inspect(); const catalogue = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName: "fixture.queued", arguments: { text: "Literal $HOME `not shell`" }, catalogueDigest: catalogue.catalogueDigest,
      expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "queue-at-idle" };
    const queued = await host.apply({ kind: "command", operationId: "queued-command", payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(queued.status).toBe("queued"); expect("runId" in queued && queued.runId).toBe(null); expect(calls).toBe(0);
    expect((await host.queue()).items[0]).toMatchObject({ kind: "command", commandName: "fixture.queued", operationId: "queued-command", state: "queued" });
    release(); await idle(host); expect(calls).toBe(0);
    expect((await message(host, "overtake", "Do not overtake queued command")).status).toBe("rejected");
    const current = await host.inspect(); const admitted = await host.admitQueued("queued-command", canonicalDigest(request), { actorId: "human", commandId: "fresh-command", commandDigest: digest,
      expectedSessionVersion: current.version, expectedConfigVersion: 1, controller: request.controller, expiresAt: new Date(Date.now() + 5000).toISOString(),
      runId: "run-queued-command", turnId: "turn-queued-command", association: { mode: "ad-hoc", profileConsentVersion: 1 } });
    expect(admitted.status).toBe("queued"); await idle(host); expect(calls).toBe(1);
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Literal $HOME `not shell`");
    expect((await host.queue()).items[0]?.state).toBe("admitted");
  } finally { release(); await host.dispose(); }
});

test("interrupt is a fresh exact current-turn control that stops a real pending question without starting new work", async () => {
  let allowed = false; const { host, provider } = await fixture([callRound("ask", "ask_user", JSON.stringify({ question: "Wait for stop", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] })), okReply], true, false,
    undefined, async () => true, undefined, undefined, undefined, { authorizeOwnedControl: async (action) => allowed && action.resource.kind === "turn" && action.resource.runId === "run-interrupt" });
  const invoke = async (id: string) => { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "interrupt", arguments: {},
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try { await message(host, "interrupt", "Wait on a question"); for (let i = 0; i < 100 && !(await host.history()).messages.some((m) => m.text.includes("Wait for stop")); i++) await Bun.sleep(5);
    expect((await invoke("denied-interrupt")).status).toBe("rejected"); expect((await host.inspect()).activeRunId).toBe("run-interrupt");
    allowed = true; const result = await invoke("actual-interrupt"); expect(result.status).toBe("applied");
    expect("result" in result && result.result).toEqual({ status: "stopped" }); expect((await host.inspect()).activeRunId).toBe(null); expect(provider.requests).toHaveLength(1);
  } finally { await host.dispose(); }
});

test("applying a queued config emits real suspension for later inputs pinned to the prior config", async () => {
  const { host, provider } = await fixture(); let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); const original = provider.provider.stream;
  provider.provider.stream = (request, options) => (async function* () { await wait; yield* original(request, options); })();
  try { await message(host, "config-before-input", "Busy turn"); let row = await host.inspect();
    const config: Control["ConfigChange"] = { expectedSessionVersion: row.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
      baselineCandidateId: row.config.baselineCandidateId, reasoningEffort: "none", routing: row.config.routing, busyPolicy: "queue-at-idle" };
    expect((await host.apply({ kind: "config", operationId: "queued-same-config", payloadDigest: canonicalDigest(config), actorId: "human", request: config })).status).toBe("queued");
    row = await host.inspect(); const input: Control["MessageSubmit"] = { expectedSessionVersion: row.version, controller: config.controller, expectedConfigVersion: 1, text: "Old config literal input",
      interpretation: "literal-message", busyPolicy: "enqueue", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
    await host.apply({ kind: "submit-message", operationId: "old-config-input", payloadDigest: canonicalDigest(input), actorId: "human", request: input });
    release(); await idle(host); row = await host.inspect();
    expect((await host.admitQueued("queued-same-config", canonicalDigest(config), { actorId: "human", commandId: "fresh-config", commandDigest: digest, controller: config.controller,
      expectedSessionVersion: row.version, expectedConfigVersion: 1, expiresAt: new Date(Date.now() + 5000).toISOString() })).status).toBe("applied");
    expect((await host.queue()).items.map((item) => item.state)).toEqual(["applied", "suspended"]);
    expect((await host.events()).events.some((event) => event.kind === "queue-changed" && event.item.operationId === "old-config-input" && event.item.state === "suspended")).toBe(true);
  } finally { release(); await host.dispose(); }
});

test("goal uses the shipped native goal handler and literal text under the admitted snapshot", async () => {
  const patch = "diff --git a/goal.txt b/goal.txt\nnew file mode 100644\n--- /dev/null\n+++ b/goal.txt\n@@ -0,0 +1 @@\n+goal-owned\n";
  const { host, provider, cwd } = await fixture([callRound("patch", "apply_patch", JSON.stringify({ patch })), okReply]);
  try { const row = await host.inspect(); const cat = await host.catalogue(); const text = "Implement goal $HOME `literal` --auto";
    const request: Control["CommandInvoke"] = { commandName: "goal", arguments: { text }, catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version,
      expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const outcome = await host.apply({ kind: "command", operationId: "goal-command", payloadDigest: canonicalDigest(request), actorId: "human", request,
      runId: "run-goal", turnId: "turn-goal", association: { mode: "ad-hoc", profileConsentVersion: 1 } });
    expect(outcome.status).toBe("queued"); await idle(host); expect(await readFile(join(cwd, "goal.txt"), "utf8")).toBe("goal-owned\n");
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain(text); expect(provider.requests).toHaveLength(2);
  } finally { await host.dispose(); }
});

test("sessions.resume reuses the exact owned native lease without recursive host dispatch", async () => {
  const { host } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { lifecycle: {
    async apply(input) { const session = await input.resumeSource(); return { ok: true, value: { receiptId: "resume-source", operationId: input.operationId, sessionId: session.sessionId,
      kind: "resume-session", status: "applied", observedSessionVersion: session.version, session, reason: "none" } }; }, async list() { return { ok: true, value: [] }; }, async open(input) { return { ok: true, value: input.source }; },
  } });
  const resume = async (operationId: string) => { const row = await host.inspect(); const cat = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName: "sessions.resume", arguments: { sessionId: row.sessionId, expectedSessionVersion: row.version, expectedHistoryVersion: row.historyVersion,
      expectedWorkspaceBaseline: row.workspaceBaseline, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 } }, expectedSessionVersion: row.version, expectedConfigVersion: 1,
      controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, catalogueDigest: cat.catalogueDigest, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try { expect((await resume("resume-held")).status).toBe("applied"); const row = await host.inspect();
    const close: Control["SessionClose"] = { expectedSessionVersion: row.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, mode: "when-idle" };
    expect((await host.apply({ kind: "close-session", operationId: "close-resume-source", payloadDigest: canonicalDigest(close), actorId: "human", request: close })).status).toBe("applied");
    expect((await resume("resume-released")).status).toBe("applied"); expect((await host.inspect()).state).toBe("idle");
  } finally { await host.dispose(); }
});

test("goal continuation reads the admitted canonical Hub Flow without provisioning a local Flow", async () => {
  let reads = 0; const done: Script = [{ kind: "text_delta", text: "GOAL_ROUND_COMPLETE" }, { kind: "model_end" }];
  const verifier: Script = [{ kind: "text_delta", text: '{"achieved":true,"gaps":[]}' }, { kind: "model_end" }];
  const port: SessionProjectReadPort = { source: "hub-canonical", listFlows: async () => [], readFlow: async (id) => { reads++; expect(id).toBe("hub-flow"); return { id, title: "Canonical goal context", status: "in-progress" }; } };
  const { host, provider, cwd } = await fixture([okReply, done, verifier], true, false, undefined, async () => true, undefined, port, undefined, { allowSubagents: true, providerId: "ollama" });
  try { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "goal", arguments: { text: "Bounded managed goal", autoRounds: 1 },
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    await host.apply({ kind: "command", operationId: "canonical-goal", payloadDigest: canonicalDigest(request), actorId: "human", request, runId: "run-canonical-goal", turnId: "turn-canonical-goal",
      association: { mode: "flow", flowId: "hub-flow", expectedFlowVersion: 1, specDigest: digest, criteriaDigest: digest } }); await idle(host);
    expect((await host.events()).events.some((event) => event.kind === "command-outcome" && event.outcome.operationId === "canonical-goal" && event.outcome.status === "applied")).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3); expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("Canonical goal context");
    expect(await Bun.file(join(cwd, ".metaproject", "flows", "index.json")).exists()).toBe(false);
  } finally { await host.dispose(); }
});

test("manual model selection while routing stays enabled changes the actual classifier-fallback provider baseline", async () => {
  const other = scriptedProvider([okReply]);
  const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: ["m", "n"].map((modelId) => ({
    candidateId: `scripted:${modelId}`, providerId: "scripted", modelId, reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" })) };
  const { host, provider } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined,
    { availability, classify: async () => { throw new Error("classifier failed"); }, resolveProvider: (_provider, model) => { expect(model).toBe("n"); return other.provider; } });
  const invoke = async (commandName: string, args: Control["BoundedJson"], id: string) => { const row = await host.inspect(); const cat = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName, arguments: args, catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version,
      expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const result = await host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request });
    expect(result.status).toBe("confirmation-required"); if (!("confirmation" in result) || result.confirmation === null) throw new Error("no exact config card");
    const card = result.confirmation; const current = await host.inspect(); const answer: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: request.controller,
      confirmationId: card.confirmationId, operationDigest: card.operationDigest, policyDigest: card.policyDigest, decision: "allow-once" };
    expect((await host.apply({ kind: "confirm-command", operationId: `confirm-${id}`, payloadDigest: canonicalDigest(answer), actorId: "human", request: answer })).status).toBe("applied");
    expect((await host.events()).events.some((event) => event.kind === "command-outcome" && event.outcome.operationId === id && event.outcome.status === "applied")).toBe(true);
    const appliedEvent = (await host.events()).events.find((event) => event.kind === "command-outcome" && event.outcome.operationId === id && event.outcome.status === "applied");
    expect(appliedEvent?.kind === "command-outcome" && validateArguments(cat.entries.find((entry) => entry.commandName === commandName)!.resultSchema, appliedEvent.outcome.result).ok).toBe(true);
  };
  const observed: Control["ConfigSnapshot"][] = []; const off = host.subscribeTurnOutcome((event) => { if (event.kind === "running") observed.push(event.snapshot); });
  try { await invoke("route.set", { enabled: true }, "enable-routing"); await invoke("model", { candidateId: "scripted:n" }, "pick-b");
    expect((await host.inspect()).config.routing.enabled).toBe(true);
    await message(host, "fallback-b", "Use the manually selected baseline"); await idle(host);
    expect(provider.requests).toHaveLength(0); expect(other.requests).toHaveLength(1);
    expect(observed[0]).toMatchObject({ effectiveCandidateId: "scripted:n", routingDecision: "classifier-fallback", fallbackReason: "classifier-failed", config: { baselineCandidateId: "scripted:n" } });
  } finally { off(); await host.dispose(); }
});

test("plan narrows the next immutable turn before approvals and restores only the local floor after exact confirmation", async () => {
  const patch = "diff --git a/planned.txt b/planned.txt\nnew file mode 100644\n--- /dev/null\n+++ b/planned.txt\n@@ -0,0 +1 @@\n+written-after-confirmation\n";
  let approvalCalls = 0;
  const { host, provider, cwd } = await fixture([callRound("denied", "apply_patch", JSON.stringify({ patch })), okReply, callRound("read", "read_file", JSON.stringify({ path: "read.txt" })), okReply,
    callRound("allowed", "apply_patch", JSON.stringify({ patch })), okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { onApprove: () => { approvalCalls++; } });
  const invoke = async (commandName: string, args: Control["BoundedJson"], id: string) => { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName, arguments: args,
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try { await writeFile(join(cwd, "read.txt"), "readable"); const on = await invoke("plan.set", { enabled: true }, "plan-on"); expect(on.status).toBe("applied");
    expect("result" in on && on.result).toMatchObject({ enabled: true, configVersion: 2, effectiveFromTurnOrdinal: 1 }); expect((await host.inspect()).config.policyDigest).toBe(digest);
    await message(host, "planned-write", "Attempt a write while readonly"); await idle(host); expect(await Bun.file(join(cwd, "planned.txt")).exists()).toBe(false); expect(approvalCalls).toBe(0);
    await message(host, "planned-read", "Read read.txt"); await idle(host); expect(JSON.stringify(provider.requests[3]?.messages)).toContain("readable");
    const off = await invoke("plan.set", { enabled: false }, "plan-off"); expect(off.status).toBe("confirmation-required");
    if (!("confirmation" in off) || off.confirmation === null) throw new Error("missing exact restriction card");
    const current = await host.inspect(); const answer: Control["CommandConfirmation"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      confirmationId: off.confirmation.confirmationId, operationDigest: off.confirmation.operationDigest, policyDigest: digest, decision: "allow-once" };
    expect((await host.apply({ kind: "confirm-command", operationId: "confirm-plan-off", payloadDigest: canonicalDigest(answer), actorId: "human", request: answer })).status).toBe("applied");
    await message(host, "restored-write", "Apply the patch under original floor"); await idle(host); expect(await readFile(join(cwd, "planned.txt"), "utf8")).toBe("written-after-confirmation\n");
    const view = await invoke("plan", {}, "plan-inspect"); expect("result" in view && view.result).toMatchObject({ enabled: false, configVersion: 3 }); expect((await host.inspect()).config.policyDigest).toBe(digest);
  } finally { await host.dispose(); }
});

test("compact with a focus keeps the operator's focus in the compaction summary the next turn's model reads", async () => {
  const { host, provider } = await fixture([okReply, okReply, okReply, okReply, okReply]);
  const invoke = async (args: Control["BoundedJson"], id: string) => { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "compact", arguments: args,
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try {
    for (const turn of ["one", "two", "three", "four"]) { await message(host, `turn-${turn}`, `Operator turn ${turn}`); await idle(host); }
    expect((await invoke({ focus: "x".repeat(201) }, "compact-too-long")).status).toBe("rejected");
    const compacted = await invoke({ focus: "keep the API notes" }, "compact-focus");
    expect(compacted.status).toBe("applied");
    expect("result" in compacted && typeof compacted.result === "string" ? JSON.parse(compacted.result) : null).toEqual({ removed: 2, noop: false });
    await message(host, "turn-five", "Operator turn five"); await idle(host);
    const summary = provider.requests.at(-1)?.messages.find((entry) => entry.role === "user" && entry.content.includes("Removed 2 messages"));
    expect(summary?.content).toContain("Focus: keep the API notes");
    expect((await invoke({}, "compact-again")).status).toBe("applied");
  } finally { await host.dispose(); }
});

test("mode ask is a versioned host restriction applied at an idle boundary that survives config, plan, restart and lifecycle and that no command widens", async () => {
  const first = await fixture([okReply]); const { host, cwd, root } = first;
  const invoke = async (target: Awaited<ReturnType<typeof createSessionHost>>, commandName: string, args: Control["BoundedJson"], id: string) => { const row = await target.inspect(); const cat = await target.catalogue(); const request: Control["CommandInvoke"] = { commandName, arguments: args,
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return target.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  const restriction = async (target: Awaited<ReturnType<typeof createSessionHost>>, id: string) => { const view = await invoke(target, "plan", {}, id); return "result" in view ? view.result as Record<string, unknown> : undefined; };
  const entry = (await host.catalogue()).entries.find((item) => item.commandName === "mode.ask");
  expect(entry).toMatchObject({ availability: "available", mutationClass: "session", busyPolicy: "reject", confirmation: "none" });
  const asked = await invoke(host, "mode.ask", {}, "mode-ask");
  expect(asked.status).toBe("applied");
  expect("result" in asked && asked.result).toMatchObject({ enabled: false, approvalMode: "ask", configVersion: 2, effectiveFromTurnOrdinal: 1 });
  // Repeating it is a no-op on the same version, not a new restriction.
  expect((await invoke(host, "mode.ask", {}, "mode-ask-again")).status).toBe("applied");
  expect(await restriction(host, "after-repeat")).toMatchObject({ approvalMode: "ask", configVersion: 2 });
  // A plan toggle and a config change carry the approval restriction forward; turning plan back off restores only the floor beneath it.
  expect((await invoke(host, "plan.set", { enabled: true }, "plan-on")).status).toBe("applied");
  expect(await restriction(host, "plan-on-view")).toMatchObject({ enabled: true, approvalMode: "ask", configVersion: 3 });
  let row = await host.inspect(); const config: Control["ConfigChange"] = { expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
    baselineCandidateId: row.config.baselineCandidateId, reasoningEffort: row.config.reasoningEffort, routing: row.config.routing, busyPolicy: "reject" };
  expect((await host.apply({ kind: "config", operationId: "config-after-ask", payloadDigest: canonicalDigest(config), actorId: "human", request: config })).status).toBe("applied");
  expect(await restriction(host, "config-view")).toMatchObject({ enabled: true, approvalMode: "ask", configVersion: 4 });
  // No chat command widens it: other permission modes are not native commands, and the mode read changes nothing.
  for (const name of ["mode.trust", "mode.auto"]) expect((await invoke(host, name, {}, `widen-${name}`)).status).toBe("rejected");
  expect((await invoke(host, "mode.ask", { approvalMode: "trust" }, "mode-ask-argument")).status).toBe("rejected");
  expect(await restriction(host, "after-widen")).toMatchObject({ approvalMode: "ask", configVersion: 4 });
  await host.dispose();
  // Restart keeps it; a lifecycle child built from the source restriction inherits it with its digest, and a stripped copy is refused.
  row = record(); const reopened = await createSessionHost({ cwd, dataDir: join(root, "state"), record: row, runtime: createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m" }), workspace: first.workspace, authorizeAction: async () => true });
  try {
    expect(await restriction(reopened, "restart-view")).toMatchObject({ enabled: true, approvalMode: "ask", configVersion: 4 });
    const source = await restriction(reopened, "lifecycle-source") as unknown as import("./commands/plan").SessionRestriction;
    const child = await fixtureFromRestriction({ ...source, configVersion: 1, effectiveFromTurnOrdinal: 1 });
    try { expect(await restriction(child.host, "child-view")).toMatchObject({ enabled: true, approvalMode: "ask", configVersion: 1 }); } finally { await child.host.dispose(); }
    const { approvalMode: _dropped, ...stripped } = { ...source, configVersion: 1, effectiveFromTurnOrdinal: 1 };
    await expect(fixtureFromRestriction(stripped)).rejects.toThrow("invalid-initial-session-restriction");
  } finally { await reopened.dispose(); }
});

/** A new host that starts from an inherited restriction, as a lifecycle child does. */
async function fixtureFromRestriction(initialRestriction: import("./commands/plan").SessionRestriction) {
  const root = await mkdtemp(join(tmpdir(), "keryx-native-host-child-")); roots.push(root); const cwd = join(root, "checkout");
  expect(await Bun.spawn(["git", "init", cwd], { stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
  const host = await createSessionHost({ cwd, dataDir: join(root, "state"), record: record(), runtime: createNativeSessionRuntime({ cwd, provider: scriptedProvider([okReply]).provider, providerId: "scripted", modelId: "m" }),
    workspace: { verify: async () => ({ ok: true, baseline: digest }), checkpoint: async () => ({ ok: true, baseline: digest }) }, authorizeController: async () => true, authorizeAction: async () => true, initialRestriction });
  return { host };
}

test("mode ask is refused while a turn runs and applies only at the idle boundary", async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  // The running turn waits at its first action boundary until released.
  const { host } = await fixture([okReply], true, false, undefined, async () => { await held; return true; });
  const invoke = async (id: string) => { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "mode.ask", arguments: {},
    catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try {
    expect((await message(host, "running", "A turn that is running")).status).toBe("admitted");
    expect((await host.inspect()).state).toBe("busy");
    expect(await invoke("mode-ask-busy")).toMatchObject({ status: "rejected", errorCode: "busy" });
    expect((await host.inspect()).config.configVersion).toBe(1);
    release(); await idle(host);
    expect((await invoke("mode-ask-idle")).status).toBe("applied");
    expect((await host.inspect()).config.configVersion).toBe(2);
  } finally { release(); await host.dispose(); }
});

test("readonly restriction persists by config version across restart and stale restoration cards cannot widen it", async () => {
  const first = await fixture(); const { host, cwd, root } = first;
  const invoke = async (commandName: string, args: Control["BoundedJson"], id: string) => { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName, arguments: args,
    expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, catalogueDigest: cat.catalogueDigest, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  await invoke("plan.set", { enabled: true }, "persist-plan-on"); const off = await invoke("plan.set", { enabled: false }, "stale-plan-off");
  if (!("confirmation" in off) || off.confirmation === null) throw new Error("no restoration card");
  let row = await host.inspect(); const config: Control["ConfigChange"] = { expectedSessionVersion: row.version, expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
    baselineCandidateId: row.config.baselineCandidateId, reasoningEffort: row.config.reasoningEffort, routing: row.config.routing, busyPolicy: "reject" };
  expect((await host.apply({ kind: "config", operationId: "intervening-config", payloadDigest: canonicalDigest(config), actorId: "human", request: config })).status).toBe("applied");
  row = await host.inspect(); const stale: Control["CommandConfirmation"] = { expectedSessionVersion: row.version, controller: config.controller, confirmationId: off.confirmation.confirmationId,
    operationDigest: off.confirmation.operationDigest, policyDigest: digest, decision: "allow-once" };
  expect((await host.apply({ kind: "confirm-command", operationId: "stale-restoration-answer", payloadDigest: canonicalDigest(stale), actorId: "human", request: stale })).status).toBe("rejected");
  await host.dispose();
  const patch = "diff --git a/restarted.txt b/restarted.txt\nnew file mode 100644\n--- /dev/null\n+++ b/restarted.txt\n@@ -0,0 +1 @@\n+must-not-write\n";
  const script = scriptedProvider([callRound("write", "apply_patch", JSON.stringify({ patch })), okReply]); let approvals = 0;
  const reopened = await createSessionHost({ cwd, dataDir: join(root, "state"), record: record(), runtime: createNativeSessionRuntime({ cwd, provider: script.provider, providerId: "scripted", modelId: "m",
    approve: async () => { approvals++; return true; } }), workspace: first.workspace, authorizeAction: async () => true });
  try { expect((await reopened.inspect()).config).toMatchObject({ configVersion: 3, policyDigest: digest }); await message(reopened, "restart-readonly", "Try the prohibited patch"); await idle(reopened);
    expect(await Bun.file(join(cwd, "restarted.txt")).exists()).toBe(false); expect(approvals).toBe(0);
  } finally { await reopened.dispose(); }
  const statePath = join(root, "state", "remote-sessions", "session-test.json"); const saved = JSON.parse(await readFile(statePath, "utf8")); delete saved.restrictions; await writeFile(statePath, JSON.stringify(saved));
  const missingScript = scriptedProvider([okReply]); const missing = await createSessionHost({ cwd, dataDir: join(root, "state"), record: record(), runtime: createNativeSessionRuntime({ cwd, provider: missingScript.provider, providerId: "scripted", modelId: "m" }), workspace: first.workspace, authorizeAction: async () => true });
  try { expect((await missing.inspect()).state).toBe("recovery-required"); await message(missing, "missing-restriction", "Must not execute unknown restriction"); expect(missingScript.requests).toHaveLength(0); }
  finally { await missing.dispose(); }
});

test("known command and queue rejections emit their method-specific receipts without mislabelling a resume", async () => {
  const { host } = await fixture();
  try { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "status", arguments: {}, catalogueDigest: cat.catalogueDigest,
    expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const rejected = await host.apply({ kind: "command", operationId: "wrong-actor-command", payloadDigest: canonicalDigest(request), actorId: "other-human", request });
    expect(rejected).toMatchObject({ commandName: "status", status: "rejected", errorCode: "forbidden" });
    const remove: Control["QueueRemove"] = { queueItemId: "missing-item", expectedQueueVersion: row.queueVersion, expectedItemVersion: 1, expectedSessionVersion: row.version, controller: request.controller };
    const outcome = await host.apply({ kind: "remove-queue", operationId: "missing-remove", payloadDigest: canonicalDigest(remove), actorId: "human", request: remove });
    expect(outcome).toMatchObject({ kind: "remove-queue", status: "rejected" });
    const events = (await host.events()).events;
    expect(events.some((event) => event.kind === "command-outcome" && event.outcome.operationId === "wrong-actor-command" && event.outcome.status === "rejected")).toBe(true);
    expect(events.some((event) => event.kind === "operation-receipt" && event.receipt.operationId === "missing-remove" && event.receipt.status === "rejected")).toBe(true);
  } finally { await host.dispose(); }
});

test("exit closes the actual native history owner and retains its transcript without allocating another run", async () => {
  const { host, provider, cwd, root } = await fixture();
  try { await message(host, "before-exit", "Retain this executed conversation"); await idle(host); const native = listSessions(cwd, join(root, "state"))[0]!.id;
    const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "exit", arguments: {}, catalogueDigest: cat.catalogueDigest,
      expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const operation = { kind: "command" as const, operationId: "native-exit", payloadDigest: canonicalDigest(request), actorId: "human", request };
    const receipt = await host.apply(operation); expect(receipt.status).toBe("applied"); expect("result" in receipt && receipt.result).toEqual({ status: "closed" });
    expect((await host.inspect()).state).toBe("closed"); expect(await Bun.file(join(sessionLeasePath(cwd, native, join(root, "state")), "owner.json")).exists()).toBe(false);
    expect((await host.history()).messages.some((message) => message.text.includes("Retain this executed"))).toBe(true); expect(provider.requests).toHaveLength(1);
    expect(await host.apply(operation)).toEqual(receipt);
  } finally { await host.dispose(); }
});

test("exact human confirmation denial terminally rejects the original command without executing it", async () => {
  let effects = 0; const contribution: NativeCommandContribution = { entry: { commandName: "fixture.confirm", handlerId: "native.fixture.confirm", summary: "Confirmed fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] }, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "workspace", states: ["idle"],
    busyPolicy: "reject", confirmation: "human", availability: "available", reason: "fixture" }, async execute() { effects++; return "executed"; } };
  const { host } = await fixture([okReply], true, false, undefined, async () => true, [contribution]);
  try { const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "fixture.confirm", arguments: {}, catalogueDigest: cat.catalogueDigest,
    expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const original = { kind: "command" as const, operationId: "denied-original", payloadDigest: canonicalDigest(request), actorId: "human", request, runId: "run-denied", turnId: "turn-denied", association: { mode: "ad-hoc" as const, profileConsentVersion: 1 } };
    const card = await host.apply(original); if (!("confirmation" in card) || card.confirmation === null) throw new Error("no confirmation");
    const deny: Control["CommandConfirmation"] = { expectedSessionVersion: row.version, controller: request.controller, confirmationId: card.confirmation.confirmationId,
      operationDigest: card.confirmation.operationDigest, policyDigest: digest, decision: "deny" };
    await host.apply({ kind: "confirm-command", operationId: "deny-answer", payloadDigest: canonicalDigest(deny), actorId: "human", request: deny });
    expect((await host.apply(original)).status).toBe("rejected"); expect(effects).toBe(0);
    expect((await host.events()).events.some((event) => event.kind === "command-outcome" && event.outcome.operationId === "denied-original" && event.outcome.status === "rejected")).toBe(true);
    expect((await host.inspect()).activeRunId).toBe(null);
  } finally { await host.dispose(); }
});

test("routing selection reserves one native slot outside mutation serialization and remains cancellable before any turn snapshot", async () => {
  let selected = 0; let release!: () => void; let started!: () => void; const began = new Promise<void>((resolve) => { started = resolve; });
  const { host, provider, root } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { routingEnabled: true,
    classify: async (_text, _config, signal) => { selected++; started(); await new Promise<void>((resolve) => { release = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); }); return undefined; } });
  let pending: Promise<unknown> | undefined;
  try { pending = message(host, "selecting", "Classify this bounded work"); await began;
    const durable = JSON.parse(await readFile(join(root, "state", "remote-sessions", "session-test.json"), "utf8"));
    expect(durable.selection).toMatchObject({ operationId: "selecting", runId: "run-selecting", turnId: "turn-selecting" });
    const row = await host.inspect(); const cat = await host.catalogue(); const request: Control["CommandInvoke"] = { commandName: "status", arguments: {}, catalogueDigest: cat.catalogueDigest,
      expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    const inspected = await Promise.race([host.apply({ kind: "command", operationId: "read-during-selection", payloadDigest: canonicalDigest(request), actorId: "human", request }), Bun.sleep(100).then(() => "blocked")]);
    expect(inspected).not.toBe("blocked"); expect(selected).toBe(1); expect(provider.requests).toHaveLength(0);
    const stopped = await host.cancel({ runId: "run-selecting", turnId: "turn-selecting", actorId: "human", request: { expectedRunVersion: 1, expectedSessionVersion: row.version,
      controller: request.controller, reason: "Stop pending classifier" } }); expect(stopped.status).toBe("stopped");
    await pending; expect(provider.requests).toHaveLength(0); expect((await host.events()).events.some((event) => event.kind === "turn-admitted")).toBe(false);
  } finally { release?.(); await pending; await host.dispose(); }
});

test("same-millisecond authenticated renewal may acknowledge equal expiry without extending or changing its generation", async () => {
  const { host } = await fixture();
  try { const current = await host.inspect(); const receipt: Control["ControllerReceipt"] = { receiptId: "same-ms-renewal", sessionVersion: current.version + 1, lease: current.controller! };
    expect((await host.applyController(receipt, { actorId: "human", commandId: "same-ms", commandDigest: digest })).ok).toBe(true);
    expect((await host.inspect()).controller).toEqual(current.controller);
    const earlier = { ...receipt, receiptId: "backwards-renewal", sessionVersion: receipt.sessionVersion + 1, lease: { ...receipt.lease, expiresAt: new Date(Date.parse(receipt.lease.expiresAt) - 1).toISOString() } };
    expect((await host.applyController(earlier, { actorId: "human", commandId: "backwards", commandDigest: digest })).ok).toBe(false);
  } finally { await host.dispose(); }
});

test("duplicate original work during selection shares one private classification and rejects changed replay", async () => {
  let classifications = 0; let began!: () => void; let release!: () => void; const started = new Promise<void>((resolve) => { began = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
  const { host, provider } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { routingEnabled: true,
    classify: async () => { classifications++; began(); await held; return "scripted:m"; } });
  let first: Promise<unknown> | undefined; let duplicate: Promise<unknown> | undefined;
  try { first = message(host, "same-selection", "Same immutable work"); await started; duplicate = message(host, "same-selection", "Same immutable work");
    expect((await message(host, "same-selection", "Different changed replay")).status).toBe("rejected"); expect(classifications).toBe(1);
    release(); expect(await duplicate).toEqual(await first); await idle(host); expect(provider.requests).toHaveLength(1);
  } finally { release(); await Promise.all([first, duplicate]); await host.dispose(); }
});


test("queued classification survives transient admission authority loss without reclassifying or replacing its logical receipt", async () => {
  let classifications = 0; let unavailable = true;
  const { host, provider, root } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { routingEnabled: true,
    classify: async () => { classifications++; return "scripted:m"; },
    authorizeSelection: async (action) => action.phase === "admission" && unavailable ? { status: "temporarily-unavailable" as const } : { status: "valid" as const } });
  try {
    const row = await host.inspect();
    const request: Control["MessageSubmit"] = { expectedSessionVersion: row.version, expectedConfigVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
      text: "Classify this literal queued request exactly once", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "enqueue" };
    const logical = { kind: "submit-message" as const, operationId: "retry-queued", payloadDigest: canonicalDigest(request), actorId: "human", request };
    const queued = await host.apply(logical); expect(queued.status).toBe("queued");
    const deliver = async (suffix: string) => { const current = await host.inspect(); return host.admitQueued(logical.operationId, logical.payloadDigest, { actorId: "human", commandId: `delivery-${suffix}`, commandDigest: digest,
      expectedSessionVersion: current.version, expectedConfigVersion: 1, controller: request.controller, expiresAt: new Date(Date.now() + 5000).toISOString(), runId: `run-${suffix}`, turnId: `turn-${suffix}` }); };
    const observations: unknown[] = []; const off = host.subscribeTurnOutcome((event) => observations.push(event));
    expect((await deliver("expired")).status).toBe("queued");
    expect((await host.queue()).items[0]?.state).toBe("queued"); expect(await host.apply(logical)).toEqual(queued);
    expect(provider.requests).toHaveLength(0); expect(classifications).toBe(1);
    expect(observations).toContainEqual(expect.objectContaining({ kind: "admission-refused", reason: "temporarily-unavailable", retainedQueue: true }));
    const persisted = JSON.parse(await readFile(join(root, "state", "remote-sessions", "session-test.json"), "utf8"));
    expect(persisted.selectionDecisions).toHaveLength(1);
    unavailable = false; expect((await deliver("fresh")).status).toBe("admitted"); await idle(host);
    expect(classifications).toBe(1); expect(provider.requests).toHaveLength(1); off();
  } finally { await host.dispose(); }
});


test("queued classifier unknown authority stays fenced while explicit revocation suspends the logical input", async () => {
  for (const status of ["unknown", "revoked-or-forbidden"] as const) {
    let classifications = 0;
    const { host, provider } = await fixture([okReply], true, false, undefined, async () => true, undefined, undefined, undefined, { routingEnabled: true,
      classify: async () => { classifications++; return "scripted:m"; }, authorizeSelection: async (action) => action.phase !== "admission" ? true : status === "unknown" ? false : { status } });
    try {
      const current = await host.inspect(); const request: Control["MessageSubmit"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1,
        text: "Never repeat an unknown classifier or bypass revoked authority", interpretation: "literal-message", association: { mode: "ad-hoc", profileConsentVersion: 1 }, busyPolicy: "enqueue" };
      const queued = await host.apply({ kind: "submit-message", operationId: "unknown-queued", payloadDigest: canonicalDigest(request), actorId: "human", request });
      const row = await host.inspect(); const observations: unknown[] = []; const off = host.subscribeTurnOutcome((event) => observations.push(event));
      await host.admitQueued("unknown-queued", canonicalDigest(request), { actorId: "human", commandId: "unknown-delivery", commandDigest: digest, expectedSessionVersion: row.version, expectedConfigVersion: 1,
        controller: request.controller, expiresAt: new Date(Date.now() + 5000).toISOString(), runId: "run-unknown", turnId: "turn-unknown" });
      expect(classifications).toBe(1); expect(provider.requests).toHaveLength(0); expect(observations.some((value) => typeof value === "object" && value !== null && "kind" in value && value.kind === "admission-refused")).toBe(status !== "unknown");
      expect((await host.queue()).items[0]?.state).toBe(status === "unknown" ? "queued" : "suspended");
      expect((await host.inspect()).state).toBe(status === "unknown" ? "recovery-required" : "idle");
      if (status === "unknown") expect((await host.apply({ kind: "submit-message", operationId: "unknown-queued", payloadDigest: canonicalDigest(request), actorId: "human", request }))).toEqual(queued);
      off();
    } finally { await host.dispose(); }
  }
});

test("queued selection refuses a work window that expires during workspace verification without replacing its logical input", async () => {
  let clock=Date.now();let classifications=0;
  const {host,workspace,provider}=await fixture([okReply],true,false,()=>clock,async()=>true,undefined,undefined,undefined,{routingEnabled:true,classify:async()=>{classifications++;return 'scripted:m';}});
  try{const current=await host.inspect();const request:Control['MessageSubmit']={expectedSessionVersion:current.version,expectedConfigVersion:1,controller:{controllerLeaseId:'controller',expectedControllerVersion:1},text:'Preserve the queued work if its final native check outlives authority',interpretation:'literal-message',association:{mode:'ad-hoc',profileConsentVersion:1},busyPolicy:'enqueue'};
  const operation={kind:'submit-message' as const,operationId:'verify-expired',payloadDigest:canonicalDigest(request),actorId:'human',request};const queued=await host.apply(operation);
  workspace.verify=async()=>{clock+=6000;return {ok:true,baseline:digest};};const row=await host.inspect();
  const receipt=await host.admitQueued(operation.operationId,operation.payloadDigest,{actorId:'human',commandId:'verify-expired-command',commandDigest:digest,expectedSessionVersion:row.version,expectedConfigVersion:1,controller:request.controller,expiresAt:new Date(clock+5000).toISOString(),runId:'verify-run',turnId:'verify-turn'});
  expect(receipt).toEqual(queued);expect((await host.queue()).items[0]?.state).toBe('queued');expect(provider.requests).toHaveLength(0);expect(classifications).toBe(1);
  }finally{await host.dispose();}
});

test("default native host attaches actual safe settings readers using its effective configuration and readonly restriction", async () => {
 const {host}=await fixture();
 try{const current=await host.inspect();const catalogue=await host.catalogue();expect(catalogue.entries.find(entry=>entry.commandName==='settings')?.availability).toBe('available');
 const request:Control['CommandInvoke']={commandName:'settings',arguments:{},expectedSessionVersion:current.version,expectedConfigVersion:1,controller:{controllerLeaseId:'controller',expectedControllerVersion:1},catalogueDigest:catalogue.catalogueDigest,busyPolicy:'reject'};
 const outcome=await host.apply({kind:'command',operationId:'native-settings',payloadDigest:canonicalDigest(request),actorId:'human',request});expect(outcome.status).toBe('applied');if(!('result'in outcome)||typeof outcome.result!=='string')throw new Error('missing actual settings');const result=JSON.parse(outcome.result);expect(result).toMatchObject({ok:true,data:{effective:{configVersion:1,baselineCandidateId:'scripted:m',readonlyRestriction:{enabled:false}}}});
 }finally{await host.dispose();}
});

test("local owner recovery closes only an exact expired idle native owner without fabricating a human operation",async()=>{
 let clock=Date.now();const {host,cwd,root}=await fixture([okReply],true,false,()=>clock);const initial=await host.inspect();const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;clock=Date.parse(initial.controller!.expiresAt)+1;
 try{const result=await host.recoverExpiredIdle({sessionId:initial.sessionId,nativeSessionId,controllerLeaseId:initial.controller!.controllerLeaseId,controllerVersion:initial.controller!.version,expectedHistoryVersion:initial.historyVersion,expectedWorkspaceBaseline:initial.workspaceBaseline});expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error.code);expect(result.value.stopped).toBe(true);expect(result.value.session.state).toBe('closed');expect(result.value.controller.lease).toMatchObject({controllerLeaseId:initial.controller!.controllerLeaseId,version:initial.controller!.version+1,state:'released',expiresAt:initial.controller!.expiresAt});const events=(await host.events()).events;const closed=events.findIndex(event=>event.kind==='session-state'&&event.session.state==='closed');const released=events.findIndex(event=>event.kind==='controller-changed'&&event.receipt.lease.state==='released');expect(closed).toBeGreaterThanOrEqual(0);expect(released).toBeGreaterThan(closed);expect(events.some(event=>event.kind==='operation-receipt')).toBe(false);
 }finally{await host.dispose();}
});
test("local owner recovery refuses stale pins, a live controller and busy work without any effect",async()=>{
 let clock=Date.now();const {host,cwd,root,provider}=await fixture([okReply],true,false,()=>clock);const initial=await host.inspect();const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;
 const exact={sessionId:initial.sessionId,nativeSessionId,controllerLeaseId:initial.controller!.controllerLeaseId,controllerVersion:initial.controller!.version,expectedSessionVersion:initial.version,expectedHistoryVersion:initial.historyVersion,expectedWorkspaceBaseline:initial.workspaceBaseline};
 let release!:()=>void;const blocked=new Promise<void>((resolve)=>{release=resolve;});
 try{const cursor=initial.sessionEventCursor;const refusal=async(target:typeof exact)=>{const result=await host.recoverExpiredIdle(target);return result.ok?'applied':result.error.code;};
 expect(await refusal(exact)).toBe('controller-live');clock=Date.parse(initial.controller!.expiresAt)+1;
 for(const stale of [{controllerVersion:2},{controllerLeaseId:'other-lease'},{nativeSessionId:'other-native'},{sessionId:'other-session'},{expectedSessionVersion:initial.version+1},{expectedHistoryVersion:initial.historyVersion+1},{expectedWorkspaceBaseline:'b'.repeat(64)}])expect(await refusal({...exact,...stale})).toBe('stale-reference');
 const unchanged=await host.inspect();expect(unchanged.state).toBe('idle');expect(unchanged.sessionEventCursor).toBe(cursor);expect(unchanged.controller).toEqual(initial.controller);
 clock=Date.now();const original=provider.provider.stream;provider.provider.stream=(request,options)=>(async function*(){await blocked;yield* original(request,options);})();expect((await message(host,'busy-owner','Stay busy while the controller expires')).status).toBe('admitted');
 const busy=await host.inspect();clock=Date.parse(busy.controller!.expiresAt)+1;expect(await refusal({...exact,expectedSessionVersion:busy.version,expectedHistoryVersion:busy.historyVersion})).toBe('session-not-idle');expect((await host.inspect()).activeRunId).toBe('run-busy-owner');
 }finally{release();await host.dispose();}
});
test("uncertain local recovery stop keeps the native lease and fences same-process resume and controller claims",async()=>{
 let child:ReturnType<typeof Bun.spawn>|undefined;let clock=Date.now();const {host,runtime,cwd,root,workspace}=await fixture([okReply],true,false,()=>clock,async()=>true,undefined,undefined,undefined,{spawner:()=>{const proc=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'pipe',stderr:'pipe',detached:true});child=proc;return superviseSpawnedProcess(proc,{kill(){/* A failed OS stop port leaves the actual process alive. */}});}});
 let reopened:Awaited<ReturnType<typeof createSessionHost>>|undefined;
 try{const initial=await host.inspect();const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;expect((await runtime.jobs.start('Owned idle session resource',{phase:'foreground',owner:{kind:'session',identity:nativeSessionId}})).ok).toBe(true);
 const target={sessionId:initial.sessionId,nativeSessionId,controllerLeaseId:initial.controller!.controllerLeaseId,controllerVersion:initial.controller!.version,expectedSessionVersion:initial.version,expectedHistoryVersion:initial.historyVersion,expectedWorkspaceBaseline:initial.workspaceBaseline};
 clock=Date.parse(initial.controller!.expiresAt)+1;const uncertain=await host.recoverExpiredIdle(target);expect(uncertain.ok?'applied':uncertain.error.code).toBe('recovery-required');
 const fenced=await host.inspect();expect(fenced.state).toBe('recovery-required');expect(fenced.controller).toEqual(initial.controller);const events=(await host.events()).events;expect(events.some(event=>event.kind==='controller-changed')).toBe(false);expect(events.some(event=>event.kind==='session-state'&&event.session.state==='closed')).toBe(false);
 const again=await host.recoverExpiredIdle({...target,expectedSessionVersion:fenced.version});expect(again.ok?'applied':again.error.code).toBe('session-not-idle');
 const contenderScript=`import {openLeasedSession} from ${JSON.stringify(join(import.meta.dir,'lease.ts'))};let refusal='none';try{openLeasedSession({cwd:${JSON.stringify(cwd)},dataDir:${JSON.stringify(join(root,'state'))},resumeId:${JSON.stringify(nativeSessionId)}});}catch(error){refusal=error instanceof Error?error.name:'unknown';}console.log(JSON.stringify({refusal}));`;
 const contender=Bun.spawn([process.execPath,'--no-env-file','--config=/dev/null','-e',contenderScript],{cwd,env:{PATH:process.env.PATH??'',KERYX_HOOKS:'off'},stdout:'pipe',stderr:'pipe',stdin:'ignore'});const [stdout,,exit]=await Promise.all([new Response(contender.stdout).text(),new Response(contender.stderr).text(),contender.exited]);expect(exit).toBe(0);expect(JSON.parse(stdout)).toEqual({refusal:'SessionLeasedError'});
 // A live human claim (clock back inside the original lease) isolates the recovery-required fence from expiry.
 clock=Date.now();const takeover=(session:Control['SessionRecord'],id:string):Control['ControllerReceipt']=>({receiptId:`takeover-${id}`,sessionVersion:session.version+1,lease:{controllerLeaseId:`takeover-lease-${id}`,sessionId:session.sessionId,version:session.controller!.version+1,actorId:'human',actorKind:'human-operator',expiresAt:new Date(Date.now()+60_000).toISOString(),state:'held'}});
 const resume=async(owner:Awaited<ReturnType<typeof createSessionHost>>,id:string)=>{const current=await owner.inspect();const request:Control['SessionResume']={expectedSessionVersion:current.version,controller:{controllerLeaseId:current.controller!.controllerLeaseId,expectedControllerVersion:current.controller!.version},expectedHistoryVersion:current.historyVersion,expectedWorkspaceBaseline:current.workspaceBaseline};return owner.apply({kind:'resume-session',operationId:`resume-${id}`,payloadDigest:canonicalDigest(request),actorId:'human',request});};
 const claim=await host.applyController(takeover(fenced,'one'),{actorId:'human',commandId:'takeover-one',commandDigest:digest});expect(claim.ok?'applied':claim.error.code).toBe('recovery-required');expect((await resume(host,'one')).status).toBe('recovery-required');expect((await host.inspect()).state).toBe('recovery-required');
 // The same process re-opening the native session receives its own retained lease handle (lease.ts); the host must still refuse it.
 const second=createNativeSessionRuntime({cwd,provider:scriptedProvider([okReply]).provider,providerId:'scripted',modelId:'m'});
 reopened=await createSessionHost({cwd,dataDir:join(root,'state'),record:record(),runtime:second,workspace,authorizeController:async()=>true,authorizeQueued:async()=>true,authorizeAction:async()=>true});
 const restored=await reopened.inspect();expect(restored.state).toBe('recovery-required');expect(reopened.nativeSessionId()).toBe(nativeSessionId);
 const reclaim=await reopened.applyController(takeover(restored,'two'),{actorId:'human',commandId:'takeover-two',commandDigest:digest});expect(reclaim.ok?'applied':reclaim.error.code).toBe('recovery-required');expect((await resume(reopened,'two')).status).toBe('recovery-required');
 const reopenedRecovery=await reopened.recoverExpiredIdle({...target,expectedSessionVersion:restored.version});expect(reopenedRecovery.ok?'applied':reopenedRecovery.error.code).not.toBe('applied');expect((await reopened.inspect()).state).toBe('recovery-required');
 }finally{if(child){try{process.kill(-child.pid,'SIGKILL');}catch{/* The process group is already gone. */}await child.exited;}await reopened?.dispose();await host.dispose();}
},20000);
test("unknown actual owned process stop retains the native lease and never confirms idle disposal",async()=>{
 let child:ReturnType<typeof Bun.spawn>|undefined;const {host,runtime,cwd,root}=await fixture([okReply],true,false,undefined,async()=>true,undefined,undefined,undefined,{spawner:()=>{const proc=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'pipe',stderr:'pipe',detached:true});child=proc;return superviseSpawnedProcess(proc,{kill(){/* Inject a failed OS stop port; the actual process remains alive for proof. */}});}});
 try{const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;const started=await runtime.jobs.start('Owned session resource',{phase:'foreground',owner:{kind:'session',identity:nativeSessionId}});expect(started.ok).toBe(true);expect((await runtime.stop()).status).toBe('unknown');expect((await runtime.stop()).status).toBe('unknown');await host.dispose();expect((await host.inspect()).state).toBe('recovery-required');
 // A same-process re-open returns this process's own held handle by design (lease.ts), so the retained lease is proven against a separate contender process.
 const script=`import {openLeasedSession} from ${JSON.stringify(join(import.meta.dir,'lease.ts'))};let refusal='none';
try{openLeasedSession({cwd:${JSON.stringify(cwd)},dataDir:${JSON.stringify(join(root,'state'))},resumeId:${JSON.stringify(nativeSessionId)}});}catch(error){refusal=error instanceof Error?error.name:'unknown';}
console.log(JSON.stringify({refusal}));`;
 const contender=Bun.spawn([process.execPath,'--no-env-file','--config=/dev/null','-e',script],{cwd,env:{PATH:process.env.PATH??'',KERYX_HOOKS:'off'},stdout:'pipe',stderr:'pipe',stdin:'ignore'});
 const [stdout,stderr,exit]=await Promise.all([new Response(contender.stdout).text(),new Response(contender.stderr).text(),contender.exited]);
 expect(exit).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({refusal:'SessionLeasedError'});expect(()=>process.kill(-child!.pid,0)).not.toThrow();
 }finally{if(child){try{process.kill(-child.pid,'SIGKILL');}catch{/* The process group is already gone. */}await child.exited;}await host.dispose();}
},15000);

/** A separate real process tries to open the native session: `SessionLeasedError` proves the lease is still held. */
async function contenderRefusal(cwd:string,dataDir:string,nativeSessionId:string):Promise<string>{
 const script=`import {openLeasedSession} from ${JSON.stringify(join(import.meta.dir,'lease.ts'))};let refusal='none';try{openLeasedSession({cwd:${JSON.stringify(cwd)},dataDir:${JSON.stringify(dataDir)},resumeId:${JSON.stringify(nativeSessionId)}});}catch(error){refusal=error instanceof Error?error.name:'unknown';}console.log(JSON.stringify({refusal}));`;
 const contender=Bun.spawn([process.execPath,'--no-env-file','--config=/dev/null','-e',script],{cwd,env:{PATH:process.env.PATH??'',KERYX_HOOKS:'off'},stdout:'pipe',stderr:'pipe',stdin:'ignore'});
 const [stdout,,exit]=await Promise.all([new Response(contender.stdout).text(),new Response(contender.stderr).text(),contender.exited]);expect(exit).toBe(0);return (JSON.parse(stdout) as {refusal:string}).refusal;
}
/** A real HTTP MCP fixture bound through the production local-approval path; `close` is observed and can be made to fail. */
async function mcpHost(clock:()=>number){
 const {startMockHttpMcpServer}=await import('../../fixtures/mcp-servers/http-server');const {configureNativeSessionServices}=await import('./native-services-production');
 const server=await startMockHttpMcpServer();const root=await mkdtemp(join(tmpdir(),'keryx-native-host-mcp-'));roots.push(root);const cwd=join(root,'checkout');expect(await Bun.spawn(['git','init',cwd],{stdout:'ignore',stderr:'pipe'}).exited).toBe(0);
 const observed={closes:0,results:[] as Array<{stopped:boolean}>,failClose:false};
 const runtime=createNativeSessionRuntime({cwd,provider:scriptedProvider([okReply]).provider,providerId:'scripted',modelId:'m',servicesFactory:async(context)=>{const services=await configureNativeSessionServices({...context,locallyApproved:{httpMcp:[{name:'fixture',url:server.url}],beforeConnect:async()=>{}}},new AbortController().signal);
  return{...services,async close(){observed.closes++;if(observed.failClose)return{stopped:false};const result=await services.close();observed.results.push(result);return result;}};}});
 const host=await createSessionHost({cwd,dataDir:join(root,'state'),record:record(),runtime,now:clock,workspace:{verify:async()=>({ok:true,baseline:digest}),checkpoint:async()=>({ok:true,baseline:digest})},authorizeController:async()=>true,authorizeQueued:async()=>true,authorizeAction:async()=>true});
 return{server,root,cwd,runtime,host,observed,nativeSessionId:listSessions(cwd,join(root,'state'))[0]!.id};
}
test("dispose and expired-idle recovery finalize the production-bound HTTP MCP session",async()=>{
 let clock=Date.now();const disposing=await mcpHost(()=>clock);
 try{expect(disposing.runtime.integrationPort()?.mcp?.status()).toEqual([{name:'fixture',status:'connected',toolCount:2}]);expect(disposing.server.requests().length).toBeGreaterThan(0);
  await disposing.host.dispose();expect(disposing.observed.closes).toBe(1);expect(disposing.observed.results).toEqual([{stopped:true}]);expect(disposing.runtime.integrationPort()?.mcp).toBeUndefined();
  expect(await contenderRefusal(disposing.cwd,join(disposing.root,'state'),disposing.nativeSessionId)).toBe('none');
 }finally{await disposing.host.dispose();await disposing.server.stop();}
 const recovering=await mcpHost(()=>clock);
 try{const initial=await recovering.host.inspect();clock=Date.parse(initial.controller!.expiresAt)+1;
  const result=await recovering.host.recoverExpiredIdle({sessionId:initial.sessionId,nativeSessionId:recovering.nativeSessionId,controllerLeaseId:initial.controller!.controllerLeaseId,controllerVersion:initial.controller!.version,expectedSessionVersion:initial.version,expectedHistoryVersion:initial.historyVersion,expectedWorkspaceBaseline:initial.workspaceBaseline});
  expect(result.ok?'applied':result.error.code).toBe('applied');expect(recovering.observed.closes).toBe(1);expect(recovering.observed.results).toEqual([{stopped:true}]);expect(recovering.runtime.integrationPort()?.mcp).toBeUndefined();
 }finally{await recovering.host.dispose();await recovering.server.stop();}
},20000);
test("an unproven session service close keeps the native lease and the session fenced on dispose and on recovery",async()=>{
 let clock=Date.now();const disposing=await mcpHost(()=>clock);
 try{disposing.observed.failClose=true;await disposing.host.dispose();expect(disposing.observed.closes).toBe(1);expect((await disposing.host.inspect()).state).toBe('recovery-required');
  expect(await contenderRefusal(disposing.cwd,join(disposing.root,'state'),disposing.nativeSessionId)).toBe('SessionLeasedError');
 }finally{disposing.observed.failClose=false;await disposing.server.stop();}
 const recovering=await mcpHost(()=>clock);
 try{recovering.observed.failClose=true;const initial=await recovering.host.inspect();clock=Date.parse(initial.controller!.expiresAt)+1;
  const result=await recovering.host.recoverExpiredIdle({sessionId:initial.sessionId,nativeSessionId:recovering.nativeSessionId,controllerLeaseId:initial.controller!.controllerLeaseId,controllerVersion:initial.controller!.version,expectedSessionVersion:initial.version,expectedHistoryVersion:initial.historyVersion,expectedWorkspaceBaseline:initial.workspaceBaseline});
  expect(result.ok?'applied':result.error.code).toBe('recovery-required');const fenced=await recovering.host.inspect();expect(fenced.state).toBe('recovery-required');expect(fenced.controller).toEqual(initial.controller);
  expect((await recovering.host.events()).events.some(event=>event.kind==='controller-changed')).toBe(false);
  expect(await contenderRefusal(recovering.cwd,join(recovering.root,'state'),recovering.nativeSessionId)).toBe('SessionLeasedError');
 }finally{recovering.observed.failClose=false;await recovering.host.dispose();await recovering.server.stop();}
},20000);
test("dispose of a stalled routing selection returns within its bound and keeps the session fenced with the lease held",async()=>{
 let began!:()=>void;const started=new Promise<void>((resolve)=>{began=resolve;});
 // The classifier ignores its abort signal and never settles.
 const {host,cwd,root}=await fixture([okReply],true,false,undefined,async()=>true,undefined,undefined,undefined,{routingEnabled:true,classify:async()=>{began();return new Promise<undefined>(()=>{});}});
 const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;
 void message(host,'stalled-selection','Classify this and never return').catch(()=>undefined);await started;
 const begun=Date.now();await host.dispose();const elapsed=Date.now()-begun;
 expect(elapsed).toBeLessThan(5000);expect((await host.inspect()).state).toBe('recovery-required');
 expect(await contenderRefusal(cwd,join(root,'state'),nativeSessionId)).toBe('SessionLeasedError');
},15000);
test("dispose of a same-process re-opened host never releases a native lease another runtime left unproven",async()=>{
 let child:ReturnType<typeof Bun.spawn>|undefined;const {host,runtime,cwd,root,workspace}=await fixture([okReply],true,false,undefined,async()=>true,undefined,undefined,undefined,{spawner:()=>{const proc=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'pipe',stderr:'pipe',detached:true});child=proc;return superviseSpawnedProcess(proc,{kill(){/* A failed OS stop port leaves the actual process alive. */}});}});
 let reopened:Awaited<ReturnType<typeof createSessionHost>>|undefined;
 try{const nativeSessionId=listSessions(cwd,join(root,'state'))[0]!.id;expect((await runtime.jobs.start('Owned session resource',{phase:'foreground',owner:{kind:'session',identity:nativeSessionId}})).ok).toBe(true);
  await host.dispose();expect((await host.inspect()).state).toBe('recovery-required');
  // The same process re-opens the native session with a fresh runtime whose own stop succeeds.
  reopened=await createSessionHost({cwd,dataDir:join(root,'state'),record:record(),runtime:createNativeSessionRuntime({cwd,provider:scriptedProvider([okReply]).provider,providerId:'scripted',modelId:'m'}),workspace,authorizeController:async()=>true,authorizeQueued:async()=>true,authorizeAction:async()=>true});
  expect(reopened.nativeSessionId()).toBe(nativeSessionId);expect((await reopened.inspect()).state).toBe('recovery-required');
  await reopened.dispose();expect((await reopened.inspect()).state).toBe('recovery-required');
  expect(await contenderRefusal(cwd,join(root,'state'),nativeSessionId)).toBe('SessionLeasedError');expect(()=>process.kill(-child!.pid,0)).not.toThrow();
 }finally{if(child){try{process.kill(-child.pid,'SIGKILL');}catch{/* The process group is already gone. */}await child.exited;}await reopened?.dispose();}
},15000);
test("an unreadable fork transcript leaves no orphaned fork session and holds no native fork lease",async()=>{
 const store=await import('./store');const original={...store};let refusal:unknown;let forkCwd='';
 const {host,cwd,root}=await fixture([okReply],true,false,undefined,async()=>true,undefined,undefined,undefined,{lifecycle:{
  async apply(input){forkCwd=input.sourceCwd;try{await input.forkNative({throughHistoryCursor:2,expectedHistoryVersion:input.source.historyVersion,targetCwd:input.sourceCwd,title:'Unreadable fork'});}catch(cause){refusal=cause;}return{ok:false,error:{code:'forbidden',message:'forbidden'}};},
  async list(){return{ok:true,value:[]};},async open(){return{ok:false,error:{code:'not-found',message:'not-found'}};},
 }});
 try{await message(host,'fork-source','Only executed native turn');await idle(host);const sourceId=listSessions(cwd,join(root,'state'))[0]!.id;
  // The fork's own transcript cannot be read back right after it was written; the source stays readable.
  void mock.module('./store',()=>({...original,loadContext:(target:string,id:string,dataDir?:string)=>{if(id!==sourceId)throw new Error('unreadable fork transcript');return original.loadContext(target,id,dataDir);}}));
  const row=await host.inspect();const catalogue=await host.catalogue();
  const request:Control['CommandInvoke']={commandName:'sessions.fork',arguments:{throughHistoryCursor:2,expectedHistoryVersion:row.historyVersion,targetCheckoutId:row.checkoutId,expectedInventoryVersion:1,expectedHeadSha:'a'.repeat(40),title:'Unreadable fork'},catalogueDigest:catalogue.catalogueDigest,
   expectedSessionVersion:row.version,expectedConfigVersion:row.config.configVersion,controller:{controllerLeaseId:'controller',expectedControllerVersion:1},busyPolicy:'reject'};
  expect((await host.apply({kind:'command',operationId:'unreadable-fork',payloadDigest:canonicalDigest(request),actorId:'human',request})).status).toBe('rejected');
  void mock.module('./store',()=>original);
  expect(forkCwd).toBe(cwd);expect(refusal).toMatchObject({name:'SessionHostError',code:'native-fork-history-unreadable'});
  expect(listSessions(cwd,join(root,'state')).map(session=>session.id)).toEqual([sourceId]);
  expect(readdirSync(join(sessionDir(cwd,sourceId,join(root,'state')),'..')).filter(name=>!name.startsWith('.'))).toEqual([sourceId]);
 }finally{void mock.module('./store',()=>original);await host.dispose();}
});
/** A fixture whose every model round waits until the returned release: the test decides when the busy turn ends. */
async function gatedFixture() {
  const fixtured = await fixture(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const original = fixtured.provider.provider.stream;
  fixtured.provider.provider.stream = (request, options) => (async function* () { await gate; yield* original(request, options); })();
  return { ...fixtured, release };
}
const closeController = { controllerLeaseId: "controller", expectedControllerVersion: 1 };
async function closeWhenIdle(host: Awaited<ReturnType<typeof createSessionHost>>, operationId: string) {
  const close: Control["SessionClose"] = { expectedSessionVersion: (await host.inspect()).version, controller: closeController, mode: "when-idle" };
  return host.apply({ kind: "close-session", operationId, payloadDigest: canonicalDigest(close), actorId: "human", request: close });
}
async function submit(host: Awaited<ReturnType<typeof createSessionHost>>, operationId: string, text: string) {
  const input: Control["MessageSubmit"] = { expectedSessionVersion: (await host.inspect()).version, controller: closeController, expectedConfigVersion: 1, text, interpretation: "literal-message", busyPolicy: "enqueue", association: { mode: "ad-hoc", profileConsentVersion: 1 } };
  return host.apply({ kind: "submit-message", operationId, payloadDigest: canonicalDigest(input), actorId: "human", request: input });
}
async function settledState(host: Awaited<ReturnType<typeof createSessionHost>>, states: string[]) {
  for (let n = 0; n < 400; n++) { const current = await host.inspect(); if (states.includes(current.state)) return current; await Bun.sleep(5); }
  throw new Error("native host did not settle");
}
const closeReceipts = async (host: Awaited<ReturnType<typeof createSessionHost>>, operationId: string) => (await host.events()).events.flatMap((event) => event.kind === "operation-receipt" && event.receipt.operationId === operationId ? [event.receipt.status] : []);

test("a when-idle close during a turn is recorded pending, seals new submissions and closes at the turn boundary with earlier queued input suspended", async () => {
  const { host, provider, release } = await gatedFixture();
  try {
    await message(host, "busy-before-close", "Busy turn");
    expect((await submit(host, "queued-before-close", "Queued before the close")).status).toBe("queued");
    const pending = await closeWhenIdle(host, "close-when-idle"); expect(pending.status).toBe("pending"); expect((await host.inspect()).state).toBe("busy");
    expect(await closeReceipts(host, "close-when-idle")).toEqual(["pending"]);
    // Sealed: a later submission is refused and nothing new joins the queue; a second close is refused while the first is pending.
    expect((await submit(host, "after-close", "After the close")).status).toBe("rejected");
    expect((await closeWhenIdle(host, "second-close")).status).toBe("rejected");
    expect((await host.queue()).items.map((item) => [item.operationId, item.state])).toEqual([["queued-before-close", "queued"]]);
    release();
    const closed = await settledState(host, ["closed", "recovery-required"]); expect(closed.state).toBe("closed"); expect(closed.activeRunId).toBeNull();
    expect(await closeReceipts(host, "close-when-idle")).toEqual(["pending", "applied"]);
    expect((await host.queue()).items.map((item) => [item.operationId, item.state])).toEqual([["queued-before-close", "suspended"]]);
    expect(provider.requests).toHaveLength(1);
  } finally { release(); await host.dispose(); }
});

test("a when-idle close whose turn ends without a measured baseline resolves recovery-required and never reports closed", async () => {
  const { host, workspace, release } = await gatedFixture();
  try {
    await message(host, "unproven-before-close", "Busy turn");
    expect((await closeWhenIdle(host, "close-unproven")).status).toBe("pending");
    workspace.checkpoint = async () => ({ ok: false, error: { code: "workspace-conflict", message: "baseline unavailable" } });
    release();
    expect((await settledState(host, ["closed", "recovery-required"])).state).toBe("recovery-required");
    for (let n = 0; n < 200 && (await closeReceipts(host, "close-unproven")).length < 2; n++) await Bun.sleep(5);
    expect(await closeReceipts(host, "close-unproven")).toEqual(["pending", "recovery-required"]); expect((await host.inspect()).state).toBe("recovery-required");
  } finally { release(); await host.dispose(); }
});

test("the native decision window may only be shortened: a longer, empty or fractional window is refused before any effect", async () => {
  const { host, runtime, workspace, cwd, root } = await fixture();
  try {
    for (const decisionTtlMs of [120_001, 0, 1.5]) await expect(createSessionHost({ cwd, dataDir: join(root, "state"), record: { ...record(), sessionId: "session-decision-window" }, runtime, workspace, decisionTtlMs })).rejects.toMatchObject({ code: "invalid-decision-ttl" });
  } finally { await host.dispose(); }
});

test("every command outcome the host sends satisfies the result check Hub applies: a long help is bounded and a violating result is a rejection that leaves the session usable", async () => {
  const resultSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: { n: { type: "integer", minimum: 0, maximum: 1 } }, required: ["n"] };
  const violating: NativeCommandContribution = { entry: { commandName: "fixture.violating", summary: "Returns a result outside its own schema", handlerId: "native.fixture.violating",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema, mutationClass: "read", states: ["idle", "busy", "paused"],
    busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "fixture" }, structuredResult: true, execute: async () => ({ n: 7 }) };
  const { host } = await fixture([okReply], true, false, undefined, async () => true, [violating]);
  const invoke = async (commandName: string, id: string) => { const row = await host.inspect(); const cat = await host.catalogue();
    const request: Control["CommandInvoke"] = { commandName, arguments: {}, catalogueDigest: cat.catalogueDigest, expectedSessionVersion: row.version,
      expectedConfigVersion: row.config.configVersion, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, busyPolicy: "reject" };
    return host.apply({ kind: "command", operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request }); };
  try {
    const catalogue = await host.catalogue();
    // The real catalogue is far larger than the byte quota once serialized.
    expect(Buffer.byteLength(JSON.stringify(JSON.stringify(catalogue)))).toBeGreaterThan(32768);
    for (const [commandName, id, status] of [["fixture.violating", "violating", "rejected"], ["help", "help", "applied"], ["status", "status-after", "applied"]] as const) {
      expect(await invoke(commandName, id)).toMatchObject({ status, errorCode: status === "rejected" ? "implementation-gap" : null });
      const sent = (await host.events()).events.find((event) => event.kind === "command-outcome" && event.outcome.operationId === id);
      if (sent?.kind !== "command-outcome") throw new Error(`no outcome event for ${id}`);
      const entry = catalogue.entries.find((item) => item.commandName === commandName)!;
      expect(sent.outcome.status === "rejected" || validateArguments(entry.resultSchema, sent.outcome.result).ok).toBe(true);
    }
    expect((await host.inspect()).state).toBe("idle");
  } finally { await host.dispose(); }
});
