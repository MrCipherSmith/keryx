import { expect, test } from "bun:test";
import { validateArguments, type Control } from "../../remote-control/protocol";
import type { SessionHostOperation, SessionHostReceipt } from "../host-types";
import { createCommandCatalogue } from "./catalogue";
import { createTerminalSessionAdapter } from "./terminal-adapter";

const digest = "a".repeat(64);
function recordingHost() {
  const record: Control["SessionRecord"] = { sessionId: "session-test", projectId: "project-test", machineId: "machine-test", checkoutId: "checkout-test", agentProfileId: "native",
    version: 3, historyVersion: 1, state: "idle", title: "Adapter fixture",
    config: { configVersion: 2, baselineCandidateId: "scripted:m", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["scripted:m"], fallbackCandidateId: "scripted:m" }, policyDigest: digest, capabilityDigest: digest },
    controller: { controllerLeaseId: "controller", sessionId: "session-test", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "held" },
    activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: digest, forkedFromSessionId: null,
    capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
  const catalogue = createCommandCatalogue(digest);
  const sent: Control["CommandInvoke"][] = [];
  const host = {
    inspect: async () => structuredClone(record),
    catalogue: async () => catalogue,
    apply: async (operation: SessionHostOperation): Promise<SessionHostReceipt> => {
      if (operation.kind !== "command") throw new Error("terminal adapter sent a non-command operation");
      sent.push(operation.request);
      return { operationId: operation.operationId, sessionId: record.sessionId, commandName: operation.request.commandName, status: "applied", sessionVersion: record.version,
        result: null, confirmationId: null, errorCode: null, confirmation: null, runId: null, turnId: null };
    },
  };
  return { host, sent, catalogue, adapter: createTerminalSessionAdapter(host, { actorId: "human", controllerLeaseId: "controller", controllerVersion: 1 }) };
}
async function sends(line: string) {
  const fixture = recordingHost(); const receipt = await fixture.adapter.execute(line);
  const request = fixture.sent[0];
  const entry = fixture.catalogue.entries.find((item) => item.commandName === request?.commandName);
  return { receipt, request, sent: fixture.sent, schemaValid: request !== undefined && entry !== undefined && validateArguments(entry.inputSchema, request.arguments).ok };
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
  for (const line of ["/plan maybe", "/reasoning loud", "/reasoning", "/tasks kill", "/tasks output job-1 x", "/route sideways", "/setup init extra", "/demote a b",
    "/goal", "/goal ship it --workspace", "/goal ship it --auto", "/intake list now", "/autoreview frobnicate", "/trail tool=", "/bus warp", "/remote-control a b",
    "/model local-candidate", "/connect test local-candidate", "/history 5", "/projectctx warn", "/decisions reason because"]) {
    const refused = await sends(line);
    expect({ line, sent: refused.sent.length }).toEqual({ line, sent: 0 });
    expect(refused.receipt).toMatchObject({ status: "rejected", errorCode: "invalid-arguments", sessionId: "session-test", sessionVersion: 3 });
  }
});
