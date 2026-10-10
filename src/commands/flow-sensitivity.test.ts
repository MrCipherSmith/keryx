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
  await Bun.write(path.join(ROOT, "README.md"), "# fixture\n");
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
  const ROOT_DIR = "/repo";
  const FILES = new Set(["/repo/README.md", "/repo/Makefile", "/repo/lib/foo", "/repo/src/flow/a.ts", "/tmp/x"]);
  const DIRS = new Set(["/repo/src", "/repo/docs", "/repo/src/flow"]);
  const fixtureExists = (p: string): "file" | "dir" | null => (FILES.has(p) ? "file" : DIRS.has(p) ? "dir" : null);
  test.each([
    ["reverted in abc1234 and saw it fail", true],
    ["abc1234", true],
    ["(abc1234)", true],
    ["abc1234.", true],
    ["abc1234…", true],
    ["abc1234..def5678", true],
    ["abc1234...def5678", true],
    ["https://x/y", true],
    ["<https://x>", true],
    ["README.md", true],
    ["src", false],
    ["docs", false],
    ["src/flow", true],
    ["(src/flow/)", true],
    ["src/flow/)", true],
    ["Makefile", true],
    ["lib/foo", true],
    ["src\\flow\\a.ts", true],
    ["/tmp/x", true],
    ["logs/run.log", true],
    ["see (logs/run.log).", true],
    ["n/a", false],
    ["n/a/", false],
    ["pass/fail", false],
    ["pass/fail/skip", false],
    ["and/or", false],
    ["e.g./i.e.", false],
    ["defaced", false],
    ["deadbeef", false],
    ["1234567", false],
    ["20261011", false],
    ["took 1234567 ms", false],
    ["I reverted it, trust me", false],
    ["abc12", false],
    ["foo/bar", false],
    ["...", false],
  ] as const)("%j -> %p", (note, expected) => {
    expect(noteNamesEvidence(note, ROOT_DIR, fixtureExists)).toBe(expected);
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
    ["noted exec, note with an existing path", "AC1", "see README.md", false],
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

  // `flow` subcommands locate the flow under the cwd, so `ac confirm` itself cannot run from a subdirectory; the
  // evidence check still resolves against the git toplevel, which is what this pins (default root, real filesystem).
  test("a root-relative path from a subdirectory is evidence", async () => {
    await setup(CONFIRM_CRITERIA);
    await mkdir(path.join(ROOT, ".git"), { recursive: true });
    await mkdir(path.join(ROOT, "pkg", "deep"), { recursive: true });
    process.chdir(path.join(ROOT, "pkg", "deep"));
    expect(noteNamesEvidence("see README.md")).toBe(true);
    expect(noteNamesEvidence("see pkg/deep")).toBe(true);
    expect(noteNamesEvidence("see pkg")).toBe(false);
  });

  test("the warning names the claimed sensitivity", async () => {
    const id = await setup(CONFIRM_CRITERIA);
    const logs = capture();
    await flowCommand(["ac", "confirm", id, "AC1"]);
    expect(logs.join("\n")).toContain("warning: AC1 claims sensitive: revert, but --note names no evidence of the revert run");
  });
});
