// Flow 313 (W4 portability), T9: renders the canonical `.metaproject/rules/`
// library into the deterministic `keryx:rules` managed-block body a
// `rules-export` surface (`src/integrations/surfaces-rules.ts`) installs into
// a harness's own instruction file. Spec:
// docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md
// "Canonical instructions → per-harness instruction files".
//
// This module never renders a rule's own BODY — only a one-line index entry
// (path + description) per rule — so the managed block stays small and the
// canonical source (`.metaproject/rules/`) remains the single place a rule's
// actual text lives. `collectCanonicalRules` is pure read + parse (no
// writes); `renderRulesBlockBody` is pure string rendering (no I/O).
//
// `src/rules` is zone `shared` (see `src/lib/import-policy.ts`): this module
// imports only from `../lib`.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, toPosix } from "../lib/fs";

export const RULES_BLOCK_START_MARKER = "<!-- keryx:rules -->";
export const RULES_BLOCK_END_MARKER = "<!-- /keryx:rules -->";

export interface CanonicalRuleEntry {
  /** POSIX path, always `rules/<...>` relative to `.metaproject/`. */
  readonly relativePath: string;
  readonly title: string;
  readonly description: string;
}

const RULE_EXTENSIONS = new Set([".md", ".mdc"]);
const README_BASENAME = "readme.md";
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Review round 1, F7: unlike a rule's title/description (both run through
 * `neutralise` below), a rule's `relativePath` comes straight from the
 * filesystem — a file or directory NAME under `.metaproject/rules/` — and is
 * rendered unescaped, inside backticks, directly into the `keryx:rules`
 * managed block. A path containing a real `<!-- keryx:rules -->`/
 * `<!-- /keryx:rules -->` (or `<!-- keryx:index -->`/`<!-- keryx:instructions
 * -->`) marker forges a second, real marker line inside the rendered block:
 * the next render then fails with "unterminated block", and
 * `ensureMetaprojectReference`'s managed-block replacer (before its own F7
 * fix) would truncate everything after it. A backtick closes the code span
 * early; control characters (including CR/LF) let a path masquerade as extra
 * markdown lines (e.g. a fake `## SYSTEM` heading) inside what is meant to be
 * one list item. Refusing anything holding `<`, `>`, a backtick, a control
 * character, or the literal `<!--`/`-->` substrings closes all of these at
 * once — a rule whose OWN NAME does this is skipped (never rendered), and
 * reported via `CollectCanonicalRulesResult.skipped` instead of silently
 * dropped or, worse, trusted.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point (review round 1, F7)
const UNSAFE_RULE_PATH_PATTERN = /[\x00-\x1f\x7f<>`]/;

function isUnsafeRulePath(relativePath: string): boolean {
  return UNSAFE_RULE_PATH_PATTERN.test(relativePath) || relativePath.includes("<!--") || relativePath.includes("-->");
}

export interface SkippedCanonicalRule {
  readonly relativePath: string;
  readonly reason: string;
}

export interface CollectCanonicalRulesResult {
  readonly rules: readonly CanonicalRuleEntry[];
  readonly skipped: readonly SkippedCanonicalRule[];
}

/**
 * Neutralises any substring a rule's own text could use to forge or close a
 * managed-block marker: HTML comment delimiters (`<!--`, `-->`) and backticks
 * (which could otherwise fence a rendered marker to look like code, or break
 * the single-line list-item shape). Applied to BOTH title and description —
 * every piece of rule-authored text this module ever writes into the block.
 */
function neutralise(text: string): string {
  return text.replace(/<!--/g, "< !--").replace(/-->/g, "-- >").replace(/`/g, "'");
}

/** Collapse all whitespace (including newlines) to single spaces, trim, and cap at `MAX_DESCRIPTION_LENGTH`. */
function collapseSingleLine(text: string, maxLength: number = MAX_DESCRIPTION_LENGTH): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…` : collapsed;
}

interface ParsedFrontMatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
}

/**
 * Minimal front-matter parser: `---\n<key>: <value>\n...---\n<body>`. Only
 * simple `key: value` / `key: "value"` lines are read (every `.mdc`/`.md`
 * rule file in `.metaproject/rules` uses this shape — see
 * `core/solid-principles.mdc`'s `description: "..."` and
 * `core/execution-metrics.md`'s `type:`/`id:`/`priority:`). A file with no
 * `---` front matter at all is returned with an empty field map and its full
 * content as `body`.
 */
function parseFrontMatter(content: string): ParsedFrontMatter {
  if (!content.startsWith("---")) return { fields: new Map(), body: content };
  const lines = content.split("\n");
  if (lines[0] !== "---") return { fields: new Map(), body: content };
  const endIndex = lines.findIndex((line, i) => i > 0 && line === "---");
  if (endIndex < 0) return { fields: new Map(), body: content };

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, endIndex)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);
    fields.set(key, value);
  }
  const body = lines.slice(endIndex + 1).join("\n");
  return { fields, body };
}

function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : undefined;
}

/** `core/git-concurrency` -> `Git Concurrency` — last-resort title when a file has neither front matter nor an H1. */
function titleFromFileName(relativePath: string): string {
  const base = path.basename(relativePath).replace(/\.(mdc|md)$/i, "");
  return base
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Parses one rule file's title/description. Never throws — a file this module cannot make sense of degrades to filename-derived facts rather than failing the whole export. */
function parseRuleFile(fileName: string, content: string): { title: string; description: string } {
  const { fields, body } = parseFrontMatter(content);
  const heading = firstHeading(body);
  const title = heading ?? titleFromFileName(fileName);

  const frontMatterDescription = fields.get("description");
  const rawDescription = frontMatterDescription && frontMatterDescription.length > 0 ? frontMatterDescription : (heading ?? title);
  const description = neutralise(collapseSingleLine(rawDescription));

  return { title: neutralise(collapseSingleLine(title, 120)), description };
}

/**
 * Walk `.metaproject/rules/` recursively for `*.md`/`*.mdc` files, skipping any file literally named
 * `README.md` (case-insensitive) at any depth — those are directory-level
 * documentation about the rules library itself, not a rule to index. Returns
 * `rules` sorted by `relativePath` for deterministic rendering. A missing
 * `.metaproject/rules` directory returns `{ rules: [], skipped: [] }` (never
 * throws — a project with no canonical rules yet is a legitimate, common
 * state, not an error).
 *
 * Review round 1, F7: a rule whose relative path (any file or directory
 * segment under `.metaproject/rules/`) is unsafe to interpolate into the
 * `keryx:rules` managed block unescaped (see `isUnsafeRulePath`) is never
 * added to `rules` — it is reported in `skipped` instead, sorted the same
 * way, so a caller can surface it as a problem (`probe`/install warnings)
 * rather than the file silently vanishing from the index with no trace.
 */
export async function collectCanonicalRules(root: string): Promise<CollectCanonicalRulesResult> {
  const rulesDir = path.join(root, ".metaproject", "rules");
  if (!(await pathExists(rulesDir))) return { rules: [], skipped: [] };

  const rules: CanonicalRuleEntry[] = [];
  const skipped: SkippedCanonicalRule[] = [];

  async function walk(dirAbsolute: string, dirRelative: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dirAbsolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const childRelative = dirRelative ? `${dirRelative}/${dirent.name}` : dirent.name;
      const childAbsolute = path.join(dirAbsolute, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!RULE_EXTENSIONS.has(ext)) continue;
      if (dirent.name.toLowerCase() === README_BASENAME) continue;

      const relativePath = `rules/${toPosix(childRelative)}`;
      if (isUnsafeRulePath(relativePath)) {
        skipped.push({
          relativePath,
          reason:
            "unsafe rule path: contains a control character, `<`, `>`, a backtick, or an HTML comment delimiter (<!-- / -->) — refused to protect the managed keryx:rules block from a forged marker",
        });
        continue;
      }

      let content: string;
      try {
        content = await readFile(childAbsolute, "utf8");
      } catch {
        continue;
      }
      const { title, description } = parseRuleFile(dirent.name, content);
      rules.push({ relativePath, title, description });
    }
  }

  await walk(rulesDir, "");
  rules.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { rules, skipped };
}

/**
 * Deterministic markdown body for the `keryx:rules` managed block, including
 * its own start/end markers (mirrors `markdown-block.ts`'s
 * `renderInstructionsBlock`'s self-contained shape). An empty `rules` list
 * still renders the heading/intro plus a "no canonical rules found." line —
 * NEVER an empty block, which would otherwise round-trip as a `no-block`
 * state on the very next `inspectMarkdownBlock` probe.
 *
 * Review round 1, F7 (defense in depth): every `rule.relativePath` is
 * re-checked with `isUnsafeRulePath` immediately before it is interpolated —
 * `collectCanonicalRules` above is the only realistic caller and already
 * filters these out, but this function's own contract ("render the remaining
 * paths inside backticks only after that check") must hold regardless of
 * what a caller passes it. An unsafe entry reaching here is dropped silently
 * rather than rendered (it should never happen; `collectCanonicalRules`
 * already reports it in `skipped` for its own caller).
 */
export function renderRulesBlockBody(rules: readonly CanonicalRuleEntry[]): string {
  const safeRules = rules.filter((rule) => !isUnsafeRulePath(rule.relativePath));
  const intro = [
    "## Project rules (Keryx)",
    "",
    "Canonical source: `.metaproject/rules/` (managed by keryx; edit the rules there, not this block). Read the rule that matches your task before acting:",
    "",
  ];
  const list =
    safeRules.length === 0
      ? ["No canonical rules found."]
      : safeRules.map((rule) => `- \`.metaproject/${rule.relativePath}\` — ${rule.description}`);

  return `${RULES_BLOCK_START_MARKER}\n${[...intro, ...list].join("\n")}\n${RULES_BLOCK_END_MARKER}\n`;
}
