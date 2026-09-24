// Flow 313 (W4 portability), T6 — manifest.ts: schema validation, formatVersion
// major check, duplicate-path and kind/path consistency refusals.

import { describe, expect, test } from "bun:test";

import { DEFAULT_BUNDLE_LIMITS } from "./archive";
import { parseManifest, serializeManifest } from "./manifest";
import { BUNDLE_FORMAT_VERSION, type BundleManifest } from "./types";

function validManifest(): BundleManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: "keryx-project-abc123def456",
    createdAt: "2026-09-24T00:00:00.000Z",
    sourceKeryxVersion: "0.2.160",
    provenance: { producedBy: "keryx bundle export", sourceScope: "project" },
    compat: { minKeryxVersion: "0.2.160", targetHarnesses: [] },
    contents: [
      {
        path: "agents/foo.md",
        kind: "agent",
        scope: "project",
        sha256: "a".repeat(64),
        sizeBytes: 10,
      },
    ],
  };
}

describe("parseManifest", () => {
  test("accepts a schema-valid manifest", () => {
    const bytes = Buffer.from(serializeManifest(validManifest()), "utf8");
    const result = parseManifest(bytes);
    expect(result.ok).toBe(true);
  });

  test("refuses invalid JSON", () => {
    const result = parseManifest(Buffer.from("not json", "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals[0]?.reason).toBe("schema-invalid");
  });

  test("refuses a manifest failing the schema (missing required field)", () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    delete manifest.bundleId;
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "schema-invalid")).toBe(true);
  });

  test("refuses a formatVersion whose major does not match", () => {
    const manifest = validManifest();
    manifest.formatVersion = "2.0.0";
    const result = parseManifest(Buffer.from(serializeManifest(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals[0]?.reason).toBe("unsupported-format-version");
  });

  test("refuses duplicate contents[].path", () => {
    const manifest = validManifest();
    manifest.contents.push({ ...manifest.contents[0] } as BundleManifest["contents"][number]);
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "duplicate-path")).toBe(true);
  });

  test("refuses a path that does not match its kind's on-disk shape", () => {
    const manifest = validManifest();
    manifest.contents[0]!.path = "not-agents/foo.md";
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "kind-path-mismatch")).toBe(true);
  });

  // R2-F21 (R1-F22 regression coverage): an ASCII case-only duplicate ("SAME
  // file on a case-insensitive filesystem) must be refused even though the
  // exact-string duplicate check above would not catch it.
  test("refuses an ASCII case-only duplicate path", () => {
    const manifest = validManifest();
    manifest.contents.push({ ...manifest.contents[0], path: "agents/FOO.md" } as BundleManifest["contents"][number]);
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "duplicate-path")).toBe(true);
  });

  // R2-F21 (R1-F22 regression coverage): a file/directory prefix collision —
  // one entry's path IS another entry's parent directory — is refused, not
  // silently allowed to write one path as both a file and a directory.
  test("refuses a file/directory prefix collision between two entries", () => {
    const manifest = validManifest();
    manifest.contents = [
      { path: "skills/a", kind: "skill", scope: "project", sha256: "a".repeat(64), sizeBytes: 1 },
      { path: "skills/a/ref.md", kind: "skill", scope: "project", sha256: "b".repeat(64), sizeBytes: 1 },
    ];
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "duplicate-path")).toBe(true);
  });

  // R2-F4: `contents.length` is capped BEFORE the per-entry duplicate/prefix
  // loop runs — a manifest claiming more entries than the archive's own
  // entry cap (`DEFAULT_BUNDLE_LIMITS.maxEntries`) is refused outright,
  // rather than paying for an O(n) (pre-fix: O(n^2)) pass over an
  // attacker-controlled array size. Fails on the pre-fix code, which had no
  // cap here at all (only `archive.ts`'s cap on the ARCHIVE's own entries,
  // which this manifest-level array is independent of).
  test("R2-F4: refuses a contents[] array over the entry cap before any per-entry work", () => {
    const manifest = validManifest();
    const over = DEFAULT_BUNDLE_LIMITS.maxEntries + 1;
    manifest.contents = Array.from({ length: over }, (_, i) => ({
      path: `memory/lessons/${i}.md`,
      kind: "memory-entry" as const,
      scope: "project" as const,
      sha256: "a".repeat(64),
      sizeBytes: 1,
    }));
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals[0]?.reason).toBe("archive-too-large");
  });

  // R3-F19: the entry-count cap must run BEFORE the full JSON-schema
  // validation, not merely before the per-entry duplicate/prefix loop the
  // R2-F4 fix already capped — `validateAgainstSchemaObject` itself walks
  // and validates every `contents[]` entry, which was the actually
  // expensive step (6s / 1.68 GB at ~100k entries in review round 3). Every
  // entry here is DELIBERATELY schema-invalid (`sha256` far too short): if
  // the cap ran after schema validation, the result would report
  // `schema-invalid` (from the first invalid entries encountered), not
  // `archive-too-large` — asserting the reason is `archive-too-large` proves
  // the cheap shape-and-length check short-circuits before that expensive
  // pass ever starts. Fails on the pre-fix code (which validated first).
  test("R3-F19: the entry cap short-circuits before schema validation runs", () => {
    const manifest = validManifest();
    const over = DEFAULT_BUNDLE_LIMITS.maxEntries + 1;
    manifest.contents = Array.from({ length: over }, (_, i) => ({
      path: `memory/lessons/${i}.md`,
      kind: "memory-entry" as const,
      scope: "project" as const,
      sha256: "not-a-valid-sha256", // schema-invalid on purpose
      sizeBytes: 1,
    }));
    const start = performance.now();
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    const elapsedMs = performance.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]?.reason).toBe("archive-too-large");
    }
    // Generous ceiling (the pre-fix cost was measured in seconds) — this is
    // a correctness assertion (schema validation never ran), not a strict
    // perf budget.
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("serializeManifest", () => {
  test("is stable JSON with a trailing newline", () => {
    const text = serializeManifest(validManifest());
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(serializeManifest(validManifest())).toBe(text);
  });
});
