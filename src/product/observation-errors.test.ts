// A line beginning `outcome-observed:` with no recognized verdict is a parse
// failure, not a silent no-op and not a hidden intent: the index names the flow,
// `keryx product index` exits non-zero, and the flow stays in the `open` queue,
// so a typo can never make an intent disappear.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { buildIntentIndex } from "./corpus";
import { FIXTURE_COUNTS, copyFixtureRepo } from "./fixtures/repo";
import { buildOpenReport, loadOpenReport, openHeaderLines, renderIndexSummary } from "./service";
import { checkStaleness, writeIntentIndex } from "./store";

const roots: string[] = [];
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

const FLOW = "001-2026-01-01-stated-outcome";
const FLOW_PATH = `.metaproject/flows/${FLOW}`;

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function journalLine(root: string, line: string, flow = FLOW): Promise<void> {
  await appendFile(path.join(root, ".metaproject", "flows", flow, "journal.md"), `${line}\n`);
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const MALFORMED = [
  ["the old free-text form", "outcome-observed: 2026-02-15 expired-token errors fell to zero"],
  ["an empty line", "outcome-observed:"],
  ["a verdict nobody defined", "outcome-observed: worked — errors fell"],
  ["a verdict with no note", "outcome-observed: helped"],
  ["a verdict with an empty note", "outcome-observed: helped —"],
  ["a hyphen where the em dash goes", "outcome-observed: helped - errors fell"],
] as const;

describe("a malformed observation line", () => {
  for (const [label, line] of MALFORMED) {
    test(`${label} is a failure naming the flow`, async () => {
      const root = await project();
      await journalLine(root, line);
      const index = await buildIntentIndex(root);
      expect(index.failures).toHaveLength(1);
      expect(index.failures[0]).toStartWith(`${FLOW_PATH}/journal.md: outcome-observed line has no recognized verdict`);
      expect(index.failures[0]).toContain("helped|no-effect|harmed|inconclusive");
    });
  }

  test("the flow stays an intent, unobserved and in the open queue", async () => {
    const root = await project();
    const before = buildOpenReport(await buildIntentIndex(root));
    await journalLine(root, MALFORMED[0][1]);
    const index = await buildIntentIndex(root);
    const flow = index.intents.find((intent) => intent.id === "001");
    expect(flow?.outcome).toMatchObject({ observed: false, verdict: null, observedAt: null, note: null });
    const report = buildOpenReport(index);
    expect(report.entries.map((entry) => entry.id)).toContain("001");
    expect(report.neverChecked).toBe(before.neverChecked);
    expect(report.observed).toBe(before.observed);
    expect(report.failures).toBe(1);
  });

  test("a flow that is both an intent and a failure is not counted twice", async () => {
    const root = await project();
    await journalLine(root, MALFORMED[1][1]);
    const index = await buildIntentIndex(root);
    expect(index.counts.flows).toBe(FIXTURE_COUNTS.flows);
    expect(index.intents).toHaveLength(FIXTURE_COUNTS.intents);
    await writeIntentIndex(root, index);
    expect(await checkStaleness(root, index)).toEqual({ stale: false });
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(true);
  });

  test("the index still reads as stale, with a count reason, when a flow is added", async () => {
    const root = await project();
    await journalLine(root, MALFORMED[1][1]);
    const index = await buildIntentIndex(root);
    await Bun.write(path.join(root, ".metaproject", "flows", "006-2026-01-06-added", "flow.json"), "{}");
    const staleness = await checkStaleness(root, index);
    expect(staleness.stale).toBe(true);
    if (staleness.stale) expect(staleness.reason).toBe(`the index holds ${FIXTURE_COUNTS.flows} flows, the tree ${FIXTURE_COUNTS.flows + 1}`);
  });

  test("the header and the summary show the failure count, and only when there is one", async () => {
    const root = await project();
    expect(openHeaderLines(buildOpenReport(await buildIntentIndex(root))).join("\n")).not.toContain("parse failures");
    await journalLine(root, MALFORMED[0][1]);
    const index = await buildIntentIndex(root);
    expect(openHeaderLines(buildOpenReport(index))).toContain("  index parse failures: 1 (`keryx product index` lists them)");
    expect(renderIndexSummary(index, "index.json")).toContain(`parse failures: 1\n    ${FLOW_PATH}/journal.md:`);
  });

  test("`keryx product index` exits non-zero, names the flow, and still writes the index", async () => {
    const root = await project();
    await journalLine(root, MALFORMED[0][1]);
    process.chdir(root);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    process.exitCode = 0;
    await productCommand(["index"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain(`${FLOW_PATH}/journal.md`);
    expect((await loadOpenReport(root)).ok).toBe(true);
  });

  test("a clean tree still exits zero", async () => {
    const root = await project();
    process.chdir(root);
    console.log = () => undefined;
    process.exitCode = 0;
    await productCommand(["index"]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("fixing the line clears the failure and observes the flow", async () => {
    const root = await project();
    await journalLine(root, "outcome-observed: helped — 2026-02-15 errors fell to zero", FLOW);
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([]);
    expect(index.intents.find((intent) => intent.id === "001")?.outcome.verdict).toBe("helped");
  });
});
