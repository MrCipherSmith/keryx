// Preflight check 2 of review-orchestrator: a diff that only touches prose or
// machine-written files has nothing a reviewer can find, so no round runs.
// Anything not positively recognised as prose counts as code, so the check can
// only err toward running a round.

export interface RoundNeedInput {
  files: readonly string[];
  /** `--all` was passed. */
  all?: boolean;
  /** The operator named reviewers explicitly. */
  explicitReviewers?: readonly string[];
  /** The caller is a gate that requires a round (flow review gate). */
  gating?: boolean;
}

export interface RoundNeed {
  needed: boolean;
  reason: string;
}

// Prose is an allowlist: markdown anywhere else (agent prompts, steering files,
// instruction files, rules) shapes agent behaviour, so it is code. Lockfiles and
// committed dist/ output are code too: a repointed resolved URL or hash is a
// supply-chain change. .metaproject/data stays out of the allowlist because
// data/testing/context.md is read as instructions.
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const STEERING_TOP_LEVEL = /^(CLAUDE|AGENTS|GEMINI)\.(md|mdx|rst|adoc)$/i;
const DOC_DIRS = /^(docs\/|\.metaproject\/(flows|wiki|reviews)\/)/;
const GENERATED = /^coverage\/|(^|\/)__generated__\//;

function isProse(file: string): boolean {
  if (GENERATED.test(file)) return true;
  if (!DOC_EXT.test(file)) return false;
  if (!file.includes("/")) return !STEERING_TOP_LEVEL.test(file);
  return DOC_DIRS.test(file);
}

export function classifyRoundNeed(input: RoundNeedInput): RoundNeed {
  if (input.all === true) return { needed: true, reason: "--all forces a round" };
  if ((input.explicitReviewers?.length ?? 0) > 0) return { needed: true, reason: "an explicit reviewer list forces a round" };
  if (input.gating === true) return { needed: true, reason: "a gating round is always run" };
  if (input.files.length === 0) return { needed: false, reason: "empty diff" };
  if (input.files.every(isProse)) {
    return { needed: false, reason: "docs or machine-written files only; no code, lockfiles, CI, auth, migration, agent prompts or rule-bearing config" };
  }
  return { needed: true, reason: "code or rule-bearing files in the diff" };
}
