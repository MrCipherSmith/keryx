// Google Gemini provider adapter (flow 183, T7 / AC2, AC5, AC6).
//
// A THIN `fetch` + SSE adapter over Google's **legacy** `generateContent`/
// `streamGenerateContent` REST API (`POST /v1beta/models/{model}:
// streamGenerateContent?alt=sse`), built to `AnthropicProvider`'s exact
// template — NO vendor SDK, NO new dependency — only the injected `fetch`,
// the neutral W5 port types, the reused `AnthropicSSEParser` (confirmed
// below to fit Gemini's framing as-is), and the reused SSRF/egress guard
// (`isPrivateEgressHost`) cross this module's boundary.
//
// WHY LEGACY generateContent, NOT the newer Interactions API: a real,
// recorded architectural decision (plan.md's "Vendor wire-shape decisions" /
// description.md), not a gap. Interactions is Google's forward-looking pick
// but is session/continuation-shaped (`previous_interaction_id`) — a
// structural mismatch with keryx's stateless, flat
// `NormalizedRequest.messages[]`. `generateContent` is labelled "legacy" in
// Google's docs but explicitly remains fully supported with no announced
// EOL, and its flat `contents[]` array is the actual structural fit.
//
// GEMINI'S REAL STRUCTURAL DIFFERENCE FROM EVERY OTHER ADAPTER HERE: there is
// no `system` role and no separate tool/function role. The system prompt is a
// top-level `systemInstruction` field; a tool RESULT is sent back as a
// `role:"user"` message carrying a `functionResponse` part (never a
// `role:"tool"`/`role:"function"` message the way Anthropic/OpenAI-compat
// model it).
//
// SSE FRAMING (researched, not assumed — see the "SSE framing" note below):
// `streamGenerateContent?alt=sse` returns a standard `text/event-stream`
// where each `data: <json>` line (terminated by a blank line) IS one
// complete `GenerateContentResponse` JSON object — no `event:` line, no
// partial/fragmented JSON split across multiple `data:` lines. This is
// exactly what `AnthropicSSEParser` already parses (a generic `data:`-line
// framer that tolerates an absent `event:` field) — reused HERE UNCHANGED,
// no adaptation needed.
//
// TOOL-CALL ARGUMENT GRANULARITY (researched, refines plan.md's flagged
// uncertainty): by default, `functionCall.args` on `generateContent`/
// `streamGenerateContent` arrives WHOLE in a single chunk — NOT streamed as
// incremental partial-JSON fragments the way OpenAI/the compat engine do.
// Incremental function-call-argument streaming (`toolConfig.
// functionCallingConfig.streamFunctionCallArguments` -> `partialArgs`/
// `willContinue`) is a distinct, newer, model-gated opt-in feature (research
// found it associated with Gemini 3+ and the Interactions API) that this
// adapter does NOT enable and does NOT wire — so every `functionCall` part
// here maps to `tool_call_start` immediately followed by `tool_call_end`
// with the complete `args` as JSON, no `tool_call_delta` in between.
//
// REASONING METADATA (researched, refines plan.md's "default false unless
// confirmed" caveat — CONFIRMED here, not guessed): the `generateContent`
// REST reference documents `generationConfig.thinkingConfig.{thinkingBudget,
// includeThoughts}`, and a thought-summary content part carries a boolean
// `thought: true` field alongside `text`. This adapter claims
// `reasoningMetadata: true` on that confirmed basis and maps a `thought:
// true` text part to `reasoning_delta` (never `text_delta`).
//
// Determinism / offline: `fetch` is always injected via `deps.fetch` (the
// global is never touched); no `Date.now`/`Math.random`. Every yielded
// event/error is scrubbed of the credential before it leaves this module,
// and nothing is ever persisted (storage-off).
//
// THINKING CONFIG + THOUGHT SIGNATURES (flow 268, T15 / AC10): live-doc
// verification via WebFetch against ai.google.dev/gemini-api/docs/thinking
// and .../thought-signatures during this task was inconclusive — one fetch
// redirected to the thinking guide with no signature detail, another
// returned a `thinking_level`/`thinking_summaries`/"steps[]" shape that
// looks like the newer, STATEFUL Interactions-style API this adapter
// deliberately does NOT use (see "WHY LEGACY generateContent" above), not
// the flat `generationConfig.thinkingConfig` + `candidates[].content.
// parts[]` shape this legacy `generateContent` endpoint already uses
// (confirmed elsewhere in this file). This adapter therefore implements
// against the task-provided protocol facts, which match this file's own
// prior confirmed research (the REASONING METADATA note above) rather than
// the ambiguous fetch results:
//   - When `request.options.reasoning` requests an effort ("low"/"medium"/
//     "high"; absent/"off" = not requested), `generationConfig.
//     thinkingConfig.includeThoughts` is set true, plus a depth field
//     chosen per model family: `gemini-3*` models get `thinkingLevel`
//     ("low"/"high" only — no confirmed "medium" level, so effort "medium"
//     maps to "high"); every other model id (the `gemini-2.5*` family and
//     the generic fallback) gets `thinkingBudget` in tokens (low=1024,
//     medium=8192, high=24576).
//   - A `thoughtSignature` on ANY response part is captured into a
//     `reasoning_replay` event REGARDLESS of whether effort was requested
//     (Google documents it arriving even with `includeThoughts` unset) and
//     is replayed verbatim on the SAME part shape (including a
//     `functionCall` part) on the next request — see
//     `GeminiThoughtSignatureReplayData` and `toGeminiContents` below.

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
  ProviderReplayItem,
  StreamOptions,
} from "../types";
import { AnthropicSSEParser } from "../anthropic/sse";

/** Explicit capability grant authorizing this adapter to reach the network. */
export interface GeminiCapabilityGrant {
  readonly network: true;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export interface GeminiProviderDeps {
  readonly fetch: typeof fetch;
  readonly grant?: GeminiCapabilityGrant;
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

/** One model advertised by {@link GeminiProvider.descriptorDocument}. */
export interface GeminiModelDescriptor {
  modelId: string;
  revision: string;
}

/**
 * The durable, schema-validating descriptor document for the Gemini provider.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export interface GeminiProviderDescriptorDocument {
  schemaVersion: number;
  providerId: string;
  providerRevision: string;
  models: GeminiModelDescriptor[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelToolCalls: boolean;
    cancellation: boolean;
    structuredOutput?: boolean;
  };
  remoteState: { storage: false; retention: false; continuation: false };
}

/** Public Gemini API base URL used when the grant supplies none. */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
/** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
const PROVIDER_REVISION = "gemini-2026-08-20";
/** The single model this adapter fixture pins. */
const DEFAULT_MODEL: GeminiModelDescriptor = {
  modelId: "gemini-2.5-flash",
  revision: "2.5",
};

/** A normalized event without its per-attempt bookkeeping fields. */
type EventBody = Omit<NormalizedEvent, "sequence" | "attemptId">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * The `data` shape this adapter puts on a `reasoning_replay` event's
 * {@link ProviderReplayItem} (`kind: "thought_signature"`). `target`
 * identifies which kind of response part the signature arrived on so replay
 * can reattach it deterministically: `"functionCall"` items also carry
 * `functionCallIndex` (this round's 0-based position among ALL `functionCall`
 * parts, matching the position `message.toolCalls` ends up in) and, when the
 * chunk carried one, `toolCallId` (the normalized call id) — replay prefers
 * `toolCallId` and falls back to `functionCallIndex` only when it is absent.
 * `"text"` items carry neither.
 */
export interface GeminiThoughtSignatureReplayData {
  target: "functionCall" | "text";
  functionCallIndex?: number;
  toolCallId?: string;
  signature: string;
}

function isGeminiThoughtSignatureReplayData(value: unknown): value is GeminiThoughtSignatureReplayData {
  if (!isPlainObject(value)) {
    return false;
  }
  const target = value.target;
  const signature = value.signature;
  return (target === "functionCall" || target === "text") && typeof signature === "string" && signature.length > 0;
}

/**
 * This provider's own `thought_signature` replay items on an assistant
 * message, in event order. A foreign `providerId` (a replay item some other
 * adapter owns) and any `kind` other than `"thought_signature"` are ignored,
 * matching {@link ProviderReplayItem}'s "an adapter for a different provider
 * must ignore an item it does not own" contract.
 */
function geminiThoughtSignatureItems(message: NormalizedMessage): GeminiThoughtSignatureReplayData[] {
  const replay = message.reasoning?.replay;
  if (replay === undefined) {
    return [];
  }
  const out: GeminiThoughtSignatureReplayData[] = [];
  for (const item of replay) {
    if (item.providerId !== "gemini" || item.kind !== "thought_signature") {
      continue;
    }
    if (isGeminiThoughtSignatureReplayData(item.data)) {
      out.push(item.data);
    }
  }
  return out;
}

/** Token budgets for `thinkingBudget` (Gemini 2.5-family models), per effort. */
const THINKING_BUDGET_BY_EFFORT: Record<string, number> = { low: 1024, medium: 8192, high: 24576 };

/**
 * Gemini only confirms low/medium/high (flow 268 T16): "minimal" (below its
 * lowest confirmed level), "xhigh" and "max" (above its highest) are clamped
 * to the nearest one it supports rather than sent as an unconfirmed string.
 * Applied BEFORE either depth-control mapping below, so both the
 * `thinkingLevel` (gemini-3*) and `thinkingBudget` (gemini-2.5* / generic)
 * branches see only low/medium/high.
 */
const GEMINI_EFFORT_CLAMP: Readonly<Record<string, "low" | "medium" | "high">> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Clamp an arbitrary requested effort string to Gemini's own low/medium/high vocabulary. */
function clampGeminiEffort(effort: string): "low" | "medium" | "high" {
  return GEMINI_EFFORT_CLAMP[effort] ?? "medium";
}

/**
 * `gemini-3*` model ids use the newer `thinkingLevel` depth control;
 * everything else (the `gemini-2.5*` family, and the generic fallback for an
 * unrecognized id) uses the older token-budget `thinkingBudget` control. See
 * the module header's THINKING CONFIG note for the research caveat.
 */
function usesThinkingLevel(modelId: string): boolean {
  return /^gemini-3(\.|-|$)/i.test(modelId);
}

/**
 * Build `generationConfig.thinkingConfig` for a requested reasoning effort,
 * or `undefined` when no effort was requested (`request.options.reasoning`
 * absent or `"off"`) — `generationConfig` then carries no `thinkingConfig`
 * key at all, unchanged from before this task. Thought-summary text
 * (`includeThoughts`) is always requested alongside the depth control so a
 * requested effort always surfaces its chain-of-thought as `reasoning_delta`.
 */
function buildThinkingConfig(modelId: string, effort: string | undefined): Record<string, unknown> | undefined {
  if (effort === undefined || effort === "off") {
    return undefined;
  }
  const clampedEffort = clampGeminiEffort(effort);
  if (usesThinkingLevel(modelId)) {
    // Only "low"/"high" are confirmed for `thinkingLevel` — "medium" (and any
    // unrecognized value) maps to "high" rather than sending an unconfirmed
    // "medium" the API might reject.
    const level = clampedEffort === "low" ? "low" : "high";
    return { includeThoughts: true, thinkingLevel: level };
  }
  const budget = THINKING_BUDGET_BY_EFFORT[clampedEffort] ?? THINKING_BUDGET_BY_EFFORT.medium;
  return { includeThoughts: true, thinkingBudget: budget };
}

/**
 * Serialize a normalized conversation into Gemini `contents[]` wire form.
 *
 * Gemini has NO `system` role (the system instruction is a separate
 * top-level field, handled by the caller) and NO tool/function role: a tool
 * RESULT is a `role:"user"` message carrying a `functionResponse` part, and
 * an assistant tool call is a `functionCall` part on a `role:"model"` turn.
 * Only pairs that hold together inside THIS request become structured parts
 * (`linkToolCalls`); a half-pair degrades to plain text, matching the
 * Anthropic/compat-engine precedent for a compacted or resumed window.
 */
function toGeminiContents(messages: readonly NormalizedMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const linked of linkToolCalls(messages)) {
    const message = linked.message;
    if (message.role === "system") {
      // systemInstruction is carried as a separate top-level field; a system
      // message never becomes a contents[] entry.
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0 && linked.linkedCalls.length === 0) {
      // A tool-call turn whose calls could not be linked carries no text and
      // no calls — nothing to serialize (mirrors AnthropicProvider).
      continue;
    }
    if (message.role === "tool" && linked.linkedToolCallId !== undefined) {
      const call = linked.message.toolCallId;
      out.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: findToolName(messages, linked.linkedToolCallId) ?? "",
              id: call,
              response: parseFunctionResponse(message.content),
            },
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant" && linked.linkedCalls.length > 0) {
      const parts: Record<string, unknown>[] = [];
      let textPartIndex: number | undefined;
      if (message.content.length > 0) {
        textPartIndex = parts.length;
        parts.push({ text: message.content });
      }
      // Keyed by call id (not array index) so a `toolCallId`-addressed
      // signature attaches to the right part even when `linkToolCalls`
      // dropped an earlier, unanswered call from this subset.
      const functionCallPartByCallId = new Map<string, Record<string, unknown>>();
      for (const call of linked.linkedCalls) {
        const functionCallPart: Record<string, unknown> = {
          functionCall: { name: call.name, id: call.id, args: parseToolInput(call.arguments) },
        };
        functionCallPartByCallId.set(call.id, functionCallPart);
        parts.push(functionCallPart);
      }

      // flow 268 T15 (AC10): reattach this round's captured thoughtSignature
      // items verbatim, on the same part shape they arrived on.
      for (const item of geminiThoughtSignatureItems(message)) {
        if (item.target === "functionCall") {
          const resolvedCallId =
            item.toolCallId ?? (item.functionCallIndex !== undefined ? message.toolCalls?.[item.functionCallIndex]?.id : undefined);
          const functionCallPart = resolvedCallId === undefined ? undefined : functionCallPartByCallId.get(resolvedCallId);
          if (functionCallPart !== undefined) {
            (functionCallPart.functionCall as Record<string, unknown>).thoughtSignature = item.signature;
          }
          // Unresolvable (the call it belonged to was dropped as a half-pair
          // by `linkToolCalls`) — there is no surviving part to carry it on
          // this request, so it is silently omitted rather than invented.
          continue;
        }
        if (textPartIndex !== undefined) {
          (parts[textPartIndex] as Record<string, unknown>).thoughtSignature = item.signature;
        } else {
          // Google documents a `thoughtSignature` occasionally arriving on a
          // final, otherwise-empty text part (no visible text this round).
          // Reproduce exactly that shape rather than dropping the signature
          // or inventing a non-empty text part for it to ride on.
          textPartIndex = parts.length;
          parts.push({ text: "", thoughtSignature: item.signature });
        }
      }

      out.push({ role: "model", parts });
      continue;
    }
    const part: Record<string, unknown> = { text: message.content };
    if (message.role === "assistant") {
      // This message shape has no `functionCall` part to carry a
      // `"functionCall"`-target signature on — only a `"text"`-target item
      // (the only kind that fits here) is attached; a stray `"functionCall"`
      // item (should not occur without `linkedCalls`) is dropped.
      for (const item of geminiThoughtSignatureItems(message)) {
        if (item.target === "text") {
          part.thoughtSignature = item.signature;
        }
      }
    }
    out.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [part],
    });
  }
  return out;
}

/** Locate the name of the assistant call a linked tool result answers, by id. */
function findToolName(messages: readonly NormalizedMessage[], toolCallId: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.toolCalls)) {
      continue;
    }
    const match = message.toolCalls.find((call) => call.id === toolCallId);
    if (match !== undefined) {
      return match.name;
    }
  }
  return undefined;
}

/**
 * A `functionResponse.response` is expected to be an OBJECT. Tool result
 * content is plain text; wrap it defensively — parse if it happens to be
 * JSON, otherwise carry it under a neutral `result` key so the wire payload
 * is always a well-formed object.
 */
function parseFunctionResponse(rawContent: string): Record<string, unknown> {
  if (rawContent.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawContent);
    return isPlainObject(parsed) ? parsed : { result: parsed };
  } catch {
    return { result: rawContent };
  }
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

/**
 * Merge Gemini's `usageMetadata` counters into a single exact
 * {@link NormalizedUsage}. `cachedContentTokenCount`/`thoughtsTokenCount`
 * have no neutral field and are folded into `unknownExtensions` by the
 * caller under namespaced `gemini.*` keys — this helper only builds the
 * mapped subset.
 */
function mergeUsage(
  promptTokens: number | undefined,
  candidatesTokens: number | undefined,
  totalTokens: number | undefined,
): NormalizedUsage {
  const usage: NormalizedUsage = { exact: true };
  if (promptTokens !== undefined) {
    usage.inputTokens = promptTokens;
  }
  if (candidatesTokens !== undefined) {
    usage.outputTokens = candidatesTokens;
  }
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  } else if (promptTokens !== undefined || candidatesTokens !== undefined) {
    usage.totalTokens = (promptTokens ?? 0) + (candidatesTokens ?? 0);
  }
  return usage;
}

/**
 * Classify a non-2xx HTTP response into the neutral error taxonomy, per
 * Google's error envelope `{"error":{"code":<http-status-like number>,
 * "message":string,"status":<RPC enum string>}}` — NOTE the naming is
 * opposite of what one might expect: `code` is the numeric HTTP-status-like
 * field, `status` is the string enum. Mirrors `classifyHttpError` in
 * `anthropic-provider.ts` / the compat engine, adapted to Gemini's confirmed
 * `status` enum values (research: no confirmed `Retry-After`/`RetryInfo`
 * field on 429s — no backoff hint is invented here).
 */
function classifyGeminiError(httpStatus: number, rpcStatus: string | undefined): NormalizedError {
  if (rpcStatus === "UNAUTHENTICATED" || httpStatus === 401 || httpStatus === 403) {
    return { kind: "authentication", retryable: retryableFor("authentication", false), message: "" };
  }
  if (rpcStatus === "RESOURCE_EXHAUSTED" || httpStatus === 429) {
    // Research found NO confirmed Retry-After/RetryInfo field on this API's
    // 429s — classify without a backoff hint rather than inventing one.
    return { kind: "rate_limit", retryable: retryableFor("rate_limit", true), message: "" };
  }
  if (rpcStatus === "UNAVAILABLE" || httpStatus >= 500) {
    return { kind: "unavailable", retryable: retryableFor("unavailable", true), message: "" };
  }
  if (rpcStatus === "INVALID_ARGUMENT" || httpStatus === 400) {
    // Research did not confirm a context-overflow-specific status/code
    // distinct from plain INVALID_ARGUMENT on this API — invalid_request is
    // the documented, honest fallback rather than a guessed context_overflow
    // detection.
    return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
  }
  if (httpStatus >= 400) {
    return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
  }
  return { kind: "unknown", retryable: retryableFor("unknown", false), message: "" };
}

/** Default first-byte / idle stream deadline (flow 268 T22), overridable via {@link GeminiProviderDeps}. */
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

/** Sentinel returned by {@link raceReadAgainstDeadline} when the deadline elapses first. */
const READ_TIMED_OUT = Symbol("gemini-read-timed-out");

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
 * Thin Gemini `generateContent`/`streamGenerateContent` {@link ProviderPort}.
 * Constructed with an injected `fetch` and an optional explicit capability
 * `grant`; `stream()` performs one guarded, credential-redacted, storage-off
 * attempt and normalizes its SSE into the documented `NormalizedEvent`
 * sequence.
 */
export class GeminiProvider implements ProviderPort {
  private readonly deps: GeminiProviderDeps;

  constructor(deps: GeminiProviderDeps) {
    this.deps = deps;
  }

  describe(): ProviderDescription {
    const capabilities: ProviderCapabilities = {
      streaming: true,
      toolCalls: true,
      // Confirmed by research: Gemini can return multiple functionCall parts
      // in one model turn.
      parallelToolCalls: true,
      // responseSchema + responseMimeType:"application/json" in
      // generationConfig — documented, not this adapter's own invention.
      structuredOutput: true,
      // CONFIRMED (not guessed) via research on the generateContent REST
      // reference: generationConfig.thinkingConfig.{thinkingBudget,
      // includeThoughts} + a `thought: true` content-part field.
      reasoningMetadata: true,
      // Implicit/automatic for Gemini 2.5+, observed via
      // cachedContentTokenCount — NOT the separate explicit CachedContent
      // resource path (that needs its own lifecycle this stateless adapter
      // does not manage).
      promptCaching: true,
      // inlineData/fileData parts — base64 image support is well-documented.
      vision: true,
      // The dedicated {model}:countTokens endpoint exists but is NOT wired by
      // this adapter (out of scope for this task) — false until wired.
      tokenCounting: false,
      modelListing: false,
    };
    return {
      capabilities,
      descriptor: { providerId: "gemini", providerRevision: PROVIDER_REVISION },
    };
  }

  descriptorDocument(): GeminiProviderDescriptorDocument {
    return {
      schemaVersion: 1,
      providerId: "gemini",
      providerRevision: PROVIDER_REVISION,
      models: [{ modelId: DEFAULT_MODEL.modelId, revision: DEFAULT_MODEL.revision }],
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        cancellation: true,
        structuredOutput: true,
      },
      remoteState: { storage: false, retention: false, continuation: false },
    };
  }

  async *stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    let sequence = 0;
    const stamp = (body: EventBody): NormalizedEvent => ({ ...body, sequence: sequence++, attemptId: opts.attemptId });
    const errorEvent = (error: NormalizedError): NormalizedEvent => stamp({ kind: "provider_error", error });

    const grant = this.deps.grant;

    // Credential redaction: scrub the apiKey out of any string that leaves
    // the module. `grant` may be absent (no credential to scrub).
    const redact = (message: string): string =>
      grant !== undefined && grant.apiKey.length > 0 ? message.split(grant.apiKey).join("[redacted]") : message;

    // AC3-equivalent capability gate: no valid grant -> fail-closed, `fetch`
    // NEVER invoked.
    if (grant === undefined || grant.network !== true || typeof grant.apiKey !== "string" || grant.apiKey.length === 0) {
      yield errorEvent({
        kind: "authentication",
        retryable: retryableFor("authentication", false),
        message: "network capability grant with an apiKey is required to reach the Gemini API",
      });
      return;
    }

    const baseUrl = grant.baseUrl ?? DEFAULT_BASE_URL;

    // AC4 guarded egress: private/loopback/link-local/metadata hosts fail
    // closed, BEFORE any fetch, reusing the SSRF predicate.
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

    // `request.modelId` goes straight through unguarded, matching every
    // other adapter's convention (AnthropicProvider, OpenAiProvider, the
    // compat engine — none silently substitute a default for an empty
    // caller-supplied model id; a caller bug should fail loudly against the
    // vendor API rather than silently answer from a different model than
    // requested). `DEFAULT_MODEL.modelId` still backs `describe()`/
    // `descriptorDocument()` below, unaffected by this.
    const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    // x-goog-api-key header — confirmed current/preferred form over the
    // older `?key=` query param (research flagged the query-param path as
    // unconfirmed-still-working; the header is used here).
    const headers: Record<string, string> = {
      "x-goog-api-key": grant.apiKey,
      "content-type": "application/json",
    };
    const payload: Record<string, unknown> = {
      contents: toGeminiContents(request.messages),
      ...(request.systemInstruction.length > 0
        ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } }
        : {}),
      ...(request.tools !== undefined && request.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  ...(tool.description !== undefined ? { description: tool.description } : {}),
                  parameters: tool.inputSchema,
                })),
              },
            ],
          }
        : {}),
      generationConfig: {
        maxOutputTokens: request.budget.maxOutputTokens,
        ...(request.options?.temperature !== undefined ? { temperature: request.options.temperature } : {}),
        // flow 268 T15 (AC10): only present when an effort was requested —
        // `thinkingConfig` is entirely absent otherwise, unchanged from
        // before this task.
        ...(() => {
          const thinkingConfig = buildThinkingConfig(request.modelId, request.options?.reasoning);
          return thinkingConfig === undefined ? {} : { thinkingConfig };
        })(),
      },
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
        message: redact(`network request to the Gemini API failed: ${String(cause)}`),
      });
      return;
    }

    // Non-2xx -> typed, fail-closed error, no model_end.
    if (!response.ok) {
      let error: NormalizedError;
      let providerMessage = `Gemini API returned HTTP ${response.status}`;
      try {
        const parsed = asRecord(JSON.parse(await response.text()));
        const envelope = asRecord(parsed.error);
        const rpcStatus = asString(envelope.status);
        const httpCode = asNumber(envelope.code) ?? response.status;
        error = classifyGeminiError(httpCode, rpcStatus);
        const detail = asString(envelope.message);
        if (detail !== undefined && detail.length > 0) {
          providerMessage = detail;
        }
      } catch {
        // Non-JSON error body: classify by HTTP status alone.
        error = classifyGeminiError(response.status, undefined);
      }
      error.message = redact(providerMessage);
      yield stamp({ kind: "provider_error", error });
      return;
    }

    // Streaming body read (flow 268 T22): the SSE body is read INCREMENTALLY
    // via `response.body.getReader()`, not buffered whole with
    // `response.text()` — each record the parser completes is normalized and
    // yielded immediately, so a caller observes `text_delta`/`reasoning_delta`
    // while the model is still generating rather than only once the
    // connection closes. Two independent deadlines guard a stalled
    // connection: `firstByteTimeoutMs` (no byte at all since the response
    // headers arrived) and `idleTimeoutMs` (no further chunk since the last
    // one) — both default to 120s, configurable via `deps`. A timeout cancels
    // the reader and yields exactly one retryable `unavailable`
    // provider_error, never a model_end. An abort mid-read still fails closed
    // to the SAME terminal `cancelled` error the fetch()-level abort path
    // yields (mirrors AnthropicProvider/compat engine).
    //
    // TERMINAL DETECTION: unlike Anthropic's dedicated `message_stop` event
    // or the OpenAI Responses API's `response.completed`, this legacy
    // `generateContent` format has no distinct terminal-event type — the SAME
    // `GenerateContentResponse` JSON shape is used for every chunk, and
    // completion is signalled by a `finishReason` field appearing on the
    // first candidate of the LAST chunk. That IS detectable incrementally
    // (confirmed per-record, not merely "stream end"): the read loop stops as
    // soon as a record carries a non-empty `finishReason`, exactly the same
    // "stop on terminal event, don't wait for socket close" contract as the
    // other two adapters. Only if the stream closes WITHOUT ever reporting a
    // `finishReason` does this adapter fall back to relying on stream end
    // (EOF) plus the idle-timeout deadline above to detect a stalled/dropped
    // connection — that path yields a truncated-stream `malformed`, per the
    // existing truncation handling below, never a silent model_end.
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
    // Gemini's `alt=sse` framing is `data: <complete GenerateContentResponse
    // JSON>` per record, no `event:` line — exactly what AnthropicSSEParser
    // already parses (a generic `data:`-line framer tolerant of an absent
    // `event`). Reused UNCHANGED, no adaptation needed (confirmed via
    // research, see module header).
    const parser = new AnthropicSSEParser();
    const cancelReader = (): void => {
      // Best-effort cleanup: the socket may already be closed/errored, and a
      // cancel() rejection here is never a second failure mode.
      reader.cancel().catch(() => undefined);
    };

    const bodies: EventBody[] = [];
    let sawFirstChunk = false;
    let sawFinish = false;
    let receivedAnyChunk = false;
    let malformed: NormalizedError | undefined;
    let promptTokens: number | undefined;
    let candidatesTokens: number | undefined;
    let totalTokens: number | undefined;
    let cachedContentTokens: number | undefined;
    let thoughtsTokens: number | undefined;
    // flow 268 T15 (AC10): 0-based position among ALL `functionCall` parts
    // seen so far this round — matches the position each linked call ends up
    // at in `NormalizedMessage.toolCalls` (both are built by appending, in
    // the same `tool_call_end` order), so a captured `functionCallIndex`
    // resolves deterministically on replay even without a `toolCallId`.
    let functionCallIndexInRound = 0;

    const pushUsageAndFinish = (): void => {
      // usage_update precedes model_end, once, using the LAST-seen
      // usageMetadata values folded progressively across chunks (research:
      // unclear whether usageMetadata appears per-chunk or only on the final
      // chunk — folding progressively is correct either way).
      if (promptTokens !== undefined || candidatesTokens !== undefined || totalTokens !== undefined) {
        const usage = mergeUsage(promptTokens, candidatesTokens, totalTokens);
        const unknownExtensions: Record<string, unknown> = {};
        if (cachedContentTokens !== undefined) {
          unknownExtensions["gemini.cached_content_tokens"] = cachedContentTokens;
        }
        if (thoughtsTokens !== undefined) {
          unknownExtensions["gemini.thoughts_tokens"] = thoughtsTokens;
        }
        bodies.push({
          kind: "usage_update",
          usage,
          ...(Object.keys(unknownExtensions).length > 0 ? { unknownExtensions } : {}),
        });
      }
      bodies.push({ kind: "model_end" });
    };

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
          message: redact(`Gemini SSE body read failed: ${String(cause)}`),
        });
        return;
      }

      if (readResult === READ_TIMED_OUT) {
        cancelReader();
        yield errorEvent({
          kind: "unavailable",
          retryable: retryableFor("unavailable", true),
          message: `Gemini stream timed out waiting for ${
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
            message: redact("Gemini SSE data line was not valid JSON"),
          };
          break;
        }
        const chunk = asRecord(parsed);

        if (!sawFirstChunk) {
          sawFirstChunk = true;
          bodies.push({ kind: "model_start" });
        }

        const candidates = asArray(chunk.candidates);
        const firstCandidate = asRecord(candidates[0]);
        const content = asRecord(firstCandidate.content);
        const parts = asArray(content.parts);
        for (const rawPart of parts) {
          const part = asRecord(rawPart);
          const text = asString(part.text);
          const functionCall = asRecord(part.functionCall);
          const callName = asString(functionCall.name);
          const signature = asString(part.thoughtSignature);
          let signatureCallId: string | undefined;
          let signatureCallIndex: number | undefined;

          if (text !== undefined) {
            // A `thought: true` part is chain-of-thought reasoning text, never
            // ordinary output (confirmed via research, see module header).
            if (asBoolean(part.thought)) {
              bodies.push({ kind: "reasoning_delta", text });
            } else {
              bodies.push({ kind: "text_delta", text });
            }
          } else if (callName !== undefined) {
            // Gemini does NOT stream partial function-call arguments by
            // default (confirmed via research: incremental streaming is a
            // distinct, newer, model-gated opt-in this adapter does not
            // enable) — args arrive whole in this one chunk, so this maps to
            // tool_call_start immediately followed by tool_call_end, no
            // tool_call_delta in between.
            const callId = asString(functionCall.id) ?? callName;
            const argsInput = JSON.stringify(asRecord(functionCall.args));
            bodies.push({ kind: "tool_call_start", toolCallId: callId, toolName: callName });
            bodies.push({ kind: "tool_call_end", toolCallId: callId, input: argsInput });
            signatureCallId = callId;
            signatureCallIndex = functionCallIndexInRound;
            functionCallIndexInRound += 1;
          }

          // flow 268 T15 (AC10): a `thoughtSignature` on ANY part is captured
          // regardless of whether an effort/`includeThoughts` was requested —
          // Google documents it arriving unconditionally. Associated with the
          // part it arrived on in THIS loop iteration, so a split-chunk
          // signature can never drift onto the wrong part.
          if (signature !== undefined && signature.length > 0) {
            const data: GeminiThoughtSignatureReplayData =
              signatureCallIndex !== undefined
                ? {
                    target: "functionCall",
                    functionCallIndex: signatureCallIndex,
                    ...(signatureCallId !== undefined ? { toolCallId: signatureCallId } : {}),
                    signature,
                  }
                : { target: "text", signature };
            const replay: ProviderReplayItem = { providerId: "gemini", kind: "thought_signature", data };
            bodies.push({ kind: "reasoning_replay", replay });
          }
        }

        const usageMetadata = asRecord(chunk.usageMetadata);
        if (Object.keys(usageMetadata).length > 0) {
          promptTokens = asNumber(usageMetadata.promptTokenCount) ?? promptTokens;
          candidatesTokens = asNumber(usageMetadata.candidatesTokenCount) ?? candidatesTokens;
          totalTokens = asNumber(usageMetadata.totalTokenCount) ?? totalTokens;
          cachedContentTokens = asNumber(usageMetadata.cachedContentTokenCount) ?? cachedContentTokens;
          thoughtsTokens = asNumber(usageMetadata.thoughtsTokenCount) ?? thoughtsTokens;
        }

        const finishReason = asString(firstCandidate.finishReason);
        if (finishReason !== undefined && finishReason.length > 0) {
          sawFinish = true;
          pushUsageAndFinish();
        }
        if (malformed !== undefined || sawFinish) {
          break;
        }
      }

      // A terminal record (`finishReason` present) or a malformed record ends
      // the attempt right here (AC1): stop reading immediately rather than
      // waiting for the socket to close — a permissive endpoint may keep it
      // open past the last real chunk.
      if (malformed !== undefined || sawFinish) {
        cancelReader();
        const aborted = yield* drainAndCheckAbort(bodies, opts.signal, stamp);
        if (aborted) {
          yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
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

    // Reached only via a natural EOF (reader signalled `done`) — a
    // `finishReason` or a malformed record always returns from inside the
    // loop above. No detectable terminal event was ever seen, so the only
    // signal this adapter has is the stream simply ending: rely on that plus
    // the idle-timeout deadline above (already elapsed by definition if we
    // got here) to distinguish a clean-but-unreported completion from a
    // dropped connection — treated as a truncated/malformed attempt below,
    // per module header.
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      parser.push(trailing);
    }
    const torn = parser.flush();
    if (torn.length > 0) {
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("Gemini SSE stream ended mid-record (torn stream)"),
      };
    } else if (!receivedAnyChunk) {
      // A 200 with literally zero bytes never sets `sawFirstChunk` and would
      // otherwise yield nothing — fail closed with a terminal `malformed`
      // rather than a silent-success empty iterable.
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("empty response body"),
      };
    } else if (sawFirstChunk && !sawFinish) {
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("Gemini SSE stream ended before a finishReason was reported (truncated stream)"),
      };
    }

    // Emit, checking cancellation before every event so an aborted attempt
    // ends with exactly one trailing `cancelled` error and no further output.
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
