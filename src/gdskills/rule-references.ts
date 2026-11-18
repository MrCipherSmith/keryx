import { stat } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { MOVED_RULES } from "./retired-rules";

/**
 * Rules a skill names as its standard — `core/reviewing.mdc`,
 * `rules/core/styling.mdc` — normalised to the path under `.metaproject/rules/`.
 *
 * Only backticked `.mdc` references count. That is the shape every skill tree
 * keryx imports uses for "read this rule", and it keeps prose (`src/core/flow/
 * CLAUDE.md`, a bare `core/` directory) from being mistaken for a rule the
 * skill cannot work without.
 *
 * Importing a skill copied its SKILL.md and nothing it pointed at, so a
 * reviewer whose round contract lived in `core/reviewing.mdc` arrived in a
 * project that had no such file — and nothing said so. This is the list both
 * sides check: `keryx skills import` to fetch what is missing, and
 * `keryx review reviewers` to report what is still missing.
 *
 * A directory that differs only in case from one keryx installs is spelled as
 * keryx spells it: `Core/x.mdc` is `core/x.mdc`. On a case-insensitive
 * filesystem they are one path — the directory `keryx init`, `keryx update`
 * and `keryx skills install` overwrite — so every caller (the import's
 * ships-with-keryx check, where it writes, the row it reports and the
 * `shadowedRules` of `keryx review reviewers`) must see one reference, and
 * this is the one place that spelling is decided.
 *
 * The same holds for a rule keryx moved out of `core/` (`MOVED_RULES`,
 * ADR-0001): a skill written before the move still cites `core/git-rules.mdc`,
 * the file keryx now ships — and the installer leaves — at
 * `process/git-rules.mdc`. The reference is the moved path, so the reviewer
 * reads the rule that exists and an overlay's copy goes to the project slot
 * the new path resolves through. The spelling the text used is not lost:
 * `citedRuleReferences` keeps it, and `shadowedRuleReferences` reports a
 * redirect from it, so a reviewer is told which file to open instead.
 */
export function ruleReferences(content: string): string[] {
  return [...new Set(citedRuleReferences(content).map((citation) => citation.ref))].sort();
}

/** One rule citation: `cited` as the text spells it (layer case normalised), `ref` after a move. */
export type RuleCitationSpelling = { cited: string; ref: string };

export function citedRuleReferences(content: string): RuleCitationSpelling[] {
  const byCited = new Map<string, RuleCitationSpelling>();
  // `<dir>/<name>.mdc`, or a stack pack's `stacks/<pack>/<name>.mdc` (ADR-0001 P4).
  for (const match of content.matchAll(/`(?:\.metaproject\/)?(?:rules\/)?((?:stacks\/[a-z0-9_-]+|[a-z0-9_-]+)\/[a-z0-9._-]+\.mdc)`/gi)) {
    if (!match[1]) continue;
    const cited = withKeryxDirSpelling(match[1]);
    byCited.set(cited, { cited, ref: canonicalRuleReference(cited) });
  }
  return [...byCited.values()].sort((a, b) => (a.cited < b.cited ? -1 : a.cited > b.cited ? 1 : 0));
}

/**
 * Citations of a moved `.md` rule at its old `core/` path (review R2-1). They
 * are not rule references (`ruleReferences` is `.mdc` only, and `.md` files
 * are reported through `unresolvedReferences`), but a reviewer reading one must
 * still be redirected to the new path.
 */
function movedMarkdownCitations(content: string): RuleCitationSpelling[] {
  const byCited = new Map<string, RuleCitationSpelling>();
  for (const match of content.matchAll(/`(?:\.metaproject\/)?(?:rules\/)?(core\/[a-z0-9._-]+\.md)`/gi)) {
    if (!match[1]) continue;
    const cited = withKeryxDirSpelling(match[1]);
    const ref = canonicalRuleReference(cited);
    if (ref !== cited) byCited.set(cited, { cited, ref });
  }
  return [...byCited.values()];
}

/** The `core/` path a moved rule was cited under before it moved; empty for any other reference. */
export function preMoveRuleReferences(ref: string): string[] {
  return MOVED_RULES.filter((entry) => entry.movedTo === ref).map((entry) => `core/${entry.fileName}`);
}

/** `Core/x.mdc` -> `core/x.mdc`, then a moved `core/<name>` -> its new layer path. */
export function canonicalRuleReference(ref: string): string {
  const spelled = withKeryxDirSpelling(ref);
  if (!spelled.startsWith("core/")) return spelled;
  const moved = MOVED_RULES.find((entry) => `core/${entry.fileName}` === spelled);
  return moved === undefined ? spelled : moved.movedTo;
}

/**
 * The rule layers keryx ships (ADR-0001 D1): the directories under
 * `.metaproject/rules/` whose files `keryx init`, `keryx update` and
 * `keryx skills install` force-copy from the bundled rules. The language and
 * framework layers are the stack packs, installed under `rules/stacks/<pack>/`,
 * and are not listed here.
 */
export const KERYX_RULE_LAYERS = ["core", "process", "activity"] as const;

export type KeryxRuleLayer = (typeof KERYX_RULE_LAYERS)[number];

export function isKeryxRuleLayer(dir: string): dir is KeryxRuleLayer {
  return (KERYX_RULE_LAYERS as readonly string[]).includes(dir);
}

function withKeryxDirSpelling(ref: string): string {
  const slash = ref.indexOf("/");
  const dir = ref.slice(0, slash);
  const layer = KERYX_RULE_LAYERS.find((candidate) => candidate !== dir && candidate === dir.toLowerCase());
  return layer === undefined ? ref : `${layer}${ref.slice(slash)}`;
}

/**
 * Whether `absolute` is a regular file (a symlink to one counts). A directory,
 * a socket or a dangling link is not a rule anyone can read.
 */
export async function isRegularFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

/**
 * The directory under `.metaproject/rules/` that holds a project's own version
 * of a rule. `keryx init`, `keryx update` and `keryx skills install` force-copy
 * the bundled rules over the layer directories (`KERYX_RULE_LAYERS`) and
 * `rules/stacks/`, and touch nothing else under `rules/`, so an overlay's rule
 * that shares a name with one keryx ships survives only outside them.
 */
export const PROJECT_RULES_DIR = "project";

/**
 * Project-relative posix path of the project's own slot for a reference:
 * `.metaproject/rules/project/<ref>`, the whole reference kept —
 * `core/x.mdc` → `.metaproject/rules/project/core/x.mdc`.
 *
 * The slot used to be keyed on the basename, so `core/x.mdc` and `house/x.mdc`
 * shared one file: the second rule an import met was reported as differing
 * from the first and installed nowhere. A file lying directly in
 * `rules/project/` is nobody's slot now; it answers only a reference that
 * names it, `project/<name>.mdc`, as the literal file it is.
 */
export function projectRulePath(ref: string): string {
  return path.posix.join(".metaproject", "rules", PROJECT_RULES_DIR, ref);
}

/** Project-relative posix path of the file a reference names literally. */
export function literalRulePath(ref: string): string {
  return path.posix.join(".metaproject", "rules", ref);
}

export type RuleResolution = {
  ref: string;
  /** The project slot, {@link projectRulePath}: the first candidate. */
  project: string;
  /** The file the reference spells out, {@link literalRulePath}: the second candidate. */
  literal: string;
  /** Whichever candidate exists, the project slot first; absent when neither does. */
  resolved?: string;
  /**
   * True when the reference resolves to its project slot — the reviewer reads a
   * different file than the one its text spells out.
   */
  shadowed: boolean;
  /**
   * Candidates something exists at that is not a regular file (a directory,
   * say), in candidate order; absent when there are none. Such a candidate
   * answers nothing: no reviewer can read it, and nothing is written over it.
   */
  notRegularFiles?: string[];
};

/**
 * Where a rule reference resolves in this project:
 * `.metaproject/rules/project/<ref>` first, then `.metaproject/rules/<ref>`.
 * Only a regular file answers; anything else at a candidate is listed in
 * `notRegularFiles` and passed over.
 *
 * The one owner of that order. `keryx review reviewers` reports through it and
 * `keryx skills import` decides through it, so the two cannot disagree about
 * which file a reviewer reads.
 */
export async function resolveRuleReference(projectRoot: string, ref: string): Promise<RuleResolution> {
  const project = projectRulePath(ref);
  const literal = literalRulePath(ref);
  const notRegularFiles: string[] = [];
  let resolved: string | undefined;
  for (const candidate of [project, literal]) {
    const absolute = path.join(projectRoot, candidate);
    if (await isRegularFile(absolute)) {
      resolved = candidate;
      break;
    }
    if (await pathExists(absolute)) notRegularFiles.push(candidate);
  }
  return {
    ref,
    project,
    literal,
    ...(resolved !== undefined ? { resolved } : {}),
    shadowed: resolved === project,
    ...(notRegularFiles.length > 0 ? { notRegularFiles } : {}),
  };
}

/** The subset of {@link ruleReferences} that resolves to no file, in either location. */
export async function unresolvedRuleReferences(projectRoot: string, content: string): Promise<string[]> {
  const missing = new Set<string>();
  for (const { cited, ref } of citedRuleReferences(content)) {
    if ((await resolveCitation(projectRoot, cited, ref)) === undefined) missing.add(ref);
  }
  return [...missing].sort();
}

/**
 * Where a citation resolves: its moved path first, then — for a project this
 * keryx has not updated yet, whose `core/` copy is still in place — the path
 * the text spells (review R2-LS-4). `undefined` when neither has a file.
 */
async function resolveCitation(projectRoot: string, cited: string, ref: string): Promise<RuleResolution | undefined> {
  const canonical = await resolveRuleReference(projectRoot, ref);
  if (canonical.resolved !== undefined) return canonical;
  if (cited === ref) return undefined;
  const asCited = await resolveRuleReference(projectRoot, cited);
  return asCited.resolved === undefined ? undefined : asCited;
}

export type ShadowedRule = { ref: string; resolved: string };

/**
 * Citations the reviewer must read from another file than the one its text
 * names: a `rules/project/<ref>` copy that answers instead of the named file,
 * and a rule keryx moved out of `core/` (review LS-1) — `ref` is the spelling
 * the text uses, `resolved` the file that exists. Without the redirect a
 * reviewer citing `core/git-rules.mdc` would open a path `keryx update` deleted.
 */
export async function shadowedRuleReferences(projectRoot: string, content: string): Promise<ShadowedRule[]> {
  const shadowed: ShadowedRule[] = [];
  for (const { cited, ref } of [...citedRuleReferences(content), ...movedMarkdownCitations(content)]) {
    const resolution = await resolveCitation(projectRoot, cited, ref);
    if (resolution === undefined || resolution.resolved === undefined) continue;
    // Read where the text points unless a project slot or a move says otherwise.
    const redirected = resolution.resolved !== literalRulePath(cited);
    if (resolution.shadowed || redirected) shadowed.push({ ref: cited, resolved: resolution.resolved });
  }
  return shadowed;
}

/**
 * A reference a skill makes that {@link ruleReferences} does not cover.
 *
 * - `missing` — a backticked `skills/...` or `rules/...` path ending `.md` or
 *   `.json` with no file at `.metaproject/<path>`.
 * - `non-portable` — a rule cited by an absolute or `~` path. It may well exist
 *   on this machine; it is reported because it is true on exactly one.
 */
export type UnresolvedReference = { ref: string; reason: "missing" | "non-portable" };

export async function unresolvedReferences(projectRoot: string, content: string): Promise<UnresolvedReference[]> {
  const found = new Map<string, UnresolvedReference>();
  for (const match of content.matchAll(/`(?:\.metaproject\/)?((?:skills|rules)\/[^`\s]+\.(?:md|json))`/gi)) {
    const ref = match[1];
    if (!ref || found.has(ref) || ref.split("/").includes("..")) continue;
    // A `rules/core/<name>.md` keryx moved is looked for at its new path.
    // A project keryx has not updated yet still has it at the cited path (R2-LS-4).
    const lookup = ref.startsWith("rules/") ? `rules/${canonicalRuleReference(ref.slice("rules/".length))}` : ref;
    const exists = async (relative: string) => pathExists(path.join(projectRoot, ".metaproject", relative));
    if (!(await exists(lookup)) && (lookup === ref || !(await exists(ref)))) {
      found.set(ref, { ref, reason: "missing" });
    }
  }
  for (const match of content.matchAll(/`((?:~\/|\/)[^`\s]+\.mdc)`/gi)) {
    const ref = match[1];
    if (ref && !found.has(ref)) found.set(ref, { ref, reason: "non-portable" });
  }
  return [...found.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
