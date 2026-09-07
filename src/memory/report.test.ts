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
import { searchEntries } from "./search";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import type { MemoryEntry } from "./types";

function afc25Entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "decisions/x.md",
    type: "decision",
    title: "adopt bun for scripts",
    version: "1.2.0",
    status: "accepted",
    confidence: "medium",
    summary: "adopt bun runtime for scripts",
    details: "",
    tags: [],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: "pr#412", link: "https://example.invalid/pr/412" },
    author: "author:bob",
    confirmedBy: "reviewer:alice",
    caveat: "rollout deferred to Q3 pending security sign-off",
    ...over,
  };
}

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

// AFC-25 / AC6: compression (search -> renderMemorySearchReport) preserves the
// exact source fragment/version, author, scope, and confirming participant
// rather than dropping them because the compressed shape doesn't declare the
// field.
test("AFC-25: compression preserves version, scope, provenance, author, and confirming participant", () => {
  const known = afc25Entry({
    relativePath: "decisions/known.md",
    scopes: { module: "release-pipeline", entity: "canary", files: [], skills: [] },
  });
  const scored = searchEntries([known], "adopt bun", {}, C, new Date("2026-08-10"));
  const report = renderMemorySearchReport({
    runId: "afc25-known",
    generatedAt: new Date("2026-08-10T00:00:00.000Z"),
    search: { schemaVersion: 1, query: "adopt bun", results: scored },
    filters: {},
  });
  expect(validateMemorySearchReport(report)).toEqual([]);
  const result = report.results[0];
  expect(result).toBeDefined();
  expect(result?.version).toBe("1.2.0");
  expect(result?.scope).toBe("module:release-pipeline, entity:canary");
  expect(result?.provenance).toEqual({ source: "pr#412", link: "https://example.invalid/pr/412" });
  expect(result?.author).toBe("author:bob");
  expect(result?.confirmedBy).toBe("reviewer:alice");
  expect(result?.caveat).toBe("rollout deferred to Q3 pending security sign-off");
});

// AFC-25 / AC6: an absent source becomes the explicit "unknown" sentinel, not
// a dropped/empty field that a reader could mistake for "nothing to report".
test("AFC-25: absent source/author/confirming participant/scope surfaces as explicit unknown, not silently dropped", () => {
  const unsourced = afc25Entry({
    relativePath: "decisions/unsourced.md",
    provenance: { source: null, link: null },
    author: null,
    confirmedBy: null,
    version: null,
    caveat: null,
  });
  const scored = searchEntries([unsourced], "adopt bun", {}, C, new Date("2026-08-10"));
  const report = renderMemorySearchReport({
    runId: "afc25-unsourced",
    generatedAt: new Date("2026-08-10T00:00:00.000Z"),
    search: { schemaVersion: 1, query: "adopt bun", results: scored },
    filters: {},
  });
  expect(validateMemorySearchReport(report)).toEqual([]);
  const result = report.results[0];
  expect(result?.version).toBe("unknown");
  expect(result?.scope).toBe("unknown");
  expect(result?.provenance).toEqual({ source: "unknown", link: "unknown" });
  expect(result?.author).toBe("unknown");
  expect(result?.confirmedBy).toBe("unknown");
  expect(result?.caveat).toBeNull();
});

// AFC-25 / AC6: claimType is carried verbatim from entry.type through the
// compression stage; a high vs. low model confidence never changes it — the
// score/confidence ranks results, it never promotes a hypothesis into a
// decision or an instruction.
test("AFC-25 confidence probe: claimType survives compression unchanged by confidence", () => {
  const lowConfidence = afc25Entry({ relativePath: "decisions/low.md", confidence: "low", status: "draft" });
  const highConfidence = afc25Entry({ relativePath: "decisions/high.md", confidence: "high", status: "draft" });
  const scored = searchEntries(
    [lowConfidence, highConfidence],
    "adopt bun",
    { status: "draft" },
    C,
    new Date("2026-08-10"),
  );
  const report = renderMemorySearchReport({
    runId: "afc25-confidence",
    generatedAt: new Date("2026-08-10T00:00:00.000Z"),
    search: { schemaVersion: 1, query: "adopt bun", results: scored },
    filters: {},
  });
  expect(report.results).toHaveLength(2);
  for (const result of report.results) {
    // Same entry.type ("decision") regardless of confidence, and status stays
    // "draft" (a hypothesis) -- confidence never promotes it to "accepted".
    expect(result.claimType).toBe("decision");
    expect(result.status).toBe("draft");
  }
  const low = report.results.find((r) => r.path === "decisions/low.md");
  const high = report.results.find((r) => r.path === "decisions/high.md");
  expect(low?.confidence).toBe("low");
  expect(high?.confidence).toBe("high");
  expect(low?.claimType).toBe(high?.claimType);
});
