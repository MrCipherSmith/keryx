// Provider-neutral normalized types for the Keryx harness (flow 007, W5 / P-01).
//
// These types pin the provider boundary specified in
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`. They are
// deliberately SDK-free: no concrete provider client package (Anthropic,
// OpenAI-compatible, Google, or any other) is imported here. A provider adapter
// maps its wire protocol onto these neutral shapes; unknown provider fields are
// preserved (namespaced/redacted) in `unknownExtensions` rather than discarded.

/**
 * The 8 documented normalized event kinds (`provider-protocol.md` -> "Normalized
 * Events"), plus `reasoning_delta`/`reasoning_replay` (flow 268 T11), added after
 * that doc froze to carry reasoning/chain-of-thought support without touching
 * the frozen 8-kind contract `assertEventValid`/`provider-port.test.ts` pin.
 */
export type NormalizedEventKind =
  | "model_start"
  | "text_delta"
  /**
   * Chain-of-thought text from a reasoning-capable model, carried in `text`.
   * `redacted: true` on this event means the provider produced reasoning here
   * but withheld its plain text (e.g. Anthropic's `redacted_thinking` block) —
   * `text` is absent or empty in that case; the opaque bytes needed to send it
   * back, if any, arrive separately as a `reasoning_replay` event.
   */
  | "reasoning_delta"
  /**
   * An opaque, provider-specific payload (`replay`) that a later request must
   * echo back verbatim to keep a reasoning round valid (a `thinking` block's
   * `signature`, an OpenAI Responses reasoning item's `encrypted_content`, a
   * Gemini `thoughtSignature`, MiniMax `reasoning_details`, …). Never carries
   * visible text; not redacted/edited/shown — see {@link ProviderReplayItem}.
   */
  | "reasoning_replay"
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
  /** `text_delta` payload; also `reasoning_delta`'s visible chain-of-thought text. */
  text?: string;
  /**
   * `reasoning_delta` only: true when this delta's reasoning content was
   * withheld by the provider (no meaningful `text`). See the `reasoning_delta`
   * kind doc on {@link NormalizedEventKind}. Absent/false elsewhere.
   */
  redacted?: boolean;
  /**
   * `reasoning_replay` payload: the opaque bytes an adapter must send back
   * verbatim to keep this reasoning round valid on the next request. See
   * {@link ProviderReplayItem}.
   */
  replay?: ProviderReplayItem;
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

/** One tool call an assistant turn emitted, as the provider reported it. */
export interface NormalizedToolCall {
  /** Provider-assigned call id; the anchor a tool result references. */
  id: string;
  name: string;
  /** Raw JSON argument text as emitted — NOT parsed or validated here. */
  arguments: string;
}

/**
 * An opaque, JSON-serialisable payload a SPECIFIC provider adapter must send
 * back verbatim to keep a reasoning round valid on a later request (flow 268
 * T11, foundation for T12–T15's adapters). `providerId` scopes it — an adapter
 * for a different provider must ignore an item it does not own rather than
 * guess at its shape. `kind` is adapter-defined (e.g. `"thinking_signature"`,
 * `"encrypted_content"`, `"reasoning_details"`, `"thought_signature"`) so one
 * provider can carry more than one replay shape per round. `data` is never
 * shown to the user, never edited by the agent loop or by redaction (mutating
 * it — even whitespace-preserving masking — would invalidate a provider
 * signature and break the round), and never parsed/interpreted outside the
 * owning adapter.
 */
export interface ProviderReplayItem {
  providerId: string;
  kind: string;
  data: unknown;
}

/**
 * Reasoning metadata attached to an assistant {@link NormalizedMessage} (flow
 * 268 T11). Provider-neutral by construction: the agent loop stores this
 * without knowing what a specific provider's `replay` payloads contain.
 *
 * - `text`: accumulated visible chain-of-thought for the round, if any (same
 *   text `io.onReasoning` was already given — this is what makes that
 *   forwarding-only behavior ALSO durable in history/session storage).
 * - `redacted`: true when at least part of this round's reasoning was
 *   withheld by the provider (see `reasoning_delta`'s `redacted` field).
 * - `replay`: opaque items, in event order, a later request replays verbatim
 *   to the SAME provider (see {@link ProviderReplayItem}) — untouched by
 *   redaction/display formatting.
 * - `durationMs`/`tokens`: optional display metadata for a later TUI (T17).
 *   `durationMs` is filled here (cheap: two `deps.now()` reads bracketing the
 *   round's reasoning span) since `deps.now` is always available (defaults to
 *   `() => new Date().toISOString()`); `tokens` is left for T17, which has a
 *   provider-reported reasoning-token count to use that this layer does not.
 */
export interface MessageReasoning {
  text?: string;
  redacted?: boolean;
  replay?: ProviderReplayItem[];
  durationMs?: number;
  tokens?: number;
}

/** A single message in a normalized request, with provenance class. */
export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Trust provenance of the content (trusted policy vs. project/model output). */
  provenance?: "trusted" | "project" | "model" | "tool";
  /**
   * Assistant only: the tool calls this turn emitted.
   *
   * Without this the assistant's own turn was absent from every subsequent
   * request — a tool-call-only round wrote nothing to history — so the model was
   * asked to continue a transcript in which it had never called a tool and the
   * results appeared as if a human had pasted them. Both adapters degrade to the
   * old text-only form when a call cannot be linked to its result, so the field
   * is safe to omit and safe to ignore.
   */
  toolCalls?: NormalizedToolCall[];
  /** Tool only: the id of the assistant call this message answers. */
  toolCallId?: string;
  /**
   * ISO timestamp of when this message first entered history (set at the
   * `history.push(...)` call site, not at whatever checkpoint later flushes
   * it to disk). Optional and store-only bookkeeping: no request builder
   * reads it (they construct provider payloads field by field — see
   * `toAnthropicMessages`/`toGeminiContents`/`toResponsesInput`/the compat
   * provider's inline builder — so an extra field here never reaches the
   * wire), and a caller that omits it is unaffected: `session/store.ts`
   * falls back to the checkpoint-flush time for any message without one,
   * which is the pre-existing behavior.
   */
  ts?: string;
  /**
   * Assistant only: chain-of-thought metadata for the round that produced
   * this message (flow 268 T11). Attached alongside `toolCalls` on a
   * tool-call-only round, and on a text round, so neither shape loses it.
   * Never set to an empty object — absent means "no reasoning this round",
   * matching every pre-existing message. See {@link MessageReasoning}.
   */
  reasoning?: MessageReasoning;
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
