import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  createMemoryReportStore,
  renderMemorySearchReport,
  validateMemorySearchReport,
} from "./report";
import { createMemoryService } from "./service";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-report-"));
  await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
  return root;
}

test("P1-3: report DTO is bounded, portable, and schema-valid", async () => {
  const root = await fixtureRoot();
  try {
    const search = await createMemoryService().search({ cwd: root, query: "authority boundary" });
    const report = renderMemorySearchReport({
      runId: "report-unit-1",
      generatedAt: new Date("2026-08-10T00:00:00.000Z"),
      search,
      filters: { limit: 100 },
    });
    expect(validateMemorySearchReport(report)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain("absolutePath");
    expect(JSON.stringify(report)).not.toContain("details");
    expect(report.results).toHaveLength(Math.min(search.results.length, 100));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P1-4/P1-9: report store publishes immutable unique runs and removes interrupted staging", async () => {
  const root = await fixtureRoot();
  try {
    const search = await createMemoryService().search({ cwd: root, query: "authority boundary" });
    const store = createMemoryReportStore({
      clock: () => new Date(),
      runId: (() => {
        let sequence = 0;
        return () => `report-${++sequence}`;
      })(),
    });
    const interrupted = path.join(root, ".metaproject", "runtime", "memory", "tmp", "interrupted");
    await mkdir(interrupted, { recursive: true });
    await writeFile(path.join(interrupted, "partial.json"), "{", "utf8");
    const stale = new Date(Date.now() - 120_000);
    await utimes(interrupted, stale, stale);
    const first = await store.writeReport({ cwd: root, search, filters: {} });
    const second = await store.writeReport({ cwd: root, search, filters: {} });
    expect(first.runId).not.toBe(second.runId);
    expect(first.markdownPath).toBe(".metaproject/runtime/memory/search/report-1/report.md");
    expect(JSON.parse(await readFile(path.join(root, first.jsonPath), "utf8"))).toMatchObject({ runId: "report-1" });
    await expect(store.writeReport({ cwd: root, search, filters: {}, runId: "report-1" })).rejects.toThrow("already exists");
    expect(await readdir(path.join(root, ".metaproject", "runtime", "memory", "tmp"))).toEqual([]);
    const concurrent = await Promise.allSettled([
      createMemoryReportStore().writeReport({ cwd: root, search, filters: {}, runId: "concurrent" }),
      createMemoryReportStore().writeReport({ cwd: root, search, filters: {}, runId: "concurrent" }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
