// Flow 454 AC6: the memory-outside-stage readiness item over a log keryx wrote itself. An extra orchestrator
// memory call blocks and is named; the stage alone, a reviewer's call, and a log that holds only its first line
// are ready; a call keryx could not attribute only warns (D1); no file at all is ready, as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ORCHESTRATOR_LOG } from "./layers-usage";
import { CALLER_ORCHESTRATOR, CALLER_UNATTRIBUTED, recordLogStart, recordOrchestratorCall, type OrchestratorLogEntry } from "./orchestrator-log";
import { computeReadiness } from "./readiness";

const STARTED = "2026-10-15T10:00:00.000Z";
const STAGE_QUERY = "auth middleware session tokens";

let root: string;
let pkg: string;
let tick = 0;

function writeManifest(): void {
  writeFileSync(
    path.join(pkg, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      reviewId: "r1",
      mode: "review-flow",
      status: "draft",
      target: { kind: "branch", ref: "feat/x" },
      artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
      coverage: [],
      cleanContext: { startedAt: STARTED },
    }),
  );
}

const search = (caller: string, query: string, status?: string): OrchestratorLogEntry => ({
  source: "mcp",
  caller,
  tool: "memory_search",
  input: { query, ...(status === undefined ? {} : { status }) },
});

async function record(entry: OrchestratorLogEntry): Promise<void> {
  tick += 1;
  await recordOrchestratorCall(pkg, entry, { now: new Date(Date.parse(STARTED) + tick * 1000) });
}

const item = async () => (await computeReadiness(pkg)).items.find((entry) => entry.id === "memory-outside-stage")!;

beforeEach(() => {
  tick = 0;
  root = mkdtempSync(path.join(tmpdir(), "keryx-memory-stage-auto-"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  mkdirSync(pkg, { recursive: true });
  writeManifest();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("AC6: the memory-outside-stage item over a recorded log", () => {
  test("an extra orchestrator memory call is blocked, and the detail names it", async () => {
    await recordLogStart(pkg);
    await record(search(CALLER_ORCHESTRATOR, STAGE_QUERY, "accepted"));
    await record(search(CALLER_ORCHESTRATOR, "what did we decide about this PR last time"));
    const blocked = await item();
    expect(blocked.status).toBe("fail");
    expect(blocked.evidence).toContain("1 memory call(s) by the orchestrator outside its memory stage");
    expect(blocked.evidence).toContain("what did we decide about this PR last time");
    expect((await computeReadiness(pkg)).verdict).toBe("NOT READY");
  });

  test("a log that holds only the stage query is ready", async () => {
    await recordLogStart(pkg);
    await record(search(CALLER_ORCHESTRATOR, STAGE_QUERY, "accepted"));
    const ready = await item();
    expect(ready.status).toBe("pass");
    expect(ready.evidence).toContain(STAGE_QUERY);
  });

  test("a call under a reviewer's id is ready", async () => {
    await recordLogStart(pkg);
    await record(search(CALLER_ORCHESTRATOR, STAGE_QUERY, "accepted"));
    await record(search("review-logic", "retry storms"));
    await record({ source: "cli", caller: "review-logic", command: "keryx memory list" });
    expect((await item()).status).toBe("pass");
  });

  test("an unattributed call is ready, with a warning in the detail", async () => {
    await recordLogStart(pkg);
    await record(search(CALLER_ORCHESTRATOR, STAGE_QUERY, "accepted"));
    await record(search(CALLER_UNATTRIBUTED, "who called this"));
    const ready = await item();
    expect(ready.status).toBe("pass");
    expect(ready.evidence).toContain("warning: 1 unattributed memory call(s)");
    expect(ready.evidence).toContain("who called this");
  });

  test("unattributed calls never block, however many there are", async () => {
    await recordLogStart(pkg);
    for (const query of ["a", "b", "c", "d"]) await record(search(CALLER_UNATTRIBUTED, query));
    const ready = await item();
    expect(ready.status).toBe("pass");
    expect(ready.evidence).toContain("warning: 4 unattributed memory call(s)");
  });

  test("an unattributed call does not hide an orchestrator call beside it", async () => {
    await recordLogStart(pkg);
    await record(search(CALLER_UNATTRIBUTED, "who called this"));
    await record(search(CALLER_ORCHESTRATOR, "a stray lookup"));
    const blocked = await item();
    expect(blocked.status).toBe("fail");
    expect(blocked.evidence).toContain("a stray lookup");
    expect(blocked.evidence).toContain("warning: 1 unattributed memory call(s)");
  });

  test("a log that holds only its first line is ready and says no memory call was recorded", async () => {
    await recordLogStart(pkg);
    const ready = await item();
    expect(ready.status).toBe("pass");
    expect(ready.evidence).toContain("no memory call recorded");
  });

  test("no file at all is ready and says it could not see the orchestrator", async () => {
    const ready = await item();
    expect(ready.status).toBe("pass");
    expect(ready.evidence).toContain("no orchestrator tool log");
    expect(ready.evidence).toContain(`tool-calls/${ORCHESTRATOR_LOG}.jsonl`);
  });
});
