// Native OpenAI Responses-API provider adapter (flow 183, T6 / AC1/AC5/AC6).
//
// A THIN `fetch` + SSE adapter over the OpenAI **Responses API** (`POST
// /v1/responses`, `stream:true`) — NOT the older Chat Completions
// `/v1/chat/completions` shape the extracted `OpenAiCompatEngine` engine
// speaks. Built to `AnthropicProvider`'s exact template: capability-grant
// gated, NO vendor SDK, only the injected `fetch`, the neutral W5 port types,
// the reused (genuinely generic, despite its name/location)
// `AnthropicSSEParser` `text/event-stream` framer, and the reused W15
// private-egress predicate cross this module's boundary.
//
// Responses API is chosen over Chat Completions per this flow's
// `plan.md`/`description.md` research: Chat Completions stays supported, but
// new agentic features (reasoning summaries, hosted tools) land only in
// Responses — see `.metaproject/flows/183-.../plan.md`'s "OpenAI: Responses
// API" section for the sourced wire-shape research this module implements.
//
// Determinism / offline: `fetch` is always injected via `deps.fetch` (the
// global is never touched); no `Date.now`/`Math.random`. Every yielded
// event/error is scrubbed of the credential before it leaves this module, and
// nothing is ever persisted (storage-off).

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
export interface OpenAiCapabilityGrant {
  readonly network: true;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export interface OpenAiProviderDeps {
  readonly fetch: typeof fetch;
  readonly grant?: OpenAiCapabilityGrant;
  readonly clock?: () => number;
}

/** One model advertised by {@link OpenAiProvider.descriptorDocument}. */
export interface OpenAiModelDescriptor {
  modelId: string;
  revision: string;
}

/**
 * The durable, schema-validating descriptor document for the OpenAI provider.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export interface OpenAiProviderDescriptorDocument {
  schemaVersion: number;
  providerId: string;
  providerRevision: string;
  models: OpenAiModelDescriptor[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelToolCalls: boolean;
    cancellation: boolean;
    structuredOutput?: boolean;
  };
  remoteState: { storage: false; retention: false; continuation: false };
}

/** Public OpenAI Responses API base URL used when the grant supplies none. */
const DEFAULT_BASE_URL = "https://api.openai.com";
/** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
const PROVIDER_REVISION = "openai-responses-2026-08";
/** The single model this adapter fixture pins. */
const DEFAULT_MODEL: OpenAiModelDescriptor = {
  modelId: "gpt-4.1",
  revision: "2026-08",
};

/** A normalized event without its per-attempt bookkeeping fields. */
type EventBody = Omit<NormalizedEvent, "sequence" | "attemptId">;

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
 * Serialize a normalized conversation into Responses API `input` item array
 * form (NOT the Chat Completions `messages[]` shape). `systemInstruction`
 * does NOT go into `input` at all — it is sent as the top-level
 * `instructions` string field (see {@link OpenAiProvider.stream}).
 *
 * The Responses API expresses the tool loop as sibling ITEMS in the flat
 * `input` array: a `function_call` item (the assistant's call) and a
 * `function_call_output` item (the tool's result), correlated by `call_id` —
 * not content blocks nested inside one message, unlike Anthropic. Only pairs
 * that hold together inside THIS request become linked items
 * (`linkToolCalls`); a half-pair degrades to a plain message item, so a
 * compacted or resumed window cannot produce a dangling reference the API
 * would reject.
 */
function toResponsesInput(messages: readonly NormalizedMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const linked of linkToolCalls(messages)) {
    const message = linked.message;
    if (message.role === "tool") {
      if (linked.linkedToolCallId !== undefined) {
        out.push({ type: "function_call_output", call_id: linked.linkedToolCallId, output: message.content });
        continue;
      }
      // Half-pair: no assistant call in this request answers this result.
      // Degrade to a plain user message rather than emitting a dangling
      // function_call_output the API would reject.
      out.push({ type: "message", role: "user", content: [{ type: "input_text", text: message.content }] });
      continue;
    }
    if (message.role === "assistant" && message.content.length === 0 && linked.linkedCalls.length === 0) {
      // A tool-call turn whose calls could not be linked carries no text and
      // no calls — nothing to emit.
      continue;
    }
    if (message.role === "assistant" && linked.linkedCalls.length > 0) {
      if (message.content.length > 0) {
        out.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const call of linked.linkedCalls) {
        out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      continue;
    }
    out.push({
      type: "message",
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
    });
  }
  return out;
}

/** Resolve a concrete retry disposition, falling back for policy-conditional rows. */
function retryableFor(kind: ProviderErrorKind, fallback: boolean): boolean {
  const concrete = defaultRetryable(kind);
  return concrete === undefined ? fallback : concrete;
}

/**
 * Merge the Responses API's split token counts into a single exact
 * {@link NormalizedUsage}. `NormalizedUsage` has no dedicated reasoning-token
 * field — the caller folds `output_tokens_details.reasoning_tokens` into the
 * event body's `unknownExtensions` under a namespaced key instead of
 * discarding it.
 */
function mergeUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  totalTokens: number | undefined,
): NormalizedUsage {
  const usage: NormalizedUsage = { exact: true };
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  } else if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  }
  return usage;
}

/**
 * Extract the vendor error object from either the DOCUMENTED terminal SSE
 * `error` event shape (fields flat on the event) or the shape actually
 * observed in the wild (fields nested under an `error` key) — research
 * (community-reported, flow 183 T6) found live responses disagree with the
 * documented reference for this one event, so both are accepted rather than
 * trusting either exclusively.
 */
interface ExtractedErrorFields {
  code?: string;
  message?: string;
  param?: string;
}

function extractErrorFields(data: Record<string, unknown>): ExtractedErrorFields {
  const nested = asRecord(data.error);
  const code = asString(nested.code) ?? asString(data.code);
  const message = asString(nested.message) ?? asString(data.message);
  const param = asString(nested.param) ?? asString(data.param);
  const out: ExtractedErrorFields = {};
  if (code !== undefined) {
    out.code = code;
  }
  if (message !== undefined) {
    out.message = message;
  }
  if (param !== undefined) {
    out.param = param;
  }
  return out;
}

/** Classify a non-2xx HTTP response into the neutral error taxonomy. */
function classifyHttpError(status: number, headers: Headers, code: string | undefined): NormalizedError {
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
  if (status === 400) {
    // `context_length_exceeded` is the confirmed `code` string OpenAI returns
    // for an over-budget request on the non-streaming path (research, flow
    // 183 T6) — mapped to the dedicated `context_overflow` taxonomy row
    // rather than the generic `invalid_request`.
    if (code === "context_length_exceeded") {
      return { kind: "context_overflow", retryable: retryableFor("context_overflow", false), message: "" };
    }
    return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
  }
  if (status >= 500) {
    return { kind: "unavailable", retryable: retryableFor("unavailable", true), message: "" };
  }
  if (status >= 400) {
    return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
  }
  return { kind: "unknown", retryable: retryableFor("unknown", false), message: "" };
}

/** In-progress `function_call` item state, keyed by the wire `item_id`. */
interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/**
 * Thin OpenAI Responses-API {@link ProviderPort}. Constructed with an
 * injected `fetch` and an optional explicit capability `grant`; `stream()`
 * performs one guarded, credential-redacted, storage-off attempt and
 * normalizes its SSE into the documented `NormalizedEvent` sequence.
 */
export class OpenAiProvider implements ProviderPort {
  private readonly deps: OpenAiProviderDeps;

  constructor(deps: OpenAiProviderDeps) {
    this.deps = deps;
  }

  describe(): ProviderDescription {
    const capabilities: ProviderCapabilities = {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: true,
      // Confirmed via research (flow 183 T6): `response.reasoning_summary_text.delta`
      // streams reasoning-SUMMARY text fragments (never raw chain-of-thought),
      // corroborated by the official streaming-events reference, OpenAI SDK
      // issue tracker, and OpenAI developer community threads independently
      // describing the same event name/field shape.
      reasoningMetadata: true,
      // Automatic/opaque prompt caching, observed only via
      // `usage.input_tokens_details.cached_tokens` — no cache-object
      // management needed, an honest claim for a stateless adapter.
      promptCaching: true,
      // `input_image` content-part shape was confirmed via research (flow 183
      // T6: `{type:"input_image", image_url, detail, file_id}`), but request-
      // side image-input SERIALIZATION is not implemented by this adapter
      // (toResponsesInput only builds text parts) — claiming `true` without
      // wiring the capability would overclaim, so this stays `false` per
      // plan.md's "unconfirmed/unwired -> false" rule.
      vision: false,
      tokenCounting: false,
      modelListing: false,
    };
    return {
      capabilities,
      descriptor: { providerId: "openai", providerRevision: PROVIDER_REVISION },
    };
  }

  descriptorDocument(): OpenAiProviderDescriptorDocument {
    return {
      schemaVersion: 1,
      providerId: "openai",
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

    // Credential redaction: scrub the apiKey out of any string that leaves the
    // module. `grant` may be absent (no credential to scrub).
    const redact = (message: string): string =>
      grant !== undefined && grant.apiKey.length > 0 ? message.split(grant.apiKey).join("[redacted]") : message;

    // No valid grant -> fail-closed, `fetch` NEVER invoked.
    if (grant === undefined || grant.network !== true || typeof grant.apiKey !== "string" || grant.apiKey.length === 0) {
      yield errorEvent({
        kind: "authentication",
        retryable: retryableFor("authentication", false),
        message: "network capability grant with an apiKey is required to reach the OpenAI API",
      });
      return;
    }

    const baseUrl = grant.baseUrl ?? DEFAULT_BASE_URL;

    // Guarded egress: private/loopback/link-local/metadata hosts fail closed,
    // BEFORE any fetch, reusing the W15 SSRF predicate (AC4).
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

    const url = `${baseUrl.replace(/\/+$/, "")}/v1/responses`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${grant.apiKey}`,
      "content-type": "application/json",
    };
    const payload: Record<string, unknown> = {
      model: request.modelId,
      instructions: request.systemInstruction,
      input: toResponsesInput(request.messages),
      stream: true,
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              parameters: tool.inputSchema,
            })),
            parallel_tool_calls: true,
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
        message: redact(`network request to the OpenAI API failed: ${String(cause)}`),
      });
      return;
    }

    // Provider negatives: non-2xx -> typed, fail-closed error, no model_end.
    if (!response.ok) {
      let bodyRecord: Record<string, unknown> = {};
      try {
        bodyRecord = asRecord(JSON.parse(await response.text()));
      } catch {
        // Non-JSON error body: keep the generic status message below.
      }
      const fields = extractErrorFields(bodyRecord);
      const error = classifyHttpError(response.status, response.headers, fields.code);
      let providerMessage = `OpenAI API returned HTTP ${response.status}`;
      if (fields.message !== undefined && fields.message.length > 0) {
        providerMessage = fields.message;
      }
      error.message = redact(providerMessage);
      yield stamp({ kind: "provider_error", error });
      return;
    }

    // Happy path: read the SSE body (offline, fully in-memory) and normalize.
    //
    // Guarded body read (mirrors the AnthropicProvider/compat-engine fix): an
    // abort mid-read yields the SAME terminal `cancelled` error the fetch-level
    // abort path yields; any other read-time failure fails closed as
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
        message: redact(`OpenAI SSE body read failed: ${String(cause)}`),
      });
      return;
    }

    // Zero-byte body: a 200 with no SSE bytes never sets `sawStart` and would
    // otherwise yield nothing — fail closed with a terminal `malformed`.
    if (bodyText.length === 0) {
      yield errorEvent({
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: redact("empty response body"),
      });
      return;
    }

    const parser = new AnthropicSSEParser();
    const records = parser.push(bodyText);
    const torn = parser.flush();

    const bodies: EventBody[] = [];
    const pendingTools = new Map<string, PendingToolCall>();
    let sawStart = false;
    let sawCompleted = false;
    let malformed: NormalizedError | undefined;
    let terminalError: NormalizedError | undefined;

    for (const record of records) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.data);
      } catch {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("OpenAI SSE data line was not valid JSON"),
        };
        break;
      }
      const data = asRecord(parsed);
      const eventType = asString(data.type) ?? asString(record.event);

      switch (eventType) {
        case "response.created": {
          // Bookkeeping only — `model_start` is emitted on the first REAL
          // content/tool event below, mirroring the compat engine's "first
          // chunk seen" convention rather than firing on this event, which
          // can precede a request that ultimately yields nothing.
          break;
        }
        case "response.output_item.added": {
          const item = asRecord(data.item);
          if (asString(item.type) === "function_call") {
            if (!sawStart) {
              sawStart = true;
              bodies.push({ kind: "model_start" });
            }
            const itemId = asString(data.item_id) ?? asString(item.id) ?? "";
            // `call_id`, NOT `id`, is the correlation key OpenAI actually uses
            // (confirmed via research, flow 183 T6) — `id` is the item's own
            // identity, `call_id` is what a later `function_call_output` item
            // must reference to answer this call.
            const callId = asString(item.call_id) ?? itemId;
            const toolName = asString(item.name);
            pendingTools.set(itemId, { callId, name: toolName ?? "", arguments: asString(item.arguments) ?? "" });
            const startBody: EventBody = { kind: "tool_call_start", toolCallId: callId };
            if (toolName !== undefined) {
              startBody.toolName = toolName;
            }
            bodies.push(startBody);
          }
          break;
        }
        case "response.output_text.delta": {
          if (!sawStart) {
            sawStart = true;
            bodies.push({ kind: "model_start" });
          }
          const text = asString(data.delta);
          const body: EventBody = { kind: "text_delta" };
          if (text !== undefined) {
            body.text = text;
          }
          bodies.push(body);
          break;
        }
        case "response.reasoning_summary_text.delta": {
          if (!sawStart) {
            sawStart = true;
            bodies.push({ kind: "model_start" });
          }
          const text = asString(data.delta);
          if (text !== undefined && text.length > 0) {
            bodies.push({ kind: "reasoning_delta", text });
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = asString(data.item_id) ?? "";
          const fragment = asString(data.delta) ?? "";
          const pending = pendingTools.get(itemId);
          const toolCallId = pending?.callId ?? itemId;
          if (pending !== undefined) {
            pending.arguments += fragment;
          }
          if (fragment.length > 0) {
            bodies.push({ kind: "tool_call_delta", toolCallId, inputDelta: fragment });
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const itemId = asString(data.item_id) ?? "";
          const pending = pendingTools.get(itemId);
          const fullArguments = asString(data.arguments) ?? pending?.arguments ?? "";
          const toolCallId = pending?.callId ?? itemId;
          bodies.push({ kind: "tool_call_end", toolCallId, input: fullArguments });
          pendingTools.delete(itemId);
          break;
        }
        case "response.output_item.done": {
          // A `function_call` item's completion is already handled by
          // `response.function_call_arguments.done` above; this event is a
          // defensive fallback for a call whose `arguments.done` never
          // arrived (e.g. a zero-argument call some models skip the delta
          // for) so `tool_call_end` is still guaranteed.
          const item = asRecord(data.item);
          if (asString(item.type) === "function_call") {
            const itemId = asString(data.item_id) ?? asString(item.id) ?? "";
            const pending = pendingTools.get(itemId);
            if (pending !== undefined) {
              const fullArguments = asString(item.arguments) ?? pending.arguments;
              bodies.push({ kind: "tool_call_end", toolCallId: pending.callId, input: fullArguments });
              pendingTools.delete(itemId);
            }
          }
          break;
        }
        case "response.completed": {
          sawCompleted = true;
          const usage = asRecord(asRecord(data.response).usage);
          const inputTokens = asNumber(usage.input_tokens);
          const outputTokens = asNumber(usage.output_tokens);
          const totalTokens = asNumber(usage.total_tokens);
          const reasoningTokens = asNumber(asRecord(usage.output_tokens_details).reasoning_tokens);
          const usageBody: EventBody = {
            kind: "usage_update",
            usage: mergeUsage(inputTokens, outputTokens, totalTokens),
          };
          if (reasoningTokens !== undefined) {
            usageBody.unknownExtensions = { "openai.reasoning_tokens": reasoningTokens };
          }
          bodies.push(usageBody);
          bodies.push({ kind: "model_end" });
          break;
        }
        case "response.failed":
        case "response.incomplete": {
          const fields = extractErrorFields(asRecord(data.response));
          const code = fields.code;
          let kind: ProviderErrorKind = "unknown";
          if (code === "context_length_exceeded") {
            kind = "context_overflow";
          } else if (code !== undefined && code.length > 0) {
            kind = "invalid_request";
          }
          let message = fields.message;
          if (message === undefined || message.length === 0) {
            // Defensive, per research: a documented bug means context-overflow
            // on this streaming path can produce a terminal error with an
            // EMPTY message. Never surface an empty string.
            message =
              kind === "context_overflow"
                ? "OpenAI Responses API returned an error with no message; likely context-length overflow"
                : "OpenAI Responses API returned an error with no message";
          }
          terminalError = { kind, retryable: retryableFor(kind, false), message: redact(message) };
          break;
        }
        case "error": {
          const fields = extractErrorFields(data);
          const code = fields.code;
          let kind: ProviderErrorKind = "unknown";
          if (code === "context_length_exceeded") {
            kind = "context_overflow";
          } else if (code !== undefined && code.length > 0) {
            kind = "invalid_request";
          }
          let message = fields.message;
          if (message === undefined || message.length === 0) {
            // Defensive, per research: the documented empty-`message` bug on
            // this terminal `error` event, most commonly triggered by
            // context-length overflow. Never surface an empty string.
            message =
              kind === "context_overflow"
                ? "OpenAI Responses API returned an error with no message; likely context-length overflow"
                : "OpenAI Responses API returned an error with no message; likely context-length overflow (unconfirmed cause)";
          }
          terminalError = { kind, retryable: retryableFor(kind, false), message: redact(message) };
          break;
        }
        default:
          // `response.in_progress`, `response.content_part.added`/`.done`,
          // and any other unrecognized event type carry no neutral mapping.
          break;
      }
      if (terminalError !== undefined) {
        break;
      }
    }

    // Torn trailing record or a stream that started but never reached a
    // terminal event is a truncated/malformed attempt: no model_end.
    if (malformed === undefined && terminalError === undefined) {
      if (torn.length > 0) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("OpenAI SSE stream ended mid-record (torn stream)"),
        };
      } else if (sawStart && !sawCompleted) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("OpenAI SSE stream ended before response.completed (truncated stream)"),
        };
      }
    }

    // Emit, checking cancellation before every event so an aborted attempt ends
    // with exactly one trailing `cancelled` error and no further output.
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
    if (terminalError !== undefined) {
      yield stamp({ kind: "provider_error", error: terminalError });
      return;
    }
    if (malformed !== undefined) {
      yield stamp({ kind: "provider_error", error: malformed });
    }
  }
}
