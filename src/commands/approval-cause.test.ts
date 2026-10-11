// Flow 426 AC5: every approval prompt carries one cause line from a closed set.

import { expect, test } from "bun:test";
import {
  APPROVAL_CAUSES,
  approvalCauseLine,
  causeOfMeta,
  classifyApprovalCause,
  type ApprovalCause,
} from "./approval-cause";
import { describeApprovalForTopic } from "../remote/shell-bridge";

test("AC5: the cause set is closed and has the seven frozen names", () => {
  expect([...APPROVAL_CAUSES]).toEqual([
    "destructive",
    "credentials",
    "publish",
    "hook-ask",
    "untrusted-content",
    "not-in-routine-list",
    "mode-ask",
  ]);
});

test("AC5 destructive: a destructive call names destructive, ahead of every other flag", () => {
  expect(classifyApprovalCause({ destructive: true })).toBe("destructive");
  expect(classifyApprovalCause({ destructive: true, credentials: true, untrusted: true, shell: true })).toBe("destructive");
});

test("AC5 credentials: credentials and human-confirmation calls name credentials", () => {
  expect(classifyApprovalCause({ credentials: true })).toBe("credentials");
  expect(classifyApprovalCause({ confirmation: true })).toBe("credentials");
  expect(classifyApprovalCause({ credentials: true, publishLease: true, hookAsk: true })).toBe("credentials");
});

test("AC5 publish: a publish lease names publish", () => {
  expect(classifyApprovalCause({ publishLease: true })).toBe("publish");
  expect(classifyApprovalCause({ publishLease: true, hookAsk: true, untrusted: true })).toBe("publish");
});

test("AC5 hook-ask: a hook that asked names hook-ask", () => {
  expect(classifyApprovalCause({ hookAsk: true })).toBe("hook-ask");
  expect(classifyApprovalCause({ hookAsk: true, untrusted: true, shell: true })).toBe("hook-ask");
});

test("AC5 untrusted-content: a non-shell call after external content names untrusted-content", () => {
  expect(classifyApprovalCause({ untrusted: true })).toBe("untrusted-content");
  expect(classifyApprovalCause({ untrusted: true, shell: false })).toBe("untrusted-content");
});

test("AC5 not-in-routine-list: a shell command after external content that is not in the table names not-in-routine-list", () => {
  expect(classifyApprovalCause({ untrusted: true, shell: true })).toBe("not-in-routine-list");
});

test("AC5 mode-ask: a call that only the mode asks about names mode-ask", () => {
  expect(classifyApprovalCause({})).toBe("mode-ask");
  expect(classifyApprovalCause({ shell: true })).toBe("mode-ask");
});

test("AC5: each cause has one short line starting with why:", () => {
  const lines = APPROVAL_CAUSES.map((cause) => approvalCauseLine(cause));
  expect(new Set(lines).size).toBe(APPROVAL_CAUSES.length);
  for (const line of lines) {
    expect(line.startsWith("why: ")).toBe(true);
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThan(110);
  }
});

test("AC5: causeOfMeta prefers the cause the agent set and falls back to the flags", () => {
  const base = { fingerprint: "f", destructive: false };
  expect(causeOfMeta("shell_exec", { ...base, cause: "publish" })).toBe("publish");
  expect(causeOfMeta("shell_exec", { ...base, destructive: true })).toBe("destructive");
  expect(causeOfMeta("shell_exec", { ...base, untrustedOrigin: true })).toBe("not-in-routine-list");
  expect(causeOfMeta("web_fetch", { ...base, untrustedOrigin: true })).toBe("untrusted-content");
  expect(causeOfMeta("apply_patch", { ...base, alwaysAsk: true })).toBe("credentials");
  expect(causeOfMeta("shell_exec", undefined)).toBe("mode-ask");
});

test("AC5: the Telegram relay of the prompt carries the same cause line", () => {
  for (const cause of APPROVAL_CAUSES as readonly ApprovalCause[]) {
    const text = describeApprovalForTopic("shell_exec", JSON.stringify({ command: "keryx flow status" }), {
      destructive: cause === "destructive",
      credentials: cause === "credentials",
      untrustedOrigin: cause === "untrusted-content" || cause === "not-in-routine-list",
      cause,
    });
    expect(text).toContain(approvalCauseLine(cause));
  }
});
