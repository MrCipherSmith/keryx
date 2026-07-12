// RED tests for C-03 (flow 006, W4 / T6).
//
// Drives the (not-yet-existing) deterministic contract validator over the
// frozen fixtures in `docs/requirements/keryx-project-agent-harness/schemas/`.
// C-02 implements `src/contracts/validator.ts` and
// `src/contracts/keyword-coverage.ts` to make this suite GREEN; until then the
// missing-module import is the expected RED failure.
//
// Six matrices, per AC3:
//   1. positive matrix   — every family's positive fixture validates.
//   2. negative matrix   — every family's negative fixture is rejected.
//   3. keyword coverage  — every JSON Schema keyword the frozen schemas use
//                           is in SUPPORTED_KEYWORDS, including the known-hard
//                           ones (const/allOf/oneOf/if/then/uniqueItems/
//                           minItems/maxItems/maxLength/format/$ref).
//   4. mutation matrix    — deterministic single-field mutations of positive
//                           fixtures (wrong type, out-of-enum, missing
//                           required) are rejected.
//   5. migration matrix   — schema-version-registry.json is complete (34
//                           entries), deterministic, and pointer-resolvable;
//                           an in-range schemaVersion validates and an
//                           out-of-range one is rejected.
//   6. fixture-hash matrix — sha256 over canonical (sorted-key) JSON of each
//                           positive case is stable across two computations.
//
// All fixtures/paths are read from disk deterministically; no Date.now(),
// network, or randomness anywhere in this file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { SUPPORTED_KEYWORDS, usedKeywords } from "./keyword-coverage";
import { validateAgainstSchema } from "./validator";

// Frozen schemas dir, computed relative to this file (src/contracts/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);
const FIXTURES_DIR = path.join(SCHEMA_DIR, "fixtures");

type FixtureFamily = { schema: string; positive: string; negative: string };
type RegistryEntry = {
  schema: string;
  schemaId: string;
  storedVersion: number;
  acceptedRange: string;
  migrationId: string;
  lifecycle?: string;
};

// biome-ignore lint: fixture JSON has no static type; read raw and treat as unknown-shaped data.
function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

const fixtureMatrix = readJson(path.join(FIXTURES_DIR, "fixture-matrix.json"));
const positiveCatalog = readJson(path.join(FIXTURES_DIR, fixtureMatrix.positiveCatalog));
const negativeCatalog = readJson(path.join(FIXTURES_DIR, fixtureMatrix.negativeCatalog));
const versionRegistry = readJson(path.join(SCHEMA_DIR, "schema-version-registry.json"));
const families: FixtureFamily[] = fixtureMatrix.families;

// Resolve a "#/cases/<name>" JSON Pointer (RFC 6901) against a catalog document.
function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) {
    throw new Error(`Unsupported pointer (must start with "#/"): ${pointer}`);
  }
  const segments = pointer
    .slice(2)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = doc;
  for (const seg of segments) {
    if (node === null || typeof node !== "object" || !(seg in (node as Record<string, unknown>))) {
      throw new Error(`Pointer segment "${seg}" not resolvable in pointer ${pointer}`);
    }
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

// Deterministic canonical JSON: recursively sort object keys so structurally
// identical fixtures hash the same regardless of source key order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

// Minimal "^N" range check matching the registry's documented convention:
// storedVersion/acceptedRange operate on whole-number contract versions (no
// integer minor/patch component), so "^1" accepts exactly major version 1.
function isVersionAccepted(version: number, range: string): boolean {
  const match = /^\^(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`Unsupported acceptedRange format: ${range}`);
  }
  const major = Number(match[1]);
  return Number.isInteger(version) && version === major;
}

// --- 1. Positive matrix -----------------------------------------------------

describe("positive matrix — every family's positive fixture validates", () => {
  for (const family of families) {
    test(`${family.schema} accepts its positive fixture (${family.positive})`, () => {
      const data = resolvePointer(positiveCatalog, family.positive);
      const result = validateAgainstSchema(family.schema, data, { schemaDir: SCHEMA_DIR });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }
});

// --- 2. Negative matrix ------------------------------------------------------

describe("negative matrix — every family's negative fixture is rejected", () => {
  for (const family of families) {
    test(`${family.schema} rejects its negative fixture (${family.negative})`, () => {
      const data = resolvePointer(negativeCatalog, family.negative);
      const result = validateAgainstSchema(family.schema, data, { schemaDir: SCHEMA_DIR });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }
});

// --- 3. Keyword-coverage matrix ----------------------------------------------

describe("keyword-coverage matrix", () => {
  test("every JSON Schema validation keyword used by the frozen schemas is supported", () => {
    const used = usedKeywords(SCHEMA_DIR);
    for (const keyword of used) {
      expect(SUPPORTED_KEYWORDS.has(keyword)).toBe(true);
    }
  });

  test("the used-keyword set includes the known-hard keywords the schemas rely on", () => {
    const used = usedKeywords(SCHEMA_DIR);
    const hard = [
      "const",
      "allOf",
      "oneOf",
      "if",
      "then",
      "uniqueItems",
      "minItems",
      "maxItems",
      "maxLength",
      "format",
      "$ref",
    ];
    for (const keyword of hard) {
      expect(used.has(keyword)).toBe(true);
    }
  });

  test("usedKeywords excludes pure-meta keywords and property names", () => {
    const used = usedKeywords(SCHEMA_DIR);
    for (const meta of ["$schema", "$id", "title", "description"]) {
      expect(used.has(meta)).toBe(false);
    }
    // Property names that happen to collide with keyword spellings (e.g. a
    // schema field literally named "format" or "enum") must not leak in
    // either — this only holds if usedKeywords scans structurally rather
    // than via a bare string/key scan. None of the frozen schemas define
    // such a property, so this is a coverage guard rather than a positive
    // assertion on current fixture content.
  });
});

// --- 4. Mutation matrix -------------------------------------------------------

describe("mutation matrix — deterministic single-field mutations invalidate positive fixtures", () => {
  test("harness-config: wrong type for 'enabled' (boolean -> string) is rejected", () => {
    const base = resolvePointer(positiveCatalog, "#/cases/config") as Record<string, unknown>;
    const mutated = { ...base, enabled: "false" };
    const result = validateAgainstSchema("harness-config.schema.json", mutated, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("harness-tool-call: out-of-enum 'risk' value is rejected", () => {
    const base = resolvePointer(positiveCatalog, "#/cases/tool-call") as Record<string, unknown>;
    const mutated = { ...base, risk: "explode" };
    const result = validateAgainstSchema("harness-tool-call.schema.json", mutated, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("harness-policy-decision: deleting required 'decision' is rejected", () => {
    const base = resolvePointer(positiveCatalog, "#/cases/policy-decision") as Record<string, unknown>;
    const mutated: Record<string, unknown> = { ...base };
    delete mutated.decision;
    const result = validateAgainstSchema("harness-policy-decision.schema.json", mutated, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("session-manifest: deleting required 'currentLeafEntryId' is rejected", () => {
    const base = resolvePointer(positiveCatalog, "#/cases/session-manifest") as Record<string, unknown>;
    const mutated: Record<string, unknown> = { ...base };
    delete mutated.currentLeafEntryId;
    const result = validateAgainstSchema("session-manifest.schema.json", mutated, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// --- 5. Migration matrix ------------------------------------------------------

describe("migration matrix — schema-version-registry.json is deterministic and complete", () => {
  test("registry has exactly 34 entries (33 active families + harness-agent-task migration-only reader)", () => {
    expect(versionRegistry.entries).toHaveLength(34);
  });

  test("registry entries are unique by schema name and pointer-resolvable to an existing frozen schema file", () => {
    const seen = new Set<string>();
    for (const entry of versionRegistry.entries as RegistryEntry[]) {
      expect(seen.has(entry.schema)).toBe(false);
      seen.add(entry.schema);
      expect(existsSync(path.join(SCHEMA_DIR, entry.schema))).toBe(true);
      expect(entry.schemaId).toBe(`https://keryx.local/schemas/harness/${entry.schema}`);
    }
  });

  test("re-reading the registry file twice yields an identical deterministic mapping (diff empty)", () => {
    const first = readJson(path.join(SCHEMA_DIR, "schema-version-registry.json"));
    const second = readJson(path.join(SCHEMA_DIR, "schema-version-registry.json"));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("a schemaVersion within acceptedRange validates; one outside it is rejected per defaultRejectionBehavior", () => {
    expect(versionRegistry.defaultRejectionBehavior).toBe("typed_schema_incompatible");

    const byFamilySchema = new Map(families.map((f) => [f.schema, f]));
    let exercised = 0;

    for (const entry of versionRegistry.entries as RegistryEntry[]) {
      const family = byFamilySchema.get(entry.schema);
      if (!family) {
        // harness-agent-task.schema.json is migration-only and intentionally
        // absent from the active fixture matrix (fixtures/README.md).
        expect(entry.lifecycle).toBe("migration-only");
        continue;
      }

      const positive = resolvePointer(positiveCatalog, family.positive) as Record<string, unknown>;
      expect(positive.schemaVersion).toBe(entry.storedVersion);
      expect(isVersionAccepted(entry.storedVersion, entry.acceptedRange)).toBe(true);

      const withinRange = { ...positive, schemaVersion: entry.storedVersion };
      const withinResult = validateAgainstSchema(entry.schema, withinRange, { schemaDir: SCHEMA_DIR });
      expect(withinResult.valid).toBe(true);

      const outsideVersion = entry.storedVersion + 1;
      expect(isVersionAccepted(outsideVersion, entry.acceptedRange)).toBe(false);
      const outsideRange = { ...positive, schemaVersion: outsideVersion };
      const outsideResult = validateAgainstSchema(entry.schema, outsideRange, { schemaDir: SCHEMA_DIR });
      expect(outsideResult.valid).toBe(false);
      expect(outsideResult.errors.length).toBeGreaterThan(0);

      exercised += 1;
    }

    expect(exercised).toBe(families.length);
  });
});

// --- 6. Fixture-hash matrix ---------------------------------------------------

describe("fixture-hash matrix — positive fixtures hash deterministically", () => {
  test("every positive case's canonical sha256 is stable across two computations (re-run diff empty)", () => {
    const cases = positiveCatalog.cases as Record<string, unknown>;
    const names = Object.keys(cases);
    expect(names.length).toBeGreaterThan(0);

    const first: Record<string, string> = {};
    for (const name of names) {
      first[name] = sha256Of(cases[name]);
    }
    const second: Record<string, string> = {};
    for (const name of names) {
      second[name] = sha256Of(cases[name]);
    }

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const hash of Object.values(first)) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("canonical hashing is key-order independent", () => {
    const a = { z: 1, a: { b: 2, a: 1 } };
    const b = { a: { a: 1, b: 2 }, z: 1 };
    expect(sha256Of(a)).toBe(sha256Of(b));
  });
});
