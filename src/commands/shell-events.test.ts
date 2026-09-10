import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clip, createFileEventSink, FIELD_LIMIT, serializeShellEvent } from "./shell-events";

describe("serializeShellEvent", () => {
  test("one NDJSON object per line", () => {
    const line = serializeShellEvent({ type: "assistant", text: "src/a.ts" });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({ type: "assistant", text: "src/a.ts" });
  });

  test("a credential in a tool result never reaches the file", () => {
    // This file records shell commands and their output. A contained `cat
    // ~/.aws/credentials` or `env` puts a live secret in the stream, and this
    // programme has already had one credential reach an artifact in the clear
    // because a second producer skipped the redaction floor.
    const line = serializeShellEvent({
      type: "tool_result",
      name: "shell_exec",
      isError: false,
      output: "aws_secret_access_key = Kq3nZ8vTt1cLpR7yWx0bA5dGf2HjMn6QsUv9Ye4Z",
    });
    expect(line).not.toContain("Kq3nZ8vTt1cLpR7yWx0bA5dGf2HjMn6QsUv9Ye4Z");
  });

  test("a secret cannot survive by sitting past the truncation point", () => {
    // Redaction runs BEFORE clipping. The other order looks identical on short
    // values and leaks on long ones, which is the case that actually occurs:
    // a secret is usually somewhere in the middle of a large file dump.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const line = serializeShellEvent({
      type: "tool_result",
      name: "read_file",
      isError: false,
      output: `${"x".repeat(FIELD_LIMIT * 2)}${secret}`,
    });
    expect(line).not.toContain(secret);
  });

  test("truncation is marked, not silent", () => {
    // A clipped string that looks whole is the same defect as a failed search
    // that reports success: the reader cannot tell a short answer from a cut one.
    const clipped = clip("y".repeat(FIELD_LIMIT + 50));
    expect(clipped).toContain("[+50 chars]");
    expect(clip("short")).toBe("short");
  });

  test("usage passes through unredacted — it is numbers", () => {
    const line = serializeShellEvent({ type: "usage", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(JSON.parse(line.trim())).toEqual({ type: "usage", usage: { inputTokens: 12, outputTokens: 3 } });
  });
});

describe("createFileEventSink", () => {
  test("appends as events happen, so a killed session keeps what it produced", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-events-"));
    const file = path.join(dir, "events.jsonl");
    const sink = createFileEventSink(file);
    sink.emit({ type: "turn_start", prompt: "find it", provider: "grok", model: "grok-4.6" });
    // Read BEFORE the second event: buffering to the end would lose everything
    // a session produced before it was killed.
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    sink.emit({ type: "turn_end", text: "src/a.ts", toolCalls: 2, usage: { inputTokens: 10 } });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines.map((l) => l.type)).toEqual(["turn_start", "turn_end"]);
  });

  test("a write failure is reported once and never takes the session down", () => {
    // Losing the observation of a session is not a reason to lose the session.
    // But it is not silent either: a reader of an empty file learns why.
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-events-"));
    const blocked = path.join(dir, "occupied");
    writeFileSync(blocked, "", "utf8");
    const target = path.join(blocked, "events.jsonl"); // a file used as a directory
    const reported: string[] = [];
    const sink = createFileEventSink(target, (message) => reported.push(message));
    expect(() => sink.emit({ type: "assistant", text: "x" })).not.toThrow();
    expect(() => sink.emit({ type: "assistant", text: "y" })).not.toThrow();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("no further events will be recorded");
  });
});
