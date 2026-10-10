// Flow 422 T7: `flow freeze` warns about criteria with no verification kind, asks a
// human (TTY only) whether to freeze anyway, and journals the warning otherwise.
// Only an explicit interactive "no" stops it; nothing else ever refuses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps, TrackerAdapter } from "../flow/types";
import { flowCommand, freezePromptIo } from "./flow";

const realIo = { ...freezePromptIo };
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

async function setup(criteria: string[]): Promise<{ id: string; dir: string }> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-freeze-kind-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  const { flow, dir } = await createFlowService(deps).init({ cwd: ROOT, title: "Unmarked" });
  const flowDir = path.join(ROOT, ".metaproject", "flows", path.basename(dir));
  await Bun.write(
    path.join(flowDir, "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", ...criteria, ""].join("\n"),
  );
  process.chdir(ROOT);
  return { id: flow.id, dir: flowDir };
}

async function status(id: string): Promise<string> {
  return (await createFlowService(deps).get({ cwd: ROOT, id })).status;
}

const MIXED = [
  "- AC1: Has a kind [verify: judged]",
  "- AC2: Plain wording",
  "- AC3: Another [verify: none — human]",
  "- AC4: More plain wording",
];

function capture(): string[] {
  const logs: string[] = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  return logs;
}

afterEach(async () => {
  console.log = realLog;
  Object.assign(freezePromptIo, realIo);
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

describe("flow freeze with criteria that have no verification kind", () => {
  test("non-interactive: warns naming both, never prompts, freezes, journals the warning", async () => {
    const { id, dir } = await setup(MIXED);
    let asked = 0;
    freezePromptIo.interactive = () => false;
    freezePromptIo.ask = async () => {
      asked += 1;
      return false;
    };
    const logs = capture();
    await flowCommand(["freeze", id]);
    expect(logs.join("\n")).toContain("no verification kind on AC2, AC4");
    expect(asked).toBe(0);
    expect(await status(id)).toBe("ready");
    const journal = await readFile(path.join(dir, "journal.md"), "utf8");
    expect(journal).toMatch(/- \d{4}-\d\d-\d\dT[\d:.]+Z - warning: no verification kind on AC2, AC4/);
  });

  test("interactive yes: asks the question naming both, freezes, journals the operator's decision", async () => {
    const { id, dir } = await setup(MIXED);
    const questions: string[] = [];
    freezePromptIo.interactive = () => true;
    freezePromptIo.ask = async (q) => {
      questions.push(q);
      return true;
    };
    capture();
    await flowCommand(["freeze", id]);
    expect(questions).toEqual(["freeze without a verification kind on AC2, AC4? [y/N] "]);
    expect(await status(id)).toBe("ready");
    const journal = await readFile(path.join(dir, "journal.md"), "utf8");
    expect(journal).toContain("operator froze without a verification kind on AC2, AC4");
  });

  test("interactive no: the freeze is abandoned and the flow is unchanged", async () => {
    const { id } = await setup(MIXED);
    const before = await status(id);
    freezePromptIo.interactive = () => true;
    freezePromptIo.ask = async () => false;
    const logs = capture();
    await flowCommand(["freeze", id]);
    expect(logs.join("\n")).toContain("no verification kind on AC2, AC4");
    expect(before).not.toBe("ready");
    expect(await status(id)).toBe(before);
  });

  test("fully marked criteria: no warning and no prompt", async () => {
    const { id } = await setup(["- AC1: a [verify: judged]", "- AC2: b [verify: none — human]"]);
    let asked = 0;
    freezePromptIo.interactive = () => true;
    freezePromptIo.ask = async () => {
      asked += 1;
      return false;
    };
    const logs = capture();
    await flowCommand(["freeze", id]);
    expect(asked).toBe(0);
    expect(logs.join("\n")).not.toContain("no verification kind");
    expect(await status(id)).toBe("ready");
  });
});
