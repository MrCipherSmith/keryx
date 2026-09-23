import { expect, test } from "bun:test";
import { evaluateShellApproval, formatShellApprovalHints, rememberExactShellGrant } from "./shell-approval";

const cleanIo = {
  loadAudit: () => ({ permissions: { allow: ["git status"] }, rejected: [] as const }),
  fingerprint: () => "start",
};

test("evaluateShellApproval auto-approves a matching allowlist entry", () => {
  const sessionAllow = new Set<string>();
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    sessionAllow,
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.autoApprove).toBe(true);
  expect(ev.command).toBe("git status");
  expect(sessionAllow.has("git status")).toBe(true);
});

test("evaluateShellApproval never auto-approves destructive commands", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    meta: { fingerprint: "fp", destructive: true },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.autoApprove).toBe(false);
  expect(ev.destructive).toBe(true);
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/destructive/);
});

test("evaluateShellApproval never auto-approves credential-touching commands", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    meta: { fingerprint: "fp", destructive: false, credentials: true },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.autoApprove).toBe(false);
  expect(ev.credentials).toBe(true);
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/credentials/);
});

// --- publishLease (specification §4.4, flow 275 T5) ------------------------

test("evaluateShellApproval never auto-approves a command a git-publish lease applies to, even a saved allowlist match", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }), // command shape irrelevant; io says it's allowlisted
    meta: { fingerprint: "fp", destructive: false, publishLease: true },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo, // allowlists "git status" — would otherwise auto-approve
  });
  expect(ev.autoApprove).toBe(false);
  expect(ev.publishLease).toBe(true);
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/publish/);
});

test("evaluateShellApproval without publishLease is unaffected (regression guard)", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.publishLease).toBe(false);
  expect(ev.autoApprove).toBe(true);
});

// Flow 275 F1 (specification §4.4): "The prompt names the lease, its holder
// and its reason." `ApprovalMeta.publishLeaseDetail` must reach the readline
// hint line, not just `ShellApprovalEval.publishLease`'s boolean.
test("evaluateShellApproval carries publishLeaseDetail through, and the readline hint names the holder and reason", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git push origin main" }),
    meta: {
      fingerprint: "fp",
      destructive: false,
      publishLease: true,
      publishLeaseDetail: 'held by @alice — "cutting the release"',
    },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.publishLeaseDetail).toBe('held by @alice — "cutting the release"');
  const hints = formatShellApprovalHints(ev).join(" ");
  expect(hints).toContain("@alice");
  expect(hints).toContain("cutting the release");
});

test("evaluateShellApproval falls back to the generic hint when publishLeaseDetail is absent", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git push origin main" }),
    meta: { fingerprint: "fp", destructive: false, publishLease: true },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.publishLeaseDetail).toBeUndefined();
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/a peer's git-publish lease applies/);
});

test("rememberExactShellGrant refuses to remember anything while publishLease is set", () => {
  const sessionAllow = new Set<string>();
  const stored = rememberExactShellGrant("git push origin main", sessionAllow, { publishLease: true });
  expect(stored).toBe("");
  expect(sessionAllow.size).toBe(0);
});

test("evaluateShellApproval reports tamper but still auto-approves a matching grant", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    sessionAllow: new Set(),
    fingerprintAtStart: "old",
    io: { ...cleanIo, fingerprint: () => "new" },
  });
  expect(ev.tampered).toBe(true);
  expect(ev.autoApprove).toBe(true);
});

// --- security review of PR #661: `flow confirm` shares SAC's never-remember floor ---

test("review #661: a `keryx flow *` session pattern auto-approves `flow status` but never `flow confirm`", () => {
  const io = { loadAudit: () => ({ permissions: { allow: [] as string[] }, rejected: [] as const }), fingerprint: () => "start" };
  const control = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "keryx flow status 299" }),
    sessionAllow: new Set(["keryx flow *"]),
    fingerprintAtStart: "start",
    io,
  });
  expect(control.autoApprove).toBe(true);
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "keryx flow confirm 299" }),
    sessionAllow: new Set(["keryx flow *"]),
    fingerprintAtStart: "start",
    io,
  });
  expect(ev.sacReviewConfirmation).toBe(true);
  expect(ev.autoApprove).toBe(false);
  expect(formatShellApprovalHints(ev).join(" ")).toContain("will not be remembered");
});

test("review #661: an exact remembered grant for `keryx flow confirm 299` does not auto-approve it", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "keryx flow confirm 299" }),
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: { loadAudit: () => ({ permissions: { allow: ["keryx flow confirm 299"] }, rejected: [] as const }), fingerprint: () => "start" },
  });
  expect(ev.autoApprove).toBe(false);
});

test("review #661: `flow confirm` is never offered or stored as an 'always' grant", async () => {
  const { suggestShellPatterns, validateShellPattern } = await import("../lib/shell-permissions");
  const offer = suggestShellPatterns("keryx flow confirm 299");
  expect(offer.offerExact).toBe(false);
  expect(offer.offerPrefix).toBe(false);
  expect(validateShellPattern("keryx flow confirm *").ok).toBe(false);
  expect(validateShellPattern("keryx flow confirm 299").ok).toBe(false);
  // readline's `rememberable` is the negation of these flags (shell.ts); the floor flag is set.
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "keryx flow confirm 299" }),
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.sacReviewConfirmation).toBe(true);
});
