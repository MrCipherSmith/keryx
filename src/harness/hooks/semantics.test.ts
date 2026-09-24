import { describe, expect, test } from "bun:test";
import { failureEffect } from "./semantics";
import type { HookClass, HookFailureKind } from "./types";
import type { PolicyOutcome, PolicyProfileId } from "../policy/types";

const PROFILES: PolicyProfileId[] = ["read-only-review", "monitored-trusted-local", "unattended-untrusted"];
const NON_MALFORMED_FAILURES: HookFailureKind[] = ["timeout", "crash", "sandbox-unavailable", "refused"];

describe("failureEffect — gate class", () => {
  for (const profile of PROFILES) {
    for (const failure of NON_MALFORMED_FAILURES) {
      test(`${failure} denies in ${profile}`, () => {
        const result = failureEffect({ cls: "gate", event: "PreToolUse", failure, profileId: profile });
        expect(result.effect).toBe("deny");
      });
    }
  }

  for (const profile of PROFILES) {
    test(`malformed silent-approves in ${profile} when decide() said allow`, () => {
      const result = failureEffect({ cls: "gate", event: "PreToolUse", failure: "malformed", profileId: profile, decideOutcome: "allow" });
      expect(result.effect).toBe("silent-approve");
    });

    test(`malformed denies in ${profile} when decide() said ask`, () => {
      const result = failureEffect({ cls: "gate", event: "PreToolUse", failure: "malformed", profileId: profile, decideOutcome: "ask" });
      expect(result.effect).toBe("deny");
    });
  }
});

describe("failureEffect — gate-advisory class", () => {
  const failures: HookFailureKind[] = ["timeout", "crash", "malformed"];
  for (const failure of failures) {
    test(`${failure} proceeds with a warning in read-only-review`, () => {
      const result = failureEffect({ cls: "gate-advisory", event: "PreToolUse", failure, profileId: "read-only-review" });
      expect(result.effect).toBe("proceed");
      expect(result.warning).toBe("hook-advisory-failed");
    });
    test(`${failure} proceeds with a warning in monitored-trusted-local`, () => {
      const result = failureEffect({ cls: "gate-advisory", event: "PreToolUse", failure, profileId: "monitored-trusted-local" });
      expect(result.effect).toBe("proceed");
      expect(result.warning).toBe("hook-advisory-failed");
    });
    test(`${failure} denies in unattended-untrusted`, () => {
      const result = failureEffect({ cls: "gate-advisory", event: "PreToolUse", failure, profileId: "unattended-untrusted" });
      expect(result.effect).toBe("deny");
    });
  }
});

describe("failureEffect — observe / context classes always fail open with a warning", () => {
  const failures: HookFailureKind[] = ["timeout", "crash", "malformed"];
  for (const profile of PROFILES) {
    for (const failure of failures) {
      test(`observe ${failure} proceeds with hook-observer-failed in ${profile}`, () => {
        const result = failureEffect({ cls: "observe", event: "PostToolUse", failure, profileId: profile });
        expect(result.effect).toBe("proceed");
        expect(result.warning).toBe("hook-observer-failed");
      });
      test(`context ${failure} proceeds with hook-context-failed in ${profile}`, () => {
        const result = failureEffect({ cls: "context", event: "PreCompact", failure, profileId: profile });
        expect(result.effect).toBe("proceed");
        expect(result.warning).toBe("hook-context-failed");
      });
    }
  }
});

describe("failureEffect — SessionStart always proceeds regardless of class", () => {
  const classes: HookClass[] = ["gate", "gate-advisory", "observe", "context"];
  const failures: HookFailureKind[] = ["timeout", "crash", "malformed"];
  for (const cls of classes) {
    for (const failure of failures) {
      for (const profile of PROFILES) {
        test(`${cls}/${failure}/${profile} on SessionStart proceeds with a warning`, () => {
          const result = failureEffect({ cls, event: "SessionStart", failure, profileId: profile, decideOutcome: "ask" as PolicyOutcome });
          expect(result.effect).toBe("proceed");
          expect(result.warning).toBeDefined();
        });
      }
    }
  }
});

describe("failureEffect — sandbox-unavailable/refused classify like crash", () => {
  test("sandbox-unavailable denies for gate, like crash", () => {
    const result = failureEffect({ cls: "gate", event: "PreToolUse", failure: "sandbox-unavailable", profileId: "read-only-review" });
    expect(result.effect).toBe("deny");
    expect(result.reason).toBe("hook-sandbox-unavailable");
  });

  test("refused denies for gate, like crash", () => {
    const result = failureEffect({ cls: "gate", event: "PreToolUse", failure: "refused", profileId: "read-only-review" });
    expect(result.effect).toBe("deny");
    expect(result.reason).toBe("hook-crashed");
  });
});
