import { test, expect } from "bun:test";
import { searchEntries, renderSearchMarkdown } from "./search";
import { acceptedCurrentSearchFilters } from "./relevant";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import type { MemoryEntry } from "./types";

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "lessons/x.md",
    type: "lesson",
    title: "",
    version: "0.1.0",
    status: "draft",
    confidence: "medium",
    summary: "",
    details: "",
    tags: [],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: null, link: null },
    ...over,
  };
}

test("ranks relevant entries and drops non-matching", () => {
  const relevant = entry({ relativePath: "lessons/bun.md", status: "accepted", title: "Prefer Bun", summary: "use bun runtime for scripts" });
  const other = entry({ relativePath: "lessons/other.md", status: "accepted", title: "Something else", summary: "unrelated content here" });
  const results = searchEntries([relevant, other], "bun runtime", {}, C, new Date("2026-07-07"));
  expect(results.length).toBe(1);
  expect(results[0]?.entry.relativePath).toBe("lessons/bun.md");
});

test("status filter restricts results", () => {
  const accepted = entry({ relativePath: "a.md", status: "accepted", title: "bun", summary: "bun" });
  const draft = entry({ relativePath: "b.md", status: "draft", title: "bun", summary: "bun" });
  const results = searchEntries([accepted, draft], "bun", { status: "accepted" }, C, new Date());
  expect(results.length).toBe(1);
  expect(results[0]?.entry.status).toBe("accepted");
});

test("module and entity filters restrict results", () => {
  const pipelineStep = entry({
    relativePath: "a.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "pipelines", entity: "step", files: [], skills: [] },
  });
  const pipelineStore = entry({
    relativePath: "b.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "pipelines", entity: "store", files: [], skills: [] },
  });
  const analyticsStep = entry({
    relativePath: "c.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "analytics", entity: "step", files: [], skills: [] },
  });

  const results = searchEntries(
    [pipelineStore, analyticsStep, pipelineStep],
    "step",
    { module: "pipelines", entity: "step" },
    C,
    new Date(),
  );

  expect(results.map((result) => result.entry.relativePath)).toEqual(["a.md"]);
});

test("accepted/high-confidence outranks draft/low at equal relevance", () => {
  // AC1 (defect 2): the default `current` query now requires `accepted`
  // status, so a draft entry no longer surfaces under the plain default —
  // ranking accepted-vs-draft together requires the explicit historical
  // mode (`asOf`), matching the policy's "history only via an explicit,
  // fully-status-labelled mode".
  const now = new Date("2026-01-01T00:00:00.000Z");
  const accepted = entry({ relativePath: "a.md", status: "accepted", confidence: "high", title: "bun tip", summary: "bun tip" });
  const draft = entry({ relativePath: "b.md", status: "draft", confidence: "low", title: "bun tip", summary: "bun tip" });
  const results = searchEntries([draft, accepted], "bun tip", { asOf: "2026-01-01" }, C, now);
  expect(results[0]?.entry.relativePath).toBe("a.md");
});

// AFC-25 / AC6: an absent source must be explicitly visible as "unknown" in
// rendered output, never a silently-omitted line a reader would read as "no
// provenance to report".
test("AFC-25: renderSearchMarkdown shows an explicit unknown source instead of dropping the line", () => {
  const unsourced = entry({
    relativePath: "decisions/unsourced.md",
    status: "accepted",
    title: "bun tip",
    summary: "bun tip",
    provenance: { source: null, link: null },
  });
  const results = searchEntries([unsourced], "bun tip", {}, C, new Date());
  const markdown = renderSearchMarkdown("bun tip", results);
  expect(markdown).toContain("provenance: unknown");
});

// AFC-06 (flow 234, T14, defect 2): `temporalMatch`'s default-current branch
// never required `status === "accepted"` — only an explicit `status` filter
// did. A plain default search could return a deprecated entry as current.
test("AC1 defect 2: default current query excludes deprecated status even without an explicit filter", () => {
  const deprecated = entry({ relativePath: "d.md", status: "deprecated", title: "bun tip", summary: "bun tip" });
  const results = searchEntries([deprecated], "bun tip", {}, C, new Date());
  expect(results.length).toBe(0);
});

// The override guard (AC1): a caller-supplied status filter is a deliberate
// override of the default accepted-only requirement above, and must keep
// returning the requested non-accepted status.
test("AC1 override guard: an explicit status filter still returns the requested non-accepted status", () => {
  const deprecated = entry({ relativePath: "d.md", status: "deprecated", title: "bun tip", summary: "bun tip" });
  const results = searchEntries([deprecated], "bun tip", { status: "deprecated" }, C, new Date());
  expect(results.length).toBe(1);
  expect(results[0]?.entry.status).toBe("deprecated");
});

// T20 finding 1 (flow 234 review, BLOCKER): `acceptedCurrentSearchFilters`
// (relevant.ts) always sets BOTH `status: "accepted"` and
// `asOf: currentDay(now)`. Before the fix, `temporalMatch`'s truthy-`asOf`
// branch short-circuited to `isValidAt` alone, before either the
// `hasStatusFilter` guard or the lifecycle branch ran -- so an
// `accepted`-status entry with a broken/dangling `supersededBy` pointer
// passed straight through on exactly the filter shape `flow init`'s
// "Related Memory" section uses (`src/flow/context.ts`), even though the
// same entry is correctly rejected by a plain default search (no `asOf`) a
// few lines below in this same file.
test("T20 finding 1: acceptedCurrentSearchFilters rejects an accepted entry with a broken supersession chain", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const brokenChain = entry({
    relativePath: "decisions/broken-chain.md",
    status: "accepted",
    title: "widget rollout",
    summary: "widget rollout",
    supersededBy: "decisions/nonexistent-replacement.md",
  });
  const filters = acceptedCurrentSearchFilters(now, { limit: 5 });
  const results = searchEntries([brokenChain], "widget rollout", filters, C, now);
  expect(results.map((r) => r.entry.relativePath)).not.toContain("decisions/broken-chain.md");
});

// The historical-query half of the same fix: a properly-modeled superseded
// entry (`supersedeEntry`, `supersede.ts`, always flips `Status` to
// `"superseded"` in the SAME write that sets `Superseded-By` -- it never
// leaves an entry `"accepted"` with a live pointer) must still answer a
// bare `asOf` historical question ("was this valid on this past date,
// regardless of status") through plain interval validity. The finding 1 fix
// is scoped to `entry.status === "accepted"` specifically so it does not
// touch this case.
test("T20 finding 1: a bare asOf (no status filter) still answers a historical question for a properly-superseded entry", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const properlySuperseded = entry({
    relativePath: "decisions/later-superseded.md",
    status: "superseded",
    title: "widget rollout",
    summary: "widget rollout",
    validFrom: "2025-06-01",
    validTo: "2025-12-01",
    supersededBy: "decisions/replacement.md",
  });
  const results = searchEntries([properlySuperseded], "widget rollout", { asOf: "2025-07-01" }, C, now);
  expect(results.map((r) => r.entry.relativePath)).toContain("decisions/later-superseded.md");
});

// The self-contradictory state itself must never be admitted, on ANY path,
// not just the `acceptedCurrentSearchFilters` shape covered above: even a
// bare `asOf` with no status filter must reject an entry whose own status is
// still `"accepted"` while it carries a live `supersededBy` pointer -- that
// combination is not a legitimate historical fact, it is the broken/
// dangling-chain anomaly this finding exists to close.
test("T20 finding 1: a bare asOf still rejects the self-contradictory accepted+supersededBy state", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const brokenChain = entry({
    relativePath: "decisions/broken-chain.md",
    status: "accepted",
    title: "widget rollout",
    summary: "widget rollout",
    supersededBy: "decisions/nonexistent-replacement.md",
  });
  const results = searchEntries([brokenChain], "widget rollout", { asOf: "2026-01-01" }, C, now);
  expect(results.map((r) => r.entry.relativePath)).not.toContain("decisions/broken-chain.md");
});
