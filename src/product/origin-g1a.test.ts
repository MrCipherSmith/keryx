// Flow 390, AC6 — G1a in product is computed by origin x (real criterion | not
// measured). A flow without an origin, or with one this build cannot read, counts
// as unknown.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex } from "./corpus";
import { copyFixtureRepo } from "./fixtures/repo";
import { g1aByOrigin, g1aLines } from "./by-origin";
import { buildOpenReport, renderOpen } from "./service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function setOrigin(root: string, dir: string, origin: unknown): Promise<void> {
  const file = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw["origin"] = origin;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

// The fixture: 001 and 002 state a real criterion; 003, 004 and 005 do not.
const REAL_001 = "001-2026-01-01-stated-outcome";
const NONE_003 = "003-2026-01-03-no-criterion";

describe("G1a by origin", () => {
  test("flows without an origin all count as unknown, split by real criterion and not measured", async () => {
    const rows = g1aByOrigin(await buildIntentIndex(await fixtureRoot()));
    expect(rows).toEqual([
      { origin: "human-request", criterion: 0, notMeasured: 0 },
      { origin: "agent-finding", criterion: 0, notMeasured: 0 },
      { origin: "agent-proposal", criterion: 0, notMeasured: 0 },
      { origin: "unknown", criterion: 2, notMeasured: 3 },
    ]);
  });

  test("each flow is counted under its own origin, by whether it states a real criterion", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, REAL_001, { kind: "human-request", quote: "q", source: "chat 1" });
    await setOrigin(root, NONE_003, { kind: "agent-finding", source: "ci" });
    await setOrigin(root, "004-2026-01-04-in-progress", { kind: "agent-proposal", source: "talk" });
    const rows = g1aByOrigin(await buildIntentIndex(root));
    const byOrigin = new Map(rows.map((row) => [row.origin, row]));
    expect(byOrigin.get("human-request")).toEqual({ origin: "human-request", criterion: 1, notMeasured: 0 });
    expect(byOrigin.get("agent-finding")).toEqual({ origin: "agent-finding", criterion: 0, notMeasured: 1 });
    expect(byOrigin.get("agent-proposal")).toEqual({ origin: "agent-proposal", criterion: 0, notMeasured: 1 });
    // 002 (a criterion) and 005 (none) carry no origin.
    expect(byOrigin.get("unknown")).toEqual({ origin: "unknown", criterion: 1, notMeasured: 1 });
    const total = rows.reduce((sum, row) => sum + row.criterion + row.notMeasured, 0);
    expect(total).toBe(5);
  });

  test("an origin kind this build cannot read counts as unknown", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, REAL_001, { kind: "robot", quote: "q" });
    const unknown = g1aByOrigin(await buildIntentIndex(root)).find((row) => row.origin === "unknown");
    expect(unknown).toEqual({ origin: "unknown", criterion: 2, notMeasured: 3 });
  });

  test("requirements packages are not counted: only flows are", async () => {
    const rows = g1aByOrigin(await buildIntentIndex(await fixtureRoot()));
    expect(rows.reduce((sum, row) => sum + row.criterion + row.notMeasured, 0)).toBe(5);
  });
});

describe("the G1a table", () => {
  test("is part of the open report and of its rendering", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, REAL_001, { kind: "human-request", quote: "q", source: "chat 1" });
    const report = buildOpenReport(await buildIntentIndex(root));
    expect(report.g1a?.find((row) => row.origin === "human-request")).toEqual({ origin: "human-request", criterion: 1, notMeasured: 0 });
    const rendered = renderOpen(report);
    expect(rendered).toContain("G1a by origin (flows with a real criterion / not measured):");
    expect(rendered).toContain("  human-request: 1 real criterion, 0 not measured");
    expect(rendered).toContain("  unknown: 1 real criterion, 3 not measured");
  });

  test("prints nothing when there are no flows", () => {
    expect(g1aLines(undefined)).toEqual([]);
    expect(
      g1aLines([
        { origin: "human-request", criterion: 0, notMeasured: 0 },
        { origin: "unknown", criterion: 0, notMeasured: 0 },
      ]),
    ).toEqual([]);
  });
});
