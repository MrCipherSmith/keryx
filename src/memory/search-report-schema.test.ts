import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import { renderMemorySearchReport } from "./report";
import { searchEntries } from "./search";
import type { MemoryEntry } from "./types";

// AFC-25 / AC6: the checked-in schema is the contract the compressed/handoff
// shape must be validated against. If it still declares `additionalProperties:
// false` with only the pre-AFC-25 seven fields, it contradicts the shape
// `renderMemorySearchReport`/`validateMemorySearchReport` (report.ts) actually
// produce and accept -- a schema that would reject every real report. This
// test compares the schema, field by field, against what the (unedited)
// validator in report.ts actually does, not against a guess.

const SCHEMA_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-memory-reliability",
  "schemas",
  "memory-search-report.schema.json",
);

type ResultSchema = {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { enum?: string[]; anyOf?: unknown[]; required?: string[]; additionalProperties?: boolean }>;
};

function loadResultSchema(): ResultSchema {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as { $defs: { result: ResultSchema } };
  return schema.$defs.result;
}

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

test("AFC-25: schema result definition accepts exactly the fields renderMemorySearchReport produces", () => {
  const known = afc25Entry({ relativePath: "decisions/known.md" });
  const scored = searchEntries([known], "adopt bun", {}, C, new Date("2026-08-10"));
  const report = renderMemorySearchReport({
    runId: "schema-sync-known",
    generatedAt: new Date("2026-08-10T00:00:00.000Z"),
    search: { schemaVersion: 1, query: "adopt bun", results: scored },
    filters: {},
  });
  const result = report.results[0];
  expect(result).toBeDefined();

  const resultSchema = loadResultSchema();
  const producedKeys = Object.keys(result as object).sort();
  expect(resultSchema.additionalProperties).toBe(false);
  // Every field the validator actually requires is schema-required, and
  // nothing else is -- a stale/short required list is exactly the defect.
  expect([...resultSchema.required].sort()).toEqual(producedKeys);
  for (const key of producedKeys) {
    expect(resultSchema.properties).toHaveProperty(key);
  }
});

test("AFC-25: schema accepts the unknown-sentinel/null shape produced for an unsourced entry", () => {
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
    runId: "schema-sync-unsourced",
    generatedAt: new Date("2026-08-10T00:00:00.000Z"),
    search: { schemaVersion: 1, query: "adopt bun", results: scored },
    filters: {},
  });
  const result = report.results[0];
  expect(result).toBeDefined();
  expect(result?.version).toBe("unknown");
  expect(result?.scope).toBe("unknown");
  expect(result?.provenance).toEqual({ source: "unknown", link: "unknown" });
  expect(result?.author).toBe("unknown");
  expect(result?.confirmedBy).toBe("unknown");
  expect(result?.caveat).toBeNull();

  const resultSchema = loadResultSchema();
  expect(resultSchema.properties.confidence?.enum).toEqual(["low", "medium", "high"]);
  expect(resultSchema.properties.caveat?.anyOf).toBeDefined();
  expect([...(resultSchema.properties.provenance?.required ?? [])].sort()).toEqual(["link", "source"]);
  expect(resultSchema.properties.provenance?.additionalProperties).toBe(false);
});
