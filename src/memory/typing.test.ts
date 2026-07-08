import { test, expect } from "bun:test";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import { searchEntries } from "./search";
import {
  MEMORY_CLASS_MAP,
  MEMORY_CLASS_VALUES,
  MEMORY_TYPE_VALUES,
  memoryClassOf,
} from "./types";
import type { MemoryEntry } from "./types";

// AC-C7: MEMORY_CLASS_MAP maps every MEMORY_TYPES kind to exactly one valid
// class (total coverage), and `--class` retrieval returns only that class.

test("MEMORY_CLASS_MAP totally covers MEMORY_TYPE_VALUES with a valid class", () => {
  for (const type of MEMORY_TYPE_VALUES) {
    const cls = MEMORY_CLASS_MAP[type];
    expect(cls).toBeDefined();
    if (!cls) {
      continue;
    }
    expect(MEMORY_CLASS_VALUES).toContain(cls);
  }
  // No stray keys that are not real memory types.
  for (const key of Object.keys(MEMORY_CLASS_MAP)) {
    expect(MEMORY_TYPE_VALUES).toContain(key);
  }
});

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "x.md",
    type: "lesson",
    title: "cache",
    version: "1.0.0",
    status: "accepted",
    confidence: "high",
    summary: "cache invalidation guidance",
    details: "",
    tags: ["cache"],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: null, link: null },
    ...over,
  };
}

test("--class prefilter returns only entries of that resolved class (AC-C7)", () => {
  const semantic = entry({ relativePath: "decisions/d.md", type: "decision" });
  const procedural = entry({ relativePath: "patterns/p.md", type: "pattern" });
  const episodic = entry({ relativePath: "lessons/l.md", type: "lesson" });

  const results = searchEntries(
    [semantic, procedural, episodic],
    "cache",
    { class: "procedural" },
    C,
    new Date("2026-07-08"),
  );
  expect(results.map((r) => r.entry.relativePath)).toEqual(["patterns/p.md"]);
  expect(results.every((r) => memoryClassOf(r.entry) === "procedural")).toBe(true);
});

test("explicit Class header overrides the type-mapped class", () => {
  const overridden = entry({ type: "lesson", class: "procedural" });
  expect(memoryClassOf(overridden)).toBe("procedural");
  const defaulted = entry({ type: "lesson" });
  expect(memoryClassOf(defaulted)).toBe("episodic");
});
