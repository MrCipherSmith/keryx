import { expect, test } from "bun:test";
import type { Control } from "../../remote-control/protocol";
import type { NativeSessionRuntime } from "../native-runtime";
import { createCommandCatalogue } from "./catalogue";
import { executeSessionCommand, type SessionCommandContext } from "./handlers";

const digest = "a".repeat(64);
const record: Control["SessionRecord"] = { sessionId: "session-history", projectId: "project", machineId: "machine", checkoutId: "checkout", agentProfileId: "native",
  version: 2, historyVersion: 1, state: "idle", title: "History fixture",
  config: { configVersion: 1, baselineCandidateId: "c", reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: ["c"], fallbackCandidateId: "c" }, policyDigest: digest, capabilityDigest: digest },
  controller: null, activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 3, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: digest, forkedFromSessionId: null,
  capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
const messages = [1, 2, 3].map((cursor): Control["SessionMessage"] => ({ messageId: `m${cursor}`, sessionId: record.sessionId, historyCursor: cursor, role: cursor % 2 === 0 ? "assistant" : "human",
  text: `message ${cursor}`, runId: null, turnId: null, createdAt: "2026-01-01T00:00:00.000Z" }));
function context(): SessionCommandContext {
  // `/history` reads only the public history: no runtime member is touched by this handler.
  return { cwd: "/fixture", nativeSessionDir: "/fixture/native", operationId: "history-op", record: structuredClone(record), catalogue: createCommandCatalogue(digest),
    runtime: {} as NativeSessionRuntime, history: () => [], publicHistory: () => structuredClone(messages), compact: () => ({ removed: 0, noop: true }) };
}
const invoke = (args: Control["BoundedJson"]): Control["CommandInvoke"] => ({ expectedSessionVersion: 2, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
  expectedConfigVersion: 1, catalogueDigest: createCommandCatalogue(digest).catalogueDigest, commandName: "history", arguments: args, busyPolicy: "reject" });

test("/history N reads the last N messages of the ordered history; no number reads all of it, and N stays within the shipped 1-20 bound", async () => {
  const read = async (args: Control["BoundedJson"]) => executeSessionCommand(context(), invoke(args));
  expect(JSON.parse(String((await read({})).result))).toEqual(messages);
  expect(JSON.parse(String((await read({ count: 2 })).result))).toEqual(messages.slice(-2));
  expect(JSON.parse(String((await read({ count: 20 })).result))).toEqual(messages);
  for (const bad of [{ count: 0 }, { count: 21 }, { limit: 2 }]) expect(await read(bad)).toMatchObject({ status: "rejected", errorCode: "invalid-arguments" });
});
