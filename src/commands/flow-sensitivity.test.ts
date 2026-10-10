// Flow 423 T5: `flow ac kinds` prints the sensitivity line (and --json carries the counts), and
// `flow ac confirm` warns, never refuses, when a sensitivity claim has no evidence in --note.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../flow/types";
import { flowCommand, noteNamesEvidence } from "./flow";

const realLog = console.log;
const ORIGINAL_CWD = process.cwd();
let ROOT = "";

const tracker: TrackerAdapter = {
  id: "fake",
  detect: async () => true,
  parseRef: () => null,
  fetchIssue: async () => ({ title: "t", body: "b" }),
  prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: "d".repeat(40) }),
  comment: async () => true,
};
const deps: FlowServiceDeps = {
  tracker,
  healthGate: async () => ({ status: "pass", reasons: [] }),
  now: () => new Date("2026-10-10T10:00:00Z"),
};

const CRITERIA = [
  "- AC1: a [verify: exec `bun test a` · sensitive: revert]",
  "- AC2: b [verify: invariant `bun test b`; sensitive: mutation]",
  "- AC3: c [verify: exec `bun test c`]",
  "- AC4: d [verify: judged]",
];

async function setup(criteria: string[]): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-sensitivity-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const { flow, dir } = await createFlowService(deps).init({ cwd: ROOT, title: "Sens" });
  const flowDir = path.join(ROOT, ".metaproject", "flows", path.basename(dir));
  await Bun.write(path.join(flowDir, "acceptance-criteria.md"), ["# Acceptance Criteria", "", "## Criteria", "", ...criteria, ""].join("\n"));
  process.chdir(ROOT);
  return flow.id;
}

function capture(): string[] {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  return logs;
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

describe("flow ac kinds sensitivity line", () => {
  test("text output counts proven and unproven runnable criteria", async () => {
    const id = await setup(CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "kinds", id]);
    expect(logs.join("\n")).toContain("sensitivity: 2 of 3 runnable proven (revert 1, mutation 1) · 1 unproven");
  });

  test("--json carries the counts", async () => {
    const id = await setup(CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "kinds", id, "--json"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.sensitivity).toEqual({ proven: 2, unproven: 1, byValue: { revert: 1, mutation: 1, "failure-scenario": 0 } });
    expect(parsed.criteria.AC1.sensitivity).toBe("revert");
  });
});

describe("noteNamesEvidence", () => {
  test("accepts a sha, a path with a slash, a URL; rejects prose and absence", () => {
    expect(noteNamesEvidence("reverted in abc1234 and saw it fail")).toBe(true);
    expect(noteNamesEvidence("see src/flow/ac-kinds.ts")).toBe(true);
    expect(noteNamesEvidence("https://example.com/run/1")).toBe(true);
    expect(noteNamesEvidence("I reverted it, trust me")).toBe(false);
    expect(noteNamesEvidence("abc12")).toBe(false);
    expect(noteNamesEvidence(undefined)).toBe(false);
  });
});

describe("flow ac confirm sensitivity warning", () => {
  test("warns but confirms when --note is absent", async () => {
    const id = await setup(CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, "AC1"]);
    const out = logs.join("\n");
    expect(out).toContain("warning: AC1 claims sensitive: revert, but --note names no evidence of the revert run");
    expect(out).toContain("Confirmed");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("warns when the note holds no evidence reference", async () => {
    const id = await setup(CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, "AC2", "--note", "looked fine"]);
    expect(logs.join("\n")).toContain("warning: AC2 claims sensitive: mutation");
  });

  test("no warning with evidence, without a sensitivity claim, or on other kinds", async () => {
    const id = await setup(CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, "AC1", "--note", "revert run at abc1234"]);
    await flowCommand(["ac", "confirm", id, "AC3"]);
    await flowCommand(["ac", "confirm", id, "AC4"]);
    const out = logs.join("\n");
    expect(out).not.toContain("warning:");
    expect(out.match(/Confirmed/g)?.length).toBe(3);
  });
});
