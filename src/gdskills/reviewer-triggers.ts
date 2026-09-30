import { parseSkillFrontmatter } from "./skill-frontmatter";

/**
 * What a review package's text says about when it is dispatched: its path
 * triggers and its selection flags.
 *
 * Pure text in, values out — no filesystem, no inventory. Two readers need the
 * same answer about the same SKILL.md: `keryx review reviewers`
 * (`src/review/reviewers.ts`) reports it, and `keryx skills import`
 * (`./import-skills.ts`) warns from it before the package is written. It lives
 * here because `gdskills` is the lower layer: `review` imports `gdskills`, and
 * the importer reaching up into `review` for these made the two directories
 * depend on each other.
 */

/**
 * Where a project reviewer's path triggers came from.
 *
 * - `metadata` — `metadata.paths` in its frontmatter: a comma-separated glob
 *   list, a flow list, or a YAML block list.
 * - `description` — globs (`src/core/**`) found in its description, and the
 *   literal file paths (`src/utils/column-zone.ts`) listed beside them.
 * - `none` — neither; the path gate has nothing to match, so it dispatches.
 */
export type PathTriggerSource = "metadata" | "description" | "none";

/**
 * Escape a literal so it can be embedded in a regex source.
 *
 * Extracted and exported for one reason: the version inlined here was broken and
 * nothing could tell. The class was written `[.*+?^${}()|[\\]\\\\]`, which closes
 * at the FIRST `]` — so the pattern became "one metacharacter, then two
 * backslashes, then a bracket", matching essentially nothing. The escape was a
 * complete no-op rather than a partial one.
 *
 * It never misbehaved because all three call-site labels ("Origin", "Origin
 * Hash", "Imported At") contain no metacharacters, so escaping them is identity
 * either way. That is exactly why it needed lifting out: through the public
 * surface, fixed and broken are indistinguishable, and a fix nothing can observe
 * is a fix that silently rots. Here it is directly testable.
 */
export function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquoted(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

/** `a, b`, `"a, b"` or `[a, "b"]` on the key's own line. */
function inlineEntries(value: string): string[] {
  return value
    .replace(/^["'[]|["'\]]$/g, "")
    .split(",")
    .map(unquoted)
    .filter(Boolean);
}

/**
 * The `- item` lines that follow an empty `key:`, indented at least as far as
 * the key. The list ends at the first line that is not one of them.
 */
function blockEntries(lines: string[], keyIndent: number): string[] {
  const entries: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (!item || (item[1] ?? "").length < keyIndent) break;
    const entry = unquoted(item[2] ?? "");
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * The entries of a list-valued key under `metadata:` in a SKILL.md's
 * frontmatter, trimmed and unquoted.
 *
 * Every spelling YAML gives one list is read: a comma-separated scalar
 * (`paths: "a, b"`), a flow list (`paths: [a, b]`) and a block list (`paths:`
 * followed by `- a` lines). The block list used to be ignored without a word —
 * the key's line held no value, so the field read as not declared.
 */
export function metadataList(content: string, key: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return [];
  const lines = content.slice(3, end).split("\n");
  const field = new RegExp(`^(\\s+)${escapeRegexLiteral(key)}:\\s*(.*)$`);
  let inMetadata = false;
  for (const [index, line] of lines.entries()) {
    const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata";
      continue;
    }
    if (!inMetadata) continue;
    const match = field.exec(line);
    if (!match) continue;
    const value = (match[2] ?? "").trim();
    return value ? inlineEntries(value) : blockEntries(lines.slice(index + 1), (match[1] ?? "").length);
  }
  return [];
}

/** Extensions of documents a description cites as its standard — never a trigger. */
const CITED_DOCUMENT_EXTENSIONS = new Set(["md", "mdc"]);

/** Strip what prose wraps a path in: quotes, list punctuation, an unbalanced `)`. */
function unwrapToken(raw: string): string {
  let token = raw.replace(/^[("'`]+/, "");
  for (;;) {
    let next = token.replace(/[,.;:"'`]+$/, "");
    if (next.endsWith(")") && next.split(")").length > next.split("(").length) next = next.slice(0, -1);
    if (next === token) return token;
    token = next;
  }
}

/**
 * Whether a glob-less token is a repo-relative file path a diff can match.
 *
 * The stated rule is "contains `/` and has a file extension other than
 * `.md` / `.mdc`". Read literally it also takes prose, so each clause below is
 * one kind of prose it must not take:
 *
 * - path characters only — a URL (`https://…`) or `a=b/c.ts` has others;
 * - no leading `/` or `~`, no empty / `.` / `..` segment — an absolute or
 *   relative spelling never equals a path in a diff;
 * - no segment ending in `.` — `e.g./i.e`;
 * - a first segment with a dot must be a dot-directory (`.github/…`) —
 *   `github.com/acme/overlay.git`, `e.g/i.e`, `0.3.40/0.3.41`;
 * - the extension starts with a letter — `v1.2/v1.3`, `2026/09.30`;
 * - not under `.metaproject/` — keryx's own tree is what a description names
 *   as its configuration ("enabled in .metaproject/tasks.config.json", the
 *   bundled `review-jev-*` descriptions), not code under review.
 *
 * What no clause here can tell apart is `React/Next.js` from `src/routes.js`:
 * that is settled by the caller, which takes a literal only beside a glob.
 */
function isLiteralFilePath(token: string): boolean {
  if (!/^[A-Za-z0-9._@/-]+$/.test(token) || !token.includes("/")) return false;
  const segments = token.split("/");
  if (segments.some((segment) => segment === "" || segment.endsWith("."))) return false;
  const first = segments[0] as string;
  if (first === ".metaproject" || (first.includes(".") && !first.startsWith("."))) return false;
  const extension = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(segments[segments.length - 1] as string)?.[1];
  return extension !== undefined && !CITED_DOCUMENT_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Path triggers a description names: any token with a `*` that looks like a
 * path, and — beside at least one of those — any literal file path
 * (`src/utils/column-zone.ts`). A trigger list often has one entry that is a
 * single file, and dropping it gated the reviewer off the very file it was
 * written for. `*.ts(x)` expands to both spellings.
 *
 * A literal is a trigger only in a description that also yields a glob. A
 * description with no glob is prose, and prose is full of things shaped like a
 * file path: `React/Next.js conventions reviewer.` became the trigger
 * `React/Next.js`, which matches no file in any diff — so the reviewer was
 * gated off every round, and was no longer reported as `paths: none`.
 *
 * Two kinds of token yield nothing, deliberately. Prose without a glob or an
 * extension (`date/temporal utils`, `test/e2e`): a guessed trigger that matches
 * nothing would gate a reviewer off a diff it was written for. And a cited
 * document (`src/core/flow/CLAUDE.md`, `core/reviewing.mdc`): that is where the
 * reviewer's rules come from, not what it reviews.
 */
export function descriptionPathTriggers(description: string): string[] {
  const triggers = new Set<string>();
  let hasGlob = false;
  for (const raw of description.split(/\s+/)) {
    const token = unwrapToken(raw);
    const optional = /^(.*)\(([a-z0-9]+)\)$/i.exec(token);
    const spellings = optional?.[1] && optional[2] ? [optional[1], `${optional[1]}${optional[2]}`] : [token];
    const isGlob = token.includes("*") && (token.includes("/") || token.startsWith("*."));
    if (!isGlob && !spellings.every(isLiteralFilePath)) continue;
    hasGlob ||= isGlob;
    for (const spelling of spellings) triggers.add(spelling);
  }
  return hasGlob ? [...triggers] : [];
}

export function descriptionFlags(description: string): string[] {
  const flags = new Set<string>();
  for (const match of description.matchAll(/(?:^|[\s(,])(--[a-z][a-z0-9-]*)/g)) {
    if (match[1] && match[1] !== "--all") flags.add(match[1]);
  }
  return [...flags];
}

/**
 * What gates a review package on the diff: `metadata.paths`, then the triggers
 * its description names, then nothing.
 *
 * The one reader of that precedence. `keryx review reviewers` reports it and
 * `keryx skills import` warns from it (a dry run too, hence from the text
 * rather than the inventory) — two copies of the parse would let the warning
 * say `none` about a package the inventory gates.
 */
export function reviewerPathGate(content: string): { paths: string[]; pathsSource: PathTriggerSource } {
  const declared = metadataList(content, "paths");
  if (declared.length > 0) return { paths: declared, pathsSource: "metadata" };
  const description = parseSkillFrontmatter(content).description;
  const described = description ? descriptionPathTriggers(description) : [];
  return { paths: described, pathsSource: described.length > 0 ? "description" : "none" };
}

/** The shape of a selection flag — what `descriptionFlags` finds and what an operator can pass. */
const SELECTION_FLAG = /^--[a-z][a-z0-9-]*$/;

const NOT_A_FLAG = "a flag is `--` and a name of lower-case letters, digits and dashes that starts with a letter";

const NO_DECLARED_FLAG =
  "metadata.flags: no entry is a flag — this reviewer has no selection flags; the flags its description names are not used once metadata.flags is declared";

export type ReviewerFlagReport = {
  /** Selection flags, normalised, `--all` excluded, each listed once. */
  flags: string[];
  /** One line per `metadata.flags` entry that was dropped, and one when none was left. */
  warnings: string[];
};

/**
 * Selection flags of a review package, and what had to be dropped to get them.
 *
 * `metadata.flags`, when it has entries, is the whole answer; otherwise the
 * flags the description names. `--all` is excluded either way — it selects
 * every reviewer already.
 *
 * A declared entry is normalised before it is compared with anything: split on
 * commas and whitespace, trimmed, lower-cased, and given a `--` when it has no
 * leading dash. Taken verbatim, `vantage`, `--Vantage ` and `--vantage` were
 * three flags; none was shared, so `familyFlags` stayed empty and the reviewer
 * spelled correctly was dispatched under `--vantage` without its path gate. An
 * entry that is still not a flag is dropped and reported rather than kept as a
 * flag nobody can pass.
 *
 * A declared list in which nothing is a flag leaves the reviewer with NO
 * flags; it does not fall back to the description. A unique flag dispatches
 * its reviewer outright, without the path gate — so falling back would hand
 * the reviewer flags its author replaced, and with them a way past its gate
 * that nothing in its frontmatter declares. With no flags it is selected by its
 * paths or by `--all`, both of which keep the gate, and the warning says why.
 */
export function reviewerFlagReport(content: string): ReviewerFlagReport {
  const entries = metadataList(content, "flags")
    .flatMap((entry) => entry.split(/[\s,]+/))
    .filter(Boolean);
  if (entries.length === 0) {
    const description = parseSkillFrontmatter(content).description;
    return { flags: description ? descriptionFlags(description) : [], warnings: [] };
  }
  const flags = new Set<string>();
  const warnings: string[] = [];
  for (const entry of entries) {
    const lowered = entry.toLowerCase();
    const flag = lowered.startsWith("-") ? lowered : `--${lowered}`;
    if (!SELECTION_FLAG.test(flag)) {
      warnings.push(`metadata.flags: ${JSON.stringify(entry)} dropped — ${NOT_A_FLAG}`);
    } else if (flag !== "--all") {
      flags.add(flag);
    }
  }
  if (flags.size === 0 && warnings.length > 0) warnings.push(NO_DECLARED_FLAG);
  return { flags: [...flags], warnings };
}

/** {@link reviewerFlagReport}'s flags alone. */
export function reviewerFlags(content: string): string[] {
  return reviewerFlagReport(content).flags;
}
