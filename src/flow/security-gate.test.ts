import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowServiceDeps, TrackerAdapter } from "./types";
import { uniqueTestRoot } from "../lib/test-tmp";

const ROOT = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-flow-security-test");

function fakeTracker(): TrackerAdapter & { commented: string[] } {
  const commented: string[] = [];
  return {
    id: "fake",
    commented,
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "Issue body text" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
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
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

async function writeAc(dir: string, criteria: string[]): Promise<void> {
  const file = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await writeFile(
    file,
    `# Acceptance Criteria\n\n## Criteria\n\n${criteria.map((c, i) => `- AC${i + 1}: ${c}`).join("\n")}\n`,
    "utf8",
  );
}

// Drive a flow to the point where `complete` runs its gates.
async function driveToComplete(deps: FlowServiceDeps): Promise<ReturnType<ReturnType<typeof createFlowService>["complete"]>> {
  const service = createFlowService(deps);
  const { flow } = await service.init({ cwd: ROOT, title: "Security gate flow" });
  const dir = "001-2026-07-07-security-gate-flow";
  await writeAc(dir, ["Criterion one"]);
  await service.freeze({ cwd: ROOT, id: flow.id });
  await service.start({ cwd: ROOT, id: flow.id });
  await service.implemented({ cwd: ROOT, id: flow.id, prUrl: "https://github.com/acme/app/pull/1" });
  await service.acConfirm({ cwd: ROOT, id: flow.id, criterion: "AC1" });
  return service.complete({ cwd: ROOT, id: flow.id });
}

test("no securityGate dep: only the three pre-existing gates run (no regression)", async () => {
  await fresh();
  const result = await driveToComplete(makeDeps());
  expect(result.gates.map((g) => g.name)).toEqual(["acceptance-criteria", "pull-request", "health"]);
  expect(result.passed).toBe(true);
});

test("securityGate returning null omits the gate entirely", async () => {
  await fresh();
  const result = await driveToComplete(makeDeps({ securityGate: async () => null }));
  expect(result.gates.some((g) => g.name === "security")).toBe(false);
  expect(result.passed).toBe(true);
});

test("advisory securityGate adds an informational passing gate; flow still completes", async () => {
  await fresh();
  const result = await driveToComplete(
    makeDeps({ securityGate: async () => ({ status: "pass", detail: "security advisory: informational" }) }),
  );
  const security = result.gates.find((g) => g.name === "security");
  expect(security?.status).toBe("pass");
  expect(result.passed).toBe(true);
  expect(result.flow.status).toBe("done");
});

test("enforced securityGate failure returns the flow to in-progress", async () => {
  await fresh();
  const result = await driveToComplete(
    makeDeps({ securityGate: async () => ({ status: "fail", detail: "security gate: fail" }) }),
  );
  const failed = result.gates.filter((g) => g.status === "fail").map((g) => g.name);
  expect(failed).toContain("security");
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
  await rm(ROOT, { recursive: true, force: true });
});
