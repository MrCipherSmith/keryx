// Flow 392: blind mode and the irreversible list.
//
// A third of the questions are asked blind: no "recommended" mark, the options in
// a random order, the recommendation revealed right after the answer. It exists
// to measure whether the human follows the mark or the substance. It must never
// make an irreversible choice harder to get right, so a question matching the
// irreversible list is always asked in the ordinary way.

import { readFile } from "node:fs/promises";
import { configFile } from "./store";

/** Probability that a question is asked blind (AC3). */
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
  // Russian
  "релиз",
  "удал",
  "пуш",
  "опублик",
  "деплой",
  "деплои",
  "выкат",
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
  // Russian
  "слить",
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
  // Russian
  "продакш",
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

function matchesTerm(needle: string, text: string): boolean {
  const cyrillic = /\p{Script=Cyrillic}/u.test(needle);
  return (cyrillic ? new RegExp(escapeRegExp(needle), "u") : wordStart(needle)).test(text);
}

/** A whole word (or its plural / a short ending), so "main" is not "maintain", "origin" is not "original", "баз" is not "базовый". */
function matchesTarget(target: string, text: string): boolean {
  const cyrillic = /\p{Script=Cyrillic}/u.test(target);
  if (cyrillic) return new RegExp(`${SEPARATOR}${escapeRegExp(target)}\\p{L}{0,3}(?![\\p{L}\\p{N}])`, "u").test(text);
  const pattern = target === "repository" ? "repositor(?:y|ies)" : `${escapeRegExp(target)}(?:e?s)?`;
  return new RegExp(`${SEPARATOR}${pattern}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * Whether a question touches an irreversible action, in two tiers.
 *
 * Strong terms (the `irreversible` list: the built-in one plus whatever the
 * project config added) count wherever they appear: the free `action` tag, the
 * question, every option's id, label and description. Weak terms (WEAK_IRREVERSIBLE)
 * count only inside the `action` tag, or when the question, or one option, also
 * names a risk target (main, production, remote, a branch, a table, ...). Matching
 * is case-insensitive, and an ambiguous question still errs towards
 * "irreversible": a false positive only costs a measurement, a false negative
 * could cost a release.
 */
export function isIrreversible(
  irreversible: readonly string[],
  question: string,
  action?: string,
  options: ReadonlyArray<{ id: string; label?: string | undefined; description?: string | undefined }> = [],
): boolean {
  const lower = (text: string): string => text.toLowerCase();
  const units = [question, ...options.map((option) => [option.id, option.label ?? "", option.description ?? ""].join(" "))].map(lower).filter((text) => text.trim().length > 0);
  const tag = lower(action ?? "");
  const haystacks = tag.trim().length > 0 ? [tag, ...units] : units;

  const strong = irreversible.some((entry) => {
    const needle = entry.trim().toLowerCase();
    return needle.length > 0 && haystacks.some((text) => matchesTerm(needle, text));
  });
  if (strong) return true;

  if (tag.trim().length > 0 && WEAK_IRREVERSIBLE.some((needle) => matchesTerm(needle, tag))) return true;
  return units.some((text) => WEAK_IRREVERSIBLE.some((needle) => matchesTerm(needle, text)) && RISK_TARGETS.some((target) => matchesTarget(target, text)));
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
