// Provider-neutral normalized types for the Keryx harness (flow 007, W5 / P-01).
//
// These types pin the provider boundary specified in
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`. They are
// deliberately SDK-free: no concrete provider client package (Anthropic,
// OpenAI-compatible, Google, or any other) is imported here. A provider adapter
// maps its wire protocol onto these neutral shapes; unknown provider fields are
// preserved (namespaced/redacted) in `unknownExtensions` rather than discarded.

/**
 * The 8 documented normalized event kinds. Every provider stream normalizes to
 * exactly these (`provider-protocol.md` -> "Normalized Events").
 */
export type NormalizedEventKind =
  | "model_start"
  | "text_delta"
  /** Chain-of-thought text from a reasoning-capable model (carried in `text`). */
  | "reasoning_delta"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_end"
  | "usage_update"
  | "model_end"
  | "provider_error";

/**
 * The 9 provider error classifications (`provider-protocol.md` -> "Error
 * Taxonomy"). `malformed` is the in-memory name for the wire schema's
 * "malformed response" row; the durable `model-error.schema.json` enum folds it
 * into `unknown`, but the neutral runtime taxonomy keeps it distinct so retry
 * policy ("retry once, then fail provider task") can be expressed.
 */
export type ProviderErrorKind =
  | "authentication"
  | "invalid_request"
  | "rate_limit"
  | "overloaded"
  | "context_overflow"
  | "unavailable"
  | "cancelled"
  | "malformed"
  | "unknown";

/**
 * An attempt "either completes, fails, is cancelled, or is abandoned after
 * partial output" (`provider-protocol.md` -> "Normalized Events").
 */
export type AttemptOutcome = "complete" | "failed" | "cancelled" | "abandoned";

/**
 * A normalized, provider-neutral error. `retryable` is the runtime's retry
 * disposition for this specific occurrence (the taxonomy fixes it for the
 * unambiguous rows; policy decides the conditional rows). `message` is
 * already redacted of any credential material by the adapter.
 */
export interface NormalizedError {
  kind: ProviderErrorKind;
  retryable: boolean;
  message: string;
  /** Optional provider-supplied request id for correlation/debugging. */
  providerRequestId?: string;
  /** Optional bounded backoff hint (ms) for retryable rows. */
  retryAfterMs?: number;
}

/**
 * A single normalized streaming event. `kind`, `sequence`, and `attemptId` are
 * always present; the remaining fields are populated per-kind. Unknown provider
 * extensions are preserved verbatim in `unknownExtensions` (namespaced,
 * redacted) and never dropped.
 */
export interface NormalizedEvent {
  kind: NormalizedEventKind;
  /** Monotonically increasing within a single attempt; restarts per attempt. */
  sequence: number;
  /** Stable identity of the attempt that produced this event. */
  attemptId: string;
  /** `text_delta` payload. */
  text?: string;
  /** Correlates `tool_call_start`/`tool_call_delta`/`tool_call_end`. */
  toolCallId?: string;
  /** Tool name announced on `tool_call_start`. */
  toolName?: string;
  /** Partial JSON input fragment on `tool_call_delta` — never executable. */
  inputDelta?: string;
  /** Complete raw JSON input string on `tool_call_end`. */
  input?: string;
  /** `usage_update` counters (exact only when the provider reported them). */
  usage?: NormalizedUsage;
  /** `provider_error` payload. */
  error?: NormalizedError;
  /**
   * Provider-specific fields with no neutral mapping, preserved as-is under a
   * namespaced key (e.g. `provider.trace_id`) with sensitive values redacted.
   */
  unknownExtensions?: Record<string, unknown>;
}

/** Normalized token usage. Fields are absent when the provider did not report them. */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** True only when the counts above are provider-reported exact values. */
  exact?: boolean;
}

/** A single message in a normalized request, with provenance class. */
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Trust provenance of the content (trusted policy vs. project/model output). */
  provenance?: "trusted" | "project" | "model" | "tool";
}

/** A neutral tool definition surfaced to the provider. */
export interface NormalizedToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  /** Risk metadata used by policy resolution. */
  risk?: string;
}

/** Optional sampling/decoding options, only set when the provider supports them. */
export interface NormalizedRequestOptions {
  temperature?: number;
  reasoning?: string;
  verbosity?: string;
}

/** Output/run token budget for a request. */
export interface NormalizedBudget {
  maxOutputTokens: number;
  /** Total run reservation this request draws against. */
  runReservation: number;
}

/**
 * The in-memory runtime request (`provider-protocol.md` -> "Normalized
 * Request"): content, provenance, budget, and stream mode. This is distinct
 * from the durable, hashed wire record described by `model-request.schema.json`
 * (attemptId/causal/contentHash/toolRegistryHash); an adapter serializes this
 * in-memory shape into that wire shape before persisting/validating.
 */
export interface NormalizedRequest {
  providerId: string;
  modelId: string;
  /** System instruction assembled from trusted Keryx policy + project context. */
  systemInstruction: string;
  /** Ordered messages with provenance class. */
  messages: NormalizedMessage[];
  /** Tool definitions with schemas and risk metadata. */
  tools?: NormalizedToolDefinition[];
  options?: NormalizedRequestOptions;
  budget: NormalizedBudget;
  /** Stream mode. */
  stream: boolean;
  /** Cancellation signal for the in-flight request. */
  signal?: AbortSignal;
  requestId: string;
  /** Parent run id for correlation. */
  parentRunId: string;
}

/**
 * Provider capability matrix (`provider-protocol.md` -> "Provider Capability
 * Matrix"). Exactly these 9 flags; an absent capability degrades to a
 * documented fallback.
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  reasoningMetadata: boolean;
  promptCaching: boolean;
  vision: boolean;
  tokenCounting: boolean;
  modelListing: boolean;
}

/** A neutral, minimal provider descriptor surfaced by `ProviderPort.describe()`. */
export interface ProviderDescriptorSummary {
  providerId: string;
  providerRevision?: string;
}

/** The value returned by `ProviderPort.describe()`. */
export interface ProviderDescription {
  capabilities: ProviderCapabilities;
  descriptor: ProviderDescriptorSummary;
}

/** Options passed to a single attempt-scoped `stream()` invocation. */
export interface StreamOptions {
  /** Stable identity for this attempt; stamped on every yielded event. */
  attemptId: string;
  /** Cancellation signal for the attempt. */
  signal?: AbortSignal;
}

/**
 * A single provider attempt. `sequence` numbering and every emitted event are
 * scoped to `id`; the attempt resolves to exactly one `AttemptOutcome`.
 */
export interface Attempt {
  id: string;
  outcome: AttemptOutcome;
  /** Populated when `outcome` is `failed` (or a cancellation carried an error). */
  error?: NormalizedError;
}

/**
 * The provider-neutral port. A concrete adapter implements it without leaking
 * any SDK type across this boundary.
 */
export interface ProviderPort {
  /** Advertise capabilities and identity as data. */
  describe(): ProviderDescription;
  /**
   * Open an attempt-scoped normalized event stream. Every yielded event carries
   * `opts.attemptId`; `opts.signal` cancels the in-flight request.
   */
  stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent>;
}
