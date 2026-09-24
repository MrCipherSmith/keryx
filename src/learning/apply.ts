// `keryx learn apply` (W3 spec "Apply"; plan module table; flow 312 T9).
//
// For a `domain` other than `review-conventions`, renders the accepted
// record's `trigger`/`action` into a `LearningProposal` (`src/gdskills/learn.ts`'s
// existing shape) under `.metaproject/data/gdskills/proposals/`, then calls
// the existing `applyLearningProposal` — still the only writer into
// `.metaproject/project-skills/`. A `domain: "review-conventions"` record is
// refused here: it is applied through `keryx review learn --reviewer <id>`
// (`reviewer-profile.ts`), not through this path.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { isPathInside, withFileLock, writeFileAtomic } from "../lib/fs";
import { renderProposalMarkdown, resolveRegisteredSkillTarget, suggestedSectionsFor } from "../gdskills/learn";
import type { ApplyLearningProposalResult, LearningProposal, LearningSourceType } from "../gdskills/learn";
import { applyLearningProposal } from "../gdskills/learn";
import { loadReviewLearningConfigSafe } from "../review/review-learning";
import { containsConfiguredLogin, mayCarryReviewerText, stripReviewerCommentTriggerPrefix } from "./reviewer-id";
import { scanLearnedText } from "./scan";
import { readPattern, type StoreEnvOptions } from "./store";
import type { EvidenceSourceType, LearnedPattern, LearningDomain } from "./types";

export class LearningApplyError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LearningApplyError";
  }
}

export interface ApplyLearnedPatternOptions {
  /** `<module>/<name>` — the target project skill, same shape `keryx skills learn --skill` already takes. */
  skill: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ApplyLearnedPatternResult {
  proposalPath: string;
  applied: ApplyLearningProposalResult;
}

const MIN_LESSON_LEN = 12;
const MAX_LESSON_LEN = 260;

/** First matching evidence item's `sourceType`, mapped onto `learn.ts`'s narrower `LearningSourceType` — takes priority over the domain fallback below because it is the more concrete signal. */
const EVIDENCE_TO_SOURCE_TYPE: Partial<Record<EvidenceSourceType, LearningSourceType>> = {
  review: "review",
  "reviewer-comment": "review",
  test: "test",
  failure: "failure",
  health: "health",
  memory: "memory",
};

/** Fallback when no evidence item maps directly (e.g. `sourceType: "observation"` only). `review-conventions` is unreachable here — `applyLearnedPattern` refuses that domain before this runs — but the table stays total so a future caller of the pure function never gets `undefined`. */
const DOMAIN_TO_SOURCE_TYPE: Record<LearningDomain, LearningSourceType> = {
  "code-style": "memory",
  architecture: "memory",
  testing: "test",
  security: "failure",
  "review-conventions": "review",
  workflow: "memory",
  documentation: "memory",
  performance: "health",
  tooling: "memory",
  other: "memory",
};

function sourceTypeFor(record: LearnedPattern): LearningSourceType {
  for (const item of record.evidence) {
    const mapped = EVIDENCE_TO_SOURCE_TYPE[item.sourceType];
    if (mapped !== undefined) return mapped;
  }
  return DOMAIN_TO_SOURCE_TYPE[record.domain];
}

/** `learn.ts`'s own 12-260 char lesson bound (`extractLessons`/`healthLessonsForSkill`) — a text outside it is dropped rather than written as a lesson nobody's extractor would have kept. */
function fitsLessonBounds(text: string): boolean {
  return text.length >= MIN_LESSON_LEN && text.length <= MAX_LESSON_LEN;
}

/** `[action]`, plus `trigger` as context when it independently fits the bound and differs from `action`. */
function lessonsFor(record: LearnedPattern): string[] {
  const lessons: string[] = [];
  if (fitsLessonBounds(record.action)) lessons.push(record.action);
  if (fitsLessonBounds(record.trigger) && record.trigger !== record.action) lessons.push(record.trigger);
  return lessons;
}

function timestampCompact(now: Date): string {
  return now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

/** The record's own store path, relative to root — always `.metaproject/data/learning/candidates/<id>.json`: `applyLearnedPattern` only ever reads a project-scope record. */
function candidateSourcePath(id: string): string {
  return path.posix.join(".metaproject", "data", "learning", "candidates", `${id}.json`);
}

/**
 * Pure: renders an accepted `LearnedPattern` into the `LearningProposal`
 * shape `src/gdskills/learn.ts` already expects, carrying `confidenceLevel`
 * forward as `LearningProposal.confidence`. Deterministic in every input
 * (`now`), so callers can compute a proposal without touching disk.
 */
export function learnedPatternToProposal(
  record: LearnedPattern,
  skill: { module: string; name: string; path: string; target: string },
  now: Date,
  dryRun = false,
): LearningProposal {
  const sourceType = sourceTypeFor(record);
  const proposalId = `learned-${record.id}-${timestampCompact(now)}`;
  const proposalPath = path.posix.join(".metaproject", "data", "gdskills", "proposals", `${proposalId}.json`);
  return {
    schemaVersion: 1,
    proposalId,
    sourceType,
    sourcePath: candidateSourcePath(record.id),
    skill,
    confidence: record.confidenceLevel ?? "low",
    lessons: lessonsFor(record),
    suggestedSections: suggestedSectionsFor(sourceType),
    proposalPath,
    createdAt: now.toISOString(),
    dryRun,
  };
}

function storeOptionsOf(opts: { env?: NodeJS.ProcessEnv; homeDir?: string }): StoreEnvOptions {
  return {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
  };
}

/**
 * `status: "accepted"` (project scope) -> a `LearningProposal` written under
 * `.metaproject/data/gdskills/proposals/`, applied via the existing
 * `applyLearningProposal` (the only writer into
 * `.metaproject/project-skills/`, unchanged). Refuses:
 *  - no such project-scope record (`learning-record-not-found`);
 *  - a record not currently `status: "accepted"` (`learning-not-accepted`);
 *  - `domain: "review-conventions"` (`use-review-learn-reviewer` — apply that
 *    domain via `keryx review learn --reviewer <id>` instead);
 *  - `trigger`/`action` failing the security scan, re-run here rather than
 *    trusted from accept time (`learning-text-refused`);
 *  - `--skill` not resolving to a registered project skill
 *    (`learning-skill-not-found`, from `resolveRegisteredSkillTarget` — the
 *    same resolver `keryx skills learn --skill` uses).
 * `applyLearningProposal` itself still refuses a resolved skill path outside
 * `.metaproject/project-skills/` via `isPathInside` — this function never
 * relaxes that boundary.
 */
export async function applyLearnedPattern(
  root: string,
  id: string,
  opts: ApplyLearnedPatternOptions,
): Promise<ApplyLearnedPatternResult> {
  const storeOptions = storeOptionsOf(opts);
  const record = await readPattern(root, id, "project", storeOptions);
  if (record === undefined) {
    throw new LearningApplyError("learning-record-not-found", `no project-scope learned-pattern record "${id}"`);
  }
  if (record.status !== "accepted") {
    throw new LearningApplyError(
      "learning-not-accepted",
      `record "${id}" is status "${record.status}", not "accepted"; run \`keryx learn accept ${id}\` first`,
    );
  }
  if (record.domain === "review-conventions") {
    throw new LearningApplyError(
      "use-review-learn-reviewer",
      `record "${id}" is domain "review-conventions" — apply it with \`keryx review learn --reviewer <id>\`, not \`keryx learn apply\``,
    );
  }

  const scan = await scanLearnedText(root, [record.trigger, record.action]);
  if (scan.findings.length > 0) {
    throw new LearningApplyError("learning-text-refused", `record "${id}" refused by the security scan: ${scan.findings.join(", ")}`);
  }

  // R2-F6/R6-F4/R7-F3: same defense-in-depth as `graduate.ts`'s agent-candidate
  // render and extract's upsert, scoped by `mayCarryReviewerText` to the
  // records whose `trigger`/`action` text could actually carry a reviewer
  // login: the deterministic `reviewer-comment` signal (the generalized
  // lesson in `action`, the trigger hint after
  // `REVIEWER_COMMENT_TRIGGER_PREFIX`), and any model-backed record
  // (`provenance.extractorKind === "model-backed"`) regardless of its
  // self-declared `extractor` label (R7-F3) — a model-backed extractor sees
  // the whole observation window and picks its own label, so it is gated
  // unconditionally rather than only when that label happens to equal the
  // literal string `"reviewer-comment"`. Every other deterministic
  // extractor's trigger/action comes from fixed templates plus non-review
  // observation data, so it never carries an attribution fragment in the
  // first place — gating it too would refuse a `code-style`/`testing`/etc.
  // record whose text happens to equal a configured login for reasons
  // unrelated to any reviewer (R6-F4).
  //
  // R3-F3: the config is loaded through the guarded loader — a malformed
  // `review-learning.config.json` refuses THIS gate with a named reason
  // (`review-learning-config-invalid`) instead of throwing an un-reasoned
  // error straight out of `loadReviewLearningConfig`. Simplest consistent
  // rule: apply needs the login gate to be trustworthy before it can apply
  // anything, so a config it cannot read at all is refused, full stop —
  // never silently treated as "no configured logins".
  const configResult = await loadReviewLearningConfigSafe(root);
  if (!configResult.ok) {
    throw new LearningApplyError(
      "review-learning-config-invalid",
      `record "${id}" cannot be applied: .metaproject/review-learning.config.json is invalid: ${configResult.error}`,
    );
  }
  const configuredLogins =
    configResult.config === null ? [] : [...new Set([...configResult.config.authors, ...(configResult.config.reviewerProfiles ?? [])])];
  if (mayCarryReviewerText(record.provenance)) {
    // R4-F1: a record produced by the `reviewer-comment` extractor carries
    // that signal's own FIXED trigger wording (`REVIEWER_COMMENT_TRIGGER_
    // PREFIX`) around the variable keyword hint — strip it before the login
    // gate inspects `record.trigger` (a no-op for any other gated record,
    // i.e. a model-backed one, whose trigger never had that prefix), the
    // same fix `extract.ts`'s upsert applies, so a boundary-matched
    // configured login is checked only against the comment's own variable
    // content.
    const triggerForLoginCheck = stripReviewerCommentTriggerPrefix(record.trigger);
    if (
      configuredLogins.length > 0 &&
      (containsConfiguredLogin(triggerForLoginCheck, configuredLogins) || containsConfiguredLogin(record.action, configuredLogins))
    ) {
      throw new LearningApplyError("learning-text-refused", `record "${id}" refused: contains a configured reviewer login`);
    }
  }

  let skillEntry: { module: string; name: string; path: string; target: string };
  try {
    skillEntry = await resolveRegisteredSkillTarget(root, opts.skill);
  } catch (error) {
    throw new LearningApplyError(
      "learning-skill-not-found",
      error instanceof Error ? error.message : String(error),
    );
  }

  const dryRun = opts.dryRun === true;
  const proposal = learnedPatternToProposal(record, skillEntry, new Date(), dryRun);
  const proposalsRoot = path.join(root, ".metaproject", "data", "gdskills", "proposals");
  const proposalJsonPath = path.join(root, proposal.proposalPath);
  if (!isPathInside(proposalsRoot, proposalJsonPath)) {
    throw new LearningApplyError(
      "learning-path-outside-root",
      `refusing to write proposal outside .metaproject/data/gdskills/proposals: ${proposal.proposalPath}`,
    );
  }

  if (dryRun) {
    // T9 concern: `--dry-run` must write NOTHING durable — compute and return
    // the proposal only. `applyLearningProposal` itself always reads its
    // proposal back from disk (that file doubles as the input a later
    // non-dry-run `keryx skills learn apply` would consume), so there is no
    // way to call it without a file existing somewhere. The fix is to put
    // that file somewhere private and remove it again before returning,
    // rather than writing it (and its rendered `.md`) into the public
    // `.metaproject/data/gdskills/proposals/` directory the non-dry-run path
    // uses — nothing observable on disk survives this call.
    const scratchDir = path.join(root, ".metaproject", "data", "learning", ".apply-dry-run");
    const scratchPath = path.join(scratchDir, `${proposal.proposalId}.json`);
    const scratchRelative = path.posix.join(".metaproject", "data", "learning", ".apply-dry-run", `${proposal.proposalId}.json`);
    await mkdir(scratchDir, { recursive: true });
    try {
      await writeFileAtomic(scratchPath, `${JSON.stringify(proposal, null, 2)}\n`);
      const applied = await applyLearningProposal(root, scratchRelative, { dryRun: true });
      return { proposalPath: proposal.proposalPath, applied };
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }

  await withFileLock(path.join(root, ".metaproject", "data", "gdskills", "learn.lock"), async () => {
    await writeFileAtomic(proposalJsonPath, `${JSON.stringify(proposal, null, 2)}\n`);
    await writeFileAtomic(path.join(proposalsRoot, `${proposal.proposalId}.md`), renderProposalMarkdown(proposal));
  });

  const applied = await applyLearningProposal(root, proposal.proposalPath, { dryRun });
  return { proposalPath: proposal.proposalPath, applied };
}
