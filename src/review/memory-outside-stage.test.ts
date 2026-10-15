// Flow 452 AC4: the orchestrator reads project memory once, in its memory stage. Any other memory call in its own tool log
// blocks the review, a reviewer's lookup does not, and only the operator's quoted waiver lifts it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ORCHESTRATOR_LOG, memoryCalls } from "./layers-usage";
import { computeReadiness, readinessItemId, waiveReadiness } from "./readiness";

let root: string;
let pkg: string;

const STAGE = 'keryx memory search "auth middleware session tokens" --status accepted';
const line = (command: string, extra: object = {}): string => JSON.stringify({ command, ...extra });

function writePackage(cleanContext?: object): void {
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
      ...(cleanContext === undefined ? {} : { cleanContext }),
    }),
  );
}

function writeLog(reviewer: string, lines: string[]): void {
  mkdirSync(path.join(pkg, "tool-calls"), { recursive: true });
  writeFileSync(path.join(pkg, "tool-calls", `${reviewer}.jsonl`), `${lines.join("\n")}\n`);
}

const item = async () => (await computeReadiness(pkg)).items.find((entry) => entry.id === "memory-outside-stage")!;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-memory-stage-"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  mkdirSync(pkg, { recursive: true });
  writePackage({ startedAt: "2026-10-15T10:00:00.000Z" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the tenth readiness item", () => {
  test("is item 10, selectable by number or id", () => {
    expect(readinessItemId("10")).toBe("memory-outside-stage");
    expect(readinessItemId("memory-outside-stage")).toBe("memory-outside-stage");
  });

  test("a log that holds only the stage query is ready, with or without a recorded query", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE), line("keryx ctx rg foo src")]);
    expect((await item()).status).toBe("pass");
    writePackage({ startedAt: "2026-10-15T10:00:00.000Z", memoryQuery: "auth middleware session tokens" });
    const recorded = await item();
    expect(recorded.status).toBe("pass");
    expect(recorded.evidence).toContain("auth middleware session tokens");
  });

  test("the stage query repeated verbatim is still the stage", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE), line('keryx  memory search "auth  middleware session tokens" --status accepted --limit 5')]);
    expect((await item()).status).toBe("pass");
  });

  test("an extra orchestrator memory search with another query is blocked, and the repair names the commands", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE), line('keryx memory search "what did we decide about this PR last time" --status accepted')]);
    const blocked = await item();
    expect(blocked.status).toBe("fail");
    expect(blocked.evidence).toContain("1 memory call(s) by the orchestrator outside its memory stage");
    expect(blocked.evidence).toContain("what did we decide about this PR last time");
    expect(blocked.repair).toContain('keryx memory search "<query>" --status accepted');
    expect(blocked.repair).toContain('--waive memory-outside-stage "<operator quote>"');
    expect((await computeReadiness(pkg)).verdict).toBe("NOT READY");
  });

  test("a query that differs from the recorded stage query is outside it, even as the first call", async () => {
    writePackage({ startedAt: "2026-10-15T10:00:00.000Z", memoryQuery: "auth middleware session tokens" });
    writeLog(ORCHESTRATOR_LOG, [line('keryx memory search "something else" --status accepted')]);
    expect((await item()).status).toBe("fail");
  });

  test("a search without --status accepted, a listing and a handoff are outside the stage", async () => {
    writeLog(ORCHESTRATOR_LOG, [line('keryx memory search "auth"'), line("keryx memory list"), JSON.stringify({ name: "mcp__keryx__memory_handoff", input: {} })]);
    const blocked = await item();
    expect(blocked.status).toBe("fail");
    expect(blocked.evidence).toContain("3 memory call(s)");
  });

  test("an MCP memory_search is judged by its query and status", async () => {
    writeLog(ORCHESTRATOR_LOG, [JSON.stringify({ name: "mcp__keryx__memory_search", arguments: { query: "auth middleware session tokens", status: "accepted" } })]);
    expect((await item()).status).toBe("pass");
    writeLog(ORCHESTRATOR_LOG, [JSON.stringify({ name: "mcp__keryx__memory_search", arguments: { query: "auth middleware session tokens", status: "accepted" } }), JSON.stringify({ name: "memory_search", arguments: { query: "remember anything about this?" } })]);
    expect((await item()).status).toBe("fail");
  });

  test("a stage call stamped before the round started is a read that preceded the stage", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE, { time: "2026-10-15T09:00:00.000Z" })]);
    const blocked = await item();
    expect(blocked.status).toBe("fail");
    expect(blocked.evidence).toContain("before the round started");
    writeLog(ORCHESTRATOR_LOG, [line(STAGE, { time: "2026-10-15T10:00:05.000Z" })]);
    expect((await item()).status).toBe("pass");
  });

  test("a reviewer's own memory lookup is not the orchestrator's", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE)]);
    writeLog("review-logic", [line('keryx memory search "retry storms" --status accepted'), line("keryx memory list")]);
    expect((await item()).status).toBe("pass");
  });

  test("without an orchestrator log the item passes and says what it could not see", async () => {
    writeLog("review-logic", [line("keryx memory list")]);
    const passed = await item();
    expect(passed.status).toBe("pass");
    expect(passed.evidence).toContain("could not see the orchestrator's own memory reads");
  });

  test("only the operator's quoted waiver lifts it, and the item no longer fails", async () => {
    writeLog(ORCHESTRATOR_LOG, [line(STAGE), line('keryx memory search "stray"')]);
    await expect(waiveReadiness(pkg, ["memory-outside-stage"], "")).rejects.toThrow("operator's own words");
    await waiveReadiness(pkg, ["10"], "the operator looked at the stray read and accepts it");
    const waived = await item();
    expect(waived.status).toBe("waived");
    expect(waived.waiver?.operatorQuote).toBe("the operator looked at the stray read and accepts it");
    expect((await computeReadiness(pkg)).items.filter((entry) => entry.status === "fail").map((entry) => entry.id)).not.toContain("memory-outside-stage");
  });
});

describe("memoryCalls", () => {
  test("reads a plain command line, a JSON command, and skips calls into other layers", () => {
    const calls = memoryCalls([`${STAGE}`, line("keryx wiki query foo"), line('keryx memory search "x y" --module auth --limit 3'), "keryx ctx rg 'keryx memory search'"].join("\n"));
    expect(calls.map((call) => ({ search: call.search, accepted: call.accepted, query: call.query }))).toEqual([
      { search: true, accepted: true, query: "auth middleware session tokens" },
      { search: true, accepted: false, query: "x y" },
    ]);
  });
});
