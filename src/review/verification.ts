/**
 * The verifier merge: the code that decides what a verification may do to a
 * finding (flow 202, AC7-AC11).
 *
 * ## Why this replaces `review-strict`
 *
 * `review-strict` ran in Wave C and re-read existing findings to adjust their
 * severity with no new evidence, under an elevation table biased 3:1 toward
 * escalation. That operation is measured to make accuracy WORSE:
 *
 * - GPT-4 on GSM8K across self-correction rounds: 95.5 -> 91.5 -> 89.0. GPT-3.5
 *   on CommonSenseQA: 75.8 -> 38.1. Among answers that changed, correct ->
 *   incorrect exceeds incorrect -> correct (Huang et al., ICLR 2024,
 *   arXiv:2310.01798).
 * - Self-Refine (arXiv:2303.17651) shows the same shape from the other side:
 *   +49.2 on dialogue response generation, +0.2 on maths. The gains are on
 *   subjective tasks and vanish on verifiable reasoning. A code review is
 *   verifiable reasoning.
 *
 * So the pass is REMOVED, not improved. What replaces it can only delete, and it
 * reaches its verdict by executing something rather than by re-reading.
 *
 * ## The invariant this module exists to hold
 *
 * **Nothing here can add a finding, change a finding, or raise a severity.** The
 * merged record is built from the ORIGINAL finding; the only thing taken out of a
 * claim is a `verification` object. An escalation is therefore not "rejected by a
 * rule" — there is no code path that could apply one. What the rejection list
 * adds is visibility: an attempt is recorded by name rather than silently
 * ignored, because a filter that drops input without saying so is how the
 * `keryx:findings` block used to fall through to the prose parser.
 *
 * The corollary is why per-claim rejection is safe here while `recordDispositions`
 * had to be atomic: **every rejection path retains the finding.** A malformed,
 * self-verifying, duplicated or mutation-carrying claim can only ever cost a
 * verdict, never a finding. The one thing that removes a finding is a
 * well-formed, non-self, evidenced `refuted` claim in `filter` mode.
 *
 * ## The consensus counter-example
 *
 * Nothing here votes, and that is deliberate. 80+ agents unanimously endorsed a
 * padding-oracle vulnerability that did not exist; a single empirical test killed
 * it. Consensus cannot detect a hallucination its members share, so agreement is
 * not a verification method and does not appear in {@link VERIFICATION_METHODS}.
 */

import {
  DEFAULT_VERIFICATION_MODE,
  REASONING_CAPPED_VERDICT,
  VERIFICATION_METHODS,
  VERIFICATION_MODES,
  VERIFICATION_VERDICTS,
  type ReviewFindingVerification,
  type ReviewScopeCountsLike,
  type ReviewScopeDropLike,
  type StructuredReviewFinding,
  type VerificationClaimInput,
  type VerificationMethod,
  type VerificationMode,
  type VerificationSource,
  type VerificationVerdict,
} from "./types";

/** The only properties a claim may carry. Anything else is a mutation attempt. */
export const VERIFICATION_CLAIM_PROPERTIES = [
  "finding",
  "verdict",
  "method",
  "evidence",
  "verifier",
] as const;

/**
 * Why a claim was discarded. Every one of these leaves the finding in place.
 *
 * `mutation` is the AC8 case and is listed alongside the malformed ones on
 * purpose: an attempted escalation is not a special kind of error, it is simply
 * a claim carrying a property the verifier has no authority over.
 */
export const VERIFICATION_REJECTION_REASONS = [
  "mode-off",
  "unknown-finding",
  "ambiguous-finding",
  "conflicting-claims",
  "mutation",
  "unknown-verdict",
  "unknown-method",
  "no-evidence",
  "no-verifier",
  "self-verification",
] as const;
export type VerificationRejectionReason = (typeof VERIFICATION_REJECTION_REASONS)[number];

export type VerificationRejection = {
  /** The finding the claim named, verbatim, so an unresolvable one is still legible. */
  finding: string;
  reason: VerificationRejectionReason;
  /** What was wrong, in words, rendered into the review record. */
  detail: string;
};

/** A verdict a reasoning-only claim was not allowed to reach. */
export type VerificationCap = {
  finding: string;
  claimed: VerificationVerdict;
  recorded: VerificationVerdict;
  detail: string;
};

export type VerificationCounts = {
  mode: VerificationMode;
  /** Claims received, including the ones discarded. */
  claims: number;
  /** Claims whose verdict reached a finding. `claims = applied + rejected`. */
  applied: number;
  rejected: number;
  capped: number;
  confirmed: number;
  refuted: number;
  unverifiable: number;
  /** Findings carrying no verification at all. Not a synonym for droppable. */
  unverified: number;
  findingsIn: number;
  findingsRetained: number;
  /** Removed by the verifier. Always 0 outside `filter` mode. */
  findingsRefuted: number;
};

export type VerificationMergeResult<T> = {
  retained: T[];
  /** Findings a `refuted` verdict removed. Empty unless mode is `filter`. */
  refuted: T[];
  rejections: VerificationRejection[];
  caps: VerificationCap[];
  counts: VerificationCounts;
};

export type MergeVerificationsOptions = {
  mode?: VerificationMode | undefined;
};

/** The wrapper form a verifier returns, flattened; the wrapper names the verifier. */
export function verificationClaims(source: VerificationSource | undefined): VerificationClaimInput[] {
  if (source === undefined) {
    return [];
  }
  if (Array.isArray(source)) {
    return [...source];
  }
  const wrapper = source as { verifier?: string | undefined; verifications: readonly VerificationClaimInput[] };
  if (!Array.isArray(wrapper.verifications)) {
    throw new Error(
      "A verifier result must be an array of claims or `{ verifier, verifications: [...] }`. Nothing was merged.",
    );
  }
  return wrapper.verifications.map((claim) =>
    claim.verifier === undefined && wrapper.verifier !== undefined
      ? { ...claim, verifier: wrapper.verifier }
      : { ...claim },
  );
}

export function isVerificationMode(value: unknown): value is VerificationMode {
  return typeof value === "string" && (VERIFICATION_MODES as readonly string[]).includes(value);
}

/**
 * Apply verification claims to findings, deleting at most and never adding.
 *
 * The findings are not mutated: each retained entry is a new object built from
 * the original plus, at most, a `verification`.
 */
export function mergeVerifications<T extends StructuredReviewFinding>(
  findings: readonly T[],
  claims: readonly VerificationClaimInput[],
  options: MergeVerificationsOptions = {},
): VerificationMergeResult<T> {
  const mode = options.mode ?? DEFAULT_VERIFICATION_MODE;
  const rejections: VerificationRejection[] = [];
  const caps: VerificationCap[] = [];

  if (mode === "off") {
    // Refused, not ignored. A caller that supplied verdicts and got silence back
    // would read the empty result as "nothing was refuted".
    for (const claim of claims) {
      rejections.push({
        finding: claimName(claim),
        reason: "mode-off",
        detail: "verification_mode is `off`; no verdict was read. Set `annotate` to record it.",
      });
    }
    return finish(findings, new Map(), mode, claims.length, 0, rejections, caps);
  }

  // Pass 1: resolve and validate. Nothing is applied yet, because a conflict is
  // only visible once every claim has been resolved.
  const accepted = new Map<string, Array<{ finding: T; verification: ReviewFindingVerification }>>();
  for (const claim of claims) {
    const name = claimName(claim);
    const extra = unknownProperties(claim);
    if (extra.length > 0) {
      // AC8. The claim is discarded WHOLE rather than stripped down to its
      // verdict: a producer that tried to rewrite the finding has told us it
      // believes it may, and taking the verdict from it anyway would accept the
      // half of its output we happen to allow.
      rejections.push({
        finding: name,
        reason: "mutation",
        detail: `the claim carried ${extra.join(", ")}. A verifier can only delete: it cannot raise a severity, add a finding, or change a finding's text.`,
      });
      continue;
    }

    const matches = findings.filter(
      (finding) => finding.global_id === claim.finding || finding.id === claim.finding,
    );
    if (matches.length === 0) {
      rejections.push({
        finding: name,
        reason: "unknown-finding",
        detail: "this round reported no such finding. A verifier cannot introduce one.",
      });
      continue;
    }
    if (matches.length > 1) {
      rejections.push({
        finding: name,
        reason: "ambiguous-finding",
        detail: `names ${matches.length} findings; use the global_id (${matches
          .map((finding) => finding.global_id ?? finding.id)
          .join(", ")}).`,
      });
      continue;
    }
    const target = matches[0] as T;

    if (!isVerdict(claim.verdict)) {
      rejections.push({
        finding: name,
        reason: "unknown-verdict",
        detail: `verdict ${JSON.stringify(claim.verdict)} is not one of ${VERIFICATION_VERDICTS.join(", ")}.`,
      });
      continue;
    }
    if (!isMethod(claim.method)) {
      rejections.push({
        finding: name,
        reason: "unknown-method",
        detail: `method ${JSON.stringify(claim.method)} is not one of ${VERIFICATION_METHODS.join(", ")}.`,
      });
      continue;
    }
    if (typeof claim.evidence !== "string" || claim.evidence.trim() === "") {
      rejections.push({
        finding: name,
        reason: "no-evidence",
        detail:
          "a verdict with nothing behind it is the operation this replaces. Give the command that ran, or the search that found the sites.",
      });
      continue;
    }
    if (typeof claim.verifier !== "string" || actorKey(claim.verifier) === "") {
      // Not pedantry: AC9 is unenforceable against an anonymous claim, and a
      // record that does not say who verified cannot be audited for it later.
      // Keyed rather than trimmed, so a name that is only punctuation — `"()"`
      // normalises away to nothing — is anonymous rather than a distinct actor.
      rejections.push({
        finding: name,
        reason: "no-verifier",
        detail: "a claim that does not say who made it cannot be checked against the never-self-verify rule.",
      });
      continue;
    }
    if (actorKey(claim.verifier) === actorKey(target.reviewer)) {
      // AC9. The reviewer that raised a finding is the one actor whose agreement
      // carries no information about it.
      rejections.push({
        finding: name,
        reason: "self-verification",
        detail: `${claim.verifier} raised this finding (recorded as ${target.reviewer}) and cannot verify it. Dispatch a different reviewer.`,
      });
      continue;
    }

    let verdict: VerificationVerdict = claim.verdict;
    if (claim.method === "reasoning" && verdict !== REASONING_CAPPED_VERDICT) {
      caps.push({
        finding: target.global_id ?? target.id,
        claimed: verdict,
        recorded: REASONING_CAPPED_VERDICT,
        detail:
          "reasoning alone produces no new evidence, so it records `unverifiable`. Run something, or check the class_scope sites.",
      });
      verdict = REASONING_CAPPED_VERDICT;
    }

    const key = target.global_id ?? target.id;
    const verification: ReviewFindingVerification = {
      verdict,
      method: claim.method,
      evidence: claim.evidence,
      verifier: claim.verifier,
    };
    accepted.set(key, [...(accepted.get(key) ?? []), { finding: target, verification }]);
  }

  // Pass 2: a finding claimed twice keeps neither verdict WHEN THE CLAIMS
  // DISAGREE. Taking the first would let claim order decide whether a finding
  // survives, and the safe resolution of a conflict is the one that cannot
  // delete.
  //
  // Agreement is not a conflict, and treating it as one discarded the strongest
  // evidence the pipeline can produce: two verifiers independently reaching
  // `confirmed`, each having run something, cancelled each other and the finding
  // was recorded as unverified with a rejection row calling it a conflict. The
  // safe-direction argument is about ORDER deciding an outcome; when every claim
  // says the same thing there is no order to decide anything. Note this is not
  // consensus voting — the module header's counter-example stands. A unanimous
  // group still had to survive every per-claim gate: each verdict was reached by
  // a named non-author with evidence, and a `reasoning` claim was already capped
  // before it got here, so agreement adds no authority it did not each have.
  const applied = new Map<string, ReviewFindingVerification>();
  // Claims, not findings: a unanimous pair applies TWO claims to one finding, and
  // `claims_received = claims_applied + claims_rejected` has to keep holding or
  // the record's arithmetic silently stops adding up.
  let appliedClaims = 0;
  for (const [key, group] of accepted) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    if (group.length === 1) {
      applied.set(key, first.verification);
      appliedClaims += 1;
      continue;
    }
    const verdicts = new Set(group.map((entry) => entry.verification.verdict));
    if (verdicts.size > 1) {
      rejections.push({
        finding: key,
        reason: "conflicting-claims",
        detail: `${group.length} claims for one finding disagree (${group
          .map((entry) => `${entry.verification.verifier}: ${entry.verification.verdict}`)
          .join(", ")}). None is applied; the finding stays unverified.`,
      });
      continue;
    }
    applied.set(key, unanimous(group.map((entry) => entry.verification)));
    appliedClaims += group.length;
  }

  return finish(findings, applied, mode, claims.length, appliedClaims, rejections, caps);
}

function finish<T extends StructuredReviewFinding>(
  findings: readonly T[],
  applied: ReadonlyMap<string, ReviewFindingVerification>,
  mode: VerificationMode,
  claimCount: number,
  appliedClaims: number,
  rejections: VerificationRejection[],
  caps: VerificationCap[],
): VerificationMergeResult<T> {
  const retained: T[] = [];
  const refuted: T[] = [];
  const counts: VerificationCounts = {
    mode,
    claims: claimCount,
    applied: appliedClaims,
    rejected: rejections.length,
    capped: caps.length,
    confirmed: 0,
    refuted: 0,
    unverifiable: 0,
    unverified: 0,
    findingsIn: findings.length,
    findingsRetained: 0,
    findingsRefuted: 0,
  };

  for (const finding of findings) {
    const verification = applied.get(finding.global_id ?? finding.id);
    if (verification === undefined) {
      counts.unverified += 1;
      retained.push(finding);
      continue;
    }
    counts[verification.verdict] += 1;
    // The merged record is the ORIGINAL plus a verification. Nothing else from
    // the claim reaches it, which is where "can only delete" is enforced.
    const merged = { ...finding, verification } as T;
    if (verification.verdict === "refuted" && mode === "filter") {
      refuted.push(merged);
      continue;
    }
    retained.push(merged);
  }

  counts.findingsRetained = retained.length;
  counts.findingsRefuted = refuted.length;
  return { retained, refuted, rejections, caps, counts };
}

/**
 * One verification standing for several that reached the same verdict.
 *
 * Every verifier and every piece of evidence is carried, because the record has
 * to say who checked — AC9 is audited off this field afterwards, and collapsing
 * two checks into one name would hide the second actor exactly as `reviewer`
 * hardcoded to `review-orchestrator` hid the first. The STRONGEST method is the
 * one recorded, since the group's verdict is at least as well supported as its
 * best-supported member.
 */
function unanimous(verifications: readonly ReviewFindingVerification[]): ReviewFindingVerification {
  const head = verifications[0] as ReviewFindingVerification;
  if (verifications.length === 1) {
    return head;
  }
  const verifiers: string[] = [];
  for (const verification of verifications) {
    const named = verification.verifier ?? "<unnamed>";
    if (!verifiers.includes(named)) {
      verifiers.push(named);
    }
  }
  const strongest = [...verifications].sort(
    (left, right) => VERIFICATION_METHODS.indexOf(left.method) - VERIFICATION_METHODS.indexOf(right.method),
  )[0] as ReviewFindingVerification;
  return {
    verdict: head.verdict,
    method: strongest.method,
    evidence: verifications
      .map((verification) => `${verification.verifier ?? "<unnamed>"} (${verification.method}): ${verification.evidence}`)
      .join("; "),
    verifier: verifiers.join(", "),
  };
}

function claimName(claim: VerificationClaimInput): string {
  return typeof claim.finding === "string" && claim.finding !== "" ? claim.finding : "<unnamed>";
}

/**
 * An actor name reduced to what identifies it, for the AC9 comparison only.
 *
 * `verifier` and `reviewer` are free text a model fills in. Comparing them with
 * `===` made AC9 a formatting coincidence: `"review-logic "`, `" review-logic"`,
 * `"Review-Logic"` and `"review-logic(sonnet)"` all walked past the guard, and
 * in `filter` mode that is a blocker deleted by its own author with no rejection
 * row to show it happened.
 *
 * Deliberately OVER-matching, because the two directions cost different things.
 * A false self-verification costs a verdict and the finding is retained — every
 * rejection path in this module retains the finding. A missed one costs the
 * finding itself. So a trailing model annotation is stripped and separators are
 * folded, and `review-logician` still reads as a different actor because nothing
 * here does prefix matching.
 */
function actorKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unknownProperties(claim: VerificationClaimInput): string[] {
  return Object.keys(claim)
    .filter((key) => !(VERIFICATION_CLAIM_PROPERTIES as readonly string[]).includes(key))
    .sort();
}

function isVerdict(value: unknown): value is VerificationVerdict {
  return typeof value === "string" && (VERIFICATION_VERDICTS as readonly string[]).includes(value);
}

function isMethod(value: unknown): value is VerificationMethod {
  return typeof value === "string" && (VERIFICATION_METHODS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Stage counts (AC11)
// ---------------------------------------------------------------------------

export type ReviewStageCountsInput = {
  /** From `keryx review scope --json`. Absent means no pre-filter ran. */
  preFilter?: ReviewScopeCountsLike | undefined;
  /**
   * One row per drop, with its reason. This is the AC5 half: eight integers say
   * how much vanished and never why, and "files_dropped: 2" is indistinguishable
   * from two source files dropped by mistake.
   */
  preFilterDrops?: readonly ReviewScopeDropLike[] | undefined;
  /**
   * True when a `## Pre-filter scope` block already present in the package's
   * `scope.md` is being carried forward verbatim rather than overwritten.
   *
   * It changes one sentence, and the sentence is the point: with a block carried
   * forward, "no pre-filter scope was supplied to this package" is FALSE, and
   * writing a false statement over a true record is worse than writing nothing.
   */
  preFilterCarried?: boolean | undefined;
  verification: VerificationCounts;
  rejections?: readonly VerificationRejection[] | undefined;
  caps?: readonly VerificationCap[] | undefined;
};

/**
 * What each stage removed, in the form the review record carries.
 *
 * Written even when both stages are trivial, because AC15 constrains every claim
 * this flow makes to these numbers: there is no precision figure to improve on,
 * so "dropped, refuted, retained" is the only thing any of it can be checked
 * against afterwards.
 *
 * The pre-filter half prints `not recorded` rather than zeroes when no scope was
 * supplied. "Dropped nothing" and "never ran" are different facts, and a record
 * that renders them identically is the same defect as `dismissed-out-of-scope: 0`
 * meaning "not written down".
 */
export function renderStageCountsMarkdown(input: ReviewStageCountsInput): string {
  const lines: string[] = [];
  lines.push("## Stage counts");
  lines.push("");
  lines.push("Stated as counts, never as a precision figure: no precision baseline");
  lines.push("exists to improve on (see the flow's baseline.md — 53/53 = 100% by");
  lines.push("construction, refused as a baseline).");
  lines.push("");
  lines.push("### Dropped by the pre-filter");
  lines.push("");
  if (input.preFilter === undefined) {
    if (input.preFilterCarried === true) {
      lines.push("no `--scope` was passed to this ingest, but this package already");
      lines.push("carried a `## Pre-filter scope` block written by `keryx review scope");
      lines.push("--append`. It is reproduced verbatim below rather than overwritten.");
    } else {
      lines.push("not recorded — no pre-filter scope was supplied to this package.");
      lines.push("This is NOT `dropped 0`: nothing ran, so nothing is known.");
    }
  } else {
    const counts = input.preFilter;
    lines.push(`files_seen: ${counts.filesSeen}`);
    lines.push(`files_retained: ${counts.filesRetained}`);
    lines.push(`files_dropped: ${counts.filesDropped}`);
    lines.push(`blocks_seen: ${counts.blocksSeen}`);
    lines.push(`blocks_retained: ${counts.blocksRetained}`);
    lines.push(`blocks_dropped: ${counts.blocksDropped}`);
    lines.push(`changed_lines_retained: ${counts.changedLinesRetained}`);
    lines.push(`changed_lines_dropped: ${counts.changedLinesDropped}`);
    lines.push("");
    // AC5, verbatim: "with a reason per drop". The counts above answer how much,
    // and only these rows answer what and why.
    const drops = input.preFilterDrops;
    if (drops === undefined && input.preFilterCarried === true) {
      lines.push("per-drop rows: in the `## Pre-filter scope` block carried forward below,");
      lines.push("written by `keryx review scope --append` and not overwritten by this ingest.");
    } else if (drops === undefined) {
      lines.push("per-drop rows: not supplied — only the counts reached this package.");
      lines.push("Pass the whole `keryx review scope --json` document, not just its `counts`.");
    } else if (drops.length === 0) {
      lines.push("_the pre-filter ran and dropped nothing_");
    } else {
      lines.push("| path | where | reason | why |");
      lines.push("|---|---|---|---|");
      for (const drop of drops) {
        const where =
          drop.granularity === "file"
            ? "whole file"
            : `lines ${drop.startLine ?? "?"}-${drop.endLine ?? "?"} (${drop.changedLines})`;
        lines.push(`| ${escapePipes(drop.path)} | ${where} | ${escapePipes(drop.reason)} | ${escapePipes(drop.detail)} |`);
      }
    }
  }
  lines.push("");

  const verification = input.verification;
  lines.push("### Refuted by the verifier");
  lines.push("");
  lines.push(`verification_mode: ${verification.mode}`);
  lines.push(`claims_received: ${verification.claims}`);
  lines.push(`claims_applied: ${verification.applied}`);
  lines.push(`claims_rejected: ${verification.rejected}`);
  lines.push(`verdicts_capped_to_unverifiable: ${verification.capped}`);
  lines.push(`confirmed: ${verification.confirmed}`);
  lines.push(`refuted: ${verification.refuted}`);
  lines.push(`unverifiable: ${verification.unverifiable}`);
  lines.push(`unverified: ${verification.unverified}`);
  lines.push("");
  lines.push("### Retained");
  lines.push("");
  lines.push(`findings_in: ${verification.findingsIn}`);
  lines.push(`findings_removed_by_verifier: ${verification.findingsRefuted}`);
  lines.push(`findings_retained: ${verification.findingsRetained}`);
  if (verification.mode === "annotate" && verification.refuted > 0) {
    lines.push("");
    lines.push(
      `\`annotate\` records verdicts and removes nothing: ${verification.refuted} finding(s) are marked refuted and still reported.`,
    );
  }
  lines.push("");

  const rejections = input.rejections ?? [];
  lines.push("### Verification claims discarded");
  lines.push("");
  if (rejections.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| finding | reason | why |");
    lines.push("|---|---|---|");
    for (const rejection of rejections) {
      lines.push(`| ${escapePipes(rejection.finding)} | ${rejection.reason} | ${escapePipes(rejection.detail)} |`);
    }
    lines.push("");
    lines.push("Every discarded claim leaves its finding in place: a claim can cost a verdict, never a finding.");
  }
  lines.push("");

  const caps = input.caps ?? [];
  if (caps.length > 0) {
    lines.push("### Verdicts capped");
    lines.push("");
    lines.push("| finding | claimed | recorded | why |");
    lines.push("|---|---|---|---|");
    for (const cap of caps) {
      lines.push(`| ${escapePipes(cap.finding)} | ${cap.claimed} | ${cap.recorded} | ${escapePipes(cap.detail)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}
