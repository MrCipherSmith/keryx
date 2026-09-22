// Flow 289, AC5 — the owner gate: opt-in per package the same way `tasks`
// and `review` are. A new flow fails it with a named reason while no owner
// is set and passes once one is; a flow created before the gate reports it
// skipped and completes exactly as it did before.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowInitInput, FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "cafe1cafe2cafe3cafe4cafe5cafe6cafe7cafe8";

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-owner-gate-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function flowJsonPath(dir: string): string {
  return path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
}

async function readRawFlow(dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(flowJsonPath(dir), "utf8")) as FlowState;
}

async function writeRawFlow(dir: string, flow: FlowState): Promise<void> {
  await writeFile(flowJsonPath(dir), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
}

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

/** Drive a fresh flow to the point where `complete` runs its gates, and close every task. */
async function driveToGates(
  service: FlowService,
  title: string,
  init: Partial<FlowInitInput> = {},
): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title, ...init });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/1" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }
  return { id: flow.id, dir };
}

test("AC5: `flow init` opts every new flow into the owner gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow } = await service.init({ cwd: ROOT, title: "Opts in" });
  expect(flow.gates?.owner).toBe(true);
});

test("AC5: complete fails the owner gate with a named reason while no owner is set", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "No owner yet");

  const result = await service.complete({ cwd: ROOT, id });

  const owner = result.gates.find((gate) => gate.name === "owner");
  expect(owner?.status).toBe("fail");
  expect(owner?.detail).toContain("no owner set");
  expect(owner?.detail).toContain("flow owner set");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
});

test("AC5: complete passes the owner gate once an owner is set", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Owner set at init", { owner: "Aleks" });

  const result = await service.complete({ cwd: ROOT, id });

  const owner = result.gates.find((gate) => gate.name === "owner");
  expect(owner?.status).toBe("pass");
  expect(owner?.detail).toContain("Aleks");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

test("AC5: an owner set after init, before complete, also satisfies the gate", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id } = await driveToGates(service, "Owner set later");
  await service.ownerSet({ cwd: ROOT, id, owner: "Priya", reason: "assigned" });

  const result = await service.complete({ cwd: ROOT, id });

  expect(result.gates.find((gate) => gate.name === "owner")?.status).toBe("pass");
  expect(result.passed).toBe(true);
});

test("AC5: a flow created before the owner gate reports it skipped, and completes exactly as before", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { id, dir } = await driveToGates(service, "Legacy package, no owner gate");

  // Reproduce a package written before this change: `gates` entirely absent,
  // no `owner` — the same shape 197+ real packages in this repository have.
  const raw = await readRawFlow(dir);
  delete raw.gates;
  delete raw.owner;
  await writeRawFlow(dir, raw);

  const result = await service.complete({ cwd: ROOT, id });

  const owner = result.gates.find((gate) => gate.name === "owner");
  expect(owner?.status).toBe("skipped");
  expect(owner?.detail).toContain("created before the gate");
  // Unaffected by the new gate: every other condition was already satisfied,
  // so completion succeeds exactly as it would have before this change.
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});
