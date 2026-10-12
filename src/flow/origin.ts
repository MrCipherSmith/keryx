// Where a flow came from: a human's request, or an agent's own finding or proposal.
//
// `flow.json` carries `origin` as an optional `{kind, quote?, source?}`. Absent
// reads `unknown`, and reading never rewrites a file. The kind is recorded by
// evidence, not by assertion: `human-request` needs a verbatim quote of the
// human's first message with the idea AND a source (channel, message id or
// time); `agent-finding` and `agent-proposal` need a source. Evidence that is
// missing leaves the origin `unknown` with a printed reason. Nothing gates on
// the origin: it labels a sample, it never blocks `init`, `freeze`, `complete`
// or a product command, and an invalid kind is reported and ignored.
//
// `outcomeAuthor` stays (G1a is read on it) but is secondary: the agent is
// always the one who typed the criterion, so a recorded origin derives
// `agent` unless `outcomeAuthor` was set explicitly, and an explicit value is
// never overwritten.

import { readOutcomeAuthor, type OutcomeAuthorReading } from "./outcome-author";

export const ORIGIN_KINDS = ["human-request", "agent-finding", "agent-proposal"] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/** What a reader prints for a flow: a recorded kind, or `unknown` when the field is absent or unusable. */
export type OriginReading = OriginKind | "unknown";

/** Every reading a reader can print, in the order they are listed: the three kinds, then `unknown`. */
export const ORIGIN_READINGS: readonly OriginReading[] = [...ORIGIN_KINDS, "unknown"];

export interface FlowOrigin {
  kind: OriginKind;
  /** The human's request, verbatim. Stored byte for byte. */
  quote?: string | undefined;
  /** Where the request or finding came from: channel, message id, time, check name. */
  source?: string | undefined;
}

export function isOriginKind(value: unknown): value is OriginKind {
  return typeof value === "string" && (ORIGIN_KINDS as readonly string[]).includes(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The origin of a raw `origin` value, or `undefined` when it is absent,
 * malformed or carries an unknown kind. Never throws: a reader never fails on a
 * file it did not write.
 */
export function readOrigin(value: unknown): FlowOrigin | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isOriginKind(raw.kind)) return undefined;
  const origin: FlowOrigin = { kind: raw.kind };
  if (typeof raw.quote === "string" && raw.quote.length > 0) origin.quote = raw.quote;
  if (typeof raw.source === "string" && raw.source.length > 0) origin.source = raw.source;
  return origin;
}

export function readOriginKind(value: unknown): OriginReading {
  return readOrigin(value)?.kind ?? "unknown";
}

export interface OriginResolution {
  /** The origin to record, or undefined when the evidence is not enough. */
  origin?: FlowOrigin | undefined;
  /** Why no origin was recorded. Set exactly when `origin` is undefined and a kind was asked for. */
  note?: string | undefined;
}

/**
 * Evidence rule. `human-request` needs a quote and a source; `agent-finding`
 * and `agent-proposal` need a source (a quote is optional). Otherwise nothing
 * is recorded and the note says what is missing. An invalid kind is also a
 * note, never an exception.
 */
export function resolveOrigin(input: {
  kind: string;
  quote?: string | undefined;
  source?: string | undefined;
}): OriginResolution {
  if (!isOriginKind(input.kind)) {
    return {
      note: `origin kind "${input.kind}" is not one of: ${ORIGIN_KINDS.join(", ")}; origin stays unknown.`,
    };
  }
  const hasQuote = nonBlank(input.quote);
  const hasSource = nonBlank(input.source);
  if (input.kind === "human-request") {
    if (!hasQuote && !hasSource) {
      return { note: "origin human-request needs a verbatim --quote and a --source; neither was given, origin stays unknown." };
    }
    if (!hasQuote) {
      return { note: "origin human-request needs a verbatim --quote of the human's first message; none was given, origin stays unknown." };
    }
    if (!hasSource) {
      return { note: "origin human-request needs a --source (channel, message id or time); none was given, origin stays unknown." };
    }
  } else if (!hasSource) {
    return { note: `origin ${input.kind} needs a --source (the check, review or test that produced it); none was given, origin stays unknown.` };
  }
  const origin: FlowOrigin = { kind: input.kind };
  if (hasQuote) origin.quote = input.quote;
  if (hasSource) origin.source = input.source;
  return { origin };
}

/**
 * The outcome author a reader shows. An explicit valid `outcomeAuthor` always
 * wins. Without one, a recorded origin derives `agent`: the agent types the
 * criterion whoever had the idea, which is what the origin now says. With
 * neither the reading is `unknown`.
 */
export function effectiveOutcomeAuthor(flow: { outcomeAuthor?: unknown; origin?: unknown }): OutcomeAuthorReading {
  const explicit = readOutcomeAuthor(flow.outcomeAuthor);
  if (explicit !== "unknown") return explicit;
  return readOrigin(flow.origin) === undefined ? "unknown" : "agent";
}

/** One line for status and journal output: `kind`, then the quote and source when present. */
export function originSummary(origin: FlowOrigin | undefined): string {
  if (origin === undefined) return "unknown";
  const parts: string[] = [origin.kind];
  if (origin.quote !== undefined) parts.push(`quote: ${JSON.stringify(origin.quote)}`);
  if (origin.source !== undefined) parts.push(`source: ${origin.source}`);
  return parts.join("; ");
}

/**
 * The lines every surface prints for an origin: `origin: <kind>`, then the
 * verbatim quote (a multi-line quote keeps its line breaks, indented) and the
 * source. No origin reads `origin: unknown`. `indent` prefixes every line.
 */
export function originDetailLines(
  origin: { kind: string; quote?: string | undefined; source?: string | undefined } | undefined,
  indent = "",
): string[] {
  if (origin === undefined) return [`${indent}origin: unknown`];
  const lines = [`${indent}origin: ${origin.kind}`];
  if (origin.quote !== undefined) {
    const [first = "", ...rest] = origin.quote.split("\n");
    lines.push(`${indent}  quote:  «${first}`, ...rest.map((line) => `${indent}          ${line}`));
    lines[lines.length - 1] += "»";
  }
  if (origin.source !== undefined) lines.push(`${indent}  source: ${origin.source}`);
  return lines;
}

// --- Outcome criteria template lines ---------------------------------------

export const REQUEST_LABEL = "Запрос (дословно)";
export const SOURCE_LABEL = "Источник";
export const FORMALIZATION_LABEL = "Эффект (формализация агента)";
export const OBSERVE_LABEL = "Как наблюдать (предложение агента)";

export const REQUEST_PLACEHOLDER = "<the human's request, verbatim, no translation or paraphrase>";
export const SOURCE_PLACEHOLDER = "<where the finding or proposal came from: check, review, test or discussion>";
export const FORMALIZATION_PLACEHOLDER = "<the effect that has to be true when this flow is done, in your own words>";
export const OBSERVE_PLACEHOLDER = "<how the effect can be observed once the flow is done>";

/** The bullet lines that hold a placeholder instead of content, so intent extraction can skip them. */
export const ORIGIN_PLACEHOLDER_BULLETS: readonly string[] = [
  `- ${REQUEST_LABEL}: ${REQUEST_PLACEHOLDER}`,
  `- ${SOURCE_LABEL}: ${SOURCE_PLACEHOLDER}`,
  `- ${FORMALIZATION_LABEL}: ${FORMALIZATION_PLACEHOLDER}`,
  `- ${OBSERVE_LABEL}: ${OBSERVE_PLACEHOLDER}`,
];

/**
 * The three lines of the Outcome criteria section for a recorded origin: the
 * verbatim request (or, for an agent kind, the source), the agent's
 * formalization and the agent's proposal for how to observe it. A quote spans
 * several lines as 4-space-indented continuation lines so the bullet stays one
 * list item and the original text survives.
 */
export function renderOriginBullets(origin: FlowOrigin): string[] {
  const first: string[] = [];
  if (origin.kind === "human-request") {
    first.push(...bulletWithText(REQUEST_LABEL, origin.quote === undefined ? undefined : `«${origin.quote}»`, REQUEST_PLACEHOLDER));
    if (origin.source !== undefined) first[first.length - 1] += ` (source: ${origin.source})`;
  } else {
    first.push(...bulletWithText(SOURCE_LABEL, origin.source, SOURCE_PLACEHOLDER));
    if (origin.quote !== undefined) first.push(...bulletWithText(REQUEST_LABEL, `«${origin.quote}»`, REQUEST_PLACEHOLDER));
  }
  return [
    ...first,
    `- ${FORMALIZATION_LABEL}: ${FORMALIZATION_PLACEHOLDER}`,
    `- ${OBSERVE_LABEL}: ${OBSERVE_PLACEHOLDER}`,
  ];
}

function bulletWithText(label: string, text: string | undefined, placeholder: string): string[] {
  if (text === undefined) return [`- ${label}: ${placeholder}`];
  const lines = text.split("\n");
  const head = `- ${label}: ${lines[0] ?? ""}`;
  return [head, ...lines.slice(1).map((line) => `    ${line}`)];
}
