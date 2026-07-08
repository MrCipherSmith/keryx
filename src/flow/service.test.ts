import { afterAll, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowServiceDeps, TrackerAdapter } from "./types";

// Each test gets its own OS temp dir (no shared path -> no cross-test/CI flakes).
let ROOT = "";

function fakeTracker(over: Partial<{
  checksGreen: boolean;
  exists: boolean;
  isDraft: boolean;
  commented: string[];
}> = {}): TrackerAdapter & { commented: string[] } {
  const commented: string[] = over.commented ?? [];
  return {
    id: "fake",
    commented,
    detect: async () => true,
    parseRef: (input) => {
      const match = input.match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
      return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : null;
    },
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({
      exists: over.exists ?? true,
      isDraft: over.isDraft ?? true,
      checksGreen: over.checksGreen ?? true,
    }),
    comment: async (_ref, body) => {
      commented.push(body);
      return true;
    },
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-07-07T10:00:00Z"),
    ...over,
  };
}

async function fresh(): Promise<void> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-flow-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

afterAll(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
});

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  const file = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await writeFile(
    file,
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

test("init scaffolds the package; ids increment; freeze rejects placeholder AC", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));

  const first = await service.init({ cwd: ROOT, title: "Fix login timeout" });
  expect(first.flow.id).toBe("001");
  expect(first.flow.status).toBe("initializing");
  expect(first.dir).toContain("001-2026-07-07-fix-login-timeout");
  for (const file of ["flow.json", "description.md", "context.md", "plan.md", "tasks.md", "acceptance-criteria.md", "journal.md"]) {
    const content = await readFile(path.join(ROOT, first.dir, file), "utf8");
    expect(content.length).toBeGreaterThan(0);
  }

  const second = await service.init({ cwd: ROOT, title: "Another story" });
  expect(second.flow.id).toBe("002");

  // Placeholder AC must not freeze.
  await expect(service.freeze({ cwd: ROOT, id: "001" })).rejects.toThrow(/at least one real/);
});

test("concurrent init calls allocate unique flow ids", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));

  const results = await Promise.all([
    service.init({ cwd: ROOT, title: "Concurrent alpha" }),
    service.init({ cwd: ROOT, title: "Concurrent beta" }),
  ]);

  expect(results.map((result) => result.flow.id).sort()).toEqual(["001", "002"]);
  expect(new Set(results.map((result) => result.dir)).size).toBe(2);
});

test("freeze locks AC; tampering blocks transitions and is caught by check", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));
  const { flow } = await service.init({ cwd: ROOT, title: "Guard the criteria" });
  const dir = `001-2026-07-07-guard-the-criteria`;

  await writeAc(dir, ["Login succeeds within 2s"]);
  const frozen = await service.freeze({ cwd: ROOT, id: flow.id });
  expect(frozen.status).toBe("ready");
  expect(frozen.acChecksum).toMatch(/^sha256:/);

  // Tamper outside the CLI.
  await writeAc(dir, ["Login succeeds within 20s (loosened!)"]);
  await expect(service.start({ cwd: ROOT, id: flow.id })).rejects.toThrow(/outside the task-manager/);

  const check = await service.check({ cwd: ROOT });
  expect(check.ok).toBe(false);
  expect(check.issues.some((issue) => issue.kind === "checksum")).toBe(true);

  // ac update is the sanctioned path.
  await service.acUpdate({ cwd: ROOT, id: flow.id, reason: "requirement loosened by owner" });
  const started = await service.start({ cwd: ROOT, id: flow.id });
  expect(started.status).toBe("in-progress");
});

test("full happy path: start -> tasks -> implemented -> confirm -> complete(done) + issue comment", async () => {
  await fresh();
  const tracker = fakeTracker();
  const service = createFlowService(makeDeps({ tracker }));

  const { flow } = await service.init({
    cwd: ROOT,
    issue: "https://github.com/acme/app/issues/42",
  });
  expect(flow.title).toBe("Issue title");
  expect(flow.source.type).toBe("github-issue");
  const dir = `001-2026-07-07-issue-title`;

  await writeAc(dir, ["Criterion one", "Criterion two"]);
  await service.freeze({ cwd: ROOT, id: "001" });
  await service.start({ cwd: ROOT, id: "001" });

  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: ROOT, id: "001", taskId });
  }

  // implemented requires a PR; status authority enforced by machine.
  await expect(service.complete({ cwd: ROOT, id: "001" })).rejects.toThrow(/Invalid flow transition/);
  await service.implemented({ cwd: ROOT, id: "001", prUrl: "https://github.com/acme/app/pull/43" });

  await service.acConfirm({ cwd: ROOT, id: "001", criterion: "AC1", note: "verified manually" });
  await service.acConfirm({ cwd: ROOT, id: "001", criterion: "AC2" });

  const result = await service.complete({ cwd: ROOT, id: "001", comment: true });
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
  expect(result.gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass"]);
  expect(result.commented).toBe(true);
  expect(tracker.commented[0]).toContain("Flow 001");
  expect(tracker.commented[0]).toContain("pull/43");
});

test("failed gates return the flow to in-progress with fix notes", async () => {
  await fresh();
  const service = createFlowService(
    makeDeps({
      tracker: fakeTracker({ checksGreen: false }),
      healthGate: async () => ({ status: "fail", reasons: ["P0 findings"] }),
    }),
  );

  const { flow } = await service.init({ cwd: ROOT, title: "Gate failure path" });
  const dir = `001-2026-07-07-gate-failure-path`;
  await writeAc(dir, ["Must be verified"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/9" });
  // AC1 deliberately NOT confirmed.

  const result = await service.complete({ cwd: ROOT, id: flow.id });
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  const failedNames = result.gates.filter((gate) => gate.status === "fail").map((gate) => gate.name);
  expect(failedNames).toEqual(["acceptance-criteria", "pull-request", "health"]);
  expect(result.flow.history.some((event) => event.event === "completion-failed")).toBe(true);
});

test("block stores the previous status and unblock restores it", async () => {
  await fresh();
  const service = createFlowService(makeDeps({ tracker: null }));
  const { flow } = await service.init({ cwd: ROOT, title: "Blockable" });
  const dir = `001-2026-07-07-blockable`;
  await writeAc(dir, ["ok"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });

  const blocked = await service.block({ cwd: ROOT, id: flow.id, reason: "waiting on API keys" });
  expect(blocked.status).toBe("blocked");
  const resumed = await service.unblock({ cwd: ROOT, id: flow.id });
  expect(resumed.status).toBe("in-progress");
});
