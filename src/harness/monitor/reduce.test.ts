// Tests for the deterministic subagent monitoring fold (flow 092, Phase 4).
import { describe, expect, test } from "bun:test";
import { diffAgents, reduceAgents, type AgentEvent, type AgentsSnapshot } from "./reduce";

let seq = 0;
function ev(
  type: AgentEvent["type"],
  dispatch_id: string | null,
  data?: Record<string, unknown>,
): AgentEvent {
  return {
    contract_version: "1.0.0",
    run_id: "run-1",
    event_id: `e-${seq++}`,
    dispatch_id,
    type,
    ...(data !== undefined ? { data } : {}),
    timestamp_utc: "1970-01-01T00:00:00.000Z",
  };
}

describe("reduceAgents — status mapping (AC1)", () => {
  test("created→running, completed→done, blocked→blocked, validation_failed→failed", () => {
    const snap = reduceAgents([
      ev("dispatch_created", "d1"),
      ev("dispatch_created", "d2"),
      ev("dispatch_completed", "d2"),
      ev("dispatch_created", "d3"),
      ev("dispatch_blocked", "d3"),
      ev("dispatch_created", "d4"),
      ev("validation_failed", "d4"),
    ]);
    const byId = Object.fromEntries(snap.agents.map((a) => [a.dispatchId, a.status]));
    expect(byId).toEqual({ d1: "running", d2: "done", d3: "blocked", d4: "failed" });
    expect(snap.runId).toBe("run-1");
  });

  test("run_failed with a dispatch_id marks that dispatch failed", () => {
    const snap = reduceAgents([ev("dispatch_created", "d1"), ev("run_failed", "d1")]);
    expect(snap.agents[0]?.status).toBe("failed");
  });

  test("run-level events (null dispatch_id) create no per-agent record", () => {
    const snap = reduceAgents([ev("run_started", null), ev("run_completed", null)]);
    expect(snap.agents).toEqual([]);
    expect(snap.runId).toBe("run-1");
  });

  test("a terminal status is never downgraded by a later event", () => {
    const snap = reduceAgents([
      ev("dispatch_created", "d1"),
      ev("dispatch_completed", "d1"),
      ev("dispatch_created", "d1"), // stray re-create must not downgrade done→running
    ]);
    expect(snap.agents[0]?.status).toBe("done");
  });

  test("model/source captured from event data", () => {
    const snap = reduceAgents([
      ev("dispatch_created", "d1", { provider: "anthropic", model: "claude-opus-4-8", source: "inherited" }),
    ]);
    expect(snap.agents[0]?.model).toBe("anthropic/claude-opus-4-8");
    expect(snap.agents[0]?.source).toBe("inherited");
  });

  test("agents are sorted by dispatchId (stable)", () => {
    const snap = reduceAgents([ev("dispatch_created", "z"), ev("dispatch_created", "a"), ev("dispatch_created", "m")]);
    expect(snap.agents.map((a) => a.dispatchId)).toEqual(["a", "m", "z"]);
  });
});

describe("reduceAgents — usage accounting exact-only (AC2)", () => {
  test("exact usage samples are summed", () => {
    const snap = reduceAgents([
      ev("dispatch_created", "d1", { usage: { inputTokens: 100, outputTokens: 20, exact: true } }),
      ev("decision_recorded", "d1", { usage: { inputTokens: 50, outputTokens: 10, exact: true } }),
    ]);
    expect(snap.agents[0]?.usage).toEqual({ inputTokens: 150, outputTokens: 30, exact: true });
  });

  test("inexact usage is NOT summed and flips exact=false", () => {
    const snap = reduceAgents([
      ev("dispatch_created", "d1", { usage: { inputTokens: 100, outputTokens: 20, exact: true } }),
      ev("decision_recorded", "d1", { usage: { inputTokens: 999, outputTokens: 999, exact: false } }),
    ]);
    expect(snap.agents[0]?.usage).toEqual({ inputTokens: 100, outputTokens: 20, exact: false });
  });

  test("no usage events => zeroed exact usage", () => {
    const snap = reduceAgents([ev("dispatch_created", "d1")]);
    expect(snap.agents[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0, exact: true });
  });
});

describe("reduceAgents — determinism (AC1/AC5)", () => {
  test("identical events yield deep-equal snapshots", () => {
    const events = [ev("dispatch_created", "d1"), ev("dispatch_completed", "d1")];
    const a = reduceAgents(events);
    const b = reduceAgents(events);
    expect(a).toEqual(b);
  });
});

describe("diffAgents — deltas (AC3)", () => {
  const base = (): AgentsSnapshot =>
    reduceAgents([ev("dispatch_created", "d1"), ev("dispatch_created", "d2")]);

  test("a new dispatch is spawned", () => {
    const prev = base();
    const next = reduceAgents([
      ev("dispatch_created", "d1"),
      ev("dispatch_created", "d2"),
      ev("dispatch_created", "d3"),
    ]);
    expect(diffAgents(prev, next)).toEqual([{ dispatchId: "d3", kind: "spawned" }]);
  });

  test("a status change emits the new status", () => {
    const prev = base();
    const next = reduceAgents([
      ev("dispatch_created", "d1"),
      ev("dispatch_completed", "d1"),
      ev("dispatch_created", "d2"),
      ev("dispatch_blocked", "d2"),
    ]);
    expect(diffAgents(prev, next)).toEqual([
      { dispatchId: "d1", kind: "done" },
      { dispatchId: "d2", kind: "blocked" },
    ]);
  });

  test("a dispatch present only in prev is idle", () => {
    const prev = base();
    const next = reduceAgents([ev("dispatch_created", "d1")]);
    expect(diffAgents(prev, next)).toEqual([{ dispatchId: "d2", kind: "idle" }]);
  });

  test("no changes => no deltas; deterministic", () => {
    const prev = base();
    const next = base();
    expect(diffAgents(prev, next)).toEqual([]);
  });
});
