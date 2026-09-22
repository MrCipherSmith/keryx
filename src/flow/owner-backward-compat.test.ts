// Flow 289, AC6 — a flow.json written before owner/signature fields existed
// keeps loading, validating, passing `flow check`, and completing exactly as
// it did before; reading it never rewrites it on disk.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { flowStateSchema } from "./schema";
import { createFlowService } from "./service";
import { flowIdOf } from "./store";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

let ROOT = "";
const HEAD = "abad1deaabad1deaabad1deaabad1deaabad1dea";

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
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-owner-compat-"));
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

test("AC6: a v1 flow.json with no gates/owner/signatures validates against flowStateSchema", () => {
  const legacy = {
    schemaVersion: 1,
    id: "002",
    slug: "pre-owner-flow",
    title: "Written before owner/signature existed",
    status: "done",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T17:01:50.445Z",
    source: { type: "description", ref: null },
    acChecksum: `sha256:${"a".repeat(64)}`,
    acConfirmed: { AC1: { at: "2026-07-10T17:01:50.321Z", note: "evidence" } },
    pr: {},
    tasks: [{ id: "T1", title: "Collect remaining context", kind: "context", status: "done" }],
    history: [],
  };
  const result = validateAgainstSchemaObject(flowStateSchema(), legacy);
  expect(result.valid).toBe(true);
});

test("AC6: reading a legacy flow.json migrates it in memory but never rewrites the file on disk", async () => {
  await fresh();
  const dir = "003-2026-07-10-legacy-flow";
  await mkdir(path.join(ROOT, ".metaproject", "flows", dir), { recursive: true });
  const legacy: FlowState = {
    schemaVersion: 1,
    id: "003",
    slug: "legacy-flow",
    title: "Legacy flow",
    status: "in-progress",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    source: { type: "description", ref: null },
    acChecksum: null,
    acConfirmed: {},
    pr: { url: null },
    tasks: [{ id: "T1", title: "Collect remaining context", kind: "context", status: "todo" }],
    history: [{ at: "2026-07-10T00:00:00.000Z", event: "created" }],
  };
  const bytesBefore = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(flowJsonPath(dir), bytesBefore, "utf8");

  const service = createFlowService(makeDeps());
  const loaded = await service.get({ cwd: ROOT, id: "003" });

  // Migrated in memory: no owner/signatures fields (never inferred, never
  // fabricated), and every existing field intact.
  expect(loaded.owner).toBeUndefined();
  expect(loaded.signatures).toBeUndefined();
  expect(loaded.schemaVersion).toBe(2); // v1 -> v2 migration, unrelated to this flow, still applies

  const bytesAfter = await readFile(flowJsonPath(dir), "utf8");
  expect(bytesAfter).toBe(bytesBefore);
});

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

test("AC6: `flow check` reports no issue for a pre-existing package missing owner/signature fields", async () => {
  await fresh();
  const service: FlowService = createFlowService(makeDeps());
  const { dir: created } = await service.init({ cwd: ROOT, title: "Will be downgraded to legacy shape" });
  const dir = path.basename(created);
  const raw = await readRawFlow(dir);
  delete raw.gates;
  delete raw.owner;
  delete raw.signatures;
  await writeRawFlow(dir, raw);

  const result = await service.check({ cwd: ROOT });
  const issuesForThisFlow = result.issues.filter((issue) => issue.flow.includes(flowIdOf(dir)));
  expect(issuesForThisFlow).toEqual([]);
});

test("AC6: the same legacy package completes exactly as before — owner gate skipped, not failed", async () => {
  await fresh();
  const service = createFlowService(makeDeps());
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Legacy completion" });
  const dir = path.basename(created);
  await writeAc(dir, ["Only criterion"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: "https://github.com/acme/app/pull/9" });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: flow.id, taskId });
  }

  // Downgrade to the pre-change shape right before completing.
  const raw = await readRawFlow(dir);
  delete raw.gates;
  delete raw.owner;
  await writeRawFlow(dir, raw);

  const result = await service.complete({ cwd: ROOT, id: flow.id });

  expect(result.gates.find((gate) => gate.name === "owner")?.status).toBe("skipped");
  expect(result.gates.find((gate) => gate.name === "tasks")?.status).toBe("skipped");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
  // A completion signature is still appended — AC4 applies unconditionally,
  // independent of the owner gate's opt-in — but it never claims an owner
  // that was never set.
  expect(result.flow.owner).toBeUndefined();
  expect(result.flow.signatures?.at(-1)?.kind).toBe("complete");
});
