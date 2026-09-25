// review-jev-comments — flow 333, AC3/AC4 of the frozen acceptance criteria
// (`.metaproject/flows/333-*/acceptance-criteria.md`).
//
// An ADDITIONAL, CLI-driven orchestrator reviewer that checks whether PR
// review comments already in the existing ledger
// (`.metaproject/reviews/pr-comments/*.json`, `src/review/pr-comments.ts`)
// were ADDRESSED. keryx computes every fact (commits after the comment
// touching its file, the thread's resolved flag, replies already on the
// ledger) and Jev is asked exactly one `choice` question per open comment —
// resolved-by-fix / still-open / not-actionable / needs-escalation. keryx
// composes every word of the finding; Jev's answer is one label, never prose
// that reaches a finding verbatim.
//
// CORE ZONE (`src/lib/import-zones.ts`): never imports the client-zone Jev
// client — same discipline `src/review/jev-rules.ts`/`src/review/jev-docs.ts`
// already establish. Structural question/answer shapes only;
// `src/commands/review-jev-comments.ts` (the ADAPTER) is where this meets
// `callJevSystemOne` AND the read-only GitHub/git facts this module cannot
// gather itself (it takes them in, already computed).
//
// Through the security facade, not `security/redact` directly (import-policy
// ratchet is at its cap; see `src/review/jev-rules.ts`'s identical note).

import { redactSensitiveText } from "../security/service";
import { estimateTokens } from "./cost";
import type { ScopedRegion } from "./scope";

export const JEV_COMMENT_CHOICES = ["resolved-by-fix", "still-open", "not-actionable", "needs-escalation"] as const;
export type JevCommentChoice = (typeof JEV_COMMENT_CHOICES)[number];

const CHOICE_LABELS: Readonly<Record<JevCommentChoice, string>> = {
  "resolved-by-fix": "a later commit (or a reply) actually addresses what the comment asked for",
  "still-open": "nothing since the comment addresses it, and it still applies",
  "not-actionable": "the comment does not ask for a code change (a question already answered, a compliment, an out-of-scope remark)",
  "needs-escalation": "the comment raises something that blocks progress and needs the operator's judgement, not a reply",
};

/** A structural stand-in for `JevQuestion` (`type: "choice"`) — see the file header. */
export interface CommentChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<JevCommentChoice, string>>;
}

export type ThreadResolution = "resolved" | "unresolved" | "unknown";

export interface CommitTouch {
  readonly sha: string;
  readonly date: string;
}

export interface CommentReply {
  readonly author: string;
  readonly body: string;
  readonly submittedAt: string;
}

/** Every deterministic fact this module needs about one open comment — gathered by the adapter, judged here. */
export interface OpenCommentFacts {
  readonly id: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
  readonly submittedAt: string;
  readonly threadId: string | null;
  readonly resolved: ThreadResolution;
  /** Commits after `submittedAt` that touch `path` (capped by the adapter). */
  readonly commitsAfter: readonly CommitTouch[];
  readonly replies: readonly CommentReply[];
  /** The diff's own current hunks at `path`, when any — "the later hunks at that location" (AC3). */
  readonly laterHunks: readonly ScopedRegion[];
}

/** AC3's deterministic fact lines, computed BEFORE Jev is asked and placed above the redacted text — the same "facts first" discipline `src/review/ci-triage.ts` and `src/review/conform-state.ts` already established. */
export function commentFactLines(facts: OpenCommentFacts): string[] {
  const resolvedLine =
    facts.resolved === "resolved" ? "the review thread IS marked resolved on GitHub." : facts.resolved === "unresolved" ? "the review thread is NOT marked resolved." : "the review thread's resolved state could not be read.";
  return [
    `comment: ${facts.author} at ${facts.submittedAt}${facts.path !== null ? `, on ${facts.path}${facts.line !== null ? `:${facts.line}` : ""}` : ""}`,
    `thread: ${resolvedLine}`,
    `commits after this comment touching ${facts.path ?? "(no file)"}: ${facts.commitsAfter.length}` +
      (facts.commitsAfter.length > 0 ? ` (${facts.commitsAfter.map((c) => c.sha.slice(0, 7)).join(", ")})` : ""),
    `replies on the ledger: ${facts.replies.length}`,
    `current hunk(s) at this location: ${facts.laterHunks.length}`,
  ];
}

const COMMENT_TOKEN_BUDGET = 64_000;
const QUESTIONS_BUDGET_FRACTION = 0.5;
const REPLY_BODY_CHARS = 500;
const HUNK_TEXT_CHARS = 1_500;
const COMMENT_BODY_CHARS = 1_500;

function commentQuestionKey(facts: OpenCommentFacts): string {
  return facts.id;
}

function questionFor(): CommentChoiceQuestion {
  return {
    type: "choice",
    instructions:
      "The state above is one PR review comment, the deterministic facts about what happened since it was posted, its " +
      "replies (if any), and the code's current hunk(s) at that location (if any). Given all of that, which of the " +
      "criteria best describes this comment's status now?",
    criteria: CHOICE_LABELS,
  };
}

function renderCommentFacts(facts: OpenCommentFacts): string {
  const body = redactSensitiveText(facts.body);
  const boundedBody = body.length > COMMENT_BODY_CHARS ? `${body.slice(0, COMMENT_BODY_CHARS)}\n… (truncated)` : body;
  const repliesText = facts.replies
    .map((reply) => {
      const text = redactSensitiveText(reply.body);
      const bounded = text.length > REPLY_BODY_CHARS ? `${text.slice(0, REPLY_BODY_CHARS)}\n… (truncated)` : text;
      return `  - ${reply.author} at ${reply.submittedAt}: ${bounded}`;
    })
    .join("\n");
  const hunksText = facts.laterHunks
    .map((region) => {
      const text = redactSensitiveText(region.text);
      const bounded = text.length > HUNK_TEXT_CHARS ? `${text.slice(0, HUNK_TEXT_CHARS)}\n… (truncated)` : text;
      return `${region.path}:${region.startLine}-${region.endLine}\n${bounded}`;
    })
    .join("\n\n");
  return [
    `### comment ${facts.id}`,
    ...commentFactLines(facts),
    "comment body (redacted):",
    boundedBody,
    ...(facts.replies.length > 0 ? ["replies (redacted):", repliesText] : []),
    ...(facts.laterHunks.length > 0 ? ["current hunk(s) (redacted):", hunksText] : []),
  ].join("\n");
}

export interface CommentsBatch {
  readonly items: readonly OpenCommentFacts[];
  readonly state: string;
  readonly questions: Readonly<Record<string, CommentChoiceQuestion>>;
}

/** AC3: batch open comments into as few `/systemone` requests as fit the 64k budget — mirrors `src/review/conform-jev.ts`'s `batchConformItems` shape. */
export function batchOpenComments(items: readonly OpenCommentFacts[]): CommentsBatch[] {
  const batches: CommentsBatch[] = [];
  let current: OpenCommentFacts[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      items: current,
      state: current.map(renderCommentFacts).join("\n\n"),
      questions: Object.fromEntries(current.map((item) => [commentQuestionKey(item), questionFor()])),
    });
    current = [];
  };

  for (const item of items) {
    const attempt = [...current, item];
    const stateTokens = estimateTokens(attempt.map(renderCommentFacts).join("\n\n"));
    const questionsTokens = estimateTokens(attempt.map((f) => `${commentQuestionKey(f)}:choice`).join("\n"));
    const withinQuestionsShare = questionsTokens <= COMMENT_TOKEN_BUDGET * QUESTIONS_BUDGET_FRACTION;
    if (current.length > 0 && (stateTokens + questionsTokens > COMMENT_TOKEN_BUDGET || !withinQuestionsShare)) {
      flush();
      current = [item];
    } else {
      current = attempt;
    }
  }
  flush();
  return batches;
}

// ---------------------------------------------------------------------------
// AC4: findings — still-open / needs-escalation only.
// ---------------------------------------------------------------------------

export type CommentsFindingSeverity = "minor" | "major";
export type CommentsFindingConfidence = "high" | "medium" | "low";

export interface CommentsFinding {
  readonly id: string;
  readonly severity: CommentsFindingSeverity;
  readonly file: string | null;
  readonly line: number | null;
  readonly quote: string;
  readonly problem: string;
  readonly impact: string;
  readonly suggested_fix: string;
  readonly evidence: string;
  readonly confidence: CommentsFindingConfidence;
  readonly reviewer: "review-jev-comments";
  readonly dedupe_key: string;
  readonly class_scope?: { readonly sites: readonly string[]; readonly enumeration_method: string };
}

function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** AC4: `still-open`/`needs-escalation` become findings (minor/major); `resolved-by-fix`/`not-actionable` are dropped — never re-opened, never auto-replied. */
export function synthesizeCommentFinding(facts: OpenCommentFacts, choice: JevCommentChoice): CommentsFinding | undefined {
  if (choice !== "still-open" && choice !== "needs-escalation") return undefined;
  const severity: CommentsFindingSeverity = choice === "needs-escalation" ? "major" : "minor";
  const site = `${facts.path ?? "(no file)"}${facts.line !== null ? `:${facts.line}` : ""}`;
  const quote = facts.body.split("\n").find((l) => l.trim().length > 0)?.trim().slice(0, 200) ?? facts.body.slice(0, 200);
  return {
    id: `jev-comments-${shortHash(facts.id)}`,
    severity,
    file: facts.path,
    line: facts.line,
    quote,
    problem:
      choice === "needs-escalation"
        ? `Comment by ${facts.author} at ${site} needs the operator's judgement — Jev classified it "needs-escalation" rather than a reply keryx can make on its own.`
        : `Comment by ${facts.author} at ${site} is still open: ${facts.commitsAfter.length} commit(s) since it was posted touch ${facts.path ?? "no file"}, but nothing addresses it yet.`,
    impact:
      choice === "needs-escalation"
        ? "A comment that blocks progress but nobody is tracking looks resolved simply because rounds kept moving."
        : "An unanswered review comment left unflagged reads as accepted, when it was only unnoticed.",
    suggested_fix:
      choice === "needs-escalation"
        ? `Bring "${facts.author}"'s comment at ${site} to the operator before the next round — it is not a \`keryx review comments reply\` case.`
        : `Address "${facts.author}"'s comment at ${site}, then let \`keryx review comments reply\` mark it handled.`,
    evidence: `Jev choice: ${choice}; thread ${facts.resolved}; ${facts.commitsAfter.length} commit(s) after the comment touching ${facts.path ?? "(no file)"}; ${facts.replies.length} repl(y/ies) on the ledger.`,
    confidence: facts.resolved === "unknown" ? "medium" : "high",
    reviewer: "review-jev-comments",
    dedupe_key: facts.id,
    ...(severity === "major" ? { class_scope: { sites: [site], enumeration_method: "the single PR review comment this finding is about" } } : {}),
  };
}

export function commentsFindingStats(findings: readonly CommentsFinding[]): Readonly<{ blocker: number; major: number; minor: number; info: number }> {
  let major = 0;
  let minor = 0;
  for (const finding of findings) {
    if (finding.severity === "major") major += 1;
    else minor += 1;
  }
  return { blocker: 0, major, minor, info: 0 };
}

export interface JevCommentsRunResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-comments";
  readonly summary: string;
  readonly findings: readonly CommentsFinding[];
  readonly stats: ReturnType<typeof commentsFindingStats>;
}

export function renderJevCommentsMarkdown(result: JevCommentsRunResult): string {
  const lines: string[] = [
    "# review-jev-comments",
    "",
    `status: ${result.status}`,
    result.summary,
    "",
    `stats: blocker=${result.stats.blocker}, major=${result.stats.major}, minor=${result.stats.minor}, info=${result.stats.info}`,
    "",
  ];
  if (result.findings.length === 0) {
    lines.push("_no still-open or escalation-worthy comments_");
    return `${lines.join("\n")}\n`;
  }
  for (const finding of result.findings) {
    lines.push(`## [${finding.id}] ${finding.severity} — ${finding.file ?? "(no file)"}${finding.line !== null ? `:${finding.line}` : ""}`);
    lines.push("");
    lines.push(`- **Problem**: ${finding.problem}`);
    lines.push(`- **Impact**: ${finding.impact}`);
    lines.push(`- **Suggested fix**: ${finding.suggested_fix}`);
    lines.push(`- **Evidence**: ${finding.evidence}`);
    lines.push(`- **Confidence**: ${finding.confidence}`);
    lines.push(`- **Quote**: \`${finding.quote}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * AC4: "surfaced to the existing Step 14 reply flow (`keryx review comments
 * reply`) as an advisory label, never auto-replying or auto-resolving." The
 * label cache the adapter writes after a `jev-comments` run, and
 * `runCommentsReply` reads back best-effort — this module owns only the
 * SHAPE, so both adapters (`review-jev-comments.ts` and `review.ts`'s own
 * `runCommentsReply`) agree on it without either importing the other's CLI.
 */
export interface CommentAdvisoryLabel {
  readonly choice: JevCommentChoice;
  readonly computedAt: string;
}

export type CommentAdvisoryLabels = Readonly<Record<string, CommentAdvisoryLabel>>;
