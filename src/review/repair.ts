// What the pipeline may fill in for a reviewer, and what it must never.
//
// `review ingest` refuses a report that does not satisfy the contract, and that
// is right for anything the reviewer had to DECIDE. It was also refusing things
// the reviewer merely had to TYPE. On 2026-09-12 one round took three
// consecutive refusals — missing `id`, then missing `problem`, then missing
// `class_scope` — and the first of them read:
//
//     Refusing to record two findings under one key:
//     …#undefined claimed by 5 findings.
//
// Nothing in that is a judgement. The ids were absent, the order they were
// reported in was right there, and the round stood still while they were typed
// in by hand.
//
// So two fields are repaired and no others:
//
//   - `id`, from the finding's position in the report. Pure ordering, no claim.
//   - `problem`, from the finding's own `title`, and ONLY from it. `title` is
//     not a contract property — it is dropped on projection — so a reviewer
//     that wrote a one-line statement of the defect currently has it discarded
//     and is then refused for not having stated the defect. Copying the
//     reviewer's own sentence is not the pipeline inventing a claim.
//
// Everything else stays refused. `class_scope` is an enumeration somebody has
// to perform; `evidence` is a thing somebody has to have run; a disposition is
// an outcome somebody has to have observed. Filling any of those in would
// produce a record that validates and says nothing — which is the failure
// `coerceStructured` already documents, and this module is deliberately its
// narrow exception rather than a hole in it.
//
// The acceptance check below is copied in spirit from
// `internal/tool/comment_args_repair.go` in alibaba/open-code-review, where a
// repaired batch is accepted only if it introduces no field the schema does not
// define and preserves the object count. A repair that cannot be checked is a
// corruption nobody notices.

import type { StructuredReviewFinding } from "./types";

/** What was filled in, for whom, and from where. */
export type FindingRepair = {
  /** The finding's `id` AFTER repair — the only name it has that is stable. */
  finding: string;
  field: "id" | "problem";
  /** Where the value came from: a position, or another property of the same finding. */
  source: string;
};

/** The fields this module is permitted to write. Widening it fails `acceptRepair`. */
const REPAIRABLE = new Set(["id", "problem"]);

type LooseFinding = Partial<StructuredReviewFinding> & Record<string, unknown>;

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/** `F-001`, `F-002`, … skipping any number a report already used. */
function mintId(index: number, taken: ReadonlySet<string>): string {
  let n = index + 1;
  let candidate = `F-${String(n).padStart(3, "0")}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `F-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

/**
 * Refuse a repair that did more than it was allowed to.
 *
 * Not defensive programming: it is the guard that makes "we only repair
 * mechanics" checkable instead of merely stated. A later change that starts
 * filling in `class_scope` fails here rather than passing review.
 */
function acceptRepair(before: ReadonlyArray<ReadonlySet<string>>, after: readonly LooseFinding[]): void {
  if (before.length !== after.length) {
    throw new Error(
      `Refusing a repair that changed the number of findings: ${before.length} in, ${after.length} out. A repair may fill fields in; it may never add or drop a finding.`,
    );
  }
  for (const [index, finding] of after.entries()) {
    const had = before[index] as ReadonlySet<string>;
    const added = Object.keys(finding).filter((key) => !had.has(key));
    const illegal = added.filter((key) => !REPAIRABLE.has(key));
    if (illegal.length > 0) {
      throw new Error(
        `Refusing a repair that wrote ${illegal.join(", ")} onto finding ${index + 1}: only ${[...REPAIRABLE].join(" and ")} may be filled in. Everything else is a claim the reviewer has to make.`,
      );
    }
  }
}

/**
 * Fill in `id` and `problem` where they are mechanically recoverable.
 *
 * Mutates in place — the caller owns the array and everything downstream reads
 * the same objects — and returns what it did, so the package can record that a
 * value was supplied rather than authored.
 */
export function repairMechanicalOmissions(findings: LooseFinding[]): FindingRepair[] {
  const before = findings.map((finding) => new Set(Object.keys(finding)));
  const taken = new Set(findings.map((finding) => finding.id).filter((id): id is string => !isBlank(id)));
  const repairs: FindingRepair[] = [];

  for (const [index, finding] of findings.entries()) {
    if (isBlank(finding.id)) {
      const minted = mintId(index, taken);
      taken.add(minted);
      finding.id = minted;
      repairs.push({ finding: minted, field: "id", source: `position ${index + 1} in the report` });
    }
    if (isBlank(finding.problem) && !isBlank(finding["title"])) {
      finding.problem = String(finding["title"]).trim();
      repairs.push({ finding: finding.id as string, field: "problem", source: "the finding's own title" });
    }
  }

  acceptRepair(before, findings);
  return repairs;
}
