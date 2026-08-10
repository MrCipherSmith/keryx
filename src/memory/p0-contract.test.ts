import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import { collectEntries } from "./store";
import { searchEntries } from "./search";
import { createMemoryService } from "./service";
import { assertP0Purity, snapshotProject } from "./p0-test-utils";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-p0-"));
  await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
  return root;
}

const SNAPSHOT_PATHS = [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"];
const SNAPSHOT_OPTIONS = {
  paths: SNAPSHOT_PATHS,
  includeRuntimePaths: [
    ".metaproject/data/memory/artifacts/latest.md",
    ".metaproject/data/memory/artifacts/latest.json",
  ],
};

test("P0-3: default service search is pure under the P1 enforcement gate", async () => {
  const root = await fixtureRoot();
  try {
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const result = await createMemoryService().search({ cwd: root, query: "authority boundary" });
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("markdownPath");
    expect(result).not.toHaveProperty("jsonPath");
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P0-8/P0-9: authority statuses and Valid-To-equals-query-day boundary are explicit", async () => {
  const entries = await collectEntries(FIXTURE);
  expect(entries.map((entry) => entry.status).sort()).toEqual([
    "accepted",
    "accepted",
    "conflict",
    "deprecated",
    "draft",
    "superseded",
  ]);

  for (const status of ["accepted", "draft", "conflict", "deprecated", "superseded"] as const) {
    const results = searchEntries(entries, "authority boundary", { status, asOf: "2026-08-09" }, C, new Date("2026-08-09"));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.entry.status === status)).toBe(true);
  }

  // The as-of interval is [Valid-From, Valid-To), so equality closes the entry.
  const asOf = searchEntries(
    entries,
    "authority boundary",
    { asOf: "2026-08-10", status: "accepted" },
    C,
    new Date("2026-08-10"),
  );
  expect(asOf.map((result) => result.entry.relativePath)).not.toContain("decisions/expired.md");

  // P5 centralizes the exclusive current-query boundary: equality closes the
  // entry just as it does for explicit as-of queries.
  const current = searchEntries(entries, "authority boundary", {}, C, new Date("2026-08-10"));
  const includesBoundary = current.some((result) => result.entry.relativePath === "decisions/expired.md");
  expect(includesBoundary).toBe(false);
});

test("P0-10: pure search no longer exposes or writes legacy report paths", async () => {
  const root = await fixtureRoot();
  try {
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const result = await createMemoryService().search({ cwd: root, query: "authority" });
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(result).not.toHaveProperty("markdownPath");
    expect(result).not.toHaveProperty("jsonPath");
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
