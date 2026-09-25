// Reference-document conformance mode — flow 308, PRD.md Requirements 24-29 /
// PLAN.md Phase 2, AC1/AC2 of the frozen acceptance criteria
// (`.metaproject/flows/308-*/acceptance-criteria.md`).
//
// AC1: a reference document (a rules file, a skill, or a project skill) is
// split DETERMINISTICALLY into clauses — no model call — each numbered or
// bulleted item under a heading becomes one clause with a stable id (heading
// slug plus index), its text, and its heading path.
//
// AC2: each clause is tagged `state_kind: "pr" | "report" | "hunk"` and
// `checkable: true | false` (+ `reason` when false). Tagging uses EXPLICIT
// MARKERS when the document supplies them (parsed here, still no model call)
// and otherwise falls back to a single Jev `choice` question per clause,
// cached by the document's content hash. This module owns the marker syntax
// and the untagged->tagged merge; the Jev question/answer shapes are kept
// structural (see the file-boundary note below) and the cache lives in
// `./conform-tag-cache.ts`.
//
// CORE ZONE (`src/lib/import-zones.ts`): this module never imports the
// client-zone Jev client (`src/harness/decision/jev-client.ts`) — same
// discipline `src/review/ci-triage.ts`'s header explains at length. The
// question/answer shapes below are chosen to satisfy `JevQuestion`/`JevAnswer`
// structurally with no import needed; `src/commands/review.ts` (an ADAPTER)
// is where the two actually meet.

export const REFERENCE_CLAUSE_STATE_KINDS = ["pr", "report", "hunk"] as const;
export type ReferenceClauseStateKind = (typeof REFERENCE_CLAUSE_STATE_KINDS)[number];

/**
 * A structural stand-in for `JevQuestion` (`type: "choice"`) — see the file
 * header. `criteria` is an OBJECT (option id -> label), matching the real
 * vendor endpoint (flow 308's live check got `HTTP 400 "expected: record,
 * received: array"` for an array shape — see `jev-client.ts`'s own note on
 * `JevQuestion.criteria`).
 */
export interface ConformChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** AC2's tagging criteria: which state kind a clause belongs to, or that it cannot be checked at all. */
export const CLAUSE_TAG_CRITERIA = ["pr", "report", "hunk", "not-checkable"] as const;
export type ClauseTagCriterion = (typeof CLAUSE_TAG_CRITERIA)[number];

/** {@link CLAUSE_TAG_CRITERIA} as the record shape the real `/systemone` endpoint requires for a `choice` question. */
const CLAUSE_TAG_CRITERIA_RECORD: Readonly<Record<string, string>> = Object.fromEntries(
  CLAUSE_TAG_CRITERIA.map((criterion) => [criterion, criterion]),
);

/**
 * AC1's output: text, stable id, heading path — no `state_kind`/`checkable`
 * yet. `explicit` carries whatever an inline marker in the document itself
 * already said (AC2's "explicit markers" path), so a caller that has one
 * never needs to ask Jev for that clause.
 */
export interface RawReferenceClause {
  readonly clause_id: string;
  readonly text: string;
  readonly heading_path: readonly string[];
  readonly explicit?: ClauseExplicitTag;
}

export type ClauseExplicitTag =
  | { readonly state_kind: ReferenceClauseStateKind }
  | { readonly not_checkable_reason: string };

/** AC2's fully tagged clause — what every downstream consumer (state gathering, the CLI, the TUI) reads. */
export interface ReferenceClause {
  readonly clause_id: string;
  readonly text: string;
  readonly heading_path: readonly string[];
  readonly state_kind: ReferenceClauseStateKind;
  readonly checkable: boolean;
  readonly reason?: string;
  /** How this clause got its tag — never trusted silently by a caller that wants to know. */
  readonly tag_source: "explicit" | "jev" | "cache";
}

// ---------------------------------------------------------------------------
// AC1: deterministic extraction — no model call anywhere in this section.
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
// Top-level (0-3 leading spaces, same threshold markdown itself uses before a
// list item is read as a nested code block) bullet or ordered-list item.
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
// A continuation line: indented at least 2 spaces, non-blank, not itself a new
// list item or heading. Loose (unindented) wrapped prose is NOT attached —
// the fixtures this flow ships are written one clause per line on purpose,
// which is also what keeps clause boundaries unambiguous for a test to pin.
const CONTINUATION_RE = /^ {2,}(\S.*)$/;

const EXPLICIT_MARKER_RE = /\s*\[(state:(pr|report|hunk)|not-checkable:\s*([^\]]+))\]\s*$/i;

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "clause";
}

/** Strip a trailing `[state:pr]` / `[not-checkable: reason]` marker, returning the clean text and the tag it named. */
function extractExplicitMarker(text: string): { text: string; explicit?: ClauseExplicitTag } {
  const match = EXPLICIT_MARKER_RE.exec(text);
  if (match === null) {
    return { text };
  }
  const clean = text.slice(0, match.index).trim();
  const stateKind = match[2];
  const reason = match[3];
  if (stateKind !== undefined) {
    return { text: clean, explicit: { state_kind: stateKind as ReferenceClauseStateKind } };
  }
  return { text: clean, explicit: { not_checkable_reason: (reason ?? "").trim() } };
}

/**
 * AC1: split a reference document into clauses. Pure, synchronous, no I/O and
 * no model call. `docText` is the whole file's content (markdown-shaped —
 * a rules `.mdc` file, a skill's `SKILL.md` body, or a project skill).
 *
 * Clause id: `<nearest-heading-slug>-<1-based index within that heading>`.
 * The index resets at every heading line (any level) — the SAME rule that
 * decides which items are "under" it: everything from one heading line up to
 * (not including) the next. A document with no heading before its first list
 * uses the fixed slug `root`.
 */
export function extractReferenceClauses(docText: string): RawReferenceClause[] {
  const lines = docText.replace(/\r\n/g, "\n").split("\n");
  const clauses: RawReferenceClause[] = [];
  const headingPath: string[] = [];
  let headingSlug = "root";
  let indexInHeading = 0;
  let current: { textLines: string[]; explicit?: ClauseExplicitTag } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const joined = current.textLines.join(" ").replace(/\s+/g, " ").trim();
    if (joined.length > 0) {
      indexInHeading += 1;
      clauses.push({
        clause_id: `${headingSlug}-${indexInHeading}`,
        text: joined,
        heading_path: [...headingPath],
        ...(current.explicit !== undefined ? { explicit: current.explicit } : {}),
      });
    }
    current = undefined;
  };

  for (const rawLine of lines) {
    const headingMatch = HEADING_RE.exec(rawLine);
    if (headingMatch !== null) {
      flush();
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      headingPath.length = Math.min(headingPath.length, level - 1);
      headingPath[level - 1] = text;
      headingPath.length = level;
      // The id's own "heading slug" is the NEAREST heading only — `heading_path`
      // (below) carries the full ancestor chain separately, per AC1's "a
      // stable id (heading slug plus index), its text, and its heading path"
      // naming three DIFFERENT things, not the path folded into the id.
      headingSlug = slugify(text);
      indexInHeading = 0;
      continue;
    }
    const listMatch = LIST_ITEM_RE.exec(rawLine);
    if (listMatch !== null) {
      flush();
      const { text, explicit } = extractExplicitMarker(listMatch[1]!);
      current = { textLines: [text], ...(explicit !== undefined ? { explicit } : {}) };
      continue;
    }
    const continuationMatch = current !== undefined ? CONTINUATION_RE.exec(rawLine) : null;
    if (continuationMatch !== null && current !== undefined) {
      const { text, explicit } = extractExplicitMarker(continuationMatch[1]!);
      current.textLines.push(text);
      if (explicit !== undefined) current.explicit = explicit;
      continue;
    }
    if (rawLine.trim().length === 0) {
      flush();
      continue;
    }
    // Any other non-blank, non-continuation line ends the current clause —
    // ordinary prose between headings and lists is not a clause.
    flush();
  }
  flush();
  return clauses;
}

// ---------------------------------------------------------------------------
// AC2: tagging — explicit markers first, Jev `choice` fallback otherwise.
// ---------------------------------------------------------------------------

/** One `choice` question per clause that has no explicit marker (AC2's Jev fallback). */
export function buildClauseTagQuestions(
  clauses: readonly RawReferenceClause[],
): Readonly<Record<string, ConformChoiceQuestion>> {
  const questions: Record<string, ConformChoiceQuestion> = {};
  for (const clause of clauses) {
    if (clause.explicit !== undefined) continue;
    questions[clause.clause_id] = {
      type: "choice",
      instructions:
        `Classify this rule-document clause. Which kind of state would you check it against — "pr" (the pull ` +
        `request's own title/body/size), "report" (an existing review report/findings), or "hunk" (a code or test ` +
        `change)? If it names no gatherable artefact at all — a live/manual step such as "verified on a running ` +
        `instance" or an obligation on the reviewer's own process — answer "not-checkable" instead.\n\nClause: ${clause.text}`,
      criteria: CLAUSE_TAG_CRITERIA_RECORD,
    };
  }
  return questions;
}

/** One raw clause's resolved tag, however it was resolved. */
export interface ClauseTag {
  readonly state_kind: ReferenceClauseStateKind;
  readonly checkable: boolean;
  readonly reason?: string;
}

const DEFAULT_NOT_CHECKABLE_REASON =
  "Jev classified this clause as not gatherable from any artefact this reviewer reads (live/manual step or reviewer-process obligation).";

/**
 * Merge AC1's raw clauses with resolved tags — explicit markers win outright
 * (never sent to Jev, never looked up in the cache); everything else reads
 * `resolved` (the caller's job: explicit answers for a cache hit, a live Jev
 * `choice` answer otherwise) and falls back to `state_kind: "pr", checkable:
 * false` with a named reason when NEITHER a marker nor a resolution exists —
 * the fail-closed reading of an untagged clause, never silently dropped.
 */
export function applyClauseTags(
  clauses: readonly RawReferenceClause[],
  resolved: ReadonlyMap<string, { readonly source: "jev" | "cache"; readonly tag: ClauseTag }>,
): ReferenceClause[] {
  return clauses.map((clause) => {
    if (clause.explicit !== undefined) {
      if ("state_kind" in clause.explicit) {
        return {
          clause_id: clause.clause_id,
          text: clause.text,
          heading_path: clause.heading_path,
          state_kind: clause.explicit.state_kind,
          checkable: true,
          tag_source: "explicit",
        };
      }
      return {
        clause_id: clause.clause_id,
        text: clause.text,
        heading_path: clause.heading_path,
        state_kind: "pr",
        checkable: false,
        reason: clause.explicit.not_checkable_reason,
        tag_source: "explicit",
      };
    }
    const hit = resolved.get(clause.clause_id);
    if (hit === undefined) {
      return {
        clause_id: clause.clause_id,
        text: clause.text,
        heading_path: clause.heading_path,
        state_kind: "pr",
        checkable: false,
        reason: "No explicit marker, no cached tag, and no Jev answer was supplied for this clause — treated as not-checkable rather than guessed.",
        tag_source: "jev",
      };
    }
    return {
      clause_id: clause.clause_id,
      text: clause.text,
      heading_path: clause.heading_path,
      ...hit.tag,
      tag_source: hit.source,
    };
  });
}

/** Turn one raw Jev `choice` answer into a {@link ClauseTag}. */
export function clauseTagFromChoice(choice: string): ClauseTag {
  if (choice === "pr" || choice === "report" || choice === "hunk") {
    return { state_kind: choice, checkable: true };
  }
  return { state_kind: "pr", checkable: false, reason: DEFAULT_NOT_CHECKABLE_REASON };
}
