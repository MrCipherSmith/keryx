// Wires the agent-first-core proposed contracts (flow 238, phase 6, T9 — AC4/
// AC-32 schema boundary, AC6/AC-M06 export audit) to the deterministic fixture
// harness that `src/contracts/fixtures.test.ts` already proved out against a
// different docpack (`docs/requirements/keryx-project-agent-harness/schemas/`).
// Before this file, the six schemas + six examples + validation-cases.json
// under `docs/requirements/keryx-agent-first-core/` had zero consumers
// anywhere in `src/` or `scripts/` — the clearest "capability nothing calls"
// instance flow 238's phase-6 inventory found (T9 context, AC4 section).
//
// What is reused unchanged from the existing harness: `validateAgainstSchema`
// / `validateAgainstSchemaObject` (validator.ts), `SchemaResolver`
// (resolver.ts), and `usedKeywords`/`SUPPORTED_KEYWORDS`
// (keyword-coverage.ts). What had to change: the validator did not implement
// `not` or `dependentRequired`, both of which these schemas use
// (operation-response.schema.json's `not`, common.schema.json's
// `dependentRequired` on the `budget` $def) — see the two additions in
// validator.ts/keyword-coverage.ts alongside this file. That gap is this
// file's RED evidence: before those additions, `usedKeywords(SCHEMA_DIR)`
// contains `not`/`dependentRequired`, `SUPPORTED_KEYWORDS` does not, and the
// keyword-coverage assertion below fails; separately,
// "negative-ok-with-error" below is schema-VALID under the un-fixed validator
// (the `not` clause is silently skipped) even though validation-cases.json
// records it `schemaValid: false`.
//
// Shape difference from the other docpack's harness: that harness resolves
// fixtures through a single JSON-Pointer catalog
// (`fixtures/{positive,negative}-catalog.json`). This docpack instead ships
// one standalone example file per schema plus a single
// `examples/validation-cases.json` that names a `base` example and applies
// RFC 6902-shaped `add`/`remove`/`replace` mutations (metrics-and-validation.md
// "Schema fixtures и отрицательные случаи"). `applyMutations` below is the
// small RFC 6901/6902 subset needed to replay those mutations; it is new
// because the other harness never needed it.
//
// What does NOT fit this harness, and why: validation-cases.json cases with a
// `serviceOutcome` field (e.g. "service-stale-base", "service-cross-scope-handle",
// "service-batch-dependency-cycle") describe a SERVICE-level oracle — live
// version comparison, cross-scope/expired handle rejection, DAG cycle
// detection — that metrics-and-validation.md explicitly separates from schema
// validation ("Синтаксические случаи должны отвергаться схемой, живые
// версии/полномочия/сравнение scope/DAG — service validator"). Those cases are
// still replayed here, but only their `schemaValid` half is asserted (the
// mutated document must still be schema-valid, proving the schema does not
// over-reject); `serviceOutcome` is recorded as evidence of what a future
// batch/handle RUNTIME (not owned by this lane) must still check, not
// exercised. Forcing service semantics into a JSON Schema validator would be
// forcing a fit the inventory already warned against ("prevents a false claim
// that the schema itself provides atomic CAS").
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  auditContentForExport,
  auditPathsForExport,
  listAgentFirstCoreExportFiles,
} from "./export-audit";
import { SUPPORTED_KEYWORDS, usedKeywords } from "./keyword-coverage";
import { validateAgainstSchema, validateAgainstSchemaObject } from "./validator";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SCHEMA_DIR = path.join(REPO_ROOT, "docs", "requirements", "keryx-agent-first-core", "schemas");
const EXAMPLES_DIR = path.join(REPO_ROOT, "docs", "requirements", "keryx-agent-first-core", "examples");

// biome-ignore lint: fixture JSON has no static type; read raw and treat as unknown-shaped data.
function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function schemaForExample(exampleFile: string): string {
  return exampleFile.replace(/\.json$/, ".schema.json").replace(/\.v1\.schema\.json$/, ".schema.json");
}

// --- Minimal RFC 6902-shaped patch applier (add/remove/replace only — the
// three ops validation-cases.json actually uses) over RFC 6901 pointers.
type Mutation = { op: "add" | "remove" | "replace"; path: string; value?: unknown };

function splitPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`Unsupported JSON Pointer (must start with "/"): ${pointer}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function applyMutations(doc: unknown, mutations: Mutation[]): unknown {
  const root = structuredClone(doc) as Record<string, unknown> | unknown[];
  for (const mutation of mutations) {
    const segments = splitPointer(mutation.path);
    const lastRaw = segments[segments.length - 1];
    if (lastRaw === undefined) {
      throw new Error(`Mutation path must address at least one segment: ${mutation.path}`);
    }
    let parent: unknown = root;
    for (const seg of segments.slice(0, -1)) {
      parent = Array.isArray(parent) ? (parent as unknown[])[Number(seg)] : (parent as Record<string, unknown>)[seg];
    }
    if (Array.isArray(parent)) {
      const index = lastRaw === "-" ? parent.length : Number(lastRaw);
      if (mutation.op === "add") parent.splice(index, 0, mutation.value);
      else if (mutation.op === "remove") parent.splice(index, 1);
      else parent[index] = mutation.value;
    } else {
      const obj = parent as Record<string, unknown>;
      if (mutation.op === "remove") delete obj[lastRaw];
      else obj[lastRaw] = mutation.value;
    }
  }
  return root;
}

// --- 1. Positive matrix — every schema's own example validates -------------

const FAMILIES = [
  { schema: "batch.schema.json", example: "batch.json" },
  { schema: "change-set.schema.json", example: "change-set.json" },
  { schema: "handoff.schema.json", example: "handoff.json" },
  { schema: "operation-response.schema.json", example: "operation-response.json" },
  { schema: "wiki-evidence.schema.json", example: "wiki-evidence.json" },
  { schema: "wiki-freshness-calibration.schema.json", example: "wiki-freshness-calibration.v1.json" },
];

describe("positive matrix — every family's example validates against its own schema", () => {
  for (const family of FAMILIES) {
    test(`${family.schema} accepts ${family.example}`, () => {
      const data = readJson(path.join(EXAMPLES_DIR, family.example));
      const result = validateAgainstSchema(family.schema, data, { schemaDir: SCHEMA_DIR });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }
});

test("common.schema.json's $defs are consumed by every family via $ref — not orphaned, and directly resolvable", () => {
  // Every family above already exercises this indirectly (each schema $refs
  // common.schema.json#/$defs/scope at minimum). This test additionally proves
  // a single $def resolves and validates standalone, using
  // validateAgainstSchemaObject the same way an inline caller (e.g. an MCP tool
  // inputSchema) would reference one $def without loading a whole document.
  const scope = {
    projectId: "demo-project",
    checkoutId: "demo-checkout",
  };
  const result = validateAgainstSchemaObject(
    { $ref: "common.schema.json#/$defs/scope" },
    scope,
    { schemaDir: SCHEMA_DIR },
  );
  expect(result.errors).toEqual([]);
  expect(result.valid).toBe(true);
});

// --- 2. validation-cases.json matrix — positive + negative + service-marked -

const validationCases = readJson(path.join(EXAMPLES_DIR, "validation-cases.json"));

describe("validation-cases matrix — examples/validation-cases.json", () => {
  test("the file has the expected, deterministic case count (guards a silently truncated file)", () => {
    expect(Array.isArray(validationCases.cases)).toBe(true);
    expect(validationCases.cases.length).toBe(18);
  });

  for (const testCase of validationCases.cases as Array<Record<string, unknown>>) {
    const id = testCase.id as string;
    test(`${id}`, () => {
      let schemaFile: string;
      let document: unknown;

      if ("value" in testCase) {
        // Shape A: a literal document, schema named explicitly.
        schemaFile = testCase.schema as string;
        document = testCase.value;
      } else {
        // Shape B: base example + RFC 6902-shaped mutations.
        const base = testCase.base as string;
        schemaFile = schemaForExample(base);
        const baseDoc = readJson(path.join(EXAMPLES_DIR, base));
        const mutations = (testCase.mutations as Mutation[] | undefined) ?? [];
        document = applyMutations(baseDoc, mutations);
      }

      const expectedValid =
        "valid" in testCase ? (testCase.valid as boolean) : (testCase.schemaValid as boolean);
      expect(typeof expectedValid).toBe("boolean");

      const result = validateAgainstSchema(schemaFile, document, { schemaDir: SCHEMA_DIR });
      expect(result.valid).toBe(expectedValid);
      if (!expectedValid) {
        expect(result.errors.length).toBeGreaterThan(0);
      }

      // `serviceOutcome` names a service-level oracle this lane does not own
      // and does not implement (see file header). Record that it was present
      // without asserting it, so a case that silently drops its serviceOutcome
      // field is not mistaken for one that was actually checked.
      if ("serviceOutcome" in testCase) {
        expect(typeof testCase.serviceOutcome).toBe("string");
      }
    });
  }

  test("every case was exercised (no case silently skipped by id collision or a missing branch)", () => {
    const ids = new Set((validationCases.cases as Array<{ id: string }>).map((c) => c.id));
    expect(ids.size).toBe(validationCases.cases.length);
  });
});

// --- 3. Keyword-coverage matrix ----------------------------------------------

describe("keyword-coverage matrix — agent-first-core schemas", () => {
  test("every JSON Schema validation keyword these schemas use is supported by the validator", () => {
    const used = usedKeywords(SCHEMA_DIR);
    for (const keyword of used) {
      expect(SUPPORTED_KEYWORDS.has(keyword)).toBe(true);
    }
  });

  test("the used-keyword set includes the known-hard keywords, including `not` and `dependentRequired`", () => {
    const used = usedKeywords(SCHEMA_DIR);
    const hard = [
      "const",
      "allOf",
      "anyOf",
      "if",
      "then",
      "else",
      "not",
      "dependentRequired",
      "enum",
      "minItems",
      "uniqueItems",
      "pattern",
      "$ref",
    ];
    for (const keyword of hard) {
      expect(used.has(keyword)).toBe(true);
    }
  });
});

// --- 4. Mutation matrix — deterministic single-field mutations not already --
//        covered by validation-cases.json (the `not` clause above IS covered
//        by "negative-ok-with-error"/"negative-error-without-error-object";
//        `dependentRequired` is not exercised anywhere else, so it is covered
//        here directly against the $def).

describe("mutation matrix — keywords this lane added to the validator", () => {
  test("common.schema.json budget: estimatedTokens without estimator is rejected (dependentRequired)", () => {
    const budget = { maxBytes: 4096, usedBytes: 100, maxItems: 10, usedItems: 1, estimatedTokens: 32 };
    const result = validateAgainstSchemaObject(
      { $ref: "common.schema.json#/$defs/budget" },
      budget,
      { schemaDir: SCHEMA_DIR },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("common.schema.json budget: estimator without estimatedTokens is rejected (dependentRequired, other direction)", () => {
    const budget = { maxBytes: 4096, usedBytes: 100, maxItems: 10, usedItems: 1, estimator: "tiktoken-cl100k" };
    const result = validateAgainstSchemaObject(
      { $ref: "common.schema.json#/$defs/budget" },
      budget,
      { schemaDir: SCHEMA_DIR },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("common.schema.json budget: estimatedTokens WITH estimator validates", () => {
    const budget = {
      maxBytes: 4096,
      usedBytes: 100,
      maxItems: 10,
      usedItems: 1,
      estimatedTokens: 32,
      estimator: "tiktoken-cl100k",
    };
    const result = validateAgainstSchemaObject(
      { $ref: "common.schema.json#/$defs/budget" },
      budget,
      { schemaDir: SCHEMA_DIR },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("wiki-freshness-calibration: deleting required 'profileVersion' is rejected", () => {
    const base = readJson(path.join(EXAMPLES_DIR, "wiki-freshness-calibration.v1.json")) as Record<
      string,
      unknown
    >;
    const mutated: Record<string, unknown> = { ...base };
    delete mutated.profileVersion;
    const result = validateAgainstSchema("wiki-freshness-calibration.schema.json", mutated, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("wiki-freshness-calibration: agreedBeforeOptimisation=false is rejected (const true)", () => {
    const base = readJson(path.join(EXAMPLES_DIR, "wiki-freshness-calibration.v1.json")) as Record<
      string,
      unknown
    >;
    const mutated = { ...base, agreedBeforeOptimisation: false };
    const result = validateAgainstSchema("wiki-freshness-calibration.schema.json", mutated, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// --- 5. Export audit (AC6 / AC-M06) ------------------------------------------

describe("export audit — no private names, paths or results in the selected difference", () => {
  test("the real selected difference (schemas + examples, whole set) is clean", () => {
    const files = listAgentFirstCoreExportFiles(SCHEMA_DIR, EXAMPLES_DIR);
    // 7 schema files (6 document schemas + common.schema.json) + 7 example
    // files (6 examples + validation-cases.json). Exact count so a file
    // silently added or dropped from the audited set is caught, not just a
    // non-empty check.
    expect(files.length).toBe(14);

    const result = auditPathsForExport(files);
    expect(result.findings).toEqual([]);
    expect(result.clean).toBe(true);
  });

  test("the audit can fail: a planted private-looking fixture is caught in all three categories", () => {
    const plantedPath = path.join(import.meta.dir, "__fixtures__", "export-audit-planted-private.json");
    const content = readFileSync(plantedPath, "utf8");
    const findings = auditContentForExport(plantedPath, content);

    expect(findings.length).toBeGreaterThan(0);
    const categories = new Set(findings.map((f) => f.category));
    expect(categories.has("secret")).toBe(true);
    expect(categories.has("pii")).toBe(true);
    expect(categories.has("private-path")).toBe(true);

    // Same proof through the file-list entry point, not just the pure content
    // function, so the wiring from disk to detector is exercised too.
    const result = auditPathsForExport([plantedPath]);
    expect(result.clean).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  test("an empty file list is refused, not reported clean", () => {
    expect(() => auditPathsForExport([])).toThrow();
  });
});

// --- 6. Core dependency guard (AC6 / AC-M06 — "core dependencies contain no --
//        model runner"). Already true at the manifest level per the phase-6
//        inventory; this pins it with a test instead of leaving it an
//        unenforced observation.

describe("core dependency guard — no model runner in package.json's own dependency graph", () => {
  test("package.json declares zero runtime dependencies", () => {
    const pkg = readJson(path.join(REPO_ROOT, "package.json"));
    expect(pkg.dependencies).toEqual({});
  });

  test("no dependency or optionalDependency name matches a declared model-provider directory under src/harness/provider/", () => {
    // "Model runner name" is not invented here: it is read from this repo's
    // own src/harness/provider/ directory listing (anthropic/, openai/,
    // gemini/, ollama/, ...), excluding the two non-provider entries
    // (compat/, fixtures/) that live alongside them.
    const providerDir = path.join(REPO_ROOT, "src", "harness", "provider");
    const providerNames = readdirSync(providerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "compat" && entry.name !== "fixtures")
      .map((entry) => entry.name.toLowerCase());
    expect(providerNames.length).toBeGreaterThan(0);

    const pkg = readJson(path.join(REPO_ROOT, "package.json"));
    const declaredPackageNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ].map((name) => name.toLowerCase());

    for (const provider of providerNames) {
      for (const declared of declaredPackageNames) {
        expect(declared.includes(provider)).toBe(false);
      }
    }
  });
});
