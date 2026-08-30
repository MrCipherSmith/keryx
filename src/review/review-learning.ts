// The join between "comments these particular people left" and "teach the local
// skill" — flow 206.
//
// WHY THIS FILE EXISTS AT ALL
//
// Two halves shipped working and unconnected. `keryx review comments collect`
// wrote a durable record of every comment on a pull request and who left it.
// `keryx skills learn --from-review <path>` turned a file into a proposal, and
// `keryx skills learn apply` was the only thing that could write it into a
// project skill. Nothing named *whose* comments should become lessons, so the
// loop was two commands and a human copy-paste in the middle.
//
// This file is the missing middle, and it is deliberately thin:
//
//   - It reads. It never fetches. The record `collect` wrote is the source, and
//     a learning pass that went back to GitHub would be learning from a pull
//     request that has moved on since the round it claims to describe.
//   - It filters, and the filter is a configuration file, not a judgement. There
//     is no heuristic here for "senior", "authoritative" or "worth learning
//     from". A project names logins; an author it does not name contributes
//     nothing.
//   - It renders, and hands the rendering to `learnProjectSkill`. There is no
//     second learning implementation, no second applier, and nothing in this
//     file writes a `SKILL.md`.
//
// WHY ABSENCE IS SILENT
//
// A project with no `.metaproject/review-learning.config.json` does not learn.
// That is the common case and it is correct, so it prints one plain line and
// exits 0 — not a warning. A tool that warns about a supported state teaches its
// users that warnings are noise, and the next warning that matters is the one
// they skip.

import path from "node:path";
import { pathExists } from "../lib/fs";
import { readJsonFile } from "../lib/json";
import { splitSentences, type PrCommentState, type SeenComment } from "./pr-comments";

export const REVIEW_LEARNING_CONFIG_SCHEMA_VERSION = 1;

export type ReviewLearningConfig = {
  schemaVersion: typeof REVIEW_LEARNING_CONFIG_SCHEMA_VERSION;
  /** `<module>/<skill>` under `.metaproject/project-skills/`. */
  skill: string;
  /** `owner/repo` — the repository whose collected comments teach this skill. */
  repo: string;
  /** GitHub logins whose comments count. Empty is refused; see the loader. */
  authors: string[];
};

export function reviewLearningConfigPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "review-learning.config.json");
}

/**
 * The config, or `null` when the project has none.
 *
 * `null` and a throw are two different answers and the distinction is the point.
 * No file means "this project does not learn" — supported, silent. A file that
 * is present and wrong means someone tried to configure learning and it will not
 * work, and defaulting past that would produce a learning pass that silently
 * teaches nothing while reporting success.
 */
export async function loadReviewLearningConfig(cwd: string): Promise<ReviewLearningConfig | null> {
  const file = reviewLearningConfigPath(cwd);
  if (!(await pathExists(file))) {
    return null;
  }

  const raw = await readJsonFile<Partial<ReviewLearningConfig>>(file);
  const where = path.relative(cwd, file);
  if (raw.schemaVersion !== REVIEW_LEARNING_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `${where}: schemaVersion must be ${REVIEW_LEARNING_CONFIG_SCHEMA_VERSION}, got ${JSON.stringify(raw.schemaVersion)}.`,
    );
  }
  const skill = typeof raw.skill === "string" ? raw.skill.trim() : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(skill)) {
    throw new Error(
      `${where}: "skill" must be "<module>/<skill>" naming a project skill under .metaproject/project-skills, got ${JSON.stringify(raw.skill)}.`,
    );
  }
  const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`${where}: "repo" must be "owner/repo", got ${JSON.stringify(raw.repo)}.`);
  }
  const authors = Array.isArray(raw.authors)
    ? raw.authors.filter((author): author is string => typeof author === "string" && author.trim() !== "")
    : [];
  if (authors.length === 0) {
    throw new Error(
      `${where}: "authors" must name at least one login. A configured file with no authors learns from nobody, which is what deleting the file already means — and it says so out loud instead of reporting a successful pass that taught nothing.`,
    );
  }

  return {
    schemaVersion: REVIEW_LEARNING_CONFIG_SCHEMA_VERSION,
    skill,
    repo,
    authors: authors.map((author) => author.trim()),
  };
}

export type LearningSelection = {
  /** Comments from a configured author that carry text. These become lessons. */
  kept: SeenComment[];
  /** Comments dropped because nobody configured their author. */
  unconfigured: SeenComment[];
  /**
   * Comments from a configured author whose body the record does not carry —
   * written before the record held bodies. Reported, never guessed at.
   */
  bodyless: SeenComment[];
};

/**
 * GitHub logins are case-insensitive, so the filter is too. It is otherwise
 * exact: no prefix match, no "contains", no bot-suffix stripping. A near-match
 * that let one extra person through would be indistinguishable, in the resulting
 * `SKILL.md`, from a configured one.
 */
export function selectLearnableComments(
  state: Pick<PrCommentState, "seen">,
  authors: readonly string[],
): LearningSelection {
  const configured = new Set(authors.map((author) => author.toLowerCase()));
  const kept: SeenComment[] = [];
  const unconfigured: SeenComment[] = [];
  const bodyless: SeenComment[] = [];
  for (const comment of state.seen) {
    if (!configured.has(comment.author.toLowerCase())) {
      unconfigured.push(comment);
      continue;
    }
    if (typeof comment.body !== "string" || comment.body.trim() === "") {
      bodyless.push(comment);
      continue;
    }
    kept.push(comment);
  }
  return { kept, unconfigured, bodyless };
}

export type RenderLearningSourceInput = {
  repo: string;
  number: number;
  skill: string;
  authors: readonly string[];
  selection: LearningSelection;
  collectedSha: string | null;
};

/**
 * The two files, and why there are two.
 *
 * `.json` is what `learnProjectSkill` reads, and it is **an array of lesson
 * strings and nothing else**. That shape is not decoration: `extractLessons`
 * parses a JSON source and collects *every* string in it between 12 and 260
 * characters. A source carrying its own provenance — "Generated by keryx review
 * learn", "Configured authors: …" — would see those sentences harvested as
 * lessons and written into the project's `SKILL.md` beside the real ones. Every
 * string in the file is therefore a lesson, by construction.
 *
 * `.md` is the provenance the `.json` cannot hold: which record it came from,
 * which commit that record was true of, who was configured, how many comments
 * were excluded and why. Nothing reads it; it exists so that a lesson in a
 * `SKILL.md` can be traced back to a pull request six months later.
 *
 * Both are named after the pull request, so a second run overwrites its own
 * files rather than accumulating one pair per invocation.
 */
export function learningSourcePath(cwd: string, repo: string, number: number): string {
  return path.join(cwd, ".metaproject", "data", "gdskills", "learning-sources", `${slug(repo)}__${number}.json`);
}

export function learningRecordPath(cwd: string, repo: string, number: number): string {
  return path.join(cwd, ".metaproject", "data", "gdskills", "learning-sources", `${slug(repo)}__${number}.md`);
}

function slug(repo: string): string {
  return repo.replace(/\//g, "__");
}

/** The extractor's window. A string outside it is dropped, so the renderer works inside it. */
const MIN_LESSON = 12;
const MAX_LESSON = 260;

/**
 * The lessons themselves — the only thing the extractor will see.
 *
 * Bodies are split into sentences rather than passed whole. The record stores up
 * to 800 characters of a comment and the extractor drops anything over 260, so a
 * comment passed whole is a comment that teaches nothing at all: the longer and
 * more considered the review comment, the more certainly it would be silently
 * discarded. Splitting is what makes a long comment contribute the points it
 * actually makes.
 *
 * Only kept comments contribute. The unconfigured ones are counted in the `.md`
 * and never quoted anywhere — an "excluded, for completeness" appendix would put
 * the excluded author's words into the file the extractor reads, which is
 * precisely the leak the filter exists to prevent.
 */
export function learningSourceLessons(selection: LearningSelection): string[] {
  const lessons: string[] = [];
  for (const comment of selection.kept) {
    for (const sentence of splitSentences(comment.body ?? "")) {
      const collapsed = sentence.replace(/\s+/g, " ").trim();
      if (collapsed.length < MIN_LESSON) continue;
      lessons.push(collapsed.length <= MAX_LESSON ? collapsed : clip(collapsed));
    }
  }
  return [...new Set(lessons)];
}

export function renderLearningSource(selection: LearningSelection): string {
  return `${JSON.stringify(learningSourceLessons(selection), null, 2)}\n`;
}

/** Cut at a word boundary and say so; a lesson chopped mid-word reads as corruption. */
function clip(text: string): string {
  const head = text.slice(0, MAX_LESSON - 2);
  const boundary = head.lastIndexOf(" ");
  return `${(boundary > MAX_LESSON / 2 ? head.slice(0, boundary) : head).trimEnd()}…`;
}

/** The provenance file. Nothing reads it; it is how a lesson stays traceable. */
export function renderLearningRecord(input: RenderLearningSourceInput): string {
  const { selection } = input;
  const used =
    selection.kept.length === 0
      ? "- none\n"
      : selection.kept.map((comment) => `- \`${comment.id}\` by \`${comment.author}\` — ${comment.url}\n`).join("");

  return `# Learning source for ${input.repo}#${input.number}

Written by \`keryx review learn\` from \`.metaproject/reviews/pr-comments/${slug(input.repo)}__${input.number}.json\`,
the record \`keryx review comments collect\` wrote. No network call produced this file.

- Repository: \`${input.repo}\`
- Pull request: \`${input.number}\`
- Record collected against: \`${input.collectedSha ?? "unrecorded"}\`
- Target skill: \`${input.skill}\`
- Configured authors: ${input.authors.map((author) => `\`${author}\``).join(", ")}
- Comments used: ${selection.kept.length}
- Comments excluded because their author is not configured: ${selection.unconfigured.length}
- Comments from a configured author with no recorded body: ${selection.bodyless.length}

The excluded comments are counted here and quoted nowhere, including here. Their
text reaches no proposal and no \`SKILL.md\`.

## Comments used

${used}
## Lessons extracted

${learningSourceLessons(selection).map((lesson) => `- ${lesson}\n`).join("") || "- none\n"}`;
}
