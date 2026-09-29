// Flow 365, AC2 — `flow outcome author`: the reason is required, an unknown value is refused,
// one journal line names old, new and the reason, field and line land together, and setting the
// value already held writes nothing.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-29T10:00:00Z"),
  };
}

async function fresh(): Promise<FlowService> {
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-outcome-author-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService(makeDeps());
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

type InitInput = Parameters<FlowService["init"]>[0];

// `init` reports the flow directory relative to the project root; the assertions read it directly.
async function init(service: FlowService, input: InitInput): Promise<{ flow: FlowState; dir: string }> {
  const result = await service.init(input);
  return { flow: result.flow, dir: path.join(ROOT, result.dir) };
}

async function readRawFlow(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(path.join(dir, "flow.json"), "utf8")) as FlowState;
}

async function flowDirs(): Promise<string[]> {
  try {
    return await readdir(path.join(ROOT, ".metaproject", "flows"));
  } catch {
    return [];
  }
}

import { flowCommand } from "../commands/flow";

async function journal(dir: string): Promise<string> {
  return await readFile(path.join(dir, "journal.md"), "utf8");
}

function outcomeLines(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("outcome-author-set"));
}

async function legacyFlow(service: FlowService): Promise<{ id: string; dir: string }> {
  // A flow written before the field existed: drop it from flow.json.
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Old flow" });
  const raw = await readRawFlow(dir);
  delete raw.outcomeAuthor;
  await Bun.write(path.join(dir, "flow.json"), `${JSON.stringify(raw, null, 2)}\n`);
  return { id: flow.id, dir };
}

test("AC2: agent -> human writes the field and exactly one journal line naming old, new and the reason", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Switch author" });
  const before = await journal(dir);

  const updated = await service.outcomeAuthorSet({
    cwd: ROOT,
    id: flow.id,
    author: "human",
    reason: "Aleks rewrote the criterion",
  });

  expect(updated.outcomeAuthor).toBe("human");
  expect((await readRawFlow(dir)).outcomeAuthor).toBe("human");
  const added = (await journal(dir)).slice(before.length);
  const lines = outcomeLines(added);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("agent");
  expect(lines[0]).toContain("human");
  expect(lines[0]).toContain("Aleks rewrote the criterion");
});

test("AC2: a flow without the field names `unknown` as the old value", async () => {
  const service = await fresh();
  const { id, dir } = await legacyFlow(service);

  await service.outcomeAuthorSet({ cwd: ROOT, id, author: "agent", reason: "confirmed from the PR" });

  expect((await readRawFlow(dir)).outcomeAuthor).toBe("agent");
  const lines = outcomeLines(await journal(dir));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("unknown -> agent");
  expect(lines[0]).toContain("confirmed from the PR");
});

test("AC2: setting the value already held writes no journal line and leaves flow.json untouched", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Same value", outcomeAuthor: "human" });
  const flowBefore = await readFile(path.join(dir, "flow.json"), "utf8");
  const journalBefore = await journal(dir);

  await service.outcomeAuthorSet({ cwd: ROOT, id: flow.id, author: "human", reason: "no change" });

  expect(await readFile(path.join(dir, "flow.json"), "utf8")).toBe(flowBefore);
  expect(await journal(dir)).toBe(journalBefore);
});

test.each(["", "   "])("AC2: reason %j is refused and nothing is written", async (reason) => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Needs a reason" });
  const flowBefore = await readFile(path.join(dir, "flow.json"), "utf8");
  const journalBefore = await journal(dir);

  await expect(service.outcomeAuthorSet({ cwd: ROOT, id: flow.id, author: "human", reason })).rejects.toThrow(/--reason/);

  expect(await readFile(path.join(dir, "flow.json"), "utf8")).toBe(flowBefore);
  expect(await journal(dir)).toBe(journalBefore);
});

test("AC2: an unknown value is refused and nothing is written", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Bad value" });
  const flowBefore = await readFile(path.join(dir, "flow.json"), "utf8");

  await expect(
    service.outcomeAuthorSet({ cwd: ROOT, id: flow.id, author: "robot", reason: "why not" }),
  ).rejects.toThrow(/must be one of: agent, human/);
  await expect(
    service.outcomeAuthorSet({ cwd: ROOT, id: flow.id, author: "unknown", reason: "why not" }),
  ).rejects.toThrow(/must be one of: agent, human/);

  expect(await readFile(path.join(dir, "flow.json"), "utf8")).toBe(flowBefore);
});

test("AC2: the change is recorded in history too, so the field and the trail move together", async () => {
  const service = await fresh();
  const { flow } = await init(service, { cwd: ROOT, title: "History" });
  const updated = await service.outcomeAuthorSet({ cwd: ROOT, id: flow.id, author: "human", reason: "handwritten" });
  const last = updated.history[updated.history.length - 1];
  expect(last?.event).toBe("outcome-author-set");
  expect(last?.detail).toContain("handwritten");
});

test("AC2: the CLI refuses a missing --reason and an unknown value with a non-zero exit", async () => {
  const service = await fresh();
  const { flow } = await init(service, { cwd: ROOT, title: "CLI refusals" });
  const originalCwd = process.cwd();
  const realError = console.error;
  const realLog = console.log;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = () => undefined;
  try {
    process.chdir(ROOT);
    process.exitCode = 0;
    await flowCommand(["outcome", "author", flow.id, "human"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--reason");

    process.exitCode = 0;
    await flowCommand(["outcome", "author", flow.id, "robot", "--reason", "x"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await flowCommand(["outcome", "author", flow.id, "human", "--reason", "a person wrote it"]);
    expect(process.exitCode).toBe(0);
    const state = await service.get({ cwd: ROOT, id: flow.id });
    expect(state.outcomeAuthor).toBe("human");
  } finally {
    console.error = realError;
    console.log = realLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
});
