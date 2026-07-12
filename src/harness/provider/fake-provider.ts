// FakeProvider — offline, deterministic `ProviderPort` for the Keryx harness
// (flow 008, W6 / F-01).
//
// Replays a committed fake-provider transcript fixture into the exact ordered
// `NormalizedEvent` sequence documented by
// `docs/requirements/keryx-project-agent-harness/provider-protocol.md`
// ("Normalized Events" / "Tool Call Semantics" / "Error Taxonomy") and by the
// flow 008 context ("Raw→normalized mapping (FakeProvider replay)").
//
// Deterministic + offline by construction: selection is a canonical sha256 of
// the request (`node:crypto`), replay is a pure fold over the in-memory
// transcript. No `Date.now`, no `Math.random`, no network, no filesystem
// writes, and no provider SDK — this reuses only the W5 neutral port types.

import { createHash } from "node:crypto";
import { defaultRetryable } from "./provider-port";
import type {
  NormalizedError,
  NormalizedEvent,
  NormalizedRequest,
  NormalizedUsage,
  ProviderDescription,
  ProviderErrorKind,
  ProviderPort,
  StreamOptions,
} from "./types";

/** The raw event kinds a fake-provider transcript can carry (pre-normalization). */
type RawEventKind = "text_delta" | "tool_call" | "finish" | "error";

/** A single raw transcript event as stored on disk. */
interface RawTranscriptEvent {
  sequence: number;
  kind: RawEventKind;
  payload?: Record<string, unknown>;
}

/**
 * An in-memory fake-provider transcript. Mirrors the on-disk fixture shape
 * (`src/harness/provider/fixtures/transcripts/*.json`) validated by
 * `fake-provider-transcript.schema.json`. `requestHash` is the canonical
 * {@link requestHashOf} digest the port keys selection by.
 */
export interface FakeProviderTranscript {
  schemaVersion: number;
  transcriptId: string;
  providerId: "fake-provider";
  providerRevision: string;
  requestHash: string;
  events: RawTranscriptEvent[];
}

/** A normalized event without its per-attempt bookkeeping fields. */
type NormalizedEventBody = Omit<NormalizedEvent, "sequence" | "attemptId">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively sort object keys so the canonical JSON is stable regardless of
 * insertion order. Non-serializable values (functions, `undefined`) are
 * dropped, matching JSON semantics.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined || typeof entry === "function") {
      continue;
    }
    sorted[key] = canonicalize(entry);
  }
  return sorted;
}

/**
 * Deterministic canonical sha256 over a {@link NormalizedRequest}. Stable
 * across key ordering; the fake-provider fixtures are keyed by this digest and
 * {@link FakeProvider.stream} selects a transcript by matching it.
 */
export function requestHashOf(request: NormalizedRequest): string {
  const canonical = JSON.stringify(canonicalize(request));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Flatten a raw `payload.provider` object into namespaced `unknownExtensions`
 * (`provider.<subkey>`), preserving values verbatim. Returns `undefined` when
 * there is no provider extension block to preserve.
 */
function extractUnknownExtensions(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const provider = payload.provider;
  if (!isPlainObject(provider)) {
    return undefined;
  }
  const extensions: Record<string, unknown> = {};
  for (const subkey of Object.keys(provider)) {
    extensions[`provider.${subkey}`] = provider[subkey];
  }
  return extensions;
}

/** Map a raw provider `usage` block to neutral, exact-count {@link NormalizedUsage}. */
function mapUsage(usage: Record<string, unknown>): NormalizedUsage {
  const normalized: NormalizedUsage = { exact: true };
  if (typeof usage.input_tokens === "number") {
    normalized.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    normalized.outputTokens = usage.output_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    normalized.totalTokens = usage.total_tokens;
  }
  return normalized;
}

/**
 * Offline, deterministic {@link ProviderPort}. Constructed with an in-memory
 * transcript list; {@link stream} selects the transcript whose `requestHash`
 * matches {@link requestHashOf}(request) and replays its raw events into the
 * documented `NormalizedEvent` sequence.
 */
export class FakeProvider implements ProviderPort {
  private readonly transcripts: FakeProviderTranscript[];

  constructor(transcripts: FakeProviderTranscript[]) {
    this.transcripts = transcripts;
  }

  describe(): ProviderDescription {
    return {
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: false,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: {
        providerId: "fake-provider",
        ...(this.transcripts[0] !== undefined
          ? { providerRevision: this.transcripts[0].providerRevision }
          : {}),
      },
    };
  }

  async *stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    const hash = requestHashOf(request);
    const transcript = this.transcripts.find((candidate) => candidate.requestHash === hash);
    if (transcript === undefined) {
      throw new Error(`FakeProvider: no transcript matches request hash ${hash}`);
    }

    const { attemptId } = opts;
    let sequence = 0;
    const emit = (body: NormalizedEventBody): NormalizedEvent => ({
      ...body,
      sequence: sequence++,
      attemptId,
    });

    // `model_start` is always prepended at emitted-sequence 0.
    yield emit({ kind: "model_start" });

    for (const raw of transcript.events) {
      const payload = raw.payload ?? {};

      switch (raw.kind) {
        case "text_delta": {
          const body: NormalizedEventBody = { kind: "text_delta" };
          if (typeof payload.text === "string") {
            body.text = payload.text;
          }
          const extensions = extractUnknownExtensions(payload);
          if (extensions !== undefined) {
            body.unknownExtensions = extensions;
          }
          yield emit(body);
          break;
        }

        case "tool_call": {
          const input = payload.input;
          // Malformed: a complete tool call must carry a JSON-object input.
          // A non-object input cannot normalize into a coherent
          // start/end pair, so emit a single typed provider_error preserving
          // the partial trail and stop (the errored attempt never completes).
          if (!isPlainObject(input)) {
            yield emit({
              kind: "provider_error",
              error: {
                kind: "malformed",
                retryable: defaultRetryable("malformed") ?? false,
                message: "Malformed tool_call: 'input' is not a JSON object",
              },
            });
            return;
          }
          const startBody: NormalizedEventBody = { kind: "tool_call_start" };
          const endBody: NormalizedEventBody = { kind: "tool_call_end", input: JSON.stringify(input) };
          if (typeof payload.toolCallId === "string") {
            startBody.toolCallId = payload.toolCallId;
            endBody.toolCallId = payload.toolCallId;
          }
          if (typeof payload.toolName === "string") {
            startBody.toolName = payload.toolName;
          }
          yield emit(startBody);
          yield emit(endBody);
          break;
        }

        case "finish": {
          const usage = payload.usage;
          if (isPlainObject(usage)) {
            yield emit({ kind: "usage_update", usage: mapUsage(usage) });
          }
          const body: NormalizedEventBody = { kind: "model_end" };
          const extensions = extractUnknownExtensions(payload);
          if (extensions !== undefined) {
            body.unknownExtensions = extensions;
          }
          yield emit(body);
          break;
        }

        case "error": {
          const error: NormalizedError = {
            kind: payload.kind as ProviderErrorKind,
            retryable: payload.retryable as boolean,
            message: payload.message as string,
          };
          yield emit({ kind: "provider_error", error });
          return;
        }
      }
    }
  }
}
