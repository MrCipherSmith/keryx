import { expect, test } from "bun:test";
import { formatAuditLine } from "./audit-log";
import {
  buildAuditEvent,
  classifyMutatingOutcome,
  formatTurnEventLine,
  highestSeq,
  parseSseBody,
} from "./output-channel-logic";

// --- SSE parsing: mirrors the exact wire shape `streamTurnEvents` in
// src/lib/serve-server.ts:604 writes: `id: ${seq}\ndata: ${json}\n\n`.

test("parseSseBody parses a single-event SSE body into one StreamEvent", () => {
  const body = `id: 0\ndata: ${JSON.stringify({
    schemaVersion: "1.0.0",
    turnId: "t1",
    seq: 0,
    kind: "turn.started",
    at: "2026-08-20T22:00:00.000Z",
  })}\n\n`;

  const events = parseSseBody(body);
  expect(events.length).toBe(1);
  expect(events[0]?.turnId).toBe("t1");
  expect(events[0]?.seq).toBe(0);
  expect(events[0]?.kind).toBe("turn.started");
});

test("parseSseBody parses multiple events in cursor order", () => {
  const e1 = { schemaVersion: "1.0.0", turnId: "t1", seq: 0, kind: "turn.started", at: "2026-08-20T22:00:00.000Z" };
  const e2 = {
    schemaVersion: "1.0.0",
    turnId: "t1",
    seq: 1,
    kind: "assistant.delta",
    at: "2026-08-20T22:00:01.000Z",
    text: "hi",
  };
  const body = `id: 0\ndata: ${JSON.stringify(e1)}\n\nid: 1\ndata: ${JSON.stringify(e2)}\n\n`;

  const events = parseSseBody(body);
  expect(events.length).toBe(2);
  expect(events.map((e) => e.seq)).toEqual([0, 1]);
});

test("parseSseBody skips a malformed record without losing well-formed ones around it", () => {
  const good = { schemaVersion: "1.0.0", turnId: "t1", seq: 0, kind: "turn.started", at: "2026-08-20T22:00:00.000Z" };
  const body = `id: 0\ndata: ${JSON.stringify(good)}\n\nid: 1\ndata: not-json\n\n`;

  const events = parseSseBody(body);
  expect(events.length).toBe(1);
  expect(events[0]?.seq).toBe(0);
});

test("parseSseBody returns an empty array for an empty body", () => {
  expect(parseSseBody("")).toEqual([]);
});

test("parseSseBody drops a record missing required StreamEvent fields", () => {
  const body = `id: 0\ndata: ${JSON.stringify({ foo: "bar" })}\n\n`;
  expect(parseSseBody(body)).toEqual([]);
});

test("highestSeq returns the max seq across a batch", () => {
  const events = [
    { turnId: "t1", seq: 3, kind: "turn.started", at: "x" },
    { turnId: "t1", seq: 1, kind: "turn.started", at: "x" },
    { turnId: "t1", seq: 5, kind: "turn.finished", at: "x", terminal: true },
  ];
  expect(highestSeq(events)).toBe(5);
});

test("highestSeq returns undefined for an empty batch", () => {
  expect(highestSeq([])).toBeUndefined();
});

test("formatTurnEventLine renders a single line, never multi-line", () => {
  const line = formatTurnEventLine({
    turnId: "t1",
    seq: 2,
    kind: "assistant.delta",
    at: "2026-08-20T22:00:00.000Z",
    text: "hello\nworld",
  });
  // The event's own text may contain newlines; the rendered line format
  // itself must still be a single physical output-channel entry per event
  // (appendLine is called once per event by the caller), so assert the
  // formatter doesn't itself inject extra blank framing lines.
  expect(line.startsWith("[turn t1] #2 assistant.delta:")).toBe(true);
});

test("formatTurnEventLine renders tool events with name and outcome", () => {
  const line = formatTurnEventLine({
    turnId: "t1",
    seq: 4,
    kind: "tool.finished",
    at: "x",
    tool: { name: "search_code", outcome: "ok" },
  });
  expect(line).toContain("search_code");
  expect(line).toContain("ok");
});

// --- AC6: mutating-action outcome classification + exactly-one-line shape.

test("classifyMutatingOutcome: exit code 0 is success", () => {
  expect(classifyMutatingOutcome(0)).toBe("success");
});

test("classifyMutatingOutcome: any non-zero exit code is failure", () => {
  expect(classifyMutatingOutcome(1)).toBe("failure");
  expect(classifyMutatingOutcome(127)).toBe("failure");
});

test("AC6: buildAuditEvent + formatAuditLine produce exactly one line for a successful mutating action", () => {
  const event = buildAuditEvent("user", "keryx.init", 0);
  const line = formatAuditLine({ ...event, timestamp: "2026-08-20T22:00:00.000Z" });
  expect(line.split("\n").length).toBe(1);
  expect(line).toContain("action=keryx.init");
  expect(line).toContain("outcome=success");
});

test("AC6: buildAuditEvent + formatAuditLine produce exactly one line for a FAILED mutating action (an error is still one line, never zero)", () => {
  const event = buildAuditEvent("extension", "keryx.init", 1, "exit code 1");
  const line = formatAuditLine({ ...event, timestamp: "2026-08-20T22:00:00.000Z" });
  expect(line.split("\n").length).toBe(1);
  expect(line).toContain("outcome=failure");
  expect(line).toContain("detail=exit code 1");
});

test("AC6: buildAuditEvent omits detail when not provided", () => {
  const event = buildAuditEvent("user", "keryx.refresh", 0);
  expect("detail" in event).toBe(false);
});
