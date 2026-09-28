// Acceptance layer W0: the verification KIND of an acceptance criterion.
//
// A criterion may end in one trailing marker inside its own `- ACn: ...` line,
// so the kind is covered by the same checksum as the wording:
//
//   - AC1: <text> [verify: exec `<command>`]
//   - AC2: <text> [verify: invariant `<command>`]
//   - AC3: <text> [verify: judged]
//   - AC4: <text> [verify: none — <reason>]
//
// A line with no marker is `unclassified`. That is not an error and it is how
// every criterion frozen before this module existed reads. It is NEVER read as
// `none`: `none` is a decision somebody took, `unclassified` is the absence of
// one.
//
// Pure and read-only. No model call, no network, no filesystem, no imports.
// Nothing here gates anything: a kind is reported, never enforced. The kind
// may not refuse a freeze, a confirmation, or a completion (specification,
// AC4) — the only consumer allowed to act on `exec`/`invariant` is a later,
// separately gated workstream (W1), not this file.

export type AcKind = "exec" | "invariant" | "judged" | "none" | "unclassified";

export type AcKindRecord =
  | { readonly kind: "exec" | "invariant"; readonly check: string }
  | { readonly kind: "judged" }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "unclassified" };

export const AC_KINDS: readonly AcKind[] = ["exec", "invariant", "judged", "none", "unclassified"];

export interface AcKindReport {
  readonly flowId: string;
  /** Keyed by `ACn`. */
  readonly criteria: Readonly<Record<string, AcKindRecord>>;
  readonly counts: Readonly<Record<AcKind, number>>;
  /** `exec` + `invariant`. */
  readonly runnable: number;
  readonly total: number;
}

export interface AcKindError {
  readonly id: string;
  readonly message: string;
}

export interface ParsedAcKind {
  readonly id: string;
  /** The criterion text with its trailing marker removed — what token extraction and classification receive. */
  readonly text: string;
  /** The criterion text exactly as the line holds it, marker included. */
  readonly rawText: string;
  /** `unclassified` for a line with no marker AND for a line whose marker failed to parse (that one also appears in `errors`). */
  readonly record: AcKindRecord;
}

export interface AcKindParseResult {
  readonly criteria: readonly ParsedAcKind[];
  readonly errors: readonly AcKindError[];
}

// The same top-line rule `check-ac.ts`'s `parseAcceptanceCriteria` and
// `store.ts`'s `readAcCriteria` use. Repeated here (rather than imported) so
// `check-ac.ts` can import THIS module without a cycle; `ac-kinds.test.ts`
// asserts the two agree.
const AC_LINE = /^\s*[-*]\s*(AC\d+)\s*:\s?(.*)$/i;

const MARKER_OPEN = "[verify:";

/** Replace each inline code span with spaces of the same length, so a `[verify: …]` quoted in backticks is prose, not a marker. */
function maskCodeSpans(text: string): string {
  return text.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
}

interface MarkerScan {
  /** Occurrences of `[verify:` outside inline code. */
  readonly occurrences: number;
  /** Index of the last occurrence; `-1` when there is none. */
  readonly lastStart: number;
  /** The last occurrence runs to the end of the line and closes with `]`. */
  readonly trailing: boolean;
  /** Length of the text with trailing whitespace removed. */
  readonly end: number;
}

function scanMarkers(text: string): MarkerScan {
  const masked = maskCodeSpans(text);
  let occurrences = 0;
  let lastStart = -1;
  for (let at = masked.indexOf(MARKER_OPEN); at !== -1; at = masked.indexOf(MARKER_OPEN, at + MARKER_OPEN.length)) {
    occurrences += 1;
    lastStart = at;
  }
  const end = text.trimEnd().length;
  return { occurrences, lastStart, trailing: occurrences > 0 && end > lastStart && text[end - 1] === "]", end };
}

/**
 * The criterion text without its trailing `[verify: …]` marker. Text with no
 * trailing marker is returned UNCHANGED (same string), so behaviour on an
 * unclassified criterion is byte-identical to before this module existed.
 */
export function stripVerifyMarker(text: string): string {
  const scan = scanMarkers(text);
  if (!scan.trailing || scan.occurrences !== 1) return text;
  return text.slice(0, scan.lastStart).trimEnd();
}

const KIND_WORDS = "exec, invariant, judged or none";

function unclassified(error?: string): { record: AcKindRecord; error?: string } {
  return error === undefined ? { record: { kind: "unclassified" } } : { record: { kind: "unclassified" }, error };
}

/** Parse ONE criterion's text into its kind record; `error` is set (and the record is `unclassified`) when a marker is present but malformed. */
export function parseAcKindText(text: string): { record: AcKindRecord; error?: string } {
  const scan = scanMarkers(text);
  if (scan.occurrences === 0) return unclassified();
  if (scan.occurrences > 1) {
    return unclassified("a second [verify: …] marker — a criterion carries exactly one, as the last thing on its line");
  }
  if (!scan.trailing) {
    return unclassified("the [verify: …] marker must be the last thing on the line and close with `]`");
  }
  const payload = text.slice(scan.lastStart + MARKER_OPEN.length, scan.end - 1).trim();
  if (payload.length === 0) return unclassified(`an empty [verify: …] marker — expected ${KIND_WORDS}`);
  const word = /^[A-Za-z]+/.exec(payload)?.[0] ?? "";
  const rest = payload.slice(word.length).trim();
  switch (word) {
    case "judged":
      return rest.length === 0 ? { record: { kind: "judged" } } : unclassified("`judged` takes no arguments — write [verify: judged]");
    case "exec":
    case "invariant": {
      if (rest.length === 0) return unclassified(`\`${word}\` requires a backticked command, e.g. [verify: ${word} \`bun test path/to.test.ts\`]`);
      const command = /^`([^`]*)`$/.exec(rest);
      if (command === null) return unclassified(`\`${word}\` requires exactly one backticked command after the kind, e.g. [verify: ${word} \`bun test path/to.test.ts\`]`);
      const check = (command[1] ?? "").trim();
      if (check.length === 0) return unclassified(`\`${word}\` has an empty backticked command`);
      return { record: { kind: word, check } };
    }
    case "none": {
      if (rest.length === 0) return unclassified("`none` requires a reason after an em dash, e.g. [verify: none — <reason>]");
      const reason = /^—\s*([\s\S]*)$/.exec(rest);
      if (reason === null) return unclassified("`none` requires its reason after an em dash (—), e.g. [verify: none — <reason>]");
      const why = (reason[1] ?? "").trim();
      if (why.length === 0) return unclassified("`none` has an empty reason after the em dash");
      return { record: { kind: "none", reason: why } };
    }
    default:
      return unclassified(`unknown verification kind "${word.length > 0 ? word : payload}" — expected ${KIND_WORDS}`);
  }
}

/** Parse every `- ACn:` line of an `acceptance-criteria.md` body. Never throws; malformed markers land in `errors`. */
export function parseAcKinds(content: string): AcKindParseResult {
  const criteria: ParsedAcKind[] = [];
  const errors: AcKindError[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = AC_LINE.exec(line);
    if (!match?.[1]) continue;
    const id = match[1].toUpperCase();
    const rawText = (match[2] ?? "").trim();
    const parsed = parseAcKindText(rawText);
    if (parsed.error !== undefined) errors.push({ id, message: parsed.error });
    criteria.push({ id, text: stripVerifyMarker(rawText), rawText, record: parsed.record });
  }
  return { criteria, errors };
}

function emptyCounts(): Record<AcKind, number> {
  return { exec: 0, invariant: 0, judged: 0, none: 0, unclassified: 0 };
}

/** Build the report for a criteria body. A criterion id repeated in the file keeps its first record. */
export function buildAcKindReport(flowId: string, content: string): { report: AcKindReport; errors: readonly AcKindError[] } {
  const parsed = parseAcKinds(content);
  const criteria: Record<string, AcKindRecord> = {};
  for (const criterion of parsed.criteria) {
    if (!(criterion.id in criteria)) criteria[criterion.id] = criterion.record;
  }
  return { report: reportFromRecords(flowId, criteria), errors: parsed.errors };
}

export function reportFromRecords(flowId: string, criteria: Readonly<Record<string, AcKindRecord>>): AcKindReport {
  const counts = emptyCounts();
  for (const record of Object.values(criteria)) counts[record.kind] += 1;
  return {
    flowId,
    criteria,
    counts,
    runnable: counts.exec + counts.invariant,
    total: Object.keys(criteria).length,
  };
}

/** The two-line distribution block `flow freeze`, `flow ac kinds` and the TUI print. */
export function renderAcKindDistribution(report: Pick<AcKindReport, "counts" | "runnable" | "total">): readonly string[] {
  const { counts } = report;
  const percent = report.total === 0 ? 0 : Math.round((report.runnable / report.total) * 100);
  const tail = [`${counts.none} accepted as unverifiable`, `${counts.judged} judged`, ...(counts.unclassified > 0 ? [`${counts.unclassified} unclassified`] : [])];
  return [
    `acceptance kinds: exec ${counts.exec}  invariant ${counts.invariant}  judged ${counts.judged}  none ${counts.none}  unclassified ${counts.unclassified}   (${report.total} criteria)`,
    `coverage: ${report.runnable}/${report.total} runnable (${percent}%)  ·  ${tail.join("  ·  ")}`,
  ];
}

/** A one-line human label for a record: `exec  bun test …`, `none  — reason`. */
export function describeAcKind(record: AcKindRecord): string {
  switch (record.kind) {
    case "exec":
    case "invariant":
      return `${record.kind} \`${record.check}\``;
    case "none":
      return `none — ${record.reason}`;
    default:
      return record.kind;
  }
}

/**
 * Read a persisted `acKinds` value back into records. Anything absent or not
 * shaped like a record map reads as `undefined` — the caller decides what an
 * absent field means (governance: "fully unclassified", never "no criteria").
 */
export function readAcKindRecords(value: unknown): Record<string, AcKindRecord> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, AcKindRecord> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    const kind = record["kind"];
    if ((kind === "exec" || kind === "invariant") && typeof record["check"] === "string") out[id] = { kind, check: record["check"] };
    else if (kind === "judged") out[id] = { kind };
    else if (kind === "none" && typeof record["reason"] === "string") out[id] = { kind, reason: record["reason"] };
    else if (kind === "unclassified") out[id] = { kind };
    else return undefined;
  }
  return out;
}
