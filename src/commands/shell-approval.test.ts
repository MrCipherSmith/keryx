import { expect, test } from "bun:test";
import { evaluateShellApproval, formatShellApprovalHints } from "./shell-approval";

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

test("evaluateShellApproval never auto-approves destructive or credential commands", () => {
  const ev = evaluateShellApproval({
    inputJson: JSON.stringify({ command: "git status" }),
    meta: { fingerprint: "fp", destructive: true, credentials: true },
    sessionAllow: new Set(),
    fingerprintAtStart: "start",
    io: cleanIo,
  });
  expect(ev.autoApprove).toBe(false);
  expect(ev.destructive).toBe(true);
  expect(ev.credentials).toBe(true);
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/destructive/);
  expect(formatShellApprovalHints(ev).join(" ")).toMatch(/credentials/);
});

test("evaluateShellApproval reports tamper when the fingerprint moved", () => {
  const ev = evaluateShellApproval({
    inputJson: "echo hi",
    sessionAllow: new Set(),
    fingerprintAtStart: "old",
    io: { ...cleanIo, fingerprint: () => "new" },
  });
  expect(ev.tampered).toBe(true);
  expect(ev.autoApprove).toBe(false);
});
