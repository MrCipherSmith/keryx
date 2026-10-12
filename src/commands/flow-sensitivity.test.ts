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
  // The label needs a word boundary before it that is not a hyphen: `no-evidence:` is not the label.
  test.each([
    ["evidence: abc1234", true],
    ["revert run; Evidence: https://x/y", true],
    ["EVIDENCE: logs/run.log", true],
    ["evidence:abc1234", true],
    ["evidence: n/a; evidence: abc1234", true],
    [undefined, false],
    ["", false],
    ["abc1234 reverted", false],
    ["evidence:", false],
    ["evidence:   ", false],
    ["evidence: n/a", false],
    ["evidence: NA", false],
    ["evidence: none", false],
    ["evidence: -", false],
    ["evidence: TBD", false],
    ["evidence: todo; other", false],
    ["evidence: n/a.", false],
    ["evidence: none.", false],
    ["Evidence: TODO.", false],
    ["evidence: `n/a`", false],
    ["evidence: (none)", false],
    ["`evidence:` n/a", false],
    ["evidence: —", false],
    ["evidence: <ref>", false],
    ["evidence: ref", false],
    ["no-evidence: x", false],
    ["noevidence: x", false],
  ] as const)("%j -> %p", (note, expected) => {
    expect(noteNamesEvidence(note)).toBe(expected);
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
    ["noted exec, labelled sha", "AC1", "evidence: abc1234 revert run", false],
    ["noted exec, labelled path after text", "AC1", "ran it; Evidence: logs/run.log", false],
    ["noted exec, labelled URL", "AC1", "EVIDENCE: https://example.com/run/1", false],
    ["noted exec, sha without the label", "AC1", "revert run at abc1234", true],
    ["noted exec, no --note", "AC1", undefined, true],
    ["noted exec, placeholder reference", "AC1", "evidence: n/a", true],
    ["noted invariant, labelled sha", "AC2", "evidence:abc1234", false],
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
    expect(logs.join("\n")).toContain("warning: AC1 claims sensitive: revert, but --note has no \"evidence: <ref>\" (e.g. evidence: abc1234 revert run)");
  });
});
