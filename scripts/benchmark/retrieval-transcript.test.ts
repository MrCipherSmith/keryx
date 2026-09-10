import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTranscript } from "./retrieval-transcript";

describe("writeTranscript", () => {
  test("writes the stream and creates the directory it needs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "transcript-test-"));
    try {
      const file = path.join(root, "nested", "t1-x-keryx-shell-context-on.jsonl");
      writeTranscript(file, '{"type":"turn_start"}\n');
      expect(readFileSync(file, "utf8")).toBe('{"type":"turn_start"}\n');
      // No stderr, no sibling file: an empty one would read as "stderr was captured and was empty".
      expect(existsSync(`${file}.stderr`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps stderr beside the stream when there was any", () => {
    const root = mkdtempSync(path.join(tmpdir(), "transcript-test-"));
    try {
      const file = path.join(root, "arm.jsonl");
      writeTranscript(file, "", "Unknown shell argument: --nope\n");
      expect(readFileSync(`${file}.stderr`, "utf8")).toContain("Unknown shell argument");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is a no-op without a destination, so callers outside the arena are unchanged", () => {
    expect(() => writeTranscript(undefined, "anything", "anything")).not.toThrow();
  });
});
