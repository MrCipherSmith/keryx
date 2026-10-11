// Flow 422 (AC6): the share of unclassified criteria among flows frozen in the last 7 days, on a fixture
// flows directory and an injected clock.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_DIR, STATUS_FILE, runResearchSync } from "./research-sync";
import { collectFrozenFlows, renderKindShare } from "./research-sync-kinds";

const NOW = new Date("2026-10-11T12:00:00Z");
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-kinds-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function addFlow(id: string, frozenAt: string | null, criteria: string[]): Promise<void> {
  const dir = path.join(root, ".metaproject", "flows", `${id}-fixture`);
  await mkdir(dir, { recursive: true });
  const history = [{ at: "2026-01-01T00:00:00Z", event: "created" }, ...(frozenAt === null ? [] : [{ at: frozenAt, event: "frozen" }])];
  await writeFile(path.join(dir, "flow.json"), JSON.stringify({ id, history }));
  await writeFile(path.join(dir, "acceptance-criteria.md"), criteria.map((text, i) => `- AC${i + 1}: ${text}`).join("\n"));
}

const lines = async (): Promise<string> => renderKindShare(await collectFrozenFlows(root), NOW).join("\n");

test("a week of untagged flows: counts, percentage and a warning", async () => {
  await addFlow("1", "2026-10-10T08:00:00Z", ["a", "b", "c"]);
  await addFlow("2", "2026-10-06T08:00:00Z", ["d", "e [verify: judged]"]);
  const out = await lines();
  expect(out).toContain("flows frozen in the last 7 days: 2 flows, 5 criteria, unclassified 4 (80%)");
  expect(out).toContain("WARNING");
  expect(out).toContain("last `frozen` history entry");
});

test("a tagged week: no warning", async () => {
  await addFlow("1", "2026-10-10T08:00:00Z", ["a [verify: judged]", "b [verify: exec `bun test x`]", "c [verify: none — manual]"]);
  const out = await lines();
  expect(out).toContain("1 flows, 3 criteria, unclassified 0 (0%)");
  expect(out).not.toContain("WARNING");
});

test("exactly 20% unclassified does not warn", async () => {
  await addFlow("1", "2026-10-10T08:00:00Z", ["a", "b [verify: judged]", "c [verify: judged]", "d [verify: judged]", "e [verify: judged]"]);
  const out = await lines();
  expect(out).toContain("unclassified 1 (20%)");
  expect(out).not.toContain("WARNING");
});

test("flows frozen outside the window or never frozen are not counted", async () => {
  await addFlow("1", "2026-10-01T08:00:00Z", ["a", "b"]);
  await addFlow("2", null, ["c"]);
  await addFlow("3", "2026-10-12T08:00:00Z", ["d"]);
  const out = await lines();
  expect(out).toContain("no flows frozen in the last 7 days");
  expect(out).not.toContain("NaN");
  expect(out).not.toContain("WARNING");
});

test("no flows directory at all reads as zero flows frozen", async () => {
  expect(await lines()).toContain("no flows frozen in the last 7 days");
});

test("a frozen flow with zero criteria does not divide by zero", async () => {
  await addFlow("1", "2026-10-10T08:00:00Z", []);
  const out = await lines();
  expect(out).toContain("1 flows, 0 criteria");
  expect(out).not.toContain("NaN");
});

test("the window follows the injected clock", async () => {
  await addFlow("1", "2026-10-10T08:00:00Z", ["a"]);
  const flows = await collectFrozenFlows(root);
  expect(renderKindShare(flows, new Date("2026-10-16T00:00:00Z")).join("\n")).toContain("1 flows, 1 criteria");
  expect(renderKindShare(flows, new Date("2026-10-18T00:00:00Z")).join("\n")).toContain("no flows frozen");
});

test("13 of 64 unclassified prints 20% and does not warn; 14 of 64 prints 22% and warns", async () => {
  const mark = (n: number, tagged: boolean): string[] => Array.from({ length: n }, (_, i) => (tagged ? `t${i} [verify: judged]` : `u${i}`));
  await addFlow("1", "2026-10-10T08:00:00Z", [...mark(13, false), ...mark(51, true)]);
  const at20 = await lines();
  expect(at20).toContain("unclassified 13 (20%)");
  expect(at20).not.toContain("WARNING");
  await rm(path.join(root, ".metaproject"), { recursive: true, force: true });
  await addFlow("1", "2026-10-10T08:00:00Z", [...mark(14, false), ...mark(50, true)]);
  const at22 = await lines();
  expect(at22).toContain("unclassified 14 (22%)");
  expect(at22).toContain("WARNING");
});

// F-001: the sync's own wiring, on a fixture root with injected counts and head (no git, no python).
test("runResearchSync puts the verification-kind section and the WARNING into sync-status.md", async () => {
  const catalog = path.join(root, CATALOG_DIR);
  await mkdir(catalog, { recursive: true });
  await writeFile(path.join(catalog, "part1-counts.json"), JSON.stringify({ commit: "abc1234", flows: 1 }));
  await addFlow("1", "2026-10-10T08:00:00Z", ["a", "b", "c [verify: judged]"]);
  const outcome = await runResearchSync({
    root,
    now: () => NOW,
    headHash: async () => "abc1234",
    runCounts: async () => JSON.stringify({ commit: "abc1234", flows: 1 }),
  });
  expect(outcome.ok).toBe(true);
  const page = await readFile(path.join(catalog, STATUS_FILE), "utf8");
  expect(page).toContain("## Виды проверки (verification kinds)");
  expect(page).toContain("1 flows, 3 criteria, unclassified 2 (67%)");
  expect(page).toContain("WARNING: unclassified share 67%");
});
