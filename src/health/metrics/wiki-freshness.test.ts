// LWG-15 freshness health metric (flow 228): AC2, AC3, AC4, AC5, AC6, AC8.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  freshnessReportPath,
  readWikiFreshnessMetric,
  renderWikiFreshnessLine,
} from "./wiki-freshness";

const NOW = new Date("2026-09-04T12:00:00Z");
const now = () => NOW;

async function project(report?: unknown, generatedAt = "2026-09-04T11:00:00Z"): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-health-"));
  if (report !== undefined) {
    const file = freshnessReportPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const body =
      typeof report === "string"
        ? report
        : JSON.stringify({ generatedAt, ...(report as Record<string, unknown>) });
    await writeFile(file, body);
  }
  return cwd;
}

const TOTALS = { pagesTotal: 50, pagesFresh: 34, pagesUndecidable: 6 };

describe("absence is reported, never rounded (AC3)", () => {
  test("no report yields no number and says why", async () => {
    const metric = await readWikiFreshnessMetric(await project(), { now });
    expect(metric.status).toBe("no-report");
    expect(metric.ratio).toBeUndefined();
    expect(metric.pagesFresh).toBeUndefined();
    // The dangerous alternative is 100% fresh from an absent report.
    expect(metric.reason).toContain("not evidence that the wiki is fresh");
    expect(renderWikiFreshnessLine(metric)).toContain("not measured");
  });

  test("unparseable JSON is treated as absent, with a reason (AC6)", async () => {
    const metric = await readWikiFreshnessMetric(await project("{ truncated"), { now });
    expect(metric.status).toBe("unreadable-report");
    expect(metric.ratio).toBeUndefined();
  });

  test("a report missing its totals yields no partial number (AC6)", async () => {
    const metric = await readWikiFreshnessMetric(await project({ totals: {} }), { now });
    expect(metric.status).toBe("unreadable-report");
    expect(metric.pagesTotal).toBeUndefined();
  });
});

describe("measurement (AC2, AC4)", () => {
  test("reports the counts and a ratio over SCORABLE pages", async () => {
    const cwd = await project({
      totals: TOTALS,
      pages: [
        { confidence: "must-refresh" },
        { confidence: "review-suggested" },
        { confidence: "fyi" },
      ],
    });
    const metric = await readWikiFreshnessMetric(cwd, { now });

    expect(metric.status).toBe("measured");
    expect(metric.pagesTotal).toBe(50);
    expect(metric.pagesFresh).toBe(34);
    expect(metric.pagesUndecidable).toBe(6);
    // 34 of 44 scorable, NOT 34 of 50: counting pages it cannot judge would
    // flatter the figure, and calling them stale would accuse them of a fault
    // nobody established.
    expect(metric.ratio).toBeCloseTo(34 / 44, 5);
    // `fyi` rows are advisory and are not "needing attention".
    expect(metric.actionable).toBe(2);
  });

  test("the rendered line shows the excluded count so the ratio cannot hide it", async () => {
    const cwd = await project({ totals: TOTALS, pages: [] });
    const line = renderWikiFreshnessLine(await readWikiFreshnessMetric(cwd, { now }));
    expect(line).toContain("34/44");
    expect(line).toContain("6 undecidable (excluded)");
  });

  test("a corpus with nothing scorable yields no ratio rather than dividing by zero", async () => {
    const cwd = await project({ totals: { pagesTotal: 6, pagesFresh: 0, pagesUndecidable: 6 }, pages: [] });
    const metric = await readWikiFreshnessMetric(cwd, { now });
    expect(metric.status).toBe("measured");
    expect(metric.ratio).toBeUndefined();
  });
});

describe("stale evidence (AC5)", () => {
  test("an old report keeps its numbers but is marked as not current", async () => {
    const cwd = await project({ totals: TOTALS, pages: [] }, "2026-08-01T00:00:00Z");
    const metric = await readWikiFreshnessMetric(cwd, { now, staleAfterDays: 7 });

    expect(metric.status).toBe("stale-evidence");
    // The numbers survive — they are the last thing known — but the status
    // says they are not today's state.
    expect(metric.pagesFresh).toBe(34);
    expect(metric.reportAgeDays).toBe(34);
    expect(renderWikiFreshnessLine(metric)).toContain("STALE EVIDENCE");
  });

  test("a fresh report is not marked stale", async () => {
    const cwd = await project({ totals: TOTALS, pages: [] });
    expect((await readWikiFreshnessMetric(cwd, { now })).status).toBe("measured");
  });

  test("staleAfterDays 0 disables the check", async () => {
    const cwd = await project({ totals: TOTALS, pages: [] }, "2020-01-01T00:00:00Z");
    expect((await readWikiFreshnessMetric(cwd, { now, staleAfterDays: 0 })).status).toBe("measured");
  });
});

describe("cost (AC8)", () => {
  test("works with no graph and no wiki present at all", async () => {
    // The honest form of "reads one file": the metric resolves in a project
    // that has NO graph storage and NO wiki directory. If it consulted either,
    // this would fail — and `health run` would be starting a traversal it has
    // no business doing.
    const cwd = await project({ totals: TOTALS, pages: [{ confidence: "must-refresh" }] });
    const metric = await readWikiFreshnessMetric(cwd, { now });

    expect(metric.status).toBe("measured");
    expect(metric.actionable).toBe(1);
    // Nothing but the report file was ever created in this project.
    const entries = await readdir(path.join(cwd, ".metaproject"));
    expect(entries).toEqual(["data"]);
  });

  test("a wiki full of pages does not change the numbers — they come from the report", async () => {
    const cwd = await project({ totals: TOTALS, pages: [] });
    await mkdir(path.join(cwd, ".metaproject", "wiki", "components"), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(cwd, ".metaproject", "wiki", "components", `p${index}.md`), "# P\n");
    }
    const metric = await readWikiFreshnessMetric(cwd, { now });
    // 50, from the report — not 20, from the directory.
    expect(metric.pagesTotal).toBe(50);
  });
});
