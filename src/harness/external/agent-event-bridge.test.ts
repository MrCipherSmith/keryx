// Tests for the ExternalEvent -> AgentEvent bridge (flow 176, T22, AC5).
//
// AC5's exact text: "Each codec parses its recorded fixtures into the
// canonical event sequence, and `reduceAgents` folds that sequence without
// modification to the fold." Two things must be true for that to hold:
//
//   1. `bridgeExternalEvent(s)` maps every `ExternalEvent` kind onto a valid
//      `AgentEvent` — asserted directly below, with injected `now`/`eventId`
//      for determinism.
//   2. Feeding a REAL fixture, parsed by a REAL codec, through the bridge and
//      then through the REAL, UNMODIFIED `reduceAgents` produces a sensible
//      `AgentsSnapshot` — the literal end-to-end proof, for both codecs. This
//      is why `reduceAgents` is imported directly from `../monitor/reduce`
//      rather than mocked: a passing suite that needed to touch that file
//      would mean the design is wrong.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { reduceAgents } from "../monitor/reduce";
import type { AgentEvent, AgentStatus } from "../monitor/reduce";
import { bridgeExternalEvent, bridgeExternalEvents } from "./agent-event-bridge";
import type { BridgeContext } from "./agent-event-bridge";
import { parseClaudeEvents } from "./codec/claude-cli";
import { parseCodexEvents } from "./codec/codex-cli";
import type { ExternalEvent } from "./types";

const FIXED_TIME = new Date("2026-08-20T00:00:00.000Z");
let eventCounter = 0;

/** Deterministic context: fixed clock, sequential ids so assertions are stable. */
function testContext(overrides: Partial<BridgeContext> = {}): BridgeContext {
  eventCounter = 0;
  return {
    runId: "run-1",
    dispatchId: "dispatch-1",
    now: () => FIXED_TIME,
    eventId: () => `event-${++eventCounter}`,
    ...overrides,
  };
}

describe("bridgeExternalEvent", () => {
  test("child_started with sessionRef -> dispatch_created carrying it", () => {
    const event: ExternalEvent = { kind: "child_started", sessionRef: "thread-123" };
    expect(bridgeExternalEvent(event, testContext())).toEqual({
      contract_version: "1.0.0",
      run_id: "run-1",
      dispatch_id: "dispatch-1",
      event_id: "event-1",
      timestamp_utc: FIXED_TIME.toISOString(),
      type: "dispatch_created",
      data: { sessionRef: "thread-123" },
    });
  });

  test("child_started without sessionRef -> dispatch_created, no data", () => {
    const event: ExternalEvent = { kind: "child_started" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("dispatch_created");
    expect(bridged.data).toBeUndefined();
  });

  test("child_finished with text -> dispatch_completed carrying it as message", () => {
    const event: ExternalEvent = { kind: "child_finished", text: "ok" };
    expect(bridgeExternalEvent(event, testContext())).toEqual({
      contract_version: "1.0.0",
      run_id: "run-1",
      dispatch_id: "dispatch-1",
      event_id: "event-1",
      timestamp_utc: FIXED_TIME.toISOString(),
      type: "dispatch_completed",
      message: "ok",
    });
  });

  test("child_finished without text -> dispatch_completed, no message", () => {
    const event: ExternalEvent = { kind: "child_finished" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("dispatch_completed");
    expect(bridged.message).toBeUndefined();
  });

  test("child_failed -> run_failed carrying the message", () => {
    const event: ExternalEvent = { kind: "child_failed", message: "no credentials" };
    expect(bridgeExternalEvent(event, testContext())).toEqual({
      contract_version: "1.0.0",
      run_id: "run-1",
      dispatch_id: "dispatch-1",
      event_id: "event-1",
      timestamp_utc: FIXED_TIME.toISOString(),
      type: "run_failed",
      message: "no credentials",
    });
  });

  test("usage -> artifact_written carrying data.usage with exact:true, only present fields", () => {
    const event: ExternalEvent = { kind: "usage", inputTokens: 100, outputTokens: 20, costUnits: 0.5 };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.data).toEqual({ usage: { inputTokens: 100, outputTokens: 20, exact: true } });
    expect(bridged.message).toBeUndefined();
  });

  test("usage with only inputTokens omits outputTokens from the folded usage", () => {
    const event: ExternalEvent = { kind: "usage", inputTokens: 7 };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.data).toEqual({ usage: { inputTokens: 7, exact: true } });
  });

  test("usage with no fields at all still folds to exact:true, empty otherwise", () => {
    const event: ExternalEvent = { kind: "usage" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.data).toEqual({ usage: { exact: true } });
  });

  test("tool_call -> artifact_written, message prefers detail over name", () => {
    const event: ExternalEvent = { kind: "tool_call", name: "shell", detail: "ls -la" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("ls -la");
    expect(bridged.data).toBeUndefined();
  });

  test("tool_call without detail falls back to name", () => {
    const event: ExternalEvent = { kind: "tool_call", name: "shell" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.message).toBe("shell");
  });

  test("tool_result -> artifact_written carrying detail as message when present", () => {
    const event: ExternalEvent = { kind: "tool_result", detail: "exit 0" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("exit 0");
  });

  test("tool_result without detail -> artifact_written, no message", () => {
    const event: ExternalEvent = { kind: "tool_result" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBeUndefined();
  });

  test("assistant_text -> artifact_written carrying text as message", () => {
    const event: ExternalEvent = { kind: "assistant_text", text: "here is the answer" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("here is the answer");
  });

  test("thinking -> artifact_written carrying text as message", () => {
    const event: ExternalEvent = { kind: "thinking", text: "let me consider..." };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("let me consider...");
  });

  test("user_message -> artifact_written carrying text as message", () => {
    const event: ExternalEvent = { kind: "user_message", text: "please continue" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("please continue");
  });

  test("retry -> artifact_written carrying message, status-neutral (non-terminal)", () => {
    const event: ExternalEvent = { kind: "retry", message: "Reconnecting... 2/5" };
    const bridged = bridgeExternalEvent(event, testContext());
    expect(bridged.type).toBe("artifact_written");
    expect(bridged.message).toBe("Reconnecting... 2/5");
  });

  test("every bridged event carries the same run_id/dispatch_id/contract_version from ctx", () => {
    const ctx = testContext({ contractVersion: "2.3.0" });
    const events: ExternalEvent[] = [{ kind: "child_started" }, { kind: "child_finished" }];
    for (const bridged of bridgeExternalEvents(events, ctx)) {
      expect(bridged.run_id).toBe("run-1");
      expect(bridged.dispatch_id).toBe("dispatch-1");
      expect(bridged.contract_version).toBe("2.3.0");
    }
  });

  test("contract_version defaults to 1.0.0 when the caller omits it", () => {
    const bridged = bridgeExternalEvent({ kind: "child_started" }, testContext());
    expect(bridged.contract_version).toBe("1.0.0");
  });

  test("falls back to real crypto.randomUUID and Date when now/eventId are not injected", () => {
    const bridged = bridgeExternalEvent(
      { kind: "child_started" },
      { runId: "run-1", dispatchId: "dispatch-1" },
    );
    expect(bridged.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(bridged.timestamp_utc).toISOString()).not.toThrow();
  });
});

describe("bridgeExternalEvents", () => {
  test("maps a whole transcript in order, preserving element count and order", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started", sessionRef: "s-1" },
      { kind: "assistant_text", text: "ok" },
      { kind: "child_finished" },
    ];
    const bridged = bridgeExternalEvents(events, testContext());
    expect(bridged.map((e) => e.type)).toEqual(["dispatch_created", "artifact_written", "dispatch_completed"]);
    expect(bridged.map((e) => e.event_id)).toEqual(["event-1", "event-2", "event-3"]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real fixture -> real codec -> bridge -> REAL, UNMODIFIED
// reduceAgents. This is the literal proof of AC5's claim.
// ---------------------------------------------------------------------------

const CODEX_FIXTURES = path.join(import.meta.dir, "..", "..", "..", "fixtures", "external", "codex-cli");
const CLAUDE_FIXTURES = path.join(import.meta.dir, "..", "..", "..", "fixtures", "external", "claude-cli");

function readFixture(dir: string, name: string): string {
  return readFileSync(path.join(dir, name), "utf8");
}

function foldCodexFixture(name: string): ExternalEvent[] {
  return readFixture(CODEX_FIXTURES, name)
    .split("\n")
    .flatMap((line) => [...parseCodexEvents(line)]);
}

function foldClaudeFixture(name: string): ExternalEvent[] {
  return readFixture(CLAUDE_FIXTURES, name)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => [...parseClaudeEvents(line)]);
}

/** Assert the fold produced exactly one AgentRecord for this dispatch, with the expected status. */
function expectSingleDispatch(bridged: AgentEvent[], dispatchId: string, status: AgentStatus): void {
  const snapshot = reduceAgents(bridged);
  expect(snapshot.runId).toBe(bridged[0]?.run_id ?? null);
  expect(snapshot.agents).toHaveLength(1);
  expect(snapshot.agents[0]?.dispatchId).toBe(dispatchId);
  expect(snapshot.agents[0]?.status).toBe(status);
}

describe("AC5 end-to-end: codex-cli fixture -> bridge -> unmodified reduceAgents", () => {
  test("success.stdout.jsonl folds to a single done AgentRecord", () => {
    const events = foldCodexFixture("success.stdout.jsonl");
    expect(events.length).toBeGreaterThan(0);
    const bridged = bridgeExternalEvents(events, testContext({ runId: "codex-run", dispatchId: "codex-dispatch" }));
    expectSingleDispatch(bridged, "codex-dispatch", "done");
  });

  test("not-logged-in.stdout.jsonl folds to a single failed AgentRecord", () => {
    const events = foldCodexFixture("not-logged-in.stdout.jsonl");
    expect(events.length).toBeGreaterThan(0);
    const bridged = bridgeExternalEvents(events, testContext({ runId: "codex-run", dispatchId: "codex-dispatch" }));
    expectSingleDispatch(bridged, "codex-dispatch", "failed");
  });
});

describe("AC5 end-to-end: claude-cli fixture -> bridge -> unmodified reduceAgents", () => {
  test("success.stdout.jsonl folds to a single done AgentRecord", () => {
    const events = foldClaudeFixture("success.stdout.jsonl");
    expect(events.length).toBeGreaterThan(0);
    const bridged = bridgeExternalEvents(events, testContext({ runId: "claude-run", dispatchId: "claude-dispatch" }));
    expectSingleDispatch(bridged, "claude-dispatch", "done");
  });

  test("not-logged-in.stdout.jsonl folds to a single failed AgentRecord", () => {
    const events = foldClaudeFixture("not-logged-in.stdout.jsonl");
    expect(events.length).toBeGreaterThan(0);
    const bridged = bridgeExternalEvents(events, testContext({ runId: "claude-run", dispatchId: "claude-dispatch" }));
    expectSingleDispatch(bridged, "claude-dispatch", "failed");
  });
});
