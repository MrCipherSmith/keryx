// Tests for event-sourced orchestrator state (flow 095, Phase 6a).
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { AgentEvent } from "./reduce";
import {
  applyEvents,
  initialOrchestratorState,
  reduceState,
  type ReduceStateMeta,
} from "./reduce-state";

const SCHEMA_DIR = path.join(import.meta.dir, "..", "..", "..", ".metaproject", "core", "gdskills", "contracts");
const STATE_SCHEMA = "orchestrator-state.schema.json";

const META: ReduceStateMeta = {
  contractVersion: "1.0.0",
  orchestrator: "flow-orchestrator",
  phase: "execute",
  runId: "run-1",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

let seq = 0;
function ev(type: AgentEvent["type"], dispatch_id: string | null, data?: Record<string, unknown>, at?: string): AgentEvent {
  return {
    contract_version: "1.0.0",
    run_id: "run-1",
    event_id: `e-${seq++}`,
    dispatch_id,
    type,
    ...(data !== undefined ? { data } : {}),
    timestamp_utc: at ?? "2026-07-20T00:00:01.000Z",
  };
}

describe("reduceState — schema validity (AC1)", () => {
  test("a folded state validates against orchestrator-state.schema.json", () => {
    const state = reduceState(
      [
        ev("run_started", null),
        ev("dispatch_created", "d1", { skill: "task-implementer" }),
        ev("dispatch_completed", "d1"),
        ev("artifact_written", null, { path: "artifacts/out.json", kind: "report" }),
        ev("run_completed", null),
      ],
      META,
    );
    const result = validateAgainstSchema(STATE_SCHEMA, state, { schemaDir: SCHEMA_DIR });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("an empty log still yields a schema-valid pending state", () => {
    const state = reduceState([], META);
    expect(state.status).toBe("pending");
    expect(state.plan.steps).toEqual([]);
    expect(validateAgainstSchema(STATE_SCHEMA, state, { schemaDir: SCHEMA_DIR }).valid).toBe(true);
  });
});

describe("reduceState — status & step mapping (AC2)", () => {
  test("run + step statuses map as specified", () => {
    const state = reduceState(
      [
        ev("run_started", null),
        ev("dispatch_created", "d1", { skill: "s1" }),
        ev("dispatch_created", "d2", { skill: "s2" }),
        ev("dispatch_completed", "d1"),
        ev("dispatch_blocked", "d2"),
        ev("dispatch_created", "d3", { skill: "s3" }),
        ev("validation_failed", "d3"),
      ],
      META,
    );
    const byId = Object.fromEntries(state.plan.steps.map((s) => [s.id, s.status]));
    expect(byId).toEqual({ d1: "completed", d2: "blocked", d3: "failed" });
    expect(state.status).toBe("in_progress");
    expect(state.plan.steps.map((s) => s.skill)).toEqual(["s1", "s2", "s3"]);
  });

  test("run_completed => completed; run_failed => failed (terminal)", () => {
    expect(reduceState([ev("run_started", null), ev("run_completed", null)], META).status).toBe("completed");
    expect(reduceState([ev("run_started", null), ev("run_failed", null)], META).status).toBe("failed");
  });

  test("a terminal step status is not downgraded by a later event", () => {
    const state = reduceState(
      [ev("dispatch_created", "d1", { skill: "s1" }), ev("dispatch_completed", "d1"), ev("dispatch_created", "d1")],
      META,
    );
    expect(state.plan.steps[0]?.status).toBe("completed");
  });

  test("current_step tracks the latest created dispatch", () => {
    const state = reduceState([ev("dispatch_created", "d1", { skill: "s1" }), ev("dispatch_created", "d2", { skill: "s2" })], META);
    expect(state.plan.current_step).toBe("d2");
  });

  test("artifacts are deduped by path in first-seen order", () => {
    const state = reduceState(
      [
        ev("artifact_written", null, { path: "a.json", kind: "report" }),
        ev("artifact_written", null, { path: "a.json", kind: "report" }),
        ev("artifact_written", null, { path: "b.json", kind: "plan" }),
      ],
      META,
    );
    expect(state.artifacts.map((a) => a.path)).toEqual(["a.json", "b.json"]);
  });

  test("updated_at rises to the latest event timestamp", () => {
    const state = reduceState(
      [ev("run_started", null, undefined, "2026-07-20T00:00:05.000Z"), ev("run_completed", null, undefined, "2026-07-20T00:00:09.000Z")],
      META,
    );
    expect(state.updated_at).toBe("2026-07-20T00:00:09.000Z");
  });
});

describe("reduceState — determinism & replay (AC3/AC4)", () => {
  const log = (): AgentEvent[] => [
    ev("run_started", null),
    ev("dispatch_created", "d1", { skill: "s1" }),
    ev("dispatch_created", "d2", { skill: "s2" }),
    ev("dispatch_completed", "d1"),
    ev("dispatch_blocked", "d2"),
  ];

  test("identical logs yield deep-equal state (AC3)", () => {
    expect(reduceState(log(), META)).toEqual(reduceState(log(), META));
  });

  test("replay-safety: prefix-then-suffix equals whole (AC4)", () => {
    const events = log();
    for (let split = 0; split <= events.length; split++) {
      const whole = reduceState(events, META);
      const prefix = applyEvents(initialOrchestratorState(META), events.slice(0, split));
      const combined = applyEvents(prefix, events.slice(split));
      expect(combined).toEqual(whole);
    }
  });

  test("applyEvents does not mutate the input state", () => {
    const init = initialOrchestratorState(META);
    const snapshot = JSON.parse(JSON.stringify(init));
    applyEvents(init, log());
    expect(init).toEqual(snapshot);
  });
});
