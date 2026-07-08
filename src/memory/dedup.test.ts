import { test, expect } from "bun:test";
import { findConflicts, findDuplicates, type Candidate } from "./dedup";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import type { MemoryEntry } from "./types";

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "x.md",
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

function candidate(over: Partial<Candidate>): Candidate {
  return {
    title: "",
    summary: "",
    type: "lesson",
    tags: [],
    scopes: { module: null, entity: null, files: [] },
    ...over,
  };
}

test("detects a near-duplicate by title similarity", () => {
  const existing = [entry({ relativePath: "a.md", title: "Prefer Bun for scripts" })];
  const dupes = findDuplicates(candidate({ title: "Prefer Bun for scripts" }), existing, C);
  expect(dupes.length).toBe(1);
  expect(dupes[0]?.path).toBe("a.md");
});

test("distinct titles are not duplicates", () => {
  const existing = [entry({ relativePath: "a.md", title: "Prefer Bun for scripts", summary: "alpha" })];
  const dupes = findDuplicates(candidate({ title: "Use Postgres for storage", summary: "beta" }), existing, C);
  expect(dupes.length).toBe(0);
});

test("flags a conflict for a decision overlapping an accepted decision", () => {
  const existing = [
    entry({ relativePath: "d.md", type: "decision", status: "accepted", title: "Use X", tags: ["pipelines"], scopes: { module: "pipelines", entity: null, files: [], skills: [] } }),
  ];
  const conflicts = findConflicts(
    candidate({ title: "Use Y instead", type: "decision", tags: ["pipelines"], scopes: { module: "pipelines", entity: null, files: [] } }),
    existing,
  );
  expect(conflicts.length).toBe(1);
});

test("lessons never conflict; draft decisions are not conflict targets", () => {
  const acceptedDecision = [entry({ type: "decision", status: "accepted", scopes: { module: "p", entity: null, files: [], skills: [] } })];
  const draftDecision = [entry({ type: "decision", status: "draft", scopes: { module: "p", entity: null, files: [], skills: [] } })];
  expect(findConflicts(candidate({ type: "lesson", scopes: { module: "p", entity: null, files: [] } }), acceptedDecision).length).toBe(0);
  expect(findConflicts(candidate({ type: "decision", scopes: { module: "p", entity: null, files: [] } }), draftDecision).length).toBe(0);
});
