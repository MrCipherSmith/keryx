// Flow 365, AC4 — with --outcome-author human the description.md Outcome criteria section is the
// template's own text, byte for byte, and no example is inserted; agent or no flag creates the
// flow exactly as before.
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

import { renderDescription } from "./templates";

const SECTION = /## Outcome criteria\n[\s\S]*?(?=\n## )/;

async function description(dir: string): Promise<string> {
  return await readFile(path.join(dir, "description.md"), "utf8");
}

test("AC4: --outcome-author human leaves description.md byte-identical to the template", async () => {
  const service = await fresh();
  const { dir } = await init(service, { cwd: ROOT, title: "Human flow", outcomeAuthor: "human" });
  const written = await description(dir);
  expect(written).toBe(renderDescription("Human flow", "user description"));
});

test("AC4: the Outcome criteria section is the same for human, agent and no flag", async () => {
  const service = await fresh();
  const human = await init(service, { cwd: ROOT, title: "Same title", slug: "human-one", outcomeAuthor: "human" });
  const agent = await init(service, { cwd: ROOT, title: "Same title", slug: "agent-one", outcomeAuthor: "agent" });
  const bare = await init(service, { cwd: ROOT, title: "Same title", slug: "bare-one" });

  const sections = await Promise.all([human.dir, agent.dir, bare.dir].map(async (dir) => (await description(dir)).match(SECTION)?.[0]));
  expect(sections[0]).toBeDefined();
  expect(sections[1]).toBe(sections[0]);
  expect(sections[2]).toBe(sections[0]);
});

test("AC4: agent and no flag write the whole description.md exactly as before", async () => {
  const service = await fresh();
  const agent = await init(service, { cwd: ROOT, title: "Plain agent", outcomeAuthor: "agent" });
  const bare = await init(service, { cwd: ROOT, title: "Plain bare", slug: "plain-bare" });

  expect(await description(agent.dir)).toBe(renderDescription("Plain agent", "user description"));
  expect(await description(bare.dir)).toBe(renderDescription("Plain bare", "user description"));
});

test("AC4: the human section holds only the template hint, no inserted example", async () => {
  const service = await fresh();
  const { dir } = await init(service, { cwd: ROOT, title: "Hint only", outcomeAuthor: "human" });
  const section = (await description(dir)).match(SECTION)?.[0] ?? "";
  const body = section.replace("## Outcome criteria", "").trim();
  expect(body).toBe((renderDescription("x", "y").match(SECTION)?.[0] ?? "").replace("## Outcome criteria", "").trim());
  expect(body).not.toMatch(/^\s*[-*]\s/m);
});
