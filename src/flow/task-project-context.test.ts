import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "../gdskills/project-rules";
import { createFlowService } from "./service";
import type { FlowService } from "./types";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const RULE = ".metaproject/rules/project/styling.mdc";
const RULE_TEXT = "use tokens, not hex\n";

type Fixture = { root: string; dir: string; service: FlowService; flowId: string };

async function fixture(enforcement?: "warn" | "block"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-task-ctx-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "rules", "project"), { recursive: true });
  await writeFile(path.join(root, RULE), RULE_TEXT, "utf8");
  if (enforcement !== undefined) {
    await writeFile(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ gdskills: { projectContext: { enforcement } } }), "utf8");
  }
  const service = createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-17T10:00:00Z"),
  });
  const { flow, dir } = await service.init({ cwd: root, title: "Task context" });
  await writeFile(path.join(root, dir, "acceptance-criteria.md"), "# Acceptance Criteria\n\n## Criteria\n\n- AC1: it works [verify: judged]\n", "utf8");
  await service.freeze({ cwd: root, id: flow.id });
  await service.start({ cwd: root, id: flow.id });
  return { root, dir, service, flowId: flow.id };
}

async function files(root: string, cited: boolean): Promise<{ result: string; resolved: string }> {
  const sha = sha256Hex(RULE_TEXT);
  const resolved = {
    schema: 1,
    entries: [{ kind: "rule", source: "project", path: RULE, sha256: sha, reason: "glob", tier: "must_read" }],
  };
  const result = { project_context_applied: cited ? [{ path: RULE, sha256: sha, how: "read" }] : [] };
  await writeFile(path.join(root, "resolved.json"), JSON.stringify(resolved), "utf8");
  await writeFile(path.join(root, "result.json"), JSON.stringify(result), "utf8");
  return { result: "result.json", resolved: "resolved.json" };
}

async function taskStatus(f: Fixture, taskId: string): Promise<string | undefined> {
  const flow = await f.service.get({ cwd: f.root, id: f.flowId });
  return flow.tasks.find((task) => task.id === taskId)?.status;
}

test("block: an implement task whose result misses a must_read rule is refused with the validator's lines and stays open", async () => {
  const f = await fixture("block");
  const { result, resolved } = await files(f.root, false);
  const refusal = f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: result, resolvedFile: resolved } });
  await expect(refusal).rejects.toThrow(/project context: 1 miss\(es\), 0 drifted \(enforcement block\)/);
  await expect(refusal).rejects.toThrow(new RegExp(`project context miss: ${RULE.replace(/\./g, "\\.")}`));
  expect(await taskStatus(f, "T2")).not.toBe("done");
});

test("block: a result that cites every must_read entry with the pinned sha256 closes the task", async () => {
  const f = await fixture("block");
  const { result, resolved } = await files(f.root, true);
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: result, resolvedFile: resolved } });
  expect(await taskStatus(f, "T2")).toBe("done");
});

test("block: a test task is checked like an implement task", async () => {
  const f = await fixture("block");
  const { result, resolved } = await files(f.root, false);
  await expect(f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T3", projectContext: { resultFile: result, resolvedFile: resolved } })).rejects.toThrow(/1 miss/);
});

test("block: pin drift between resolve and close refuses the task", async () => {
  const f = await fixture("block");
  const { result, resolved } = await files(f.root, true);
  await writeFile(path.join(f.root, RULE), "use tokens, and spacing scale\n", "utf8");
  await expect(f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: result, resolvedFile: resolved } })).rejects.toThrow(/1 drifted/);
});

test("block: an implement task with no recorded result is refused; skipped with a reason and a non-code task pass", async () => {
  const f = await fixture("block");
  await expect(f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2" })).rejects.toThrow(/records no result to check/);
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", disposition: "skipped", reason: "nothing to write" });
  expect(await taskStatus(f, "T2")).toBe("done");
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T4" });
  expect(await taskStatus(f, "T4")).toBe("done");
});

test("warn: the same miss passes and is written to the flow journal", async () => {
  const f = await fixture("warn");
  const { result, resolved } = await files(f.root, false);
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: result, resolvedFile: resolved } });
  expect(await taskStatus(f, "T2")).toBe("done");
  const journal = await readFile(path.join(f.root, f.dir, "journal.md"), "utf8");
  expect(journal).toContain("1 miss(es), 0 drifted (enforcement warn)");
  expect(journal).toContain(RULE);
});

test("default install (no config): a miss passes and a task without a result is not checked", async () => {
  const f = await fixture();
  const { result, resolved } = await files(f.root, false);
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: result, resolvedFile: resolved } });
  await f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T3" });
  expect(await taskStatus(f, "T3")).toBe("done");
});

test("--result without --resolved (or the reverse) is an error in any mode", async () => {
  const f = await fixture("warn");
  await expect(f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resultFile: "result.json" } })).rejects.toThrow(/go together/);
  await expect(f.service.taskDone({ cwd: f.root, id: f.flowId, taskId: "T2", projectContext: { resolvedFile: "resolved.json" } })).rejects.toThrow(/go together/);
});
