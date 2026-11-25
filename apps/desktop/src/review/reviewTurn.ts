// Desktop Review v3, stage 1 (docs/requirements/keryx-desktop-review-v3/specification.md, «Ход ревью (этап 1)»): a
// manual review is a turn in a live session. These builders produce the exact turn texts; they send nothing.
// A literal `/review` would be keryx's review-inbox view in the ACP shell, so the turn names the skill in plain text.
import type { DeskRevision, DeskRunKey } from "../../../../src/review/desk-run-types";
import { DESK_REVIEW_POOLS, deskOptionsKey, type DeskReviewOptions } from "../../../../src/review/desk-run-options";
import { reviewStateId } from "../../../../src/review/review-state-id";

export const REVIEW_SKILL_PATH = ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md";

/** Shown when the target session is running a turn: nothing is sent and nothing is queued (AC8). */
export const REVIEW_SESSION_BUSY = "The session is running a turn. Send the review when it finishes.";

export function reviewPullRequestUrl(key: Pick<DeskRunKey, "repo" | "number">): string {
  return `https://github.com/${key.repo}/pull/${key.number}`;
}

/** One shell word: plain tokens stay as they are, anything else is single-quoted. */
function shellWord(value: string): string {
  return /^[\w.,:/@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The launch settings in one readable line: mode, adaptivity, parallelism, limits, model pools and Flow. */
export function describeLaunchSettings(options?: DeskReviewOptions): string {
  if (!options) return "defaults";
  const parts = [`mode ${options.mode}`];
  if (options.orchestrator === false) parts.push("single reviewer");
  else parts.push(`adaptive ${options.adaptive ? "on" : "off"}`);
  if (options.maxParallel !== undefined) parts.push(`max parallel ${options.maxParallel}`);
  const limits = [
    options.maxMinutes !== undefined && `${options.maxMinutes} min`,
    options.maxWaves !== undefined && `${options.maxWaves} waves`,
    options.maxTokens !== undefined && `${options.maxTokens} tokens`,
  ].filter((limit): limit is string => typeof limit === "string");
  parts.push(limits.length ? `limits ${limits.join(", ")}` : "no limits");
  const pools = DESK_REVIEW_POOLS.filter(pool => options.modelPools[pool].length > 0)
    .map(pool => `${pool} ${options.modelPools[pool].map(model => `${model.provider}/${model.model}`).join(", ")}`);
  parts.push(pools.length ? `models ${pools.join(" / ")}` : "models: session default");
  if (options.autoPublish) parts.push("publish automatically");
  parts.push(options.flowId ? `Flow ${options.flowId}` : "no Flow");
  return parts.join("; ");
}

export interface ReviewStartTurnInput {
  key: DeskRunKey;
  revision: DeskRevision;
  /** The session the turn goes into; the skill records it as the round's session. */
  sessionId: string;
  options?: DeskReviewOptions | undefined;
  /** Defaults to `deskOptionsKey(options)`; an empty key leaves `--settings` out (unknown settings). */
  settingsKey?: string | undefined;
  /** The user's own request, when the review was asked for in words. */
  request?: string | undefined;
}

/** The `keryx review state open` command the start turn asks the skill to run first. */
export function reviewStateOpenCommand(input: ReviewStartTurnInput): string {
  const { key, revision, sessionId } = input;
  const settings = input.settingsKey ?? deskOptionsKey(input.options);
  const args = ["--pr", reviewPullRequestUrl(key), "--base", revision.baseSha, "--head", revision.headSha,
    ...(key.viewer ? ["--viewer", key.viewer] : []), "--session", sessionId, ...(settings ? ["--settings", settings] : []),
    "--source", "desktop"];
  return ["keryx review state open", ...args.map(shellWord)].join(" ");
}

/** The turn that starts (or resumes, by the round rule R5) a Desktop review in a session. */
export function reviewStartTurn(input: ReviewStartTurnInput): string {
  const { key, revision } = input;
  const url = reviewPullRequestUrl(key);
  const request = input.request?.trim();
  return [
    `Review pull request ${url} with the review-orchestrator skill (${REVIEW_SKILL_PATH}).`,
    "This is a Desktop review: keep its state with `keryx review state` as the skill's \"Desktop review state\" section says.",
    `Review this revision: base ${revision.baseSha}, head ${revision.headSha}.`,
    `First run: ${reviewStateOpenCommand(input)}`,
    `Launch settings: ${describeLaunchSettings(input.options)}.`,
    ...(request ? [`Request: ${request}`] : []),
  ].join("\n");
}

/** The turn that continues a Desktop review in the session that holds it. */
export function reviewContinueTurn({ key, note }: { key: DeskRunKey; note?: string | undefined }): string {
  const id = reviewStateId(key.repo, key.number, key.viewer || null);
  const text = note?.trim();
  return [
    `Continue the Desktop review of ${reviewPullRequestUrl(key)} in this session (review ${id}).`,
    `Run \`keryx review state show --review ${id}\`, take the round's package and carry on from the step its state names; do not start a new package for the same head.`,
    ...(text ? [text] : []),
  ].join("\n");
}
