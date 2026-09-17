// Anthropic Messages-API provider adapter (flow 018, W14 / RP-01).
//
// The FIRST real `ProviderPort`: a THIN `fetch` + SSE adapter over the Anthropic
// Messages API (`POST /v1/messages`, `stream:true`) behind an explicit network
// capability grant and a storage-off privacy/retention contract. NO Anthropic
// SDK, NO new dependency — only the injected `fetch`, the neutral W5 port types,
// the pure W14 SSE parser, and the reused W15 private-egress predicate cross
// this module's boundary.
//
// Determinism / offline: `fetch` is always injected via `deps.fetch` (the global
// is never touched); no `Date.now`/`Math.random` (a clock is injectable via
// `deps.clock` but unused on the offline paths). Every yielded event/error is
// scrubbed of the credential before it leaves this module, and nothing is ever
// persisted (storage-off).

import { isPrivateEgressHost } from "../../mutation/guard";
import { defaultRetryable } from "../provider-port";
import { linkToolCalls } from "../tool-call-linking";
import type {
  NormalizedError,
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedUsage,
  ProviderCapabilities,
  ProviderDescription,
  ProviderErrorKind,
  ProviderPort,
  StreamOptions,
} from "../types";
import { AnthropicSSEParser } from "./sse";

/** Explicit capability grant authorizing this adapter to reach the network. */
export interface AnthropicCapabilityGrant {
  readonly network: true;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export interface AnthropicProviderDeps {
  readonly fetch: typeof fetch;
  readonly grant?: AnthropicCapabilityGrant;
  readonly clock?: () => number;
  /**
   * Deadline (ms) for the first stream byte to arrive after the response
   * headers resolve. Guards a connection the API accepted but never started
   * answering. Defaults to {@link DEFAULT_STREAM_TIMEOUT_MS} (120s).
   */
  readonly firstByteTimeoutMs?: number;
  /**
   * Deadline (ms) between successive stream chunks once the first byte has
   * arrived. Guards a connection that started answering and then stalled.
   * Defaults to {@link DEFAULT_STREAM_TIMEOUT_MS} (120s).
   */
  readonly idleTimeoutMs?: number;
}

/** One model advertised by {@link AnthropicProvider.descriptorDocument}. */
export interface AnthropicModelDescriptor {
  modelId: string;
  revision: string;
}

/**
 * The durable, schema-validating descriptor document for the Anthropic provider.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export interface AnthropicProviderDescriptorDocument {
  schemaVersion: number;
  providerId: string;
  providerRevision: string;
  models: AnthropicModelDescriptor[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelToolCalls: boolean;
    cancellation: boolean;
    structuredOutput?: boolean;
  };
  remoteState: { storage: false; retention: false; continuation: false };
}

/** Public Anthropic Messages API base URL used when the grant supplies none. */
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** Non-empty Anthropic API version header value. */
const ANTHROPIC_VERSION = "2023-06-01";
/** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
const PROVIDER_REVISION = "anthropic-2024-10-22";
/** The single model this adapter fixture pins. */
const DEFAULT_MODEL: AnthropicModelDescriptor = {
  modelId: "claude-3-5-sonnet-20241022",
  revision: "20241022",
};

/** A normalized event without its per-attempt bookkeeping fields. */
type EventBody = Omit<NormalizedEvent, "sequence" | "attemptId">;

/**
 * In-progress content-block state, keyed by the wire `index`. `input` doubles
 * as the tool's partial-JSON accumulator and the `thinking` block's visible
 * text accumulator (mutually exclusive by `type`); `signature` accumulates a
 * `thinking` block's `signature_delta` fragments; `redactedData` captures a
 * `redacted_thinking` block's opaque `data` at `content_block_start` (it
 * carries no deltas).
 */
interface BlockState {
  type: "tool" | "text" | "thinking" | "redacted_thinking";
  toolCallId?: string;
  input: string;
  signature?: string;
  redactedData?: string;
}

/** This adapter's own `providerId`, stamped on every `reasoning_replay` item it emits. */
const PROVIDER_ID = "anthropic";

/** Thinking-request family (Anthropic 2026 thinking API) a model id belongs to. */
export type AnthropicModelFamily = "adaptive" | "budget";

/**
 * `-4-5` generation marker (Haiku 4.5, Sonnet 4.5, Opus 4.5): these, plus any
 * `claude-3*`/`claude-2*` id, are the "budget" family (`thinking: { type:
 * "enabled", budget_tokens }`). Everything else — Opus 5, Sonnet 5, Fable,
 * Mythos, Opus 4.6/4.7/4.8, Sonnet 4.6, and any unrecognized future claude id
 * — defaults to "adaptive" (`thinking: { type: "adaptive" }` +
 * `output_config.effort`), matching the newer models' behavior of thinking
 * by default even when no reasoning effort was requested.
 */
const BUDGET_FAMILY_PATTERN = /(^|\D)4-5(\D|$)/;
/** Any Claude 3.x or 2.x generation id (`claude-3-5-sonnet-...`, `claude-2.1`, ...). */
const OLD_GENERATION_PATTERN = /claude-[23](\D|$)/;
/** Opus/Sonnet 4.6: adaptive family, but WITHOUT an `xhigh` effort level. */
const NO_XHIGH_PATTERN = /(^|\D)4-6(\D|$)/;

/**
 * Classify `modelId` into its thinking-request family. Pure and exported so
 * request-building logic and tests share one source of truth.
 */
export function anthropicModelFamily(modelId: string): AnthropicModelFamily {
  const id = modelId.toLowerCase();
  if (BUDGET_FAMILY_PATTERN.test(id) || OLD_GENERATION_PATTERN.test(id)) {
    return "budget";
  }
  return "adaptive";
}

/** `budget_tokens` for each reasoning effort level on a "budget"-family model. */
const BUDGET_TOKENS_BY_EFFORT: Record<string, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16000,
  max: 16000,
};

/** Fallback `budget_tokens` for an effort string outside the documented set. */
const DEFAULT_BUDGET_TOKENS = BUDGET_TOKENS_BY_EFFORT.medium!;

/** The request-body fields a reasoning effort setting contributes (`thinking` shape and `max_tokens`). */
interface ThinkingRequestParams {
  thinking?: Record<string, unknown>;
  outputConfig?: Record<string, unknown>;
  maxTokens: number;
}

/**
 * Resolve the `thinking`/`output_config`/`max_tokens` request fields for a
 * given model + reasoning effort. `effort` absent or `"off"` means the user
 * did not ask for reasoning: no `thinking` param is sent at all (an
 * "adaptive"-family model may still think by default — that is fine, it is
 * captured and replayed regardless of whether it was requested).
 */
function buildThinkingParams(
  modelId: string,
  effort: string | undefined,
  maxOutputTokens: number,
): ThinkingRequestParams {
  if (effort === undefined || effort === "off") {
    return { maxTokens: maxOutputTokens };
  }
  const family = anthropicModelFamily(modelId);
  if (family === "adaptive") {
    const resolvedEffort = effort === "xhigh" && NO_XHIGH_PATTERN.test(modelId.toLowerCase()) ? "high" : effort;
    return {
      // "summarized" display is REQUIRED: these models default to "omitted",
      // which arrives with an EMPTY thinking text (the round is still valid
      // and replayed, but the user sees nothing).
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: resolvedEffort },
      maxTokens: maxOutputTokens,
    };
  }
  const budgetTokens = BUDGET_TOKENS_BY_EFFORT[effort] ?? DEFAULT_BUDGET_TOKENS;
  return {
    thinking: { type: "enabled", budget_tokens: budgetTokens },
    // budget_tokens must be < max_tokens; raise max_tokens to make room for
    // both the thinking budget and the requested output budget.
    maxTokens: budgetTokens + maxOutputTokens,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A `tool_use` block carries an OBJECT input, while the normalized call keeps the
 * raw argument text the provider emitted. Argument text is model output and can
 * be truncated or malformed, so a parse failure degrades to an empty object
 * rather than throwing while the request body is being built — the request still
 * goes out and the model sees its own call.
 */
/**
 * This adapter's own `thinking`/`redacted_thinking` replay items on a message
 * (owned means `providerId === "anthropic"`; a foreign item — carried over
 * from a different provider adapter, e.g. after a mid-session provider switch
 * — is ignored here rather than guessed at), in stored (event) order, as
 * READY-TO-SEND wire blocks. `item.data` is already the exact wire block
 * shape (`{ type: "thinking", thinking, signature }` /
 * `{ type: "redacted_thinking", data }`) constructed when the block was
 * parsed, so replay is a verbatim echo — no reshaping, no touching the
 * signature/opaque bytes.
 */
function ownedThinkingBlocks(message: NormalizedMessage): Record<string, unknown>[] {
  const replay = message.reasoning?.replay;
  if (replay === undefined || replay.length === 0) {
    return [];
  }
  const blocks: Record<string, unknown>[] = [];
  for (const item of replay) {
    if (item.providerId !== PROVIDER_ID) {
      continue;
    }
    if (item.kind === "thinking" || item.kind === "redacted_thinking") {
      blocks.push(asRecord(item.data));
    }
  }
  return blocks;
}

/**
 * Serialize a normalized conversation into Anthropic Messages wire form.
 *
 * Anthropic expresses the tool loop as content BLOCKS: `tool_use` on the
 * assistant turn, `tool_result` on the following user turn, linked by id.
 * Flattening every non-assistant message to plain text erased the model's own
 * calls from the transcript it was asked to continue. Only pairs that hold
 * together inside THIS request become blocks (`linkToolCalls`); a half-pair
 * keeps the previous plain mapping, so a compacted or resumed window cannot
 * produce a dangling reference.
 *
 * An assistant message that owns `thinking`/`redacted_thinking` replay items
 * (flow 268 T13) ALSO becomes array-content, even when it has no linked tool
 * calls (a thinking-only text round): those blocks are replayed first, in
 * their original order, before the `text` and `tool_use` blocks — dropping or
 * reordering an earlier round's thinking block is treated as history editing
 * by newer models and can be rejected, so every prior assistant message that
 * owns replay items gets it here, not only the most recent one.
 */
export function toAnthropicMessages(messages: readonly NormalizedMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const linked of linkToolCalls(messages)) {
    const message = linked.message;
    const thinkingBlocks = message.role === "assistant" ? ownedThinkingBlocks(message) : [];
    if (
      message.role === "assistant" &&
      message.content.length === 0 &&
      linked.linkedCalls.length === 0 &&
      thinkingBlocks.length === 0
    ) {
      // A tool-call turn whose calls could not be linked carries no text, no
      // calls, and no thinking to replay. Anthropic REJECTS an empty content
      // string, and this message only exists at all because assistant tool
      // calls are now recorded — so it must not reach the wire.
      continue;
    }
    if (message.role === "tool" && linked.linkedToolCallId !== undefined) {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: linked.linkedToolCallId, content: message.content }],
      });
      continue;
    }
    if (message.role === "assistant" && (linked.linkedCalls.length > 0 || thinkingBlocks.length > 0)) {
      const blocks: Record<string, unknown>[] = [...thinkingBlocks];
      if (message.content.length > 0) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of linked.linkedCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolInput(call.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    });
  }
  return out;
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  if (rawArguments.trim().length === 0) {
    return {};
  }
  try {
    return asRecord(JSON.parse(rawArguments));
  } catch {
    return {};
  }
}

/** Resolve a concrete retry disposition, falling back for policy-conditional rows. */
function retryableFor(kind: ProviderErrorKind, fallback: boolean): boolean {
  const concrete = defaultRetryable(kind);
  return concrete === undefined ? fallback : concrete;
}

/** Merge Anthropic's split token counts into a single exact {@link NormalizedUsage}. */
function mergeUsage(inputTokens: number | undefined, outputTokens: number | undefined): NormalizedUsage {
  const usage: NormalizedUsage = { exact: true };
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  return usage;
}

/** Classify a non-2xx HTTP response into the neutral error taxonomy. */
function classifyHttpError(status: number, headers: Headers): NormalizedError {
  if (status === 401) {
    return { kind: "authentication", retryable: retryableFor("authentication", false), message: "" };
  }
  if (status === 429) {
    const error: NormalizedError = { kind: "rate_limit", retryable: retryableFor("rate_limit", true), message: "" };
    const retryAfter = headers.get("retry-after");
    const seconds = retryAfter === null ? undefined : Number.parseInt(retryAfter, 10);
    if (seconds !== undefined && Number.isFinite(seconds)) {
      error.retryAfterMs = seconds * 1000;
    }
    return error;
  }
  if (status === 529) {
    return { kind: "overloaded", retryable: retryableFor("overloaded", true), message: "" };
  }
  if (status >= 500) {
    return { kind: "unavailable", retryable: retryableFor("unavailable", true), message: "" };
  }
  if (status >= 400) {
    return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
  }
  return { kind: "unknown", retryable: retryableFor("unknown", false), message: "" };
}

/**
 * Classify a mid-stream SSE `error` event's `error.type` string (e.g.
 * `overloaded_error`, `rate_limit_error`) into the neutral error taxonomy.
 * This event arrives on an already-200'd connection (distinct from the
 * `classifyHttpError` non-2xx path above) — Anthropic's documented streaming
 * contract allows the server to abandon an in-progress stream with a
 * terminal `event: error` record rather than a normal `message_stop`, most
 * commonly for `overloaded_error` under load.
 */
function classifySseErrorType(errorType: string | undefined): ProviderErrorKind {
  switch (errorType) {
    case "overloaded_error":
      return "overloaded";
    case "rate_limit_error":
      return "rate_limit";
    case "authentication_error":
    case "permission_error":
      return "authentication";
    case "invalid_request_error":
    case "not_found_error":
      return "invalid_request";
    case "api_error":
      return "unavailable";
    default:
      return "unknown";
  }
}

/** Default first-byte / idle stream deadline (flow 268 T22), overridable via {@link AnthropicProviderDeps}. */
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

/** Sentinel returned by {@link raceReadAgainstDeadline} when the deadline elapses first. */
const READ_TIMED_OUT = Symbol("anthropic-read-timed-out");

/** The resolved type of `reader.read()`, derived rather than named (lib.dom's exact type differs across TS/bun-types versions). */
type ReadChunkResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

/**
 * Race one `reader.read()` against a deadline timer. Resolves to the read
 * result, or the timeout sentinel when `ms` elapses first. The timer is
 * ALWAYS cleared before returning — on a successful read, a timeout, or a
 * rejected read (abort/torn socket) — so no timer outlives this call.
 */
async function raceReadAgainstDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadChunkResult | typeof READ_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof READ_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMED_OUT), ms);
  });
  try {
    return await Promise.race([reader.read(), deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Drain a FIFO queue of pending event bodies, yielding each as a stamped
 * `NormalizedEvent` and checking cancellation BEFORE every yield (AC1: an
 * aborted attempt ends with exactly one trailing `cancelled` error and no
 * further output). Returns `true` when the caller observed the signal
 * aborted (queue may be left partially drained) — the caller yields the
 * terminal `cancelled` error itself, since only it holds `errorEvent`.
 */
async function* drainAndCheckAbort(
  queue: EventBody[],
  signal: AbortSignal | undefined,
  stamp: (body: EventBody) => NormalizedEvent,
): AsyncGenerator<NormalizedEvent, boolean> {
  while (queue.length > 0) {
    if (signal?.aborted === true) {
      return true;
    }
    const body = queue.shift();
    if (body === undefined) {
      break;
    }
    yield stamp(body);
  }
  return signal?.aborted === true;
}

/**
 * Thin Anthropic Messages-API {@link ProviderPort}. Constructed with an injected
 * `fetch` and an optional explicit capability `grant`; `stream()` performs one
 * guarded, credential-redacted, storage-off attempt and normalizes its SSE into
 * the documented `NormalizedEvent` sequence.
 */
export class AnthropicProvider implements ProviderPort {
  private readonly deps: AnthropicProviderDeps;

  constructor(deps: AnthropicProviderDeps) {
    this.deps = deps;
  }

  describe(): ProviderDescription {
    const capabilities: ProviderCapabilities = {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: false,
      reasoningMetadata: true,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    };
    return {
      capabilities,
      descriptor: { providerId: "anthropic", providerRevision: PROVIDER_REVISION },
    };
  }

  descriptorDocument(): AnthropicProviderDescriptorDocument {
    return {
      schemaVersion: 1,
      providerId: "anthropic",
      providerRevision: PROVIDER_REVISION,
      models: [{ modelId: DEFAULT_MODEL.modelId, revision: DEFAULT_MODEL.revision }],
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        cancellation: true,
        structuredOutput: false,
      },
      remoteState: { storage: false, retention: false, continuation: false },
    };
  }

  async *stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const stamp = (body: EventBody): NormalizedEvent => ({ ...body, sequence: sequence++, attemptId: opts.attemptId });
    const errorEvent = (error: NormalizedError): NormalizedEvent => stamp({ kind: "provider_error", error });

    const grant = this.deps.grant;

    // Credential redaction: scrub the apiKey out of any string that leaves the
    // module. `grant` may be absent (no credential to scrub).
    const redact = (message: string): string =>
      grant !== undefined && grant.apiKey.length > 0 ? message.split(grant.apiKey).join("[redacted]") : message;

    // AC3 capability gate: no valid grant -> fail-closed, `fetch` NEVER invoked.
    if (grant === undefined || grant.network !== true || typeof grant.apiKey !== "string" || grant.apiKey.length === 0) {
      yield errorEvent({
        kind: "authentication",
        retryable: retryableFor("authentication", false),
        message: "network capability grant with an apiKey is required to reach the Anthropic API",
      });
      return;
    }

    const baseUrl = grant.baseUrl ?? DEFAULT_BASE_URL;

    // AC3 guarded egress: private/loopback/link-local/metadata hosts fail closed,
    // BEFORE any fetch, reusing the W15 SSRF predicate.
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      host = baseUrl;
    }
    if (isPrivateEgressHost(host)) {
      yield errorEvent({
        kind: "invalid_request",
        retryable: retryableFor("invalid_request", false),
        message: redact(`egress to a private/loopback/link-local/metadata host is denied: ${host}`),
      });
      return;
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    const headers: Record<string, string> = {
      "x-api-key": grant.apiKey,
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    // Reasoning request (flow 268 T13): `request.options?.reasoning` is the
    // effort a caller asked for ("off"/absent = not asked). Sampling params
    // (temperature/top_p/top_k) are rejected alongside `thinking` on the
    // newer models — this adapter never sends them at all, so no gating is
    // needed here.
    const thinkingParams = buildThinkingParams(
      request.modelId,
      request.options?.reasoning,
      request.budget.maxOutputTokens,
    );
    const payload: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: thinkingParams.maxTokens,
      system: request.systemInstruction,
      messages: toAnthropicMessages(request.messages),
      stream: true,
      ...(thinkingParams.thinking !== undefined ? { thinking: thinkingParams.thinking } : {}),
      ...(thinkingParams.outputConfig !== undefined ? { output_config: thinkingParams.outputConfig } : {}),
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
    };
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };

    let response: Response;
    try {
      response = await this.deps.fetch(url, init);
    } catch (cause) {
      if (opts.signal?.aborted === true) {
        yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
        return;
      }
      yield errorEvent({
        kind: "unavailable",
        retryable: retryableFor("unavailable", true),
        message: redact(`network request to the Anthropic API failed: ${String(cause)}`),
      });
      return;
    }

    // AC4 provider negatives: non-2xx -> typed, fail-closed error, no model_end.
    if (!response.ok) {
      const error = classifyHttpError(response.status, response.headers);
      let providerMessage = `Anthropic API returned HTTP ${response.status}`;
      try {
        const parsed = asRecord(JSON.parse(await response.text()));
        const detail = asString(asRecord(parsed.error).message);
        if (detail !== undefined && detail.length > 0) {
          providerMessage = detail;
        }
        const requestId = asString(parsed.request_id);
        if (requestId !== undefined) {
          error.providerRequestId = requestId;
        }
      } catch {
        // Non-JSON error body: keep the generic status message.
      }
      error.message = redact(providerMessage);
      yield stamp({ kind: "provider_error", error });
      return;
    }

    // Streaming body read (flow 268 T22): the SSE body is read INCREMENTALLY
    // via `response.body.getReader()`, not buffered whole with
    // `response.text()` — each record the parser completes is normalized and
    // yielded immediately, so a caller observes `text_delta`/`tool_call_delta`
    // while the model is still generating rather than only once the
    // connection closes. Two independent deadlines guard a stalled
    // connection: `firstByteTimeoutMs` (no byte at all since the response
    // headers arrived) and `idleTimeoutMs` (no further chunk since the last
    // one) — both default to 120s, configurable via `deps`. A timeout cancels
    // the reader and yields exactly one retryable `unavailable`
    // provider_error, never a model_end. An abort mid-read still fails closed
    // to the SAME terminal `cancelled` error the fetch()-level abort path
    // yields (flow-019 contract, mirrored from H-01 T5's `response.text()`
    // guard).
    if (response.body === null) {
      yield errorEvent({
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("empty response body"),
      });
      return;
    }

    const firstByteTimeoutMs = this.deps.firstByteTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const idleTimeoutMs = this.deps.idleTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new AnthropicSSEParser();
    const cancelReader = (): void => {
      // Best-effort cleanup: the socket may already be closed/errored, and a
      // cancel() rejection here is never a second failure mode.
      reader.cancel().catch(() => undefined);
    };

    const bodies: EventBody[] = [];
    const blocks = new Map<number, BlockState>();
    let inputTokens: number | undefined;
    let sawStart = false;
    let sawStop = false;
    let receivedAnyChunk = false;
    let malformed: NormalizedError | undefined;
    let terminalError: NormalizedError | undefined;

    readLoop: while (true) {
      const timeoutMs = receivedAnyChunk ? idleTimeoutMs : firstByteTimeoutMs;
      let readResult: ReadChunkResult | typeof READ_TIMED_OUT;
      try {
        readResult = await raceReadAgainstDeadline(reader, timeoutMs);
      } catch (cause) {
        cancelReader();
        const aborted =
          opts.signal?.aborted === true ||
          (typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "AbortError");
        if (aborted) {
          yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
          return;
        }
        yield errorEvent({
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact(`Anthropic SSE body read failed: ${String(cause)}`),
        });
        return;
      }

      if (readResult === READ_TIMED_OUT) {
        cancelReader();
        yield errorEvent({
          kind: "unavailable",
          retryable: retryableFor("unavailable", true),
          message: `Anthropic stream timed out waiting for ${
            receivedAnyChunk ? "the next chunk" : "the first byte"
          } (limit ${timeoutMs}ms)`,
        });
        return;
      }

      const { done, value } = readResult;
      if (done) {
        break readLoop;
      }
      if (value.length > 0) {
        // Only a non-empty chunk counts as "the first byte arrived": an
        // empty, non-final read (degenerate but spec-legal) must not silently
        // satisfy the first-byte deadline or flip the zero-byte-body check
        // below.
        receivedAnyChunk = true;
      }

      const chunkText = decoder.decode(value, { stream: true });
      for (const record of parser.push(chunkText)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(record.data);
        } catch {
          malformed = {
            kind: "malformed",
            retryable: retryableFor("malformed", false),
            message: redact("Anthropic SSE data line was not valid JSON"),
          };
          break;
        }
        const data = asRecord(parsed);
        switch (asString(data.type)) {
          case "message_start": {
            sawStart = true;
            inputTokens = asNumber(asRecord(asRecord(data.message).usage).input_tokens);
            bodies.push({ kind: "model_start" });
            break;
          }
          case "content_block_start": {
            const index = asNumber(data.index) ?? -1;
            const block = asRecord(data.content_block);
            const blockType = asString(block.type);
            if (blockType === "tool_use") {
              const state: BlockState = { type: "tool", input: "" };
              const toolCallId = asString(block.id);
              if (toolCallId !== undefined) {
                state.toolCallId = toolCallId;
              }
              blocks.set(index, state);
              const startBody: EventBody = { kind: "tool_call_start" };
              if (toolCallId !== undefined) {
                startBody.toolCallId = toolCallId;
              }
              const toolName = asString(block.name);
              if (toolName !== undefined) {
                startBody.toolName = toolName;
              }
              bodies.push(startBody);
            } else if (blockType === "thinking") {
              blocks.set(index, { type: "thinking", input: "", signature: "" });
            } else if (blockType === "redacted_thinking") {
              // No deltas ever follow a `redacted_thinking` block — the opaque
              // `data` arrives whole here. The visible-text side (`reasoning_delta`
              // with `redacted: true`, no text) is emitted right away; the
              // `reasoning_replay` carrying `data` follows at `content_block_stop`,
              // mirroring the `thinking` block's start-then-stop shape.
              blocks.set(index, { type: "redacted_thinking", input: "", redactedData: asString(block.data) ?? "" });
              bodies.push({ kind: "reasoning_delta", redacted: true });
            } else {
              blocks.set(index, { type: "text", input: "" });
            }
            break;
          }
          case "content_block_delta": {
            const index = asNumber(data.index) ?? -1;
            const delta = asRecord(data.delta);
            const deltaType = asString(delta.type);
            if (deltaType === "text_delta") {
              const body: EventBody = { kind: "text_delta" };
              const text = asString(delta.text);
              if (text !== undefined) {
                body.text = text;
              }
              bodies.push(body);
            } else if (deltaType === "input_json_delta") {
              const fragment = asString(delta.partial_json) ?? "";
              const block = blocks.get(index);
              if (block !== undefined) {
                block.input += fragment;
              }
              const body: EventBody = { kind: "tool_call_delta", inputDelta: fragment };
              if (block?.toolCallId !== undefined) {
                body.toolCallId = block.toolCallId;
              }
              bodies.push(body);
            } else if (deltaType === "thinking_delta") {
              const block = blocks.get(index);
              const text = asString(delta.thinking);
              if (text !== undefined) {
                if (block !== undefined && block.type === "thinking") {
                  block.input += text;
                }
                if (text.length > 0) {
                  bodies.push({ kind: "reasoning_delta", text });
                }
              }
            } else if (deltaType === "signature_delta") {
              // Bookkeeping only — accumulated for the `reasoning_replay` this
              // block emits at `content_block_stop`; no visible-text event.
              const block = blocks.get(index);
              const signature = asString(delta.signature);
              if (block !== undefined && block.type === "thinking" && signature !== undefined) {
                block.signature = (block.signature ?? "") + signature;
              }
            }
            break;
          }
          case "content_block_stop": {
            const index = asNumber(data.index) ?? -1;
            const block = blocks.get(index);
            if (block !== undefined && block.type === "tool") {
              const endBody: EventBody = { kind: "tool_call_end", input: block.input };
              if (block.toolCallId !== undefined) {
                endBody.toolCallId = block.toolCallId;
              }
              bodies.push(endBody);
            } else if (block !== undefined && block.type === "thinking") {
              bodies.push({
                kind: "reasoning_replay",
                replay: {
                  providerId: PROVIDER_ID,
                  kind: "thinking",
                  data: { type: "thinking", thinking: block.input, signature: block.signature ?? "" },
                },
              });
            } else if (block !== undefined && block.type === "redacted_thinking") {
              bodies.push({
                kind: "reasoning_replay",
                replay: {
                  providerId: PROVIDER_ID,
                  kind: "redacted_thinking",
                  data: { type: "redacted_thinking", data: block.redactedData ?? "" },
                },
              });
            }
            break;
          }
          case "message_delta": {
            const outputTokens = asNumber(asRecord(data.usage).output_tokens);
            bodies.push({ kind: "usage_update", usage: mergeUsage(inputTokens, outputTokens) });
            break;
          }
          case "message_stop": {
            sawStop = true;
            bodies.push({ kind: "model_end" });
            break;
          }
          case "error": {
            // A terminal SSE `error` event (e.g. `overloaded_error` under
            // load) — Anthropic's documented streaming contract allows the
            // server to abandon an in-progress stream this way instead of a
            // normal `message_stop`. Ends the attempt the same way a
            // malformed record does: stop reading, drain what is already
            // queued, then yield this as the terminal event (no model_end).
            const errorObj = asRecord(data.error);
            const kind = classifySseErrorType(asString(errorObj.type));
            const message = asString(errorObj.message);
            terminalError = {
              kind,
              retryable: retryableFor(kind, false),
              message: redact(message !== undefined && message.length > 0 ? message : "Anthropic API returned a stream error with no message"),
            };
            break;
          }
          default:
            // `ping`, `content_block_start` for non-tool blocks handled above, and
            // any unknown event carry no neutral mapping.
            break;
        }
        if (terminalError !== undefined) {
          break;
        }
      }

      // A terminal event (`message_stop`, `error`) or a malformed record ends
      // the attempt right here (AC1): stop reading immediately rather than
      // waiting for the socket to close — a permissive endpoint may keep it
      // open past its own terminal event.
      if (malformed !== undefined || terminalError !== undefined || sawStop) {
        cancelReader();
        const aborted = yield* drainAndCheckAbort(bodies, opts.signal, stamp);
        if (aborted) {
          yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
          return;
        }
        if (terminalError !== undefined) {
          yield stamp({ kind: "provider_error", error: terminalError });
          return;
        }
        if (malformed !== undefined) {
          yield stamp({ kind: "provider_error", error: malformed });
        }
        return;
      }

      // Drain whatever this chunk produced before reading the next one, so a
      // caller observes each event as soon as it is parsed (AC1) rather than
      // only once the whole body has arrived.
      const aborted = yield* drainAndCheckAbort(bodies, opts.signal, stamp);
      if (aborted) {
        cancelReader();
        yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
        return;
      }
    }

    // Reached only via a natural EOF (reader signalled `done`) — a terminal
    // event or a malformed record always returns from inside the loop above.
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      parser.push(trailing);
    }
    const torn = parser.flush();
    // Torn trailing record or a stream that started but never reached
    // `message_stop` is a truncated/malformed attempt (AC4): no model_end.
    if (torn.length > 0) {
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("Anthropic SSE stream ended mid-record (torn stream)"),
      };
    } else if (!receivedAnyChunk) {
      // A 200 with literally zero bytes never sets `sawStart` and would
      // otherwise yield nothing — fail closed with a terminal `malformed`
      // rather than a silent-success empty iterable.
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("empty response body"),
      };
    } else if (sawStart && !sawStop) {
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("Anthropic SSE stream ended before message_stop (truncated stream)"),
      };
    }

    // Emit, checking cancellation before every event so an aborted attempt ends
    // with exactly one trailing `cancelled` error and no further output (AC1).
    const aborted = yield* drainAndCheckAbort(bodies, opts.signal, stamp);
    if (aborted) {
      yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
      return;
    }
    if (malformed !== undefined) {
      yield stamp({ kind: "provider_error", error: malformed });
    }
  }
}
