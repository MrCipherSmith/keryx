// RED tests for R0-01 (flow 009, W7 / T5, sub-slice S1).
//
// Pins the bounded, trusted context manifest contract, per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`
// `@task-R0-01` scenarios:
//   - @SC_R02_TRUSTED_STARTUP           "Build trusted project context
//     before the first model request" (manifest half)
//   - @SC_R02_CONTEXT_BOUND             "Persist context scope and
//     fingerprints"
//   - @SC_R02_OPTIONAL_ARTIFACT_DEGRADES "Record an unavailable optional
//     context artifact"
//
// T6 (impl, S1) implements `src/harness/context/manifest.ts`
// (`buildContextManifest`, `ContextManifest`) to make this suite GREEN; until
// then the missing-module import is the expected RED failure.
//
// Deterministic: `deps.clock` is fixed, no `Date.now()`, no network, no
// randomness — two builds over identical input must be byte-identical.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";

// PINNED API (see dispatch) — T6 exports these from "./manifest"; import
// fails until then (expected RED: "Cannot find module './manifest'").
import { buildContextManifest, type ContextManifest } from "./manifest";

// Frozen schemas dir, computed relative to this file
// (src/harness/context/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

// Documented Release 0 context-manifest ceilings (ADR-0001 / README §Startup
// and Resume Preconditions / PRD §Success Criteria (3)): <= 2 MiB, <= 200,000
// estimated tokens.
const MAX_BYTES_CEILING = 2 * 1024 * 1024;
const MAX_TOKENS_CEILING = 200_000;

function makeDeps(): { clock: () => string } {
  return { clock: () => "2026-01-01T00:00:00.000Z" };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

// NOTE (API delta — see subagent-result): `buildContextManifest`'s pinned
// input `sources: unknown[]` is intentionally opaque at the seam. These test
// fixtures assume each source entry carries at least
// `{ kind: string; path: string; available: boolean; skipReason?: string }`
// (plus arbitrary content for available ones) for S1 to interpret into the
// manifest's `sources[]` shape (kind/path/hash/reliability/trustedAsPolicy/
// summary?). If S1 picks a different input shape, this is the delta to fix.
const manifestInput = {
  projectRoot: "/fixture",
  sources: [
    { kind: "wiki-index", path: "wiki/index.md", available: true, content: "# Wiki Index\n" },
    {
      kind: "health-artifact",
      path: "data/health/artifacts/latest.md",
      available: false,
      skipReason: "optional health artifact not present in this fixture project",
    },
  ] as unknown[],
  limits: { maxBytes: MAX_BYTES_CEILING, maxTokens: MAX_TOKENS_CEILING },
};

// --- SC_R02_TRUSTED_STARTUP / SC_R02_CONTEXT_BOUND --------------------------

describe("SC_R02_TRUSTED_STARTUP / SC_R02_CONTEXT_BOUND — bounded, trusted manifest", () => {
  test("buildContextManifest produces a manifest that validates against the frozen harness-context-manifest schema", () => {
    const manifest: ContextManifest = buildContextManifest(manifestInput, makeDeps());
    const result = validateAgainstSchema("harness-context-manifest.schema.json", manifest, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("the manifest carries project, scope, and content fingerprints", () => {
    const manifest = buildContextManifest(manifestInput, makeDeps());
    expect(manifest.projectRoot).toBe(manifestInput.projectRoot);
    expect(manifest.contextHash).toMatch(/^[a-f0-9]{64}$/);

    const scope = asRecord(manifest.scope);
    expect(typeof scope.scopeHash).toBe("string");
    expect(scope.scopeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("buildContextManifest is deterministic: two builds over identical input are byte-identical", () => {
    const first = buildContextManifest(manifestInput, makeDeps());
    const second = buildContextManifest(manifestInput, makeDeps());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("the manifest stays within the documented byte/token ceilings", () => {
    const manifest = buildContextManifest(manifestInput, makeDeps());
    const limits = asRecord(manifest.limits);
    expect(limits.maxBytes).toBeLessThanOrEqual(MAX_BYTES_CEILING);
    expect(limits.maxTokens).toBeLessThanOrEqual(MAX_TOKENS_CEILING);
    if (typeof limits.actualBytes === "number") {
      expect(limits.actualBytes).toBeLessThanOrEqual(limits.maxBytes as number);
    }
    if (typeof limits.estimatedTokens === "number") {
      expect(limits.estimatedTokens).toBeLessThanOrEqual(limits.maxTokens as number);
    }
  });
});

// --- SC_R02_OPTIONAL_ARTIFACT_DEGRADES --------------------------------------

describe("SC_R02_OPTIONAL_ARTIFACT_DEGRADES — unavailable optional artifact", () => {
  test("an unavailable optional context artifact is recorded with an explicit skip reason, not silently treated as trusted policy", () => {
    const manifest = buildContextManifest(manifestInput, makeDeps());
    const sources = manifest.sources.map(asRecord);
    const skipped = sources.find((source: Record<string, unknown>) => source.path === "data/health/artifacts/latest.md");

    expect(skipped).toBeDefined();
    if (skipped === undefined) {
      throw new Error("expected the unavailable health-artifact source to be present in manifest.sources");
    }
    expect(skipped.trustedAsPolicy).toBe(false);
    expect(skipped.reliability).toBe("unknown");
    expect(typeof skipped.summary).toBe("string");
    expect((skipped.summary as string).length).toBeGreaterThan(0);
  });

  test("an available source is recorded distinctly from an unavailable one (not collapsed into the same skip state)", () => {
    const manifest = buildContextManifest(manifestInput, makeDeps());
    const sources = manifest.sources.map(asRecord);
    const available = sources.find((source: Record<string, unknown>) => source.path === "wiki/index.md");

    expect(available).toBeDefined();
    if (available === undefined) {
      throw new Error("expected the available wiki-index source to be present in manifest.sources");
    }
    expect(available.trustedAsPolicy).toBe(true);
    expect(typeof available.hash).toBe("string");
    expect((available.hash as string).length).toBeGreaterThan(0);
  });
});
