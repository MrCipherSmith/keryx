// Generic OpenAI-Chat-Completions-compatible engine (flow 183, T5 / AC3).
//
// Extracted verbatim (behavior-for-behavior) from `OllamaProvider`
// (`../ollama/ollama-provider.ts`, flow 020 T6 + flows 047/049/056/177), which
// was, per its own header comment, never actually Ollama-specific: its
// `stream()` body IS the generic OpenAI-Chat-Completions `POST
// /v1/chat/completions` (`stream:true`) engine, reused unmodified for 9
// hosted OpenAI-compatible gateways (OpenRouter, DeepSeek, Z.AI x2, Cerebras,
// Groq, Moonshot, Grok) that have nothing to do with Ollama.
//
// This module is THE generic engine, parameterized by identity (provider id,
// provider revision, default base URL, default model) via
// {@link OpenAiCompatIdentity}. `OllamaProvider` is now a thin wrapper that
// constructs this engine with Ollama's specific defaults (loopback allowed,
// no key required, `http://localhost:11434`); every other OpenAI-compatible
// gateway (`make-provider.ts`'s compat-registry branch) constructs this
// engine directly with its own identity.
//
// A THIN `fetch` + SSE adapter over an OpenAI-compatible `POST
// /v1/chat/completions` endpoint (`stream:true`) behind an explicit network
// capability grant. NO vendor SDK, NO new dependency — only the injected
// `fetch`, the neutral W5 port types, the reused W14 SSE parser
// (`AnthropicSSEParser`, a generic `data:`-line framer), and the reused W15
// egress predicates (`isPrivateEgressHost` + the additive `isLoopbackHost`)
// cross this module's boundary.
//
// SECURITY (AC2 of flow 020, preserved here as AC4 of flow 183): egress is
// DENIED fail-closed for any private/loopback/link-local/metadata host UNLESS
// the destination is loopback AND the grant carries the explicit
// `allowLoopback` opt-in. The opt-in re-permits LOOPBACK ONLY — metadata/
// link-local/private-LAN hosts stay denied even with it.
//
// Determinism / offline: `fetch` is always injected via `deps.fetch` (the
// global is never touched); there is NO `Date.now`/`Math.random` (a clock is
// injectable via `deps.clock` but unused on these paths). Nothing is ever
// persisted (storage-off), and a guarded body read fails closed (mirrors the
// W14 flow-019 fix): an abort mid-read yields `cancelled`, any other read
// failure `malformed`.

import { redactSensitiveText } from "../../../security/service";
import { isLoopbackHost, isPrivateEgressHost, isPrivateLanHost } from "../../mutation/guard";
import { AnthropicSSEParser } from "../anthropic/sse";
import { defaultRetryable } from "../provider-port";
import { linkToolCalls } from "../tool-call-linking";
import { ThinkTagParser } from "./think-tag-parser";
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

/** Explicit capability grant authorizing this adapter to reach the network. */
export interface OpenAiCompatCapabilityGrant {
  readonly network: true;
  readonly baseUrl?: string;
  /** Narrow opt-in that re-permits LOOPBACK egress only (never widens SSRF). */
  readonly allowLoopback?: boolean;
  /**
   * Operator opt-in for custom file providers only: re-permits RFC1918
   * private-LAN egress (10/8, 172.16/12, 192.168/16, CGNAT 100.64/10) for a
   * hostname the operator typed into their own config. NEVER re-permits
   * loopback (use `allowLoopback`), metadata/link-local (169.254/16), or the
   * unspecified address — those stay denied even with this flag.
   */
  readonly allowPrivateLan?: boolean;
  /**
   * Ask the server to append a usage-bearing chunk to the stream.
   *
   * Without `stream_options: { include_usage: true }` an OpenAI-compatible stream
   * carries NO usage at all, so `onUsage` never fires, `NormalizedUsage` stays
   * empty and the session has no idea what it spent. Verified against x.ai: the
   * same request returns zero usage chunks without the field and
   * `prompt_tokens: 638, cached_tokens: 512` with it.
   *
   * Opt-in per grant rather than always-on, because a non-conformant
   * OpenAI-compatible server may reject an unknown top-level field, and a local
   * model that works today must keep working. Declared per provider in the registry
   * and confirmed per provider; the loopback Ollama path leaves it alone.
   */
  readonly streamUsage?: boolean;  /**
   * Optional bearer credential for an authenticated OpenAI-compatible gateway
   * (e.g. OpenRouter). When set, an `Authorization: Bearer <apiKey>` header is
   * sent. Read from env by the caller; never logged or echoed here.
   */
  readonly apiKey?: string;
  /**
   * Chat path appended to `baseUrl`; defaults to `/v1/chat/completions`. Overridden
   * for versioned OpenAI-compat endpoints (e.g. Z.AI GLM `…/paas/v4` answers at
   * `/chat/completions`, no `/v1`).
   */
  readonly chatPath?: string;
  /** Optional extra request headers (e.g. OpenRouter `HTTP-Referer` / `X-Title`). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Custom-provider reasoning configuration (flow 268 T10 / AC4-AC5), threaded
   * verbatim from `CustomCompatProvider.reasoning`
   * (`src/lib/provider-config.ts`) via `OpenAiCompatProvider.reasoning`
   * (`src/commands/providers.ts`) and `makeProvider`. Absent means the
   * pre-existing default behaviour: `delta.content` passes through unchanged,
   * and `reasoning`/`reasoning_content`/`reasoning_details` are still read
   * (see AC5 — that part is unconditional, for every format).
   */
  readonly reasoning?: {
    /**
     * `"field"` (default when absent): reasoning read from the
     * `reasoning`/`reasoning_content` delta field.
     * `"inline-tags"`: `delta.content` is routed through `ThinkTagParser`
     * (MiniMax's default `<think>…</think>` shape).
     * `"split"`: content passes through unchanged; reasoning is expected
     * out-of-band (typically paired with a `requestParams` opt-in, e.g.
     * MiniMax's `reasoning_split: true`).
     */
    readonly format?: "field" | "inline-tags" | "split";
    /**
     * Shallow-merged into the compat request payload AFTER the base fields.
     * `model`, `messages`, `stream`, and `tools` are never overridable —
     * those keys are ignored when merging.
     */
    readonly requestParams?: Readonly<Record<string, unknown>>;
    /** Stored/threaded only; a later task reads this to pick a replay strategy. */
    readonly replay?: "none" | "deepseek" | "minimax";
  };
}

/** Injected dependencies. `fetch` is mandatory (never the global); `grant` gates egress. */
export interface OpenAiCompatProviderDeps {
  readonly fetch: typeof fetch;
  readonly grant?: OpenAiCompatCapabilityGrant;
  readonly clock?: () => number;
  /**
   * Deadline (ms) for the first stream byte to arrive after the response
   * headers resolve. Guards a connection the gateway accepted but never
   * started answering. Defaults to {@link DEFAULT_STREAM_TIMEOUT_MS} (120s).
   */
  readonly firstByteTimeoutMs?: number;
  /**
   * Deadline (ms) between successive stream chunks once the first byte has
   * arrived. Guards a connection that started answering and then stalled.
   * Defaults to {@link DEFAULT_STREAM_TIMEOUT_MS} (120s).
   */
  readonly idleTimeoutMs?: number;
}

/** One model advertised by {@link OpenAiCompatEngine.descriptorDocument}. */
export interface OpenAiCompatModelDescriptor {
  modelId: string;
  revision: string;
}

/**
 * The durable, schema-validating descriptor document for this engine.
 * Validates against the frozen `provider-descriptor.schema.json` with
 * storage/retention/continuation pinned to `false` (storage-off contract).
 */
export interface OpenAiCompatProviderDescriptorDocument {
  schemaVersion: number;
  providerId: string;
  providerRevision: string;
  models: OpenAiCompatModelDescriptor[];
  capabilities: {
    streaming: boolean;
    tools: boolean;
    parallelToolCalls: boolean;
    cancellation: boolean;
    structuredOutput?: boolean;
  };
  remoteState: { storage: false; retention: false; continuation: false };
}

/**
 * Identity parameters distinguishing one OpenAI-compatible gateway from
 * another. Everything else (SSE parsing, tool-call accumulation, the SSRF
 * guard, request/response normalization) is identical across gateways — this
 * is the whole surface a caller needs to vary.
 */
export interface OpenAiCompatIdentity {
  /** Default base URL used when the grant supplies none. */
  readonly defaultBaseUrl: string;
  /** Stable provider revision advertised by `describe()` / `descriptorDocument()`. */
  readonly providerRevision: string;
  /** Provider id advertised by `describe()` / `descriptorDocument()` (e.g. `"ollama"`, `"openrouter"`). */
  readonly providerId: string;
  /** The single model this adapter's `descriptorDocument()` pins. */
  readonly defaultModel: OpenAiCompatModelDescriptor;
  /**
   * Human-readable vendor label used inside error messages (e.g. `"Ollama"`,
   * `"OpenRouter"`). Defaults to `providerId` verbatim when omitted. Kept
   * separate from `providerId` so extracting this engine out of
   * `OllamaProvider` did not change any error message's wording/casing.
   */
  readonly providerLabel?: string;
}

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

/** Merge the gateway's split token counts into a single exact {@link NormalizedUsage}. */
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

/**
 * Classify a non-2xx HTTP response into the neutral error taxonomy.
 *
 * 401 and 429 as the native OpenAI adapter maps them. 403 joins 401 here, where
 * the OpenAI adapter keeps it `invalid_request`: an OAuth-backed gateway answers a
 * rejected token with 403 — x.ai does, `The OAuth2 access token could not be
 * validated.` — and that is a credential problem, not a malformed request. Every
 * 4xx used to be `invalid_request`, so a refused credential and a request with a
 * bad field were the same error, and a rate limit was not retryable.
 */
function classifyHttpError(status: number, headers: Headers): NormalizedError {
  if (status === 401 || status === 403) {
    // A refused credential or account. The same request cannot succeed on retry.
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
  if (status >= 500) {
    return { kind: "unavailable", retryable: retryableFor("unavailable", true), message: "" };
  }
  // 404 (model not found) and any other 4xx are non-retryable invalid requests.
  return { kind: "invalid_request", retryable: retryableFor("invalid_request", false), message: "" };
}

/** Longest server reason kept in an error message. */
const MAX_ERROR_REASON_CHARS = 300;

/** Default first-byte / idle stream deadline (flow 268 T5), overridable via {@link OpenAiCompatProviderDeps}. */
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;

/**
 * Stable providerId stamped on every `reasoning_replay` item this engine
 * emits (flow 268 T12 / AC7), and the ONLY providerId this engine reads back
 * off `NormalizedMessage.reasoning.replay` when building a later request — an
 * item stamped by a different adapter (Anthropic's `thinking_signature`,
 * Gemini's `thought_signature`, …) is ignored rather than guessed at. Shared
 * across every OpenAI-compat identity (DeepSeek, MiniMax, OpenRouter, …)
 * because the replay SHAPE (deepseek `reasoning_content` echo, minimax
 * `reasoning_details`/raw `<think>` content) is a property of the wire
 * protocol this engine speaks, not of any one gateway's identity.
 */
const COMPAT_REPLAY_PROVIDER_ID = "openai-compat";

/** One MiniMax `reasoning_details` item accumulated across streamed fragments. */
interface ReasoningDetailSlot {
  /** Grouping key: `idx:<index>`, `id:<id>`, or `"none"` when the item carries neither. */
  key: string;
  /** Every field from the FIRST fragment holding this key, except `text`. */
  fields: Record<string, unknown>;
  /** `text` concatenated across every fragment sharing this key, in arrival order. */
  text: string;
}

/**
 * Resolve what an assistant {@link NormalizedMessage} sends on a LATER
 * request under `grant.reasoning.replay` (flow 268 T12 / AC7):
 *
 * - `"deepseek"`, request carries tools: an owned `reasoning_content` replay
 *   item becomes the message's `reasoning_content` field — DeepSeek's
 *   thinking mode 400s on a tool-bearing request whose prior assistant turns
 *   omit it. Without tools the field is never added (DeepSeek ignores it
 *   there, and an unconditional echo would just be dead weight on the wire).
 * - `"minimax"`: an owned `raw_content` replay item REPLACES `content`
 *   verbatim (the original `<think>…</think>` text must round-trip
 *   unedited); an owned `reasoning_details` replay item is attached as the
 *   message's `reasoning_details` field. Either, both, or neither may be
 *   present on one message.
 * - `"none"`/absent, or a message with no OWNED replay item (wrong
 *   `providerId`, or none at all): `content` passes through unchanged and no
 *   extra field is added — the pre-replay behavior.
 */
function resolveAssistantReplay(
  message: NormalizedMessage,
  replay: "none" | "deepseek" | "minimax" | undefined,
  requestHasTools: boolean,
): { content: string; extra: Record<string, unknown> } {
  if (replay === undefined || replay === "none") {
    return { content: message.content, extra: {} };
  }
  const owned = (message.reasoning?.replay ?? []).filter((item) => item.providerId === COMPAT_REPLAY_PROVIDER_ID);
  if (replay === "deepseek") {
    const extra: Record<string, unknown> = {};
    if (requestHasTools) {
      const item = owned.find((candidate) => candidate.kind === "reasoning_content");
      if (item !== undefined && typeof item.data === "string" && item.data.length > 0) {
        extra.reasoning_content = item.data;
      }
    }
    return { content: message.content, extra };
  }
  // replay === "minimax"
  let content = message.content;
  const rawContent = owned.find((candidate) => candidate.kind === "raw_content");
  if (rawContent !== undefined && typeof rawContent.data === "string") {
    content = rawContent.data;
  }
  const extra: Record<string, unknown> = {};
  const details = owned.find((candidate) => candidate.kind === "reasoning_details");
  if (details !== undefined) {
    extra.reasoning_details = details.data;
  }
  return { content, extra };
}

/** Sentinel returned by {@link raceReadAgainstDeadline} when the deadline elapses first. */
const READ_TIMED_OUT = Symbol("compat-read-timed-out");

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
 * The server's own reason for a refusal, from the JSON shapes gateways use.
 *
 * Only `error.message` used to be read, so a gateway answering
 * `{"error": "…"}` or `{"message": "…"}` lost its reason and the operator got a
 * bare status. Redacted and bounded because it is upstream text on its way into a
 * transcript. A NON-JSON body is still never surfaced (C-01, shared with the
 * OpenAI and Anthropic adapters): an HTML error page or a proxy banner is not a
 * reason.
 */
function errorReason(bodyText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const raw =
    asString(asRecord(record.error).message) ??
    asString(record.error) ??
    asString(record.message) ??
    asString(record.detail);
  if (raw === undefined) return undefined;
  const flat = redactSensitiveText(raw.replace(/\s+/g, " ").trim());
  if (flat.length === 0) return undefined;
  return flat.length > MAX_ERROR_REASON_CHARS ? `${flat.slice(0, MAX_ERROR_REASON_CHARS)}…` : flat;
}

/**
 * Thin OpenAI-Chat-Completions-compatible {@link ProviderPort}. Constructed
 * with an injected `fetch`, an optional explicit capability `grant`, and an
 * {@link OpenAiCompatIdentity} pinning the vendor identity; `stream()`
 * performs one guarded, storage-off attempt and normalizes its SSE into the
 * documented `NormalizedEvent` sequence. Identical logic serves any
 * OpenAI-Chat-Completions-compatible gateway (Ollama, OpenRouter, DeepSeek,
 * Z.AI, Cerebras, Groq, Moonshot, Grok, …) — only `identity` differs.
 */
export class OpenAiCompatEngine implements ProviderPort {
  private readonly deps: OpenAiCompatProviderDeps;
  private readonly identity: OpenAiCompatIdentity;

  constructor(deps: OpenAiCompatProviderDeps, identity: OpenAiCompatIdentity) {
    this.deps = deps;
    this.identity = identity;
  }

  /** The human-readable vendor label used in error messages (see {@link OpenAiCompatIdentity.providerLabel}). */
  private get label(): string {
    return this.identity.providerLabel ?? this.identity.providerId;
  }

  describe(): ProviderDescription {
    const capabilities: ProviderCapabilities = {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      structuredOutput: false,
      // Trivially correct from instance state alone (AC of flow 268 T10):
      // `true` exactly when the grant carries an explicit `reasoning`
      // configuration, `false` otherwise (the pre-existing default — every
      // OTHER compat provider keeps advertising `false` even though
      // `reasoning`/`reasoning_content` parsing itself is unconditional; that
      // wider claim is not "trivially correct" from `describe()` alone and is
      // left alone here).
      reasoningMetadata: this.deps.grant?.reasoning !== undefined,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    };
    return {
      capabilities,
      descriptor: { providerId: this.identity.providerId, providerRevision: this.identity.providerRevision },
    };
  }

  descriptorDocument(): OpenAiCompatProviderDescriptorDocument {
    return {
      schemaVersion: 1,
      providerId: this.identity.providerId,
      providerRevision: this.identity.providerRevision,
      models: [{ modelId: this.identity.defaultModel.modelId, revision: this.identity.defaultModel.revision }],
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
        message: `a network capability grant is required to reach the ${this.label} API`,
      });
      return;
    }

    const baseUrl = grant.baseUrl ?? this.identity.defaultBaseUrl;

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
    const permitted =
    !isPrivateEgressHost(host) ||
    (grant.allowLoopback === true && isLoopbackHost(host)) ||
    (grant.allowPrivateLan === true && isPrivateLanHost(host));
    if (!permitted) {
      yield errorEvent({
        kind: "invalid_request",
        retryable: retryableFor("invalid_request", false),
        message: `egress to a private/loopback/link-local/metadata host is denied: ${host}`,
      });
      return;
    }

    const url = `${baseUrl.replace(/\/+$/, "")}${grant.chatPath ?? "/v1/chat/completions"}`;
    // DeepSeek's thinking-mode `reasoning_content` echo (flow 268 T12 / AC7)
    // only applies "when the request carries tools" (protocol fact) — an
    // empty/absent `tools` array is "no tools" for this purpose.
    const requestHasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const messages: Array<Record<string, unknown>> = [];
    if (request.systemInstruction.length > 0) {
      messages.push({ role: "system", content: request.systemInstruction });
    }
    // OpenAI/OpenRouter require a `role:"tool"` message to carry a
    // `tool_call_id` referencing a preceding assistant `tool_calls`, and require
    // every declared call to be answered. `linkToolCalls` reports which pairs
    // actually hold together inside THIS request; a half-pair (compaction cut a
    // window, a resumed transcript starts mid-turn, a batch was abandoned) keeps
    // the framed `user` degradation this adapter has always used, so the request
    // stays valid instead of being rejected for a dangling link.
    for (const linked of linkToolCalls(request.messages)) {
      const message = linked.message;
      if (message.role === "tool") {
        if (linked.linkedToolCallId !== undefined) {
          messages.push({ role: "tool", tool_call_id: linked.linkedToolCallId, content: message.content });
          continue;
        }
        messages.push({ role: "user", content: `Tool result:\n${message.content}` });
        continue;
      }
      if (message.role === "assistant" && message.content.length === 0 && linked.linkedCalls.length === 0) {
        // A tool-call turn whose calls could not be linked (the batch was
        // abandoned, or compaction cut the results away) carries no text and no
        // calls — an empty assistant message that says nothing. Dropping it
        // keeps the request identical to what it was before tool linking.
        continue;
      }
      if (message.role === "assistant" && linked.linkedCalls.length > 0) {
        const { content, extra } = resolveAssistantReplay(message, grant.reasoning?.replay, requestHasTools);
        messages.push({
          role: "assistant",
          content,
          tool_calls: linked.linkedCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
          ...extra,
        });
        continue;
      }
      if (message.role === "assistant") {
        const { content, extra } = resolveAssistantReplay(message, grant.reasoning?.replay, requestHasTools);
        messages.push({ role: "assistant", content, ...extra });
        continue;
      }
      messages.push({ role: message.role, content: message.content });
    }
    const payload: Record<string, unknown> = {
      model: request.modelId,
      stream: true,
      // Output token limit (flow 268 T6): `max_tokens` is the widely-supported
      // default across OpenAI-compat gateways (Ollama, OpenRouter, DeepSeek,
      // Z.AI, Cerebras, Groq, Moonshot, Grok, vLLM). Some gateways (MiniMax)
      // also accept `max_completion_tokens`, but no provider-specific switching
      // is done here — a later task adds per-provider `requestParams` overrides.
      max_tokens: request.budget.maxOutputTokens,
      // See `OpenAiCompatCapabilityGrant.streamUsage`: without this the stream
      // reports no token usage whatsoever.
      ...(this.deps.grant?.streamUsage === true ? { stream_options: { include_usage: true } } : {}),
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
    // Custom-provider `reasoning.requestParams` (AC5), shallow-merged AFTER
    // every base field above. `model`/`messages`/`stream`/`tools` are the
    // fields the request's own shape and tool wiring depend on — silently
    // dropped from the merge rather than allowed to override them. Every
    // other key (e.g. MiniMax's `reasoning_split`, or an override of
    // `max_tokens`) passes through.
    const requestParams = grant.reasoning?.requestParams;
    if (requestParams !== undefined) {
      for (const [key, value] of Object.entries(requestParams)) {
        if (key === "model" || key === "messages" || key === "stream" || key === "tools") continue;
        payload[key] = value;
      }
    }
    // Base headers are unchanged for local ollama; an authenticated gateway
    // (OpenRouter) adds a bearer credential + any caller-supplied extra headers.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (grant.apiKey !== undefined && grant.apiKey.length > 0) {
      headers.authorization = `Bearer ${grant.apiKey}`;
    }
    if (grant.headers !== undefined) {
      Object.assign(headers, grant.headers);
    }
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
        message: `network request to the ${this.label} API failed: ${String(cause)}`,
      });
      return;
    }

    // Provider negatives: non-2xx -> typed, fail-closed error, no model_end.
    if (!response.ok) {
      const error = classifyHttpError(response.status, response.headers);
      let reason: string | undefined;
      try {
        reason = errorReason(await response.text());
      } catch {
        // An unreadable body has no reason to give; the status still stands.
      }
      // The status stays in the message even when the server gave a reason: a
      // reason alone ("balance exhausted") does not say which provider or which
      // class of failure, and the label is what names the gateway.
      error.message = `${this.label} API returned HTTP ${response.status}${reason === undefined ? "" : `: ${reason}`}`;
      yield stamp({ kind: "provider_error", error });
      return;
    }

    // Streaming body read (flow 268 T5): the SSE body is read INCREMENTALLY
    // via `response.body.getReader()`, not buffered whole with
    // `response.text()` — each record the parser completes is normalized and
    // yielded immediately, so a caller observes `text_delta` while the model
    // is still generating rather than only once the connection closes. Two
    // independent deadlines guard a stalled connection: `firstByteTimeoutMs`
    // (no byte at all since the response headers arrived) and
    // `idleTimeoutMs` (no further chunk since the last one) — both default to
    // 120s, configurable via `deps`. A timeout cancels the reader and yields
    // exactly one retryable `unavailable` provider_error, never a model_end.
    // An abort mid-read still fails closed to the SAME terminal `cancelled`
    // error the fetch()-level abort path yields (flow-019 contract).
    if (response.body === null) {
      yield errorEvent({
        kind: "malformed",
        retryable: retryableFor("malformed", false),
        message: "empty response body",
      });
      return;
    }

    const firstByteTimeoutMs = this.deps.firstByteTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const idleTimeoutMs = this.deps.idleTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new AnthropicSSEParser();
    // Inline `<think>…</think>` reasoning (AC4): only constructed — and only
    // ever fed `delta.content` — when the grant asks for it. Every other
    // format leaves `delta.content` passing straight through as `text_delta`,
    // unchanged from before this task.
    const thinkTagParser = grant.reasoning?.format === "inline-tags" ? new ThinkTagParser() : undefined;
    const pushThinkSegments = (segments: ReturnType<ThinkTagParser["push"]>): void => {
      for (const segment of segments) {
        if (segment.text.length === 0) continue;
        bodies.push(
          segment.kind === "reasoning" ? { kind: "reasoning_delta", text: segment.text } : { kind: "text_delta", text: segment.text },
        );
      }
    };
    // Flushed on every NORMAL termination path (`[DONE]`, a natural
    // finish/EOF) — never on abort/timeout, which discard in-flight parser
    // state instead of trying to salvage it from a connection that failed.
    const flushThinkTagParser = (): void => {
      if (thinkTagParser === undefined) return;
      pushThinkSegments(thinkTagParser.flush());
    };

    // Compat replay accumulation (flow 268 T12 / AC7): populated ONLY for the
    // mode that needs it, across the whole round, and reported ONCE via
    // `emitReplayEvents()` at the same normal-termination points
    // `flushThinkTagParser()` is called — never on abort/timeout/error paths.
    const replayMode = grant.reasoning?.replay;
    let reasoningFieldRaw = ""; // deepseek: raw `reasoning`/`reasoning_content` delta text, concatenated verbatim.
    let rawContentRaw = ""; // minimax: raw `delta.content`, concatenated verbatim, BEFORE any think-tag parsing.
    const reasoningDetailSlots: ReasoningDetailSlot[] = []; // minimax split: merged `reasoning_details` fragments, first-seen order.
    const reasoningDetailSlotIndex = new Map<string, number>();
    /**
     * Merge one streamed `reasoning_details` item into its slot: grouped by
     * `index` (preferred, stable across fragments), then `id`, else the
     * single `"none"` slot shared by every index/id-less item — mirrors the
     * tool-call accumulator's key precedence above.
     */
    const accumulateReasoningDetail = (item: Record<string, unknown>): void => {
      const index = asNumber(item.index);
      const id = asString(item.id);
      const key = index !== undefined ? `idx:${index}` : id !== undefined && id.length > 0 ? `id:${id}` : "none";
      let slotIndex = reasoningDetailSlotIndex.get(key);
      if (slotIndex === undefined) {
        const { text: _text, ...fields } = item;
        slotIndex = reasoningDetailSlots.length;
        reasoningDetailSlots.push({ key, fields, text: "" });
        reasoningDetailSlotIndex.set(key, slotIndex);
      }
      const slot = reasoningDetailSlots[slotIndex];
      if (slot !== undefined) {
        slot.text += asString(item.text) ?? "";
      }
    };
    /**
     * Emit this round's replay payload(s) once, at a NORMAL termination
     * point. `"deepseek"` emits `reasoning_content` when the round produced
     * field reasoning text; `"minimax"` prefers merged `reasoning_details`
     * (split mode) and otherwise falls back to `raw_content` when the raw
     * stream carried inline `<think>` tags (or the engine was explicitly
     * configured to parse them via `format: "inline-tags"`).
     */
    const emitReplayEvents = (): void => {
      if (replayMode === "deepseek") {
        if (reasoningFieldRaw.length > 0) {
          bodies.push({
            kind: "reasoning_replay",
            replay: { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "reasoning_content", data: reasoningFieldRaw },
          });
        }
        return;
      }
      if (replayMode === "minimax") {
        if (reasoningDetailSlots.length > 0) {
          const data = reasoningDetailSlots.map((slot) => ({ ...slot.fields, text: slot.text }));
          bodies.push({
            kind: "reasoning_replay",
            replay: { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "reasoning_details", data },
          });
          return;
        }
        if (rawContentRaw.length > 0 && (thinkTagParser !== undefined || rawContentRaw.includes("<think>"))) {
          bodies.push({
            kind: "reasoning_replay",
            replay: { providerId: COMPAT_REPLAY_PROVIDER_ID, kind: "raw_content", data: rawContentRaw },
          });
        }
      }
    };

    const cancelReader = (): void => {
      // Best-effort cleanup: the socket may already be closed/errored, and a
      // cancel() rejection here is never a second failure mode.
      reader.cancel().catch(() => undefined);
    };

    const bodies: EventBody[] = [];
    let sawStart = false;
    let sawFinish = false;
    let receivedAnyChunk = false;
    let malformed: NormalizedError | undefined;

    // OpenAI-compat streams tool calls across chunks: first delta often has
    // `name` + empty/partial `arguments`, later deltas APPEND argument fragments.
    // We must ACCUMULATE by index/id and only emit `tool_call_end` on finish
    // (Z.AI / OpenRouter / OpenAI). Emitting end per-chunk produced empty inputs
    // (`Missing required property`) in the interactive agent.
    interface PendingToolCall {
      id: string;
      name: string;
      arguments: string;
      started: boolean;
      ended: boolean;
    }
    const pendingTools = new Map<string, PendingToolCall>();

    // Prefer `index` (stable across streamed fragments). OpenAI/Z.AI only put
    // `id` on the FIRST delta; later deltas have only `index` + argument slices.
    // Keying by id first would split one call into two pending entries.
    const toolCallKey = (toolCall: Record<string, unknown>): string => {
      const index = asNumber(toolCall.index);
      if (index !== undefined) {
        return `idx:${index}`;
      }
      const id = asString(toolCall.id);
      if (id !== undefined && id.length > 0) {
        return `id:${id}`;
      }
      return "idx:0";
    };

    const flushPendingToolEnds = (): void => {
      for (const acc of pendingTools.values()) {
        if (acc.ended) {
          continue;
        }
        if (!acc.started) {
          const startBody: EventBody = { kind: "tool_call_start", toolCallId: acc.id };
          if (acc.name.length > 0) {
            startBody.toolName = acc.name;
          }
          bodies.push(startBody);
          acc.started = true;
        }
        bodies.push({ kind: "tool_call_end", toolCallId: acc.id, input: acc.arguments });
        acc.ended = true;
      }
      pendingTools.clear();
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
          message: `${this.label} SSE body read failed: ${String(cause)}`,
        });
        return;
      }

      if (readResult === READ_TIMED_OUT) {
        cancelReader();
        yield errorEvent({
          kind: "unavailable",
          retryable: retryableFor("unavailable", true),
          message: `${this.label} stream timed out waiting for ${
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

      const text = decoder.decode(value, { stream: true });
      for (const record of parser.push(text)) {
        const trimmed = record.data.trim();
        // `data: [DONE]` is the stream terminator, never a model chunk. Stop
        // reading immediately (AC1): a permissive gateway may keep the socket
        // open past `[DONE]`, and this adapter must not wait for it to close.
        if (trimmed === "[DONE]") {
          flushThinkTagParser();
          emitReplayEvents();
          flushPendingToolEnds();
          if (sawStart) {
            bodies.push({ kind: "model_end" });
          }
          const aborted = yield* drainAndCheckAbort(bodies, opts.signal, stamp);
          cancelReader();
          if (aborted) {
            yield errorEvent({ kind: "cancelled", retryable: retryableFor("cancelled", false), message: "attempt cancelled" });
          }
          return;
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
            message: `${this.label} SSE data line was not valid JSON`,
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

        // Reasoning-capable models (OpenRouter, DeepSeek, …) stream chain-of-thought
        // in a separate delta field (`reasoning` or `reasoning_content`) BEFORE the
        // answer content. Surface it as `reasoning_delta`; plain models omit it.
        // Unconditional for every `reasoning.format` (AC5) — this is harmless
        // when the fields are absent, and MiniMax's `reasoning_split: true`
        // request param (via `requestParams`) makes it send exactly this shape.
        const reasoningField = asString(delta.reasoning) ?? asString(delta.reasoning_content);
        if (reasoningField !== undefined && reasoningField.length > 0) {
          bodies.push({ kind: "reasoning_delta", text: reasoningField });
          if (replayMode === "deepseek") {
            reasoningFieldRaw += reasoningField;
          }
        } else {
          // MiniMax's `reasoning_details` (OpenRouter-shaped): an array of
          // `{ text: "…", … }` objects; concatenate every item's `text` in
          // order. Only consulted when `reasoning`/`reasoning_content` is
          // ABSENT for this delta, so a provider that sends both never
          // double-emits the same text.
          const reasoningDetails = asArray(delta.reasoning_details);
          if (reasoningDetails.length > 0) {
            const concatenated = reasoningDetails
              .map((item) => asString(asRecord(item).text))
              .filter((text): text is string => text !== undefined && text.length > 0)
              .join("");
            if (concatenated.length > 0) {
              bodies.push({ kind: "reasoning_delta", text: concatenated });
            }
            if (replayMode === "minimax") {
              for (const item of reasoningDetails) {
                accumulateReasoningDetail(asRecord(item));
              }
            }
          }
        }

        const content = asString(delta.content);
        if (content !== undefined && content.length > 0) {
          if (replayMode === "minimax") {
            rawContentRaw += content;
          }
          if (thinkTagParser !== undefined) {
            // `format: "inline-tags"`: MiniMax's default shape puts reasoning
            // INSIDE `delta.content` as `<think>…</think>` — route it through
            // the parser instead of yielding it as `text_delta` verbatim.
            pushThinkSegments(thinkTagParser.push(content));
          } else {
            bodies.push({ kind: "text_delta", text: content });
          }
        }

        for (const rawToolCall of asArray(delta.tool_calls)) {
          const toolCall = asRecord(rawToolCall);
          const fn = asRecord(toolCall.function);
          const toolCallId = asString(toolCall.id);
          const toolName = asString(fn.name);
          const argumentsFragment = asString(fn.arguments) ?? "";
          const key = toolCallKey(toolCall);

          let acc = pendingTools.get(key);
          if (acc === undefined) {
            acc = {
              id: toolCallId ?? `call_${key.replace(/[^a-zA-Z0-9_:-]/g, "_")}`,
              name: toolName ?? "",
              arguments: "",
              started: false,
              ended: false,
            };
            pendingTools.set(key, acc);
          }
          if (toolCallId !== undefined && toolCallId.length > 0) {
            acc.id = toolCallId;
          }
          if (toolName !== undefined && toolName.length > 0) {
            acc.name = toolName;
          }

          if (!acc.started) {
            const startBody: EventBody = { kind: "tool_call_start", toolCallId: acc.id };
            if (acc.name.length > 0) {
              startBody.toolName = acc.name;
            }
            bodies.push(startBody);
            acc.started = true;
          }

          // Fragments append (OpenAI/Z.AI streaming). One-shot providers (Ollama)
          // send the whole JSON in a single fragment — still correct as append.
          if (argumentsFragment.length > 0) {
            acc.arguments += argumentsFragment;
            bodies.push({
              kind: "tool_call_delta",
              toolCallId: acc.id,
              inputDelta: argumentsFragment,
            });
          }
        }

        // `finish_reason` marks completion: flush accumulated tool calls so
        // `tool_call_end.input` is the FULL concatenated arguments JSON.
        // Trailing usage/`[DONE]` still follow on the wire (handled above/below).
        const finishReason = asString(choice0.finish_reason);
        if (finishReason !== undefined && finishReason.length > 0) {
          sawFinish = true;
          flushPendingToolEnds();
        }
      }

      if (malformed !== undefined) {
        cancelReader();
        break readLoop;
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

    // Reached only via a natural EOF (reader signalled `done`) or a malformed
    // record — `[DONE]` always returns from inside the loop above.
    if (malformed === undefined) {
      const trailing = decoder.decode();
      if (trailing.length > 0) {
        parser.push(trailing);
      }
      const torn = parser.flush();
      // A torn trailing record is a truncated/malformed attempt (no model_end).
      if (torn.length > 0) {
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: `${this.label} SSE stream ended mid-record (torn stream)`,
        };
      } else if (!receivedAnyChunk) {
        // A 200 with literally zero bytes never sets `sawStart` and would
        // otherwise yield nothing — fail closed with a terminal `malformed`
        // rather than a silent-success empty iterable.
        malformed = {
          kind: "malformed",
          retryable: retryableFor("malformed", false),
          message: "empty response body",
        };
      } else {
        // Defensive: stream ended without finish_reason but with pending tools.
        flushPendingToolEnds();
        // A clean stream that reached `[DONE]` or a `finish_reason` completes
        // with a terminal `model_end` (emitted after any usage_update). `[DONE]`
        // always exits above, so only the bare-`finish_reason` case reaches
        // here — the (former) `sawDone` flag was always false by the time
        // this ran, since its only assignment sat on the `[DONE]` path,
        // which always returns before reaching this code.
        if (sawStart && sawFinish) {
          flushThinkTagParser();
          emitReplayEvents();
          bodies.push({ kind: "model_end" });
        }
      }
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
