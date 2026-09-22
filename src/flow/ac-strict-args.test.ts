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
