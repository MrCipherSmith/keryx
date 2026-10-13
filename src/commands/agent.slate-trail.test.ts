// Flow 393 AC1 / AC8: the loop, not the model, records the Trail, and only on hosts that opted in
// to working memory (pruneArchive + a handler + an open slate the session still holds).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import { runAgentTurn } from "./agent";
import { callRound, collectingIo, makeDeps, okReply, scriptedProvider } from "./agent.test-helpers";
import type { NormalizedMessage } from "../harness/provider/types";
import {
  historySearchTool,
  recallStepTool,
  slateNoteTool,
  slateTrailTool,
} from "../harness/tool/builtin/slate-memory-tools";
import { readSlate, writeSlate, type Slate } from "../session/slate";
import { detachSlateSession, type SlateSessionRef } from "../session/slate-lifecycle";

let dir: string;
let work: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-trail-session-"));
  work = await mkdtemp(path.join(tmpdir(), "keryx-trail-work-"));
  await writeFile(path.join(work, "a.txt"), "alpha\nbeta\n");
  const empty: Slate = { anchors: { root: work, touched: [] }, course: {}, seeds: [] };
  await writeSlate(dir, () => empty);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const readCall = (id: string) => callRound(id, "read_file", JSON.stringify({ path: "a.txt" }));

async function run(options: { pruneArchive?: boolean; handler?: boolean; ref?: SlateSessionRef }) {
  const { provider } = scriptedProvider([readCall("c1"), callRound("c2", "get_cwd", "{}"), okReply]);
  const history: NormalizedMessage[] = [];
  const slateSession = options.ref ?? { dir, cwd: work, opened: true };
  await runAgentTurn(
    collectingIo().io,
    makeDeps(provider, {
      tools: builtinReadOnlyTools(work),
      ...(options.handler === false ? {} : { onContextCompaction: () => {} }),
    }),
    history,
    "go",
    { slateSession, ...(options.pruneArchive === true ? { pruneArchive: true } : {}) },
  );
  return history;
}

test("a working-memory host records one Trail entry per executed call and tags the tool messages", async () => {
  const history = await run({ pruneArchive: true });
  const slate = await readSlate(dir);
  expect(slate?.trail?.map((e) => e.tool)).toEqual(["read_file", "get_cwd"]);
  expect(slate?.trail?.map((e) => e.step)).toEqual([1, 2]);
  expect(slate?.trail?.[0]?.outcome).toBe("ok");
  expect(slate?.trail?.[0]?.files?.some((f) => f.endsWith("a.txt"))).toBe(true);

  const tools = history.filter((m) => m.role === "tool");
  expect(tools.map((m) => m.trailStep)).toEqual([1, 2]);
  // every output is on disk in full, even a tiny one, and the Trail names the file
  const outputPath = slate?.trail?.[0]?.outputPath;
  expect(outputPath).toBeDefined();
  expect(await readFile(outputPath as string, "utf8")).toContain("alpha");
  expect(tools[0]?.spillPath).toBe(outputPath);
});

test("a host without pruneArchive (ACP, subagent, trigger dispatch) writes no Trail and tags nothing", async () => {
  const history = await run({});
  expect((await readSlate(dir))?.trail).toBeUndefined();
  expect(history.some((m) => m.trailStep !== undefined || m.spillPath !== undefined)).toBe(false);
  await expect(readdir(path.join(dir, "tool-output"))).rejects.toThrow();
});

test("pruneArchive without a compaction handler is not working-memory mode", async () => {
  await run({ pruneArchive: true, handler: false });
  expect((await readSlate(dir))?.trail).toBeUndefined();
});

test("a detached (lease-lost) ref writes no Trail entry into the slate its successor holds", async () => {
  const ref: SlateSessionRef = { dir, cwd: work, opened: true };
  detachSlateSession(ref);
  await run({ pruneArchive: true, ref });
  expect((await readSlate(dir))?.trail).toBeUndefined();
});

test("a session whose slate is not open records nothing", async () => {
  await run({ pruneArchive: true, ref: { dir, cwd: work, opened: false } });
  expect((await readSlate(dir))?.trail).toBeUndefined();
});

test("the model has no tool that writes the Trail: every tool it is given leaves the Trail untouched", async () => {
  await run({ pruneArchive: true });
  const before = JSON.stringify((await readSlate(dir))?.trail);
  const forged = { step: 99, tool: "forged", digest: "forged", outcome: "ok", trail: [{ step: 100 }], key: "k", text: "t", query: "forged" };
  for (const tool of [
    slateNoteTool(() => dir, () => "t"),
    slateTrailTool(() => dir),
    recallStepTool(() => dir),
    historySearchTool(() => dir),
  ]) {
    await tool.invoke(forged);
  }
  expect(JSON.stringify((await readSlate(dir))?.trail)).toBe(before);
  // and no tool in the offered roster is named like a Trail writer
  const names = [...builtinReadOnlyTools(work)].map((t) => t.definition.name);
  expect(names.filter((n) => /trail/i.test(n))).toEqual([]);
});

test("working-memory tools are offered only to hosts that keep working memory", async () => {
  const wmTools = [
    slateNoteTool(() => dir, () => "t"),
    slateTrailTool(() => dir),
    recallStepTool(() => dir),
    historySearchTool(() => dir),
    ...builtinReadOnlyTools(work),
  ];
  const offered = async (options: { pruneArchive?: boolean; handler?: boolean }): Promise<string[]> => {
    const { provider, requests } = scriptedProvider([okReply]);
    await runAgentTurn(
      collectingIo().io,
      makeDeps(provider, { tools: wmTools, ...(options.handler === false ? {} : { onContextCompaction: () => {} }) }),
      [],
      "go",
      { slateSession: { dir, cwd: work, opened: true }, ...(options.pruneArchive === true ? { pruneArchive: true } : {}) },
    );
    return (requests[0]?.tools ?? []).map((t) => t.name);
  };
  const host = await offered({ pruneArchive: true });
  for (const name of ["slate_note", "slate_trail", "recall_step", "history_search"]) expect(host).toContain(name);
  for (const options of [{}, { pruneArchive: true, handler: false }]) {
    const names = await offered(options);
    expect(names).toContain("read_file");
    for (const name of ["slate_note", "slate_trail", "recall_step", "history_search"]) expect(names).not.toContain(name);
  }
});
