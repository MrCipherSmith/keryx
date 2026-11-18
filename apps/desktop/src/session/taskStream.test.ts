import { describe, expect, test } from "bun:test";
import { TASKS_OUTPUT } from "../acp/providers";
import { toTerminalText } from "../panels/streamTabs";
import { taskOutputSource } from "./taskStream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("taskOutputSource", () => {
  test("reads from the cursor keryx returns, shows gaps, and ends when the task finishes", async () => {
    const replies = [
      { output: "line 1\n", nextCursor: 7, status: "running" },
      { output: "line 2\n", nextCursor: 14, status: "running", missed: true },
      { output: "", nextCursor: 14, status: "completed" },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const request = async <T,>(method: string, params?: unknown): Promise<T> => {
      expect(method).toBe(TASKS_OUTPUT);
      calls.push(params as Record<string, unknown>);
      return replies.shift() as T;
    };
    let text = "";
    let ended: string | null = null;
    const stop = taskOutputSource(request, "s1", "task-1", 5)(
      (t) => (text += t),
      (note) => (ended = note),
    );
    for (let i = 0; i < 40 && ended === null; i++) await sleep(5);
    stop();
    expect(ended).toBe("task completed");
    expect(text).toBe("line 1\n\n[output skipped here]\nline 2\n");
    expect(calls[0]).toEqual({ sessionId: "s1", taskId: "task-1" });
    expect(calls[1]).toEqual({ sessionId: "s1", taskId: "task-1", since: 7 });
    expect(calls[2]?.since).toBe(14);
  });

  test("stops polling once the tab closes", async () => {
    let n = 0;
    const request = async <T,>(): Promise<T> => {
      n += 1;
      return { output: "", nextCursor: n, status: "running" } as T;
    };
    const stop = taskOutputSource(request, "s1", "t", 5)(() => {}, () => {});
    await sleep(30);
    stop();
    const at = n;
    await sleep(30);
    expect(n).toBe(at);
  });
});

describe("toTerminalText", () => {
  test("bare and CRLF newlines both become CRLF", () => {
    expect(toTerminalText("a\nb\r\nc")).toBe("a\r\nb\r\nc");
  });
});
