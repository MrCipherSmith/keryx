import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedMessage, NormalizedToolCall } from "../harness/provider/types";
import { compactMessages } from "./compact";
import {
  COLLAPSED_HEADER,
  argDigest,
  isClearedToolResult,
  parseCollapsedRecord,
  planPrune,
  pruneToolOutputs,
} from "./prune";

// Flow 387 T18: old tool exchanges collapse into one assistant text record.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "prune-collapse-"));
  dirs.push(d);
  return d;
}

function user(content: string): NormalizedMessage {
  return { role: "user", content, provenance: "trusted" };
}
function call(id: string, name = "read_file", args = `{"path":"src/${id}.ts"}`): NormalizedToolCall {
  return { id, name, arguments: args };
}
function exchange(
  calls: NormalizedToolCall[],
  chars: number,
  extra: Partial<NormalizedMessage> = {},
): NormalizedMessage[] {
  return [
    { role: "assistant", content: "", provenance: "model", toolCalls: calls, ...extra },
    ...calls.map(
      (c): NormalizedMessage => ({
        role: "tool",
        content: `${c.id}:`.padEnd(chars, "x"),
        provenance: "tool",
        toolCallId: c.id,
      }),
    ),
  ];
}
/** `count` single-call exchanges of 10K tokens each after one operator message. */
function session(count: number): NormalizedMessage[] {
  const h: NormalizedMessage[] = [user("continue")];
  for (let i = 0; i < count; i++) {
    h.push(...exchange([call(`c${i}`)], 40_000));
  }
  return h;
}
/** Every tool message has its call earlier, and every call has its result right after. */
function expectPaired(history: readonly NormalizedMessage[]): void {
  const open = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      expect(open.size).toBe(0);
      for (const c of m.toolCalls) open.add(c.id);
    } else if (m.role === "tool") {
      expect(open.delete(m.toolCallId ?? "")).toBe(true);
    } else {
      expect(open.size).toBe(0);
    }
  }
  expect(open.size).toBe(0);
}

test("collapses old exchanges into one text record per exchange, keeps the newest 40K structured", async () => {
  const sessionDir = tmp();
  const history = session(12); // newest 4 results fill the window
  const result = await pruneToolOutputs(history, { sessionDir });
  expect(result.collapsed).toBe(8);
  expect(result.pruned).toBe(8);
  expect(history.length).toBe(1 + 8 + 4 * 2);
  expect(history[0]?.content).toBe("continue");
  const records = history.filter((m) => parseCollapsedRecord(m).length > 0);
  expect(records.length).toBe(8);
  for (const r of records) {
    expect(r.role).toBe("assistant");
    expect(r.toolCalls).toBeUndefined();
    expect(r.reasoning).toBeUndefined();
  }
  const first = records[0] as NormalizedMessage;
  const file = path.join(sessionDir, "tool-output", "c0.txt");
  expect(first.content).toBe(`${COLLAPSED_HEADER}\nread_file(src/c0.ts) → ok, full output: ${file}`);
  expect(readFileSync(file, "utf8").startsWith("c0:")).toBe(true);
  // The protected window is untouched and still structured.
  const tail = history.slice(-8);
  expect(tail.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["c8", "c9", "c10", "c11"]);
  expect(tail.some(isClearedToolResult)).toBe(false);
  expectPaired(history);
});

test("the assistant's own text stays first; reasoning and arguments are dropped", async () => {
  const history: NormalizedMessage[] = [user("go")];
  history.push(
    ...exchange([call("a")], 40_000, {
      content: "Reading the file first.",
      reasoning: { replay: [{ providerId: "openai-codex", kind: "encrypted_content", data: "Z".repeat(50_000) }] },
    }),
  );
  for (let i = 0; i < 5; i++) history.push(...exchange([call(`n${i}`)], 40_000));
  await pruneToolOutputs(history, { sessionDir: undefined });
  const record = history[1] as NormalizedMessage;
  expect(record.content).toBe(`Reading the file first.\n${COLLAPSED_HEADER}\nread_file(src/a.ts) → ok`);
  expect(record.reasoning).toBeUndefined();
  expect(record.toolCalls).toBeUndefined();
});

test("a parallel exchange is collapsed whole: one line per call, error status from isError", async () => {
  const history: NormalizedMessage[] = [user("go")];
  const group = exchange([call("p1"), call("p2", "shell_exec", `{"command":"bun test"}`)], 40_000);
  (group[2] as NormalizedMessage).isError = true;
  history.push(...group);
  for (let i = 0; i < 5; i++) history.push(...exchange([call(`n${i}`)], 40_000));
  await pruneToolOutputs(history, { sessionDir: undefined });
  expect((history[1] as NormalizedMessage).content).toBe(
    `${COLLAPSED_HEADER}\nread_file(src/p1.ts) → ok\nshell_exec(bun test) → error`,
  );
  expectPaired(history);
});

test("an exchange with a result inside the protected window is never split", async () => {
  const history: NormalizedMessage[] = [user("go")];
  for (let i = 0; i < 4; i++) history.push(...exchange([call(`o${i}`)], 40_000));
  // Parallel group whose FIRST result is outside the window and second inside it.
  history.push(...exchange([call("x1"), call("x2")], 40_000));
  for (let i = 0; i < 2; i++) history.push(...exchange([call(`n${i}`)], 40_000));
  const plan = planPrune(history);
  expect(plan.groups.some((g) => history[g.start]?.toolCalls?.some((c) => c.id === "x1"))).toBe(false);
  await pruneToolOutputs(history, { sessionDir: undefined });
  const x = history.find((m) => m.toolCalls?.some((c) => c.id === "x1"));
  expect(x?.toolCalls?.map((c) => c.id)).toEqual(["x1", "x2"]);
  expectPaired(history);
});

test("is idempotent and never re-collapses a record", async () => {
  const history = session(12);
  await pruneToolOutputs(history, { sessionDir: undefined });
  const snapshot = history.map((m) => m.content);
  expect(await pruneToolOutputs(history, { sessionDir: undefined })).toEqual({
    pruned: 0,
    collapsed: 0,
    savedTokens: 0,
  });
  expect(history.map((m) => m.content)).toEqual(snapshot);
});

test("does nothing below the 20K saving threshold", async () => {
  const history = session(5); // only 1 exchange outside the window: ~10K
  expect((await pruneToolOutputs(history, { sessionDir: undefined })).collapsed).toBe(0);
  expect(history.length).toBe(11);
});

test("archive keeps the original calls and results", async () => {
  const history = session(12);
  const archive = [...history];
  const originals = archive.map((m) => ({ ...m }));
  await pruneToolOutputs(history, { sessionDir: tmp() });
  expect(archive.map((m) => m.content)).toEqual(originals.map((m) => m.content));
  expect(archive.filter((m) => m.toolCalls !== undefined).length).toBe(12);
});

test("beforeApply runs once, only when something is shrunk", async () => {
  let calls = 0;
  await pruneToolOutputs(session(3), { sessionDir: undefined, beforeApply: () => calls++ });
  expect(calls).toBe(0);
  await pruneToolOutputs(session(12), { sessionDir: undefined, beforeApply: () => calls++ });
  expect(calls).toBe(1);
});

test("compaction still extracts files read and modified from collapsed records", async () => {
  const patch = "--- a/src/old.ts\n+++ b/src/old.ts\n@@\n-a\n+b\n";
  const history: NormalizedMessage[] = [user("one")];
  history.push(...exchange([call("r1", "read_file", `{"path":"src/read-me.ts"}`)], 40_000));
  history.push(...exchange([call("w1", "apply_patch", JSON.stringify({ patch }))], 40_000));
  for (let i = 0; i < 6; i++) history.push(...exchange([call(`n${i}`)], 40_000));
  await pruneToolOutputs(history, { sessionDir: undefined });
  history.push(user("two"), user("three"), user("four"));
  const r = compactMessages(history, { keepLastUserTurns: 1 });
  expect(r.summaryText).toContain("Files read: src/read-me.ts");
  expect(r.summaryText).toContain("Files modified: src/old.ts");
});

test("argument digests", () => {
  expect(argDigest("read_file", `{"path":"src/a.ts","start_line":3}`)).toBe("src/a.ts");
  expect(argDigest("search_code", `{"pattern":"foo.*bar","path":"src"}`)).toBe("src | pattern=foo.*bar");
  expect(argDigest("search_code", `{"pattern":"foo"}`)).toBe("pattern=foo");
  const patch = "--- a/x.ts\n+++ b/x.ts\n@@\n--- a/y.ts\n+++ b/y.ts\n";
  expect(argDigest("apply_patch", JSON.stringify({ patch }))).toBe("x.ts, y.ts");
  const long = `echo ${"a".repeat(200)}`;
  const shell = argDigest("shell_exec", JSON.stringify({ command: long }));
  expect(shell.length).toBe(80);
  expect(shell.startsWith("echo aaa")).toBe(true);
  expect(argDigest("custom", `{"k":"${"v".repeat(200)}"}`).length).toBe(80);
  // deterministic
  expect(argDigest("custom", `{"k":1}`)).toBe(argDigest("custom", `{"k":1}`));
});
