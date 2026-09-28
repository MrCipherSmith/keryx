// Provider-neutral port helpers for the Keryx harness (flow 007, W5 / P-01).
//
// Implements the validation, tool-call gating, and retry-taxonomy helpers for
// the `ProviderPort` boundary specified in
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`.
//
// Schema validation REUSES the W4 validator (`src/contracts/validateAgainstSchema`);
// this module adds no new dependency and imports no provider SDK.

import { type ValidationResult, validateAgainstSchema } from "../../contracts/validator";
import type { NormalizedEvent, NormalizedRequest, ProviderErrorKind, ProviderPort } from "./types";

export type { ProviderPort };

/** Frozen durable wire-record schema for a model request. */
const MODEL_REQUEST_SCHEMA = "model-request.schema.json";
/** Frozen harness event-envelope schema. */
const HARNESS_EVENT_SCHEMA = "harness-event.schema.json";

/**
 * Validate a request payload against the frozen `model-request` schema, reusing
 * the W4 validator.
 *
 * NOTE (wire vs. in-memory delta): `model-request.schema.json` describes the
 * durable, hashed WIRE record (attemptId/causal/contentHash/toolRegistryHash),
 * which is a different shape from the in-memory {@link NormalizedRequest}
 * (content/provenance/budget/stream). The T5 suite passes wire-shaped fixtures
 * cast through `NormalizedRequest`, so this helper validates the payload it is
 * given directly against the wire schema — an adapter is responsible for
 * serializing an in-memory `NormalizedRequest` into that wire shape before
 * calling this. The declared param type matches the T5 signature verbatim.
 */
export function assertRequestValid(request: NormalizedRequest, schemaDir: string): ValidationResult {
  return validateAgainstSchema(MODEL_REQUEST_SCHEMA, request, { schemaDir });
}

/**
 * Validate a harness event payload against the frozen `harness-event` schema,
 * reusing the W4 validator.
 */
export function assertEventValid(event: unknown, schemaDir: string): ValidationResult {
  return validateAgainstSchema(HARNESS_EVENT_SCHEMA, event, { schemaDir });
}

/**
 * Gate for AC2: a tool call is executable ONLY after the provider marks it
 * complete (`tool_call_end`) AND its full raw JSON input parses. Partial
 * `tool_call_delta` fragments and any non-`tool_call_end` event never authorize
 * execution, even if they happen to carry a plausible `input` field. Full tool
 * schema validation and policy resolution happen downstream (P-02); this is the
 * port-level parse gate only.
 */
export function toolCallExecutable(event: NormalizedEvent): boolean {
  if (event.kind !== "tool_call_end") {
    return false;
  }
  if (typeof event.input !== "string") {
    return false;
  }
  try {
    JSON.parse(event.input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default retry disposition per the protocol "Error Taxonomy" table for the
 * rows the wire schema pins unambiguously. Conditional rows
 * (`unavailable`/`malformed`) and `unknown` return `undefined`, signalling that
 * policy must decide; callers should not treat `undefined` as retryable.
 */
export function defaultRetryable(kind: ProviderErrorKind): boolean | undefined {
  switch (kind) {
    case "authentication":
    case "invalid_request":
    case "context_overflow":
    case "cancelled":
      return false;
    case "rate_limit":
    case "overloaded":
      return true;
    default:
      // unavailable | malformed | unknown -> policy-conditional.
      return undefined;
  }
}

/**
 * Resolve a concrete retry disposition, falling back for policy-conditional
 * rows (A-6, flow 356): byte-identical in all four full adapters
 * (anthropic, openai, gemini, openai-compat) before this move — each one
 * separately re-implemented this exact two-line wrapper over
 * {@link defaultRetryable} rather than sharing it. Moved here once; every
 * adapter imports this instead of defining its own copy.
 */
export function retryableFor(kind: ProviderErrorKind, fallback: boolean): boolean {
  const concrete = defaultRetryable(kind);
  return concrete === undefined ? fallback : concrete;
}
