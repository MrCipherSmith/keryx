// Tests for raw JSON-RPC message parsing (flow 182, T6/T8; AC2).
//
// No SDK anywhere in this file: every case is a plain JS object shaped like a
// parsed JSON-RPC message, exactly what a transport-level `onmessage` tap
// receives. Field shapes mirror the T5 live probe findings recorded in
// `.metaproject/flows/182-.../context.md` ("T5 live probe findings").
import { describe, expect, test } from "bun:test";
import {
  extractCodexCallId,
  isExecApprovalRequestEvent,
  isJsonRpcNotificationMessage,
  isJsonRpcRequestMessage,
  parseCodexEventNotification,
  parseElicitationCreateRequest,
} from "./wire";

describe("isJsonRpcRequestMessage / isJsonRpcNotificationMessage", () => {
  test("a message with an id is a request, not a notification", () => {
    const message = { jsonrpc: "2.0", id: 7, method: "elicitation/create", params: {} };
    expect(isJsonRpcRequestMessage(message)).toBe(true);
    expect(isJsonRpcNotificationMessage(message)).toBe(false);
  });

  test("a message without an id is a notification, not a request", () => {
    const message = { jsonrpc: "2.0", method: "codex/event", params: {} };
    expect(isJsonRpcNotificationMessage(message)).toBe(true);
    expect(isJsonRpcRequestMessage(message)).toBe(false);
  });

  test("a string id is accepted for a request (JSON-RPC allows string ids)", () => {
    expect(isJsonRpcRequestMessage({ jsonrpc: "2.0", id: "req-1", method: "elicitation/create" })).toBe(true);
  });

  test("neither predicate accepts a non-object, an array, or a message with no method", () => {
    expect(isJsonRpcRequestMessage(null)).toBe(false);
    expect(isJsonRpcRequestMessage("elicitation/create")).toBe(false);
    expect(isJsonRpcRequestMessage([])).toBe(false);
    expect(isJsonRpcRequestMessage({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isJsonRpcNotificationMessage({ jsonrpc: "2.0" })).toBe(false);
  });
});

describe("parseElicitationCreateRequest", () => {
  test("preserves codex's vendor fields the SDK's own ElicitRequestSchema strips (T5 finding)", () => {
    const message = {
      jsonrpc: "2.0",
      id: 42,
      method: "elicitation/create",
      params: {
        message: "Allow codex to run `rm -rf build/`?",
        requestedSchema: { type: "object", properties: {} },
        codex_call_id: "call-123",
        codex_elicitation: "exec-approval",
        codex_command: ["rm", "-rf", "build/"],
        codex_cwd: "/tmp/worktree",
      },
    };

    const parsed = parseElicitationCreateRequest(message);
    expect(parsed).toBeDefined();
    expect(parsed?.requestId).toBe(42);
    expect(parsed?.message).toBe("Allow codex to run `rm -rf build/`?");
    expect(parsed?.requestedSchema).toEqual({ type: "object", properties: {} });
    expect(parsed?.vendor.codex_call_id).toBe("call-123");
    expect(parsed?.vendor.codex_elicitation).toBe("exec-approval");
    expect(parsed?.vendor.codex_command).toEqual(["rm", "-rf", "build/"]);
    expect(parsed?.vendor.codex_cwd).toBe("/tmp/worktree");
    // Standard fields must NOT also appear duplicated inside `vendor`.
    expect(parsed?.vendor.message).toBeUndefined();
    expect(parsed?.vendor.requestedSchema).toBeUndefined();
  });

  test("undefined for a different method, a response, or a malformed message", () => {
    expect(parseElicitationCreateRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toBeUndefined();
    expect(parseElicitationCreateRequest({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined();
    expect(parseElicitationCreateRequest(null)).toBeUndefined();
    expect(parseElicitationCreateRequest("not json")).toBeUndefined();
  });

  test("requestedSchema being the empty-object shape is parsed as-is, not treated as an error (T5 finding: this is normal)", () => {
    const parsed = parseElicitationCreateRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "elicitation/create",
      params: { message: "ok?", requestedSchema: { type: "object", properties: {} } },
    });
    expect(parsed?.requestedSchema).toEqual({ type: "object", properties: {} });
  });

  test("missing params is handled without throwing", () => {
    const parsed = parseElicitationCreateRequest({ jsonrpc: "2.0", id: 1, method: "elicitation/create" });
    expect(parsed).toBeDefined();
    expect(parsed?.message).toBeUndefined();
    expect(parsed?.vendor).toEqual({});
  });
});

describe("parseCodexEventNotification / isExecApprovalRequestEvent", () => {
  test("unpacks call_id and available_decisions from an exec_approval_request", () => {
    const message = {
      jsonrpc: "2.0",
      method: "codex/event",
      params: {
        msg: {
          type: "exec_approval_request",
          call_id: "call-123",
          available_decisions: ["approved", "abort"],
        },
      },
    };
    const event = parseCodexEventNotification(message);
    expect(event).toBeDefined();
    expect(event?.msgType).toBe("exec_approval_request");
    expect(event?.callId).toBe("call-123");
    expect(event?.availableDecisions).toEqual(["approved", "abort"]);
    expect(isExecApprovalRequestEvent(event!)).toBe(true);
  });

  test("a different msg.type is parsed but not an exec-approval-request", () => {
    const event = parseCodexEventNotification({
      jsonrpc: "2.0",
      method: "codex/event",
      params: { msg: { type: "turn_aborted", reason: "interrupted" } },
    });
    expect(event).toBeDefined();
    expect(isExecApprovalRequestEvent(event!)).toBe(false);
    expect(event?.callId).toBeUndefined();
    expect(event?.availableDecisions).toBeUndefined();
  });

  test("undefined for a different method, a request (has id), or a msg that is not an object", () => {
    expect(parseCodexEventNotification({ jsonrpc: "2.0", method: "notifications/other", params: {} })).toBeUndefined();
    expect(
      parseCodexEventNotification({ jsonrpc: "2.0", id: 1, method: "codex/event", params: { msg: {} } }),
    ).toBeUndefined();
    expect(parseCodexEventNotification({ jsonrpc: "2.0", method: "codex/event", params: { msg: "nope" } })).toBeUndefined();
    expect(parseCodexEventNotification({ jsonrpc: "2.0", method: "codex/event" })).toBeUndefined();
  });

  test("non-string entries in available_decisions are filtered out rather than throwing", () => {
    const event = parseCodexEventNotification({
      jsonrpc: "2.0",
      method: "codex/event",
      params: { msg: { type: "exec_approval_request", call_id: "c1", available_decisions: ["approved", 7, null] } },
    });
    expect(event?.availableDecisions).toEqual(["approved"]);
  });
});

describe("extractCodexCallId", () => {
  test("reads vendor.codex_call_id when present and a string", () => {
    const parsed = parseElicitationCreateRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "elicitation/create",
      params: { message: "ok?", codex_call_id: "call-abc" },
    });
    expect(extractCodexCallId(parsed!)).toBe("call-abc");
  });

  test("undefined when absent or not a string", () => {
    const withoutId = parseElicitationCreateRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "elicitation/create",
      params: { message: "ok?" },
    });
    expect(extractCodexCallId(withoutId!)).toBeUndefined();

    const withWrongType = parseElicitationCreateRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "elicitation/create",
      params: { message: "ok?", codex_call_id: 123 },
    });
    expect(extractCodexCallId(withWrongType!)).toBeUndefined();
  });
});
