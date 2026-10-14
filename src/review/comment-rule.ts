import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ReviewScopeConfig } from "./scope";

/**
 * Does this repository's own text carry a rule about comments?
 *
 * The scope pre-filter drops a comment-only block because a comment cannot break
 * behaviour. A repository that limits comments (one line at most, no narration,
 * a comment gate) has said the opposite: a comment there can be a violation. This
 * module answers "does the repository say so", from the places a repository puts
 * its conventions: `CLAUDE.md`, `AGENTS.md` and `.metaproject/rules/**`.
 *
 * The detector is deliberately narrow. A line counts only when it names comments
 * AND carries limiting wording on the same line. A line that merely mentions a
 * comment ("add a comment explaining why") is not a rule. A false positive costs
 * some tokens (comment-only blocks are reviewed); a false negative restores the
 * old behaviour, so the narrow reading is the cheap one to get wrong.
 */

const MENTIONS_COMMENT = /\bcomments?\b/i;

/** Comments left on a pull request or in a review thread, which are not comments in source: "review comments", "PR comments", "comments per PR". */
const REVIEW_COMMENTS = /\b(?:code[- ]review|review(?:er)?|pr|pull[- ]request|github|issue|bot|greptile|thread)(?:'s)?[- ]comments?\b|\bcomments?\b[^.\n]{0,40}\bper (?:pr|pull request|review(?:er)?|round|thread)\b/gi;

/** Whether the line is about comments in source: it mentions comments once the pull-request and review kind is set aside. */
function mentionsCodeComment(line: string): boolean {
  return MENTIONS_COMMENT.test(line.replace(REVIEW_COMMENTS, " "));
}

/** Wording that turns a mention of comments into a limit or a gate. */
const LIMITING_WORDING = [
  /\b(?:limit(?:ed|s)?|max(?:imum)?|cap(?:ped)?|at most|no more than|not exceed|never exceed|shorter than|too long)\b/i,
  /\b(?:one|single|two|three|\d+)[- ](?:short )?(?:line|lines|sentence|sentences)\b/i,
  /\bgate\b/i,
  /\b(?:one|1)[- ]liners?\b/i,
  /\bmulti[- ]?line\b/i,
  /\bnarrat(?:e|es|ed|ing|ion)\b/i,
  /\b(?:forbid(?:den|s)?|prohibit(?:ed|s)?|ban(?:ned|s)?)\b/i,
];

export type CommentRuleMatch = { source: string; line: number; text: string };

/** The first line of `text` that reads as a rule about comments, or `null`. */
export function findCommentRuleLine(text: string): { line: number; text: string } | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (!mentionsCodeComment(raw)) {
      continue;
    }
    if (LIMITING_WORDING.some((pattern) => pattern.test(raw))) {
      return { line: index + 1, text: raw.trim() };
    }
  }
  return null;
}

const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const RULES_DIR = path.join(".metaproject", "rules");
const RULE_EXTENSIONS = new Set([".md", ".mdc"]);
const MAX_RULE_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;

async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return null;
    }
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function ruleFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= MAX_RULE_FILES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && RULE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };
  await walk(path.join(root, RULES_DIR));
  return found;
}

/** Look for a comment rule in the repository's convention sources, in a fixed order; the first hit wins. */
export async function detectRepositoryCommentRule(root: string): Promise<CommentRuleMatch | null> {
  const candidates = [...CONVENTION_FILES.map((name) => path.join(root, name)), ...(await ruleFiles(root))];
  for (const file of candidates) {
    const text = await readSmall(file);
    if (text === null) {
      continue;
    }
    const hit = findCommentRuleLine(text);
    if (hit !== null) {
      return { source: path.relative(root, file), line: hit.line, text: hit.text };
    }
  }
  return null;
}

/** The scope settings a repository's comment rule turns on: `{}` (no change at all) when it has none. */
export async function commentRuleScopeConfig(root: string): Promise<Partial<ReviewScopeConfig>> {
  return (await detectRepositoryCommentRule(root)) === null ? {} : { retainCommentBlocks: true };
}
