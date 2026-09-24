import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateLearnedPattern, validateObservationEvent } from "./schema";
import type { LearnedPattern, ObservationEvent } from "./types";

const DOCS_SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-platform-expansion",
  "schemas",
  "learned-pattern.schema.json",
);
const RUNTIME_SCHEMA_PATH = path.join(__dirname, "learned-pattern.schema.json");

describe("learned-pattern.schema.json runtime copy", () => {
  test("is byte-identical to the docs schema", () => {
    const docs = readFileSync(DOCS_SCHEMA_PATH, "utf8");
    const runtime = readFileSync(RUNTIME_SCHEMA_PATH, "utf8");
    expect(runtime).toBe(docs);
  });
});

const SHA_A = "a".repeat(64);
const NOW = "2026-09-24T00:00:00.000Z";

function baseCandidate(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    schemaVersion: 1,
    id: "testing.repeated-correction-ab12cd34",
    trigger: "the same file region is edited twice in one turn window",
    action: "check the first edit's assumptions before writing a second one",
    domain: "testing",
    scope: "project",
    project: { identity: SHA_A, identityKind: "remote-hash" },
    confidence: 0.4,
    confidenceLevel: "low",
    status: "candidate",
    supersededBy: null,
    evidence: [
      {
        kind: "reinforcement",
        sourceType: "observation",
        sourceRef: ".metaproject/data/learning/observations/2026-09-24.jsonl",
        observedAt: NOW,
        weight: 1,
      },
    ],
    reviewerProfile: null,
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
    ttl: { expiresAt: "2026-10-24T00:00:00.000Z" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("validateLearnedPattern: valid fixtures", () => {
  test("candidate record", () => {
    const result = validateLearnedPattern(baseCandidate());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("accepted record (no ttl)", () => {
    const record = baseCandidate({
      status: "accepted",
      confidence: 0.61,
      confidenceLevel: "medium",
    });
    delete (record as { ttl?: unknown }).ttl;
    expect(validateLearnedPattern(record)).toEqual({ ok: true, errors: [] });
  });

  // R1-F9: `supersededBy` is not in `LEARNED_PATTERN_REQUIRED` — the schema
  // does not require the property at all — but the validator's allOf #1
  // branch used to treat "not null" as an error without also checking "not
  // present", so a well-formed record that simply omitted the key (rather
  // than spelling out `supersededBy: null`) failed validation for a status
  // that has nothing to do with superseding.
  test("record with supersededBy entirely absent (not just null) passes", () => {
    const record = baseCandidate();
    delete (record as { supersededBy?: unknown }).supersededBy;
    expect(validateLearnedPattern(record)).toEqual({ ok: true, errors: [] });
  });

  test("superseded record", () => {
    const record = baseCandidate({
      status: "superseded",
      supersededBy: "testing.repeated-correction-ef56gh78",
      confidence: 0.9,
      confidenceLevel: "high",
    });
    delete (record as { ttl?: unknown }).ttl;
    expect(validateLearnedPattern(record)).toEqual({ ok: true, errors: [] });
  });

  test("review-conventions record with reviewerProfile", () => {
    const record = baseCandidate({
      domain: "review-conventions",
      status: "accepted",
      reviewerProfile: { reviewerId: "rv-0123456789abcdef", generalizedFrom: 3 },
    });
    delete (record as { ttl?: unknown }).ttl;
    expect(validateLearnedPattern(record)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateLearnedPattern: conditional violations", () => {
  test("superseded without supersededBy fails", () => {
    const record = baseCandidate({ status: "superseded", supersededBy: null });
    delete (record as { ttl?: unknown }).ttl;
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("supersededBy"))).toBe(true);
  });

  test("non-superseded with non-null supersededBy fails", () => {
    const record = baseCandidate({ supersededBy: "some-other-id" });
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("supersededBy"))).toBe(true);
  });

  test("non-review-conventions domain with non-null reviewerProfile fails", () => {
    const record = baseCandidate({
      reviewerProfile: { reviewerId: "rv-abc", generalizedFrom: 1 },
    });
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("reviewerProfile"))).toBe(true);
  });

  test("candidate without ttl fails", () => {
    const record = baseCandidate();
    delete (record as { ttl?: unknown }).ttl;
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ttl"))).toBe(true);
  });

  test("non-candidate with ttl present fails", () => {
    const record = baseCandidate({ status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ttl"))).toBe(true);
  });
});

describe("validateLearnedPattern: field rules", () => {
  test("rejects additional properties", () => {
    const record = { ...baseCandidate(), extra: "nope" };
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("extra:"))).toBe(true);
  });

  test("rejects missing required fields", () => {
    const record = baseCandidate() as Partial<LearnedPattern>;
    delete record.trigger;
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith("trigger:"))).toBe(true);
  });

  test("rejects schemaVersion !== 1", () => {
    const record = { ...baseCandidate(), schemaVersion: 2 };
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects invalid id pattern", () => {
    const record = baseCandidate({ id: "Not Valid!" });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects trigger/action out of 8-400 bound", () => {
    expect(validateLearnedPattern(baseCandidate({ trigger: "short" })).ok).toBe(false);
    expect(validateLearnedPattern(baseCandidate({ action: "x".repeat(401) })).ok).toBe(false);
  });

  test("rejects unknown domain/scope/status enum values", () => {
    expect(validateLearnedPattern(baseCandidate({ domain: "nope" as never })).ok).toBe(false);
    expect(validateLearnedPattern(baseCandidate({ scope: "nope" as never })).ok).toBe(false);
    expect(validateLearnedPattern(baseCandidate({ status: "nope" as never })).ok).toBe(false);
  });

  test("rejects project.identity not matching sha256 hex pattern", () => {
    const record = baseCandidate({ project: { identity: "not-a-hash", identityKind: "remote-hash" } });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects confidence outside [0,1]", () => {
    expect(validateLearnedPattern(baseCandidate({ confidence: 1.1 })).ok).toBe(false);
    expect(validateLearnedPattern(baseCandidate({ confidence: -0.1 })).ok).toBe(false);
  });

  test("rejects inconsistent confidenceLevel", () => {
    const record = baseCandidate({ confidence: 0.9, confidenceLevel: "low" });
    const result = validateLearnedPattern(record);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("confidenceLevel"))).toBe(true);
  });

  test("rejects empty evidence array", () => {
    const record = baseCandidate({ evidence: [] });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects evidence weight above MAX_EVIDENCE_WEIGHT", () => {
    const record = baseCandidate({
      evidence: [
        {
          kind: "reinforcement",
          sourceType: "test",
          sourceRef: "some/path",
          observedAt: NOW,
          weight: 2,
        },
      ],
    });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects redaction.scanned !== true", () => {
    const record = baseCandidate({ redaction: { scanned: false as never, findings: [] } });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects provenance without extractor", () => {
    const record = baseCandidate({ provenance: {} as never });
    expect(validateLearnedPattern(record).ok).toBe(false);
  });

  test("rejects malformed createdAt/updatedAt", () => {
    expect(validateLearnedPattern(baseCandidate({ createdAt: "not-a-date" })).ok).toBe(false);
    expect(validateLearnedPattern(baseCandidate({ updatedAt: "not-a-date" })).ok).toBe(false);
  });
});

function baseObservation(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Bash",
    inputDigest: SHA_A,
    inputPreview: "echo hi",
    outputPreview: "hi",
    sessionId: "session-1",
    toolUseId: "tool-use-1",
    cwdHash: SHA_A,
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: NOW,
    ...overrides,
  };
}

describe("validateObservationEvent", () => {
  test("valid tool-complete event", () => {
    expect(validateObservationEvent(baseObservation())).toEqual({ ok: true, errors: [] });
  });

  test("valid session-end event with null tool/toolUseId/outputPreview", () => {
    const event = baseObservation({
      event: "session-end",
      tool: null,
      toolUseId: null,
      outputPreview: null,
    });
    expect(validateObservationEvent(event)).toEqual({ ok: true, errors: [] });
  });

  test("valid event with hash-only edit field (D3)", () => {
    const event = baseObservation({
      edit: { pathDigest: SHA_A, removedDigest: SHA_A, addedDigest: null },
    });
    expect(validateObservationEvent(event)).toEqual({ ok: true, errors: [] });
  });

  test("rejects unknown event name", () => {
    expect(validateObservationEvent(baseObservation({ event: "nope" as never })).ok).toBe(false);
  });

  test("rejects non-sha256 inputDigest/cwdHash", () => {
    expect(validateObservationEvent(baseObservation({ inputDigest: "abc" })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ cwdHash: "abc" })).ok).toBe(false);
  });

  test("rejects previews over 200 chars", () => {
    expect(validateObservationEvent(baseObservation({ inputPreview: "x".repeat(201) })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ outputPreview: "x".repeat(201) })).ok).toBe(false);
  });

  test("rejects malformed edit shape", () => {
    const event = baseObservation({ edit: { pathDigest: "not-a-hash" } as never });
    expect(validateObservationEvent(event).ok).toBe(false);
  });

  // O-4
  test("rejects an unbounded/out-of-pattern sessionId or toolUseId", () => {
    expect(validateObservationEvent(baseObservation({ sessionId: "has spaces" })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ sessionId: "x".repeat(129) })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ toolUseId: "has spaces" })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ toolUseId: "x".repeat(129) })).ok).toBe(false);
  });

  test("rejects an out-of-pattern tool name", () => {
    expect(validateObservationEvent(baseObservation({ tool: "has spaces" })).ok).toBe(false);
    expect(validateObservationEvent(baseObservation({ tool: "x".repeat(129) })).ok).toBe(false);
  });

  test("accepts sessionId/toolUseId/tool at the pattern's edges", () => {
    expect(validateObservationEvent(baseObservation({ sessionId: "a", toolUseId: "a", tool: "a" })).ok).toBe(true);
    expect(
      validateObservationEvent(baseObservation({ sessionId: "x".repeat(128), toolUseId: "x".repeat(128), tool: "x".repeat(128) })).ok,
    ).toBe(true);
  });

  test("rejects additional properties", () => {
    const event = { ...baseObservation(), extra: 1 };
    expect(validateObservationEvent(event).ok).toBe(false);
  });

  test("rejects missing required fields", () => {
    const event = baseObservation() as Partial<ObservationEvent>;
    delete event.sessionId;
    expect(validateObservationEvent(event).ok).toBe(false);
  });
});
