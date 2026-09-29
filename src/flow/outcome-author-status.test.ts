// Flow 365, AC4 — `flow status` prints an author line; a flow written before the field existed
// reads `unknown`, and reading it never rewrites the file.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

import { flowCommand } from "../commands/flow";
import { readOutcomeAuthor } from "./service";

let logs: string[] = [];
const realLog = console.log;

async function statusOf(id: string): Promise<string> {
  const originalCwd = process.cwd();
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    process.chdir(ROOT);
    await flowCommand(["status", id]);
    return logs.join("\n");
  } finally {
    console.log = realLog;
    process.chdir(originalCwd);
  }
}

test("AC4: status prints the recorded author for agent and human flows", async () => {
  const service = await fresh();
  const agent = await init(service, { cwd: ROOT, title: "Agent flow", slug: "agent-flow" });
  const human = await init(service, { cwd: ROOT, title: "Human flow", slug: "human-flow", outcomeAuthor: "human" });

  expect(await statusOf(agent.flow.id)).toContain("outcome author: agent");
  expect(await statusOf(human.flow.id)).toContain("outcome author: human");
});

test("AC4: a flow without the field reads unknown, and reading it rewrites nothing", async () => {
  const service = await fresh();
  const { flow, dir } = await init(service, { cwd: ROOT, title: "Old flow" });
  const raw = await readRawFlow(dir);
  delete raw.outcomeAuthor;
  await Bun.write(path.join(dir, "flow.json"), `${JSON.stringify(raw, null, 2)}\n`);
  const flowBefore = await readFile(path.join(dir, "flow.json"), "utf8");
  const journalBefore = await readFile(path.join(dir, "journal.md"), "utf8");

  expect(await statusOf(flow.id)).toContain("outcome author: unknown");
  const read = await service.get({ cwd: ROOT, id: flow.id });
  expect(readOutcomeAuthor(read.outcomeAuthor)).toBe("unknown");
  await service.list({ cwd: ROOT });

  expect(await readFile(path.join(dir, "flow.json"), "utf8")).toBe(flowBefore);
  expect(await readFile(path.join(dir, "journal.md"), "utf8")).toBe(journalBefore);
});

test("AC6: the flag gates nothing — an unknown, agent or human flow freezes and starts the same way", async () => {
  const service = await fresh();
  const statuses: string[] = [];
  for (const [i, outcomeAuthor] of (["human", "agent", undefined, "legacy"] as const).entries()) {
    const { flow, dir } = await init(service, {
      cwd: ROOT,
      title: `Gate ${i}`,
      slug: `gate-${i}`,
      ...(outcomeAuthor === undefined || outcomeAuthor === "legacy" ? {} : { outcomeAuthor }),
    });
    if (outcomeAuthor === "legacy") {
      const raw = await readRawFlow(dir);
      delete raw.outcomeAuthor;
      await Bun.write(path.join(dir, "flow.json"), `${JSON.stringify(raw, null, 2)}\n`);
    }
    await Bun.write(
      path.join(dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n## Criteria\n\n- AC1: it works\n",
    );
    await service.freeze({ cwd: ROOT, id: flow.id });
    statuses.push((await service.start({ cwd: ROOT, id: flow.id })).status);
  }
  expect(new Set(statuses).size).toBe(1);
});
