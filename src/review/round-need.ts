// Preflight check 2 of review-orchestrator: a diff that only touches prose or
// machine-written files has nothing a reviewer can find, so no round runs.
// Anything not positively recognised as prose counts as code, so the check can
// only err toward running a round.
//
// This module is the tested reference of the rule. The host executes the
// preflight prose in review-orchestrator/SKILL.md; nothing in the CLI calls
// `classifyRoundNeed` yet, and review-orchestrator-preflight.test.ts keeps the
// prose and the token lists below in step.

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

// Prose is an allowlist, and one rule: a path is prose only if all of these hold.
//  1. It is plainly normalised (no backslash, "..", "//", leading "./" or "/").
//  2. No segment, directory or file name, starts with "." (.claude, .cursorrules,
//     .mcp.json, .metaproject/data, ...). The prose roots under .metaproject are
//     the only exception: wiki/, reviews/ and flows/<id>/journal.md.
//  3. No directory is a steering directory, singular or plural (agent(s), skill(s),
//     command(s), rule(s), prompt(s), instruction(s), persona(s), steering, hook(s)).
//  4. The file name is not steering: it does not start with a steering stem (SKILL,
//     AGENT(S), CLAUDE, ...), does not end in .local/.override/.instructions/.prompt
//     before its extension, and does not contain prompt, instruction or system.
//  5. Then one of:
//     - README or CHANGELOG at any depth, with a doc extension;
//     - CONTRIBUTING, LICENSE, SECURITY or CODE_OF_CONDUCT at the top level;
//     - a doc-extension file under docs/, .metaproject/wiki/, .metaproject/reviews/
//       or a flow journal, whose stem holds a lowercase letter or is exactly one of
//       the six names above (all-uppercase stems such as AGENT or WARP are steering
//       by convention);
//     - a data file under coverage/ or __generated__/ with a generated-data extension.
// Everything else is code: lockfiles, committed dist/, CI, auth, migrations, config
// JSON, flow descriptions, acceptance criteria and tasks (gate inputs).

/** Steering directory names; "(s)" marks an optional plural. */
export const STEERING_SEGMENT_TOKENS = ["agent(s)", "skill(s)", "command(s)", "rule(s)", "prompt(s)", "instruction(s)", "persona(s)", "steering", "hook(s)"] as const;
/** File-name prefixes of steering files, in any case. */
export const STEERING_STEM_TOKENS = ["SKILL", "AGENT", "CLAUDE", "GEMINI", "QWEN", "CODEX", "WARP", "CRUSH", "JULES", "GUIDELINES", "CONVENTIONS", "copilot-instructions"] as const;
/** Suffixes before the extension that mark a steering file. */
export const STEERING_SUFFIX_TOKENS = [".local", ".override", ".instructions", ".prompt"] as const;
/** A file name containing one of these is steering. */
export const STEERING_WORD_TOKENS = ["prompt", "instruction", "system"] as const;
/** Prose at any depth. */
export const PROSE_ANY_DEPTH_NAMES = ["README", "CHANGELOG"] as const;
/** Prose at the top level only. */
export const PROSE_TOP_LEVEL_NAMES = ["CONTRIBUTING", "LICENSE", "SECURITY", "CODE_OF_CONDUCT"] as const;
export const DOC_EXTENSIONS = ["md", "mdx", "rst", "adoc"] as const;
/** The only extensions skipped under coverage/ and __generated__/. */
export const GENERATED_DATA_EXTENSIONS = ["lcov", "info", "map"] as const;

const group = (tokens: readonly string[]): string => tokens.map((token) => token.replace("(s)", "s?")).join("|");
const STEERING_SEGMENT = new RegExp(`^(?:${group(STEERING_SEGMENT_TOKENS)})$`, "i");
const STEERING_STEM = new RegExp(`^(?:${group(STEERING_STEM_TOKENS)})`, "i");
const STEERING_SUFFIX = new RegExp(`(?:${STEERING_SUFFIX_TOKENS.map((token) => token.replace(".", "\\.")).join("|")})$`, "i");
const STEERING_WORD = new RegExp(group(STEERING_WORD_TOKENS), "i");
const DOC_EXT = new RegExp(`^(?:${DOC_EXTENSIONS.join("|")})$`, "i");
const GENERATED_EXT = new RegExp(`^(?:${GENERATED_DATA_EXTENSIONS.join("|")})$`, "i");
const GENERATED = /^coverage\/|(^|\/)__generated__\//;
const PROSE_ROOT = /^(?:docs\/|\.metaproject\/(?:wiki|reviews)\/|\.metaproject\/flows\/(?=[^/]+\/journal\.md$))/;

const sameName = (names: readonly string[], stem: string): boolean => names.some((name) => name.toLowerCase() === stem.toLowerCase());

function isNormalised(file: string): boolean {
  if (file === "" || file.includes("\\") || file.includes("//") || file.startsWith("/") || file.startsWith("./")) return false;
  return !file.split("/").some((segment) => segment === ".." || segment === ".");
}

function isProse(file: string): boolean {
  if (!isNormalised(file)) return false;
  const root = PROSE_ROOT.exec(file);
  const rest = root === null ? file : file.slice(root[0].length);
  const segments = rest.split("/");
  const base = segments[segments.length - 1]!;
  const dirs = segments.slice(0, -1);
  if (segments.some((segment) => segment.startsWith("."))) return false;
  if (dirs.some((dir) => STEERING_SEGMENT.test(dir))) return false;
  const dot = base.lastIndexOf(".");
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? "" : base.slice(dot + 1);
  if (STEERING_STEM.test(base) || STEERING_SUFFIX.test(stem) || STEERING_WORD.test(base)) return false;
  if (GENERATED.test(file)) return GENERATED_EXT.test(ext);
  if (sameName(PROSE_ANY_DEPTH_NAMES, stem) && DOC_EXT.test(ext)) return true;
  if (root === null) return dirs.length === 0 && sameName(PROSE_TOP_LEVEL_NAMES, stem) && (ext === "" || ext === "txt" || DOC_EXT.test(ext));
  if (!DOC_EXT.test(ext)) return false;
  return /[a-z]/.test(stem) || sameName([...PROSE_ANY_DEPTH_NAMES, ...PROSE_TOP_LEVEL_NAMES], stem);
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
