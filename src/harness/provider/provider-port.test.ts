// RED tests for P-01 (flow 007, W5 / T5).
//
// Pins the provider-neutral `ProviderPort` contract specified in
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`:
// normalized request, the 8 normalized event kinds, the error taxonomy,
// the capability matrix, attempt-scoped identity, unknown-extension
// preservation, and the partial-tool-call rule (AC2). P-01 implements
// `src/harness/provider/types.ts` and `src/harness/provider/provider-port.ts`
// to make this suite GREEN; until then the missing-module import is the
// expected RED failure.
//
// Deterministic: no Date.now(), no network, no randomness. Schema fixtures
// are copied verbatim from the frozen catalogs so this file has no runtime
// dependency on catalog structure beyond the values themselves.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { assertEventValid, assertRequestValid, toolCallExecutable } from "./provider-port";
import type {
  Attempt,
  AttemptOutcome,
  NormalizedError,
  NormalizedEvent,
  NormalizedEventKind,
  NormalizedRequest,
  ProviderCapabilities,
  ProviderErrorKind,
  ProviderPort,
} from "./types";

// Frozen schemas dir, computed relative to this file
// (src/harness/provider/ -> repo root).
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

const SHA256_FIXTURE = "a".repeat(64);

// --- 1. Event kinds & ordering -----------------------------------------------

const EVENT_KINDS: NormalizedEventKind[] = [
  "model_start",
  "text_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
  "usage_update",
  "model_end",
  "provider_error",
];

function makeEvent(
  kind: NormalizedEventKind,
  sequence: number,
  attemptId: string,
  extra: Record<string, unknown> = {},
): NormalizedEvent {
  return { kind, sequence, attemptId, ...extra };
}

describe("normalized event kinds & ordering (provider-protocol.md 'Normalized Events')", () => {
  test("exactly the 8 documented event kinds exist and are distinct", () => {
    expect(EVENT_KINDS).toHaveLength(8);
    expect(new Set(EVENT_KINDS).size).toBe(8);
  });

  test("a trail of NormalizedEvents for one attempt has monotonically increasing sequence numbers and a stable attemptId", () => {
    const attemptId = "attempt-fixture-1";
    const trail = EVENT_KINDS.map((kind, index) => makeEvent(kind, index, attemptId));

    trail.forEach((evt, index) => {
      expect(EVENT_KINDS).toContain(evt.kind);
      expect(evt.attemptId).toBe(attemptId);
      if (index > 0) {
        expect(evt.sequence).toBeGreaterThan(trail[index - 1]!.sequence);
      }
    });
  });

  test("events from different attempts carry independent attemptId values", () => {
    const first = makeEvent("model_start", 0, "attempt-a");
    const second = makeEvent("model_start", 0, "attempt-b");
    expect(first.attemptId).not.toBe(second.attemptId);
    // sequence restarts per-attempt; both are valid at sequence 0 for their own attempt.
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(0);
  });
});

// --- 2. Error taxonomy --------------------------------------------------------

const ERROR_KINDS: ProviderErrorKind[] = [
  "authentication",
  "invalid_request",
  "rate_limit",
  "overloaded",
  "context_overflow",
  "unavailable",
  "cancelled",
  "malformed",
  "unknown",
];

describe("provider error taxonomy (provider-protocol.md 'Error Taxonomy')", () => {
  test("all 9 ProviderErrorKind values are representable as a NormalizedError", () => {
    expect(ERROR_KINDS).toHaveLength(9);
    expect(new Set(ERROR_KINDS).size).toBe(9);
    for (const kind of ERROR_KINDS) {
      const err: NormalizedError = { kind, retryable: false, message: `${kind} fixture` };
      expect(err.kind).toBe(kind);
    }
  });

  test("retryable flags match the protocol table for its unambiguous rows", () => {
    // authentication=no, invalid_request=no, rate_limit=yes, overloaded/5xx=yes,
    // cancelled=no. context_overflow is documented as "conditional" but
    // model-error.schema.json's allOf pins it to retryable=false alongside
    // authentication/invalid_request, so it is unambiguous at the wire level.
    const expected: Record<string, boolean> = {
      authentication: false,
      invalid_request: false,
      rate_limit: true,
      overloaded: true,
      context_overflow: false,
      cancelled: false,
    };
    for (const [kind, retryable] of Object.entries(expected)) {
      const err: NormalizedError = { kind: kind as ProviderErrorKind, retryable, message: "fixture" };
      expect(err.retryable).toBe(retryable);
    }
  });

  test("policy-conditional rows (unavailable/malformed) and 'unknown' are representable with either retry disposition", () => {
    for (const kind of ["unavailable", "malformed", "unknown"] as ProviderErrorKind[]) {
      const retryableErr: NormalizedError = { kind, retryable: true, message: "fixture" };
      const terminalErr: NormalizedError = { kind, retryable: false, message: "fixture" };
      expect(retryableErr.kind).toBe(kind);
      expect(terminalErr.kind).toBe(kind);
    }
  });

  test("a NormalizedError may carry an optional providerRequestId without disturbing required fields", () => {
    const err: NormalizedError = {
      kind: "rate_limit",
      retryable: true,
      message: "rate limited",
      providerRequestId: "req-fixture-1",
    };
    expect(err.providerRequestId).toBe("req-fixture-1");
  });
});

// --- 3. Unknown-extension preservation ---------------------------------------

describe("unknown-extension preservation (provider-protocol.md 'Normalized Events')", () => {
  test("unknownExtensions on a NormalizedEvent are preserved verbatim, not dropped", () => {
    const evt: NormalizedEvent = {
      kind: "model_end",
      sequence: 5,
      attemptId: "attempt-1",
      unknownExtensions: {
        "provider.vendor_field": "[redacted]",
        "provider.trace_id": "trace-xyz",
      },
    };
    expect(evt.unknownExtensions).toEqual({
      "provider.vendor_field": "[redacted]",
      "provider.trace_id": "trace-xyz",
    });
    expect(Object.keys(evt.unknownExtensions ?? {})).toHaveLength(2);
  });

  test("an event with no provider extensions leaves unknownExtensions absent rather than inventing an empty object", () => {
    const evt: NormalizedEvent = { kind: "text_delta", sequence: 1, attemptId: "attempt-1" };
    expect(evt.unknownExtensions).toBeUndefined();
  });
});

// --- 4. Attempt outcomes -------------------------------------------------------

const ATTEMPT_OUTCOMES: AttemptOutcome[] = ["complete", "failed", "cancelled", "abandoned"];

describe("attempt outcomes (provider-protocol.md: 'either completes, fails, is cancelled, or is abandoned')", () => {
  test("all 4 AttemptOutcome values are representable on an Attempt", () => {
    expect(ATTEMPT_OUTCOMES).toHaveLength(4);
    expect(new Set(ATTEMPT_OUTCOMES).size).toBe(4);
    for (const outcome of ATTEMPT_OUTCOMES) {
      const attempt: Attempt = { id: "attempt-1", outcome };
      expect(attempt.outcome).toBe(outcome);
    }
  });
});

// --- 5. Capability matrix -------------------------------------------------------

describe("capability matrix (provider-protocol.md 'Provider Capability Matrix')", () => {
  test("ProviderCapabilities exposes exactly the 9 documented capability flags", () => {
    const caps: ProviderCapabilities = {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: false,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: true,
    };
    expect(Object.keys(caps).sort()).toEqual(
      [
        "modelListing",
        "parallelToolCalls",
        "promptCaching",
        "reasoningMetadata",
        "streaming",
        "structuredOutput",
        "toolCalls",
        "tokenCounting",
        "vision",
      ].sort(),
    );
  });
});

// --- 6. Schema validation reuse (W4 validator, not a new one) ------------------

describe("schema validation reuse — assertRequestValid/assertEventValid call the W4 validateAgainstSchema", () => {
  test("assertRequestValid accepts a good payload (verbatim model-request positive fixture)", () => {
    // Copied from docs/.../fixtures/positive-contract-catalog.json#/cases/model-request.
    const goodRequestPayload = {
      schemaVersion: 1,
      requestId: "request-1",
      attemptId: "attempt-1",
      causal: { runId: "run-1", sessionId: "session-1", correlationId: "c-1" },
      providerId: "fake-provider",
      modelId: "fixture",
      contextManifestHash: SHA256_FIXTURE,
      messages: [{ role: "user", contentHash: SHA256_FIXTURE }],
      toolRegistryHash: SHA256_FIXTURE,
    };

    // NOTE for P-01 impl: model-request.schema.json describes the durable,
    // hashed wire record (attemptId/causal/contentHash/toolRegistryHash), which
    // is a different shape from the in-memory NormalizedRequest pinned above
    // (content/provenance/budget/stream). assertRequestValid's declared param
    // type is NormalizedRequest, so this fixture is passed via a structural
    // cast; if the impl instead expects to serialize a NormalizedRequest into
    // the wire shape before validating, adjust the cast/signature to match and
    // note the delta back to this suite.
    const result = assertRequestValid(goodRequestPayload as unknown as NormalizedRequest, SCHEMA_DIR);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("assertRequestValid rejects a payload missing required wire fields (verbatim model-request-no-attempt negative fixture)", () => {
    // Copied from docs/.../fixtures/negative-contract-catalog.json#/cases/model-request-no-attempt.
    const badRequestPayload = {};
    const result = assertRequestValid(badRequestPayload as unknown as NormalizedRequest, SCHEMA_DIR);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("assertEventValid accepts a good payload (verbatim harness-event positive fixture)", () => {
    // Copied from docs/.../fixtures/positive-contract-catalog.json#/cases/event.
    const goodEventPayload = {
      schemaVersion: 1,
      eventId: "event-1",
      runId: "run-1",
      sessionId: "session-1",
      correlationId: "correlation-1",
      sequence: 0,
      eventType: "run_started",
      timestamp: "2026-01-01T00:00:00Z",
      source: "harness",
      reliability: "exact",
      payload: { kind: "run", runStatus: "started" },
    };
    const result = assertEventValid(goodEventPayload, SCHEMA_DIR);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("assertEventValid rejects an untyped/empty payload (verbatim event-untyped-payload negative fixture)", () => {
    // Copied from docs/.../fixtures/negative-contract-catalog.json#/cases/event-untyped-payload.
    const badEventPayload = {};
    const result = assertEventValid(badEventPayload, SCHEMA_DIR);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// --- 7. Partial tool-call rule (AC2) --------------------------------------------

describe("partial tool-call rule (provider-protocol.md 'Tool Call Semantics', AC2)", () => {
  test("toolCallExecutable is false for a tool_call_delta (partial input)", () => {
    const partial: NormalizedEvent = {
      kind: "tool_call_delta",
      sequence: 3,
      attemptId: "attempt-1",
      toolCallId: "call-1",
      inputDelta: '{"path": "src/',
    };
    expect(toolCallExecutable(partial)).toBe(false);
  });

  test("toolCallExecutable is false for a tool_call_end whose input does not parse as JSON", () => {
    const malformedEnd: NormalizedEvent = {
      kind: "tool_call_end",
      sequence: 4,
      attemptId: "attempt-1",
      toolCallId: "call-1",
      input: '{"path": "src/unterminated',
    };
    expect(toolCallExecutable(malformedEnd)).toBe(false);
  });

  test("toolCallExecutable is true only for a completed tool_call_end with fully-parsed, valid JSON input", () => {
    const completeEnd: NormalizedEvent = {
      kind: "tool_call_end",
      sequence: 4,
      attemptId: "attempt-1",
      toolCallId: "call-1",
      input: JSON.stringify({ path: "src/index.ts" }),
    };
    expect(toolCallExecutable(completeEnd)).toBe(true);
  });

  test("toolCallExecutable is false for every non-tool_call_end kind, even carrying a plausible parsed input field", () => {
    for (const kind of EVENT_KINDS.filter((k) => k !== "tool_call_end")) {
      const evt: NormalizedEvent = {
        kind,
        sequence: 0,
        attemptId: "attempt-1",
        toolCallId: "call-1",
        input: JSON.stringify({ path: "src/index.ts" }),
      };
      expect(toolCallExecutable(evt)).toBe(false);
    }
  });
});

// --- 8. ProviderPort shape (attempt-scoped stream + capability/descriptor) ------

describe("ProviderPort contract shape", () => {
  test("a fake ProviderPort implementation satisfies describe()/stream() and stays attempt-scoped", async () => {
    const fake: ProviderPort = {
      describe: () => ({
        capabilities: {
          streaming: true,
          toolCalls: true,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: true,
        },
        descriptor: { providerId: "fake-provider" },
      }),
      // biome-ignore lint: minimal fixture stream; request/signal unused by the fake.
      stream: async function* (_request, opts) {
        yield { kind: "model_start", sequence: 0, attemptId: opts.attemptId };
        yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
      },
    };

    const described = fake.describe();
    expect(described.capabilities.streaming).toBe(true);
    expect(described.descriptor.providerId).toBe("fake-provider");

    const events: NormalizedEvent[] = [];
    for await (const evt of fake.stream({} as NormalizedRequest, { attemptId: "attempt-x" })) {
      events.push(evt);
    }
    expect(events).toHaveLength(2);
    expect(events.every((evt) => evt.attemptId === "attempt-x")).toBe(true);
    expect(events[1]!.sequence).toBeGreaterThan(events[0]!.sequence);
  });
});

// --- 9. No-SDK-leak (structural) ------------------------------------------------
//
// This is a lightweight belt to the T9 review's suspenders: it catches an
// accidental concrete-SDK import at the type/port layer, but a full
// no-SDK-leak audit (transitive deps, adapter-layer isolation) is left to T9
// review per the dispatch note.

describe("no-SDK-leak (structural belt; full audit left to T9 review)", () => {
  test("provider types/port source files do not import a concrete provider SDK package", () => {
    const bannedPatterns = [
      /@anthropic-ai\/sdk/,
      /from ["']openai["']/,
      /require\(["']openai["']\)/,
      /from ["']@google\/generative-ai["']/,
    ];
    const files = [path.join(import.meta.dir, "types.ts"), path.join(import.meta.dir, "provider-port.ts")];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const pattern of bannedPatterns) {
        expect(pattern.test(source)).toBe(false);
      }
    }
  });
});


test("Retry-After supports seconds, dates and malformed values", async () => {
  const { withRetryAfter } = await import("./provider-port");
  const now = Date.parse("2026-10-08T10:00:00Z");
  const error = () => ({ kind: "unavailable" as const, retryable: true, message: "offline" });
  expect(withRetryAfter(error(), new Headers({ "retry-after": "7" }), () => now).retryAfterMs).toBe(7000);
  expect(withRetryAfter(error(), new Headers({ "retry-after": "Thu, 08 Oct 2026 10:00:12 GMT" }), () => now).retryAfterMs).toBe(12000);
  expect(withRetryAfter(error(), new Headers({ "retry-after": "soon" }), () => now).retryAfterMs).toBeUndefined();
  expect(withRetryAfter(error(), new Headers({ "retry-after": "Thu, 08 Oct 2026 09:00:00 GMT" }), () => now).retryAfterMs).toBe(0);
  expect(withRetryAfter({ kind: "invalid_request", retryable: false, message: "403" }, new Headers({ "retry-after": "7" }), () => now).retryAfterMs).toBeUndefined();
});
