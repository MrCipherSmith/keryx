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

  test("the placeholder classifier always returns the least-escalated verdict (T9's real classifier lands later)", () => {
    const pending = toPendingElicitation({
      requestId: 1,
      message: "rm -rf /",
      requestedSchema: {},
      vendor: { codex_command: ["rm", "-rf", "/"] },
    });
    expect(classifyElicitationRisk(pending)).toEqual({ destructive: false, credentials: false });
  });
});
