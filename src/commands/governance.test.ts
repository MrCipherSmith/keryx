// Acceptance layer W0, AC7 — `governance report` shows acceptance coverage per
// flow, and a flow predating verification kinds reads as fully `unclassified`
// rather than as zero criteria.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps } from "../flow/types";
import { renderAcceptanceLine } from "../governance/report";
import { summarizeAcceptance } from "../governance/accountability";
import { governanceCommand } from "./governance";

let ROOT = "";
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;

function deps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-09-28T10:00:00Z"),
  };
}

afterEach(async () => {
  console.log = realLog;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) await rm(ROOT, { recursive: true, force: true });
  ROOT = "";
});

async function makeFlow(title: string, criteria: string[]): Promise<{ id: string; dir: string }> {
  const service = createFlowService(deps());
  const { flow, dir } = await service.init({ cwd: ROOT, title });
  const name = path.basename(dir);
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", name, "acceptance-criteria.md"),
    ["# Acceptance Criteria", "", "## Criteria", "", ...criteria, ""].join("\n"),
    "utf8",
  );
  await service.freeze({ cwd: ROOT, id: flow.id });
  return { id: flow.id, dir: name };
}

/** Rewrite flow.json as it was before verification kinds existed: no `acKinds` field. */
async function stripAcKinds(dir: string): Promise<void> {
  const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
  const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete state["acKinds"];
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function runReport(args: string[]): Promise<string> {
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  process.chdir(ROOT);
  await governanceCommand(["report", ...args]);
  console.log = realLog;
  return lines.join("\n");
}

async function freshProject(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-gov-acceptance-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
}

describe("governance report: acceptance coverage", () => {
  test("a classified flow shows runnable over total and every kind's count", async () => {
    await freshProject();
    const { id } = await makeFlow("Classified", [
      "- AC1: runs [verify: exec `bun test a`]",
      "- AC2: holds [verify: invariant `bun test b`]",
      "- AC3: read by a human [verify: judged]",
      "- AC4: unverifiable [verify: none — a judgement]",
      "- AC5: unmarked",
    ]);
    const out = await runReport(["--flow", id]);
    expect(out).toContain(
      "acceptance coverage: 2/5 runnable (40%) — exec 1, invariant 1, judged 1, none 1, unclassified 1",
    );
  });

  test("a flow predating this package reads as fully unclassified, not as zero criteria", async () => {
    await freshProject();
    const { id, dir } = await makeFlow("Legacy", ["- AC1: one", "- AC2: two", "- AC3: three"]);
    await stripAcKinds(dir);
    const out = await runReport(["--flow", id]);
    expect(out).toContain("acceptance coverage: 0/3 runnable (0%) — all 3 unclassified (predates verification kinds)");
    expect(out).not.toContain("0/0 runnable");
    expect(out).not.toMatch(/none [1-9]/);
  });

  test("--json carries recorded: false and the file's criterion count for a legacy flow", async () => {
    await freshProject();
    const { id, dir } = await makeFlow("Legacy json", ["- AC1: one", "- AC2: two"]);
    await stripAcKinds(dir);
    const json = JSON.parse(await runReport(["--flow", id, "--json"])) as {
      projects: Array<{ flows: Array<{ acceptance: { recorded: boolean; total: number; counts: Record<string, number>; runnable: number } }> }>;
    };
    const acceptance = json.projects[0]?.flows[0]?.acceptance;
    expect(acceptance?.recorded).toBe(false);
    expect(acceptance?.total).toBe(2);
    expect(acceptance?.counts).toEqual({ exec: 0, invariant: 0, judged: 0, none: 0, unclassified: 2 });
    expect(acceptance?.runnable).toBe(0);
  });

  test("reporting is read-only: the flow file is untouched", async () => {
    await freshProject();
    const { id, dir } = await makeFlow("Read only", ["- AC1: one [verify: judged]"]);
    await stripAcKinds(dir);
    const file = path.join(ROOT, ".metaproject", "flows", dir, "flow.json");
    const before = await readFile(file, "utf8");
    await runReport(["--flow", id]);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

describe("summarizeAcceptance and renderAcceptanceLine", () => {
  const base = { id: "1" } as never;

  test("absent acKinds with an unreadable criteria file keeps the total unknown, never zero", () => {
    const summary = summarizeAcceptance(base, undefined);
    expect(summary.recorded).toBe(false);
    expect(summary.total).toBeUndefined();
    expect(renderAcceptanceLine(summary)).toContain("not recorded");
    expect(renderAcceptanceLine(summary)).not.toContain("0/0");
  });

  test("an unfrozen flow reads not frozen yet; a frozen flow with no kinds predates them", () => {
    const draft = summarizeAcceptance({ id: "1", acChecksum: null } as never, 3);
    expect(draft.frozen).toBe(false);
    expect(renderAcceptanceLine(draft)).toContain("not frozen yet");
    expect(renderAcceptanceLine(draft)).not.toContain("predates");
    const legacy = summarizeAcceptance({ id: "1", acChecksum: "sha256:abc" } as never, 3);
    expect(legacy.frozen).toBe(true);
    expect(renderAcceptanceLine(legacy)).toContain("predates verification kinds");
  });

  test("a report stored before the field existed renders as not recorded", () => {
    expect(renderAcceptanceLine(undefined)).toContain("not recorded");
  });

  test("a recorded but empty map is zero criteria, which is a different fact from absent", () => {
    const summary = summarizeAcceptance({ id: "1", acKinds: {} } as never, 7);
    expect(summary.recorded).toBe(true);
    expect(summary.total).toBe(0);
  });
});
