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
