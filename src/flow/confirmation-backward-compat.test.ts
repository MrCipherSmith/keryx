// Flow 299, AC7: old flows and old signatures keep working.
//
// - Every flow package in this repository loads and validates against the
//   schema, and reading one never rewrites it.
// - A flow without `gates.confirmation` reports the confirmation gate
//   `skipped` and completes, or fails, exactly as it would have before.
// - A signature with no `confirmation` field renders as it always did.
// - There is no `schemaVersion` bump.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand } from "../commands/flow";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { flowStateSchema } from "./schema";
import { createFlowService } from "./service";
import { readFlow } from "./store";
import { writeCleanReviewPackage } from "./review-fixtures";
import type { FlowService, FlowState, TrackerAdapter } from "./types";

const REPO = path.resolve(import.meta.dir, "..", "..");
const HEAD = "1234abcd1234abcd1234abcd1234abcd1234abcd";
const PR = "https://github.com/acme/app/pull/1";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
let ROOT = "";

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

function tracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "t", body: "b" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

async function fresh(): Promise<FlowService> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-confirm-compat-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  return createFlowService({
    tracker: tracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-23T10:00:00Z"),
  });
}

test("AC7: every flow package in this repository loads, validates, and is not rewritten by being read", async () => {
  const flowsDir = path.join(REPO, ".metaproject", "flows");
  const dirs = (await readdir(flowsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => entry.name);
  expect(dirs.length).toBeGreaterThan(200);
  const invalid: string[] = [];
  for (const dir of dirs) {
    const file = path.join(flowsDir, dir, "flow.json");
    const before = await readFile(file, "utf8");
    await readFlow(REPO, dir);
    expect(await readFile(file, "utf8")).toBe(before);
    const raw: unknown = JSON.parse(before);
    if (!validateAgainstSchemaObject(flowStateSchema(), raw).valid) invalid.push(dir);
  }
  expect(invalid).toEqual([]);
});

async function preChangeFlow(service: FlowService, confirm: boolean): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "Pre-change", owner: "Aleks" });
  const dir = path.basename(created);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n",
    "utf8",
  );
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: PR });
  if (confirm) await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: ROOT, flowDir: dir, head: HEAD, prUrl: PR });
  // The pre-change shape: no `gates` object at all, as a package written before
  // flows 201/204/289/299 has. flow.json is never hand-edited at runtime; this
  // fixture stands in for real repository history.
  const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete raw["gates"];
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  return { id: flow.id, dir };
}

test("AC7: a pre-change flow reports the confirmation gate skipped and PASSES as before", async () => {
  const service = await fresh();
  const { id } = await preChangeFlow(service, true);
  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(true);
  expect(result.gates.find((gate) => gate.name === "confirmation")?.status).toBe("skipped");
  expect(result.flow.schemaVersion).toBeLessThanOrEqual(2);
  const signature = result.flow.signatures?.find((candidate) => candidate.kind === "complete");
  expect(signature?.confirmation).toBeUndefined();
});

test("AC7: a pre-change flow FAILS for exactly its own reasons, never because of the confirmation gate", async () => {
  const service = await fresh();
  const { id } = await preChangeFlow(service, false);
  const result = await service.complete({ cwd: ROOT, id });
  expect(result.passed).toBe(false);
  expect(result.gates.filter((gate) => gate.status === "fail").map((gate) => gate.name)).toEqual(["acceptance-criteria"]);
  expect(result.gates.find((gate) => gate.name === "confirmation")?.status).toBe("skipped");
});

test("AC7: an old signature without `confirmation` renders unchanged in flow status", async () => {
  const service = await fresh();
  const { id, dir } = await preChangeFlow(service, true);
  await service.complete({ cwd: ROOT, id, signedBy: "Aleks" });
  const flow = JSON.parse(await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8")) as FlowState;
  const signature = flow.signatures?.at(-1);
  process.chdir(ROOT);
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  await flowCommand(["status", id]);
  const signedLine = logs.find((line) => line.includes("signed:")) ?? "";
  expect(signedLine).toContain(`Aleks`);
  expect(signedLine).toContain(`(complete, ${signature?.at})`);
  expect(signedLine).not.toContain("terminal token");
  expect(logs.join("\n")).not.toContain("confirm: ");
});
