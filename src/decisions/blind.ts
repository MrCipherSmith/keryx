// Flow 392: blind mode and the irreversible list.
//
// A third of the questions are asked blind: no "recommended" mark, the options in
// a random order, the recommendation revealed right after the answer. It exists
// to measure whether the human follows the mark or the substance. It must never
// make an irreversible choice harder to get right, so a question matching the
// irreversible list is always asked in the ordinary way.

import { readFile } from "node:fs/promises";
import { configFile } from "./store";

/** Flow 392 probability that a question is asked blind. Superseded by the arm weights in arms.ts (D is 0.2 by default); kept for the exports that still name it. */
export const BLIND_PROBABILITY = 1 / 3;

/**
 * STRONG terms: a question that names one is always irreversible, wherever it
 * appears (the question, an option, the --action tag), whatever the config says
 * (the config only adds to this list): releasing, publishing, deploying, deleting,
 * pushing. An English entry matches at the start of a word; a Russian root matches
 * anywhere inside a word, so it covers the prefixed forms too ("пуш" is запушить,
 * спушить, пушнуть).
 */
export const DEFAULT_IRREVERSIBLE: readonly string[] = [
  "release",
  "delete",
  "push",
  "publish",
  "unpublish",
  "deploy",
  "destroy",
  "wipe",
  "purge",
  // the real synonyms of "release it": ship it, roll it out, promote it, go live
  "ship",
  "rollout",
  "roll out",
  "promote",
  "go live",
  // Russian
  "релиз",
  "удал",
  "пуш",
  "опублик",
  "деплой",
  "деплои",
  "выкат",
  "выпуск",
  "выпуст",
  "залить",
  "залей",
  "заливать",
  "заливк",
  "залью",
  "накат",
  // "зарелизить" and "релизнуть" already contain "релиз"
  "затег",
  "тегнут",
  "тегани",
  "тегнем",
  "тегну",
];

/**
 * STRONG patterns: phrases that are irreversible as a whole but that no single
 * word gives away. They are matched against the lowercased question, option or
 * action tag, and they count everywhere, like a strong term.
 */
export const STRONG_PATTERNS: readonly RegExp[] = [
  // destructive git and shell commands
  /(?:^|[^\p{L}\p{N}])reset\s+--hard/u,
  /(?:^|[^\p{L}\p{N}])clean\s+-[a-z]*f/u,
  /(?:^|[^\p{L}\p{N}])checkout\s+(?:--(?![\p{L}\p{N}-])|-f(?![\p{L}\p{N}])|--force)/u,
  /(?:^|[^\p{L}\p{N}])rm\s+-[a-z]*[rf]/u,
  /(?:^|[^\p{L}\p{N}])branch\s+-d(?![\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])--force/u,
  // tagging a version is releasing it: "tag v1.2.0", "tag the version", "поставить тег на версию"
  /(?:^|[^\p{L}\p{N}])tag\p{L}*\s+(?:\S+\s+){0,2}?v?\d+\.\d+/u,
  /(?:^|[^\p{L}\p{N}])tag\p{L}*\s+(?:the\s+|this\s+|it\s+as\s+|it\s+)?(?:version|build|head|commit)(?![\p{L}\p{N}])/u,
  /т[еэ]г\p{L}*\s+(?:\S+\s+){0,2}?(?:верси|релиз|v?\d+\.\d+)/u,
  /верси\p{L}*\s+(?:\S+\s+){0,2}?т[еэ]г/u,
  // cutting or bumping a version is releasing it: "cut 0.3.62", "bump the version", "cut a tag"
  /(?:^|[^\p{L}\p{N}])cut\s+(?:\S+\s+){0,2}?(?:v\d+\.\d+|v?\d+\.\d+\.\d+|version|build|tag|release)(?![\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])bump\p{L}*\s+(?:\S+\s+){0,3}?(?:version|release|build|v\d+\.\d+|v?\d+\.\d+\.\d+|major|minor|patch)(?![\p{L}\p{N}])/u,
  /(?:^|[^\p{L}\p{N}])tag\s+(?:it|this|that|them)(?![\p{L}\p{N}])(?=\s*(?:$|[?!.,;:)])|\s+(?:now|too|and|as|with|then)(?![\p{L}\p{N}]))/u,
  /(?:подн\p{L}*|повыс\p{L}*)\s+(?:\S+\s+){0,2}?верси/u,
  /верси\p{L}*\s+(?:\S+\s+){0,2}?(?:подн|повыс)/u,
  // sending something to a package registry
  /(?:^|[^\p{L}\p{N}])(?:to|into|в|на)\s+(?:the\s+)?(?:npm|pypi|crates\.io|rubygems|registry)(?![\p{L}\p{N}])/u,
  // "в прод", "на продакшн" (and not "в продукт")
  /(?:^|[^\p{L}\p{N}])(?:в|на|во)\s+прод(?:акш[еэ]?н\p{L}*|е|у|ом)?(?![\p{L}\p{N}])/u,
];

/**
 * WEAK terms: ordinary coding words ("merge two helpers", "drop an unused import",
 * "remove dead code", "force a type") that are only irreversible next to a risk
 * target in the same question or the same option, or when the caller tags the
 * action with one of them (`--action merge`). An agent should pass `--action` for
 * anything irreversible: that is the reliable path, the text match is a safety net.
 */
export const WEAK_IRREVERSIBLE: readonly string[] = [
  "merge",
  "drop",
  "remove",
  "force",
  "reset",
  "overwrite",
  "truncate",
  "send",
  "rollback",
  "revert",
  // Russian
  "слить",
  "слей",
  "слив",
  "слиян",
  "мерж",
  "сброс",
  "отправ",
  "перезапис",
  "убра",
];

/** What makes a weak term risky: a shared or long-lived thing it can act on. */
const RISK_TARGETS: readonly string[] = [
  "main",
  "master",
  "prod",
  "production",
  "remote",
  "origin",
  "database",
  "db",
  "table",
  "branch",
  "tag",
  "repository",
  "repo",
  "pr",
  "mr",
  "release",
  "pull request",
  "commit",
  // Russian
  "продакш",
  "мастер",
  "ветк",
  "репозитор",
  "баз",
  "таблиц",
  "тег",
];

export interface DecisionsConfig {
  irreversible: string[];
}

export async function loadDecisionsConfig(cwd: string): Promise<DecisionsConfig> {
  const merged = new Set<string>(DEFAULT_IRREVERSIBLE);
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile(cwd), "utf8"));
    const list = parsed !== null && typeof parsed === "object" ? (parsed as { irreversible?: unknown }).irreversible : undefined;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === "string" && entry.trim().length > 0) merged.add(entry.trim().toLowerCase());
      }
    }
  } catch {
    // absent or unreadable config: the built-in list stands
  }
  return { irreversible: [...merged] };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEPARATOR = "(^|[^\\p{L}\\p{N}])";

function wordStart(needle: string): RegExp {
  return new RegExp(`${SEPARATOR}${escapeRegExp(needle)}`, "u");
}

function isCyrillic(text: string): boolean {
  return /\p{Script=Cyrillic}/u.test(text);
}

function matchesTerm(needle: string, text: string): boolean {
  return (isCyrillic(needle) ? new RegExp(escapeRegExp(needle), "u") : wordStart(needle)).test(text);
}

/** A whole word (or its plural / a short ending), so "main" is not "maintain", "origin" is not "original", "баз" is not "базовый". */
function matchesTarget(target: string, text: string): boolean {
  if (isCyrillic(target)) return new RegExp(`${SEPARATOR}${escapeRegExp(target)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`, "u").test(text);
  const pattern = target === "repository" ? "repositor(?:y|ies)" : `${escapeRegExp(target)}(?:e?s)?`;
  return new RegExp(`${SEPARATOR}${pattern}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * A weak verb whose object is a pronoun ("Merge it now?", "Слить это?") or that has
 * no object at all ("Merge?") says nothing about what it acts on, so it is read as
 * the risky case: an ambiguous question fails towards non-blind. "Merge this helper
 * into that one" has a noun after the pronoun and stays ordinary.
 */
function hasBareObject(needle: string, text: string): boolean {
  const russian = isCyrillic(needle);
  const stem = `${russian ? "" : SEPARATOR}${escapeRegExp(needle)}\\p{L}{0,${russian ? 6 : 3}}`;
  const filler = russian ? "(?:сейчас|уже|пожалуйста)" : "(?:now|please|already|today)";
  const pronoun = russian ? "(?:это|его|её|ее|их|всё|все)" : "(?:it|this|that|them|everything)";
  const end = russian
    ? "(?:$|[?!.,;:)]|(?:сейчас|уже|в|на|и|или|с|до|после)(?![\\p{L}\\p{N}]))"
    : "(?:$|[?!.,;:)]|(?:now|please|already|today|into|to|in|on|onto|with|and|or|before|after|for|first|then)(?![\\p{L}\\p{N}]))";
  const withPronoun = new RegExp(`${stem}\\s+(?:${filler}\\s+)?${pronoun}(?![\\p{L}\\p{N}])\\s*(?=${end})`, "u");
  const withoutObject = new RegExp(`${stem}\\s*(?:${filler})?\\s*(?:$|[?!.])`, "u");
  return withPronoun.test(text) || withoutObject.test(text);
}

/**
 * A word that names a piece of code ("deleteUser", "release_notes", `push`) is not
 * the action: "Rename deleteUser to removeUser?" is a refactor, not a deletion. It
 * is masked only when the question is itself about code (it says rename, refactor,
 * function, ...), so "Run deployToProd now?" keeps its meaning.
 */
const CODE_CUES = new RegExp(
  `${SEPARATOR}(?:renam\\p{L}*|refactor\\p{L}*|extract\\p{L}*|inline\\p{L}*|signature|function|method|variable|parameter|argument|identifier|symbol|helper|prop|naming|constant|interface|alias|component|переименов\\p{L}*|функци\\p{L}*|метод|переменн\\p{L}*|параметр|идентификатор)(?![\\p{L}\\p{N}])`,
  "iu",
);
const IDENTIFIER =
  /`[^`\n]*`|(?<![\p{L}\p{N}_])(?:[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?![\p{L}\p{N}_])/gu;

function maskIdentifiers(text: string): string {
  return CODE_CUES.test(text) ? text.replace(IDENTIFIER, " identifier ") : text;
}

/**
 * Whether a question touches an irreversible action, in two tiers.
 *
 * Strong terms (the `irreversible` list: the built-in one plus whatever the
 * project config added) and strong patterns (`git reset --hard`, `rm -rf`, "tag
 * v1.2.0", "to npm", "в прод") count wherever they appear: the free `action` tag,
 * the question, every option's id, label and description. Weak terms
 * (WEAK_IRREVERSIBLE) count inside the `action` tag, or when the question, or one
 * option, also names a risk target (main, production, remote, a branch, a PR, a
 * table, ...), or when the weak verb has only a pronoun or nothing as its object
 * ("Merge it now?"). Matching is case-insensitive, and an ambiguous question errs
 * towards "irreversible": a false positive only costs a measurement, a false
 * negative could cost a release. Identifiers in a question about code
 * ("rename deleteUser to removeUser") are not read as actions.
 */
export function isIrreversible(
  irreversible: readonly string[],
  question: string,
  action?: string,
  options: ReadonlyArray<{ id: string; label?: string | undefined; description?: string | undefined }> = [],
): boolean {
  const lower = (text: string): string => text.toLowerCase();
  const units = [question, ...options.map((option) => [option.id, option.label ?? "", option.description ?? ""].join(" "))]
    .map((text) => lower(maskIdentifiers(text)))
    .filter((text) => text.trim().length > 0);
  const tag = lower(action ?? "");
  const haystacks = tag.trim().length > 0 ? [tag, ...units] : units;

  const strong =
    irreversible.some((entry) => {
      const needle = entry.trim().toLowerCase();
      return needle.length > 0 && haystacks.some((text) => matchesTerm(needle, text));
    }) || STRONG_PATTERNS.some((pattern) => haystacks.some((text) => pattern.test(text)));
  if (strong) return true;

  if (tag.trim().length > 0 && WEAK_IRREVERSIBLE.some((needle) => matchesTerm(needle, tag))) return true;
  return units.some((text) => {
    const present = WEAK_IRREVERSIBLE.filter((needle) => matchesTerm(needle, text));
    if (present.length === 0) return false;
    return RISK_TARGETS.some((target) => matchesTarget(target, text)) || present.some((needle) => hasBareObject(needle, text));
  });
}

/** Fisher-Yates over a copy, driven by `random` in [0, 1). */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
