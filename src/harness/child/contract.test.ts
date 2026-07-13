// RED tests for CA-01 (flow 015, W12 / T5): the canonical child-contract
// adapter.
//
// Pins the frozen spec (implementation-plan.md CA-01): "Adapt canonical
// `subagent-dispatch`/`subagent-result` with parent/session/attempt
// extensions and STATUS framing." Evidence gate: "round-trip and transport
// parity fixtures pass."
//
// Frozen extension contract:
// `docs/requirements/keryx-project-agent-harness/schemas/harness-child-contract-extension.schema.json`
// — metadata OVER the canonical `subagent-dispatch`/`subagent-result`
// contracts (`.metaproject/core/gdskills/contracts/`), NOT a replacement wire
// contract. `additionalProperties:false`. The schema's own description notes:
// "STATUS-first prose is adapter framing and must be converted to canonical
// subagent-result before persistence."
//
// CA-01 impl (next dispatch, T6) implements `src/harness/child/contract.ts`:
//   - `buildChildDispatchExtension(input)` — assembles the frozen-schema
//     extension object (schemaVersion:1 injected internally) from parent
//     context (parentRunId/sessionId/attempt/branchId/contextManifestHash/
//     policyFingerprint/budgetReservation/durableResultArtifact). The same
//     builder produces both the "subagent-dispatch" and "subagent-result"
//     variants via `input.canonicalContract`.
//   - `parseChildResult(raw, meta?)` — converts a worker's STATUS-first prose
//     reply (`raw: string`, first line `STATUS: <DONE|NEEDS_CONTEXT|BLOCKED|
//     FAILED|...>`, `meta: ParseChildResultMeta` supplies the pre-built result
//     extension + the canonical fields prose can't carry: runId/dispatchId/
//     timestampUtc/contractVersion) into a canonical `subagent-result` object
//     BEFORE persistence. It also accepts the already-normalized
//     `raw: ParsedChildResult` object form (meta ignored) so the same function
//     round-trips a previously-serialized result and normalizes both
//     transport shapes identically.
//   - `serializeChildResult(parsed)` — JSON-serializes a `ParsedChildResult`
//     (`{ extension, canonical }`) so `parseChildResult(JSON.parse(serialize(x)))`
//     deep-equals `x`.
//
// Until `src/harness/child/contract.ts` exists, the missing-module import is
// the expected RED failure ("Cannot find module './contract'") — NOT a bug in
// this test file.
//
// Deterministic: all ids/hashes/timestamps are fixture constants (no
// `Date.now()`, `Math.random()`, network, or real fs mutation).
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { decodeRpc, encodeRpc } from "../rpc";
import type { RpcEnvelope } from "../rpc";

// PINNED API (see dispatch) — CA-01 impl (T6) exports these; imports fail
// until then (expected RED: "Cannot find module './contract'").
import { buildChildDispatchExtension, parseChildResult, serializeChildResult } from "./contract";
import type {
  BuildChildDispatchExtensionInput,
  CanonicalSubagentResult,
  ChildContractExtension,
  ParseChildResultMeta,
  ParsedChildResult,
} from "./contract";

// Frozen extension schema dir, computed relative to this file
// (src/harness/child/ -> repo root).
const FROZEN_SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

// Canonical gdskills contracts dir (subagent-dispatch/subagent-result).
const CANONICAL_CONTRACTS_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".metaproject",
  "core",
  "gdskills",
  "contracts",
);

const EXTENSION_SCHEMA = "harness-child-contract-extension.schema.json";
const CANONICAL_RESULT_SCHEMA = "subagent-result.schema.json";

// ---------------------------------------------------------------------------
// Deterministic fixtures — fixed ids/hashes/timestamps, no clock/randomness.
// ---------------------------------------------------------------------------

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function makeExtensionInput(
  overrides: Partial<BuildChildDispatchExtensionInput> = {},
): BuildChildDispatchExtensionInput {
  return {
    canonicalContract: "subagent-dispatch",
    canonicalContractVersion: "1.0.0",
    parentRunId: "run-parent-0001",
    sessionId: "session-0001",
    attempt: { attemptId: "attempt-0001", number: 1 },
    branchId: "branch-0001",
    contextManifestHash: HASH_A,
    policyFingerprint: HASH_B,
    budgetReservation: { reservationId: "res-0001", maxRuntimeMs: 60_000, maxToolCalls: 20 },
    durableResultArtifact: {
      artifactId: "artifact-0001",
      kind: "final-report",
      path: "artifacts/child-0001.json",
      hash: HASH_C,
    },
    ...overrides,
  };
}

function makeResultMeta(overrides: Partial<ParseChildResultMeta> = {}): ParseChildResultMeta {
  const extension = buildChildDispatchExtension(
    makeExtensionInput({
      canonicalContract: "subagent-result",
      durableResultArtifact: {
        artifactId: "artifact-0002",
        kind: "final-report",
        path: "artifacts/child-result-0001.json",
        hash: HASH_D,
      },
    }),
  );
  return {
    extension,
    runId: "run-parent-0001",
    dispatchId: "015-T5",
    timestampUtc: "2026-07-13T00:00:00.000Z",
    contractVersion: "1.0.0",
    ...overrides,
  };
}

// --- 1. Extension shape + schema-valid (AC1) --------------------------------

describe("AC1 — buildChildDispatchExtension produces a schema-valid extension", () => {
  test("a valid dispatch input produces an extension that validates against harness-child-contract-extension.schema.json", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput());
    const result = validateAgainstSchema(EXTENSION_SCHEMA, extension, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("every required top-level and nested field is present with the correct type", () => {
    const extension: ChildContractExtension = buildChildDispatchExtension(makeExtensionInput());

    expect(extension.schemaVersion).toBe(1);
    expect(extension.canonicalContract).toBe("subagent-dispatch");
    expect(typeof extension.canonicalContractVersion).toBe("string");
    expect(extension.canonicalContractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof extension.parentRunId).toBe("string");
    expect(typeof extension.sessionId).toBe("string");
    expect(typeof extension.attempt).toBe("object");
    expect(typeof extension.attempt.attemptId).toBe("string");
    expect(typeof extension.attempt.number).toBe("number");
    expect(Number.isInteger(extension.attempt.number)).toBe(true);
    expect(typeof extension.branchId).toBe("string");
    expect(extension.contextManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(extension.policyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof extension.budgetReservation).toBe("object");
    expect(typeof extension.budgetReservation.reservationId).toBe("string");
    expect(typeof extension.budgetReservation.maxRuntimeMs).toBe("number");
    expect(typeof extension.durableResultArtifact).toBe("object");
    expect(typeof extension.durableResultArtifact.artifactId).toBe("string");
    expect(typeof extension.durableResultArtifact.kind).toBe("string");
    expect(extension.durableResultArtifact.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("deleting any required top-level field makes the extension schema-invalid", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput()) as unknown as Record<string, unknown>;
    const requiredTopLevelFields = [
      "schemaVersion",
      "canonicalContract",
      "canonicalContractVersion",
      "parentRunId",
      "sessionId",
      "attempt",
      "branchId",
      "contextManifestHash",
      "policyFingerprint",
      "budgetReservation",
      "durableResultArtifact",
    ];

    for (const field of requiredTopLevelFields) {
      const mutated: Record<string, unknown> = { ...extension };
      delete mutated[field];
      const result = validateAgainstSchema(EXTENSION_SCHEMA, mutated, { schemaDir: FROZEN_SCHEMA_DIR });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("an unknown extra top-level key is rejected (additionalProperties:false)", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput()) as unknown as Record<string, unknown>;
    const mutated = { ...extension, unexpectedField: "not-allowed" };
    const result = validateAgainstSchema(EXTENSION_SCHEMA, mutated, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("attempt.number as a string instead of an integer is rejected", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput()) as unknown as Record<string, unknown>;
    const attempt = extension.attempt as Record<string, unknown>;
    const mutated = { ...extension, attempt: { ...attempt, number: "1" } };
    const result = validateAgainstSchema(EXTENSION_SCHEMA, mutated, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("policyFingerprint that is not a 64-char hex sha256 is rejected", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput()) as unknown as Record<string, unknown>;
    const mutated = { ...extension, policyFingerprint: "not-a-sha256" };
    const result = validateAgainstSchema(EXTENSION_SCHEMA, mutated, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// --- 2. canonicalContract enum -----------------------------------------------

describe("AC1 — canonicalContract enum reflects the contract being extended", () => {
  test("building for a dispatch yields canonicalContract:'subagent-dispatch'", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput({ canonicalContract: "subagent-dispatch" }));
    expect(extension.canonicalContract).toBe("subagent-dispatch");
    const result = validateAgainstSchema(EXTENSION_SCHEMA, extension, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.valid).toBe(true);
  });

  test("building for a result yields canonicalContract:'subagent-result'", () => {
    const extension = buildChildDispatchExtension(makeExtensionInput({ canonicalContract: "subagent-result" }));
    expect(extension.canonicalContract).toBe("subagent-result");
    const result = validateAgainstSchema(EXTENSION_SCHEMA, extension, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(result.valid).toBe(true);
  });
});

// --- 3. STATUS-first prose -> canonical subagent-result BEFORE persistence --

describe("AC1 — STATUS-first prose is converted to a canonical subagent-result BEFORE persistence", () => {
  const statusCases: Array<{ token: string; expected: CanonicalSubagentResult["status"] }> = [
    { token: "DONE", expected: "DONE" },
    { token: "NEEDS_CONTEXT", expected: "NEEDS_CONTEXT" },
    { token: "BLOCKED", expected: "BLOCKED" },
    { token: "FAILED", expected: "FAILED" },
  ];

  for (const { token, expected } of statusCases) {
    test(`STATUS: ${token} maps to canonical status "${expected}" and validates against subagent-result.schema.json`, () => {
      const raw = `STATUS: ${token}\n\n## Notes\n- worker reply for token ${token}\n`;
      const meta = makeResultMeta();

      const { canonical, extension } = parseChildResult(raw, meta);

      expect(canonical.status).toBe(expected);
      expect(extension).toEqual(meta.extension);

      const result = validateAgainstSchema(CANONICAL_RESULT_SCHEMA, canonical, {
        schemaDir: CANONICAL_CONTRACTS_DIR,
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  }

  test("the persisted form is the canonical object, not the raw STATUS-first prose string", () => {
    const raw = "STATUS: DONE\n\n## Completed\n- adapter built the extension\n";
    const meta = makeResultMeta();

    const { canonical } = parseChildResult(raw, meta);

    expect(typeof canonical).toBe("object");
    expect(canonical).not.toBe(raw as unknown as CanonicalSubagentResult);
    expect(JSON.stringify(canonical).startsWith('"STATUS:')).toBe(false);
    expect(canonical.status).toBe("DONE");
    expect(canonical.run_id).toBe(meta.runId);
    expect(canonical.dispatch_id).toBe(meta.dispatchId);
    expect(canonical.timestamp_utc).toBe(meta.timestampUtc);
  });
});

// --- 4. Round-trip identity (AC2) -------------------------------------------

describe("AC2 — round-trip identity: build -> serialize -> parse yields deep-equal extension+canonical", () => {
  test("a DONE result round-trips without field loss or reorder sensitivity", () => {
    const meta = makeResultMeta();
    const raw = "STATUS: DONE\n\n## Completed\n- implemented the canonical adapter\n";
    const built: ParsedChildResult = parseChildResult(raw, meta);

    const serialized = serializeChildResult(built);
    const parsedBack = parseChildResult(JSON.parse(serialized) as ParsedChildResult);

    expect(parsedBack).toEqual(built);
  });

  test("a NEEDS_CONTEXT result round-trips identically", () => {
    const meta = makeResultMeta({ dispatchId: "015-T5-needs-context" });
    const raw = "STATUS: NEEDS_CONTEXT\n\n## Missing information\n- the frozen schema path\n";
    const built: ParsedChildResult = parseChildResult(raw, meta);

    const serialized = serializeChildResult(built);
    const parsedBack = parseChildResult(JSON.parse(serialized) as ParsedChildResult);

    expect(parsedBack).toEqual(built);
    expect(parsedBack.canonical.status).toBe("NEEDS_CONTEXT");
  });
});

// --- 5. Transport parity (AC2) ----------------------------------------------

describe("AC2 — transport parity: CLI (plain-object) and JSONL/RPC forms agree byte-for-byte", () => {
  test("decodeRpc(encodeRpc(env)).payload deep-equals the direct CLI object form, and both parse to an identical persisted canonical result", () => {
    const meta = makeResultMeta();
    const raw = "STATUS: DONE\n\n## Completed\n- built the child contract extension\n";
    const cliForm: ParsedChildResult = parseChildResult(raw, meta);

    const envelope: RpcEnvelope = {
      schemaVersion: 1,
      messageId: "child-result-0001",
      correlationId: "015-T5",
      kind: "response",
      payload: cliForm as unknown as Record<string, unknown>,
    };
    const decoded = decodeRpc(encodeRpc(envelope));

    // Transport round-trips the plain-object CLI form unchanged.
    expect(decoded.payload).toEqual(cliForm as unknown as Record<string, unknown>);

    // Re-parsing either form must yield byte-identical persisted canonical output.
    const rpcForm = parseChildResult(decoded.payload as unknown as ParsedChildResult);

    expect(JSON.stringify(rpcForm.canonical)).toBe(JSON.stringify(cliForm.canonical));
    expect(JSON.stringify(rpcForm.extension)).toBe(JSON.stringify(cliForm.extension));
    expect(rpcForm.canonical.status).toBe("DONE");
  });
});

// --- 6. Determinism -----------------------------------------------------------

describe("Determinism — identical inputs yield identical output (no Date.now/Math.random)", () => {
  test("buildChildDispatchExtension is pure: building twice from equivalent input is deep-equal", () => {
    const first = buildChildDispatchExtension(makeExtensionInput());
    const second = buildChildDispatchExtension(makeExtensionInput());
    expect(first).toEqual(second);
  });

  test("parseChildResult is pure: same raw prose + equivalent meta twice is deep-equal", () => {
    const raw = "STATUS: BLOCKED\n\n## Reason\n- waiting on a parent decision\n";
    const first = parseChildResult(raw, makeResultMeta());
    const second = parseChildResult(raw, makeResultMeta());
    expect(first).toEqual(second);
  });
});
