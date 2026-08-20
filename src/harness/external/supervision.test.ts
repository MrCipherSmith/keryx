// Tests for the pure §7.6 supervision-trigger fold (flow 176, T21).
//
// Every test below constructs a fixed `ExternalEvent[]` and calls
// `detectSupervisionTriggers` with an injected `now` and an explicit
// `sinceLastEventMs` — NO real timers, mirroring `foldExternalTranscript`'s own
// test style rather than `supervise.test.ts`'s real-millisecond convention
// (that file exercises the LIVE timer; this one exercises the pure function
// behind it).
import { describe, expect, test } from "bun:test";
import { detectSupervisionTriggers, type SupervisionConfig } from "./supervision";
import type { ExternalEvent } from "./types";

const RUN_STARTED_AT = new Date("2026-08-20T00:00:00.000Z");

function fixedNow(offsetMs = 0): () => Date {
  return () => new Date(RUN_STARTED_AT.getTime() + offsetMs);
}

function baseConfig(overrides: Partial<SupervisionConfig> = {}): SupervisionConfig {
  return {
    budgetThresholdFraction: 0.8,
    noProgressIntervalMs: 30_000,
    declaredScopePath: "/wt/wt-1",
    timeoutMs: 100_000,
    ...overrides,
  };
}

/** Calls the function under test with sane defaults for whichever fields a test does not care about. */
function detect(
  events: readonly ExternalEvent[],
  config: SupervisionConfig,
  options: { readonly nowOffsetMs?: number; readonly sinceLastEventMs?: number } = {},
) {
  return detectSupervisionTriggers(
    events,
    config,
    RUN_STARTED_AT,
    fixedNow(options.nowOffsetMs ?? 0),
    options.sinceLastEventMs ?? 0,
  );
}

function kindsOf(triggers: ReturnType<typeof detect>): string[] {
  return triggers.map((t) => t.kind);
}

// ---------------------------------------------------------------------------

describe("no trigger fires on a transcript that satisfies none of them", () => {
  test("child_started, usage, retry alone produce nothing", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started", sessionRef: "s1" },
      { kind: "usage", costUnits: 0.01 },
      { kind: "retry", message: "reconnecting" },
    ];
    const triggers = detect(events, baseConfig({ maxCostUnits: 100 }));
    expect(triggers).toEqual([]);
  });

  test("an empty transcript produces nothing", () => {
    expect(detect([], baseConfig())).toEqual([]);
  });
});

describe("phase_changed — first tool call, first assistant text, terminal event", () => {
  test("fires on the first tool_call", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started" },
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/wt/wt-1/src/a.ts"}' },
    ];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).toEqual(["phase_changed"]);
    expect(triggers[0]?.message).toContain("Read");
  });

  test("fires on the first assistant_text when there is no tool call yet", () => {
    const events: ExternalEvent[] = [{ kind: "child_started" }, { kind: "assistant_text", text: "Working on it." }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).toEqual(["phase_changed"]);
  });

  test("fires on a terminal event", () => {
    const events: ExternalEvent[] = [{ kind: "child_started" }, { kind: "child_finished", text: "done" }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).toEqual(["phase_changed"]);
    expect(triggers[0]?.message).toContain("terminal");
  });

  test("AT MOST ONE phase_changed even with three tool calls (AC12)", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started" },
      { kind: "tool_call", name: "Read", detail: "a" },
      { kind: "tool_result", detail: "ok" },
      { kind: "tool_call", name: "Write", detail: "b" },
      { kind: "tool_result", detail: "ok" },
      { kind: "tool_call", name: "Bash", detail: "c" },
    ];
    const triggers = detect(events, baseConfig());
    expect(triggers.filter((t) => t.kind === "phase_changed")).toHaveLength(1);
  });

  test("does not fire when no phase-changing event has occurred", () => {
    const events: ExternalEvent[] = [{ kind: "child_started" }, { kind: "thinking", text: "hmm" }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).not.toContain("phase_changed");
  });
});

describe("budget_threshold — reported cost or elapsed time crosses a configured fraction", () => {
  test("fires when reported cost crosses the configured fraction of maxCostUnits", () => {
    const events: ExternalEvent[] = [{ kind: "usage", costUnits: 8.5 }];
    const triggers = detect(events, baseConfig({ maxCostUnits: 10, budgetThresholdFraction: 0.8 }));
    expect(kindsOf(triggers)).toEqual(["budget_threshold"]);
  });

  test("does not fire when reported cost is below the fraction", () => {
    const events: ExternalEvent[] = [{ kind: "usage", costUnits: 1 }];
    const triggers = detect(events, baseConfig({ maxCostUnits: 10, budgetThresholdFraction: 0.8, timeoutMs: 1_000_000 }));
    expect(kindsOf(triggers)).not.toContain("budget_threshold");
  });

  test("the LATEST usage event wins, not the first", () => {
    const events: ExternalEvent[] = [
      { kind: "usage", costUnits: 9 },
      { kind: "usage", costUnits: 1 },
    ];
    const triggers = detect(events, baseConfig({ maxCostUnits: 10, budgetThresholdFraction: 0.8, timeoutMs: 1_000_000 }));
    expect(kindsOf(triggers)).not.toContain("budget_threshold");
  });

  test("fires from elapsed time alone, with no cost reported at all", () => {
    const triggers = detect([], baseConfig({ timeoutMs: 10_000, budgetThresholdFraction: 0.8 }), {
      nowOffsetMs: 9_000,
    });
    expect(kindsOf(triggers)).toEqual(["budget_threshold"]);
  });

  test("does not fire from elapsed time before the fraction is crossed", () => {
    const triggers = detect([], baseConfig({ timeoutMs: 10_000, budgetThresholdFraction: 0.8 }), {
      nowOffsetMs: 1_000,
    });
    expect(kindsOf(triggers)).not.toContain("budget_threshold");
  });

  test("absent maxCostUnits means cost alone never fires it, even for a huge reported cost", () => {
    const events: ExternalEvent[] = [{ kind: "usage", costUnits: 1_000_000 }];
    // timeoutMs kept large and elapsed 0 so only the cost half is exercised.
    const triggers = detect(events, baseConfig({ timeoutMs: 1_000_000_000 }));
    expect(kindsOf(triggers)).not.toContain("budget_threshold");
  });

  test("only one budget_threshold even when BOTH cost and time cross their fractions", () => {
    const events: ExternalEvent[] = [{ kind: "usage", costUnits: 9 }];
    const triggers = detect(events, baseConfig({ maxCostUnits: 10, timeoutMs: 10_000, budgetThresholdFraction: 0.8 }), {
      nowOffsetMs: 9_000,
    });
    expect(triggers.filter((t) => t.kind === "budget_threshold")).toHaveLength(1);
  });
});

describe("no_progress — no canonical event within a configured interval", () => {
  test("fires when sinceLastEventMs has reached the configured interval", () => {
    const triggers = detect([], baseConfig({ noProgressIntervalMs: 5_000 }), { sinceLastEventMs: 5_000 });
    expect(kindsOf(triggers)).toEqual(["no_progress"]);
  });

  test("fires past the interval too", () => {
    const triggers = detect([], baseConfig({ noProgressIntervalMs: 5_000 }), { sinceLastEventMs: 12_000 });
    expect(kindsOf(triggers)).toEqual(["no_progress"]);
  });

  test("does not fire before the interval is reached", () => {
    const triggers = detect([], baseConfig({ noProgressIntervalMs: 5_000 }), { sinceLastEventMs: 4_999 });
    expect(kindsOf(triggers)).not.toContain("no_progress");
  });
});

describe("agent_asked — assistant text classified as a question rather than work", () => {
  test("fires on a message ending with a question mark", () => {
    // Also satisfies phase_changed (assistant_text is one of its three
    // conditions) — that is a DIFFERENT kind and does not interfere with
    // asserting this one fired.
    const events: ExternalEvent[] = [{ kind: "assistant_text", text: "Should I delete this file?" }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).toContain("agent_asked");
  });

  test("fires on a message starting with a question word, even without a trailing '?'", () => {
    const events: ExternalEvent[] = [{ kind: "assistant_text", text: "Can you confirm the target directory" }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).toContain("agent_asked");
  });

  test("does not fire on a plain work update", () => {
    const events: ExternalEvent[] = [{ kind: "assistant_text", text: "Updated the file and ran the tests." }];
    const triggers = detect(events, baseConfig());
    expect(kindsOf(triggers)).not.toContain("agent_asked");
  });

  test("AT MOST ONE agent_asked even with three questions", () => {
    const events: ExternalEvent[] = [
      { kind: "assistant_text", text: "Should I proceed?" },
      { kind: "assistant_text", text: "What about the second file?" },
      { kind: "assistant_text", text: "Is this what you meant?" },
    ];
    const triggers = detect(events, baseConfig());
    expect(triggers.filter((t) => t.kind === "agent_asked")).toHaveLength(1);
  });
});

describe("scope_drift — tool call targets a path outside the dispatch's declared scope", () => {
  test("fires for a tool call whose path is a clean prefix mismatch", () => {
    // Also satisfies phase_changed (tool_call is one of its three conditions) —
    // a different kind, asserted separately elsewhere.
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/etc/passwd"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(kindsOf(triggers)).toContain("scope_drift");
  });

  test("does not fire for a tool call whose path is inside the declared scope", () => {
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/wt/wt-1/src/a.ts"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(kindsOf(triggers)).not.toContain("scope_drift");
  });

  test("REAL path-boundary check: /wt/wt-1-evil is NOT inside /wt/wt-1, despite being a string prefix", () => {
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Write", detail: '{"file_path":"/wt/wt-1-evil/secret.txt"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    // A naive `.startsWith("/wt/wt-1")` comparison would wrongly treat this as
    // inside scope; `isPathInside` (path.relative-based) must not.
    expect(kindsOf(triggers)).toContain("scope_drift");
  });

  test("a nested path several levels inside the scope is NOT drift", () => {
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/wt/wt-1/a/b/c/d.ts"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(kindsOf(triggers)).not.toContain("scope_drift");
  });

  test("a relative path in the detail is not judged (no cwd to resolve it against)", () => {
    const events: ExternalEvent[] = [{ kind: "tool_call", name: "Read", detail: '{"file_path":"src/a.ts"}' }];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(kindsOf(triggers)).not.toContain("scope_drift");
  });

  test("a shell command detail (not JSON) is not judged as a path", () => {
    const events: ExternalEvent[] = [{ kind: "tool_call", name: "Bash", detail: "rm -rf /etc" }];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(kindsOf(triggers)).not.toContain("scope_drift");
  });

  test("AT MOST ONE scope_drift even with two offending tool calls", () => {
    const events: ExternalEvent[] = [
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/etc/passwd"}' },
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/root/.ssh/id_rsa"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    expect(triggers.filter((t) => t.kind === "scope_drift")).toHaveLength(1);
  });
});

describe("a transcript can satisfy several DIFFERENT trigger kinds at once", () => {
  test("phase_changed, agent_asked and scope_drift together, each exactly once", () => {
    const events: ExternalEvent[] = [
      { kind: "child_started" },
      { kind: "assistant_text", text: "Should I read outside the worktree?" },
      { kind: "tool_call", name: "Read", detail: '{"file_path":"/etc/passwd"}' },
    ];
    const triggers = detect(events, baseConfig({ declaredScopePath: "/wt/wt-1" }));
    const kinds = kindsOf(triggers);
    expect(new Set(kinds).size).toBe(kinds.length); // no kind repeats
    expect(kinds).toContain("phase_changed");
    expect(kinds).toContain("agent_asked");
    expect(kinds).toContain("scope_drift");
  });
});
