// Flow 207, §5.3 — structural evaluation of the BUNDLED skill tree.
//
// WHAT THIS IS, STATED BEFORE ANYTHING ELSE
//
// This is LAYER ONE of the three-layer bar the roadmap names, and only layer
// one. The roadmap asks for:
//
//   1. static structural validation        <- this file
//   2. a judge across named dimensions     <- NOT BUILT
//   3. reliability over repeated runs      <- NOT BUILT
//
// Layers two and three need a model in the loop and a corpus of repeated runs.
// Neither exists, and no part of this file approximates either. Saying so here
// is not modesty: the Phase 7 audit spent 217 rows on documents that described
// pipelines nobody built, and a file called `bundled-eval` that implied a judge
// would be the same defect one directory over. What runs here is decidable by
// reading files, and everything it reports is a fact about bytes on disk.
//
// WHY IT EXISTS
//
// `keryx skills verify` (src/gdskills/verify.ts) evaluates PROJECT skills — the
// ones a user generates into their own `.metaproject/project-skills/`. Nothing
// evaluated `src/gdskills/bundled/`, the 65 `SKILL.md` files copied verbatim
// into every installation. They were assumed correct, and were not. This sweep's
// first clean run over the shipped tree returned 27 findings:
//
//   - 1 skill named but never bundled — `feature-dev` said "Launch `code-review`
//     skill", and no `code-review` has ever shipped;
//   - 25 paths into the shipped tree that resolved to nothing, in 9 distinct
//     forms, every one of them missing its category segment: four contract
//     schemas under `skills/review-orchestrator/` (the directory is
//     `skills/review/review-orchestrator/`), and five sibling skills addressed
//     as `skills/<name>` rather than `skills/<category>/<name>`;
//   - 1 script, `.metaproject/scripts/detect-models.sh`, cited by
//     `flow-orchestrator` as the way to find a cheaper model. It has never
//     existed in any tree, in any release.
//
// All 27 are fixed in the same change that added this file, in both the bundled
// source and its `.metaproject` mirror.
//
// COMPOSITION, NOT DUPLICATION
//
// Two of the rules this sweep applies already had one executable definition
// each, and both are imported rather than restated:
//
//   - `concreteModelDeclarations` (model-tier.ts) is the AC14 rule about naming
//     a model where a tier belongs.
//   - `personaOffenders` / `homePathOffenders` live HERE and
//     `bundled-no-persona.test.ts` imports them, so flow 206's guard and this
//     sweep cannot drift apart. They moved out of the test file for that reason
//     and for no other; the wording of their justifications moved with them.
//
// THE DENOMINATOR IS PART OF THE RESULT
//
// `evaluateBundledTree` returns `skills` alongside `findings` because a sweep
// that walked nothing reports zero findings and reads as a pass. Every caller —
// the guard test and the command — asserts on that number. It is the same
// non-vacuity rule flow 204 wrote into `model-tier.test.ts` after finding five
// vacuous sweeps.
//
// RESOLVED AGAINST THE INSTALLED LAYOUT, NOT THE CHECKOUT (flow 252)
//
// `xref:path` existed to say whether a path resolves. It did not say WHERE a
// path has to resolve, and the gap was the checkout: `skills/review/…` (no
// `gdskills/` segment) is a real, walkable directory in THIS repository —
// `src/gdskills/bundled/skills/review/…` — so the old normaliser accepted it
// unconditionally and checked it against that same source tree. It never
// exists in an installed project, which has no top-level `skills/` at all,
// only `.metaproject/skills/gdskills/…`. `skills/shared/git-merge-base.md`
// shipped in eleven review skills reading exactly that way — correct by the
// sweep's own resolution, broken for every user who installed the package —
// until it was rewritten by hand and the sweep never noticed either state.
// `resolveInstalledReference` now answers the question the check's name always
// implied: is this the address an installed project actually has. A bare
// `skills/<category>/<name>` naming a whole skill (no file past it) is still
// accepted, the same citation convention `rules/core/<file>` already used
// elsewhere in this tree; anything reaching further into a skill is either the
// `.metaproject/skills/gdskills/…` (or `skills/gdskills/…`) form or it is dead
// on install regardless of what this checkout happens to have on disk. Rule
// files under `rules/core/` are swept the same way — nothing read them before.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizeRouteText, routeTokens } from "../lib/route-tokens";
import { BUNDLED_GDSKILLS } from "./catalog";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";
import { concreteModelDeclarations } from "./model-tier";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import { DEFAULT_SKILL_LENGTH_CEILING, SKILL_LENGTH_CEILINGS } from "./skill-length-ceilings";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * The checks this evaluator runs. Ids, not prose: they are asserted in tests and
 * printed for operators, so they must not drift with wording.
 */
export const BUNDLED_SKILL_CHECKS = [
  "frontmatter:block",
  "frontmatter:name",
  "frontmatter:name-unique",
  "frontmatter:description",
  "description:trigger-phrase",
  "description:bare-imperative",
  "description:length",
  "description:collision",
  "anatomy:sections",
  "anatomy:red-flags-collision",
  "anatomy:length",
  "frontmatter:metadata",
  "frontmatter:harness-claude",
  "frontmatter:category",
  "catalog:registered",
  "model:concrete-declaration",
  "persona:name",
  "persona:marker",
  "path:personal-home",
  "xref:skill",
  "xref:path",
  "document:addressable",
  "document:build-parity",
] as const;

export type BundledSkillCheck = (typeof BUNDLED_SKILL_CHECKS)[number];

/** One structural defect, located precisely enough to fix without searching. */
export interface BundledSkillFinding {
  /** Which rule fired. */
  readonly check: BundledSkillCheck;
  /** Skill directory name, e.g. `feature-dev`. */
  readonly skill: string;
  /** Path relative to the swept root, e.g. `orchestration/feature-dev/SKILL.md`. */
  readonly file: string;
  /** 1-based line, or `null` when the defect is the absence of something. */
  readonly line: number | null;
  /** What is wrong, and what would make it right. */
  readonly message: string;
}

/** What one sweep produced. `skills` is the denominator, and it is load-bearing. */
export interface BundledSkillEvaluation {
  /** Absolute path of the tree that was walked. */
  readonly root: string;
  /** How many `SKILL.md` files were found. Zero means the sweep proved nothing. */
  readonly skills: number;
  /**
   * How many skill DOCUMENTS were read — `SKILL.md`, every harness build, and
   * every companion document `KNOWN_SKILL_COMPANION_DOCUMENTS` names
   * (`orchestrator-prompt.md`, `SKILL.detail.md` — swept for cross-references
   * only, per flow 257 T16; see the loop that reads them for why).
   *
   * A second denominator, not a replacement: `skills` counts the skills, this
   * counts the files whose bytes were actually checked. They differ by the
   * harness builds that ship (111 when this was written; 14 once flow 257
   * deleted the byte-identical ones) plus the handful of companions, and
   * reporting only the first is what let a build diverge from its own
   * `SKILL.md` while the sweep reported everything clean.
   */
  readonly documents: number;
  /** Every skill directory name found, sorted — the resolvable cross-reference set. */
  readonly skillNames: readonly string[];
  readonly findings: readonly BundledSkillFinding[];
}

// ---------------------------------------------------------------------------
// Persona and home-directory rules (flow 206 AC1, moved here to be shared)
// ---------------------------------------------------------------------------

/**
 * The reviewer flow 206 removed, in every spelling the repository used.
 *
 * `b091` was the name on disk; `boss` was the name eleven files asked for. Both
 * name the same person, and a rename between them is not a de-personalisation —
 * which is why both are listed rather than only the one that shipped.
 */
export const PERSONA_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bb091\b/i, why: "the reviewer's handle as it appeared on disk" },
  { pattern: /\bboss\b/i, why: "the reviewer's handle as eleven files referred to them" },
];

/**
 * Their speech and their team's conventions, stated as universal rules.
 *
 * Replacing a name with a placeholder was explicitly not enough, so the markers
 * that identify the same person without naming them are listed too. Each is a
 * phrase that carries no meaning outside that reviewer's own repository.
 */
export const PERSONAL_MARKER_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /not today ;P/i, why: "the reviewer's own catchphrase" },
  { pattern: /\bducttape\b/i, why: "the reviewer's own term, spelled their way" },
  { pattern: /\bbroken thinking\b/i, why: "the reviewer's own verdict vocabulary" },
];

/**
 * Home directories.
 *
 * `~/.claude`, `~/.cursor`, `${CODEX_HOME:-~/.codex}` and friends are NOT
 * violations: they are where the harnesses themselves keep their configuration,
 * they are the same path on every machine, and a skill that installs into a
 * harness has to name them. The violation is a path into a PARTICULAR person's
 * home — an absolute `/home/<user>/…` or `/Users/<user>/…`, or a `~/`-rooted
 * directory that is not a known harness's own.
 */
export const HARNESS_HOME_ROOTS: readonly string[] = [
  "~/.claude",
  "~/.codex",
  "~/.cursor",
  "~/.antigravity",
  "~/.config/zed",
  "~/.config/opencode",
  "~/.config/keryx",
  "~/.gemini",
  "~/.windsurf",
];

/**
 * The account names a documentation example is allowed to use.
 *
 * `/Users/dev/<PROJECT>` in a schema's `examples` is not a personal path: it
 * names nobody, it is the same on every machine, and a skill documenting a
 * `codebase_path` field has to show one. A real login is refused everywhere.
 */
export const PLACEHOLDER_ACCOUNTS: ReadonlySet<string> = new Set([
  "dev",
  "user",
  "you",
  "me",
  "username",
  "youruser",
]);

const ABSOLUTE_HOME = /(?:^|[\s"'`(=])(?:\/home|\/Users)\/([A-Za-z<][\w.<>-]*)\//g;
const TILDE_PATH = /~\/[\w.\-/${}:]+/g;

/**
 * Every persona name or speech marker `text` carries.
 *
 * `kind` distinguishes the two, because they are two different findings: a NAME
 * is the reviewer's handle, a MARKER is their speech surviving a rename. A
 * removal that swaps the name for a placeholder and leaves the catchphrase is
 * the exact half-fix flow 206 refused, so the two must stay separable rather
 * than collapse into one count.
 */
export function personaOffenders(text: string): { line: number; kind: "name" | "marker"; why: string }[] {
  const out: { line: number; kind: "name" | "marker"; why: string }[] = [];
  text.split("\n").forEach((line, index) => {
    for (const { pattern, why } of PERSONA_PATTERNS) {
      if (pattern.test(line)) out.push({ line: index + 1, kind: "name", why });
    }
    for (const { pattern, why } of PERSONAL_MARKER_PATTERNS) {
      if (pattern.test(line)) out.push({ line: index + 1, kind: "marker", why });
    }
  });
  return out;
}

/** Every path into a particular person's home directory, as `{ line, why }`. */
export function homePathOffenders(text: string): { line: number; why: string }[] {
  const out: { line: number; why: string }[] = [];
  text.split("\n").forEach((raw, index) => {
    for (const match of raw.matchAll(ABSOLUTE_HOME)) {
      const account = match[1] ?? "";
      // `<user>`, `<USER>` and friends are the field, not an occupant of it.
      if (account.startsWith("<") || PLACEHOLDER_ACCOUNTS.has(account.toLowerCase())) continue;
      out.push({ line: index + 1, why: `absolute path into ${account}'s home directory` });
    }
    for (const match of raw.match(TILDE_PATH) ?? []) {
      // `${CODEX_HOME:-~/.codex}` and the like: the default inside the
      // expansion is the thing being checked.
      const normalised = match.replace(/^.*:-/, "");
      if (HARNESS_HOME_ROOTS.some((root) => normalised.startsWith(root))) continue;
      out.push({ line: index + 1, why: `home path outside the known harness roots — ${match}` });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** The YAML frontmatter block, or `undefined` when the file opens without one. */
export function frontmatterBlock(markdown: string): string | undefined {
  if (!markdown.startsWith("---")) return undefined;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return markdown.slice(3, end);
}

/**
 * Top-level frontmatter keys and their scalar values.
 *
 * Deliberately shallow: `metadata:` opens a nested block and its value here is
 * the empty string, which is enough to answer "is the key present". Parsing YAML
 * properly would add a dependency to answer a question nothing asks.
 */
function frontmatterKeys(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (match === null) continue;
    out.set(match[1] as string, (match[2] ?? "").trim());
  }
  return out;
}

/**
 * Where the evaluator's own code lives, for the report header.
 *
 * Reported relative to the working directory whenever it sits inside it, which
 * is both what the reader needs — "this is the checkout I am editing", versus an
 * absolute path somewhere else that is the installed build — and what keeps an
 * operator's home directory out of a report people paste into issues. This file
 * flags `path:personal-home` in skill text; its own output should not add one.
 * Falls back to a plain marker where `import.meta.url` is not a file URL.
 */
function evaluatorSource(): string {
  try {
    const here = new URL(".", import.meta.url);
    if (here.protocol !== "file:") return "unknown";
    const dir = decodeURIComponent(here.pathname);
    const rel = path.relative(process.cwd(), dir);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : dir;
  } catch {
    return "unknown";
  }
}

/**
 * Frontmatter fields a harness build may legitimately differ from its `SKILL.md`
 * on.
 *
 * `compatible_harnesses` is per-build metadata by construction — the exporter
 * writes it, and 14 shipped builds differ from their canonical file in that one
 * line and nothing else. Everything outside this set diverging means the build
 * has fallen behind.
 */
const BUILD_DIVERGENCE_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["compatible_harnesses"]);

/**
 * A document reduced to what a build and its `SKILL.md` must share: the whole
 * body, plus every frontmatter line except the fields a build may set itself.
 */
function buildComparableText(markdown: string): string {
  const block = frontmatterBlock(markdown);
  if (block === undefined) return markdown;
  const body = markdown.slice(block.length + 3);
  const kept = block
    .split("\n")
    .filter((line) => {
      const match = /^\s*([A-Za-z_][\w-]*)\s*:/.exec(line);
      return match === null || !BUILD_DIVERGENCE_ALLOWED_FIELDS.has(match[1] as string);
    })
    .join("\n");
  return `${kept}${body}`;
}

/**
 * Frontmatter fields every bundled skill must carry, each mapped to the check id
 * its absence reports under.
 *
 * The set is what all 65 files already declare, which is the only defensible
 * place to set the bar: a required field that some shipped skill lacks is a
 * guard that fails on arrival and gets deleted, and a field none of them
 * declares is an aspiration rather than a rule.
 *
 * A map rather than a list, and `satisfies` rather than a cast, so adding a
 * required field without adding its check id is a COMPILE error. The cast this
 * replaced would have produced a finding carrying an id absent from
 * `BUNDLED_SKILL_CHECKS`, which the renderer would then never print.
 */
export const REQUIRED_FRONTMATTER_CHECKS = {
  name: "frontmatter:name",
  description: "frontmatter:description",
  metadata: "frontmatter:metadata",
} as const satisfies Record<string, BundledSkillCheck>;

/** The required field names, for callers that only need the list. */
export const REQUIRED_FRONTMATTER_FIELDS = Object.keys(
  REQUIRED_FRONTMATTER_CHECKS,
) as readonly (keyof typeof REQUIRED_FRONTMATTER_CHECKS)[];

// ---------------------------------------------------------------------------
// Description quality (flow 257 T7)
// ---------------------------------------------------------------------------
//
// `frontmatter:description` (above) answers one question: does the field exist
// and resolve to text a harness can serve at all. It fires on absence and on a
// block scalar that resolves to nothing. It does NOT judge the text's shape,
// and three shapes slip past it while still routing badly:
//
//   - no trigger phrase at all, so an agent choosing between skills has no
//     situational cue and has to infer one from a summary of what the skill
//     DOES rather than WHEN to reach for it;
//   - a trigger phrase followed by a bare imperative verb ("Use when
//     implement a feature…") — grammatically a command aimed at the skill,
//     not a description of the situation that should trigger it, and the
//     shape flow 257 T6 removed from the tree;
//   - a description past the length a harness's routing prompt can afford,
//     concretely the 1024-character cap agentskills.io's skill spec sets.
//
// These are kept as a SEPARATE `description:*` family rather than folded into
// `frontmatter:description`, on purpose: that check is a parse-level fact
// ("does this resolve to text"), these three are a content-quality judgment
// ("is that text shaped to route on"), and collapsing four unrelated failure
// reasons into one id is exactly what `REQUIRED_FRONTMATTER_CHECKS`'s own
// comment above warns against — an operator reading `frontmatter:description:
// 3 finding(s)` could not tell an empty field from a well-formed paragraph
// that is merely too long.

/**
 * Trigger phrases a description's routing clause may open with.
 *
 * Derived empirically, not guessed: every one of the 67 shipped `SKILL.md`
 * descriptions contains at least one of these three, and none contains "Use
 * before", "Use after", or "Use while" — phrases that read as equally valid
 * English but that this sweep has no shipped example to verify against. A
 * set that admits a phrase nothing on disk uses is an aspiration, the same
 * defect `REQUIRED_FRONTMATTER_FIELDS`'s comment already refuses for required
 * fields. Widen this set only once a shipped description actually needs the
 * wider phrase — the check adapts to the tree, not the other way round.
 */
export const ALLOWED_DESCRIPTION_TRIGGER_PHRASES: readonly string[] = ["Use when", "Use to", "Use for"];

const TRIGGER_PHRASE_PATTERN = new RegExp(
  `\\b(?:${ALLOWED_DESCRIPTION_TRIGGER_PHRASES.map((phrase) => phrase.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "i",
);

/** Whether `description` carries none of `ALLOWED_DESCRIPTION_TRIGGER_PHRASES`. */
export function descriptionLacksTriggerPhrase(description: string): boolean {
  return !TRIGGER_PHRASE_PATTERN.test(description);
}

/**
 * Verb infinitives that read as a command when they follow "Use when" —
 * "Use when implement a feature" says to the reader "implement", not "use
 * this when a feature needs implementing".
 *
 * Not an attempt at an exhaustive English verb list — that trades a false
 * negative on some verb missing from it for a false positive on every common
 * noun this sweep cannot tell apart from a verb (a list of ALL infinitives
 * would have to include words like "test" and "plan" that are ordinary nouns
 * as often as they are verbs, e.g. "Use when test coverage drops"). Sized to
 * the mistake this rule exists to catch: an author writing the clause as an
 * instruction to the skill out of habit, using the bare form of a verb that
 * unambiguously reads as an action when it opens a sentence.
 *
 * THIS SET IS THE UNAMBIGUOUS HALF, and it used to be both halves. Fourteen
 * words — "review", "check", "commit", "update", "install", "document",
 * "push", "run", "start", "debug", "fix", "split", "draft", "edit" — shipped
 * here alongside "implement" and "decompose", and every one of them is an
 * ordinary NOUN at least as often as it is a verb. "Use when review comments
 * arrive", "Use when check results land", "Use when commit history needs
 * rewriting", "Use when install fails" are all noun-phrase subjects — exactly
 * the situational shape this check exists to encourage — and every one of
 * them was reported as a bare imperative. That is the same defect the comment
 * above already refuses for "test" and "plan", left in the set by oversight.
 * They moved to `NOUN_AMBIGUOUS_IMPERATIVE_VERBS` below rather than being
 * deleted, because each really is imperative in the shape the check was
 * written for; what changed is that the shape now has to be visible.
 */
export const BARE_IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  "implement",
  "create",
  "write",
  "add",
  "build",
  "analyze",
  "generate",
  "deploy",
  "measure",
  "save",
  "explore",
  "open",
  "take",
  "decompose",
  "refactor",
  "migrate",
  "extract",
  "convert",
  "summarize",
  "classify",
  "rewrite",
  "verify",
  "validate",
  "audit",
  "execute",
  "distill",
  "customize",
  "configure",
  "launch",
  "remove",
  "delete",
  "scaffold",
  "replace",
  "rename",
  "investigate",
  "diagnose",
  "resolve",
]);

/**
 * Verbs that are ALSO ordinary nouns, and so only count as a bare imperative
 * when the token after them makes the imperative reading the only one
 * available.
 *
 * "Use when review the diff" can only be a command: "review" heads a verb
 * phrase whose object is introduced by a determiner. "Use when review
 * comments arrive" is a noun phrase — "review comments" is the subject of
 * "arrive" — and is precisely the situational description the check wants to
 * see. The distinguishing token is the determiner, not the verb, so the verb
 * alone cannot decide.
 */
export const NOUN_AMBIGUOUS_IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  "review",
  "check",
  "commit",
  "update",
  "install",
  "document",
  "push",
  "run",
  "start",
  "debug",
  "fix",
  "split",
  "draft",
  "edit",
]);

/**
 * Determiners and possessives that can only introduce the OBJECT of a verb
 * phrase, never continue a noun-phrase subject headed by the preceding word.
 *
 * "review the diff" — "the" cannot attach to "review" as a compound noun, so
 * "review" is the verb. "review comments" — "comments" can and does. The list
 * is deliberately closed and small: every entry is a function word with no
 * reading in which it modifies the word before it. Widen it only for another
 * word with that same property.
 */
export const IMPERATIVE_OBJECT_DETERMINERS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "its",
  "it",
  "them",
  "their",
  "your",
  "my",
  "our",
  "every",
  "each",
]);

/**
 * Match "Use when" (any casing, an optional colon/dash after it) followed by
 * one bare word — the token this rule classifies — and, optionally, the word
 * after it, which is what decides a `NOUN_AMBIGUOUS_IMPERATIVE_VERBS` entry.
 */
const USE_WHEN_OPENING = /\buse\s+when\s*[:\-—]?\s*([A-Za-z][\w'-]*)(?:\s+([A-Za-z][\w'-]*))?/gi;

/**
 * The offending verb, if `description` opens a "Use when" clause with a bare
 * imperative — `undefined` otherwise.
 *
 * Deliberately conservative in what it calls a verb: a capitalized token
 * ("Use when MobX…") is a proper noun, not a verb in imperative mood, and a
 * token ending in "-ing" ("Use when reviewing…") is already the gerund this
 * rule wants, not the defect. Only a lowercase, non-gerund token that matches
 * `BARE_IMPERATIVE_VERBS` fires — an unrecognized lowercase word (e.g. "Use
 * when a…", "Use when dispatched…") is left alone rather than guessed at,
 * because a false positive here breaks a description this sweep did not
 * write and cannot safely rewrite on its own.
 *
 * A `NOUN_AMBIGUOUS_IMPERATIVE_VERBS` entry additionally needs the following
 * token to be an `IMPERATIVE_OBJECT_DETERMINERS` word — see both sets for
 * why the verb alone cannot decide those fourteen.
 */
export function bareImperativeOpening(description: string): string | undefined {
  for (const match of description.matchAll(USE_WHEN_OPENING)) {
    const token = match[1] ?? "";
    if (token.length === 0) continue;
    if (/^[A-Z]/.test(token)) continue;
    if (/ing$/i.test(token)) continue;
    const verb = token.toLowerCase();
    if (BARE_IMPERATIVE_VERBS.has(verb)) return token;
    if (
      NOUN_AMBIGUOUS_IMPERATIVE_VERBS.has(verb) &&
      IMPERATIVE_OBJECT_DETERMINERS.has((match[2] ?? "").toLowerCase())
    ) {
      return token;
    }
  }
  return undefined;
}

/**
 * The description length cap agentskills.io's skill spec sets. Past this, a
 * harness's routing prompt pays for prose that will not fit whatever budget
 * it allotted the description, on every request it ever considers this
 * skill for.
 */
export const MAX_DESCRIPTION_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Description collision (flow 257 T11, AC6)
// ---------------------------------------------------------------------------
//
// The three checks above each judge ONE description in isolation. None of
// them can see two descriptions that read as near-duplicates of EACH OTHER —
// a router scores both skills for the same request and an agent choosing
// between them has no signal beyond a coin flip. `context-router`'s own
// SKILL.md carries a comment (`catalog.ts`) explicitly carving "collect
// context" out of its trigger list because `context-collector` already owns
// that phrase; nothing before this check verified the tree does not have
// OTHER pairs quietly reproducing what that one hand-written comment guards
// against.
//
// MEASURE: Jaccard similarity — |intersection| / |union| — over
// `routeTokens(normalizeRouteText(description))` for each of two skills' own
// descriptions. Both functions are imported from `../lib/route-tokens`
// (`routeTokens` exported for exactly this use; see its comment there) rather
// than restated, so this check judges a description on the IDENTICAL
// tokenisation the router itself scores it with — not a second guess at what
// counts as a token. `../commands/skills.ts` (the router) imports the same
// two functions from that same module rather than defining its own, which is
// what keeps the two sides on one tokenizer — see `route-tokens.ts`'s header
// for why it moved out of `commands/skills.ts` (flow 257 T18, an
// import-policy boundary fix). Unexpanded (`expand` left `false`): expansion
// adds Russian-prefix synonyms to an INCOMING QUERY (see `expandQueryTokens`), and
// a skill's own description is never a query — `scoreBundledSkillRoute`
// builds its own haystack the same unexpanded way.
//
// Jaccard, not cosine/TF-IDF: `scoreBundledSkillRoute`'s own overlap term is
// `overlap.length * 10`, a plain per-token count with no frequency or rarity
// weighting anywhere in the router. A weighted measure here would judge a
// pair by a signal the router never consults when it actually decides between
// them. Intersection-over-union of the two token sets asks the same question
// the router's own scoring asks: of everything either description would
// match a query against, how much do both share.
//
// THRESHOLD: >= `DESCRIPTION_COLLISION_THRESHOLD` (0.75) is a finding, naming
// both skills and the score. AC6 also asks for pairs at >= 0.50 to be visible
// as a non-failing note — but neither `BundledSkillEvaluation` nor
// `renderBundledEvaluation` carries any channel for a non-failing observation
// alongside `findings`; every existing check reports by being silent or by
// adding a finding, nothing between. Inventing a second reporting channel for
// one check would be exactly the kind of aspiration `ALLOWED_DESCRIPTION_
// TRIGGER_PHRASES`'s comment above refuses ("derived from what the tree
// already does", not from what one check alone would like to have). The
// 0.50 tier is therefore left OUT of `findings` entirely: `collisionPairs`
// below is exported so a caller — an operator, or the top-10 report flow 257
// T11 hands to T12 — can still ask "what is close to the line" directly,
// without this check treating "close" as a failure.
//
// Pairwise, not per-file: unlike every check above, one description's
// collision status depends on every OTHER skill's description, not on its own
// text. It cannot run inside the per-document loop below; `evaluateBundledTree`
// collects every non-empty served description first and sweeps pairs once
// all of them are known.

/** Jaccard similarity threshold at which two descriptions are a finding. */
export const DESCRIPTION_COLLISION_THRESHOLD = 0.75;

/**
 * The tier AC6 asks to be visible without failing. Not read by
 * `evaluateBundledTree` — see the comment above for why no non-failing
 * channel exists to gate on it — kept here so the number this check
 * distinguishes from a real finding is written down once, not repeated at
 * every call site that reports on `collisionPairs`.
 */
export const DESCRIPTION_COLLISION_WATCH_THRESHOLD = 0.5;

/** One pair of skills whose descriptions collide, and the score they collided at. */
export interface DescriptionCollisionPair {
  /** `${category}/${name}`, the lexicographically earlier of the two. */
  readonly a: string;
  /** `${category}/${name}`, the lexicographically later of the two. */
  readonly b: string;
  /** Jaccard similarity of the two descriptions' route tokens, in `[0, 1]`. */
  readonly similarity: number;
}

/** `routeTokens(normalizeRouteText(description))` — see the MEASURE note above for why this exact pipeline, unexpanded. */
export function descriptionRouteTokens(description: string): ReadonlySet<string> {
  return routeTokens(normalizeRouteText(description));
}

/** Jaccard similarity of two token sets: `|intersection| / |union|`. `0` when either is empty — an empty description never "collides". */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Every pair of `entries` (key -> description) at or above `minSimilarity`,
 * sorted by similarity descending (ties broken by key, for a deterministic
 * report). `entries` is keyed by `${category}/${name}`, matching every other
 * exemption map in this file (`PENDING_ANATOMY_BACKFILL` and friends).
 */
export function collisionPairs(
  entries: ReadonlyMap<string, string>,
  minSimilarity: number,
): DescriptionCollisionPair[] {
  const keys = [...entries.keys()].sort();
  const tokensByKey = new Map(keys.map((key) => [key, descriptionRouteTokens(entries.get(key) ?? "")]));
  const out: DescriptionCollisionPair[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string;
      const b = keys[j] as string;
      const similarity = jaccardSimilarity(tokensByKey.get(a) ?? new Set(), tokensByKey.get(b) ?? new Set());
      if (similarity >= minSimilarity) out.push({ a, b, similarity });
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
}

/** Canonical, order-independent key for one pair — `(a, b)` and `(b, a)` resolve to the same entry, since similarity is symmetric. */
export function collisionPairKey(a: string, b: string): string {
  return [a, b].sort().join(" :: ");
}

/** An exemption from one `description:collision` finding, with the reason a human can check. */
export interface DescriptionCollisionExemption {
  /** Why this pair ships at or above the threshold anyway. Must name T12 — see `collisionReasonNamesOwner`. */
  readonly reason: string;
}

/**
 * Real collisions the shipped tree has TODAY, each owed to flow 257's T12 (the
 * task this dispatch hands the list to, per AC6) rather than fixed here: T11
 * owns this check and its fixtures, not the wording of any bundled skill's
 * description, and three OTHER tasks (T13, T14, T15) are editing skill bodies
 * and descriptions concurrently as this file is written — editing a
 * description out from under one of them is exactly the collision a worktree
 * split exists to prevent. An entry here is what keeps the shipped tree's
 * `description:collision` finding count at zero while T12 has not yet acted;
 * it is not a permanent allowance the way `PERMANENT_ANATOMY_EXEMPTIONS` is; a
 * key surviving here after T12 lands is itself something T3 (flow 257's final
 * verification task) should notice, the same role `PENDING_ANATOMY_BACKFILL`
 * plays for the anatomy checks above.
 */
export const KNOWN_DESCRIPTION_COLLISIONS: ReadonlyMap<string, DescriptionCollisionExemption> = new Map([]);

/** Every entry's reason must name flow 257's T12, or this map has quietly become a silent, unowned suppression list. */
export function collisionReasonNamesOwner(reason: string): boolean {
  return /\bT12\b/.test(reason);
}

// ---------------------------------------------------------------------------
// Anatomy sections (flow 257 T8, AC3)
// ---------------------------------------------------------------------------
//
// The `description:*` family above judges the ROUTING clause in isolation. It
// says nothing about the rest of the document, and three structural gaps slip
// past every check above while a skill still routes fine and still "works" on
// a lucky run:
//
//   - no disambiguation for the agent that already chose this skill and needs
//     to know what it is NOT the tool for;
//   - no catalogue of the specific ways an agent talks itself into skipping
//     this skill's own rules — the exact failure mode a generic reminder to
//     "be careful" cannot prevent, because it names nothing concrete;
//   - no stated shape for "done" — a caller (a human, or an orchestrator
//     reading a subagent's final line) has nothing to check the result
//     against.
//
// Each of the three is defined below precisely enough that "does this skill
// have it" is decidable by reading the file, not a judgment call — the same
// bar `ALLOWED_DESCRIPTION_TRIGGER_PHRASES` and `BARE_IMPERATIVE_VERBS` above
// hold themselves to: derived from what the 67 shipped skills that already do
// this well actually wrote, not from an aspiration nothing on disk uses.

/**
 * The three anatomy sections this check requires, and the vocabulary the
 * exemption maps below key their entries by. Not check ids on their own —
 * every deficiency reports under the single `anatomy:sections` id, per AC3,
 * with the finding's message naming which of these three is missing.
 */
export const ANATOMY_SECTIONS = ["trigger-not-for", "red-flags", "verification"] as const;

export type AnatomySection = (typeof ANATOMY_SECTIONS)[number];

/**
 * DEFINITION 1 — trigger + "NOT for" clause.
 *
 * WHERE IT MAY LIVE: anywhere in the shipped document — the frontmatter
 * `description` (as a trailing sentence of a single-line or block-scalar
 * value) or the Markdown body (as a bullet, a sentence, or its own line). Both
 * shapes ship today: 34 of the 35 skills that already have this clause carry
 * it inside `description`, folded into the routing text an agent reads before
 * ever opening the file (e.g. `review-architecture`'s `description: |` block
 * ends "NOT for: style/naming preferences, …"); exactly one
 * (`metaproject-security`) states it as body prose directly under the H1
 * instead ("Use this skill for the `security` module, not for dependency CVEs
 * …"). Restricting the check to `description` only would report that one
 * skill as missing a disambiguation it already states in plain English one
 * line into the file — a false positive this definition exists to avoid.
 *
 * ACCEPTED SPELLING: the literal phrase "not for" (case-insensitive — the
 * shipped tree spells it "NOT for" every time, but nothing about the
 * disambiguation depends on capitalisation, unlike the trigger-phrase check
 * above whose whole point IS the exact opening words a harness pattern-
 * matches). No other spelling ("not applicable to", "never for", "excludes")
 * is accepted, for the same reason `ALLOWED_DESCRIPTION_TRIGGER_PHRASES`
 * accepts only three phrases: a spelling nothing on disk uses is a guess, not
 * a rule derived from the tree.
 *
 * This intentionally does NOT require the clause to sit inside the
 * `description:trigger-phrase` clause specifically (i.e. literally following
 * "Use when …") — `description:trigger-phrase` (above) already guarantees a
 * trigger exists somewhere in the description; this check only adds "and did
 * the document also say what it is not for", wherever that statement lives.
 *
 * BOUNDED ON BOTH SIDES, AND WHY THAT IS NOT PEDANTRY: the first spelling of
 * this pattern was a bare `/not for/i`, with a word boundary at neither end.
 * "This output is not formatted as JSON" contains the substring "not for" and
 * satisfied it — a sentence about formatting, in any skill, silently supplied
 * that skill's disambiguation. The same hole admits "not forced", "not
 * fortunate", "not foreseeable", and every other "not for…" word. `\s+` rather
 * than a literal space because prose wraps: "…, not\nfor anything else" is the
 * same clause with a line break in the middle of it.
 */
const NOT_FOR_CLAUSE_PATTERN = /\bnot\s+for\b/i;

/** Whether `text` (the whole document: frontmatter + body) states a "NOT for" disambiguation. */
export function hasNotForClause(text: string): boolean {
  return NOT_FOR_CLAUSE_PATTERN.test(text);
}

/**
 * DEFINITION 2 — Red Flags / rationalization table.
 *
 * HEADING SPELLINGS: a Markdown heading (`#` through `####`) whose text
 * contains, case-insensitively, "red flag" (matches "Red Flags", "Red Flags
 * Table", and the singular "Red Flag") or "rationali" (matches
 * "Rationalization"/"Rationalisation", either spelling). Both stems are
 * already shipped headings — "Red Flags" (11 skills), "Red Flags Table" (4
 * skills, all `review-*`) — and matched by heading text rather than by an
 * exact string so a heading such as `## Red Flags — Stop and re-read this
 * skill if you are thinking:` (task-implementer, feature-dev, issue-analyzer)
 * still counts.
 *
 * WHAT MAKES IT A TABLE (OR A TWO-COLUMN LIST): the heading alone is not
 * enough — `job-orchestrator` has two `### Red Flag` headings, and each is
 * one bolded rationalization quote followed by one paragraph of rebuttal,
 * scattered numbers of paragraphs apart under unrelated parent sections. That
 * is a single inline catch, not the consolidated reference table this check
 * requires, and it must not satisfy the same bar a real table does. So the
 * heading's own section (every line up to the next heading at the same or a
 * shallower level) must additionally contain either:
 *
 *   - a Markdown table with at least `ANATOMY_RED_FLAGS_MIN_ROWS` DATA rows
 *     (the header row itself does not count), or
 *   - at least `ANATOMY_RED_FLAGS_MIN_ROWS` consecutive two-column bullet
 *     rows (`- <quote> — <why>`) — no shipped skill uses this shape today,
 *     but AC3 names it as an accepted alternative to a table, so a future
 *     skill that lists rationalizations as bullets rather than a `|…|…|`
 *     table is not forced into table syntax just to pass this check.
 *
 * WHY 3 ROWS: every genuine shipped table has at least 4 data rows
 * (`stack-advisor`'s is the shortest, at 4; `review-logic` and
 * `review-performance` both have 6). Three sits one below that observed floor
 * — high enough that a single scattered callout (one row, by construction)
 * cannot pass, low enough that no compliant skill on the tree today is
 * pushed into non-compliance by a threshold picked too high. It is not "the
 * smallest number that rules out one row": two would already do that. Three
 * is chosen so the bar reads as "a handful of ways this goes wrong", plural
 * in the ordinary sense, rather than the bare minimum that defeats a single
 * counterexample.
 *
 * AND WHAT MAKES A ROW A ROW (flow 257 T19): the row count above was the only
 * thing standing between a rationalization table and a placeholder, so three
 * lines reading `| a | b |` satisfied the whole check. The table is the one
 * anatomy section whose value is entirely in its CONTENT — a named excuse and
 * the rebuttal that answers it — so a row that names neither is not a row this
 * check should count. Two conditions, both derived from the shipped tree
 * rather than guessed:
 *
 *   - at least two non-empty cells, because the shape is a pair (the excuse
 *     and the answer), and a one-column list of excuses is a list of things
 *     nobody has answered;
 *   - at least `ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS` characters of cell text
 *     in the row, all cells taken together.
 *
 * WHY 24 CHARACTERS: the shortest data row in any shipped Red Flags table
 * carries 72 characters of cell text (`review-security-code`'s "The team
 * would never send that payload" / "Attackers are not on the team"), and the
 * shortest non-empty single cell carries 11 (`spec-writer`'s "Scope creep").
 * 24 sits at a third of the observed row floor — far enough below it that no
 * shipped table is near the line and a genuinely terse future pair is not
 * pushed into padding, far enough above `| a | b |` (2 characters) that a
 * placeholder cannot pass. The same floor applies to the two-column bullet
 * shape, since a bullet row and a table row are the same claim in different
 * syntax.
 */
export const ANATOMY_RED_FLAGS_MIN_ROWS = 3;

/** Minimum characters of cell text one counted Red Flags row must carry. See the note above for the derivation. */
export const ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS = 24;

const RED_FLAGS_HEADING_PATTERN = /^(#{1,4})\s.*(red flag|rationali)/i;
const MARKDOWN_HEADING_PATTERN = /^(#{1,4})\s/;
const TABLE_ROW_PATTERN = /^\|.*\|\s*$/;
const TABLE_SEPARATOR_PATTERN = /^\|[\s:|-]+\|\s*$/;
const TWO_COLUMN_BULLET_PATTERN = /^-\s+\S.*(—|--|:).+\S/;

/** Every line of `text` from just after `start` up to the next heading at `level` or shallower. */
function sectionBody(lines: readonly string[], start: number, level: number): readonly string[] {
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = MARKDOWN_HEADING_PATTERN.exec(line);
    if (heading !== null && (heading[1] ?? "").length <= level) break;
    out.push(line);
  }
  return out;
}

/** The non-empty cell texts of one `|…|…|` row, outer pipes dropped. */
function tableRowCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/** Whether one data row carries enough to be a named excuse plus its answer. See `ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS`. */
function isSubstantiveTableRow(line: string): boolean {
  const cells = tableRowCells(line);
  if (cells.length < 2) return false;
  return cells.join("").length >= ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS;
}

/** The bullet-list spelling of the same claim, held to the same floor. */
function isSubstantiveBulletRow(line: string): boolean {
  if (!TWO_COLUMN_BULLET_PATTERN.test(line)) return false;
  return line.replace(/^-\s+/, "").replace(/[\s—:-]/g, "").length >= ANATOMY_RED_FLAGS_MIN_ROW_CHARACTERS;
}

/**
 * The data rows of `text`'s first qualifying Red Flags section, trimmed and
 * joined — the table's CONTENT, independent of its heading spelling and its
 * surrounding prose.
 *
 * `[]` when the document has no qualifying section. Exported because
 * `anatomy:red-flags-collision` (below) compares these bodies across skills:
 * a table pasted verbatim from another skill satisfies `hasRedFlagsSection`
 * perfectly while naming that OTHER skill's rationalizations, which is the
 * same "passes on borrowed substance" failure as a placeholder row, one step
 * further along.
 */
export function redFlagsTableBody(text: string): readonly string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = RED_FLAGS_HEADING_PATTERN.exec(lines[i] ?? "");
    if (heading === null) continue;
    const body = sectionBody(lines, i, (heading[1] ?? "").length);
    const tableRows = body.filter((line) => TABLE_ROW_PATTERN.test(line) && !TABLE_SEPARATOR_PATTERN.test(line));
    // The first `|…|` row is the header, not a rationalization.
    const dataRows = tableRows.slice(1).filter(isSubstantiveTableRow);
    const bulletRows = body.filter(isSubstantiveBulletRow);
    const rows = dataRows.length >= bulletRows.length ? dataRows : bulletRows;
    if (rows.length >= ANATOMY_RED_FLAGS_MIN_ROWS) return rows.map((row) => row.trim());
  }
  return [];
}

/** Whether `text` carries a Red Flags / rationalization table, per the definition above. */
export function hasRedFlagsSection(text: string): boolean {
  return redFlagsTableBody(text).length > 0;
}

/**
 * DEFINITION 3 — Verification / exit-criteria / STATUS section.
 *
 * HEADING SPELLINGS: a Markdown heading (`#` through `####`) whose text
 * contains, case-insensitively, "verification" or "exit criteria" (hyphen or
 * space) ANYWHERE in the heading, not only at its start — `flow-orchestrator`
 * ships `## Phase 3: Verification And Review` and `task-implementer` ships a
 * bare `## Verification`; both must count, so the pattern is not anchored
 * past the `#` marks. A heading containing only the bare word "status"
 * ("Status Updates", "Status line (first line of response)") does NOT count
 * on its own — those are formatting notes about where a line goes, not a
 * statement of what "done" looks like, and admitting them would make this
 * leg of the check nearly vacuous (half the `review-*` skills have a "Status
 * line" heading purely by formatting convention).
 *
 * WHAT ELSE COUNTS, PER THE TASK'S OWN CONTENT LIST: a heading is not the only
 * shape this repository already uses for "what done looks like":
 *
 *   - the STATUS CONTRACT LINE for subagent skills — a line, once leading
 *     Markdown decoration (`*`, `` ` ``, whitespace) is stripped, of the exact
 *     shape `STATUS: <UPPER_CASE_TOKEN>` (e.g. `STATUS: DONE`,
 *     `STATUS: BLOCKED`). This is the literal first-line-of-response contract
 *     `code-verifier`, `context-collector`, `tests-creator` and
 *     `job-orchestrator` all document, and for a skill dispatched only as a
 *     subagent it plays exactly the role a "## Verification" heading plays
 *     for a skill a user runs directly: a finite, checkable set of terminal
 *     states. Matched by the CAPITALISED form only — a YAML field such as
 *     `status: pass | fail | skipped` describing some OTHER thing's outcome
 *     (a single check's result, a job step's state) is not this skill's own
 *     reporting contract, and the shipped convention already reserves
 *     upper-case `STATUS:` for exactly this purpose;
 *   - an EXPLICIT EXIT-CRITERIA LIST in the shape the Phase-subagent family
 *     (`autodoc-analyst` and its siblings) uses instead of a prose contract:
 *     an Output Contract's `status:` field enumerating its own terminal
 *     values with `|`, e.g. `status: "DONE" | "DONE_WITH_CONCERNS" |
 *     "NEEDS_CONTEXT"`. This is the same information the STATUS line encodes
 *     — a finite named set of outcomes — spelled as a YAML enum because the
 *     subagent's contract IS a YAML block, not a prose response line.
 *
 * A bare checkbox list (`- [ ] …`) is deliberately NOT accepted as its own
 * qualifying shape here: several shipped skills use `- [ ]` purely for a
 * WORKFLOW progress tracker ("Phase 1: …", "Phase 2: …"), which is not an
 * exit criterion — it says what to do, not when the skill is done. Widen this
 * only if a shipped skill needs a genuine checkbox-shaped exit list that none
 * of the three shapes above already covers, per the same "widen once the tree
 * needs it" rule the trigger-phrase set states above.
 */
const VERIFICATION_HEADING_PATTERN = /^(#{1,4})\s.*(verification|exit[\s-]criteria)/i;
const STATUS_CONTRACT_LINE_PATTERN = /^[\s*`]*STATUS:\s*[A-Z_]/;
// Requires the FIRST alternative to be a quoted, all-caps token — the shape
// `autodoc-analyst` and its siblings use for their own terminal states
// (`status: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT"`). A lowercase,
// unquoted enum such as `status: pass | fail | skipped` (a single check's
// result, not the skill's own exit state — see the comment above) must NOT
// match, so the first alternative is anchored to `"UPPER_CASE"`.
const STATUS_CONTRACT_ENUM_PATTERN = /^[\s*`]*status:\s*"[A-Z][A-Z0-9_]*"\s*\|/;

/**
 * Whether `text` carries a Verification / exit-criteria / STATUS section, per
 * the definition above.
 *
 * A HEADING IS NOT A SECTION (flow 257 T19). `## Verification` with nothing
 * under it says no more about what "done" looks like than the absence of the
 * heading does, and it passed this check for the same reason a `| a | b |`
 * row passed the Red Flags one: presence was the whole bar. A heading now
 * qualifies only when its own section — every line up to the next heading at
 * the same level or shallower, the same span `hasRedFlagsSection` reads —
 * holds at least one non-blank line. The other two shapes need no such guard:
 * a `STATUS: DONE` line and a `status: "DONE" | …` enum ARE the content, not
 * an announcement of content to follow.
 */
export function hasVerificationSection(text: string): boolean {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (STATUS_CONTRACT_LINE_PATTERN.test(line) || STATUS_CONTRACT_ENUM_PATTERN.test(line)) return true;
    const heading = VERIFICATION_HEADING_PATTERN.exec(line);
    if (heading === null) continue;
    const body = sectionBody(lines, i, (heading[1] ?? "").length);
    if (body.some((bodyLine) => bodyLine.trim().length > 0)) return true;
  }
  return false;
}

/**
 * The line count `anatomy:length` compares against a ceiling, counted the way
 * `wc -l` counts: newline characters, so a file's trailing newline does not
 * add a line and a file without one does not lose its last.
 *
 * The count is the whole document, frontmatter included. What a ceiling bounds
 * is what an agent has to read before it can act, and the frontmatter is part
 * of that read.
 */
export function skillLineCount(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") count += 1;
  }
  return count;
}

/** What each `AnatomySection` reports as, when a finding names it. */
const ANATOMY_SECTION_LABELS: Record<AnatomySection, string> = {
  "trigger-not-for": 'a trigger with a "NOT for" clause',
  "red-flags": "a Red Flags / rationalization table",
  verification: "a Verification / exit-criteria / STATUS section",
};

/**
 * An exemption from one or more `anatomy:sections` findings, with the reason
 * a human can check.
 */
export interface AnatomySectionExemption {
  /** Which of the three sections this entry excuses — never all-purpose. */
  readonly sections: readonly AnatomySection[];
  /** Why, stated so a reviewer can tell a real reason from a rubber stamp. */
  readonly reason: string;
}

/**
 * PERMANENT exemptions — never expected to empty out.
 *
 * Every entry here is a Phase subagent: dispatched exactly once, by exactly
 * one orchestrator, at a fixed point in that orchestrator's pipeline, and
 * never by a user typing a request or an agent choosing among skills by
 * description. The `trigger-not-for` section — a disambiguation aimed at
 * whoever is CHOOSING this skill from a list — has no audience for a skill
 * nothing ever chooses; the caller already decided by writing `Task({
 * subagent_type: "…", … })` with this skill's name literally in the dispatch.
 *
 * This does NOT exempt a Phase subagent from `red-flags` or `verification` —
 * AC9 requires every workflow skill to earn both outright, and a subagent
 * being un-invocable by a user says nothing about whether ITS OWN failure
 * modes are documented or its own output has a checkable shape. Ten of these
 * twelve were missing `red-flags`; T14 wrote a phase-specific Red Flags table
 * into each rather than widening this map, so none of them is carried in
 * `PENDING_ANATOMY_BACKFILL` below any more.
 *
 * What a Phase subagent must still have, in place of the exempted section:
 * every one of the twelve already ships an Iron Laws table (its equivalent of
 * Red Flags — firm rules rather than named rationalizations) and an Output
 * Contract with an explicit `status:` enum (its equivalent of Verification —
 * see `hasVerificationSection`'s third bullet above), so the exemption trades
 * one document shape for another rather than for nothing.
 *
 * Non-vacuous today in name only: all twelve already carry a "NOT for" clause
 * in their `description` regardless (see `hasNotForClause` — none of the
 * twelve appear in the "missing NOT-for" set the shipped-tree survey
 * produced), so this map currently excuses zero live findings. It is kept
 * because the exemption is a statement of POLICY — a Phase subagent is
 * allowed to drop that clause without becoming non-compliant — not a patch
 * for a defect on today's tree, the same distinction `GENERATED_PATH_ROOTS`
 * draws above ("an allowance is not an exemption from the check; it is a
 * statement that the referent exists in a place this sweep cannot see").
 */
export const PERMANENT_ANATOMY_EXEMPTIONS: ReadonlyMap<string, AnatomySectionExemption> = new Map([
  [
    "planning/autodoc-analyst",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 2 subagent dispatched only by autodoc-orchestrator, one instance per module; never chosen by a user from a description, so the description needs no user-facing NOT-for disambiguation. Its Iron Laws table and Output Contract status enum are the discipline that substitutes for it.",
    },
  ],
  [
    "planning/autodoc-architect",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 3 subagent dispatched only by autodoc-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/autodoc-assembler",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 5 subagent dispatched only by autodoc-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/autodoc-scanner",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 1 subagent dispatched only by autodoc-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/autodoc-writer",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 4 subagent dispatched only by autodoc-orchestrator, one instance per section; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/consistency-checker",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 5 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/planner",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 6 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/problem-definer",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 1 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/project-discovery",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 0 subagent dispatched only by gproject-orchestrator, always called through it; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/spec-writer",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 4 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/stack-advisor",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 2 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
  [
    "planning/patterns-researcher",
    {
      sections: ["trigger-not-for"],
      reason:
        "Phase 3 subagent dispatched only by gproject-orchestrator; never chosen by a user from a description. Its Iron Laws and Output Contract status enum substitute for a user-facing NOT-for clause.",
    },
  ],
]);

/**
 * PENDING exemptions — flow 257's own backfill debt, and expected to reach
 * empty.
 *
 * Every entry here names a skill this sweep would otherwise fail today, and a
 * REASON that must name the flow-257 task doing the backfill (T13, T14 or
 * T15 — see `pendingReasonNamesBackfillTask` below, which a test asserts over
 * every entry) so this map cannot quietly turn into a second permanent
 * exemption list by omission. T3 (flow 257's final verification task) checks
 * this map is EMPTY once T13-T15 land; until then it is what keeps the
 * shipped tree's `anatomy:sections` finding count at zero while the backfill
 * is still in flight.
 *
 * Grouped by the task that owns the fix:
 *   - T13 — quality-category skills;
 *   - T14 — platform, planning and orchestration-category skills (this is
 *     also where the ten Phase subagents missing `red-flags` live, since they
 *     ship under `planning/`);
 *   - T15 — review-category skills, plus `core/reviewer-skill-creator`
 *     (shipped under `core/`, not `review/`, but its whole subject is
 *     authoring reviewer skills — closer to T15's remit than to T14's
 *     "platform, planning, orchestration" one; flagged here rather than
 *     silently folded in, since the task split names categories that do not
 *     quite cover it).
 */
export const PENDING_ANATOMY_BACKFILL: ReadonlyMap<string, AnatomySectionExemption> = new Map([
  // --- T13: quality — LANDED, all 13 quality skills now earn all three sections outright.

  // --- T14: platform, planning, orchestration — LANDED, all 29 entries removed.
  // The three platform skills, the ten planning skills and the nine
  // orchestration skills now state a "NOT for" clause, carry a Red Flags table
  // and state their own exit criteria outright. The ten Phase subagents
  // (`autodoc-*`, `consistency-checker`, `planner`, `problem-definer`,
  // `project-discovery`, `patterns-researcher`) were BACKFILLED rather than
  // moved to `PERMANENT_ANATOMY_EXEMPTIONS`: each one's Red Flags table names
  // rationalizations specific to its own phase, which is what AC9 asks for and
  // what an Iron Laws table — firm rules, not named excuses — does not supply.

  // --- T15: review, plus core/reviewer-skill-creator — LANDED, entries removed.
  // All eleven now carry the sections outright; nothing here excuses them.
]);

/** Every entry's reason must name the flow-257 task doing the backfill, or this map has quietly become a second permanent exemption list. */
export function pendingReasonNamesBackfillTask(reason: string): boolean {
  return /\bT1[345]\b/.test(reason);
}

// ---------------------------------------------------------------------------
// Cross-references
// ---------------------------------------------------------------------------

/**
 * Forms that DECLARE a dependency on another skill.
 *
 * Every pattern requires the word `skill` (or the `Skill(...)` call form)
 * adjacent to the name. That narrowness is the whole design. A first attempt
 * matched every backticked hyphenated token and produced 53 candidates, of
 * which the overwhelming majority were enum values (`dismissed-wont-fix`),
 * npm packages (`mobx-react-lite`) and DOM attributes (`data-testid`). A guard
 * with that false-positive rate is routed around within a week.
 *
 * The narrow form still catches the defect that actually shipped:
 * `feature-dev` said "Launch `code-review` skill" for a skill that was never
 * bundled.
 */
const SKILL_REFERENCE_PATTERNS: readonly RegExp[] = [
  /`([a-z][a-z0-9-]*)`\s+skill\b/g,
  /\bskill\s+`([a-z][a-z0-9-]*)`/g,
  /\bSkill\(\s*["']([a-z][a-z0-9-]*)["']\s*\)/g,
];

/**
 * Names that are not bundled skills and are not meant to be.
 *
 * Each entry names something REAL that lives elsewhere, so an unresolvable
 * reference stays unresolvable. An allowance is not an exemption from the check;
 * it is a statement that the referent exists in a place this sweep cannot see.
 */
export const KNOWN_EXTERNAL_SKILL_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["general-purpose", "the harness's own built-in agent type, not a keryx skill"],
]);

/**
 * Path namespaces this sweep can decide.
 *
 * `skills/`, `rules/` and `scripts/` name artifacts the bundled tree itself
 * ships, so a reference into them either resolves or is broken. Everything else
 * a skill mentions — `src/**`, `docs/**`, `.metaproject/data/**` — belongs to
 * the USER's project or is produced at runtime, and this evaluator has no
 * standing to call any of it missing. Checking those would be the "judge that
 * flags everything" failure from the other direction.
 *
 * `docs` WAS PROPOSED AS A FOURTH ROOT, AND MEASURED (flow 257 T19). The
 * prompt was `skills-storage-workflow.mdc`'s citation of
 * `docs/skills/rejected-skill-changes.md` (AC11's ledger), which nothing
 * checked. Adding `docs` here and to `PATH_REFERENCE` was tried and produces a
 * check that is wrong twice over:
 *
 *   - THE TREE. Seventeen distinct concrete `docs/…` paths are cited across
 *     the bundled tree (counted as `PATH_REFERENCE` extracts them), and ten
 *     resolve to nothing in this repository. Six of those ten are the sections
 *     `autodoc-orchestrator` GENERATES in the USER's project
 *     (`docs/architecture.md`, `docs/modules.md`, `docs/api-reference.md`,
 *     `docs/data-models.md`, `docs/onboarding.md`, `docs/index.md`) — they
 *     exist only once that pipeline has run somewhere else, so each is a
 *     finding on every checkout. The remaining seven (`docs/analysis`,
 *     `docs/plans`, `docs/report`, `docs/requirements`, …) exist at this
 *     REPOSITORY's root — but that is not where the check looks. Existence is
 *     `existsSync(path.join(root, resolved))` with `root` the bundled tree
 *     (`defaultBundledRoot()` — `src/gdskills/bundled`), which ships no `docs/`
 *     at all: 7 of the 17 exist under the repository root, 0 under the bundled
 *     root. So all seventeen would be findings HERE too, and the seven exist
 *     only because this repository happens to keep the layout
 *     `documentation-management.mdc` prescribes — nothing makes them exist in a
 *     user's project either. The citation would break in every tree, resolving
 *     in none, which is worse than a verdict that merely varies by tree: this
 *     root cannot decide these paths from where the sweep stands.
 *   - THE INSTALL. `package.json`'s `files` ships `dist`, `src/gdgraph`,
 *     `src/gdskills/bundled`, `src/gdskills/contracts` and one schema
 *     directory. `docs/skills/` is NOT published, so the one reference this
 *     root was meant to check would resolve in a checkout and fail for every
 *     installed user — exactly the flow-252 defect the header describes,
 *     rebuilt facing the other way. Nothing distinguishes a checkout from an
 *     install by layout, because the install mirrors the source layout
 *     deliberately.
 *
 * The ledger is a CONTRIBUTOR-facing file, so it is checked where it is true:
 * `REJECTED_CHANGES_LEDGER` below states the contract, and this module's own
 * test suite — which only ever runs in a checkout — asserts the file exists,
 * carries the documented header, and is the path the rule names. A check that
 * can only be right in one of the two places this evaluator runs does not
 * belong in the evaluator.
 */
const CHECKED_PATH_ROOTS = ["skills", "rules", "scripts"] as const;

/**
 * AC11's rejected-change ledger, stated once so the file, the rule that cites
 * it, and the test that pins both cannot drift apart.
 *
 * `path` is repository-relative (see `CHECKED_PATH_ROOTS` above for why it is
 * not an `xref:path` root). `header` is the table's column row verbatim: the
 * ledger's value is that a row records what was tried, why it was rejected,
 * and the evidence that sank it — a file with the heading and no columns to
 * fill would be an append-only record of nothing.
 */
export const REJECTED_CHANGES_LEDGER = {
  path: "docs/skills/rejected-skill-changes.md",
  header: "| date | skill | change tried | why rejected | evidence (before → after) | link |",
  /** The rule that requires it, bundled-tree-relative. */
  rule: "rules/core/skills-storage-workflow.mdc",
} as const;

/**
 * Prefixes that address the same artifacts through the INSTALLED layout.
 *
 * A skill may name `.metaproject/skills/gdskills/review/…` (where the file lands
 * for a user) or the same address written `.metaproject`-relative,
 * `skills/gdskills/review/…` (`installGdskills` writes the tree to
 * `.metaproject/skills/gdskills/`, so both spellings denote one file). Both
 * normalise to the bundled-relative form before resolution.
 *
 * What is deliberately NOT here: bare `skills/review/…`, missing the
 * `gdskills/` segment entirely. That spelling is the SOURCE tree's own
 * internal layout (`src/gdskills/bundled/skills/review/…`) — coincidentally
 * one file, in this one repository, and never a path an installed project
 * has. `resolveInstalledReference` below rejects it on purpose; see its
 * comment for the one narrow exception.
 */
const INSTALLED_PREFIXES: readonly [string, string][] = [
  [".metaproject/skills/gdskills/", "skills/"],
  ["skills/gdskills/", "skills/"],
  [".metaproject/rules/", "rules/"],
  [".metaproject/scripts/", "scripts/"],
];

/**
 * Directories inside the checked namespaces that a `keryx` command CREATES.
 *
 * `agent-entrypoint-distiller` lists `.metaproject/rules/entrypoints/index.md`
 * under "verify the generated outputs" — it is an output of `keryx rules
 * distill`, so its absence from the shipped tree is correct rather than broken.
 * Each entry names the command that produces it, because an allowance without a
 * producer is indistinguishable from a reference nobody checked.
 */
export const GENERATED_PATH_ROOTS: readonly { prefix: string; producedBy: string }[] = [
  { prefix: "rules/entrypoints/", producedBy: "keryx rules distill" },
];

/**
 * `*` joins the allowed characters so a glob such as a rule's own frontmatter
 * `globs: skills/gproject-` followed by a wildcard segment gets captured
 * whole and then excluded by the existing `raw.includes("*")` guard below,
 * rather than truncated right before the star into something that LOOKS like
 * a concrete path and gets existence-checked as one.
 */
const PATH_REFERENCE = /(?:^|[\s"'`([])((?:\.metaproject\/|skills\/|rules\/|scripts\/)[\w./@*-]*[\w.@*-])/g;

/**
 * Drop a sentence-ending period a path reference swept up mid-match.
 *
 * `.` is itself a valid path character (`.md`, `.json`), so `PATH_REFERENCE`
 * cannot tell "the extension's period" from "the sentence's period" while it
 * is still matching — a plain-prose reference such as "see
 * skills/quality/foo/SKILL.md." captures the trailing full stop along with
 * the file, and the path that resolves is `SKILL.md`, not `SKILL.md.`.
 *
 * Safe to strip unconditionally once matching is done, and never the
 * extension's own period: an extension's period is always followed by
 * extension letters (`.md`, never bare `.` at the end of a name), so a
 * period sitting as the very LAST character of the match cannot be one —
 * only a sentence's period lands there. Stripping it leaves a genuine
 * `skills/x/SKILL.md` reference exactly as `skills/x/SKILL.md` (its own
 * period is followed by `md`, not by the end of the match), and turns
 * `skills/x/SKILL.md.` back into the `skills/x/SKILL.md` it was quoting.
 */
function stripTrailingSentencePeriod(raw: string): string {
  return raw.endsWith(".") ? raw.slice(0, -1) : raw;
}

/**
 * Resolve a reference the way an INSTALLED project would have to: as the
 * address it names, not as whatever happens to sit at that string in THIS
 * checkout.
 *
 * Returns:
 *  - a bundled-relative path to existence-check (the reference names a real
 *    installed-layout slot and might still be a typo within it);
 *  - `null` when the reference is unconditionally wrong — it only ever
 *    denoted a path in the source tree's own layout, never one an installed
 *    project has, so no `existsSync` result could make it right;
 *  - `undefined` when this sweep has no standing to judge the reference at
 *    all (outside `skills/`, `rules/`, `scripts/`, or a `.metaproject/`
 *    address this sweep does not own).
 *
 * The one bare form still accepted under `skills/` is `skills/<category>/<name>`
 * naming a whole shipped skill by directory — three segments, nothing past the
 * skill's own name — and only when `<name>` is a skill this tree actually
 * ships (`known`). That is the same convention this tree already uses for
 * `rules/core/<file>.mdc` cross-references elsewhere (a citation, not a literal
 * read path), and closing it too would turn every "see the `code-style-review`
 * skill" mention into a rewrite this sweep cannot make on its own in a file it
 * does not own. A reference reaching INTO a skill — a specific file, one path
 * segment further — has no such excuse: it is either the installed prefix or
 * it is dead the moment a user installs.
 */
function resolveInstalledReference(reference: string, known: ReadonlySet<string>): string | null | undefined {
  for (const [from, to] of INSTALLED_PREFIXES) {
    if (reference.startsWith(from)) return to + reference.slice(from.length);
  }
  if (reference.startsWith(".metaproject/")) return undefined;

  const segments = reference.split("/");
  const root = segments[0] ?? "";
  if (root === "skills") {
    if (segments.length === 3 && known.has(segments[2] ?? "")) return reference;
    return null;
  }
  return (CHECKED_PATH_ROOTS as readonly string[]).includes(root) ? reference : undefined;
}

/**
 * Both cross-reference checks (`xref:skill`, `xref:path`), over one document's
 * text. Shared between the `SKILL.md`/harness-build sweep and the rule-file
 * sweep below so a path reference resolves the SAME way regardless of which
 * kind of shipped document names it — a rule citing a dead skill path is
 * exactly as broken as a skill citing one.
 *
 * `checkSkillNames` gates `xref:skill` only; rule files pass `false`.
 * `SKILL_REFERENCE_PATTERNS` matches a bare name beside the word "skill" —
 * exactly right for "Launch `code-review` skill" in a SKILL.md, and exactly
 * wrong for `skill-lifecycle.mdc`'s "a `needs-review` skill", which is a
 * STATUS value, not a name, that happens to sit next to the same word. Rule
 * prose talks ABOUT skills in the abstract far more than a skill's own prose
 * does; `xref:path` carries no such ambiguity and applies to both.
 */
function scanCrossReferences(
  text: string,
  root: string,
  known: ReadonlySet<string>,
  checkSkillNames: boolean,
  add: (check: "xref:skill" | "xref:path", line: number, message: string) => void,
): void {
  text.split("\n").forEach((line, index) => {
    if (checkSkillNames) {
      for (const pattern of SKILL_REFERENCE_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          const referenced = match[1] as string;
          if (!referenced.includes("-")) continue;
          if (known.has(referenced)) continue;
          if (KNOWN_EXTERNAL_SKILL_REFERENCES.has(referenced)) continue;
          add(
            "xref:skill",
            index + 1,
            `names a skill \`${referenced}\` that this tree does not ship; either bundle it or stop naming it.`,
          );
        }
      }
    }
    for (const match of line.matchAll(PATH_REFERENCE)) {
      const raw = stripTrailingSentencePeriod(match[1] as string);
      if (raw.includes("<") || raw.includes("*") || raw.includes("$")) continue;
      const resolved = resolveInstalledReference(raw, known);
      if (resolved === undefined) continue;
      if (resolved === null) {
        add(
          "xref:path",
          index + 1,
          `path \`${raw}\` names the SOURCE tree's own layout, not an installed one — an installed project has no top-level \`skills/\`, only \`.metaproject/skills/gdskills/…\`. Write \`.metaproject/skills/gdskills/${raw.slice("skills/".length)}\` (or the \`skills/gdskills/…\` form), or, to name the whole skill rather than a file in it, drop everything past its directory.`,
        );
        continue;
      }
      if (
        GENERATED_PATH_ROOTS.some(
          (entry) => resolved === entry.prefix.replace(/\/$/, "") || resolved.startsWith(entry.prefix),
        )
      ) {
        continue;
      }
      if (existsSync(path.join(root, resolved))) continue;
      add(
        "xref:path",
        index + 1,
        `path \`${raw}\` resolves to nothing under the shipped tree (looked for \`${resolved}\`).`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Every filename that IS a shipped skill document.
 *
 * `SKILL.md` is the Claude build; `SKILL.<runtime>.md` is a harness build, and
 * `skillBuildFileName` is the single definition of that spelling — the same one
 * `resolveSkillBuild` uses to decide which file a `--runtime` export copies. It
 * is imported rather than restated so a new harness cannot be added to the
 * exporter and stay invisible to this sweep.
 *
 * Membership is by exact name, never by pattern. `SKILL.detail.md`
 * (`orchestration/feature-analyzer`) matches `SKILL.*.md` and is NOT a build: it
 * is an overflow document with no frontmatter, and sweeping it would report a
 * missing frontmatter block that is correct as it stands.
 */
const SKILL_DOCUMENT_NAMES: ReadonlySet<string> = new Set(
  HARNESS_SKILL_RUNTIMES.map((runtime) => skillBuildFileName(runtime)),
);

/**
 * `SKILL*.md` files that are deliberately NOT builds, each with its reason —
 * and, more broadly since flow 257 T16, the full list of shipped companion
 * documents this sweep knows about at all.
 *
 * The `SKILL.*.md`-shaped set exists so `document:addressable` can tell "a
 * companion document" from "a build no runtime can reach". The distinction is
 * not academic: nine `SKILL.claude.md` files shipped in 0.2.72 and were read
 * by nothing — `skillBuildFileName("claude")` is `SKILL.md`, so no `--runtime`
 * export, no install, and no sweep ever opened them. They were Claude Code
 * slash-command files left behind by the conversion to skills, and they were
 * removed rather than allowed, because an allowance without a reader is a
 * backlog entry wearing an exemption's clothes.
 *
 * `orchestrator-prompt.md` — shipped by five orchestration skills
 * (`context-collector`, `feature-analyzer`, `issue-analyzer`,
 * `job-orchestrator`, `task-implementer`) — does not fit that pattern at all:
 * it is not spelled `SKILL.*.md`, so `document:addressable` never had an
 * opinion on it either way. It is listed here anyway, and this ONE map is
 * reused rather than a second one, because the two file kinds share the same
 * real property: both are prose a skill author wrote and ships, addressed by
 * name from the skill's own `SKILL.md`, carrying no frontmatter of their own.
 * `bundledSkillCompanionDocuments` below walks every name this map lists —
 * this is now the SINGLE registry of "documents that exist, are not builds,
 * and are still worth reading for a dead cross-reference", not merely a
 * `document:addressable` exemption list.
 */
export const KNOWN_SKILL_COMPANION_DOCUMENTS: ReadonlyMap<string, string> = new Map([
  [
    "SKILL.detail.md",
    "overflow reference for `orchestration/feature-analyzer`, linked from its SKILL.md; carries no frontmatter and is not addressed by any runtime",
  ],
  [
    "orchestrator-prompt.md",
    "the prompt template an orchestrator skill reads to build a subagent dispatch (context-collector, feature-analyzer, issue-analyzer, job-orchestrator, task-implementer); carries no frontmatter and is not addressed by any runtime — read by the skill's own instructions, not by a harness loader",
  ],
]);

function walkSkillDocuments(root: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (accept(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Every `SKILL.md` under `root`, absolute, sorted. `[]` when `root` is absent. */
export function bundledSkillFiles(root: string): string[] {
  return walkSkillDocuments(root, (name) => name === "SKILL.md");
}

/**
 * Every shipped skill DOCUMENT under `root` — `SKILL.md` and every harness
 * build beside it.
 *
 * This is the set the sweep actually walks, and it is a different number from
 * `bundledSkillFiles`. The tree shipped 65 `SKILL.md` and 111 harness builds; a
 * sweep that reads only the first spelling reported `xref:path` clean over 65 of
 * 176 documents and said nothing about the other 111 — which is how
 * `task-implementer` shipped four builds missing their entire reporting
 * contract while every check reported "pass". Flow 257 deleted the builds that
 * were byte-identical to their `SKILL.md` (a runtime with no build of its own
 * reads `SKILL.md`), so only genuinely different builds remain to be walked.
 */
export function bundledSkillDocuments(root: string): string[] {
  return walkSkillDocuments(root, (name) => SKILL_DOCUMENT_NAMES.has(name));
}

/**
 * Every companion document under `root` — a file `KNOWN_SKILL_COMPANION_DOCUMENTS`
 * names, wherever it ships (flow 257 T16).
 *
 * Before this, `orchestrator-prompt.md` — the file five orchestrator skills
 * read to build a subagent dispatch, and the exact file `docs/requirements/
 * keryx-orchestrator-hardening/measurement-2026-08-31.md` names for citing a
 * denied `wave-executor` in four places — was invisible to every check in this
 * sweep: it is not `SKILL.md`, not a harness build `HARNESS_SKILL_RUNTIMES`
 * knows about, and `document:addressable`'s own walk only ever looks at files
 * spelled `SKILL.*.md`. A dead path or skill reference inside one was
 * structurally undetectable, not merely unchecked.
 */
export function bundledSkillCompanionDocuments(root: string): string[] {
  return walkSkillDocuments(root, (name) => KNOWN_SKILL_COMPANION_DOCUMENTS.has(name));
}

/**
 * Every rule file under `<root>/rules/core` — the tree `installBundledRules`
 * (`src/gdskills/install.ts`) copies verbatim to `.metaproject/rules/core/`.
 * Flat by construction: `bundledRulesSourcePath` names one directory and
 * `cp(..., { recursive: true })` mirrors whatever is in it, so a walk one
 * level deep is enough today and still correct if a subdirectory is added
 * later. `[]` for a root with no `rules/core`, same convention as
 * `bundledSkillFiles`, so an absent tree reads as "swept zero", not "passed".
 */
export function bundledRuleFiles(root: string): string[] {
  const rulesRoot = path.join(root, "rules", "core");
  if (!existsSync(rulesRoot)) return [];
  return readdirSync(rulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(rulesRoot, entry.name))
    .sort();
}

/**
 * The default tree: the 65 skills shipped inside this package.
 *
 * TWO LAYOUTS, AND THE SECOND ONE IS THE ONE USERS HAVE.
 *
 * In the repository this module lives at `src/gdskills/bundled-eval.ts`, so
 * `import.meta.dir/bundled` is the tree. In an INSTALLED copy it does not
 * exist: `bun build` collapses every module into `dist/cli.js`, so
 * `import.meta.dir` is `<package>/dist`, while `package.json`'s `files` list
 * ships the skills at `<package>/src/gdskills/bundled`. Resolving only the
 * first spelling is why `keryx skills verify --bundled` returned
 * `skills_evaluated: 0` for every user who installed 0.2.72 — the sweep walked
 * `dist/bundled`, which has never existed in any release.
 *
 * `install.ts` already resolves both spellings the same way
 * (`bundledSkillSourcePath`, `contractSourcePath`); this function simply never
 * got the second rung. The fallback is checked, not assumed: if neither exists
 * the direct path is returned so the caller reports an empty sweep against the
 * address it actually looked at.
 */
export function defaultBundledRoot(): string {
  const directPath = path.join(import.meta.dir, "bundled");
  if (existsSync(directPath)) return directPath;

  const packagedPath = path.join(import.meta.dir, "..", "src", "gdskills", "bundled");
  if (existsSync(packagedPath)) return packagedPath;

  return directPath;
}

/**
 * Evaluate one bundled tree.
 *
 * `root` is the directory holding `skills/` and `rules/` — `src/gdskills/bundled`
 * for the shipped tree, or a fixture root for a test. Taking it as an argument
 * is what lets AC8's broken fixture be evaluated by the SAME code that sweeps
 * the real tree, rather than by a second implementation that could disagree.
 */
export function evaluateBundledTree(root: string = defaultBundledRoot()): BundledSkillEvaluation {
  const skillsRoot = path.join(root, "skills");
  const canonical = bundledSkillFiles(skillsRoot);
  const files = bundledSkillDocuments(skillsRoot);
  const companionDocuments = bundledSkillCompanionDocuments(skillsRoot);
  const skillNames = [...new Set(canonical.map((file) => path.basename(path.dirname(file))))].sort();
  const known = new Set(skillNames);
  const findings: BundledSkillFinding[] = [];
  /**
   * Declared frontmatter name -> the skill DIRECTORY that first declared it.
   *
   * Keyed by directory, not by file, because the five builds of one skill all
   * declare that skill's name and are supposed to. The collision this catches is
   * two DIFFERENT skills answering to one name, which is the case a harness
   * cannot resolve.
   */
  const declaredNames = new Map<string, { dir: string; file: string }>();
  /** `<category>/<directory>` pairs the install catalogue names. */
  const catalogued = new Set(BUNDLED_GDSKILLS.map((entry) => `${entry.category}/${entry.name}`));
  /**
   * `${category}/${skill}` -> its served description, one entry per skill.
   *
   * Populated only from the CANONICAL `SKILL.md` (see the guard where this is
   * written, below) — a harness build's description is supposed to be the
   * same text (`document:build-parity` catches drift), and a pairwise sweep
   * over builds too would report the same collision once per build pair
   * instead of once per skill pair. `description:collision` (after the main
   * loop) reads this map once every document has been walked.
   */
  const descriptionsByKey = new Map<string, string>();
  /** `${category}/${skill}` -> the relative canonical file path, for the finding location. */
  const descriptionFileByKey = new Map<string, string>();
  /**
   * `${category}/${skill}` -> its Red Flags table's data rows, canonical
   * `SKILL.md` only — the input to `anatomy:red-flags-collision` below.
   * Populated inside the anatomy block, where the section is already parsed,
   * rather than by a second walk over the same text.
   */
  const redFlagsByKey = new Map<string, readonly string[]>();
  /** `${category}/${skill}` -> the relative canonical file path, for the collision finding's location. */
  const redFlagsFileByKey = new Map<string, string>();

  for (const file of files) {
    const skillDir = path.dirname(file);
    const skill = path.basename(skillDir);
    const rel = path.relative(skillsRoot, file).split(path.sep).join("/");
    // The directory a document ships under. Computed here, ahead of the
    // frontmatter checks, because `frontmatter:category` needs it to judge a
    // declared `metadata.category` and `catalog:registered` (below) already
    // needed it — one source rather than two that could disagree.
    const category = path.dirname(rel).split("/")[0] ?? "";
    const text = readFileSync(file, "utf8");
    const add = (check: BundledSkillCheck, line: number | null, message: string): void => {
      findings.push({ check, skill, file: rel, line, message });
    };

    // --- frontmatter -------------------------------------------------------
    const block = frontmatterBlock(text);
    if (block === undefined) {
      add(
        "frontmatter:block",
        1,
        "no YAML frontmatter block: the file must open with `---` and close the block with a `---` line.",
      );
    } else {
      const keys = frontmatterKeys(block);
      // The one parse every field below that must match what the RUNTIME sees
      // reads through — `description` already did (see its comment below);
      // `metadata.category` and `compatible_harnesses` join it here rather
      // than staying on `frontmatterKeys`' single-line regexes, which read a
      // YAML block list or flow list as absent rather than as a value to
      // check (see `parseSkillFrontmatter`'s own comment on the field).
      const parsed = parseSkillFrontmatter(text);
      for (const [field, check] of Object.entries(REQUIRED_FRONTMATTER_CHECKS)) {
        if (!keys.has(field)) {
          add(check, 1, `frontmatter is missing the required \`${field}\` field.`);
        }
      }
      const name = keys.get("name");
      if (name !== undefined && name.replace(/^["']|["']$/g, "").length === 0) {
        add("frontmatter:name", 1, "frontmatter `name` is present but empty.");
      }
      const declaredName = name === undefined ? undefined : name.replace(/^["']|["']$/g, "");
      if (declaredName !== undefined && declaredName.length > 0) {
        const previous = declaredNames.get(declaredName);
        if (previous === undefined) {
          declaredNames.set(declaredName, { dir: skillDir, file: rel });
        } else if (previous.dir !== skillDir) {
          add(
            "frontmatter:name-unique",
            1,
            `frontmatter \`name: ${declaredName}\` is already declared by \`${previous.file}\`; a harness registers skills by this name and cannot tell two of them apart.`,
          );
        }
      }
      // Assert the description the RUNTIME will serve, not merely that the line
      // exists. `keys` is a shallow read: for a block scalar it holds the bare
      // indicator ("|"), which is non-empty and so passed this check while
      // `skills_catalog` handed that indicator to an agent as the skill's whole
      // description. Both sides now read through `parseSkillFrontmatter`.
      if (keys.has("description")) {
        const served = parsed.description ?? "";
        if (served.length === 0) {
          add(
            "frontmatter:description",
            1,
            "frontmatter `description` is present but resolves to nothing a harness can match a request against; a block scalar (`description: |`) needs its text on the following indented lines.",
          );
        } else {
          // Collected here, before the three per-description checks below,
          // guarded to the canonical file only (see `descriptionsByKey`'s
          // comment above) — a harness build reaching this branch with the
          // same skill key would otherwise overwrite nothing incorrectly, but
          // there is no reason to let it try.
          if (path.basename(file) === "SKILL.md") {
            const key = `${category}/${skill}`;
            descriptionsByKey.set(key, served);
            descriptionFileByKey.set(key, rel);
          }
          // The three content-quality checks only judge text that actually
          // exists — an empty description already failed above, and judging
          // the shape of nothing would double-report the same defect twice.
          if (descriptionLacksTriggerPhrase(served)) {
            add(
              "description:trigger-phrase",
              1,
              `frontmatter \`description\` has no trigger phrase (${ALLOWED_DESCRIPTION_TRIGGER_PHRASES.map((p) => `"${p}"`).join(", ")}); without one an agent has no situational cue for when to reach for this skill, only a summary of what it does.`,
            );
          }
          const bareVerb = bareImperativeOpening(served);
          if (bareVerb !== undefined) {
            add(
              "description:bare-imperative",
              1,
              `frontmatter \`description\` opens "Use when ${bareVerb} …" — a bare imperative reads as an instruction aimed at the skill, not a description of the situation that should trigger it; use the gerund ("Use when ${bareVerb}ing …") or rephrase around the situation.`,
            );
          }
          if (served.length > MAX_DESCRIPTION_LENGTH) {
            add(
              "description:length",
              1,
              `frontmatter \`description\` is ${served.length} characters, over the ${MAX_DESCRIPTION_LENGTH}-character cap agentskills.io's skill spec sets for descriptions; trim it.`,
            );
          }
        }
      }
      if (keys.has("metadata")) {
        const metadataVersion = /^\s{2,}version\s*:\s*(.+)$/m.exec(block);
        if (metadataVersion === null) {
          add(
            "frontmatter:metadata",
            1,
            "frontmatter `metadata` declares no `version`; without one a skill cannot be said to have changed.",
          );
        }
        // `metadata.category` is free text, not read by any runtime — the one
        // consumer (`import-skills.ts`'s `frontmatterCategory`) reads it off a
        // skill being IMPORTED, never off this shipped tree. That makes a
        // mismatch harmless to behavior and still worth catching: it is the
        // label an operator reads when deciding where a skill belongs, and it
        // drifted on 23 shipped skills with nothing to notice. Ground truth is
        // the directory the skill actually ships under — `catalog:registered`
        // above already ties that directory to `BUNDLED_GDSKILLS`, so a
        // skill that passes both checks has one category, not two.
        const declaredCategory = parsed.metadataCategory ?? "";
        if (declaredCategory.length > 0 && declaredCategory !== category) {
          add(
            "frontmatter:category",
            1,
            `frontmatter \`metadata.category\` is "${declaredCategory}" but this skill ships under \`${category}/${skill}\`; set it to "${category}" or drop the field.`,
          );
        }
      }
      // `compatible_harnesses` is per-build metadata (see
      // BUILD_DIVERGENCE_ALLOWED_FIELDS above) — a harness build is allowed to
      // list only the non-Claude family it serves. `SKILL.md` is different: it
      // IS the Claude build (`skillBuildFileName("claude") === "SKILL.md"`), so
      // a list that excludes `claude` is not a narrower build, it is this
      // build lying about the harness that loads it. Checked by exact
      // filename, not by runtime lookup, so the check reads the same way in a
      // fixture tree that never calls `evaluateBundledTree` through the CLI.
      if (path.basename(file) === "SKILL.md" && parsed.compatibleHarnesses !== undefined) {
        const harnesses = parsed.compatibleHarnesses;
        if (!harnesses.includes("claude")) {
          add(
            "frontmatter:harness-claude",
            1,
            `frontmatter \`compatible_harnesses\` ("${harnesses.join(",")}") omits \`claude\`, but this file IS the Claude build — add \`claude\` to the list.`,
          );
        }
      }
    }

    // --- anatomy: trigger/NOT-for, Red Flags, Verification -----------------
    //
    // Runs over the whole document (`text`), not only the frontmatter parsed
    // above — `hasNotForClause` explicitly reads body prose too (see its
    // definition comment). Keyed by `${category}/${skill}` because that is
    // the same key `catalogued` (above) and `BUNDLED_GDSKILLS` use, and
    // because a skill's category is exactly what routes it to a T13/T14/T15
    // pending entry.
    //
    // Canonical `SKILL.md` only, for the reason `anatomy:length` below already
    // gives: `document:build-parity` forces every harness build to carry its
    // `SKILL.md`'s body verbatim, so a build's anatomy is the SAME fact, not a
    // second one. Ungated, a skill shipping four builds reported one missing
    // section five times — five identical findings, one defect, and an
    // operator counting findings would read a five-times-worse tree than the
    // one they have. The build is not going unchecked: if it ever stops
    // matching its `SKILL.md`, that is a `document:build-parity` finding,
    // which is the accurate name for it.
    if (path.basename(file) === "SKILL.md") {
      const exemptionKey = `${category}/${skill}`;
      redFlagsByKey.set(exemptionKey, redFlagsTableBody(text));
      redFlagsFileByKey.set(exemptionKey, rel);
      const permanent = PERMANENT_ANATOMY_EXEMPTIONS.get(exemptionKey);
      const pending = PENDING_ANATOMY_BACKFILL.get(exemptionKey);
      const missing: AnatomySection[] = [];
      if (!hasNotForClause(text)) missing.push("trigger-not-for");
      if (!hasRedFlagsSection(text)) missing.push("red-flags");
      if (!hasVerificationSection(text)) missing.push("verification");
      for (const section of missing) {
        if (permanent?.sections.includes(section) === true) continue;
        if (pending?.sections.includes(section) === true) continue;
        add("anatomy:sections", null, `missing ${ANATOMY_SECTION_LABELS[section]}.`);
      }
    }

    // --- anatomy: length ----------------------------------------------------
    //
    // A ceiling is not a claim that the skill's current size is right — several
    // shipped skills sit past 2000 lines. It is the one thing this sweep can
    // decide that the others cannot: whether a skill grew past what it already
    // was without anyone choosing that. `skill-length-ceilings.ts` records
    // today's count per skill; a skill with no entry falls back to the 500
    // lines the rules already name as the point to split at, so a NEW skill
    // cannot arrive oversized without a decision recorded in that file.
    //
    // Canonical `SKILL.md` only: `document:build-parity` already forces every
    // harness build to match it except for `compatible_harnesses`, so a build's
    // length is the same fact, and measuring both would report one overage
    // twice.
    if (path.basename(file) === "SKILL.md") {
      const ceilingKey = `${category}/${skill}`;
      const recordedCeiling = SKILL_LENGTH_CEILINGS.get(ceilingKey);
      const ceiling = recordedCeiling ?? DEFAULT_SKILL_LENGTH_CEILING;
      const lines = skillLineCount(text);
      if (lines > ceiling) {
        const recorded = recordedCeiling === undefined
          ? `no recorded ceiling, so the default ${DEFAULT_SKILL_LENGTH_CEILING} applies`
          : `its recorded ceiling of ${ceiling}`;
        add(
          "anatomy:length",
          null,
          `${lines} lines exceeds ${recorded}. Split the skill, or move reference material into a sibling document, and lower the ceiling to the new count in the same change. A ceiling only ever moves DOWN: raising it is the one edit rules/core/skills-storage-workflow.mdc ("Length Ceilings") forbids, because it converts a measured limit into a record of whatever the file grew to.`,
        );
      }
    }

    // --- the install catalogue names this directory ------------------------
    //
    // `installGdskills` iterates `BUNDLED_GDSKILLS` and copies
    // `bundled/skills/<category>/<entry.name>`. A directory the catalogue does
    // not name is never copied anywhere: it ships inside the package, is read by
    // nobody, and every claim its prose makes is inert. That is decidable here
    // and nowhere else, because the sweep is the only thing that sees both lists.
    if (!catalogued.has(`${category}/${skill}`)) {
      add(
        "catalog:registered",
        null,
        `BUNDLED_GDSKILLS (src/gdskills/catalog.ts) does not name \`${category}/${skill}\`, so \`keryx skills install\` never copies this directory and no user ever sees it.`,
      );
    }

    // --- no concrete model name (AC14's existing executable rule) -----------
    for (const offender of concreteModelDeclarations(text)) {
      const line = Number.parseInt(offender.split(":")[0] ?? "", 10);
      add(
        "model:concrete-declaration",
        Number.isFinite(line) ? line : null,
        `${offender.slice(offender.indexOf(":") + 1).trim()} — declare a model_tier, never a model id.`,
      );
    }

    // --- no persona, no personal home path (flow 206's existing rules) ------
    for (const offender of personaOffenders(text)) {
      add(offender.kind === "name" ? "persona:name" : "persona:marker", offender.line, offender.why);
    }
    for (const offender of homePathOffenders(text)) {
      add("path:personal-home", offender.line, offender.why);
    }

    // --- cross-references resolve ------------------------------------------
    scanCrossReferences(text, root, known, true, add);
  }

  // --- description collisions across every catalog skill (flow 257 T11, AC6) -
  //
  // Runs once, over every skill's description collected above, not inside the
  // per-document loop — a description's collision status is a property of the
  // PAIR, decidable only once both sides are known. `KNOWN_DESCRIPTION_
  // COLLISIONS` (see its comment) is checked here so a pair T12 has not yet
  // resolved does not fail the shipped tree while it is still in flight.
  for (const { a, b, similarity } of collisionPairs(descriptionsByKey, DESCRIPTION_COLLISION_THRESHOLD)) {
    if (KNOWN_DESCRIPTION_COLLISIONS.has(collisionPairKey(a, b))) continue;
    // Attributed to `b` (the lexicographically later skill of the pair, per
    // `collisionPairs`' sort) so the finding still has exactly one home
    // directory, the same convention `frontmatter:name-unique` uses for its
    // own two-file finding above — the message names BOTH skills regardless.
    findings.push({
      check: "description:collision",
      skill: b.split("/").slice(1).join("/") || b,
      file: descriptionFileByKey.get(b) ?? `skills/${b}/SKILL.md`,
      line: null,
      message: `description collides with \`${a}\` at Jaccard similarity ${similarity.toFixed(2)} (>= ${DESCRIPTION_COLLISION_THRESHOLD}) on the router's own tokenisation — an agent routing between \`${a}\` and \`${b}\` has near-identical text to choose between; narrow one or both descriptions, or record the pair in KNOWN_DESCRIPTION_COLLISIONS with a reason naming its owner.`,
    });
  }

  // --- one skill's Red Flags table, shipped by two skills (flow 257 T19) -----
  //
  // `anatomy:sections` asks whether a table EXISTS. A table copied verbatim
  // from a sibling skill exists, has its rows, and names that other skill's
  // rationalizations — so the check passes while the document supplies nothing
  // about the ways THIS skill specifically gets talked out of its own rules,
  // which is the entire reason AC3 asks for the section. It is the same defect
  // as a `| a | b |` placeholder row, one step further along: substance that
  // is present and not the skill's own.
  //
  // Grouped, not pairwise: unlike `description:collision` this is exact
  // equality, so N skills sharing one table are one group rather than N*(N-1)/2
  // pairs. The first key in sorted order is treated as the original and every
  // later one draws the finding, the same "attribute to the later of the pair"
  // convention `description:collision` and `frontmatter:name-unique` use.
  {
    const byBody = new Map<string, string[]>();
    for (const [key, rows] of [...redFlagsByKey].sort(([a], [b]) => a.localeCompare(b))) {
      if (rows.length === 0) continue;
      const body = rows.join("\n");
      byBody.set(body, [...(byBody.get(body) ?? []), key]);
    }
    for (const keys of byBody.values()) {
      if (keys.length < 2) continue;
      const original = keys[0] as string;
      for (const key of keys.slice(1)) {
        findings.push({
          check: "anatomy:red-flags-collision",
          skill: key.split("/").slice(1).join("/") || key,
          file: redFlagsFileByKey.get(key) ?? `${key}/SKILL.md`,
          line: null,
          message: `its Red Flags table is byte-identical to \`${original}\`'s (${keys.length} skills ship this table: ${keys.join(", ")}). A rationalization table names the excuses an agent makes about THIS skill; a copied one documents another skill's failure modes and passes \`anatomy:sections\` while saying nothing about this one. Write the rows this skill's own rules get talked out of.`,
        });
      }
    }
  }

  // --- rule files: xref:path only, not the SKILL.md checks -------------------
  //
  // Rule frontmatter (`description`, `globs`, `alwaysApply`) has no `name` or
  // `metadata.version`, so running the frontmatter/catalog/model/persona checks
  // here would fail on arrival on all 33 shipped rules for a shape they were
  // never written to have. `xref:skill` is skipped too: rule prose talks ABOUT
  // skills far more than a skill's own prose does — `skill-lifecycle.mdc` calls
  // a skill's own status "a `needs-review` skill", which is a false positive
  // for the naming pattern, not a dead reference. What generalises without
  // qualification is `xref:path`: a rule citing `skills/shared/…` bare is
  // exactly as dead in an installed project as a skill citing it, and until
  // this loop existed nothing ever opened a rule file to check.
  for (const file of bundledRuleFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const text = readFileSync(file, "utf8");
    const add = (check: "xref:skill" | "xref:path", line: number, message: string): void => {
      findings.push({ check, skill: path.basename(file, path.extname(file)), file: rel, line, message });
    };
    scanCrossReferences(text, root, known, false, add);
  }

  // --- companion documents: xref:skill + xref:path only, not frontmatter/anatomy (flow 257 T16) --
  //
  // `orchestrator-prompt.md` and `SKILL.detail.md` — `KNOWN_SKILL_COMPANION_
  // DOCUMENTS`'s two entries — are skill-authored prose, addressed by name
  // from the skill's own `SKILL.md`, exactly the shape a dead `skills/…` path
  // or a named-but-unbundled skill could hide in. Unlike a rule file, this
  // prose IS a skill talking about itself and other skills, the same voice
  // `SKILL.md` uses — so `xref:skill` applies here (`checkSkillNames: true`),
  // where it does not for a rule file's prose ABOUT skills in the abstract.
  //
  // What does NOT apply: frontmatter, anatomy, catalog registration, model
  // declarations, persona markers. A companion document carries no
  // frontmatter by definition — `frontmatterBlock` would return `undefined`
  // for every one of them, and running the frontmatter/anatomy loop above
  // would report `frontmatter:block` and all three `anatomy:sections` on a
  // file that was never meant to open with `---` or restate its own skill's
  // trigger and Red Flags. Only the two checks that judge WHAT THE FILE SAYS,
  // not WHAT SHAPE THE FILE HAS, generalise to a document with no frontmatter.
  for (const file of companionDocuments) {
    const skillDir = path.dirname(file);
    const skill = path.basename(skillDir);
    const rel = path.relative(skillsRoot, file).split(path.sep).join("/");
    const text = readFileSync(file, "utf8");
    const add = (check: "xref:skill" | "xref:path", line: number, message: string): void => {
      findings.push({ check, skill, file: rel, line, message });
    };
    scanCrossReferences(text, root, known, true, add);
  }

  // --- every SKILL*.md in the tree is either read above or named a companion --
  //
  // The sweep now reads `SKILL.md` and every harness build that ships. That is only
  // full coverage if nothing ELSE in a skill directory is spelled like a build,
  // so this closes the set: a `SKILL.<x>.md` that no runtime addresses is a
  // document that ships, is never opened, and whose every claim is inert.
  for (const dir of [...new Set(files.map((file) => path.dirname(file)))].sort()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/^SKILL\..+\.md$/.test(entry.name)) continue;
      if (SKILL_DOCUMENT_NAMES.has(entry.name)) continue;
      if (KNOWN_SKILL_COMPANION_DOCUMENTS.has(entry.name)) continue;
      findings.push({
        check: "document:addressable",
        skill: path.basename(dir),
        file: path.relative(skillsRoot, path.join(dir, entry.name)).split(path.sep).join("/"),
        line: null,
        message: `\`${entry.name}\` is spelled like a harness build, but no runtime in HARNESS_SKILL_RUNTIMES resolves to it (${[...SKILL_DOCUMENT_NAMES].join(", ")}). Nothing exports it, installs it, or reads it — delete it, rename it to the build it was meant to be, or register it in KNOWN_SKILL_COMPANION_DOCUMENTS with a reason.`,
      });
    }
  }

  // --- a harness build must still carry its SKILL.md's content --------------
  //
  // Every other check reads each document on its own, so a build that has simply
  // fallen behind its `SKILL.md` is structurally perfect and reports nothing. That
  // is not hypothetical: editing one `SKILL.md` left its four builds serving the
  // previous description while this sweep printed `findings: 0`. The installed
  // mirror already has a test asserting it matches the source; the builds ship to
  // the same agents and had nothing.
  for (const file of canonical) {
    const dir = path.dirname(file);
    let canonicalComparable: string;
    try {
      canonicalComparable = buildComparableText(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const runtime of HARNESS_SKILL_RUNTIMES) {
      const buildName = skillBuildFileName(runtime);
      // `skillBuildFileName("claude")` IS `SKILL.md` — the canonical file itself.
      if (buildName === path.basename(file)) continue;
      const buildPath = path.join(dir, buildName);
      if (!existsSync(buildPath)) continue;
      let buildComparable: string;
      try {
        buildComparable = buildComparableText(readFileSync(buildPath, "utf8"));
      } catch {
        continue;
      }
      if (buildComparable === canonicalComparable) continue;
      findings.push({
        check: "document:build-parity",
        skill: path.basename(dir),
        file: path.relative(skillsRoot, buildPath).split(path.sep).join("/"),
        line: null,
        message: `\`${buildName}\` no longer carries the content of its \`SKILL.md\`, ignoring the fields a build may set for itself (${[...BUILD_DIVERGENCE_ALLOWED_FIELDS].join(", ")}). An agent on that runtime reads this file, not the canonical one — re-export the build.`,
      });
    }
  }

  return {
    root,
    skills: canonical.length,
    documents: files.length + companionDocuments.length,
    skillNames,
    findings,
  };
}

/**
 * Evaluate a tree and say plainly what was and was not checked.
 *
 * The closing section is not decoration. A report that lists a column of passing
 * checks and stops reads as "the skills are good"; this evaluator can only say
 * the files are well formed and their references resolve. The distinction is the
 * one the Phase 7 audit found missing 217 times.
 */
export function renderBundledEvaluation(evaluation: BundledSkillEvaluation): string {
  const lines: string[] = [];
  lines.push("# bundled skill evaluation (layer 1 of 3: structural)");
  lines.push("");
  lines.push(`root: ${evaluation.root}`);
  // Which CODE produced this report, not just which tree it read.
  //
  // `--root` points the scan at a working tree; it does not change the
  // evaluator doing the scanning. Run from an installed `keryx`, this report
  // describes a checkout using checks the installed build happens to carry —
  // which reads as a clean bill of health for changes it never executed. That
  // mistake was made against this very file. In a checkout, run
  // `bun run keryx skills verify --bundled`.
  lines.push(`evaluator: ${evaluatorSource()}`);
  lines.push(`skills_evaluated: ${evaluation.skills}`);
  // Both denominators, always. `skills_evaluated` alone read as full coverage
  // while 111 harness builds went unread (flow 209); printing the document count is what
  // makes the gap visible without anyone having to know it exists.
  lines.push(`documents_evaluated: ${evaluation.documents} (SKILL.md + harness builds + companion documents)`);
  lines.push(`findings: ${evaluation.findings.length}`);
  lines.push("");

  if (evaluation.documents === 0) {
    lines.push(
      "NOTHING WAS EVALUATED. The root holds no SKILL.md, so `findings: 0` means the sweep walked an empty tree — not that the tree is clean.",
    );
    return lines.join("\n");
  }

  const byCheck = new Map<string, number>();
  for (const finding of evaluation.findings) {
    byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  }
  lines.push("## checks");
  lines.push("");
  for (const check of BUNDLED_SKILL_CHECKS) {
    const count = byCheck.get(check) ?? 0;
    lines.push(`- ${check}: ${count === 0 ? "pass" : `${count} finding(s)`}`);
  }
  lines.push("");

  if (evaluation.findings.length > 0) {
    lines.push("## findings");
    lines.push("");
    for (const finding of evaluation.findings) {
      lines.push(`- ${finding.file}:${finding.line ?? "-"} [${finding.check}] ${finding.message}`);
    }
    lines.push("");
  }

  lines.push("## what this did NOT check");
  lines.push("");
  lines.push(
    "This is STRUCTURAL validation only — layer one of the three-layer bar. It says the files are well formed and that every reference into the shipped tree resolves. It says nothing about whether a skill's instructions are correct, useful, or followed: that needs a judge across named dimensions (layer 2) and reliability over repeated runs (layer 3), neither of which is built. A clean report here is not a quality claim.",
  );
  return lines.join("\n");
}
