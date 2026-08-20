// Pure logic for the output channel (spec.md §2.5, T8). Two concerns live
// here with zero `vscode` import: (a) parsing the SSE wire format the real
// `GET /v1/turns/{id}/events` route emits (`src/lib/serve-server.ts:604`:
// `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`, confirmed by reading the
// route handler directly rather than guessing), and (b) classifying a
// mutating-action result into the `{actor, outcome}` shape `audit-log.ts`'s
// `formatAuditLine` expects. `output-channel.ts` is the thin glue that owns
// the real `vscode.OutputChannel` and does the `fetch`-to-SSE plumbing.

import type { AuditActor, AuditEvent } from "./audit-log";
import type { StreamEvent } from "./turn-events";

/**
 * Parse one `text/event-stream` response body into its `StreamEvent`
 * records, in cursor (`seq`) order. Mirrors the exact wire shape
 * `streamTurnEvents` in `src/lib/serve-server.ts` writes: each event is an
 * `id: <seq>` line, a `data: <json>` line, then a blank line. A record whose
 * `data:` line fails to parse as JSON, or whose parsed value is not a
 * `StreamEvent`-shaped object, is skipped rather than throwing — a single
 * malformed chunk (e.g. one that arrived truncated at a stream boundary)
 * must not lose every event that parsed correctly around it.
 */
export function parseSseBody(body: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  // Records are separated by a blank line; `\r\n\r\n` and `\n\n` both occur
  // depending on transport, so normalise line endings first.
  const normalized = body.replace(/\r\n/g, "\n");
  const records = normalized.split("\n\n");

  for (const record of records) {
    const lines = record.split("\n").filter((line) => line.length > 0);
    const dataLine = lines.find((line) => line.startsWith("data:"));
    if (!dataLine) continue;

    const jsonText = dataLine.slice("data:".length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }

    if (isStreamEvent(parsed)) {
      events.push(parsed);
    }
  }

  return events;
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.turnId === "string" &&
    typeof candidate.seq === "number" &&
    typeof candidate.kind === "string" &&
    typeof candidate.at === "string"
  );
}

/** The highest `seq` seen across a batch of events, for the `Last-Event-ID` resume header. Undefined for an empty batch (nothing to resume from yet). */
export function highestSeq(events: readonly StreamEvent[]): number | undefined {
  return events.reduce<number | undefined>(
    (max, event) => (max === undefined || event.seq > max ? event.seq : max),
    undefined,
  );
}

/** Render one `StreamEvent` as a single human-readable output-channel line. Never multi-line, so one event never masquerades as several audit-log-shaped lines. */
export function formatTurnEventLine(event: StreamEvent): string {
  const base = `[turn ${event.turnId}] #${event.seq} ${event.kind}`;
  if (event.kind === "assistant.delta" && event.text) {
    return `${base}: ${event.text}`;
  }
  if (event.tool?.name) {
    const outcome = event.tool.outcome ? ` (${event.tool.outcome})` : "";
    return `${base}: ${event.tool.name}${outcome}`;
  }
  if (event.resolution) {
    return `${base}: ${event.resolution}`;
  }
  return base;
}

/**
 * Classify the outcome of a mutating CLI invocation into the `{actor,
 * outcome}` shape `formatAuditLine` needs (AC6). Pure so the "what counts as
 * success vs. failure" judgement is unit-testable independent of the
 * `vscode.OutputChannel` glue that calls it exactly once per action.
 */
export function classifyMutatingOutcome(exitCode: number): AuditEvent["outcome"] {
  return exitCode === 0 ? "success" : "failure";
}

/** Build a complete `AuditEvent` (minus the timestamp, added at the call site) for a mutating action. */
export function buildAuditEvent(
  actor: AuditActor,
  action: string,
  exitCode: number,
  detail?: string,
): Omit<AuditEvent, "timestamp"> {
  const outcome = classifyMutatingOutcome(exitCode);
  return detail !== undefined ? { actor, action, outcome, detail } : { actor, action, outcome };
}
