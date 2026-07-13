// RED tests for evidence records + redaction-before-persistence (flow 009,
// W7 / T11, sub-slice S4, task-R0-02).
//
// Pins the frozen evidence/redaction contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R11_REDACTION_BEFORE_PERSISTENCE "Redact protected content before
//     persistence" (only a redacted preview, hash, category, and provenance
//     are persisted; scan failure is a blocking state)
// and ADR-0001 D-01 item 6 ("Evidence-linked output — every meaningful action
// ... is linked to a redacted evidence record with artifact hash, action
// fingerprint, and timing") plus `specification.md` §Storage Structure
// ("Sensitive content is redacted before it is written to either class.").
//
// S4 impl (next dispatch) implements `src/harness/evidence/types.ts`
// (`EvidenceRecord`) and `src/harness/evidence/redaction.ts`
// (`redactForPersistence`) to make this suite GREEN; until then the
// missing-module import is the expected RED failure.
//
// Deterministic: `redactForPersistence` is a pure function of
// (content, deps.scan) — no `Date.now()`, `Math.random()`, or network
// anywhere in this file. `deps.scan` is a deterministic caller-supplied stub
// (never a real secret/PII scanner) so tests never depend on scanner
// internals.
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";

// PINNED API (see dispatch) — S4 impl exports these; imports fail until then
// (expected RED: "Cannot find module './types'" / "Cannot find module
// './redaction'").
import type { EvidenceRecord } from "./types";
import { redactForPersistence } from "./redaction";
import type { RedactionResult } from "./redaction";

// Frozen schemas dir, computed relative to this file
// (src/harness/evidence/ -> repo root).
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

const SHA_PLACEHOLDER = "c".repeat(64);

// Synthetic, obviously-fake seeded secret/PII for test purposes only — never
// a real credential. Chosen to be pattern-shaped (api-key-like / SSN-like) so
// a `deps.scan` stub can plausibly flag it, without this file itself needing
// a real secret scanner.
const SEEDED_SECRET = "sk-FAKE-TEST-0123456789abcdef0123456789";
const SEEDED_PII = "444-55-6666"; // synthetic, non-issuable SSN-shaped digits

function scanFlags(category: string): { hasSecret: boolean; category?: string; scanFailed?: boolean } {
  return { hasSecret: true, category };
}

function scanFailed(): { hasSecret: boolean; category?: string; scanFailed?: boolean } {
  return { hasSecret: false, scanFailed: true };
}

function isBlocked(result: RedactionResult): result is Extract<RedactionResult, { blocked: true }> {
  return result.blocked === true;
}

function isNotBlocked(result: RedactionResult): result is Extract<RedactionResult, { blocked: false }> {
  return result.blocked === false;
}

// --- 1. SC_R11_REDACTION_BEFORE_PERSISTENCE ---------------------------------

describe("SC_R11_REDACTION_BEFORE_PERSISTENCE — redact protected content before persistence", () => {
  test("a seeded secret is never present in the persisted preview/hash — only preview, hash, category, provenance survive", () => {
    const content = `tool output line 1\napi_key=${SEEDED_SECRET}\nline 3`;

    const result = redactForPersistence(content, { scan: () => scanFlags("secret") });

    expect(isNotBlocked(result)).toBe(true);
    if (!isNotBlocked(result)) throw new Error("expected a non-blocked redaction result");

    // Exactly the pinned discriminated-union fields — nothing else persisted.
    expect(Object.keys(result).sort()).toEqual(["blocked", "category", "hash", "preview", "provenance"]);

    expect(result.category).toBe("secret");
    expect(typeof result.preview).toBe("string");
    expect(result.preview).not.toContain(SEEDED_SECRET);

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);

    expect(typeof result.provenance).toBe("object");
    expect(result.provenance).not.toBeNull();

    // The raw secret must not survive anywhere in the persisted result, not
    // even nested inside `provenance` or embedded as a substring of `hash`.
    expect(JSON.stringify(result)).not.toContain(SEEDED_SECRET);
  });

  test("seeded PII is redacted the same way — only preview, hash, category, provenance survive", () => {
    const content = `customer ssn on file: ${SEEDED_PII}`;

    const result = redactForPersistence(content, { scan: () => scanFlags("pii") });

    expect(isNotBlocked(result)).toBe(true);
    if (!isNotBlocked(result)) throw new Error("expected a non-blocked redaction result");

    expect(result.category).toBe("pii");
    expect(result.preview).not.toContain(SEEDED_PII);
    expect(JSON.stringify(result)).not.toContain(SEEDED_PII);
  });

  test("scan failure is a blocking state — no preview/hash/category is persisted, only blocked + reason", () => {
    const content = `some content that could not be scanned: ${SEEDED_SECRET}`;

    const result = redactForPersistence(content, { scan: scanFailed });

    expect(isBlocked(result)).toBe(true);
    if (!isBlocked(result)) throw new Error("expected a blocked redaction result on scan failure");

    expect(Object.keys(result).sort()).toEqual(["blocked", "reason"]);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);

    // A blocking scan failure must never leak the raw content either.
    expect(JSON.stringify(result)).not.toContain(SEEDED_SECRET);
  });

  test("deterministic/pure: two calls over identical (content, scan) inputs produce an identical result", () => {
    const content = `repeatable content with ${SEEDED_SECRET}`;
    const first = redactForPersistence(content, { scan: () => scanFlags("secret") });
    const second = redactForPersistence(content, { scan: () => scanFlags("secret") });
    expect(second).toEqual(first);
  });
});

// --- 2. Evidence record validity ---------------------------------------------
//
// "Link every meaningful action to evidence" (ADR-0001 item 6): a constructed
// `EvidenceRecord` must validate against the frozen `evidence-record.schema.json`
// — structurally, this is what lets every model request, tool call, policy
// decision, and completion gate be linked to a redacted, hash-addressed
// artifact rather than an unverifiable free-text claim.

describe("Evidence record validity — every meaningful action links to an evidence id", () => {
  function validEvidenceRecord(): EvidenceRecord {
    return {
      schemaVersion: 1,
      evidenceId: "evidence-completion-gate-1",
      causal: {
        runId: "run-1",
        sessionId: "session-1",
        correlationId: "correlation-1",
      },
      kind: "completion-gate",
      artifact: {
        artifactId: "artifact-completion-gate-1",
        kind: "completion-gate-result",
        hash: SHA_PLACEHOLDER,
      },
      provenance: {
        provenanceId: "provenance-1",
        trustLevel: "derived",
        sourceKind: "harness-completion-gate",
      },
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  test("a constructed EvidenceRecord validates against evidence-record.schema.json", () => {
    const record = validEvidenceRecord();
    const result = validateAgainstSchema("evidence-record.schema.json", record, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("every EvidenceRecord `kind` is drawn from the frozen enum — an invented kind fails schema validation", () => {
    const record = { ...validEvidenceRecord(), kind: "not-a-real-kind" };
    const result = validateAgainstSchema("evidence-record.schema.json", record, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(false);
  });

  test("an EvidenceRecord missing its causal linkage fails schema validation (evidence must be traceable to a run/session/correlation)", () => {
    const { causal: _causal, ...withoutCausal } = validEvidenceRecord();
    const result = validateAgainstSchema("evidence-record.schema.json", withoutCausal, {
      schemaDir: SCHEMA_DIR,
    });
    expect(result.valid).toBe(false);
  });

  test("a redacted result's category/hash/provenance are sufficient inputs to build a schema-valid EvidenceRecord artifact/provenance pair", () => {
    const redacted = redactForPersistence(`secret: ${SEEDED_SECRET}`, { scan: () => scanFlags("secret") });
    if (!isNotBlocked(redacted)) throw new Error("expected a non-blocked redaction result");

    const record: EvidenceRecord = {
      schemaVersion: 1,
      evidenceId: "evidence-tool-result-1",
      causal: { runId: "run-1", sessionId: "session-1", correlationId: "correlation-2" },
      kind: "tool-result",
      artifact: { artifactId: "artifact-tool-result-1", kind: "tool-result", hash: redacted.hash },
      provenance: { provenanceId: "provenance-2", trustLevel: "untrusted", sourceKind: "tool-output" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = validateAgainstSchema("evidence-record.schema.json", record, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
