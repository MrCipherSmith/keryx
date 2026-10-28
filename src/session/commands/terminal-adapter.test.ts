import { expect, test } from "bun:test";
import { validateArguments, validateControl, type Control } from "../../remote-control/protocol";
import type { SessionHostOperation, SessionHostReceipt } from "../host-types";
import { createCommandCatalogue } from "./catalogue";
import { rewindCommands } from "./rewind";
import type { NativeCommandContribution } from "./handlers";
import { createTerminalSessionAdapter, type TerminalAuthority } from "./terminal-adapter";

const digest = "a".repeat(64);
const adHoc: Control["FlowAssociation"] = { mode: "ad-hoc", profileConsentVersion: 1 };
type Results = Partial<Record<string, Control["BoundedJson"]>>;
function recordingHost(options: { results?: Results; queue?: Control["QueueItem"][]; authority?: Partial<TerminalAuthority>; contributions?: NativeCommandContribution[] } = {}) {
  const record: Control["SessionRecord"] = { sessionId: "session-test", projectId: "project-test", machineId: "machine-test", checkoutId: "checkout-test", agentProfileId: "native",
    version: 3, historyVersion: 1, state: "idle", title: "Adapter fixture",
    config: { configVersion: 2, baselineCandidateId: "scripted:m", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" }, policyDigest: digest, capabilityDigest: digest },
    controller: { controllerLeaseId: "controller", sessionId: "session-test", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "held" },
    activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: digest, forkedFromSessionId: null,
    capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
  const catalogue = createCommandCatalogue(digest, options.contributions);
  const sent: Control["CommandInvoke"][] = [];
  const operations: SessionHostOperation[] = [];
  const host = {
    inspect: async () => structuredClone(record),
    catalogue: async () => catalogue,
    queue: async (): Promise<Control["QueuePage"]> => ({ items: structuredClone(options.queue ?? []), queueVersion: 4, cursor: 0, hasMore: false }),
    apply: async (operation: SessionHostOperation): Promise<SessionHostReceipt> => {
      operations.push(operation);
      if (operation.kind !== "command") return { receiptId: "receipt", operationId: operation.operationId, sessionId: record.sessionId, kind: operation.kind === "edit-queue" ? "edit-queue" : "remove-queue", status: "applied", observedSessionVersion: record.version, session: structuredClone(record), reason: "none" };
      sent.push(operation.request);
      return { operationId: operation.operationId, sessionId: record.sessionId, commandName: operation.request.commandName, status: "applied", sessionVersion: record.version,
        result: options.results?.[operation.request.commandName] ?? null, confirmationId: null, errorCode: null, confirmation: null, runId: null, turnId: null };
    },
  };
  return { host, sent, operations, catalogue, adapter: createTerminalSessionAdapter(host, { actorId: "human", controllerLeaseId: "controller", controllerVersion: 1, ...options.authority }) };
}
async function sends(line: string, options: Parameters<typeof recordingHost>[0] = {}) {
  const fixture = recordingHost(options); const receipt = await fixture.adapter.execute(line);
  const request = fixture.sent[0];
  const entry = fixture.catalogue.entries.find((item) => item.commandName === request?.commandName);
  return { receipt, request, sent: fixture.sent, operations: fixture.operations, schemaValid: request !== undefined && entry !== undefined && validateArguments(entry.inputSchema, request.arguments).ok };
}

test("typed TUI arguments become the catalogue entry's closed typed input, never a positional array", async () => {
  const trail = await sends("/trail 5 tool=read_file from=2");
  expect(trail.request).toMatchObject({ commandName: "trail", arguments: { count: 5, tool: "read_file", from: 2 } });
  expect(trail.schemaValid).toBe(true);
  expect((await sends("/notes design notes")).request).toMatchObject({ commandName: "notes", arguments: { key: "design notes" } });
  expect((await sends("/setup refresh")).request).toMatchObject({ commandName: "setup", arguments: { scenario: "refresh" } });
  expect((await sends("/demote job-7")).request).toMatchObject({ commandName: "demote", arguments: { taskId: "job-7" } });
  const typed = await sends("/autoreview arbiter 42");
  expect(typed.request).toMatchObject({ commandName: "autoreview.arbiter", arguments: { selector: "42" } }); expect(typed.schemaValid).toBe(true);
});

test("TUI subcommands map to the dotted handler the catalogue advertises", async () => {
  for (const [line, commandName, args] of [
    ["/intake list", "intake.list", {}], ["/tasks output job-1 4", "tasks.output", { taskId: "job-1", cursor: 4 }], ["/tasks kill job-1", "tasks.kill", { taskId: "job-1" }],
    ["/plan on", "plan.set", { enabled: true }], ["/plan off", "plan.set", { enabled: false }], ["/route ON", "route.set", { enabled: true }], ["/autoreview ls", "autoreview.ls", {}],
    ["/projectctx refs", "projectctx.refs", {}], ["/remote-control off", "remote-control.off", {}], ["/remote-control fixture-topic", "remote-control.name", { name: "fixture-topic" }], ["/remote-control on", "remote-control.name", {}],
    ["/bus send @peer hello there", "bus.send", { to: "@peer", text: "hello there" }], ["/bus pause @peer --ttl 30m hold on", "bus.pause", { to: "@peer", scope: "turns", ttlMinutes: 30, reason: "hold on" }],
    ["/review parity", "reviews", { section: "parity" }], ["/decisions arms", "decisions", { section: "arms" }],
  ] as const) {
    const sent = await sends(line);
    expect(sent.request).toMatchObject({ commandName, arguments: args });
    expect(sent.schemaValid).toBe(true);
  }
});

test("/reasoning off sends the typed wire value none; argument-free commands stay argument-free", async () => {
  expect((await sends("/reasoning off")).request).toMatchObject({ commandName: "reasoning", arguments: { effort: "none" } });
  expect((await sends("/reasoning high")).request).toMatchObject({ commandName: "reasoning", arguments: { effort: "high" } });
  expect((await sends("/status")).request).toMatchObject({ commandName: "status", arguments: {} });
  expect((await sends("/remote-control")).request).toMatchObject({ commandName: "remote-control", arguments: {} });
});

test("malformed input and unknown subcommands are refused locally the way the TUI refuses them, without reaching the host", async () => {
  for (const line of ["/plan maybe", "/reasoning loud", "/tasks kill", "/tasks output job-1 x", "/route sideways", "/setup init extra", "/demote a b",
    "/goal", "/goal ship it --workspace", "/goal ship it --auto", "/intake list now", "/autoreview frobnicate", "/trail tool=", "/bus warp", "/remote-control a b",
    "/model a b", "/connect test", "/connect frobnicate x", "/history 21", "/history 0", "/projectctx warn", "/decisions reason because", "/mcp trust revoke", "/mcp disconnect",
    "/routing configure on profile=local", "/routing configure maybe profile=a candidates=a fallback=a", "/approvals allow-once", "/questions.answer q1", "/questions.answer q1 --own",
    "/flows a b", "/ac check", "/ac flow-1 check", "/flow origin", "/flow origin flow-1 human-request --reason why", "/reviews layers", "/triggers nightly run",
    "/rewind 0", "/rewind 1 sideways", "/rewind confirm", "/rewind.preview confirm", "/queue force 1", "/queue edit 1", "/queue edit", "/queue frobnicate", "/editguard on", "/jevprofile toggle"]) {
    const refused = await sends(line);
    expect({ line, sent: refused.sent.length }).toEqual({ line, sent: 0 });
    expect(refused.receipt).toMatchObject({ status: "rejected", errorCode: "invalid-arguments", sessionId: "session-test", sessionVersion: 3 });
  }
});

test("modal-only native operations have a terminal text form that is the handler's exact closed typed input", async () => {
  for (const [line, commandName, args] of [
    ["/model local-candidate", "model", { candidateId: "local-candidate" }], ["/connect test local-candidate", "connect.test", { id: "local-candidate" }], ["/connect select c2", "connect.select", { id: "c2" }],
    ["/mcp disconnect fixture", "mcp.disconnect", { name: "fixture" }], ["/mcp trust list", "mcp.trust-list", {}], ["/mcp trust revoke srv__tool", "mcp.trust-revoke-fqn", { fqn: "srv__tool" }], ["/mcp trust revoke all", "mcp.trust-revoke-all", {}],
    ["/routing configure on profile=local candidates=a,b fallback=a", "routing.configure", { enabled: true, profileId: "local", candidateIds: ["a", "b"], fallbackCandidateId: "a" }],
    ["/history", "history", {}], ["/history 5", "history", { count: 5 }], ["/reasoning", "reasoning.show", {}],
    ["/flows flow-7", "flows", { flowId: "flow-7" }], ["/ac flow-7", "ac", { flowId: "flow-7" }], ["/workspace workspace-a", "workspace", { workspaceId: "workspace-a" }], ["/triggers nightly", "triggers", { name: "nightly" }],
    ["/flow origin flow-7", "flow", { flowId: "flow-7" }], ["/reviews depth", "reviews", { section: "depth" }], ["/projectctx last", "projectctx.last", {}], ["/projectctx references", "projectctx.references", {}],
    ["/editguard status", "editguard.status", {}], ["/jevprofile entries", "jevprofile.entries", {}], ["/rewind", "rewind", {}],
  ] as const) {
    // Probes, MCP effects and the like are workspace-class: the operator's work mode is part of the terminal's authority.
    const sent = await sends(line, { authority: { work: adHoc } });
    expect({ line, request: sent.request }).toMatchObject({ line, request: { commandName, arguments: args } });
    expect({ line, valid: sent.schemaValid }).toEqual({ line, valid: true });
  }
});

test("a workspace-class command runs as one new local run under the operator's explicit work mode, and is refused without one", async () => {
  const withWork = await sends("/goal Ship the fixture --auto 2", { authority: { work: adHoc } });
  const operation = withWork.operations[0];
  if (operation?.kind !== "command") throw new Error("no command sent");
  expect(operation).toMatchObject({ request: { commandName: "goal", arguments: { text: "Ship the fixture", autoRounds: 2 } }, association: adHoc });
  expect(operation.runId).toMatch(/^[0-9a-f-]{36}$/); expect(operation.turnId).toMatch(/^[0-9a-f-]{36}$/); expect(operation.runId).not.toBe(operation.turnId);
  const without = await sends("/goal Ship the fixture");
  expect(without.operations).toEqual([]);
  expect(without.receipt).toMatchObject({ status: "rejected", errorCode: "forbidden", commandName: "goal" });
  // A read never carries a run identity.
  const read = await sends("/status", { authority: { work: adHoc } });
  expect(read.operations[0]).not.toHaveProperty("runId");
});

test("an approval or question answer names the card by id; its run, turn, fingerprint and policy pins come from this session's own pending list", async () => {
  const pending = { approvalId: "ap1", runId: "r1", turnId: "t1", fingerprint: "f".repeat(64), policyDigest: digest };
  const results: Results = { approvals: JSON.stringify({ ok: true, data: [pending] }), "questions.list": [{ questionId: "q1", runId: "r1", turnId: "t1", fingerprint: "e".repeat(64) }] };
  const allowed = await sends("/approvals allow-once ap1", { results });
  expect(allowed.sent.map((request) => request.commandName)).toEqual(["approvals", "approvals.allow-once"]);
  expect(allowed.sent[1]).toMatchObject({ arguments: pending });
  const stale = await sends("/approvals deny ap2", { results });
  expect(stale.sent.map((request) => request.commandName)).toEqual(["approvals"]);
  expect(stale.receipt).toMatchObject({ status: "rejected", errorCode: "forbidden", commandName: "approvals.deny" });
  const answered = await sends("/questions.answer q1 yes --reason because   so", { results });
  expect(answered.sent[1]).toMatchObject({ commandName: "questions.answer", arguments: { questionId: "q1", runId: "r1", turnId: "t1", fingerprint: "e".repeat(64), answers: { kind: "option", choice: "yes", reason: "because   so" } } });
  const entry = createCommandCatalogue(digest).entries.find((row) => row.commandName === "questions.answer")!;
  expect(validateArguments(entry.inputSchema, answered.sent[1]!.arguments).ok).toBe(true);
  expect((await sends("/questions.answer q1 --own  my   own answer", { results })).sent[1]).toMatchObject({ arguments: { answers: { kind: "own", text: "my   own answer" } } });
  expect((await sends("/questions.answer q9 --cancel", { results })).receipt).toMatchObject({ status: "rejected", errorCode: "forbidden" });
});

test("/queue remove|edit N applies the frozen queue operation to the qN pending item under its exact versions", async () => {
  const item = (queueItemId: string, position: number, version: number): Control["QueueItem"] => ({ queueItemId, version, kind: "message", operationId: `op-${queueItemId}`, state: "queued", position, text: "queued", commandName: null, expectedConfigVersion: 2, replacesOperationId: null });
  const queue = [item("second", 1, 5), item("first", 0, 2), { ...item("gone", 2, 1), state: "removed" as const }];
  const removed = await sends("/queue remove 2", { queue });
  expect(removed.operations).toHaveLength(1);
  const remove = removed.operations[0]!;
  if (remove.kind !== "remove-queue") throw new Error("not a queue removal");
  expect(remove.request).toEqual({ expectedSessionVersion: 3, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, queueItemId: "second", expectedQueueVersion: 4, expectedItemVersion: 5 });
  expect(validateControl("QueueRemove", remove.request).ok).toBe(true);
  const edited = (await sends("/queue edit 1 new   text", { queue })).operations[0]!;
  if (edited.kind !== "edit-queue") throw new Error("not a queue edit");
  expect(edited.request).toMatchObject({ queueItemId: "first", expectedItemVersion: 2, text: "new   text" }); expect(validateControl("QueueEdit", edited.request).ok).toBe(true);
  expect((await sends("/queue remove", { queue })).operations[0]).toMatchObject({ kind: "remove-queue", request: { queueItemId: "first" } });
  const missing = await sends("/queue remove 3", { queue });
  expect(missing.operations).toEqual([]); expect(missing.receipt).toMatchObject({ status: "rejected", errorCode: "forbidden", commandName: "queue" });
});

test("/rewind N [mode] previews against the current history version; /rewind confirm applies exactly that preview and any other input withdraws it", async () => {
  const preview = { seq: 1, mode: "files", previewDigest: "c".repeat(64), snapshotDigest: "d".repeat(64), workspaceBaseline: digest, historyVersion: 1, paths: ["a.txt"], messagesRemoved: 0 };
  const fixture = recordingHost({ contributions: rewindCommands(true), authority: { work: adHoc }, results: { "rewind.preview": JSON.stringify({ ok: true, status: "preview", data: preview }) } });
  await fixture.adapter.execute("/rewind 1 files");
  expect(fixture.sent[0]).toMatchObject({ commandName: "rewind.preview", arguments: { seq: 1, mode: "files", expectedHistoryVersion: 1 } });
  await fixture.adapter.execute("/rewind confirm");
  const apply = fixture.operations[1];
  if (apply?.kind !== "command") throw new Error("no apply sent");
  expect(apply).toMatchObject({ request: { commandName: "rewind.apply", arguments: { seq: 1, mode: "files", expectedHistoryVersion: 1, previewDigest: "c".repeat(64), workspaceBaseline: digest } }, association: adHoc });
  expect(apply.runId).toMatch(/^[0-9a-f-]{36}$/);
  // The readline grammar's rule: another line in between cancels the pending preview.
  await fixture.adapter.execute("/rewind 1 history"); await fixture.adapter.execute("/status");
  expect(await fixture.adapter.execute("/rewind confirm")).toMatchObject({ status: "rejected", errorCode: "invalid-arguments", commandName: "rewind.apply" });
  expect(fixture.sent.filter((request) => request.commandName === "rewind.apply")).toHaveLength(1);
});
