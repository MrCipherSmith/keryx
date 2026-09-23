// Flow 293, AC3 — every `keryx flow ac` subcommand refuses an argument it
// does not use (an extra positional, `--text` without `--criterion`,
// `--criterion` without `--text`, or an unknown flag) instead of dropping it
// silently and reporting success.
//
// The concrete regression: `keryx flow ac update <id> AC1 --text "…"
// --reason "…"` printed "Acceptance criteria re-frozen" and changed nothing
// but the checksum and history — `AC1` fell out of `requireId`'s scan
// unnoticed, and `--text` had no consumer at all. Two real flows ended up
// with amendments recorded in `history` that never reached
// `acceptance-criteria.md`. Driven through `flowCommand` (not the service
// directly), because the defect was in the CLI's argument handling, not in
// `FlowService`.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { flowCommand } from "../commands/flow";
import type { FlowServiceDeps, TrackerAdapter } from "./types";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();
let errors: string[] = [];
const realError = console.error;
const realLog = console.log;

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true }),
    comment: async () => true,
  };
}

function makeDeps(over: Partial<FlowServiceDeps> = {}): FlowServiceDeps {
  return {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-22T10:00:00Z"),
    ...over,
  };
}

async function freshFrozenFlow(): Promise<{ id: string; dir: string; acFile: string }> {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
  }
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-ac-strict-args-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const service = createFlowService(makeDeps());
  const { flow, dir: created } = await service.init({ cwd: ROOT, title: "AC strict args test" });
  const dir = path.basename(created);
  const acFile = path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md");
  await Bun.write(acFile, "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n");
  await service.freeze({ cwd: ROOT, id: flow.id });
  return { id: flow.id, dir, acFile };
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

function captureErrors(): void {
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = () => {};
}

let logs: string[] = [];

/** Like {@link captureErrors}, but also keeps `console.log` output instead of discarding it. */
function captureLogsAndErrors(): void {
  errors = [];
  logs = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

async function flowJsonAcState(dir: string): Promise<{ acChecksum: unknown; acConfirmed: unknown }> {
  const raw = JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "flows", dir, "flow.json"), "utf8"),
  ) as { acChecksum: unknown; acConfirmed: unknown };
  return { acChecksum: raw.acChecksum, acConfirmed: raw.acConfirmed };
}

test("AC3: `ac update <id> AC1 --text ... --reason ...` (the pre-293 syntax) is refused, and nothing changes", async () => {
  const { id, dir, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  const before = await readFile(acFile, "utf8");
  const beforeState = await flowJsonAcState(dir);

  captureErrors();
  await flowCommand(["ac", "update", id, "AC1", "--text", "Rewritten", "--reason", "trying the old syntax"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("AC1");

  const after = await readFile(acFile, "utf8");
  const afterState = await flowJsonAcState(dir);
  expect(after).toBe(before);
  expect(afterState).toEqual(beforeState);
});

test("AC3: `ac update` refuses --text without --criterion", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  const before = await readFile(acFile, "utf8");

  captureErrors();
  await flowCommand(["ac", "update", id, "--text", "Rewritten", "--reason", "why"]);

  expect(process.exitCode).toBe(1);
  expect(await readFile(acFile, "utf8")).toBe(before);
});

test("AC3: `ac update` refuses --criterion without --text", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  const before = await readFile(acFile, "utf8");

  captureErrors();
  await flowCommand(["ac", "update", id, "--criterion", "AC1", "--reason", "why"]);

  expect(process.exitCode).toBe(1);
  expect(await readFile(acFile, "utf8")).toBe(before);
});

test("AC3: `ac update` refuses an unknown flag", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  const before = await readFile(acFile, "utf8");

  captureErrors();
  await flowCommand(["ac", "update", id, "--reason", "why", "--force"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--force");
  expect(await readFile(acFile, "utf8")).toBe(before);
});

test("AC3: `ac update --criterion/--text` still works when given correctly", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "update", id, "--criterion", "AC1", "--text", "Rewritten text", "--reason", "why"]);

  expect(process.exitCode).toBe(0);
  expect(await readFile(acFile, "utf8")).toContain("- AC1: Rewritten text");
});

test("AC3: `ac confirm` refuses an extra positional", async () => {
  const { id } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "confirm", id, "AC1", "extra"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("extra");
});

test("AC3: `ac confirm` refuses an unknown flag", async () => {
  const { id } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "confirm", id, "AC1", "--bogus", "value"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--bogus");
});

test("AC3: `ac reseal` refuses an extra positional", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  const before = await readFile(acFile, "utf8");

  captureErrors();
  await flowCommand(["ac", "reseal", id, "extra", "--reason", "why"]);

  expect(process.exitCode).toBe(1);
  expect(await readFile(acFile, "utf8")).toBe(before);
});

test("AC3: `ac reseal` refuses an unknown flag", async () => {
  const { id } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "reseal", id, "--reason", "why", "--yolo"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--yolo");
});

// Flow 293 T9, review finding #4: a value flag's VALUE can legitimately start
// with `--` (quoted shell text). The two-pass version disagreed with itself
// — the strict check and `optionValue` used different "is the next token a
// value" heuristics — so this exact confirm was refused as an unrecognised
// flag, misleadingly, and blocked a legitimate confirm.
test("review #4: `ac confirm --note` consumes a value that itself starts with --, instead of misreading it as an unknown flag", async () => {
  const { id, dir } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "confirm", id, "AC1", "--note", "--dry-run mode was used"]);

  expect(process.exitCode).toBe(0);
  expect(errors.join("\n")).toBe("");
  const { acConfirmed } = await flowJsonAcState(dir);
  const confirmed = acConfirmed as Record<string, { note?: string }>;
  expect(confirmed["AC1"]?.note).toBe("--dry-run mode was used");
});

test("review #4: `ac confirm --note=value` (the = form) still works", async () => {
  const { id, dir } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "confirm", id, "AC1", "--note=evidence text"]);

  expect(process.exitCode).toBe(0);
  const { acConfirmed } = await flowJsonAcState(dir);
  const confirmed = acConfirmed as Record<string, { note?: string }>;
  expect(confirmed["AC1"]?.note).toBe("evidence text");
});

// The one case that IS still refused: the next token is itself one of this
// subcommand's own known flags, which means the value was actually omitted
// (`--note --signed-by "x"` is someone who forgot the note text), not text
// that happens to look like a flag.
test("review #4: `ac confirm --note` with no value (next token is a known flag) is refused as a missing value, not consumed", async () => {
  const { id } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "confirm", id, "AC1", "--note", "--signed-by", "Priya"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("missing value for --note");
});

test("review #4: `ac update --reason` also consumes a value starting with --, and `ac reseal --reason` too", async () => {
  const { id } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureErrors();
  await flowCommand(["ac", "update", id, "--reason", "--dry-run mode was used"]);
  expect(process.exitCode).toBe(0);

  captureErrors();
  await flowCommand(["ac", "reseal", id, "--reason", "--still a valid reason"]);
  // Nothing is actually stale here (update above already re-sealed), so this
  // specific call fails on ITS OWN business rule ("nothing is stale") — not
  // on argument parsing. That is the point: the failure is not "unknown
  // option --still a valid reason".
  expect(errors.join("\n")).not.toContain("unknown option");
});

// The wording bug (flow 294, AC5's small extra): `ac update --criterion
// ACn --text …` printed "ACn rewritten" unconditionally, even when ACn was
// the NEXT UNUSED criterion and the call therefore APPENDED a new line to
// acceptance-criteria.md rather than replacing an existing one.
test("`ac update --criterion <existing> --text ...` prints \"rewritten\", not \"appended\"", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureLogsAndErrors();
  await flowCommand(["ac", "update", id, "--criterion", "AC1", "--text", "Rewritten text", "--reason", "why"]);

  expect(process.exitCode).toBe(0);
  expect(await readFile(acFile, "utf8")).toContain("- AC1: Rewritten text");
  expect(logs.join("\n")).toContain("AC1 rewritten");
  expect(logs.join("\n")).not.toContain("AC1 appended");
});

test("`ac update --criterion <next unused> --text ...` prints \"appended\", not \"rewritten\"", async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);
  // freshFrozenFlow seeds only AC1, so AC2 is the next unused criterion.
  const before = await readFile(acFile, "utf8");
  expect(before).not.toContain("AC2");

  captureLogsAndErrors();
  await flowCommand(["ac", "update", id, "--criterion", "AC2", "--text", "New criterion", "--reason", "scope grew"]);

  expect(process.exitCode).toBe(0);
  expect(await readFile(acFile, "utf8")).toContain("- AC2: New criterion");
  expect(logs.join("\n")).toContain("AC2 appended");
  expect(logs.join("\n")).not.toContain("AC2 rewritten");
});

// Review of PR #658, finding 2: `runAc` decided "appended" vs "rewritten" by
// `criterion.toUpperCase()` alone, with no `.trim()` — while the service's
// own `validateCriterionName` (what `acUpdate` actually validates
// `--criterion` with) trims first. A `--criterion " AC1 "` padded with
// incidental whitespace therefore never matched any entry of the clean
// `known` list (`"AC1"`, `"AC2"`, …) and was reported "appended" even though
// it was about to REWRITE the existing AC1 line. Fixed by having
// `acCriterionKnown` (service.ts) normalize through the same
// `validateCriterionName` `acUpdate` uses, instead of re-deriving a second,
// slightly different rule in the CLI layer.
test('`ac update --criterion " AC1 " ...` (padded with whitespace) still reports "rewritten", matching the service\'s own trim+uppercase normalization', async () => {
  const { id, acFile } = await freshFrozenFlow();
  process.chdir(ROOT);

  captureLogsAndErrors();
  await flowCommand(["ac", "update", id, "--criterion", " AC1 ", "--text", "Rewritten text", "--reason", "why"]);

  expect(process.exitCode).toBe(0);
  expect(await readFile(acFile, "utf8")).toContain("- AC1: Rewritten text");
  expect(logs.join("\n")).toContain("AC1 rewritten");
  expect(logs.join("\n")).not.toContain("AC1 appended");
});
