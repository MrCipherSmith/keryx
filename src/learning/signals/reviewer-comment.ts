// W3 spec, "Deterministic extraction signals" > "Review comments by
// configured reviewers". Reuses `loadReviewLearningConfig` /
// `selectLearnableComments` from `src/review/review-learning.ts` UNCHANGED —
// this file only reads the durable pr-comments records those already point
// at; it never fetches from GitHub.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadReviewLearningConfig, selectLearnableComments } from "../../review/review-learning";
import { splitSentences, type PrCommentState } from "../../review/pr-comments";
import { resolveProjectIdentity } from "../identity";
import { generalizeLesson, REVIEWER_COMMENT_TRIGGER_PREFIX, reviewerIdFor } from "../reviewer-id";
import { clampLearningText } from "./text";
import type { ObservationLine, SignalDraft, SignalRunner } from "./types";

const PR_COMMENTS_DIR = ["reviews", "pr-comments"] as const;

function shortHint(lesson: string): string {
  const words = lesson.split(/\s+/).slice(0, 6).join(" ");
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}

async function listPrCommentFiles(root: string): Promise<string[]> {
  const dir = path.join(root, ".metaproject", ...PR_COMMENTS_DIR);
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * For every `.metaproject/reviews/pr-comments/*.json` record and every
 * configured author, each kept comment's sentence-split lessons
 * (`splitSentences`, the same primitive `learningSourceLessons` in
 * `review-learning.ts` uses) are generalized (`generalizeLesson`, which
 * strips the login/mentions/courtesy phrasing — see `reviewer-id.ts`); each
 * surviving lesson becomes one draft. `reviewerProfile` is set only when the
 * author is also in the config's `reviewerProfiles`; the login itself never
 * reaches a stored field.
 */
export async function reviewerCommentSignal(root: string, _window: ObservationLine[]): Promise<SignalDraft[]> {
  const config = await loadReviewLearningConfig(root);
  if (config === null) return [];

  const files = await listPrCommentFiles(root);
  if (files.length === 0) return [];

  const projectIdentity = resolveProjectIdentity(root).identity;
  const profiledAuthors = new Set((config.reviewerProfiles ?? []).map((login) => login.toLowerCase()));
  // R2-F6: strip/refuse EVERY configured login, not just the comment's own
  // author — a comment from alice quoting or naming a co-reviewer ("as
  // bob-reviewer said...") must not leak bob's login into the stored lesson
  // either. `reviewerProfiles` is a subset of `authors` (the config loader
  // enforces this) but unioned explicitly anyway, in case that invariant is
  // ever relaxed.
  const allConfiguredLogins = [...new Set([...config.authors, ...(config.reviewerProfiles ?? [])])];
  const drafts: SignalDraft[] = [];

  for (const file of files) {
    let state: Pick<PrCommentState, "seen">;
    try {
      const parsed = JSON.parse(await readFile(path.join(root, ".metaproject", ...PR_COMMENTS_DIR, file), "utf8")) as Partial<PrCommentState>;
      state = { seen: Array.isArray(parsed.seen) ? parsed.seen : [] };
    } catch {
      continue;
    }
    const relFile = path.posix.join(".metaproject", ...PR_COMMENTS_DIR, file);

    for (const author of config.authors) {
      const selection = selectLearnableComments(state, [author]);
      for (const comment of selection.kept) {
        for (const sentence of splitSentences(comment.body ?? "")) {
          const lesson = generalizeLesson(sentence, allConfiguredLogins);
          if (lesson === null) continue;
          const isProfiled = profiledAuthors.has(author.toLowerCase());
          drafts.push({
            domain: "review-conventions",
            trigger: clampLearningText(`${REVIEWER_COMMENT_TRIGGER_PREFIX}${shortHint(lesson)})`),
            action: lesson,
            evidence: [
              {
                kind: "reinforcement",
                sourceType: "reviewer-comment",
                sourceRef: `${relFile}#comment-${comment.id}`,
                observedAt: comment.submitted_at,
                weight: 1,
              },
            ],
            extractor: "reviewer-comment",
            reviewerProfile: isProfiled
              ? { reviewerId: reviewerIdFor(projectIdentity, author), generalizedFrom: 1 }
              : null,
          });
        }
      }
    }
  }
  return drafts;
}

export const REVIEWER_COMMENT_SIGNAL: SignalRunner = {
  name: "reviewer-comment",
  domain: "review-conventions",
  run: reviewerCommentSignal,
};
