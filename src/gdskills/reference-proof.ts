// The proof a worker owes for a document promoted by a condition (flow 462).
//
// The hash pins the version; this pins the place and the reading: the cited
// anchor must be the declared one, the summary long enough, and it must reuse
// the section's own vocabulary. It is a deterministic proxy, not proof of
// reading, and says so in the docs: a worker can still fabricate a plausible
// summary, it just costs more than copying a hash.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContextEntry } from "./context-resolver";
import { extractSection } from "./references-section";

export const SUMMARY_MIN_CHARS = 40;
export const SUMMARY_MIN_SHARED_WORDS = 3;
export const WORD_MIN_LETTERS = 5;

export type ProofRule = "how" | "anchor" | "summary-length" | "summary-words";

export type ProofFailure = {
  rule: ProofRule;
  /** Continues the sentence "<path> (<reason>) ..." in the report. */
  detail: string;
};

/** One `project_context_applied` item, reduced to what the proof reads. */
export type CitedItem = {
  sha256: string;
  how?: string;
  anchor?: string;
  summary?: string;
};

/** A must_read entry the resolver promoted because a declared condition matched. */
export function isPromoted(entry: ContextEntry): boolean {
  return entry.tier === "must_read" && entry.reason.startsWith("condition:");
}

/** Distinct lower-case words of {@link WORD_MIN_LETTERS} letters or more; letters of any script. */
export function distinctWords(text: string): Set<string> {
  return new Set(text.normalize("NFC").toLowerCase().match(/\p{L}{5,}/gu) ?? []);
}

/** The item that stands for the entry: pinned hash and a real reading first, then a real reading, then whatever was cited. */
export function pickProofItem(items: readonly CitedItem[], pinned: string): CitedItem | undefined {
  return items.find((item) => item.sha256 === pinned && item.how !== "n/a") ?? items.find((item) => item.how !== "n/a") ?? items[0];
}

type SectionOutcome = { ok: true; text: string; what: string } | { ok: false; why: string };

/** The anchored section of the file as it is now, or the whole file when the declaration has no anchor. */
async function currentSection(projectRoot: string, entry: ContextEntry): Promise<SectionOutcome> {
  const file = path.isAbsolute(entry.path) ? entry.path : path.join(projectRoot, entry.path);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, why: `${entry.path} cannot be read now (${error instanceof Error ? error.message : String(error)})` };
  }
  if (entry.anchor === undefined) return { ok: true, text, what: "the file" };
  const section = extractSection(text, entry.anchor);
  if (!section.found) return { ok: false, why: `the anchored section "${entry.anchor}" cannot be found in ${entry.path} now (${section.reason})` };
  return { ok: true, text: section.text, what: `the section "${entry.anchor}"` };
}

function charCount(text: string): number {
  return Array.from(text.trim()).length;
}

async function wordsFailure(projectRoot: string, entry: ContextEntry, summary: string): Promise<ProofFailure | undefined> {
  const section = await currentSection(projectRoot, entry);
  if (!section.ok) return { rule: "summary-words", detail: `has a summary that cannot be checked: ${section.why}` };
  const sectionWords = distinctWords(section.text);
  const required = Math.min(SUMMARY_MIN_SHARED_WORDS, sectionWords.size);
  const shared = [...distinctWords(summary)].filter((word) => sectionWords.has(word)).length;
  if (shared >= required) return undefined;
  return {
    rule: "summary-words",
    detail:
      `has a summary that shares ${shared} distinct word(s) of ${WORD_MIN_LETTERS} or more letters with ${section.what}; ` +
      `${required} required. Write the summary in the wording of the text you read`,
  };
}

/** Every rule the cited item breaks, each its own failure. Empty when the proof holds. */
export async function proofFailures(input: { projectRoot: string; entry: ContextEntry; item: CitedItem }): Promise<ProofFailure[]> {
  const { entry, item } = input;
  if (item.how === "n/a") {
    return [{ rule: "how", detail: 'is cited only with how "n/a"; an entry promoted by a condition needs how "read" or "followed", its anchor and a summary' }];
  }
  const failures: ProofFailure[] = [];
  if (entry.anchor !== undefined && item.anchor !== entry.anchor) {
    failures.push({
      rule: "anchor",
      detail: item.anchor === undefined ? `cites no anchor; the declaration says "${entry.anchor}"` : `cites anchor "${item.anchor}"; the declaration says "${entry.anchor}"`,
    });
  }
  if (item.summary === undefined) {
    failures.push({ rule: "summary-length", detail: `has no summary; a promoted entry needs one of at least ${SUMMARY_MIN_CHARS} characters` });
    return failures;
  }
  const length = charCount(item.summary);
  if (length < SUMMARY_MIN_CHARS) {
    failures.push({ rule: "summary-length", detail: `has a summary of ${length} characters; at least ${SUMMARY_MIN_CHARS} are required` });
  }
  const words = await wordsFailure(input.projectRoot, entry, item.summary);
  if (words !== undefined) failures.push(words);
  return failures;
}
