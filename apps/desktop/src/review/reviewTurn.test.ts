import { expect, test } from "bun:test";
import { deskOptionsKey, type DeskReviewOptions } from "../../../../src/review/desk-run-options";
import { describeLaunchSettings, REVIEW_SKILL_PATH, reviewContinueTurn, reviewStartTurn, reviewStateOpenCommand } from "./reviewTurn";

const key = { repo: "Org/Project", repositoryId: "RID", viewer: "Me", number: 12 };
const revision = { baseSha: "b".repeat(40), headSha: "a".repeat(40) };
const url = "https://github.com/Org/Project/pull/12";
const options: DeskReviewOptions = {
  mode: "auto", adaptive: true, maxParallel: 4, maxMinutes: 30, maxTokens: 200000, flowId: "524",
  modelPools: { strong: [{ provider: "anthropic", model: "opus" }], middle: [], light: [{ provider: "openai", model: "mini" }] },
};

test("AC5 the start turn names the skill, the PR, the reviewed range and the exact state open command", () => {
  const text = reviewStartTurn({ key, revision, sessionId: "nav-session", options });
  const settings = deskOptionsKey(options);
  expect(text.split("\n")).toEqual([
    `Review pull request ${url} with the review-orchestrator skill (${REVIEW_SKILL_PATH}).`,
    "This is a Desktop review: keep its state with `keryx review state` as the skill's \"Desktop review state\" section says.",
    `Review this revision: base ${revision.baseSha}, head ${revision.headSha}.`,
    `First run: keryx review state open --pr ${url} --base ${revision.baseSha} --head ${revision.headSha} --viewer Me --session nav-session --settings '${settings}' --source desktop`,
    "Launch settings: mode auto; adaptive on; max parallel 4; limits 30 min, 200000 tokens; models strong anthropic/opus / light openai/mini; Flow 524.",
  ]);
  expect(REVIEW_SKILL_PATH).toBe(".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md");
});

test("the start turn carries the user's request and is never truncated", () => {
  const request = "Сделай адаптивное ревью ".repeat(200).trim();
  const text = reviewStartTurn({ key, revision, sessionId: "s1", options, request: `  ${request}  ` });
  expect(text.endsWith(`\nRequest: ${request}`)).toBe(true);
  expect(text).toContain(reviewStateOpenCommand({ key, revision, sessionId: "s1", options }));
});

test("no options and no viewer: defaults, no --settings and no --viewer", () => {
  const bare = { ...key, viewer: "" };
  const text = reviewStartTurn({ key: bare, revision, sessionId: "s1" });
  expect(text).toContain(`First run: keryx review state open --pr ${url} --base ${revision.baseSha} --head ${revision.headSha} --session s1 --source desktop\n`);
  expect(text).toContain("Launch settings: defaults.");
  expect(text).not.toContain("Request:");
});

test("an explicit settings key wins and a quote in it stays one shell word", () => {
  expect(reviewStateOpenCommand({ key, revision, sessionId: "s1", settingsKey: "it's" })).toContain(`--settings 'it'\\''s' --source desktop`);
});

test("launch settings describe a single-reviewer run without limits or models", () => {
  expect(describeLaunchSettings({ mode: "manual", orchestrator: false, adaptive: false, autoPublish: true, modelPools: { strong: [], middle: [], light: [] } }))
    .toBe("mode manual; single reviewer; no limits; models: session default; publish automatically; no Flow");
});

test("AC7 the continue turn names the review id and state show, with the user's note", () => {
  expect(reviewContinueTurn({ key, note: "  Look at the migration again.  " }).split("\n")).toEqual([
    `Continue the Desktop review of ${url} in this session (review org-project-12-me).`,
    "Run `keryx review state show --review org-project-12-me`, take the round's package and carry on from the step its state names; do not start a new package for the same head.",
    "Look at the migration again.",
  ]);
});

test("the continue turn of a viewer-less key uses the id without an account and no note line", () => {
  const text = reviewContinueTurn({ key: { ...key, viewer: "" } });
  expect(text).toContain("(review org-project-12)");
  expect(text).toContain("keryx review state show --review org-project-12`");
  expect(text.split("\n")).toHaveLength(2);
});
