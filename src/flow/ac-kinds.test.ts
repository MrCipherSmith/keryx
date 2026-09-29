// Acceptance layer W0, AC1 — `keryx flow ac kinds <id>` parses a criteria file
// holding all four markers plus one unmarked line and reports exec, invariant,
// judged, none and unclassified, with the counts and the per-criterion records
// the specification's data contracts define.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand } from "../commands/flow";
import { parseAcceptanceCriteria } from "./check-ac";
import {
  buildAcKindReport,
  describeAcKind,
  parseAcKindText,
  parseAcKinds,
  readAcKindRecords,
  renderAcKindDistribution,
  stripVerifyMarker,
} from "./ac-kinds";
import { createFlowService } from "./service";
import type { FlowServiceDeps } from "./types";

const ALL_KINDS = [
  "# Acceptance Criteria",
  "",
  "## Criteria",
  "",
  "- AC1: The command runs [verify: exec `bun test src/a.test.ts`]",
  "- AC2: The invariant holds [verify: invariant `bun test src/b.test.ts`]",
  "- AC3: A human reads the result [verify: judged]",
  "- AC4: A writing-ergonomics call [verify: none — no check can settle it]",
  "- AC5: Frozen before the marker existed",
  "",
].join("\n");

describe("parseAcKinds — all four markers and one unmarked line", () => {
  const parsed = parseAcKinds(ALL_KINDS);

  test("reports each kind with its record", () => {
    expect(parsed.errors).toEqual([]);
    const byId = Object.fromEntries(parsed.criteria.map((c) => [c.id, c.record]));
    expect(byId["AC1"]).toEqual({ kind: "exec", check: "bun test src/a.test.ts" });
    expect(byId["AC2"]).toEqual({ kind: "invariant", check: "bun test src/b.test.ts" });
    expect(byId["AC3"]).toEqual({ kind: "judged" });
    expect(byId["AC4"]).toEqual({ kind: "none", reason: "no check can settle it" });
    expect(byId["AC5"]).toEqual({ kind: "unclassified" });
  });

  test("an unmarked criterion is unclassified, never none", () => {
    expect(parseAcKindText("Plain prose criterion").record).toEqual({ kind: "unclassified" });
    expect(parseAcKindText("").record).toEqual({ kind: "unclassified" });
  });

  test("the report carries the counts, the runnable total and the criterion total", () => {
    const { report, errors } = buildAcKindReport("361", ALL_KINDS);
    expect(errors).toEqual([]);
    expect(report.flowId).toBe("361");
    expect(report.counts).toEqual({ exec: 1, invariant: 1, judged: 1, none: 1, unclassified: 1 });
    expect(report.runnable).toBe(2);
    expect(report.total).toBe(5);
    expect(Object.keys(report.criteria)).toEqual(["AC1", "AC2", "AC3", "AC4", "AC5"]);
  });

  test("a criterion's text loses only its trailing marker", () => {
    const first = parsed.criteria[0];
    expect(first?.text).toBe("The command runs");
    expect(first?.rawText).toBe("The command runs [verify: exec `bun test src/a.test.ts`]");
    expect(stripVerifyMarker("Frozen before the marker existed")).toBe("Frozen before the marker existed");
  });

  test("a marker quoted in backticks is prose, not a marker", () => {
    const text = "A second `[verify: …]` marker is an error [verify: judged]";
    expect(parseAcKindText(text).record).toEqual({ kind: "judged" });
    expect(stripVerifyMarker(text)).toBe("A second `[verify: …]` marker is an error");
    expect(parseAcKindText("Quotes `[verify: judged]` only in prose").record).toEqual({ kind: "unclassified" });
  });

  test("a bracket inside the marker command does not end the marker early", () => {
    const record = parseAcKindText("Greps a class [verify: exec `grep -q '[a-z]' file.md`]").record;
    expect(record).toEqual({ kind: "exec", check: "grep -q '[a-z]' file.md" });
  });

  test("the line rule agrees with the one check-ac.ts uses", () => {
    const fromCheckAc = parseAcceptanceCriteria(ALL_KINDS).map((c) => c.id);
    expect(parsed.criteria.map((c) => c.id)).toEqual(fromCheckAc);
  });
});

describe("rendering", () => {
  test("the distribution block names every kind and the coverage", () => {
    const { report } = buildAcKindReport("361", ALL_KINDS);
    const lines = renderAcKindDistribution(report);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("exec 1  invariant 1  judged 1  none 1  unclassified 1");
    expect(lines[0]).toContain("(5 criteria)");
    expect(lines[1]).toContain("2/5 runnable (40%)");
    expect(lines[1]).toContain("1 accepted as unverifiable");
    expect(lines[1]).toContain("1 unclassified");
  });

  test("a flow with no criteria renders 0% rather than dividing by zero", () => {
    const { report } = buildAcKindReport("x", "# nothing\n");
    expect(renderAcKindDistribution(report)[1]).toContain("0/0 runnable (0%)");
  });

  test("describeAcKind gives one line per record", () => {
    expect(describeAcKind({ kind: "exec", check: "bun test x" })).toBe("exec `bun test x`");
    expect(describeAcKind({ kind: "none", reason: "why" })).toBe("none — why");
    expect(describeAcKind({ kind: "judged" })).toBe("judged");
    expect(describeAcKind({ kind: "unclassified" })).toBe("unclassified");
  });

  test("readAcKindRecords reads a persisted map back and refuses a malformed one", () => {
    const { report } = buildAcKindReport("361", ALL_KINDS);
    expect(readAcKindRecords(JSON.parse(JSON.stringify(report.criteria)))).toEqual(report.criteria);
    expect(readAcKindRecords(undefined)).toBeUndefined();
    expect(readAcKindRecords([])).toBeUndefined();
    expect(readAcKindRecords({ AC1: { kind: "exec" } })).toBeUndefined();
    expect(readAcKindRecords({ AC1: { kind: "bogus" } })).toBeUndefined();
  });
});

// The command, end to end: `flowCommand(["ac", "kinds", ...])` over a real frozen flow.
let ROOT = "";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;
let logs: string[] = [];
let errs: string[] = [];

function deps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-28T10:00:00Z"),
  };
}

async function frozenFlow(criteria: string): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-ac-kinds-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService(deps());
  const { flow, dir } = await service.init({ cwd: ROOT, title: "Kinds fixture" });
  await Bun.write(path.join(ROOT, ".metaproject", "flows", path.basename(dir), "acceptance-criteria.md"), criteria);
  await service.freeze({ cwd: ROOT, id: flow.id });
  return flow.id;
}

function capture(): void {
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void errs.push(args.map(String).join(" "));
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("keryx flow ac kinds", () => {
  test("--json prints the report with all five kinds and exits zero", async () => {
    const id = await frozenFlow(ALL_KINDS);
    process.chdir(ROOT);
    capture();
    await flowCommand(["ac", "kinds", id, "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const out = JSON.parse(logs.join("\n")) as {
      counts: Record<string, number>;
      runnable: number;
      total: number;
      criteria: Record<string, { kind: string }>;
      errors: unknown[];
    };
    expect(out.counts).toEqual({ exec: 1, invariant: 1, judged: 1, none: 1, unclassified: 1 });
    expect(out.runnable).toBe(2);
    expect(out.total).toBe(5);
    expect(out.criteria["AC4"]?.kind).toBe("none");
    expect(out.errors).toEqual([]);
  });

  test("the text form lists each criterion and the distribution", async () => {
    const id = await frozenFlow(ALL_KINDS);
    process.chdir(ROOT);
    capture();
    await flowCommand(["ac", "kinds", id]);
    const text = logs.join("\n");
    expect(process.exitCode ?? 0).toBe(0);
    expect(text).toContain("AC1");
    expect(text).toContain("exec `bun test src/a.test.ts`");
    expect(text).toContain("none — no check can settle it");
    expect(text).toContain("acceptance kinds: exec 1");
    expect(text).toContain("2/5 runnable");
  });

  test("the freeze persisted the derived acKinds on flow.json", async () => {
    const id = await frozenFlow(ALL_KINDS);
    const flow = await createFlowService(deps()).get({ cwd: ROOT, id });
    expect(flow.acKinds?.["AC1"]).toEqual({ kind: "exec", check: "bun test src/a.test.ts" });
    expect(flow.acKinds?.["AC5"]).toEqual({ kind: "unclassified" });
  });
});
