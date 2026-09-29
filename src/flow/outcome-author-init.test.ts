// Flow 365, AC1 — `flow init --outcome-author`: agent by default, human only when the
// flag says so, anything else refused before the flow exists, and the schema lists the field.
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
import { flowStateSchema } from "./schema";

test("AC1: a flow created without the flag carries outcomeAuthor agent, on disk too", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "No flag given" });

  expect(flow.outcomeAuthor).toBe("agent");
  expect((await readRawFlow(dir)).outcomeAuthor).toBe("agent");
});

test("AC1: --outcome-author human is recorded as human", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "A person wrote it", outcomeAuthor: "human" });

  expect(flow.outcomeAuthor).toBe("human");
  expect((await readRawFlow(dir)).outcomeAuthor).toBe("human");
});

test("AC1: --outcome-author agent is recorded as agent", async () => {
  const service = await fresh();
  const { flow } = await init(service, { cwd: ROOT, title: "Stated agent", outcomeAuthor: "agent" });
  expect(flow.outcomeAuthor).toBe("agent");
});

test("AC1: human is never inferred from a stated owner or a human-looking title", async () => {
  const service = await fresh();
  const { flow } = await init(service, { cwd: ROOT, title: "Written by Aleks", owner: "Aleks" });
  expect(flow.owner?.value).toBe("Aleks");
  expect(flow.outcomeAuthor).toBe("agent");
});

test.each(["robot", "Human", "", "  ", "both"])("AC1: value %j is refused before the flow is created", async (value) => {
  const service = await fresh();
  await expect(service.init({ cwd: ROOT, title: "Bad author", outcomeAuthor: value })).rejects.toThrow(
    /--outcome-author must be one of: agent, human/,
  );
  expect(await flowDirs()).toEqual([]);
});

test("AC1: the CLI exits non-zero on an unknown value and on a bare flag, and creates nothing", async () => {
  await fresh();
  const originalCwd = process.cwd();
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    process.chdir(ROOT);
    process.exitCode = 0;
    await flowCommand(["init", "--title", "Bad value", "--outcome-author", "robot"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--outcome-author must be one of: agent, human");

    process.exitCode = 0;
    errors.length = 0;
    await flowCommand(["init", "--title", "Bare flag", "--outcome-author"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--outcome-author must be one of");
    expect(await flowDirs()).toEqual([]);
  } finally {
    console.error = realError;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
});

test.each([
  ["the same value twice", ["--outcome-author", "agent", "--outcome-author", "agent"]],
  ["two different values", ["--outcome-author", "agent", "--outcome-author", "human"]],
  ["the human value twice", ["--outcome-author", "human", "--outcome-author", "human"]],
  ["the equals form twice", ["--outcome-author=agent", "--outcome-author=human"]],
  ["equals form first, spaced form second", ["--outcome-author=agent", "--outcome-author", "human"]],
  ["spaced form first, equals form second", ["--outcome-author", "human", "--outcome-author=agent"]],
])("AC1: the flag repeated (%s) is refused, and no flow is created", async (_label, flagArgs) => {
  await fresh();
  const originalCwd = process.cwd();
  const realError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    process.chdir(ROOT);
    process.exitCode = 0;
    await flowCommand(["init", "--title", "Repeated flag", ...flagArgs]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--outcome-author was given more than once");
    expect(await flowDirs()).toEqual([]);
  } finally {
    console.error = realError;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
});

test("AC1: the flag given once, in either spelling, still creates the flow", async () => {
  await fresh();
  const originalCwd = process.cwd();
  const realLog = console.log;
  console.log = () => undefined;
  try {
    process.chdir(ROOT);
    process.exitCode = 0;
    await flowCommand(["init", "--title", "Spaced form", "--outcome-author", "human"]);
    await flowCommand(["init", "--title", "Equals form", "--outcome-author=human"]);
    expect(process.exitCode).toBe(0);
    const dirs = await flowDirs();
    expect(dirs).toHaveLength(2);
    for (const dir of dirs) {
      expect((await readRawFlow(path.join(ROOT, ".metaproject", "flows", dir))).outcomeAuthor).toBe("human");
    }
  } finally {
    console.log = realLog;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
});

test("AC1: `keryx flow schema` lists outcomeAuthor with exactly agent and human", () => {
  const schema = flowStateSchema() as { properties?: Record<string, { enum?: string[] }> };
  expect(schema.properties?.["outcomeAuthor"]?.enum).toEqual(["agent", "human"]);
});
