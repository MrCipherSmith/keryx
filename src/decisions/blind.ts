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
 * Actions that are never asked blind, whatever the config says (the config only
 * adds to this list): releasing, deleting, pushing to something others own,
 * merging, dropping. An English entry matches at the start of a word; a Russian
 * root matches anywhere inside a word, so it covers the prefixed forms too
 * ("пуш" is запушить, спушить, пушнуть; "мерж" is смержить).
 */
export const DEFAULT_IRREVERSIBLE: readonly string[] = [
  "release",
  "delete",
  "push",
  "publish",
  "unpublish",
  "deploy",
  "merge",
  "drop",
  "force",
  "destroy",
  "wipe",
  "purge",
  "remove",
  // Russian
  "релиз",
  "удал",
  "пуш",
  "отправ",
  "опублик",
  "слить",
  "слив",
  "слиян",
  "мерж",
  "деплой",
  "выкат",
  "сброс",
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

/**
 * Whether a question touches an irreversible action. It matches the free
 * `action` tag the caller gives, the question text, and every option's id, label
 * and description (an option can name the action when the question does not:
 * "Which way? - ship it / hold"), case-insensitively, at the start of a word.
 * That errs towards "irreversible": a false positive only costs a measurement, a
 * false negative could cost a release.
 */
export function isIrreversible(
  irreversible: readonly string[],
  question: string,
  action?: string,
  options: ReadonlyArray<{ id: string; label?: string | undefined; description?: string | undefined }> = [],
): boolean {
  const haystacks = [question, action ?? "", ...options.flatMap((option) => [option.id, option.label ?? "", option.description ?? ""])]
    .filter((text) => text.length > 0)
    .map((text) => text.toLowerCase());
  return irreversible.some((entry) => {
    const needle = entry.trim().toLowerCase();
    if (needle.length === 0) return false;
    const cyrillic = /\p{Script=Cyrillic}/u.test(needle);
    const pattern = new RegExp(cyrillic ? escapeRegExp(needle) : `(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}`, "u");
    return haystacks.some((text) => pattern.test(text));
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
