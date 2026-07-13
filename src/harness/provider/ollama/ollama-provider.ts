// Ollama OpenAI-compatible provider adapter (flow 020, T6 / AC1-AC3).
//
// A THIN `fetch` + SSE adapter over the Ollama OpenAI-compatible
// `POST /v1/chat/completions` endpoint (`stream:true`) behind an explicit
// network capability grant. NO Ollama SDK, NO new dependency — only the injected
// `fetch`, the neutral W5 port types, the reused W14 SSE parser
// (`AnthropicSSEParser`, a generic `data:`-line framer), and the reused W15
// egress predicates (`isPrivateEgressHost` + the additive `isLoopbackHost`)
// cross this module's boundary.
//
// SECURITY (AC2): egress is DENIED fail-closed for any private/loopback/
// link-local/metadata host UNLESS the destination is loopback AND the grant
// carries the explicit `allowLoopback` opt-in. The opt-in re-permits LOOPBACK
// ONLY — metadata/link-local/private-LAN hosts stay denied even with it.
//
// Determinism / offline: `fetch` is always injected via `deps.fetch` (the global
// is never touched); there is NO `Date.now`/`Math.random` (a clock is injectable
// via `deps.clock` but unused on these paths). Nothing is ever persisted
// (storage-off), and a guarded body read fails closed (mirrors the W14 flow-019
// fix): an abort mid-read yields `cancelled`, any other read failure `malformed`.

import { isLoopbackHost, isPrivateEgressHost } from "../../mutation/guard";
import { AnthropicSSEParser } from "../anthropic/sse";
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

/** Explicit capability grant authorizing this adapter to reach the network. */
export interface OllamaCapabilityGrant {
  readonly network: true;
  readonly baseUrl?: string;
  /** Narrow opt-in that re-permits LOOPBACK egress only (never widens SSRF). */
  readonly allowLoopback?: boolean;
}

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export interface OllamaProviderDeps {
  readonly fetch: typeof fetch;
  readonly grant?: OllamaCapabilityGrant;
  readonly clock?: () => number;
}

/** One model advertised by {@link OllamaProvider.descriptorDocument}. */
export interface OllamaModelDescriptor {
  modelId: string;
  revision: string;
}

/**
 * The durable, schema-validating descriptor document for the Ollama provider.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export interface OllamaProviderDescriptorDocument {
  schemaVersion: number;
  providerId: string;
  providerRevision: string;
  models: OllamaModelDescriptor[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelToolCalls: boolean;
    cancellation: boolean;
    structuredOutput?: boolean;
  };
  remoteState: { storage: false; retention: false; continuation: false };
}

/** Default local Ollama base URL used when the grant supplies none. */
const DEFAULT_BASE_URL = "http://localhost:11434";
/** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
const PROVIDER_REVISION = "ollama-2024-10-22";
/** The single model this adapter fixture pins. */
const DEFAULT_MODEL: OllamaModelDescriptor = {
  modelId: "llama3.1:latest",
  revision: "latest",
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

/** Resolve a concrete retry disposition, falling back for policy-conditional rows. */
function retryableFor(kind: ProviderErrorKind, fallback: boolean): boolean {
  const concrete = defaultRetryable(kind);
  return concrete === undefined ? fallback : concrete;
}

/** Merge Ollama's split token counts into a single exact {@link NormalizedUsage}. */
function mergeUsage(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  totalTokens: number | undefined,
): NormalizedUsage {
  const usage: NormalizedUsage = { exact: true };
  if (promptTokens !== undefined) {
    usage.inputTokens = promptTokens;
  }
  if (completionTokens !== undefined) {
    usage.outputTokens = completionTokens;
  }
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  } else if (promptTokens !== undefined || completionTokens !== undefined) {
    usage.totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
  }
  return usage;
}

/** Classify a non-2xx HTTP response into the neutral error taxonomy. */
function classifyHttpError(status: number): NormalizedError {
  if (status >= 500) {
    return { kind: "unavailable", retryable: retryableFor("unavailable", true), message: "" };
  }
  // 404 (model not found) and any other 4xx are non-retryable invalid requests.
  return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
}

/**
 * Thin Ollama OpenAI-compatible {@link ProviderPort}. Constructed with an
 * injected `fetch` and an optional explicit capability `grant`; `stream()`
 * performs one guarded, storage-off attempt and normalizes its SSE into the
 * documented `NormalizedEvent` sequence.
 */
export class OllamaProvider implements ProviderPort {
  private readonly deps: OllamaProviderDeps;

  constructor(deps: OllamaProviderDeps) {
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
      descriptor: { providerId: "ollama", providerRevision: PROVIDER_REVISION },
    };
  }

  descriptorDocument(): OllamaProviderDescriptorDocument {
    return {
      schemaVersion: 1,
      providerId: "ollama",
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

    // Capability gate: no valid network grant -> fail-closed, `fetch` NEVER invoked.
    if (grant === undefined || grant.network !== true) {
      yield errorEvent({
        kind: "invalid_request",
        retryable: retryableFor("invalid_request", false),
        message: "a network capability grant is required to reach the Ollama API",
      });
      return;
    }

    const baseUrl = grant.baseUrl ?? DEFAULT_BASE_URL;

    // SECURITY egress gate (AC2): a private/loopback/link-local/metadata host is
    // denied BEFORE any fetch, reusing the W15 SSRF predicate. Loopback is
    // re-permitted ONLY when the grant carries the explicit `allowLoopback`
    // opt-in; metadata/link-local/private-LAN never are.
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      host = baseUrl;
    }
    const permitted = !isPrivateEgressHost(host) || (grant.allowLoopback === true && isLoopbackHost(host));
    if (!permitted) {
      yield errorEvent({
        kind: "invalid_request",
        retryable: retryableFor("invalid_request", false),
        message: `egress to a private/loopback/link-local/metadata host is denied: ${host}`,
      });
      return;
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemInstruction.length > 0) {
      messages.push({ role: "system", content: request.systemInstruction });
    }
    for (const message of request.messages) {
      messages.push({
        role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : message.role,
        content: message.content,
      });
    }
    const payload: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      messages,
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                ...(tool.description !== undefined ? { description: tool.description } : {}),
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
    };
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
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
        message: `network request to the Ollama API failed: ${String(cause)}`,
      });
      return;
    }

    // Provider negatives: non-2xx -> typed, fail-closed error, no model_end.
    if (!response.ok) {
      const error = classifyHttpError(response.status);
      let providerMessage = `Ollama API returned HTTP ${response.status}`;
      try {
        const parsed = asRecord(JSON.parse(await response.text()));
        const detail = asString(asRecord(parsed.error).message);
        if (detail !== undefined && detail.length > 0) {
          providerMessage = detail;
        }
      } catch {
        // Non-JSON error body: keep the generic status message.
      }
      error.message = providerMessage;
      yield stamp({ kind: "provider_error", error });
      return;
    }

    // Guarded body read (flow-019 fix): an abort mid-read yields the SAME terminal
    // `cancelled` error the fetch-level abort path yields; any other read-time
    // failure fails closed as `malformed`. No model_end on either path.
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
        message: `Ollama SSE body read failed: ${String(cause)}`,
      });
      return;
    }

    // Zero-byte body: a 200 with no SSE bytes never sets `sawStart` and would
    // otherwise yield nothing — fail closed with a terminal `malformed`.
    if (bodyText.length === 0) {
      yield errorEvent({
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: "empty response body",
      });
      return;
    }

    const parser = new AnthropicSSEParser();
    const records = parser.push(bodyText);
    const torn = parser.flush();

    const bodies: EventBody[] = [];
    let sawStart = false;
    let sawFinish = false;
    let sawDone = false;
    let malformed: NormalizedError | undefined;

    for (const record of records) {
      const trimmed = record.data.trim();
      // `data: [DONE]` is the stream terminator, never a model chunk.
      if (trimmed === "[DONE]") {
        sawDone = true;
        continue;
      }

      // The FIRST non-terminator chunk always yields `model_start` (keyed off
      // "first chunk seen", not `delta.role` — the tool-call fixture's first
      // chunk carries no role).
      if (!sawStart) {
        sawStart = true;
        bodies.push({ kind: "model_start" });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(record.data);
      } catch {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: "Ollama SSE data line was not valid JSON",
        };
        break;
      }
      const data = asRecord(parsed);

      // A trailing usage-bearing chunk (`choices:[]` + `usage:{...}`) -> usage_update.
      if (data.usage !== undefined) {
        const usage = asRecord(data.usage);
        bodies.push({
          kind: "usage_update",
          usage: mergeUsage(
            asNumber(usage.prompt_tokens),
            asNumber(usage.completion_tokens),
            asNumber(usage.total_tokens),
          ),
        });
      }

      const choice0 = asRecord(asArray(data.choices)[0]);
      const delta = asRecord(choice0.delta);

      const content = asString(delta.content);
      if (content !== undefined && content.length > 0) {
        bodies.push({ kind: "text_delta", text: content });
      }

      for (const rawToolCall of asArray(delta.tool_calls)) {
        const toolCall = asRecord(rawToolCall);
        const fn = asRecord(toolCall.function);
        const toolCallId = asString(toolCall.id);
        const toolName = asString(fn.name);
        const argumentsString = asString(fn.arguments) ?? "";

        const startBody: EventBody = { kind: "tool_call_start" };
        if (toolCallId !== undefined) startBody.toolCallId = toolCallId;
        if (toolName !== undefined) startBody.toolName = toolName;
        bodies.push(startBody);

        // Ollama sends the whole `arguments` string in one chunk; emit one
        // `tool_call_delta` so its `inputDelta` concatenates to the final input.
        const deltaBody: EventBody = { kind: "tool_call_delta", inputDelta: argumentsString };
        if (toolCallId !== undefined) deltaBody.toolCallId = toolCallId;
        bodies.push(deltaBody);

        const endBody: EventBody = { kind: "tool_call_end", input: argumentsString };
        if (toolCallId !== undefined) endBody.toolCallId = toolCallId;
        bodies.push(endBody);
      }

      // `finish_reason` is DEFERRED: it marks completion but emits no event; the
      // trailing usage chunk (above) is surfaced BEFORE `model_end`.
      const finishReason = asString(choice0.finish_reason);
      if (finishReason !== undefined && finishReason.length > 0) {
        sawFinish = true;
      }
    }

    // A torn trailing record is a truncated/malformed attempt (no model_end).
    if (malformed === undefined && torn.length > 0) {
      malformed = {
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: "Ollama SSE stream ended mid-record (torn stream)",
      };
    }

    // A clean stream that reached `[DONE]` or a `finish_reason` completes with a
    // terminal `model_end` (emitted after any usage_update).
    if (malformed === undefined && sawStart && (sawDone || sawFinish)) {
      bodies.push({ kind: "model_end" });
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
