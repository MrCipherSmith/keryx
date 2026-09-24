import { describe, expect, test } from "bun:test";
import { composeDecision, tightenOutcome } from "./compose";
import type { PolicyDecision, PolicyOutcome } from "../policy/types";

function policy(decision: PolicyOutcome, hardDeny = false): PolicyDecision & { hardDeny?: boolean } {
  return {
    schemaVersion: 1,
    decisionId: "d1",
    toolCallId: "tc1",
    decision,
    policyProfile: "monitored-trusted-local",
    timestamp: "2026-01-01T00:00:00.000Z",
    matchedRules: ["base:rule"],
    hardDeny,
  };
}

const HOOK_SETS: Record<string, Array<{ hookId: string; decision?: PolicyOutcome }>> = {
  none: [],
  allow: [{ hookId: "h1", decision: "allow" }],
  ask: [{ hookId: "h1", decision: "ask" }],
  deny: [{ hookId: "h1", decision: "deny" }],
  mixed_allow_ask: [
    { hookId: "h1", decision: "allow" },
    { hookId: "h2", decision: "ask" },
  ],
  mixed_ask_deny: [
    { hookId: "h1", decision: "ask" },
    { hookId: "h2", decision: "deny" },
  ],
  undecided: [{ hookId: "h1" }],
};

const POLICY_OUTCOMES: Array<{ label: string; decision: PolicyOutcome; hardDeny: boolean }> = [
  { label: "allow", decision: "allow", hardDeny: false },
  { label: "ask", decision: "ask", hardDeny: false },
  { label: "deny", decision: "deny", hardDeny: false },
  { label: "hard-deny", decision: "deny", hardDeny: true },
];

describe("composeDecision — full sweep", () => {
  for (const po of POLICY_OUTCOMES) {
    for (const [setName, hooks] of Object.entries(HOOK_SETS)) {
      for (const interactive of [true, false]) {
        test(`policy=${po.label} hooks=${setName} interactive=${interactive}`, () => {
          const input = policy(po.decision, po.hardDeny);
          const result = composeDecision(input, hooks, { interactive });

          // Never mutated.
          expect(input.matchedRules).toEqual(["base:rule"]);

          if (po.decision === "deny") {
            // Deny (hard or not) is untouchable by any hook combination.
            expect(result.decision).toBe("deny");
            expect((result as PolicyDecision & { hardDeny?: boolean }).hardDeny).toBe(po.hardDeny);
            return;
          }

          const hasDeny = hooks.some((h) => h.decision === "deny");
          const hasAsk = hooks.some((h) => h.decision === "ask");

          if (hasDeny) {
            expect(result.decision).toBe("deny");
            return;
          }
          if (hasAsk) {
            if (interactive === false) {
              expect(result.decision).toBe("deny");
            } else if (po.decision === "allow") {
              expect(result.decision).toBe("ask");
            } else {
              expect(result.decision).toBe(po.decision);
            }
            return;
          }
          // No ask/deny hook (allow-only, undecided, or empty) never loosens
          // and never changes the base outcome.
          expect(result.decision).toBe(po.decision);
        });
      }
    }
  }

  test("never produces allow from an ask baseline plus a hook allow", () => {
    const result = composeDecision(policy("ask"), [{ hookId: "h1", decision: "allow" }], { interactive: true });
    expect(result.decision).toBe("ask");
  });

  test("returns a new object, never mutates matchedRules array identity", () => {
    const input = policy("allow");
    const result = composeDecision(input, [{ hookId: "h1", decision: "ask" }], { interactive: true });
    expect(result).not.toBe(input);
    expect(result.matchedRules).not.toBe(input.matchedRules);
    expect(result.matchedRules).toContain("hook:h1:ask");
  });
});

describe("tightenOutcome", () => {
  test("base deny is untouchable", () => {
    const result = tightenOutcome("deny", [{ hookId: "h1", decision: "allow" }], true);
    expect(result.outcome).toBe("deny");
  });

  test("base allow + hook ask tightens to ask when interactive", () => {
    const result = tightenOutcome("allow", [{ hookId: "h1", decision: "ask" }], true);
    expect(result.outcome).toBe("ask");
    expect(result.matchedRules).toContain("hook:h1:ask");
  });

  test("base allow + hook ask fails closed to deny when headless", () => {
    const result = tightenOutcome("allow", [{ hookId: "h1", decision: "ask" }], false);
    expect(result.outcome).toBe("deny");
  });

  test("base allow + hook deny denies regardless of interactivity", () => {
    expect(tightenOutcome("allow", [{ hookId: "h1", decision: "deny" }], true).outcome).toBe("deny");
    expect(tightenOutcome("allow", [{ hookId: "h1", decision: "deny" }], false).outcome).toBe("deny");
  });

  test("hook allow never changes anything", () => {
    const result = tightenOutcome("allow", [{ hookId: "h1", decision: "allow" }], true);
    expect(result.outcome).toBe("allow");
    expect(result.matchedRules).toEqual([]);
  });
});
