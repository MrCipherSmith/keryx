// Tests for elicitation correlation, response construction, and the T9
// classifier seam (flow 182, T8; AC3, AC5, AC9).
import { describe, expect, test } from "bun:test";
import {
  buildElicitationResponse,
  classifyElicitationRisk,
  correlateElicitation,
  pickApproveDecision,
  pickDenyDecision,
  toPendingElicitation,
} from "./elicitation";
import { parseElicitationCreateRequest } from "./wire";
import type { RawCodexEventNotification, RawElicitationRequest } from "./types";

function execApprovalEvent(callId: string, availableDecisions: readonly string[]): RawCodexEventNotification {
  return { msgType: "exec_approval_request", callId, availableDecisions, raw: {} };
}

describe("correlateElicitation", () => {
  test("correlated when a matching exec_approval_request with a non-empty decision list is present", () => {
    const events = new Map([["call-1", execApprovalEvent("call-1", ["approved", "abort"])]]);
    const result = correlateElicitation("call-1", events);
    expect(result).toEqual({ kind: "correlated", availableDecisions: ["approved", "abort"] });
  });

  test("uncorrelated when callId is undefined (no codex_call_id on the wire)", () => {
    const events = new Map([["call-1", execApprovalEvent("call-1", ["approved"])]]);
    expect(correlateElicitation(undefined, events)).toEqual({ kind: "uncorrelated" });
  });

  test("uncorrelated when no codex/event was ever seen for this call_id (AC5's live manifestation)", () => {
    expect(correlateElicitation("call-missing", new Map())).toEqual({ kind: "uncorrelated" });
  });

  test("uncorrelated when the matched event's available_decisions is empty or absent", () => {
    const emptyEvents = new Map([["call-1", execApprovalEvent("call-1", [])]]);
    expect(correlateElicitation("call-1", emptyEvents)).toEqual({ kind: "uncorrelated" });

    const undefinedEvents = new Map<string, RawCodexEventNotification>([
      ["call-1", { msgType: "exec_approval_request", callId: "call-1", availableDecisions: undefined, raw: {} }],
    ]);
    expect(correlateElicitation("call-1", undefinedEvents)).toEqual({ kind: "uncorrelated" });
  });

  test("uncorrelated when the matched event is not an exec_approval_request", () => {
    const events = new Map<string, RawCodexEventNotification>([
      ["call-1", { msgType: "turn_aborted", callId: "call-1", availableDecisions: ["approved"], raw: {} }],
    ]);
    expect(correlateElicitation("call-1", events)).toEqual({ kind: "uncorrelated" });
  });
});

describe("pickApproveDecision / pickDenyDecision", () => {
  test("prefers the exact confirmed-valid values from the T5 live probe", () => {
    expect(pickApproveDecision(["approved", "abort"])).toBe("approved");
    expect(pickDenyDecision(["approved", "abort"])).toBe("abort");
  });

  test("prefers abort over denied for deny, since denied is not always valid (T5 finding)", () => {
    expect(pickDenyDecision(["denied", "abort"])).toBe("abort");
  });

  test("falls back to a fuzzy match when the exact literal is absent", () => {
    expect(pickApproveDecision(["approve_once"])).toBe("approve_once");
    expect(pickDenyDecision(["rejected"])).toBe("rejected");
  });

  test("undefined when nothing in the vocabulary looks like the requested verdict", () => {
    expect(pickApproveDecision(["maybe_later"])).toBeUndefined();
    expect(pickDenyDecision(["maybe_later"])).toBeUndefined();
  });
});

describe("buildElicitationResponse", () => {
  test("uncorrelated always declines WITHOUT a decision field, regardless of verdict (AC5)", () => {
    expect(buildElicitationResponse("approve", { kind: "uncorrelated" })).toEqual({ action: "decline" });
    expect(buildElicitationResponse("deny", { kind: "uncorrelated" })).toEqual({ action: "decline" });
  });

  test("correlated + approve produces the exact {action, decision} shape codex reads (T5 finding)", () => {
    const correlation = { kind: "correlated" as const, availableDecisions: ["approved", "abort"] };
    expect(buildElicitationResponse("approve", correlation)).toEqual({ action: "accept", decision: "approved" });
  });

  test("correlated + deny prefers abort", () => {
    const correlation = { kind: "correlated" as const, availableDecisions: ["approved", "abort"] };
    expect(buildElicitationResponse("deny", correlation)).toEqual({ action: "decline", decision: "abort" });
  });

  test("correlated but no recognisable value for the requested verdict declines without a decision", () => {
    const correlation = { kind: "correlated" as const, availableDecisions: ["maybe_later"] };
    expect(buildElicitationResponse("approve", correlation)).toEqual({ action: "decline" });
    expect(buildElicitationResponse("deny", correlation)).toEqual({ action: "decline" });
  });
});

describe("toPendingElicitation / classifyElicitationRisk (T9 seam)", () => {
  test("toPendingElicitation carries the call id, message, and vendor payload through", () => {
    const request: RawElicitationRequest = {
      requestId: 1,
      message: "allow?",
      requestedSchema: {},
      vendor: { codex_call_id: "call-1", codex_command: ["rm", "-rf", "/"] },
    };
    expect(toPendingElicitation(request)).toEqual({
      requestId: 1,
      callId: "call-1",
      message: "allow?",
      vendor: { codex_call_id: "call-1", codex_command: ["rm", "-rf", "/"] },
    });
  });
});

describe("classifyElicitationRisk (T9, AC9)", () => {
  test("destructive: true for a codex_command the shell classifier already recognises as destructive", () => {
    const pending = toPendingElicitation({
      requestId: 1,
      message: "rm -rf /",
      requestedSchema: {},
      vendor: { codex_call_id: "call-1", codex_command: ["rm", "-rf", "/"] },
    });
    const result = classifyElicitationRisk(pending);
    expect(result.destructive).toBe(true);
    expect(result.credentials).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("credentials: true when the command touches the agent's own permission/credential files", () => {
    const pending = toPendingElicitation({
      requestId: 2,
      message: "cat keryx's own permission state",
      requestedSchema: {},
      vendor: { codex_call_id: "call-2", codex_command: ["cat", "/Users/agent/.local/share/keryx/permissions.json"] },
    });
    const result = classifyElicitationRisk(pending);
    expect(result.credentials).toBe(true);
    expect(result.destructive).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("credentials: true from codex_cwd alone, even with a non-destructive command (booleans are independent)", () => {
    const pending = toPendingElicitation({
      requestId: 3,
      message: "ls",
      requestedSchema: {},
      vendor: { codex_call_id: "call-3", codex_command: ["ls"], codex_cwd: "/Users/agent/.config/keryx" },
    });
    const result = classifyElicitationRisk(pending);
    expect(result.destructive).toBe(false);
    expect(result.credentials).toBe(true);
  });

  test("both destructive AND credentials can independently come back true for the same elicitation (AC9's literal requirement)", () => {
    // `sudo` triggers isDestructiveCommand's privilege-escalation rule
    // (destructive); the path also carries one of touchesAgentCredentials'
    // own markers (credentials) — the two signals fire independently off
    // the same joined command string, proving both booleans are reachable
    // together, not mutually exclusive.
    const pending = toPendingElicitation({
      requestId: 4,
      message: "read the agent's own auth state as root",
      requestedSchema: {},
      vendor: {
        codex_call_id: "call-4",
        codex_command: ["sudo", "cat", "/Users/agent/.local/share/keryx/auth.json"],
      },
    });
    const result = classifyElicitationRisk(pending);
    expect(result.destructive).toBe(true);
    expect(result.credentials).toBe(true);
  });

  test("a patch-approval elicitation is treated as destructive even with no codex_command at all (no diff hunks to inspect)", () => {
    const pending = toPendingElicitation({
      requestId: 5,
      message: "apply this patch?",
      requestedSchema: {},
      vendor: { codex_call_id: "call-5", codex_elicitation: "patch-approval" },
    });
    const result = classifyElicitationRisk(pending);
    expect(result.destructive).toBe(true);
    expect(result.reasons.some((r) => /patch-approval/.test(r))).toBe(true);
  });

  test("degrades to {destructive: false, credentials: false} rather than throwing when codex_command is missing or the wrong shape", () => {
    const missing = toPendingElicitation({
      requestId: 6,
      message: "allow?",
      requestedSchema: {},
      vendor: { codex_call_id: "call-6" },
    });
    expect(classifyElicitationRisk(missing)).toEqual({ destructive: false, credentials: false, reasons: [] });

    const wrongShape = toPendingElicitation({
      requestId: 7,
      message: "allow?",
      requestedSchema: {},
      vendor: { codex_call_id: "call-7", codex_command: "rm -rf /" },
    });
    expect(() => classifyElicitationRisk(wrongShape)).not.toThrow();
    expect(classifyElicitationRisk(wrongShape)).toEqual({ destructive: false, credentials: false, reasons: [] });

    const nonStringEntries = toPendingElicitation({
      requestId: 8,
      message: "allow?",
      requestedSchema: {},
      vendor: { codex_call_id: "call-8", codex_command: ["rm", 7, null] },
    });
    expect(() => classifyElicitationRisk(nonStringEntries)).not.toThrow();
    expect(classifyElicitationRisk(nonStringEntries)).toEqual({ destructive: false, credentials: false, reasons: [] });
  });

  test("a non-destructive, non-credential command classifies as fully clean", () => {
    const pending = toPendingElicitation({
      requestId: 9,
      message: "list files",
      requestedSchema: {},
      vendor: { codex_call_id: "call-9", codex_command: ["ls", "-la"] },
    });
    expect(classifyElicitationRisk(pending)).toEqual({ destructive: false, credentials: false, reasons: [] });
  });
});

describe("codex_call_id version-skew degraded handling (T10, PRD Requirement 5)", () => {
  test("a synthetic elicitation/create payload with NO codex_call_id (simulating pre-fix codex, e.g. v0.105.0) degrades to a safe, non-throwing uncorrelated deny end to end", () => {
    // No codex_call_id anywhere in params — the buggy-version shape this
    // regression guards against, in case a future keryx build is ever
    // pointed at an out-of-range codex older than the pinned min version.
    const message = {
      jsonrpc: "2.0",
      id: 99,
      method: "elicitation/create",
      params: {
        message: "Allow codex to run `rm -rf build/`?",
        requestedSchema: { type: "object", properties: {} },
        codex_elicitation: "exec-approval",
        codex_command: ["rm", "-rf", "build/"],
      },
    };

    const raw = parseElicitationCreateRequest(message);
    expect(raw).toBeDefined();

    expect(() => {
      const pending = toPendingElicitation(raw!);
      expect(pending.callId).toBeUndefined();

      // Even with a codex/event notification present for some OTHER call_id,
      // an elicitation with no callId at all can never correlate.
      const recentEvents = new Map<string, RawCodexEventNotification>([
        ["some-other-call", { msgType: "exec_approval_request", callId: "some-other-call", availableDecisions: ["approved"], raw: {} }],
      ]);
      const correlation = correlateElicitation(pending.callId, recentEvents);
      expect(correlation).toEqual({ kind: "uncorrelated" });

      const response = buildElicitationResponse("approve", correlation);
      expect(response).toEqual({ action: "decline" });
    }).not.toThrow();
  });
});
