// The wire format both ends share: SSE framing and the structural id shapes.

import { describe, expect, test } from "bun:test";
import {
  approvalCallbackData,
  encodeSseEvent,
  isApprovalId,
  isSessionId,
  parseApprovalCallback,
  SSE_KEEPALIVE_FRAME,
  SseParser,
} from "./protocol";

describe("SSE framing", () => {
  test("an encoded event parses back, id included", () => {
    const frame = encodeSseEvent("inbound", { updateId: 7, text: "hello\nworld" }, 7);
    expect(frame).toBe(`event: inbound\nid: 7\ndata: ${JSON.stringify({ updateId: 7, text: "hello\nworld" })}\n\n`);
    const parsed = new SseParser().push(frame);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.event).toBe("inbound");
    expect(parsed[0]?.id).toBe("7");
    expect(JSON.parse(parsed[0]?.data ?? "")).toEqual({ updateId: 7, text: "hello\nworld" });
  });

  test("an event with no id has none, and a newline in the payload never splits a frame", () => {
    const frame = encodeSseEvent("status", { kind: "ready" });
    expect(frame).not.toContain("id:");
    expect(encodeSseEvent("inbound", { text: "a\n\nb" }, 1).split("\n\n")).toHaveLength(2);
  });

  test("frames split across arbitrary chunks come out whole, in order", () => {
    const whole = encodeSseEvent("inbound", { n: 1 }, 1) + SSE_KEEPALIVE_FRAME + encodeSseEvent("inbound", { n: 2 }, 2);
    for (const size of [1, 2, 3, 5, 8, 13, whole.length]) {
      const parser = new SseParser();
      const got = [];
      for (let at = 0; at < whole.length; at += size) {
        got.push(...parser.push(whole.slice(at, at + size)));
      }
      expect({ size, ids: got.map((frame) => frame.id) }).toEqual({ size, ids: ["1", "2"] });
    }
  });

  test("comments and data-less frames are dropped", () => {
    const parser = new SseParser();
    expect(parser.push(SSE_KEEPALIVE_FRAME)).toEqual([]);
    expect(parser.push("event: status\n\n")).toEqual([]);
  });

  test("CRLF line endings are accepted", () => {
    const frames = new SseParser().push('event: approval\r\nid: 9\r\ndata: {"a":1}\r\n\r\n');
    expect(frames).toEqual([{ event: "approval", id: "9", data: '{"a":1}' }]);
  });

  test("a frame with no event name is a plain message, and multiple data lines are joined", () => {
    expect(new SseParser().push("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  test("a half frame waits for its end", () => {
    const parser = new SseParser();
    expect(parser.push("event: inbound\ndata: {")).toEqual([]);
    expect(parser.push('"x":1}\n\n')).toHaveLength(1);
  });
});

describe("structural ids", () => {
  test("a session id is a short token of a closed alphabet", () => {
    for (const good of ["a", "sess-1", "A_b-9", "x".repeat(64)]) {
      expect({ good, ok: isSessionId(good) }).toEqual({ good, ok: true });
    }
    for (const bad of ["", "-lead", "_lead", "x".repeat(65), "a b", "a/b", "..", "../x", "a.b", "a:b", "a\nb", "a?b", "a%2fb", "é", 5, undefined, null, {}]) {
      expect({ bad, ok: isSessionId(bad) }).toEqual({ bad, ok: false });
    }
  });

  test("an approval id is exactly 'ap' and twelve lowercase hex characters", () => {
    expect(isApprovalId("ap0123456789ab")).toBe(true);
    for (const bad of ["ap0123456789a", "ap0123456789abc", "AP0123456789ab", "ap0123456789AB", "xx0123456789ab", "ap0123456789ag", "ap:0123456789ab", ""]) {
      expect({ bad, ok: isApprovalId(bad) }).toEqual({ bad, ok: false });
    }
  });

  test("approval callback data round-trips and rejects everything near it", () => {
    const data = approvalCallbackData("ap0123456789ab", "allow");
    expect(data).toBe("ap:ap0123456789ab:allow");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseApprovalCallback(data)).toEqual({ approvalId: "ap0123456789ab", decision: "allow" });
    expect(parseApprovalCallback("ap:ap0123456789ab:deny")?.decision).toBe("deny");
    for (const bad of ["ap:ap0123456789ab:maybe", "ap:ap0123456789ab:allow:x", "x ap:ap0123456789ab:allow", "ap:bad:allow", "ap::allow", "choice:yes", "AP:ap0123456789ab:allow"]) {
      expect({ bad, parsed: parseApprovalCallback(bad) }).toEqual({ bad, parsed: undefined });
    }
  });
});
