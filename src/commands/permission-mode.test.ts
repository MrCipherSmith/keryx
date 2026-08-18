import { expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODES,
  resolveApprovalDecision,
  type PermissionMode,
} from "./permission-mode";

test("default mode is ask, unchanged current behavior for anyone who never opts in", () => {
  expect(DEFAULT_PERMISSION_MODE).toBe("ask");
});

test("isPermissionMode accepts only the three closed names", () => {
  for (const m of PERMISSION_MODES) {
    expect(isPermissionMode(m)).toBe(true);
  }
  expect(isPermissionMode("yolo")).toBe(false);
  expect(isPermissionMode("")).toBe(false);
});

test("read always auto-approves regardless of mode", () => {
  for (const mode of PERMISSION_MODES) {
    expect(
      resolveApprovalDecision({ mode, risk: "read", destructive: false, credentials: false }),
    ).toBe("auto");
    expect(
      resolveApprovalDecision({ mode, risk: "read", destructive: true, credentials: true }),
    ).toBe("auto");
  }
});

test("credentials is a hard floor no mode lifts, including auto", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of ["shell", "destructive", "delegate"] as const) {
      expect(
        resolveApprovalDecision({ mode, risk, destructive: false, credentials: true }),
      ).toBe("ask");
    }
  }
});

test("ask mode always asks for non-read actions, even benign ones", () => {
  expect(
    resolveApprovalDecision({ mode: "ask", risk: "shell", destructive: false, credentials: false }),
  ).toBe("ask");
  expect(
    resolveApprovalDecision({ mode: "ask", risk: "delegate", destructive: false, credentials: false }),
  ).toBe("ask");
});

test("trust mode auto-approves a benign shell command", () => {
  expect(
    resolveApprovalDecision({ mode: "trust", risk: "shell", destructive: false, credentials: false }),
  ).toBe("auto");
});

test("trust mode still asks for a destructive command", () => {
  expect(
    resolveApprovalDecision({ mode: "trust", risk: "shell", destructive: true, credentials: false }),
  ).toBe("ask");
});

test("trust mode still asks when the tool's own static risk is destructive", () => {
  expect(
    resolveApprovalDecision({ mode: "trust", risk: "destructive", destructive: false, credentials: false }),
  ).toBe("ask");
});

test("trust mode auto-approves a general delegate spawn that isn't flagged destructive", () => {
  expect(
    resolveApprovalDecision({ mode: "trust", risk: "delegate", destructive: false, credentials: false }),
  ).toBe("auto");
});

test("auto mode bypasses the prompt even for a destructive command", () => {
  expect(
    resolveApprovalDecision({ mode: "auto", risk: "shell", destructive: true, credentials: false }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({ mode: "auto", risk: "destructive", destructive: false, credentials: false }),
  ).toBe("auto");
});

test("mode is a closed set — TypeScript, not this test, rejects anything else", () => {
  const modes: readonly PermissionMode[] = ["ask", "trust", "auto"];
  expect(modes).toEqual(PERMISSION_MODES);
});
