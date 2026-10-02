import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NOTES_MAX_TOKENS, appendTrailEntry, readSlate, writeSlate, type Slate } from "../../../session/slate";
import {
  MESSAGE_PAGE_CHARS,
  canPrefilterRaw,
  historySearchTool,
  recallStepTool,
  slateNoteTool,
  slateTrailTool,
} from "./slate-memory-tools";
import { slateReadTool } from "./slate-tool";

const ts = "2026-10-02T00:00:00.000Z";
let dir: string;
let other: string;
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-wm-tools-"));
  other = await mkdtemp(path.join(tmpdir(), "keryx-wm-other-"));
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-wm-cwd-"));
  const slate: Slate = { anchors: { root: cwd, touched: [] }, course: {}, seeds: [] };
  await writeSlate(dir, () => slate);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const get = () => dir;

async function saveOutput(sessionDir: string, name: string, text: string): Promise<string> {
  await mkdir(path.join(sessionDir, "tool-output"), { recursive: true });
  const file = path.join(sessionDir, "tool-output", name);
  await writeFile(file, text);
  return file;
}

test("slate_note sets, replaces and deletes, and reports the shelf budget", async () => {
  const tool = slateNoteTool(get, () => ts);
  const set = await tool.invoke({ key: "goal", text: "ship it" });
  expect(set.isError).toBe(false);
  expect(JSON.parse(set.output)).toMatchObject({ stored: "goal", chars: 7, shelfLimit: NOTES_MAX_TOKENS });
  await tool.invoke({ key: "goal", text: "ship it today" });
  expect((await readSlate(dir))?.notes?.goal?.text).toBe("ship it today");
  const del = await tool.invoke({ key: "goal" });
  expect(JSON.parse(del.output)).toEqual({ deleted: "goal" });
  expect((await readSlate(dir))?.notes).toEqual({});
});

test("slate_note never creates a Seed", async () => {
  await slateNoteTool(get, () => ts).invoke({ key: "a", text: "b" });
  expect((await readSlate(dir))?.seeds).toEqual([]);
});

test("slate_note redacts a secret and says when it cut the text", async () => {
  const tool = slateNoteTool(get, () => ts);
  const res = await tool.invoke({ key: "k", text: `sk-abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(5000)}` });
  expect(JSON.parse(res.output).truncated).toContain("2000");
  const stored = (await readSlate(dir))?.notes?.k?.text ?? "";
  expect(stored).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  expect(stored.length).toBeLessThanOrEqual(2000);
});

test("slate_note past the shelf cap returns a clear refusal and stores nothing more", async () => {
  const tool = slateNoteTool(get, () => ts);
  const chunk = "alpha beta gamma delta ".repeat(100);
  let refused: { output: string; isError: boolean } | undefined;
  let written = 0;
  for (let i = 0; i < 60 && refused === undefined; i += 1) {
    const r = await tool.invoke({ key: `n${i}`, text: chunk });
    if (r.isError) refused = r;
    else written += 1;
  }
  expect(refused?.output).toContain("refused");
  expect(refused?.output).toContain(String(NOTES_MAX_TOKENS));
  expect(Object.keys((await readSlate(dir))?.notes ?? {})).toHaveLength(written);
});

test("slate_note without a session or with a bad input degrades to an error result, never a throw", async () => {
  expect((await slateNoteTool(() => undefined, () => ts).invoke({ key: "a", text: "b" })).isError).toBe(true);
  expect((await slateNoteTool(get, () => ts).invoke({ key: "../x", text: "b" })).isError).toBe(true);
  expect((await slateNoteTool(get, () => ts).invoke({ text: "b" })).isError).toBe(true);
  expect((await slateNoteTool(() => other, () => ts).invoke({ key: "a", text: "b" })).isError).toBe(true);
});

test("slate_read keeps its shape and adds notes and trail only once they exist", async () => {
  const read = slateReadTool(cwd, get);
  const before = JSON.parse((await read.invoke({})).output) as Record<string, unknown>;
  expect(Object.keys(before).sort()).toEqual(["course", "seeds"].sort());
  await slateNoteTool(get, () => ts).invoke({ key: "a", text: "b" });
  await appendTrailEntry(dir, { tool: "read_file", digest: "x", outcome: "ok", ts });
  const after = JSON.parse((await read.invoke({})).output) as Record<string, unknown>;
  expect(after.notes).toEqual({ a: { text: "b", ts } });
  expect(after.trail).toMatchObject({ count: 1 });
  expect(after.seeds).toEqual(before.seeds);
  expect(after.course).toEqual(before.course);
});

test("slate_trail filters by file, tool and step range, and pages with a continuation hint", async () => {
  for (let i = 1; i <= 6; i += 1) {
    await appendTrailEntry(dir, {
      tool: i % 2 === 0 ? "read_file" : "shell_exec",
      digest: `d${i}`,
      outcome: i === 5 ? "error" : "ok",
      ts,
      files: [`/repo/src/f${i % 3}.ts`],
    });
  }
  const trail = slateTrailTool(get);
  const byFile = (await trail.invoke({ file: "f1.ts" })).output;
  expect(byFile.split("\n").map((l) => l.slice(0, 2))).toEqual(["#1", "#4"]);
  const byTool = (await trail.invoke({ tool: "read_file" })).output;
  expect(byTool).toContain("#2");
  expect(byTool).not.toContain("#1 ");
  const range = (await trail.invoke({ from_step: 2, to_step: 5, limit: 2 })).output;
  expect(range).toContain("#2");
  expect(range).toContain("#3");
  expect(range).not.toContain("#4 ");
  expect(range).toContain("from_step 4");
  const newest = (await trail.invoke({ limit: 2 })).output;
  expect(newest).toContain("#6");
  expect(newest).toContain("#5");
  expect(newest).not.toContain("#4 ");
  expect(newest).toContain("-> error");
  expect((await trail.invoke({ tool: "nope" })).output).toContain("no matching steps");
});

test("recall_step pages a saved output by line and names the next page", async () => {
  const body = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n");
  const file = await saveOutput(dir, "out.txt", body);
  await appendTrailEntry(dir, { tool: "shell_exec", digest: "ls", outcome: "ok", ts, outputPath: file });
  const recall = recallStepTool(get);
  const first = (await recall.invoke({ step: 1, line_count: 200 })).output;
  expect(first).toContain("lines 1-200 of 450");
  expect(first).toContain("line 200");
  expect(first).not.toContain("line 201");
  expect(first).toContain('"start_line":201');
  const last = (await recall.invoke({ step: 1, start_line: 401, line_count: 200 })).output;
  expect(last).toContain("lines 401-450 of 450");
  expect(last).toContain("end of output");
  const past = await recall.invoke({ step: 1, start_line: 900 });
  expect(past.isError).toBe(true);
  expect((await recall.invoke({ step: 9 })).isError).toBe(true);
});

test("recall_step refuses a path outside this session: another session, .., a symlink, and a sibling dir", async () => {
  const foreign = await saveOutput(other, "secret.txt", "FOREIGN-SECRET");
  const inside = await saveOutput(dir, "ok.txt", "fine");
  const escape = path.join(dir, "tool-output", "..", "slate.json");
  await mkdir(path.join(dir, "tool-output-evil"), { recursive: true });
  const evil = path.join(dir, "tool-output-evil", "x.txt");
  await writeFile(evil, "EVIL-SIBLING");
  const link = path.join(dir, "tool-output", "link.txt");
  await symlink(foreign, link);
  const dirLink = path.join(dir, "tool-output", "dirlink");
  await symlink(other, dirLink);

  const outputs = [foreign, escape, evil, link, path.join(dirLink, "secret.txt"), "relative/out.txt"];
  for (const outputPath of outputs) {
    await appendTrailEntry(dir, { tool: "x", digest: "x", outcome: "ok", ts, outputPath });
  }
  const recall = recallStepTool(get);
  for (let step = 1; step <= outputs.length; step += 1) {
    const res = await recall.invoke({ step });
    expect(res.isError).toBe(true);
    expect(res.output).not.toContain("FOREIGN-SECRET");
    expect(res.output).not.toContain("EVIL-SIBLING");
  }
  // control: the same tool does read a file that is inside
  await appendTrailEntry(dir, { tool: "x", digest: "x", outcome: "ok", ts, outputPath: inside });
  expect((await recall.invoke({ step: outputs.length + 1 })).output).toContain("fine");
});

test("history_search finds text in the archive, newest first, and filters by role", async () => {
  const rows = [
    { role: "user", content: "please look at the Registry file", ts: "t1" },
    { role: "assistant", content: "", ts: "t2", toolCalls: [{ id: "c", name: "read_file", arguments: '{"path":"registry.ts"}' }] },
    { role: "tool", content: "export const registry = {}", ts: "t3", trailStep: 7 },
    { role: "user", content: "unrelated", ts: "t4" },
  ];
  await writeFile(path.join(dir, "archive.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const search = historySearchTool(get);
  const all = (await search.invoke({ query: "registry" })).output.split("\n");
  // Three hits, then the line that names the call for reading one in full.
  expect(all).toHaveLength(4);
  expect(all[0]).toContain("row 3");
  expect(all[0]).toContain("step 7");
  expect(all[2]).toContain("row 1");
  expect(all[3]).toContain('history_search {"row":N}');
  const onlyUser = (await search.invoke({ query: "registry", role: "user" })).output;
  expect(onlyUser).toContain("row 1");
  expect(onlyUser).not.toContain("row 3");
  expect((await search.invoke({ query: "zzzz-none" })).output).toContain("no match");
  expect((await search.invoke({ query: "x" })).isError).toBe(true);
});

test("history_search refuses an archive that is a symlink to another session", async () => {
  await writeFile(path.join(other, "archive.jsonl"), `${JSON.stringify({ role: "user", content: "FOREIGN-SECRET", ts: "t" })}\n`);
  await symlink(path.join(other, "archive.jsonl"), path.join(dir, "archive.jsonl"));
  const res = await historySearchTool(get).invoke({ query: "FOREIGN-SECRET" });
  expect(res.isError).toBe(true);
  expect(res.output).not.toContain("FOREIGN-SECRET");
});

test("history_search redacts a secret that sits in the archive", async () => {
  const row = { role: "tool", content: "token sk-abcdefghijklmnopqrstuvwxyz0123456789 here", ts: "t" };
  await writeFile(path.join(dir, "archive.jsonl"), `${JSON.stringify(row)}\n`);
  const res = await historySearchTool(get).invoke({ query: "token" });
  expect(res.output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
});

test("the readers answer with an error, not a throw, when there is no session", async () => {
  const none = () => undefined;
  expect((await slateTrailTool(none).invoke({})).isError).toBe(true);
  expect((await recallStepTool(none).invoke({ step: 1 })).isError).toBe(true);
  expect((await historySearchTool(none).invoke({ query: "abc" })).isError).toBe(true);
});

async function writeArchive(rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(dir, "archive.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

test("history_search finds a query that holds a newline or a quote, which the raw JSON line spells as an escape", async () => {
  await writeArchive([
    { role: "user", content: "first line\nsecond line of the ask", ts: "t1" },
    { role: "user", content: 'she said "ship it today" twice', ts: "t2" },
    { role: "assistant", content: "", ts: "t3", toolCalls: [{ id: "c", name: "write_file", arguments: '{"path":"a.ts","text":"x\\ny"}' }] },
    { role: "user", content: "unrelated", ts: "t4" },
  ]);
  const search = historySearchTool(get);
  const newline = (await search.invoke({ query: "first line\nsecond" })).output;
  expect(newline).toContain("row 1");
  const quote = (await search.invoke({ query: '"ship it today"' })).output;
  expect(quote).toContain("row 2");
  // A backslash in a tool-call argument is searched in its decoded form too.
  const inCall = (await search.invoke({ query: '"text":"x\\ny"' })).output;
  expect(inCall).toContain("row 3");
  expect((await search.invoke({ query: '"ship it tomorrow"' })).output).toContain("no match");
});

test("canPrefilterRaw is false exactly for the characters a JSON line escapes", () => {
  expect(canPrefilterRaw("plain words 123")).toBe(true);
  expect(canPrefilterRaw("with'single and\u00e9")).toBe(true);
  expect(canPrefilterRaw('a "quote"')).toBe(false);
  expect(canPrefilterRaw("back\\slash")).toBe(false);
  expect(canPrefilterRaw("new\nline")).toBe(false);
  expect(canPrefilterRaw("tab\there")).toBe(false);
  expect(canPrefilterRaw("sep\u2028arator")).toBe(false);
});

test("history_search reads one message in full by row, in pages, and names the call for the next page", async () => {
  const long = `${"a".repeat(MESSAGE_PAGE_CHARS)}${"b".repeat(MESSAGE_PAGE_CHARS)}${"c".repeat(100)}`;
  await writeArchive([
    { role: "user", content: "short one", ts: "t1" },
    { role: "user", content: long, ts: "t2" },
  ]);
  const search = historySearchTool(get);
  const first = (await search.invoke({ row: 2 })).output;
  expect(first).toContain(`row 2 user t2: characters 0-${MESSAGE_PAGE_CHARS} of ${long.length}`);
  expect(first).toContain(`next page: history_search {"row":2,"offset":${MESSAGE_PAGE_CHARS}}`);
  expect(first).not.toContain("b");
  const second = (await search.invoke({ row: 2, offset: MESSAGE_PAGE_CHARS })).output;
  expect(second).toContain(`next page: history_search {"row":2,"offset":${2 * MESSAGE_PAGE_CHARS}}`);
  expect(second).toContain("b".repeat(50));
  const last = (await search.invoke({ row: 2, offset: 2 * MESSAGE_PAGE_CHARS })).output;
  expect(last).toContain("c".repeat(100));
  expect(last).toContain("(end of message)");
  // Reassembled, the pages are the whole message.
  const body = (out: string): string => out.split("\n").slice(1, -1).join("\n");
  expect(`${body(first)}${body(second)}${body(last)}`).toBe(long);
  const past = await search.invoke({ row: 2, offset: long.length + 1 });
  expect(past.isError).toBe(true);
  expect(past.output).toContain("past the end");
  expect((await search.invoke({ row: 9 })).isError).toBe(true);
});

test("history_search recalls a message by its timestamp and role, exactly as the clip notice names it", async () => {
  const stamp = "2026-10-02T09:00:01.000Z";
  await writeArchive([
    { role: "assistant", content: "an answer with the same time", ts: stamp },
    { role: "user", content: "the ask that was clipped ".repeat(200), ts: stamp },
    { role: "user", content: "later", ts: "2026-10-02T09:00:02.000Z" },
  ]);
  const search = historySearchTool(get);
  // The assistant row comes first in the archive: the role filter is what selects the operator's message.
  const user = (await search.invoke({ ts: stamp, role: "user" })).output;
  expect(user).toContain("row 2 user");
  expect(user).toContain("the ask that was clipped");
  expect(user).not.toContain("an answer with the same time");
  const both = (await search.invoke({ ts: stamp })).output;
  expect(both).toContain("row 1 assistant");
  expect(both).toContain("1 more message(s) share this timestamp: rows 2");
  expect((await search.invoke({ ts: "2000-01-01T00:00:00.000Z" })).isError).toBe(true);
});

test("history_search needs a query or a row or a ts", async () => {
  await writeArchive([{ role: "user", content: "x", ts: "t" }]);
  expect((await historySearchTool(get).invoke({})).isError).toBe(true);
});
