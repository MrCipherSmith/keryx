import { expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODES,
  resolveApprovalDecision,
  type ApprovalGateDecision,
  type GatedToolRisk,
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
      resolveApprovalDecision({
        mode,
        risk: "read",
        destructive: false,
        credentials: false,
        sacReviewConfirmation: false,
        readOnly: false,
      }),
    ).toBe("auto");
    expect(
      resolveApprovalDecision({
        mode,
        risk: "read",
        destructive: true,
        credentials: true,
        sacReviewConfirmation: true,
        readOnly: false,
      }),
    ).toBe("auto");
  }
});

test("credentials is a hard floor no mode lifts, including auto", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of ["shell", "destructive", "delegate", "write"] as const) {
      expect(
        resolveApprovalDecision({
          mode,
          risk,
          destructive: false,
          credentials: true,
          sacReviewConfirmation: false,
          readOnly: false,
        }),
      ).toBe("ask");
    }
  }
});

test("sacReviewConfirmation is a hard floor no mode lifts, including auto", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of ["shell", "destructive", "delegate", "write"] as const) {
      expect(
        resolveApprovalDecision({
          mode,
          risk,
          destructive: false,
          credentials: false,
          sacReviewConfirmation: true,
          readOnly: false,
        }),
      ).toBe("ask");
    }
  }
});

test("ask mode always asks for non-read actions, even benign ones", () => {
  expect(
    resolveApprovalDecision({
      mode: "ask",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
  expect(
    resolveApprovalDecision({
      mode: "ask",
      risk: "delegate",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
});

test("trust mode auto-approves a benign shell command", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
});

test("trust mode still asks for a destructive command", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "shell",
      destructive: true,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
});

test("trust mode still asks when the tool's own static risk is destructive", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "destructive",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
});

test("trust mode auto-approves a general delegate spawn that isn't flagged destructive", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "delegate",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
});

test("auto mode bypasses the prompt even for a destructive command", () => {
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "shell",
      destructive: true,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "destructive",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
});

test("auto mode still asks when the action touches SAC confirm-review", () => {
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: true,
      readOnly: false,
    }),
  ).toBe("ask");
});

test("ADR-0010: write behaves exactly like shell under every mode — ask/trust/auto, benign and destructive", () => {
  expect(
    resolveApprovalDecision({
      mode: "ask",
      risk: "write",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "write",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "write",
      destructive: true,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "write",
      destructive: true,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "write",
      destructive: false,
      credentials: true,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("ask");
});

test("mode is a closed set — TypeScript, not this test, rejects anything else", () => {
  const modes: readonly PermissionMode[] = ["ask", "trust", "auto"];
  expect(modes).toEqual(PERMISSION_MODES);
});

// --- readOnly ("/plan") — orthogonal axis, gate-level hard floor ----------

const NON_READ_RISKS: readonly GatedToolRisk[] = ["shell", "destructive", "delegate", "write"];

test("readOnly denies every non-read risk under every mode, including previously-auto-approving trust/auto combos", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of NON_READ_RISKS) {
      const decision: ApprovalGateDecision = resolveApprovalDecision({
        mode,
        risk,
        destructive: false,
        credentials: false,
        sacReviewConfirmation: false,
        readOnly: true,
      });
      expect(decision).toBe("deny");
    }
  }
});

test("readOnly denies even a destructive/credentials-flagged action (deny wins over ask/auto either way)", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of NON_READ_RISKS) {
      expect(
        resolveApprovalDecision({
          mode,
          risk,
          destructive: true,
          credentials: true,
          sacReviewConfirmation: true,
          readOnly: true,
        }),
      ).toBe("deny");
    }
  }
});

test("readOnly still auto-approves read risk", () => {
  for (const mode of PERMISSION_MODES) {
    expect(
      resolveApprovalDecision({
        mode,
        risk: "read",
        destructive: false,
        credentials: false,
        sacReviewConfirmation: false,
        readOnly: true,
      }),
    ).toBe("auto");
  }
});

// --- publishLease (specification §4.4, flow 275 T5) — a third hard floor,
// alongside credentials/sacReviewConfirmation, that never denies on its own.

test("publishLease is a hard floor no mode lifts, including auto — never denies on its own", () => {
  for (const mode of PERMISSION_MODES) {
    for (const risk of ["shell", "destructive", "delegate", "write"] as const) {
      expect(
        resolveApprovalDecision({
          mode,
          risk,
          destructive: false,
          credentials: false,
          sacReviewConfirmation: false,
          readOnly: false,
          publishLease: true,
        }),
      ).toBe("ask");
    }
  }
});

test("publishLease: false (or omitted) does not change anything — trust/auto still auto-approve a benign action", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
      publishLease: false,
    }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
});

test("readOnly still denies even when publishLease is also set (deny wins)", () => {
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: true,
      publishLease: true,
    }),
  ).toBe("deny");
});

test("readOnly: false reproduces existing (pre-readOnly) behavior unchanged — trust/auto still auto-approve benign non-read actions", () => {
  expect(
    resolveApprovalDecision({
      mode: "trust",
      risk: "shell",
      destructive: false,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
  expect(
    resolveApprovalDecision({
      mode: "auto",
      risk: "write",
      destructive: true,
      credentials: false,
      sacReviewConfirmation: false,
      readOnly: false,
    }),
  ).toBe("auto");
});
