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

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
]);

// Markdown that steers agents: a change to it changes behaviour, so it is code.
const RULE_BEARING =
  /(^|\/)(SKILL(\.detail)?\.md|CLAUDE\.md|AGENTS\.md|GEMINI\.md|copilot-instructions\.md|[^/]+\.mdc)$|(^|\/)\.(claude|cursor|github|metaproject)\/(agents|commands|skills|rules)\//i;
const PROSE = /\.(md|mdx|rst|adoc)$/i;
const GENERATED = /^(dist|coverage)\/|(^|\/)__generated__\//;

function isProse(file: string): boolean {
  if (RULE_BEARING.test(file)) return false;
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (LOCKFILES.has(base)) return true;
  if (GENERATED.test(file)) return true;
  return PROSE.test(file);
}

export function classifyRoundNeed(input: RoundNeedInput): RoundNeed {
  if (input.all === true) return { needed: true, reason: "--all forces a round" };
  if ((input.explicitReviewers?.length ?? 0) > 0) return { needed: true, reason: "an explicit reviewer list forces a round" };
  if (input.gating === true) return { needed: true, reason: "a gating round is always run" };
  if (input.files.length === 0) return { needed: false, reason: "empty diff" };
  if (input.files.every(isProse)) {
    return { needed: false, reason: "docs, markdown, lockfiles or generated files only; no code, CI, auth, migration or rule-bearing config" };
  }
  return { needed: true, reason: "code or rule-bearing files in the diff" };
}
