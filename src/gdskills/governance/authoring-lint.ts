// Flow 309, W1 Lane C — the authoring standard as a runnable lint, not just
// prose in W1-stack-catalog.md's "Authoring standard" section.
//
// Two checks, mirroring the workstream's two content shapes:
//   - `lintSkill` — a `SKILL.md`'s frontmatter and body against the Agent
//     Skills standard (name shape, description shape/length, body length,
//     references one level deep, `metadata.origin` present and closed-set).
//   - `lintStackRule` — a stack pack rule file's `extends: common` +
//     `paths:` glob, checked against that stack's allowed extensions
//     (`STACK_EXTENSIONS`) so a pack cannot silently widen past its own file
//     types (W1-AC8).
//
// Both return a flat `LintFinding[]` rather than throwing: a lint is advisory
// input to `stocktake`'s verdicts and to the CLI's own exit code, not a
// side-effecting validator.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { frontmatterBlock } from "../bundled-eval";
import { parseSkillFrontmatter } from "../skill-frontmatter";

export type LintSeverity = "error" | "warning";

export interface LintFinding {
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly message: string;
}

export interface LintSkillOptions {
  /** Path to the `SKILL.md` being linted — used to resolve `references/` and the skill's directory name. */
  readonly path: string;
  /** When true, a missing/invalid `metadata.origin` is an error rather than a warning. */
  readonly strict?: boolean;
}

/** Max `name` length, per the authoring standard (Agent Skills open standard). */
export const MAX_NAME_LENGTH = 64;

/** Max `description` length — the same 1024-char cap `bundled-eval.ts`'s `MAX_DESCRIPTION_LENGTH` already enforces for shipped skills. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Max body length (lines) before content should move into `references/`. */
export const MAX_BODY_LINES = 500;

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Vendor/harness names a skill's own `name` must not reduce to — a skill
 * called `claude-reviewer` or `codex-helper` reads as a Keryx-authored
 * wrapper around a specific harness rather than a stack-agnostic capability.
 * Matched per hyphen-segment, not as a substring, so `claude-md-management`
 * (an existing bundled skill whose "claude" names a FILE, `CLAUDE.md`, not
 * the harness) is not what this rule is for — new skills should still avoid
 * the collision, which is why the check stays on the segment, not widened to
 * catch that shipped name retroactively.
 */
export const RESERVED_NAME_WORDS: ReadonlySet<string> = new Set([
  "claude",
  "anthropic",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "openai",
  "chatgpt",
  "windsurf",
  "cline",
  "aider",
  "gpt",
  "llama",
  "keryx",
]);

export const VALID_ORIGINS: ReadonlySet<string> = new Set(["authored", "generated", "imported", "learned"]);

function skillDirectoryName(skillMdPath: string): string {
  return path.basename(path.dirname(skillMdPath));
}

/** Every `references/*.md` sibling that itself links to another local `.md` — the one-hop-only rule (W1's "references one level deep"). */
function deepReferenceFindings(skillMdPath: string): LintFinding[] {
  const referencesDir = path.join(path.dirname(skillMdPath), "references");
  if (!existsSync(referencesDir)) return [];
  const findings: LintFinding[] = [];
  for (const entry of readdirSync(referencesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const refPath = path.join(referencesDir, entry.name);
    const content = readFileSync(refPath, "utf8");
    // A relative `.md` link (`[text](other.md)` or `[text](references/other.md)`)
    // or a bare `references/other.md` mention: both are a second hop past the
    // `SKILL.md -> references/*.md` link this standard allows.
    const linksAnotherReference = /\]\([^)]*\.md\)/.test(content) || /\breferences\/[\w.-]+\.md\b/.test(content);
    if (linksAnotherReference) {
      findings.push({
        rule: "references-one-level",
        severity: "error",
        message: `references/${entry.name} links to another local .md reference — SKILL.md -> references/*.md is the only hop this standard allows`,
      });
    }
  }
  return findings;
}

/**
 * Lint one `SKILL.md`'s frontmatter and body against the W1 authoring
 * standard. `content` is the whole file; `options.path` locates it on disk
 * (for the directory-name check and the `references/` walk).
 */
export function lintSkill(content: string, options: LintSkillOptions): LintFinding[] {
  const findings: LintFinding[] = [];
  const frontmatter = parseSkillFrontmatter(content);
  const directoryName = skillDirectoryName(options.path);
  const name = frontmatter.name ?? directoryName;

  if (name.length === 0) {
    findings.push({ rule: "name-required", severity: "error", message: "name is missing" });
  } else {
    if (name.length > MAX_NAME_LENGTH) {
      findings.push({
        rule: "name-length",
        severity: "error",
        message: `name "${name}" is ${name.length} chars, must be <= ${MAX_NAME_LENGTH}`,
      });
    }
    if (!NAME_PATTERN.test(name)) {
      findings.push({
        rule: "name-format",
        severity: "error",
        message: `name "${name}" must match ${NAME_PATTERN.source} (lowercase letters/digits, hyphen-separated)`,
      });
    }
    const reservedHit = name.split("-").find((segment) => RESERVED_NAME_WORDS.has(segment));
    if (reservedHit !== undefined) {
      findings.push({
        rule: "name-reserved-word",
        severity: "error",
        message: `name "${name}" contains the reserved vendor/harness word "${reservedHit}"`,
      });
    }
  }
  if (frontmatter.name !== undefined && frontmatter.name !== directoryName) {
    findings.push({
      rule: "name-matches-directory",
      severity: "error",
      message: `frontmatter name "${frontmatter.name}" does not match its directory "${directoryName}"`,
    });
  }

  const description = frontmatter.description ?? "";
  if (description.length === 0) {
    findings.push({ rule: "description-required", severity: "error", message: "description is missing" });
  } else {
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      findings.push({
        rule: "description-length",
        severity: "error",
        message: `description is ${description.length} chars, must be <= ${MAX_DESCRIPTION_LENGTH}`,
      });
    }
    if (!/use when/i.test(description)) {
      findings.push({
        rule: "description-use-when",
        severity: "error",
        message: 'description must state when the skill applies ("Use when…")',
      });
    }
  }

  const bodyLines = content.split("\n").length;
  if (bodyLines > MAX_BODY_LINES) {
    findings.push({
      rule: "body-length",
      severity: "error",
      message: `body is ${bodyLines} lines, must be <= ${MAX_BODY_LINES} (move overflow into references/)`,
    });
  }

  findings.push(...deepReferenceFindings(options.path));

  const origin = frontmatter.metadataOrigin;
  if (origin === undefined || !VALID_ORIGINS.has(origin)) {
    findings.push({
      rule: "metadata-origin",
      severity: options.strict === true ? "error" : "warning",
      message:
        origin === undefined
          ? "metadata.origin is missing (must be one of authored | generated | imported | learned)"
          : `metadata.origin "${origin}" is not one of authored | generated | imported | learned`,
    });
  }

  return findings;
}

/**
 * Per-stack file extensions a stack pack's `paths:` globs may target — the
 * table `lintStackRule` checks glob extensions against (W1-AC8). Deliberately
 * starts with the five stacks the workstream's Lane C dispatch names; a new
 * stack pack widens this table, not the check.
 */
export const STACK_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  python: ["py", "pyi"],
  "ts-js-node": ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  react: ["tsx", "jsx"],
  go: ["go"],
  rust: ["rs"],
};

export interface LintStackRuleOptions {
  readonly path: string;
  readonly allowedExtensions: readonly string[];
}

/** The `paths:` glob list from a rule file's frontmatter block, flow-list or block-list. */
function parsePathsGlobs(block: string): string[] {
  const lines = block.split("\n");
  let inPaths = false;
  const globs: string[] = [];
  for (const line of lines) {
    const inlineMatch = /^paths:\s*\[(.*)\]\s*$/.exec(line);
    if (inlineMatch !== null) {
      globs.push(
        ...(inlineMatch[1] ?? "")
          .split(",")
          .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
          .filter((entry) => entry.length > 0),
      );
      inPaths = false;
      continue;
    }
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const itemMatch = /^\s+-\s*(.+)$/.exec(line);
      if (itemMatch !== null && itemMatch[1] !== undefined) {
        globs.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
        continue;
      }
      inPaths = false;
    }
  }
  return globs;
}

function parseExtendsValue(block: string): string | undefined {
  for (const line of block.split("\n")) {
    const match = /^extends:\s*(.+)$/.exec(line);
    if (match !== null && match[1] !== undefined) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * Lint one stack pack rule file: `extends: common` present, `paths:` a
 * non-empty glob list, and every glob's extension inside
 * `options.allowedExtensions` — narrowing a pack's own `security.mdc` past
 * its general glob is allowed (per the workstream's design), widening past
 * the stack's own file types is not.
 */
export function lintStackRule(content: string, options: LintStackRuleOptions): LintFinding[] {
  const findings: LintFinding[] = [];
  const block = frontmatterBlock(content);
  if (block === undefined) {
    return [{ rule: "stack-rule-frontmatter", severity: "error", message: "missing frontmatter block" }];
  }

  const extendsValue = parseExtendsValue(block);
  if (extendsValue !== "common") {
    findings.push({
      rule: "stack-rule-extends",
      severity: "error",
      message: `frontmatter must declare "extends: common" (got ${JSON.stringify(extendsValue ?? null)})`,
    });
  }

  const globs = parsePathsGlobs(block);
  if (globs.length === 0) {
    findings.push({
      rule: "stack-rule-paths",
      severity: "error",
      message: "frontmatter must declare a non-empty paths: glob list",
    });
  }

  const allowed = new Set(options.allowedExtensions.map((extension) => extension.toLowerCase()));
  for (const glob of globs) {
    const extensionMatch = /\.([A-Za-z0-9]+)$/.exec(glob);
    const extension = extensionMatch?.[1]?.toLowerCase();
    if (extension === undefined || !allowed.has(extension)) {
      findings.push({
        rule: "stack-rule-paths-scope",
        severity: "error",
        message: `paths glob "${glob}" is outside this stack's allowed extensions (${[...allowed].sort().join(", ")})`,
      });
    }
  }

  return findings;
}
