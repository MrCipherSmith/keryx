import { expect, test } from "bun:test";
import {
  ACP_DEFAULT_MAX_LINE_BYTES,
  ACP_MESSAGE_DELIMITER,
  AcpFramingError,
  AcpLineFramer,
  decodeAcpLine,
  encodeAcpMessage,
} from "./framing";
import { JSON_RPC_ERROR_CODES, notificationMessage, requestMessage } from "./jsonrpc";

test("ACP frames with a newline and not with a Content-Length header", () => {
  const line = encodeAcpMessage(requestMessage(1, "initialize", { protocolVersion: 1 }));

  expect(line.endsWith(ACP_MESSAGE_DELIMITER)).toBe(true);
  expect(ACP_MESSAGE_DELIMITER).toBe("\n");
  expect(line).not.toContain("Content-Length");
  expect(line.slice(0, -1)).toBe(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}',
  );
});

test("a message round-trips through encode and the framer unchanged", () => {
  const message = requestMessage("req-7", "session/prompt", {
    sessionId: "s1",
    prompt: [{ type: "text", text: "hello" }],
  });

  const framer = new AcpLineFramer();
  const lines = framer.push(encodeAcpMessage(message));

  expect(lines.length).toBe(1);
  const decoded = decodeAcpLine(lines[0] ?? "");
  expect(decoded.ok).toBe(true);
  expect(decoded.ok ? decoded.value : undefined).toEqual(message);
});

// A pipe hands over bytes, not messages. This is the read boundary that breaks
// every decoder which assumes one chunk is one message.
test("a message split across three reads yields nothing until the delimiter arrives", () => {
  const framer = new AcpLineFramer();
  const line = encodeAcpMessage(notificationMessage("session/cancel", { sessionId: "s1" }));

  const head = line.slice(0, 10);
  const middle = line.slice(10, 25);
  const tail = line.slice(25);

  expect(framer.push(head)).toEqual([]);
  expect(framer.push(middle)).toEqual([]);
  expect(framer.buffered).toBeGreaterThan(0);

  const lines = framer.push(tail);
  expect(lines.length).toBe(1);
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s1" },
  });
  expect(framer.buffered).toBe(0);
});

test("two messages in one read come back as two lines, in order", () => {
  const framer = new AcpLineFramer();
  const chunk =
    encodeAcpMessage(requestMessage(1, "session/new", { cwd: "/repo", mcpServers: [] })) +
    encodeAcpMessage(requestMessage(2, "session/list", {}));

  const lines = framer.push(chunk);

  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0] ?? "").id).toBe(1);
  expect(JSON.parse(lines[1] ?? "").id).toBe(2);
});

test("a read that ends mid-message leaves exactly the remainder buffered", () => {
  const framer = new AcpLineFramer();
  const first = encodeAcpMessage(requestMessage(1, "session/list", {}));
  const second = encodeAcpMessage(requestMessage(2, "session/list", {}));

  const lines = framer.push(first + second.slice(0, 12));
  expect(lines.length).toBe(1);
  expect(framer.buffered).toBe(12);

  expect(framer.push(second.slice(12)).length).toBe(1);
  expect(framer.buffered).toBe(0);
});

// Without a streaming decoder a character straddling a read boundary becomes
// U+FFFD and the text silently changes. That is worse than a parse error.
test("a multi-byte character split across two byte reads is not corrupted", () => {
  const framer = new AcpLineFramer();
  const bytes = new TextEncoder().encode(
    encodeAcpMessage(notificationMessage("session/update", { text: "привет 🌍" })),
  );
  // Two bytes into the four-byte emoji: the worst place a read can end.
  const cut = bytes.length - 6;

  expect(framer.push(bytes.slice(0, cut))).toEqual([]);
  const lines = framer.push(bytes.slice(cut));

  expect(lines.length).toBe(1);
  expect(JSON.parse(lines[0] ?? "").params.text).toBe("привет 🌍");
});

test("blank lines and carriage returns are absorbed rather than reported", () => {
  const framer = new AcpLineFramer();
  const lines = framer.push(`\n\n{"jsonrpc":"2.0","method":"ping"}\r\n\n`);

  expect(lines).toEqual(['{"jsonrpc":"2.0","method":"ping"}']);
});

test("flush returns a final message written without a trailing newline", () => {
  const framer = new AcpLineFramer();
  expect(framer.push('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual([]);

  expect(framer.flush()).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  expect(framer.flush()).toEqual([]);
});

test("a peer that never sends a delimiter is cut off instead of growing the buffer", () => {
  const framer = new AcpLineFramer({ maxLineBytes: 64 });

  expect(() => framer.push("x".repeat(65))).toThrow(AcpFramingError);
  // The buffer is dropped, so the framer stays usable for the next message.
  expect(framer.buffered).toBe(0);
  expect(framer.push('{"jsonrpc":"2.0","method":"ping"}\n')).toEqual([
    '{"jsonrpc":"2.0","method":"ping"}',
  ]);
  expect(ACP_DEFAULT_MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
});

test("encoding refuses a message that does not serialise to JSON at all", () => {
  const unserialisable = { jsonrpc: "2.0", method: "x", toJSON: () => undefined } as never;
  expect(() => encodeAcpMessage(unserialisable)).toThrow(AcpFramingError);
});

test("a newline inside a string is escaped, so it never splits a frame", () => {
  const line = encodeAcpMessage(notificationMessage("session/update", { text: "a\nb" }));

  expect(line.split("\n").length).toBe(2);
  const framer = new AcpLineFramer();
  const lines = framer.push(line);
  expect(JSON.parse(lines[0] ?? "").params.text).toBe("a\nb");
});

test("malformed JSON decodes to a parse error rather than throwing", () => {
  const decoded = decodeAcpLine("{not json");

  expect(decoded.ok).toBe(false);
  expect(decoded.ok ? undefined : decoded.error.code).toBe(JSON_RPC_ERROR_CODES.parseError);
  expect(decoded.ok ? undefined : decoded.error.message).toBe("Parse error");
});
