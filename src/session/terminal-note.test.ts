// Flow 523 review R2-AR-003: the one grammar of a Run's result note, shared by the ACP producer and
// parser and by compaction. The producer's own tests are `src/acp/terminal-result.test.ts`.

import { describe, expect, test } from "bun:test";
import type { NormalizedMessage } from "../harness/provider/types";
import { parseTerminalNoteHeadLine, storedTerminalNoteHead, TERMINAL_RUN_ID, terminalNoteHeadLine, type TerminalRunOutcome } from "./terminal-note";

describe("the head line", () => {
  const outcomes: ReadonlyArray<readonly [TerminalRunOutcome, string]> = [
    [{ state: "exited", exitCode: 0 }, "[terminal run run-1 result: exit 0]"],
    [{ state: "exited", exitCode: -1 }, "[terminal run run-1 result: exit -1]"],
    [{ state: "exited", exitCode: null }, "[terminal run run-1 result: ended by a signal]"],
    [{ state: "running" }, "[terminal run run-1 result: still running]"],
  ];
  for (const [outcome, line] of outcomes) {
    test(`${line} is written and read back`, () => {
      expect(terminalNoteHeadLine("run-1", outcome)).toBe(line);
      expect(parseTerminalNoteHeadLine(line)).toEqual({ runId: "run-1", outcome });
    });
  }

  test("any other line is not a head line", () => {
    for (const line of [
      "",
      "[terminal run run-1 result: exit 0] and more",
      " [terminal run run-1 result: exit 0]",
      "[terminal run run 1 result: exit 0]",
      `[terminal run ${"r".repeat(65)} result: exit 0]`,
      "[terminal run run-1 result: exit]",
      "[terminal run run-1 result: done]",
      "[terminal run run-1 result: exit 99999999999999999999]",
    ]) {
      expect(parseTerminalNoteHeadLine(line)).toBeUndefined();
    }
  });

  test("the run-id pattern is the contract's: 1 to 64 of A-Z, a-z, 0-9, _ and -", () => {
    expect(TERMINAL_RUN_ID.test("r_1-A")).toBe(true);
    expect(TERMINAL_RUN_ID.test("r".repeat(64))).toBe(true);
    expect(TERMINAL_RUN_ID.test("r".repeat(65))).toBe(false);
    expect(TERMINAL_RUN_ID.test("")).toBe(false);
    expect(TERMINAL_RUN_ID.test("run/1")).toBe(false);
  });
});

describe("storedTerminalNoteHead", () => {
  const content = `${terminalNoteHeadLine("run-1", { state: "exited", exitCode: 2 })}\nUNTRUSTED…`;
  test("an injected harness user message whose first line is a head line", () => {
    expect(storedTerminalNoteHead({ role: "user", content, provenance: "harness", injected: true })).toEqual({ runId: "run-1", outcome: { state: "exited", exitCode: 2 } });
  });

  test("not a message the operator typed, a harness line that is not injected, another role, or a head line further down", () => {
    const others: NormalizedMessage[] = [
      { role: "user", content, provenance: "project" },
      { role: "user", content, provenance: "harness" },
      { role: "assistant", content, provenance: "model" },
      { role: "user", content: `hint\n${content}`, provenance: "harness", injected: true },
    ];
    for (const message of others) expect(storedTerminalNoteHead(message)).toBeUndefined();
    expect(storedTerminalNoteHead(undefined)).toBeUndefined();
  });
});
