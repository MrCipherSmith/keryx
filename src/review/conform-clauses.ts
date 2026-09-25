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

// Through the security facade, not `security/redact` directly — the
// import-policy ratchet (`src/lib/import-policy.live.test.ts`) is at its cap,
// and every caller outside `src/security/` reaches redaction through
// `src/security/service.ts` (its own file header explains why).
import { redactSensitiveText } from "../security/service";

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
  /**
   * True when `explicit` was produced by {@link preClassifyProcessClause}
   * (flow 337's deterministic pre-classifier) rather than the document's own
   * `[state:...]`/`[not-checkable:...]` marker — read by {@link applyClauseTags}
   * to stamp `tag_source: "pre-classified"` instead of `"explicit"`.
   */
  readonly preClassified?: boolean;
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
  /**
   * How this clause got its tag — never trusted silently by a caller that
   * wants to know. `"pre-classified"` (flow 337, clause-tag precision) is
   * distinct from `"explicit"`: both never reach Jev, but `"explicit"` is a
   * DOCUMENT AUTHOR's own `[state:...]`/`[not-checkable:...]` marker, while
   * `"pre-classified"` is this module's own deterministic guess
   * ({@link preClassifyProcessClause}) — a caller that wants to trust only
   * what the document itself asserted must not conflate the two.
   */
  readonly tag_source: "explicit" | "pre-classified" | "jev" | "cache";
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
// A fenced-code-block delimiter (` ``` `/` ~~~ `, any language tag) — tracked
// so the pre-classifier below can tell a numbered step written INSIDE a
// fence (this repo's own `api-contracts.mdc` writes its workflow this way)
// from an ordinary ordered list. The line itself is never a clause.
const FENCE_DELIMITER_RE = /^\s{0,3}(`{3,}|~{3,})/;
// A list item introduced by a digit marker (`1.`/`2)`), as opposed to a
// bullet (`-`/`*`/`+`) — the "ordered" half of {@link ClauseWorkflowContext}.
const ORDERED_LIST_ITEM_RE = /^ {0,3}\d+[.)]\s+/;

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

// ---------------------------------------------------------------------------
// Deterministic process/not-checkable pre-classifier (clause-tag precision
// fix, flow 337 — follow-up to `review-jev-rules`'s own precision fixes in
// `./jev-rules.ts`). PR #712 against this repo's own `.metaproject/rules`
// left exactly two findings, both false positives from ONE clause of
// `api-contracts.mdc`: "Review the contract for breaking changes" — a
// PROCESS step (step 2 of a 5-step fenced numbered workflow: design, review,
// generate types, implement, write tests) that Jev's `choice` tagging called
// `hunk`-checkable anyway. This pre-classifier catches that shape
// DETERMINISTICALLY, with no model call, applied inside `extractReferenceClauses`
// below — BEFORE `buildClauseTagQuestions` ever builds a question for the
// clause — the same "explicit, never asked" channel a document's own
// `[state:...]`/`[not-checkable:...]` marker already uses (a document-authored
// marker still wins outright; this only fires when the document supplies
// none). A clause stating a property of code (`must`/`never`/`always` + a
// code noun) is checked FIRST and always stays a Jev candidate, even if it
// also happens to open with a process-verb-shaped word.
// ---------------------------------------------------------------------------

/**
 * Imperative verbs/phrases read as addressed to a PERSON or AGENT, never to
 * code — matched only at the very START of a clause's already-marker-stripped
 * text, so "The function must document its return type" is untouched:
 * "document" there is not the clause's opening word.
 */
export const PROCESS_VERB_LEAD_TERMS = ["review", "discuss", "ask", "document", "communicate", "get approval", "plan", "decide"] as const;

const PROCESS_VERB_LEAD_RE = new RegExp(`^(${PROCESS_VERB_LEAD_TERMS.join("|")})\\b`, "i");

/** "design ... in" — a two-part phrase a single leading-verb match would miss ("Design the endpoint in OpenAPI/schema first"). */
const PROCESS_DESIGN_IN_RE = /^design\b.*\bin\b/i;

/**
 * A property-of-code clause: `must`/`never`/`always` PLUS one of these code
 * nouns anywhere in the same clause — always stays a Jev candidate, checked
 * BEFORE the process heuristics below so it wins any collision. Widened
 * (flow 337, item 3) with the property-ish nouns the reviewer's sweep found
 * uncovered — `field`, `method`, `constructor`, `property`, `file`, `files`,
 * `path`, `directory`, `module`, `component`, `store`, `schema`, `endpoint`
 * — so a clause like "Plan files MUST be Markdown (`.md`)." is rescued here
 * instead of ever reaching the verb-lead check below.
 */
export const CODE_PROPERTY_NOUNS = [
  "function",
  "class",
  "import",
  "export",
  "type",
  "handler",
  "query",
  "test",
  "field",
  "method",
  "constructor",
  "property",
  "file",
  "files",
  "path",
  "directory",
  "module",
  "component",
  "store",
  "schema",
  "endpoint",
] as const;

// Verb and noun matched independently, in EITHER order ("a handler must
// never ..." and "must never leak from a handler" both count) — a single
// ordered pattern would miss the noun-before-verb phrasing.
const CODE_PROPERTY_VERB_RE = /\b(must|never|always)\b/i;
const CODE_PROPERTY_NOUN_RE = new RegExp(`\\b(${CODE_PROPERTY_NOUNS.join("|")})\\b`, "i");

function isCodePropertyClause(text: string): boolean {
  return CODE_PROPERTY_VERB_RE.test(text) && CODE_PROPERTY_NOUN_RE.test(text);
}

/**
 * Flow 337, item 4: the noun/verb ambiguity a lead term like "plan" or
 * "document" carries — cheap, not grammar. When the next word is one of
 * these, it reads as the OBJECT of a genuine imperative ("Review THE
 * contract", "Ask WHETHER to apply changes", "Get approval FROM a domain
 * owner") — the lead word stays a verb. Absent that, the lead word is very
 * likely a bare NOUN SUBJECT instead ("Plan files MUST be Markdown", "Document
 * index" — a document's index, not an instruction to document one), so the
 * clause is left un-pre-classified rather than guessed.
 */
const IMPERATIVE_OBJECT_LEAD_WORDS = new Set([
  "the",
  "a",
  "an",
  "any",
  "each",
  "every",
  "this",
  "that",
  "these",
  "those",
  "your",
  "its",
  "their",
  "our",
  "his",
  "her",
  "whether",
  "for",
  "with",
  "about",
  "to",
  "from",
  "on",
  "in",
  "of",
  "before",
  "after",
]);

/** A lead word directly followed by one of these reads as the SUBJECT of a property statement ("Plan must...", "Document is...") rather than a command — never an imperative, checked before {@link IMPERATIVE_OBJECT_LEAD_WORDS}. */
const PROPERTY_ASSERTION_NEXT_WORDS = new Set(["must", "should", "is", "are"]);

/**
 * True when the word immediately after `leadTerm` (already matched at the
 * start of `trimmed` by {@link PROCESS_VERB_LEAD_RE}) does NOT read as an
 * imperative's object — i.e. the lead word is ambiguous enough that it
 * should NOT be pre-classified as a process step.
 */
function leadVerbReadsAsNoun(trimmed: string, leadTerm: string): boolean {
  const rest = trimmed.slice(leadTerm.length).trimStart();
  const nextWordMatch = /^([A-Za-z][A-Za-z'-]*)/.exec(rest);
  if (nextWordMatch === null) return false;
  const nextWord = nextWordMatch[1]!.toLowerCase();
  if (PROPERTY_ASSERTION_NEXT_WORDS.has(nextWord)) return true;
  return !IMPERATIVE_OBJECT_LEAD_WORDS.has(nextWord);
}

/** Where a clause sits, for {@link isWorkflowListStep}/{@link preClassifyProcessClause} — captured by `extractReferenceClauses` at the moment its enclosing list item started. */
export interface ClauseWorkflowContext {
  /** The list marker was a digit (`1.`/`2)`), not a bullet (`-`/`*`/`+`). */
  readonly ordered: boolean;
  /** The list item sits inside a fenced (` ``` `) code block. */
  readonly fenced: boolean;
  readonly headingPath: readonly string[];
}

const WORKFLOW_HEADING_RE = /workflow/i;

/**
 * True for an ordered list item whose NEAREST heading (the last entry of
 * `headingPath` — never the whole ancestor chain) itself names "workflow".
 * Flow 337, item 1: checking the full chain swept every ordered list in a
 * file merely because some ANCESTOR heading (often the file's own H1) said
 * "Workflow" — e.g. `rule-management-workflow.mdc`'s H1 "Rule Management
 * Workflow" wrongly caught "2. Keep all rule files in English." nested three
 * headings below it under "## Mandatory Behavior", which says nothing about
 * a workflow at all. Only the clause's own immediate heading counts now.
 *
 * Flow 337, item 2: being fenced no longer qualifies a step on its own
 * either (dropped the old unconditional `if (fenced) return true`) — this
 * repo's own `mobx-store-template.mdc` fences its "1. private fields … 5.
 * private methods" member-ordering list under "## Member Ordering" (no
 * "workflow" anywhere), and that list is a checkable convention, not a
 * process. A fenced OR ordered step is process only via its own text
 * (the verb-lead/design-in checks above, run before this one) or via this
 * heading check — never merely for being fenced.
 */
export function isWorkflowListStep(context: ClauseWorkflowContext): boolean {
  if (!context.ordered) return false;
  const nearestHeading = context.headingPath[context.headingPath.length - 1];
  return nearestHeading !== undefined && WORKFLOW_HEADING_RE.test(nearestHeading);
}

/**
 * The pre-classifier itself: returns a `not-checkable` reason string when
 * `text` reads as a PROCESS step rather than a checkable code property, else
 * `undefined` (stays a Jev candidate, behaviour unchanged). Pure,
 * deterministic, no I/O.
 */
export function preClassifyProcessClause(text: string, context: ClauseWorkflowContext): string | undefined {
  const trimmed = text.trim();
  if (isCodePropertyClause(trimmed)) return undefined;
  const verbMatch = PROCESS_VERB_LEAD_RE.exec(trimmed);
  if (verbMatch !== null && !leadVerbReadsAsNoun(trimmed, verbMatch[1]!)) {
    return `Pre-classified process: clause opens with the imperative verb "${verbMatch[1]!.toLowerCase()}", addressed to a person or agent — not a property checkable in a code hunk.`;
  }
  if (PROCESS_DESIGN_IN_RE.test(trimmed)) {
    return `Pre-classified process: clause opens with "design ... in" — an instruction to a person or agent, not a property checkable in a code hunk.`;
  }
  if (isWorkflowListStep(context)) {
    return `Pre-classified process: a numbered step under a heading naming "workflow" — a sequential process instruction, not a single hunk-checkable property.`;
  }
  return undefined;
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
  let inFence = false;
  let current: { textLines: string[]; explicit?: ClauseExplicitTag; ordered: boolean; fenced: boolean } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const joined = current.textLines.join(" ").replace(/\s+/g, " ").trim();
    if (joined.length > 0) {
      indexInHeading += 1;
      // Pre-classifier (flow 337): only when the document itself supplied no
      // explicit marker — an author's own `[state:...]`/`[not-checkable:...]`
      // always wins outright, exactly as before. A pre-classifier hit is
      // marked distinctly (`preClassified: true`) so `applyClauseTags` can
      // stamp `tag_source: "pre-classified"`, never conflated with a real
      // document-authored `"explicit"` marker.
      let explicit = current.explicit;
      let preClassified = false;
      if (explicit === undefined) {
        const reason = preClassifyProcessClause(joined, { ordered: current.ordered, fenced: current.fenced, headingPath });
        if (reason !== undefined) {
          explicit = { not_checkable_reason: reason };
          preClassified = true;
        }
      }
      clauses.push({
        clause_id: `${headingSlug}-${indexInHeading}`,
        text: joined,
        heading_path: [...headingPath],
        ...(explicit !== undefined ? { explicit } : {}),
        ...(preClassified ? { preClassified: true } : {}),
      });
    }
    current = undefined;
  };

  for (const rawLine of lines) {
    if (FENCE_DELIMITER_RE.test(rawLine)) {
      flush();
      inFence = !inFence;
      continue;
    }
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
      current = { textLines: [text], ordered: ORDERED_LIST_ITEM_RE.test(rawLine), fenced: inFence, ...(explicit !== undefined ? { explicit } : {}) };
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

/**
 * One `choice` question per clause that has no explicit marker AND was not
 * caught by {@link preClassifyProcessClause} at extraction time (AC2's Jev
 * fallback, narrowed by flow 337's precision fix). The clause's own text is
 * embedded — that is the feature, opt-in via `review.jev.conform` — but only
 * after `redactSensitiveText` strips any secret the reference document
 * itself happens to contain, same floor every other piece of state sent to
 * Jev already gets.
 *
 * Instructions (flow 337): the ORIGINAL wording asked "which kind of state"
 * without ever contrasting a code-observable fact against a human action —
 * `api-contracts.mdc`'s "Review the contract for breaking changes" (an
 * instruction to a person, not a fact about the diff) still got tagged
 * `hunk`. The rewrite below states the "hunk" criterion as "a property you
 * can see in a code hunk" and its rejection as "an action someone
 * performs", so the two readings a clause can have are named explicitly
 * rather than left for the model to infer from "code or test change".
 */
export function buildClauseTagQuestions(
  clauses: readonly RawReferenceClause[],
): Readonly<Record<string, ConformChoiceQuestion>> {
  const questions: Record<string, ConformChoiceQuestion> = {};
  for (const clause of clauses) {
    if (clause.explicit !== undefined) continue;
    questions[clause.clause_id] = {
      type: "choice",
      instructions:
        `Classify this rule-document clause by what you would check it against. Answer "hunk" only when the clause ` +
        `states a property you can see in a code hunk — something true of the code or test diff itself (a required ` +
        `pattern, a forbidden call, a naming or structural rule) that a reviewer could point at inside the changed ` +
        `lines. Answer "pr" for the pull request's own title/body/size, "report" for an existing review ` +
        `report/findings. If the clause instead describes an action someone performs — a step a person or agent ` +
        `carries out (reviewing, discussing, asking, documenting, communicating, planning, deciding, getting ` +
        `approval) rather than a fact the diff itself states, or any other live/manual step with no gatherable ` +
        `artefact — answer "not-checkable" instead.\n\nClause: ${redactSensitiveText(clause.text)}`,
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
      // Flow 337, item 5: a document-authored marker is `"explicit"`; a hit
      // produced by the pre-classifier at extraction time (never itself a
      // document marker) is `"pre-classified"` instead — kept distinguishable
      // by a caller that trusts only the document's own word.
      const tagSource: ReferenceClause["tag_source"] = clause.preClassified === true ? "pre-classified" : "explicit";
      if ("state_kind" in clause.explicit) {
        return {
          clause_id: clause.clause_id,
          text: clause.text,
          heading_path: clause.heading_path,
          state_kind: clause.explicit.state_kind,
          checkable: true,
          tag_source: tagSource,
        };
      }
      return {
        clause_id: clause.clause_id,
        text: clause.text,
        heading_path: clause.heading_path,
        state_kind: "pr",
        checkable: false,
        reason: clause.explicit.not_checkable_reason,
        tag_source: tagSource,
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
