import { expect, test } from "bun:test";
import { catalogueDigest, LIMITS, validateArguments, validateControl, type Control } from "../../remote-control/protocol";
import type { NativeSessionRuntime } from "../native-runtime";
import { createCommandCatalogue } from "./catalogue";
import { boundedCommandText, deliverableCommandOutcome, executeSessionCommand, type NativeCommandContribution, type SessionCommandContext } from "./handlers";

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

const textResult: Control["ArgumentSchema"] = { type: "string", maxLength: 32768 };
const command = (catalogue: Control["CommandCatalogue"], commandName: string, args: Control["BoundedJson"] = {}): Control["CommandInvoke"] => ({ expectedSessionVersion: 2,
  controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: 1, catalogueDigest: catalogue.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" });

test("a help larger than the result limit is cut by serialized bytes on a code point, so Hub's own result validation admits it", async () => {
  // Multi-byte summaries (Cyrillic, a symbol, an emoji pair, a quote JSON escapes) make the help many times the byte quota.
  const base = createCommandCatalogue(digest);
  const entries = base.entries.map((entry, index) => ({ ...entry, summary: `${"Сводка ✓ 😀 \"q\" ".repeat(12)}${index}` }));
  const catalogue: Control["CommandCatalogue"] = { ...base, entries, catalogueDigest: catalogueDigest(entries) };
  const help = entries.find((entry) => entry.commandName === "help")!;
  const full = JSON.stringify(catalogue);
  expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(4 * LIMITS.taskBytes);
  const outcome = await executeSessionCommand({ ...context(), catalogue }, command(catalogue, "help"));
  expect(outcome.status).toBe("applied");
  const text = String(outcome.result);
  // The exact check Hub applies to an applied outcome (events.ts): the advertised result schema, by serialized bytes.
  expect(validateArguments(help.resultSchema, outcome.result).ok).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(LIMITS.taskBytes);
  expect(full.startsWith(text)).toBe(true);
  // No split UTF-8 sequence: a lone surrogate would not survive a UTF-8 round trip.
  expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  // The longest such prefix: one more code point no longer fits.
  expect(validateArguments(help.resultSchema, text + String.fromCodePoint(full.codePointAt(text.length)!)).ok).toBe(false);
});

test("the wire bound counts JSON-escaped bytes and code points, never UTF-16 units", () => {
  const emoji = boundedCommandText("😀".repeat(20_000), textResult);
  // 4 bytes each inside the two quote bytes: 8191 emoji, not the 16384 a UTF-16 slice of 32768 would keep.
  expect(Array.from(emoji)).toHaveLength(8191);
  expect(Buffer.from(emoji, "utf8").toString("utf8")).toBe(emoji);
  expect(boundedCommandText("\"".repeat(40_000), textResult)).toHaveLength(16_383);
  expect(boundedCommandText("ж".repeat(40_000), { type: "string", maxLength: 100 })).toHaveLength(100);
  expect(boundedCommandText("short", textResult)).toBe("short");
});

test("a structured result outside its advertised schema is a truthful rejected outcome, never an event Hub refuses", async () => {
  const resultSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: { n: { type: "integer", minimum: 0, maximum: 1 } }, required: ["n"] };
  const contribution: NativeCommandContribution = { entry: { commandName: "fixture.structured", summary: "Structured fixture", handlerId: "native.fixture.structured",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema, mutationClass: "read", states: ["idle", "busy", "paused"],
    busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "fixture" }, structuredResult: true, execute: async () => ({ n: 5 }) };
  const catalogue = createCommandCatalogue(digest, [contribution]);
  const outcome = await executeSessionCommand({ ...context(), catalogue, contributions: [contribution] }, command(catalogue, "fixture.structured"));
  expect(outcome).toMatchObject({ status: "rejected", errorCode: "implementation-gap", commandName: "fixture.structured" });
  expect(validateControl("CommandOutcome", outcome).ok).toBe(true);
  expect(String(outcome.result)).toContain("result schema");
  // The same guard over an outcome built anywhere on the host: only an applied result Hub would refuse is withheld.
  const applied = { ...outcome, status: "applied" as const, errorCode: null, result: { n: 1 } };
  expect(deliverableCommandOutcome(applied, catalogue)).toEqual(applied);
  expect(deliverableCommandOutcome({ ...applied, result: { n: 2 } }, catalogue)).toMatchObject({ status: "rejected", errorCode: "implementation-gap" });
  expect(deliverableCommandOutcome({ ...applied, status: "queued", result: null }, catalogue)).toMatchObject({ status: "queued" });
});
