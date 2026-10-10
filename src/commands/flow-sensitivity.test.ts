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
// These deps only serve `init` in setup(); flowCommand builds its own service, and the confirm path under test
// does not depend on the clock, the tracker or the health gate.
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
  test.each([
    ["reverted in abc1234 and saw it fail", true],
    ["see src/flow/ac-kinds.ts", true],
    ["https://example.com/run/1", true],
    ["see ./notes", true],
    ["a/b/c", true],
    ["I reverted it, trust me", false],
    ["abc12", false],
    // Punctuation around a token is not part of it.
    ["(abc1234)", true],
    ["fixed in abc1234.", true],
    ["abc1234, then green", true],
    ["see (src/flow/ac-kinds.ts).", true],
    ["<https://example.com/run/1>", true],
    // Prose that merely looks like evidence.
    ["n/a", false],
    ["pass/fail on revert", false],
    ["and/or", false],
    ["a/b", false],
    ["defaced", false],
    ["deadbeef", false],
    ["...", false],
  ] as const)("%j -> %p", (note, expected) => {
    expect(noteNamesEvidence(note)).toBe(expected);
  });

  test("absence is not evidence", () => {
    expect(noteNamesEvidence(undefined)).toBe(false);
    expect(noteNamesEvidence("")).toBe(false);
  });
});

describe("flow ac confirm sensitivity warning", () => {
  const CONFIRM_CRITERIA = [
    "- AC1: a [verify: exec `bun test a` · sensitive: revert]",
    "- AC2: b [verify: invariant `bun test b` · sensitive: mutation]",
    "- AC3: c [verify: exec `bun test c`]",
    "- AC4: d [verify: judged]",
  ];
  // [label, criterion, --note value (undefined = flag absent), expect a warning]
  const CASES: ReadonlyArray<readonly [string, string, string | undefined, boolean]> = [
    ["noted exec, note with a sha", "AC1", "revert run at abc1234", false],
    ["noted exec, note with a path", "AC1", "see src/flow/ac-kinds.test.ts", false],
    ["noted exec, note with a URL", "AC1", "https://example.com/run/1", false],
    ["noted exec, no --note", "AC1", undefined, true],
    ["noted exec, vague note", "AC1", "n/a", true],
    ["noted invariant, note with a sha", "AC2", "(abc1234)", false],
    ["noted invariant, no evidence in the note", "AC2", "looked fine", true],
    ["plain exec, no --note", "AC3", undefined, false],
    ["judged, no --note", "AC4", undefined, false],
  ];

  test.each(CASES)("%s", async (_label, criterion, note, warns) => {
    const id = await setup(CONFIRM_CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, criterion, ...(note === undefined ? [] : ["--note", note])]);
    const out = logs.join("\n");
    expect(out.includes(`warning: ${criterion} claims sensitive:`)).toBe(warns);
    expect(out).toContain("Confirmed");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("the warning names the claimed sensitivity", async () => {
    const id = await setup(CONFIRM_CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, "AC1"]);
    expect(logs.join("\n")).toContain("warning: AC1 claims sensitive: revert, but --note names no evidence of the revert run");
  });
});
