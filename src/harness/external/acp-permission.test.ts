// The ACP-client permission bridge, table-driven (flow 292, AC2/AC3).
//
// Every foreign-agent permission goes through `resolveApprovalDecision` with the
// mode LOWERED to `ask`. The tables below pin, for each self-described tool
// kind, the risk keryx reads and the gate decision under every requested mode —
// which is the same under `ask`, `trust` and `auto`, because the mode never
// reaches a foreign agent unclamped.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcpPermissionOption, AcpToolCallUpdate, AcpToolKind } from "../../acp/protocol";
import type { PermissionMode } from "../../commands/permission-mode";
import {
  acpPermissionAnswer,
  answerAcpPermission,
  clampForeignMode,
  classifyAcpToolCall,
  decideAcpPermission,
} from "./acp-permission";

let base = "";
let worktree = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-perm-unit-")));
  worktree = path.join(base, "wt");
  mkdirSync(path.join(worktree, "src"), { recursive: true });
  mkdirSync(path.join(base, "outside"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const ALL_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "ao", name: "Allow once", kind: "allow_once" },
  { optionId: "aa", name: "Always allow", kind: "allow_always" },
  { optionId: "ro", name: "Reject", kind: "reject_once" },
  { optionId: "ra", name: "Always reject", kind: "reject_always" },
];

function call(kind: AcpToolKind | undefined, extra: Partial<AcpToolCallUpdate> = {}): AcpToolCallUpdate {
  return { toolCallId: "t1", title: "a call", ...(kind === undefined ? {} : { kind }), ...extra };
}

const MODES: readonly PermissionMode[] = ["ask", "trust", "auto"];

describe("AC2 — kind → risk → gate decision, for every requested mode", () => {
  const table: ReadonlyArray<{
    readonly label: string;
    readonly toolCall: () => AcpToolCallUpdate;
    readonly risk: string;
    readonly decision: "auto" | "ask" | "deny";
  }> = [
    { label: "read inside the worktree", toolCall: () => call("read", { locations: [{ path: path.join(worktree, "src", "a.ts") }] }), risk: "read", decision: "auto" },
    { label: "search", toolCall: () => call("search"), risk: "read", decision: "auto" },
    { label: "think", toolCall: () => call("think"), risk: "read", decision: "auto" },
    { label: "read OUTSIDE the worktree escalates", toolCall: () => call("read", { locations: [{ path: path.join(base, "outside", "x") }] }), risk: "write", decision: "ask" },
    { label: "edit", toolCall: () => call("edit", { locations: [{ path: path.join(worktree, "src", "a.ts") }] }), risk: "write", decision: "ask" },
    { label: "move", toolCall: () => call("move"), risk: "write", decision: "ask" },
    { label: "delete", toolCall: () => call("delete"), risk: "destructive", decision: "ask" },
    { label: "execute (benign)", toolCall: () => call("execute", { rawInput: { command: "ls", args: ["-la"] } }), risk: "shell", decision: "ask" },
    { label: "execute (destructive)", toolCall: () => call("execute", { rawInput: { command: "git push --force" } }), risk: "destructive", decision: "ask" },
    { label: "fetch", toolCall: () => call("fetch"), risk: "network", decision: "deny" },
    { label: "other", toolCall: () => call("other"), risk: "shell", decision: "ask" },
    { label: "switch_mode", toolCall: () => call("switch_mode"), risk: "shell", decision: "ask" },
    { label: "missing kind", toolCall: () => call(undefined), risk: "shell", decision: "ask" },
    { label: "a managed flow file", toolCall: () => call("edit", { locations: [{ path: path.join(worktree, ".metaproject", "flows", "1-x", "flow.json") }] }), risk: "write", decision: "deny" },
  ];

  for (const row of table) {
    for (const mode of MODES) {
      test(`${row.label} under requested mode ${mode} → ${row.risk} / ${row.decision}`, () => {
        const classification = classifyAcpToolCall(row.toolCall(), worktree);
        expect(classification.risk).toBe(row.risk as typeof classification.risk);
        const clamp = clampForeignMode(mode);
        expect(clamp.effective).toBe("ask");
        expect(decideAcpPermission(classification, clamp.effective)).toBe(row.decision);
      });
    }
  }

  test("`other` and a missing kind are classified destructive, never milder", () => {
    expect(classifyAcpToolCall(call("other"), worktree).destructive).toBe(true);
    expect(classifyAcpToolCall(call(undefined), worktree).destructive).toBe(true);
  });

  test("a read under an in-worktree symlink that points outside escalates", () => {
    symlinkSync(path.join(base, "outside"), path.join(worktree, "link"));
    const classification = classifyAcpToolCall(call("read", { locations: [{ path: path.join(worktree, "link", "new") }] }), worktree);
    expect(classification.outsideWorktree).toBe(true);
    expect(decideAcpPermission(classification, "ask")).toBe("ask");
  });

  test("the clamp is recorded: trust and auto are lowered, ask is not", () => {
    expect(clampForeignMode("trust")).toEqual({ requested: "trust", effective: "ask", clamped: true });
    expect(clampForeignMode("auto")).toEqual({ requested: "auto", effective: "ask", clamped: true });
    expect(clampForeignMode("ask")).toEqual({ requested: "ask", effective: "ask", clamped: false });
  });

  test("UNCLAMPED, trust would have auto-approved an execute — the clamp is what stops it", () => {
    const classification = classifyAcpToolCall(call("execute", { rawInput: { command: "ls" } }), worktree);
    expect(decideAcpPermission(classification, "trust")).toBe("auto");
    expect(decideAcpPermission(classification, clampForeignMode("trust").effective)).toBe("ask");
  });
});

describe("AC2 — the answer: allow_once only, never allow_always", () => {
  test("approve selects allow_once", () => {
    expect(acpPermissionAnswer("approve", ALL_OPTIONS)).toEqual({ outcome: { outcome: "selected", optionId: "ao" }, optionId: "ao" });
  });

  test("deny selects reject_once, not reject_always", () => {
    expect(acpPermissionAnswer("deny", ALL_OPTIONS)).toEqual({ outcome: { outcome: "selected", optionId: "ro" }, optionId: "ro" });
  });

  test("deny with no reject_once answers cancelled", () => {
    const options = ALL_OPTIONS.filter((option) => option.kind !== "reject_once");
    expect(acpPermissionAnswer("deny", options)).toEqual({ outcome: { outcome: "cancelled" }, optionId: null });
  });

  test("an auto-approved read with only allow_always offered is REFUSED, not granted forever", async () => {
    const options = ALL_OPTIONS.filter((option) => option.kind !== "allow_once");
    const { answer, decision } = await answerAcpPermission(
      { requestId: 1, toolCall: call("read"), options },
      { worktree, mode: clampForeignMode("ask"), unattended: true },
    );
    expect(decision.gateDecision).toBe("auto");
    expect(decision.verdict).toBe("deny");
    expect(decision.reason).toBe("no-allow-option");
    expect(answer.optionId).toBe("ro");
  });
});

describe("AC3 — fail closed", () => {
  const ctx = (overrides: Partial<Parameters<typeof answerAcpPermission>[1]> = {}): Parameters<typeof answerAcpPermission>[1] => ({
    worktree,
    mode: clampForeignMode("trust"),
    unattended: false,
    ...overrides,
  });

  test("unattended: a call that needs a human is rejected, and the record says why", async () => {
    const { answer, decision } = await answerAcpPermission({ requestId: 7, toolCall: call("execute", { rawInput: { command: "ls" } }), options: ALL_OPTIONS }, ctx({ unattended: true }));
    expect(answer.outcome).toEqual({ outcome: "selected", optionId: "ro" });
    expect(decision).toMatchObject({ risk: "shell", gateDecision: "ask", verdict: "deny", reason: "unattended", timedOut: false, modeRequested: "trust", modeEffective: "ask" });
  });

  test("no approver wired is unattended", async () => {
    const { decision } = await answerAcpPermission({ requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS }, ctx());
    expect(decision.reason).toBe("unattended");
    expect(decision.verdict).toBe("deny");
  });

  test("an approver that never answers times out into a rejection", async () => {
    const { answer, decision } = await answerAcpPermission(
      { requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS },
      ctx({ requestApproval: () => new Promise(() => undefined), approvalTimeoutMs: 20 }),
    );
    expect(answer.optionId).toBe("ro");
    expect(decision).toMatchObject({ verdict: "deny", reason: "timeout", timedOut: true });
  });

  test("a human no is a rejection", async () => {
    const { decision } = await answerAcpPermission(
      { requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS },
      ctx({ requestApproval: async (_tool, _input, meta) => ({ approved: false, fingerprint: meta?.fingerprint ?? "" }) }),
    );
    expect(decision).toMatchObject({ verdict: "deny", reason: "human" });
  });

  test("a human yes WITHOUT the prompt's fingerprint is a rejection", async () => {
    const bare = await answerAcpPermission({ requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS }, ctx({ requestApproval: async () => true }));
    expect(bare.decision.verdict).toBe("deny");
    const wrong = await answerAcpPermission(
      { requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS },
      ctx({ requestApproval: async () => ({ approved: true, fingerprint: "another-prompt" }) }),
    );
    expect(wrong.decision.verdict).toBe("deny");
  });

  test("a human yes that echoes the fingerprint selects allow_once", async () => {
    const { answer, decision } = await answerAcpPermission(
      { requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS },
      ctx({ requestApproval: async (_tool, _input, meta) => ({ approved: true, fingerprint: meta?.fingerprint ?? "" }) }),
    );
    expect(answer.optionId).toBe("ao");
    expect(decision).toMatchObject({ verdict: "approve", reason: "human" });
  });

  test("an approver that throws has approved nothing", async () => {
    const { decision } = await answerAcpPermission(
      { requestId: 7, toolCall: call("edit"), options: ALL_OPTIONS },
      ctx({ requestApproval: async () => { throw new Error("boom"); } }),
    );
    expect(decision.verdict).toBe("deny");
  });

  test("fetch is denied even with a human who would say yes", async () => {
    const { decision } = await answerAcpPermission(
      { requestId: 7, toolCall: call("fetch"), options: ALL_OPTIONS },
      ctx({ requestApproval: async (_tool, _input, meta) => ({ approved: true, fingerprint: meta?.fingerprint ?? "" }) }),
    );
    expect(decision).toMatchObject({ gateDecision: "deny", verdict: "deny", reason: "policy" });
  });
});
