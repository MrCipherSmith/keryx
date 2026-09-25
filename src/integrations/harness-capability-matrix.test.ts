// Flow 307 (W5-b), T7: the CI guard for the generated harness capability
// matrix (W5-AC4, W5-AC8). Runs in `test:core`.
//
// Proves, in order:
//   (a) the schema file itself parses as JSON and declares draft 2020-12;
//   (b) `generateCapabilityMatrix()` (the real registry) validates clean;
//   (c) the schema actually rejects a document missing any harnessEntry
//       required field, plus the two `if`/`then` combinations it encodes
//       (native+experimental, experimental+empty risk_notes) — W5-AC8;
//   (d) the checked-in artifact equals a fresh regeneration byte-for-byte —
//       the drift guard itself;
//   (e) `checkCapabilityMatrix` reports drift on an altered temp copy and
//       reports a missing file;
//   (f) canonical-id coverage and the per-harness facts this flow's
//       acceptance criteria pin (AC1/AC2/AC3 restated at the matrix layer).

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  CANONICAL_HARNESS_IDS,
  DEFAULT_MATRIX_ARTIFACT,
  MATRIX_VERSION,
  checkCapabilityMatrix,
  generateCapabilityMatrix,
  serializeCapabilityMatrix,
  validateCapabilityMatrix,
  type CapabilityMatrixDocument,
  type MatrixHarnessEntry,
} from "./matrix";
import { HARNESS_ADAPTERS } from "./registry";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "docs/requirements/keryx-agent-platform-expansion/schemas/harness-capability-matrix.schema.json",
);
const ARTIFACT_PATH = path.join(REPO_ROOT, DEFAULT_MATRIX_ARTIFACT);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-matrix-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("(a) schema file", () => {
  test("parses as JSON and declares Draft 2020-12", () => {
    const raw = readFileSync(SCHEMA_PATH, "utf8");
    const schema = JSON.parse(raw) as { $schema?: string };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("(b) generateCapabilityMatrix() validates", () => {
  test("the real registry produces a schema-conformant document", () => {
    const doc = generateCapabilityMatrix();
    expect(doc.version).toBe(MATRIX_VERSION);
    const result = validateCapabilityMatrix(doc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("(c) W5-AC8: the validator rejects an invalid matrix entry", () => {
  const REQUIRED_FIELDS: readonly (keyof MatrixHarnessEntry)[] = [
    "id",
    "state",
    "adapterKind",
    "confidence",
    "surfaces_supported",
    "surfaces_unsupported",
    "install_command",
    "verification_command",
    "risk_notes",
    "last_verified",
    "source_docs",
  ];

  for (const field of REQUIRED_FIELDS) {
    test(`deleting required field "${field}" from an entry fails validation`, () => {
      const doc = clone(generateCapabilityMatrix());
      const mutable = doc.harnesses[0] as unknown as Record<string, unknown>;
      delete mutable[field];
      const result = validateCapabilityMatrix(doc);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  test('state:"native" with confidence:"experimental" is rejected (native requires verified)', () => {
    const doc = clone(generateCapabilityMatrix());
    const nativeEntry = doc.harnesses.find((h) => h.state === "native");
    expect(nativeEntry).toBeDefined();
    (nativeEntry as unknown as Record<string, unknown>).confidence = "experimental";
    const result = validateCapabilityMatrix(doc);
    expect(result.valid).toBe(false);
  });

  test("confidence:\"experimental\" with empty risk_notes is rejected", () => {
    const doc = clone(generateCapabilityMatrix());
    const experimentalEntry = doc.harnesses.find((h) => h.confidence === "experimental");
    expect(experimentalEntry).toBeDefined();
    (experimentalEntry as unknown as Record<string, unknown>).risk_notes = "";
    const result = validateCapabilityMatrix(doc);
    expect(result.valid).toBe(false);
  });
});

describe("(d) drift guard: the checked-in artifact matches a fresh regeneration", () => {
  test("byte-for-byte", async () => {
    const generated = generateCapabilityMatrix();
    const serialized = serializeCapabilityMatrix(generated);
    const checkedIn = await readFile(ARTIFACT_PATH, "utf8");
    if (checkedIn !== serialized) {
      throw new Error(
        "docs/integrations/harness-capability-matrix.json is stale relative to HARNESS_ADAPTERS. " +
          "Regenerate it with writeCapabilityMatrix(repoRoot) from src/integrations/matrix " +
          "(or `keryx integrations matrix --write` once the CLI task lands).",
      );
    }
    expect(checkedIn).toBe(serialized);
  });
});

describe("(e) checkCapabilityMatrix", () => {
  test("reports missing file", async () => {
    await withTempDir(async (root) => {
      const result = await checkCapabilityMatrix(root);
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems.some((p) => p.includes("is missing"))).toBe(true);
    });
  });

  test("reports drift when the checked-in copy diverges from the registry, naming the first differing harness", async () => {
    await withTempDir(async (root) => {
      const doc = clone(generateCapabilityMatrix());
      // Tamper with one field on one entry — still schema-valid, but no
      // longer what the registry would generate.
      const target = doc.harnesses.find((h) => h.id === "claude")!;
      (target as unknown as Record<string, unknown>).label = "Tampered Label";
      const fullPath = path.join(root, DEFAULT_MATRIX_ARTIFACT);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, serializeCapabilityMatrix(doc), "utf8");

      const result = await checkCapabilityMatrix(root);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.includes("does not match the regenerated matrix"))).toBe(true);
      expect(result.problems.some((p) => p.includes("claude"))).toBe(true);
    });
  });

  test("reports ok when the checked-in copy matches the regeneration exactly", async () => {
    await withTempDir(async (root) => {
      const generated = generateCapabilityMatrix();
      const fullPath = path.join(root, DEFAULT_MATRIX_ARTIFACT);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, serializeCapabilityMatrix(generated), "utf8");

      const result = await checkCapabilityMatrix(root);
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
    });
  });
});

describe("(f) per-harness facts", () => {
  test("every canonical harness id (from the schema's own enum) has exactly one entry, in registry order", () => {
    const doc = generateCapabilityMatrix();
    expect(doc.harnesses.map((h) => h.id)).toEqual(HARNESS_ADAPTERS.map((a) => a.id));
    const ids = new Set(doc.harnesses.map((h) => h.id));
    for (const canonicalId of CANONICAL_HARNESS_IDS) {
      expect(ids.has(canonicalId)).toBe(true);
    }
    expect(ids.size).toBe(CANONICAL_HARNESS_IDS.length);
  });

  function entryFor(doc: CapabilityMatrixDocument, id: string): MatrixHarnessEntry {
    const entry = doc.harnesses.find((h) => h.id === id);
    if (entry === undefined) throw new Error(`no matrix entry for "${id}"`);
    return entry;
  }

  test("zed: adapterKind policy-travels-with-agent, block supported", () => {
    const doc = generateCapabilityMatrix();
    const zed = entryFor(doc, "zed");
    expect(zed.adapterKind).toBe("policy-travels-with-agent");
    expect(zed.surfaces_supported.some((s) => s.surface === "block")).toBe(true);
  });

  for (const id of ["gemini-cli", "kiro", "github-copilot-agent"]) {
    test(`${id}: experimental, block + instructions supported, non-empty risk_notes and an https source doc`, () => {
      const doc = generateCapabilityMatrix();
      const entry = entryFor(doc, id);
      expect(entry.confidence).toBe("experimental");
      expect(entry.surfaces_supported.some((s) => s.surface === "block")).toBe(true);
      expect(entry.surfaces_supported.some((s) => s.surface === "instructions")).toBe(true);
      expect(entry.risk_notes.length).toBeGreaterThan(0);
      expect(entry.source_docs.some((d) => d.startsWith("https://"))).toBe(true);
    });
  }

  for (const id of ["opencode", "antigravity"]) {
    test(`${id}: experimental, with inject-context in surfaces_unsupported`, () => {
      const doc = generateCapabilityMatrix();
      const entry = entryFor(doc, id);
      expect(entry.confidence).toBe("experimental");
      expect(entry.surfaces_unsupported.some((s) => s.surface === "inject-context")).toBe(true);
    });
  }
});
