// The harness terminal state, mapped onto the turn outcome.
//
// A total function gets a total test. `runRemoteTurn` used to skip this
// entirely — it read the run's `summary` and terminated with a hardcoded
// `("completed", "ok")` — so a run reporting `failed` with a blocked gate was
// recorded as a successful turn, which on an install with no saved provider is
// the ordinary case rather than a corner.
//
// Driven directly rather than through a real run, and deliberately: three of the
// six statuses cannot be produced offline, and a mapping that is only exercised
// for the statuses a fixture happens to reach is the same partial coverage that
// let the hardcoded version survive.

import { describe, expect, test } from "bun:test";
import { outcomeOf } from "./serve-turn";
import type { HarnessRunOutput } from "../harness/run/run";

/** Every member of the union, so a new status fails to compile rather than silently mapping. */
const EVERY_STATUS: ReadonlyArray<HarnessRunOutput["status"]> = [
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "paused",
  "in-progress",
];

describe("outcomeOf", () => {
  test("only a completed run WITH a passing gate is a completed turn", () => {
    expect(outcomeOf("completed", "pass", [])).toEqual(["completed", "ok"]);
    // No gate reported is treated as no objection — the gate is optional on the
    // output type, and absent is not the same as refused.
    expect(outcomeOf("completed", undefined, [])).toEqual(["completed", "ok"]);
  });

  test("a completed run whose GATE refused is not a completed turn", () => {
    // The leg the mapping's first version got right and no test reached. A
    // transport that reports success over a refused gate is reporting the
    // absence of an exception, not the presence of a result.
    expect(outcomeOf("completed", "blocked", [])).toEqual(["failed", "completion-gate-blocked"]);
    expect(outcomeOf("completed", "failed", ["blocker:coverage"])).toEqual([
      "failed",
      "completion-gate-failed:blocker:coverage",
    ]);
  });

  test("blocked and failed stay distinct, and the blockers travel with them", () => {
    // An operator fixes a blocked run by satisfying the blocker and a failed run
    // by looking at what broke. Collapsing them loses which of the two it is.
    expect(outcomeOf("blocked", "pass", ["blocker:startup"])).toEqual(["failed", "startup-blocked:blocker:startup"]);
    expect(outcomeOf("failed", "pass", [])).toEqual(["failed", "run-failed"]);
    expect(outcomeOf("failed", "pass", ["a", "b"])).toEqual(["failed", "run-failed:a,b"]);
  });

  test("cancelled is its own outcome, not a failure", () => {
    expect(outcomeOf("cancelled", "pass", [])).toEqual(["cancelled", "run-cancelled"]);
  });

  test("a non-terminal status is a failure, because this release cannot resume one", () => {
    expect(outcomeOf("paused", "pass", [])).toEqual(["failed", "run-not-terminal-paused"]);
    expect(outcomeOf("in-progress", "pass", [])).toEqual(["failed", "run-not-terminal-in-progress"]);
  });

  test("every status maps, and only one of them can produce `completed`", () => {
    // The totality assertion. A status added to `HarnessRunOutput` without a
    // decision here is a compile error inside `outcomeOf`; this is the runtime
    // half — nothing falls through to an invented success.
    const completed = EVERY_STATUS.filter((status) => outcomeOf(status, "pass", [])[0] === "completed");
    expect(completed).toEqual(["completed"]);
    for (const status of EVERY_STATUS) {
      const [outcome, reason] = outcomeOf(status, "pass", []);
      expect({ status, outcome: typeof outcome, reason: reason.length > 0 }).toEqual({
        status,
        outcome: "string",
        reason: true,
      });
    }
  });
});
