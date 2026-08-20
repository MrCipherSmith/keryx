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
      if (message.content.length > 0) {
        parts.push({ text: message.content });
      }
      for (const call of linked.linkedCalls) {
        parts.push({
          functionCall: { name: call.name, id: call.id, args: parseToolInput(call.arguments) },
        });
      }
      out.push({ role: "model", parts });
      continue;
    }
    out.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
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

    const modelId = request.modelId.length > 0 ? request.modelId : DEFAULT_MODEL.modelId;
    const url = `${baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
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

    // Happy path: read the SSE body (offline, fully in-memory) and normalize.
    // Fail-closed body read (mirrors AnthropicProvider/compat engine): an
    // abort mid-read yields the SAME terminal `cancelled` error the
    // fetch()-level abort path yields; any OTHER read failure fails closed as
    // `malformed`. No model_end on either path.
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (cause) {
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

    // Zero-byte / empty body: a 200 with no SSE bytes parses to zero records
    // and never yields a first chunk, indistinguishable from a legitimate
    // no-output attempt. Fail closed with a terminal `malformed` error (no
    // model_end) instead.
    if (bodyText.length === 0) {
      yield errorEvent({
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("empty response body"),
      });
      return;
    }

    // Gemini's `alt=sse` framing is `data: <complete GenerateContentResponse
    // JSON>` per record, no `event:` line — exactly what AnthropicSSEParser
    // already parses (a generic `data:`-line framer tolerant of an absent
    // `event`). Reused UNCHANGED, no adaptation needed (confirmed via
    // research, see module header).
    const parser = new AnthropicSSEParser();
    const records = parser.push(bodyText);
    const torn = parser.flush();

    const bodies: EventBody[] = [];
    let sawFirstChunk = false;
    let sawFinish = false;
    let malformed: NormalizedError | undefined;
    let promptTokens: number | undefined;
    let candidatesTokens: number | undefined;
    let totalTokens: number | undefined;
    let cachedContentTokens: number | undefined;
    let thoughtsTokens: number | undefined;

    for (const record of records) {
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
        if (text !== undefined) {
          // A `thought: true` part is chain-of-thought reasoning text, never
          // ordinary output (confirmed via research, see module header).
          if (asBoolean(part.thought)) {
            bodies.push({ kind: "reasoning_delta", text });
          } else {
            bodies.push({ kind: "text_delta", text });
          }
          continue;
        }
        const functionCall = asRecord(part.functionCall);
        const callName = asString(functionCall.name);
        if (callName !== undefined) {
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
      }
    }

    // usage_update precedes model_end, once, using the LAST-seen usageMetadata
    // values (research: unclear whether usageMetadata appears per-chunk or
    // only on the final chunk — folding progressively and emitting once at
    // the end is correct either way).
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
    if (sawFinish) {
      bodies.push({ kind: "model_end" });
    }

    // Torn trailing record or a stream that produced chunks but never
    // reported a finishReason is a truncated/malformed attempt: no model_end.
    if (malformed === undefined) {
      if (torn.length > 0) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("Gemini SSE stream ended mid-record (torn stream)"),
        };
      } else if (sawFirstChunk && !sawFinish) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("Gemini SSE stream ended before a finishReason was reported (truncated stream)"),
        };
      }
    }

    // Emit, checking cancellation before every event so an aborted attempt
    // ends with exactly one trailing `cancelled` error and no further output.
    for (const body of bodies) {
      if (opts.signal?.aborted === true) {
        yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
        return;
      }
      yield stamp(body);
    }
    if (opts.signal?.aborted === true) {
      yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
      return;
    }
    if (malformed !== undefined) {
      yield stamp({ kind: "provider_error", error: malformed });
    }
  }
}
