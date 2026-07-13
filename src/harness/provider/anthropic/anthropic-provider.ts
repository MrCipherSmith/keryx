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
import type {
  NormalizedError,
  NormalizedEvent,
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

/** In-progress content-block state, keyed by the wire `index`. */
interface BlockState {
  type: "tool" | "text";
  toolCallId?: string;
  input: string;
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
      reasoningMetadata: false,
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
    const payload: Record<string, unknown> = {
      model: request.modelId,
      max_tokens: request.budget.maxOutputTokens,
      system: request.systemInstruction,
      messages: request.messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
      stream: true,
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

    // Happy path: read the SSE body (offline, fully in-memory) and normalize.
    //
    // Fail-closed body read (H-01 T5): `fetch()` has already resolved (headers
    // received), but the body can still stall until a deadline abort fires the
    // SHARED `opts.signal` mid-read — the abort-triggered rejection from
    // `response.text()` must yield the SAME terminal `cancelled` error the
    // fetch()-level abort path yields, never escape as an uncaught exception out
    // of this generator. Any OTHER read-time failure (a torn/errored body stream)
    // fails closed as `malformed`, matching the truncated-stream taxonomy below.
    // No model_end on either path.
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
        message: redact(`Anthropic SSE body read failed: ${String(cause)}`),
      });
      return;
    }

    // Zero-byte / empty body (H-01 T5): a 200 with no SSE bytes parses to zero
    // records and never sets `sawStart`, so neither the torn nor truncated
    // `malformed` branch below fires and the generator would otherwise yield
    // NOTHING — indistinguishable from a legitimate no-output attempt. Fail
    // closed with a terminal `malformed` error (no model_end) instead.
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
    const blocks = new Map<number, BlockState>();
    let inputTokens: number | undefined;
    let sawStart = false;
    let sawStop = false;
    let malformed: NormalizedError | undefined;

    for (const record of records) {
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
          if (asString(block.type) === "tool_use") {
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
        default:
          // `ping`, `content_block_start` for non-tool blocks handled above, and
          // any unknown event carry no neutral mapping.
          break;
      }
    }

    // Torn trailing record or a stream that started but never reached
    // `message_stop` is a truncated/malformed attempt (AC4): no model_end.
    if (malformed === undefined) {
      if (torn.length > 0) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("Anthropic SSE stream ended mid-record (torn stream)"),
        };
      } else if (sawStart && !sawStop) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: redact("Anthropic SSE stream ended before message_stop (truncated stream)"),
        };
      }
    }

    // Emit, checking cancellation before every event so an aborted attempt ends
    // with exactly one trailing `cancelled` error and no further output (AC1).
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
