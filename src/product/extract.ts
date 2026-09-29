// Pure extraction of an Intent from the text of one flow or requirements
// package. No filesystem, no clock, no model: the same text always gives the
// same Intent, and a text with nothing to extract gives an Intent with nulls,
// never a throw.

import { parseAcKinds } from "../flow/ac-kinds";
import type { AcKindRecord } from "../flow/ac-kinds";
import { OUTCOME_HINT, fencedLines, flowStatementFrom, proseOutsideFences, sectionOf, statementFrom } from "../flow/description-intent";
import { OUTCOME_VERDICTS } from "./types";
import type { Intent, IntentOutcome, OutcomeVerdict } from "./types";

export { sectionOf, statementFrom };

export const NO_INSTRUMENT = "not measured — no instrument stated";

const OBSERVATION = /^outcome-observed:[ \t]*(.*)$/;
// A verdict needs its note: like `verify: none — <reason>`, a bare verdict is a mistake, not a shorthand.
const VERDICT_LINE = new RegExp(`^(${OUTCOME_VERDICTS.join("|")})[ \\t]*—[ \\t]*(\\S.*?)[ \\t]*$`);
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)\b[ \t:,-]*/;

/** Bullets of an `Outcome criteria` section, each continuation line folded into its bullet. */
export function outcomeCriterionFrom(markdown: string): string | null {
  const body = sectionOf(markdown, /^outcome criteri(?:a|on)$/i);
  if (body === null) return null;
  const bullets: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    // Only the exact template line is skipped: a real bullet that starts with the same words is a criterion.
    if ((bullet?.[1] ?? line).trim() === OUTCOME_HINT) continue;
    if (bullet !== null) bullets.push((bullet[1] ?? "").trim());
    else if (line.trim().length > 0 && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const usable = bullets.filter((bullet) => bullet.length > 0);
  return usable.length === 0 ? null : usable.join(" | ");
}

/** True when a criterion names something that can be looked at; a `not measured` line admits there is nothing. */
export function hasInstrument(criterion: string | null): criterion is string {
  if (criterion === null) return false;
  // Judged per bullet: a `not measured` bullet beside a real one still leaves an instrument.
  return criterion.split(" | ").some((bullet) => !/^`?not measured/i.test(bullet.trim()));
}

type Observation = Pick<IntentOutcome, "observed" | "verdict" | "observedAt" | "note">;

const NOT_OBSERVED: Observation = { observed: false, verdict: null, observedAt: null, note: null };

/** `<verdict> — <note>`, or `null` unless the text is exactly one of the four verdicts, an em dash and a note. */
export function parseVerdict(text: string): { verdict: OutcomeVerdict; note: string } | null {
  const match = VERDICT_LINE.exec(text.trim());
  return match === null ? null : { verdict: match[1] as OutcomeVerdict, note: match[2] ?? "" };
}

function observationOf(text: string | null): Observation {
  const parsed = text === null ? null : parseVerdict(text);
  if (parsed === null) return NOT_OBSERVED;
  return { observed: true, verdict: parsed.verdict, observedAt: LEADING_DATE.exec(parsed.note)?.[1] ?? null, note: parsed.note };
}

/** The text after the first `outcome-observed:` marker at column 0 outside a fenced code block, or `null` when the journal has none. */
function journalObservation(journal: string | null): string | null {
  if (journal === null) return null;
  const lines = journal.split(/\r?\n/);
  const fenced = fencedLines(lines);
  for (const [i, line] of lines.entries()) {
    const match = fenced[i] === true ? null : OBSERVATION.exec(line);
    if (match !== null) return match[1] ?? "";
  }
  return null;
}

/** The first `outcome-observed:` line decides; a malformed one is no observation (`observationProblem` names it). */
export function observationFrom(journal: string | null): Observation {
  return observationOf(journalObservation(journal));
}

const VERDICT_CHOICE = OUTCOME_VERDICTS.join("|");

/** Why the journal's first observation line cannot be read, or `null` when it is fine or absent. */
export function observationProblem(journal: string | null): string | null {
  const text = journalObservation(journal);
  if (text === null || parseVerdict(text) !== null) return null;
  return `outcome-observed line has no recognized verdict (expected \`outcome-observed: <${VERDICT_CHOICE}> — <note>\`)`;
}

/**
 * A requirements package's `## Outcome observations`, read from its README or,
 * without one, its primary document. Each line is `- <verdict> — <note>`; the
 * first non-blank line decides, as the first `outcome-observed:` line does.
 */
function docpackObservationLine(source: DocpackSource): string | null {
  for (const document of [source.readme ?? null, source.primary]) {
    const section = document === null ? null : sectionOf(document, /^outcome observations$/i);
    // Fences and HTML comments are not observations; a section empty after stripping is no observation, not a failure.
    const body = section === null ? null : proseOutsideFences(section);
    const line = body?.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
    if (line !== undefined) return line.trim().replace(/^[-*][ \t]+/, "");
  }
  return null;
}

export function docpackObservationFrom(source: DocpackSource): Observation {
  return observationOf(docpackObservationLine(source));
}

export function docpackObservationProblem(source: DocpackSource): string | null {
  const line = docpackObservationLine(source);
  if (line === null || parseVerdict(line) !== null) return null;
  return `outcome observation has no recognized verdict (expected \`- <${VERDICT_CHOICE}> — <note>\`)`;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.flowJson);
  } catch {
    // Fixed text: a runtime's own parse message differs between Bun and Node and would break byte-identity.
    throw new Error("flow.json is not valid JSON");
  }
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
    statement: flowStatementFrom(description),
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
  /** The package's README.md, when it has one apart from the primary document. */
  readonly readme?: string | null;
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
    outcome: { criterion: outcomeCriterionFrom(primary), ...docpackObservationFrom(source) },
  };
}
