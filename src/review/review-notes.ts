// The far end of the dismissal taxonomy: the signal that reaches the learning
// loop (roadmap §5.2, flow 207 AC4-AC6).
//
// WHY THIS FILE EXISTS
//
// Half of §5.2 was already built. `FINDING_DISPOSITION_STATES` carries the
// four-way split, `managed.ts` maps `dismissed-incorrect` to `false_positive`,
// and the review gate holds each state to its own evidence bar. What did not
// exist was the other end: `.metaproject/memory/review-notes/` was never
// created, the `review-note` memory type had never been written, and so **the
// learning loop had produced nothing at all**. A taxonomy that classifies
// perfectly and reaches no consumer measures nothing.
//
// That matters more now than when the roadmap was written, because
// `keryx review learn` — a reviewer that learns from local review comments —
// shipped alongside this and depends on the signal being real.
//
// THE ONE DISTINCTION EVERYTHING HERE TURNS ON
//
// **Only `dismissed-incorrect` is model error.** `dismissed-wont-fix`,
// `dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
// were CORRECT and that the team chose not to act on. Feeding those into a
// learning signal teaches the reviewer to stop raising true findings, which is
// the opposite of the intent and is indistinguishable, in the resulting
// `SKILL.md`, from having learned something. See {@link MODEL_ERROR_STATES}.
//
// WHY A NOTE NEEDS AN ATTESTATION (AC6)
//
// Flow 204's AC6 stands unchanged: the orchestrator may not dismiss on its own
// authority. This module does not relax that and does not restate it — it
// refuses to manufacture a learning signal out of an unattested dismissal. A
// note is written only when the record already carries either a named human
// decision or an independent verifier's `refuted` verdict; otherwise nothing is
// written and the omission is reported by name. The alternative is a pipeline in
// which an orchestrator files a finding as its own error, teaches a skill from
// it, and moves on with nobody having looked.

import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { memoryRoot } from "../memory/store";
import type { FindingDispositionState, StructuredReviewFinding } from "./types";

/**
 * The dismissal states that say the reviewer was WRONG.
 *
 * One member, and the single-element array is the point rather than an
 * accident: it is the list a future reader will be tempted to extend, and it is
 * declared with the reason attached so the temptation is answered where it
 * arises. `answered-disagree` is not a member either — it says our verifier
 * disagreed with somebody ELSE's comment, which answers nothing about whether
 * our reviewers were right.
 */
export const MODEL_ERROR_STATES = ["dismissed-incorrect"] as const satisfies ReadonlyArray<FindingDispositionState>;

export function isModelErrorState(state: string | undefined): boolean {
  return state !== undefined && (MODEL_ERROR_STATES as readonly string[]).includes(state);
}

/** A finding, as this module needs to read it. */
export type DismissibleFinding = Pick<StructuredReviewFinding, "id" | "reviewer" | "severity" | "problem"> &
  Partial<Pick<StructuredReviewFinding, "global_id" | "file" | "line" | "disposition" | "verification" | "source">>;

/**
 * The model-error signal for a set of findings.
 *
 * `dismissed_not_model_error` is carried beside `model_error` deliberately: the
 * two numbers together are what makes a dismissal rate readable, and a report
 * that gave only the first would be indistinguishable from one that had
 * conflated the four states and happened to be looking at a quiet round.
 */
export type ModelErrorSignal = {
  /** Findings whose recorded disposition is a model error. */
  model_error: number;
  /** Findings dismissed for a reason that is NOT model error. */
  dismissed_not_model_error: number;
  /** Every dismissal state seen, with its count. */
  by_state: Record<string, number>;
};

/**
 * Count the signal, keeping the four states apart.
 *
 * Nothing here reads `classification`. `false_positive` is derived FROM the
 * disposition by `managed.ts` and a record can carry one without the other; the
 * disposition is the field a human wrote and the field the gate holds to an
 * evidence bar, so it is the one that decides.
 */
export function modelErrorSignal(findings: readonly DismissibleFinding[]): ModelErrorSignal {
  const byState: Record<string, number> = {};
  let modelError = 0;
  let other = 0;
  for (const finding of findings) {
    const state = finding.disposition?.state;
    if (state === undefined || !state.startsWith("dismissed-")) {
      continue;
    }
    byState[state] = (byState[state] ?? 0) + 1;
    if (isModelErrorState(state)) {
      modelError += 1;
    } else {
      other += 1;
    }
  }
  return { model_error: modelError, dismissed_not_model_error: other, by_state: byState };
}

// ---------------------------------------------------------------------------
// Attestation (AC6)
// ---------------------------------------------------------------------------

/**
 * What a recorded human decision looks like inside a disposition's evidence.
 *
 * Deliberately the same rule as the review gate applies to the other three
 * dismissal states (`src/flow/review-gate.ts`), and pinned to it by a test that
 * drives `findingVerdict` rather than by this comment. It is an ATTRIBUTION
 * requirement, not an identity proof: nothing here can stop an orchestrator
 * writing `human: alice` about a decision alice never made. What it guarantees
 * is that filing a finding as model error requires naming a person, in a form an
 * auditor can grep for and alice can contradict.
 */
export const HUMAN_DECISION_PATTERN = /\b(human|operator|reviewer|decided[-\s]?by|approved[-\s]?by|owner)\s*[:=]\s*\S/i;

export type ReviewNoteAttestation =
  | { kind: "human"; detail: string }
  | { kind: "verifier"; detail: string }
  | { kind: "none"; detail: string };

/**
 * Who stands behind this dismissal, or nobody.
 *
 * A human decision is preferred over a verifier verdict when both are present,
 * because the note is a record of a DECISION and the person outranks the
 * machine that supported it.
 */
export function attestDismissal(finding: DismissibleFinding): ReviewNoteAttestation {
  const evidence = finding.disposition?.evidence;
  if (typeof evidence === "string" && HUMAN_DECISION_PATTERN.test(evidence)) {
    return { kind: "human", detail: evidence };
  }
  const verification = finding.verification;
  if (
    verification?.verdict === "refuted" &&
    typeof verification.method === "string" &&
    typeof verification.evidence === "string" &&
    verification.evidence.trim() !== ""
  ) {
    return {
      kind: "verifier",
      detail: `${verification.verifier ?? "an unnamed verifier"} (${verification.method}): ${verification.evidence}`,
    };
  }
  return {
    kind: "none",
    detail:
      "no recorded human decision and no independent verifier `refuted` verdict with a method and evidence. The orchestrator may not file a finding as its own error on its own authority, so no learning note was written.",
  };
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

export function reviewNotesDir(cwd: string): string {
  return path.join(memoryRoot(cwd), "review-notes");
}

/** `<reviewId>__<finding>.md`, so a re-run overwrites its own note. */
export function reviewNotePath(cwd: string, reviewId: string, findingId: string): string {
  return path.join(reviewNotesDir(cwd), `${slug(reviewId)}__${slug(findingId)}.md`);
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

export type ReviewNoteContext = {
  cwd: string;
  reviewId: string;
  /** The commit the round ran against, when one was resolved. */
  head?: string | null | undefined;
  /** Package directory, relative to `cwd`, so the note can point back at it. */
  packagePath?: string | undefined;
  now?: Date | undefined;
};

/**
 * One note, in the shape `src/memory/store.ts` parses.
 *
 * The header fields and the section names are not decoration: `collectEntries`
 * reads `Type`, `Status`, `Confidence` and `## Summary` off the file, and
 * `keryx memory check` refuses an entry with no `Version` or an empty summary.
 * A note written in a shape the memory module does not read would satisfy "a
 * file was created" and nothing else, which is the failure this whole flow is
 * about.
 *
 * `Status: draft` on purpose. Only `accepted` entries influence skills, and an
 * automatically written record of a review round is exactly the thing a person
 * should promote deliberately rather than the thing that should start steering
 * the reviewer on its own.
 */
export function renderReviewNote(finding: DismissibleFinding, context: ReviewNoteContext): string {
  const at = (context.now ?? new Date()).toISOString().slice(0, 10);
  const attestation = attestDismissal(finding);
  const name = finding.global_id ?? finding.id;
  const where = finding.file ? `\`${finding.file}\`${finding.line ? `:${finding.line}` : ""}` : "not located";
  const evidence = finding.disposition?.evidence ?? "no evidence recorded";

  return `# Review finding ${name} was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

${finding.reviewer} raised ${name} (${finding.severity}) and the round recorded it as \`dismissed-incorrect\` — the one disposition that says the reviewer was wrong.

## Details

- Finding: \`${name}\` (display id \`${finding.id}\`)
- Reviewer: \`${finding.reviewer}\`
- Severity: \`${finding.severity}\`
- Location: ${where}
- Origin: \`${finding.source ?? "internal"}\`
- What it claimed: ${finding.problem}
- Why it was dismissed: ${evidence}
- Attested by: ${attestation.kind} — ${attestation.detail}

Only \`dismissed-incorrect\` reaches this folder. \`dismissed-wont-fix\`,
\`dismissed-out-of-scope\` and \`dismissed-deprioritised\` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: ${context.packagePath ?? `round ${context.reviewId}`}
- Created: ${at}
- Updated: ${at}

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:${context.reviewId}
- commit:${context.head ?? "unrecorded"}

## Changelog

- 0.1.0 - Written by \`keryx review\` when the finding was dismissed as incorrect.
`;
}

export type ReviewNoteWritten = {
  finding: string;
  /** Path relative to `cwd`. */
  path: string;
  attestation: ReviewNoteAttestation["kind"];
};

export type ReviewNoteSkipped = {
  finding: string;
  reason: string;
};

export type ReviewNoteResult = {
  written: ReviewNoteWritten[];
  /** Dismissals that reached no note, and why. Never silent. */
  skipped: ReviewNoteSkipped[];
};

/**
 * Write one note per `dismissed-incorrect` finding, and nothing for the rest.
 *
 * Called from both ends of the pipeline — the ingest that records a round's
 * dismissals and the `review complete` that records a human's — because those
 * are the two places a `dismissed-incorrect` becomes durable, and a writer
 * attached to only one of them would leave the other producing model errors
 * nothing learns from.
 *
 * Writing is best-effort in exactly one direction: a note is never written for
 * an unattested dismissal (AC6), and the skip is returned rather than swallowed
 * so the caller can print it. It is not best-effort about failures — an
 * unwritable memory directory throws, because a learning loop that silently
 * writes nothing is the state this flow exists to end.
 */
export async function writeReviewNotes(
  findings: readonly DismissibleFinding[],
  context: ReviewNoteContext,
): Promise<ReviewNoteResult> {
  const written: ReviewNoteWritten[] = [];
  const skipped: ReviewNoteSkipped[] = [];

  for (const finding of findings) {
    if (!isModelErrorState(finding.disposition?.state)) {
      continue;
    }
    const name = finding.global_id ?? finding.id;
    const attestation = attestDismissal(finding);
    if (attestation.kind === "none") {
      skipped.push({ finding: name, reason: attestation.detail });
      continue;
    }
    const file = reviewNotePath(context.cwd, context.reviewId, finding.id);
    await writeFileAtomic(file, renderReviewNote(finding, context));
    written.push({ finding: name, path: path.relative(context.cwd, file), attestation: attestation.kind });
  }

  return { written, skipped };
}
