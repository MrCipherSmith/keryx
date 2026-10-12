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
//
// Steering files are denied first and everywhere, including under docs/ and the
// .metaproject doc directories: a nested CLAUDE.md or SKILL.md is loaded by the
// agent that reads files beside it. Dotfiles (.cursorrules, .mcp.json) and agent
// config JSON (mcp, settings, hooks, package, tsconfig) are code even where
// machine-written data is skipped. A path that is not plainly normalised
// (backslash, "..", "//", leading "./" or "/") fails open.
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i;
const DOC_DIRS = /^(docs\/|\.metaproject\/(flows|wiki|reviews)\/)/;
const TOP_LEVEL_PROSE = /^(README|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|CODE_OF_CONDUCT)(\.(md|mdx|rst|adoc|txt))?$/i;
const NESTED_PROSE = /^(README|CHANGELOG)\.(md|mdx|rst|adoc)$/i;
const STEERING_SEGMENT = /^(agents?|skills|commands|rules|steering|prompts|instructions|hooks?)$/i;
const STEERING_BASENAME = /^(?:SKILL|AGENTS|CLAUDE|GEMINI|QWEN|CONVENTIONS|copilot-instructions)|\.(?:local|override|instructions|prompt)\.(?:md|mdx|rst|adoc)$/i;
const AGENT_LOADED_JSON = /(^|[-_.])(mcp|settings|hooks?|package|tsconfig)([-_.].*)?\.json$/i;
const GENERATED = /^coverage\/|(^|\/)__generated__\//;
const GENERATED_DATA_EXT = /\.(lcov|info|json|map|html|txt|md)$/i;

function isNormalised(file: string): boolean {
  if (file === "" || file.includes("\\") || file.includes("//") || file.startsWith("/") || file.startsWith("./")) return false;
  return !file.split("/").some((segment) => segment === ".." || segment === ".");
}

function isProse(file: string): boolean {
  if (!isNormalised(file)) return false;
  const docRoot = DOC_DIRS.exec(file);
  const segments = (docRoot === null ? file : file.slice(docRoot[0].length)).split("/");
  const base = segments[segments.length - 1]!;
  const dirs = segments.slice(0, -1);
  if (dirs.some((dir) => dir.startsWith(".") || STEERING_SEGMENT.test(dir))) return false;
  if (STEERING_BASENAME.test(base) || base.startsWith(".") || AGENT_LOADED_JSON.test(base)) return false;
  if (GENERATED.test(file)) return GENERATED_DATA_EXT.test(base);
  if (docRoot !== null) return DOC_EXT.test(base);
  return (dirs.length === 0 ? TOP_LEVEL_PROSE : NESTED_PROSE).test(base);
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
