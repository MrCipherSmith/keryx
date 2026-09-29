// Pure extraction of an Intent from the text of one flow or requirements
// package. No filesystem, no clock, no model: the same text always gives the
// same Intent, and a text with nothing to extract gives an Intent with nulls,
// never a throw.

import { parseAcKinds } from "../flow/ac-kinds";
import type { AcKindRecord } from "../flow/ac-kinds";
import type { Intent, IntentOutcome } from "./types";

export const NO_INSTRUMENT = "not measured — no instrument stated";

const OBSERVATION = /^outcome-observed:[ \t]*(.*)$/m;
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)\b[ \t:,-]*/;
const PLACEHOLDERS = ["Describe the problem precisely", "What must be true when this flow is done"];
const STATEMENT_LIMIT = 300;

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match?.[1]?.length ?? 0;
}

/** Body of the first section whose heading matches, up to the next heading of the same or a higher level. */
export function sectionOf(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => headingLevel(line) > 0 && heading.test(line.replace(/^#{1,6}\s+/, "").trim()));
  if (start === -1) return null;
  const level = headingLevel(lines[start] ?? "");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const next = headingLevel(line);
    if (next > 0 && next <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

function firstSentence(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (PLACEHOLDERS.some((placeholder) => flat.startsWith(placeholder))) return null;
  const sentence = /^(.*?[.!?])(?=\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > STATEMENT_LIMIT ? `${sentence.slice(0, STATEMENT_LIMIT - 1).trimEnd()}…` : sentence;
}

/** The first usable sentence among the named sections, in the order given. */
export function statementFrom(markdown: string, headings: readonly RegExp[]): string | null {
  for (const heading of headings) {
    const body = sectionOf(markdown, heading);
    const sentence = body === null ? null : firstSentence(body);
    if (sentence !== null) return sentence;
  }
  return null;
}

/** Bullets of an `Outcome criteria` section, each continuation line folded into its bullet. */
export function outcomeCriterionFrom(markdown: string): string | null {
  const body = sectionOf(markdown, /^outcome criteri(?:a|on)$/i);
  if (body === null) return null;
  const bullets: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) bullets.push((bullet[1] ?? "").trim());
    else if (line.trim().length > 0 && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const usable = bullets.filter((bullet) => bullet.length > 0);
  return usable.length === 0 ? null : usable.join(" | ");
}

/** True when a criterion names something that can be looked at; a `not measured` line admits there is nothing. */
export function hasInstrument(criterion: string | null): criterion is string {
  return criterion !== null && !/^`?not measured/i.test(criterion);
}

export function observationFrom(journal: string | null): Pick<IntentOutcome, "observed" | "observedAt" | "note"> {
  const match = journal === null ? null : OBSERVATION.exec(journal.replace(/\r\n/g, "\n"));
  if (match === null) return { observed: false, observedAt: null, note: null };
  const text = (match[1] ?? "").trim();
  const date = LEADING_DATE.exec(text)?.[1] ?? null;
  return { observed: true, observedAt: date, note: text.length === 0 ? null : text };
}

function criteriaFrom(markdown: string | null): AcKindRecord[] {
  return markdown === null ? [] : parseAcKinds(markdown).criteria.map((criterion) => criterion.record);
}

export interface FlowSource {
  readonly flowJson: string;
  readonly description: string | null;
  readonly criteria: string | null;
  readonly journal: string | null;
}

interface FlowJsonShape {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  merged?: { at?: unknown } | null;
  history?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function closedAtOf(flow: FlowJsonShape): string | null {
  const history = Array.isArray(flow.history) ? (flow.history as Array<{ event?: unknown; at?: unknown }>) : [];
  const done = history.filter((entry) => entry?.event === "done" && text(entry.at) !== null).at(-1);
  return text(done?.at) ?? text(flow.merged?.at) ?? text(flow.updatedAt);
}

/** Throws on a flow.json that is not a JSON object; the caller counts that as a failure. */
export function extractFlowIntent(source: FlowSource, repoPath: string): Intent {
  const parsed: unknown = JSON.parse(source.flowJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("flow.json is not an object");
  const flow = parsed as FlowJsonShape;
  const description = source.description ?? "";
  const status = text(flow.status);
  const closed = status === "done";
  const title = text(flow.title) ?? /^#\s+(.+)$/m.exec(description)?.[1]?.trim() ?? repoPath.split("/").at(-1) ?? repoPath;
  const criterion = outcomeCriterionFrom(description) ?? outcomeCriterionFrom(source.criteria ?? "");
  return {
    id: text(flow.id) ?? repoPath.split("/").at(-1)?.slice(0, 3) ?? repoPath,
    source: "flow",
    path: repoPath,
    title,
    statement: statementFrom(description, [/^problem$/i, /^expected outcome$/i]),
    criteria: criteriaFrom(source.criteria),
    status: closed ? "closed" : "open",
    flowStatus: status,
    closedAt: closed ? closedAtOf(flow) : null,
    outcome: { criterion, ...observationFrom(source.journal) },
  };
}

export interface DocpackSource {
  readonly name: string;
  /** The package's primary document (PRD, TRD or README), when it has one. */
  readonly primary: string | null;
  readonly specification: string | null;
}

export function extractDocpackIntent(source: DocpackSource, repoPath: string): Intent {
  const primary = source.primary ?? "";
  const title = /^#\s+(.+)$/m.exec(primary)?.[1]?.trim() ?? source.name;
  const criteria = criteriaFrom(source.specification);
  return {
    id: source.name,
    source: "docpack",
    path: repoPath,
    title,
    statement: statementFrom(primary, [/^problem$/i, /^goal$/i, /^desired outcome$/i, /^problem and outcome$/i]),
    criteria: criteria.length > 0 ? criteria : criteriaFrom(source.primary),
    status: "open",
    flowStatus: null,
    closedAt: null,
    outcome: { criterion: outcomeCriterionFrom(primary), observed: false, observedAt: null, note: null },
  };
}
