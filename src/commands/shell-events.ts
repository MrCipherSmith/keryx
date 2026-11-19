// A machine-readable transcript of a `keryx shell` agent session.
//
// keryx could not say what a turn consumed. Usage was tracked and shown in the
// TUI, and `runAgentTurn` returns only a finish reason, so nothing outside the
// terminal could read what a session cost or what it did. That gap is why an
// August comparison of keryx against other agent CLIs could report wall-clock
// seconds and nothing else.
//
// This writes the events beside the human output rather than instead of it. The
// rendered session is unchanged, which matters more than it sounds: a headless
// mode that renders differently is a different code path, and then the thing
// measured is not the thing people run.

import { randomUUID } from "node:crypto";
import type { ReviewerActivityEvent } from "../harness/tool/builtin/reviewer-activity";
import type { NormalizedUsage, ProviderPort } from "../harness/provider/types";
import type { ReviewUsageCounts } from "../review/run-usage";
import { estimateTurnCostUsd } from "../harness/routing/turn-cost";
import { appendFileSync } from "node:fs";
// Through the security facade, not `security/redact`: reaching past a facade
// reaches everything behind it, and the import policy counts that as a bypass
// against a ceiling that is a ratchet.
import { redactSensitiveText } from "../security/service";

/** Provider-reported usage, in the shape `NormalizedUsage` already carries. */
export type ShellEventUsage = NormalizedUsage;
export type RequestOwner = { participant: "coordinator" } | { participant: "reviewer"; reviewer: string; sessionId?: string };
type RequestIdentity = RequestOwner & { provider: string; model?: string; requestId: string; source?: "external-runtime"; partial?: boolean };

export type ShellEvent =
  | ReviewerActivityEvent
  | ({ type: "request_start" } & RequestIdentity)
  | ({ type: "request_usage"; usage: ReviewUsageCounts } & RequestIdentity)
  | { readonly type: "turn_start"; readonly prompt: string; readonly provider: string; readonly model: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "tool_call"; readonly name: string; readonly input: string }
  | { readonly type: "tool_result"; readonly name: string; readonly isError: boolean; readonly output: string }
  | { readonly type: "usage"; readonly usage: ShellEventUsage }
  | {
      readonly type: "turn_end";
      readonly text: string;
      readonly toolCalls: number;
      readonly usage?: ShellEventUsage;
      readonly errorMessage?: string;
    };

export interface ShellEventSink {
  emit(event: ShellEvent): void;
}

/**
 * The per-field cap on emitted text.
 *
 * A tool result can be a whole file. The consumer of this stream wants to know
 * WHICH tool ran and whether a given path passed through it, not to hold a copy
 * of the repository — and an unbounded sink turns a fifty-task sweep into
 * gigabytes. Truncation is marked in the value rather than silent, because a
 * clipped string that looks whole is the same defect class as a failed search
 * that reports success.
 */
export const FIELD_LIMIT = 4000;

export function clip(value: string, limit: number = FIELD_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[+${value.length - limit} chars]`;
}

/**
 * Serialize one event as a single NDJSON line.
 *
 * Every string field goes through the redaction floor first. This file records
 * tool inputs and outputs — shell commands, file contents, environment — and
 * this programme has already had one credential reach an artifact in the clear
 * because a producer skipped this step. Redaction happens BEFORE clipping, so a
 * secret cannot survive by sitting past the cut.
 */
export function serializeShellEvent(event: ShellEvent, fieldLimit: number = FIELD_LIMIT): string {
  const safe = (value: string): string => clip(redactSensitiveText(value), fieldLimit);
  let redacted: ShellEvent;
  switch (event.type) {
    case "reviewer_activity":
      redacted = { ...event, reviewer: safe(event.reviewer) };
      break;
    case "request_start":
    case "request_usage":
      redacted = { ...event, ...(event.model ? { model: safe(event.model) } : {}), provider: safe(event.provider),
        ...(event.participant === "reviewer" ? { reviewer: safe(event.reviewer) } : {}) };
      break;
    case "turn_start":
      redacted = { ...event, prompt: safe(event.prompt) };
      break;
    case "assistant":
      redacted = { ...event, text: safe(event.text) };
      break;
    case "tool_call":
      redacted = { ...event, input: safe(event.input) };
      break;
    case "tool_result":
      redacted = { ...event, output: safe(event.output) };
      break;
    case "turn_end":
      redacted = {
        ...event,
        text: safe(event.text),
        ...(event.errorMessage === undefined ? {} : { errorMessage: safe(event.errorMessage) }),
      };
      break;
    default:
      redacted = event;
  }
  return `${JSON.stringify(redacted)}\n`;
}

/**
 * Append events to a file, one JSON object per line.
 *
 * Appended as they happen rather than buffered to the end: a session killed
 * mid-turn should leave the events it already produced, for the same reason the
 * sweep writes each task's results before starting the next one.
 *
 * A write failure never takes the session down. The events file is an
 * observation of a session, and losing the observation is not a reason to lose
 * the work — but it is not silent either: the first failure is reported through
 * `onError` so a caller reading an empty file knows why it is empty.
 */
export function createFileEventSink(
  filePath: string,
  onError?: (message: string) => void,
  fieldLimit: number = FIELD_LIMIT,
): ShellEventSink {
  let broken = false;
  return {
    emit(event) {
      if (broken) return;
      try {
        appendFileSync(filePath, serializeShellEvent(event, fieldLimit), "utf8");
      } catch (error) {
        broken = true;
        onError?.(
          `[events] cannot write ${filePath}: ${error instanceof Error ? error.message : String(error)} — ` +
            "no further events will be recorded for this session",
        );
      }
    },
  };
}

/** Instrument the actual stream (including retries). An interrupted request leaves a start without a receipt. */
export function observeReviewProvider(port: ProviderPort, sink: ShellEventSink, owner: RequestOwner,
  provider: string, model: string, userConfigDir: string): ProviderPort {
  return {
    describe: () => port.describe(),
    async *stream(request, opts) {
      const identity = { ...owner, provider, model, requestId: randomUUID() };
      sink.emit({ type: "request_start", ...identity });
      for await (const event of port.stream(request, opts)) {
        if (event.kind === "usage_update" && event.usage !== undefined) {
          const u = event.usage;
          // A Codex subscription does not bill its account at an API model's token price.
          const usd = provider !== "openai-codex" && !u.cost && u.inputTokens !== undefined && u.outputTokens !== undefined
            ? estimateTurnCostUsd({ providerId: provider, modelId: model, userConfigDir, ...u, inputTokens: u.inputTokens, outputTokens: u.outputTokens })
            : undefined;
          sink.emit({ type: "request_usage", ...identity, usage: { ...u,
            ...(usd !== undefined && Number.isFinite(usd) && usd >= 0 ? { estimatedCost: { amount: usd, currency: "USD" } } : {}) } });
        }
        yield event;
      }
    },
  };
}

/** External hosts return one receipt per dispatch. A throw or missing receipt leaves the request partial. */
export function observeExternalReview(sink: ShellEventSink, reviewer: string, provider: string, model?: string) {
  const identity = { participant: "reviewer" as const, reviewer, source: "external-runtime" as const,
    requestId: randomUUID(), provider, ...(model ? { model } : {}) };
  sink.emit({ type: "request_start", ...identity });
  return (usage?: ReviewUsageCounts & { partial?: boolean }) => {
    if (usage) sink.emit({ type: "request_usage", ...identity, ...(usage.partial ? { partial: true } : {}), usage });
  };
}
