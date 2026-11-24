import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishCompletedDeskReview, requestDeskPublication } from "./desk-publication";
import { DESK_TEMPLATE_SELECTION, projectReviewOverlay, reportTemplateFingerprint } from "./desk-review-report";
import { DeskRunStore } from "./desk-run-store";
import { isolateGitDiscovery } from "./test-git-fixture";

const key = { repo: "example/project", repositoryId: "fixture-repo-id", viewer: "fixture-reviewer", number: 7 };
const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const envNames = ["KERYX_CONFIG_DIR", "KERYX_DATA_DIR", "PATH", "GH_TOKEN", "GITHUB_TOKEN",
  "FIXTURE_BODY", "FIXTURE_PR", "FIXTURE_NAMED_PR", "FIXTURE_DIFF", "FIXTURE_DIFF_READS",
  "FIXTURE_COMPARE", "FIXTURE_COMPARE_READS", "FIXTURE_DISCUSSION", "FIXTURE_DISCUSSION_READS", "FIXTURE_POST_FAIL"] as const;
let saved: Partial<Record<(typeof envNames)[number], string | undefined>>;
let restoreGit: () => void;
let root: string;
let project: string;
let directory: string;
let id: string;
const confirmFixture = async () => {};

function json(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}

function setPull(fields: { state?: string; baseRefOid?: string; headRefOid?: string }, viewer = key.viewer) {
  json(path.join(root, "pr.json"), { data: { viewer: { login: viewer }, repository: { id: key.repositoryId,
    pullRequest: { state: "OPEN", baseRefOid: revision.baseSha, headRefOid: revision.headSha, ...fields } } } });
}

function setHead(headRefOid: string, viewer = key.viewer) {
  setPull({ headRefOid }, viewer);
}

const posted = () => JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8"));
const reads = (name: "FIXTURE_COMPARE_READS" | "FIXTURE_DISCUSSION_READS") =>
  existsSync(process.env[name]!) ? readFileSync(process.env[name]!, "utf8") : "";
/** GitHub's compare status of the reviewed head against the current head, or `fail:<stderr>` for a failing gh call. */
const setCompare = (status: string) => writeFileSync(process.env.FIXTURE_COMPARE!, `${status}\n`);
const movedHead = "c".repeat(40);
const movedLine = `Reviewed commit \`${revision.headSha}\`. The pull request has moved to \`${movedHead}\` since; ` +
  "this review does not cover the newer commits.";

beforeEach(() => {
  restoreGit = isolateGitDiscovery();
  saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  root = mkdtempSync(path.join(tmpdir(), "keryx-review-publication-"));
  project = path.join(root, "project");
  mkdirSync(project);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "init.templateDir=", ...args], { cwd: project });
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/example/project.git");

  process.env.KERYX_CONFIG_DIR = path.join(root, "config");
  process.env.KERYX_DATA_DIR = path.join(root, "data");
  process.env.PATH = root + path.delimiter + saved.PATH;
  process.env.FIXTURE_BODY = path.join(root, "post.json");
  process.env.FIXTURE_PR = path.join(root, "pr.json");
  process.env.FIXTURE_DIFF = path.join(root, "diff.txt");
  process.env.FIXTURE_DIFF_READS = path.join(root, "diff-reads");
  process.env.FIXTURE_COMPARE = path.join(root, "compare.txt");
  process.env.FIXTURE_COMPARE_READS = path.join(root, "compare-reads");
  process.env.FIXTURE_DISCUSSION = path.join(root, "discussion.json");
  process.env.FIXTURE_DISCUSSION_READS = path.join(root, "discussion-reads");
  setCompare("ahead");
  writeFileSync(process.env.FIXTURE_DISCUSSION, "[[]]\n");
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.FIXTURE_NAMED_PR;
  delete process.env.FIXTURE_POST_FAIL;
  setHead(revision.headSha);
  writeFileSync(process.env.FIXTURE_DIFF, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  const gh = path.join(root, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    'case "$1:$4" in',
    "  auth:*) printf 'fixture-value-only\\n' ;;",
    '  api:graphql) if [ -n "$GH_TOKEN" ] && [ -n "$FIXTURE_NAMED_PR" ]; then cat "$FIXTURE_NAMED_PR"; else cat "$FIXTURE_PR"; fi ;;',
    '  api:-H) printf x >> "$FIXTURE_DIFF_READS"; cat "$FIXTURE_DIFF" ;;',
    '  api:--paginate) printf x >> "$FIXTURE_DISCUSSION_READS"; cat "$FIXTURE_DISCUSSION" ;;',
    `  api:repos/*/compare/*) printf '%s %s %s\\n' "$4" "$5" "$6" >> "$FIXTURE_COMPARE_READS"; read -r status < "$FIXTURE_COMPARE"`,
    `    case "$status" in fail:*) printf '%s\\n' "\${status#fail:}" >&2; exit 1 ;; *) printf '%s\\n' "$status" ;; esac ;;`,
    // FIXTURE_POST_FAIL: the review POST fails with this stderr line, as gh reports an HTTP error.
    '  api:--method) if [ -n "$FIXTURE_POST_FAIL" ]; then cat > /dev/null; printf \'%s\\n\' "$FIXTURE_POST_FAIL" >&2; exit 1; fi;' +
      ' cat > "$FIXTURE_BODY"; printf \'{"id":23}\\n\' ;;',
    "  *) exit 1 ;;",
    "esac",
  ].join("\n"));
  chmodSync(gh, 0o700);

  const store = new DeskRunStore();
  try {
    id = store.request(project, key, revision)!;
    const attempt = store.byId(id)!;
    store.end(attempt, {
      state: "partial", phase: "Partial", reason: "Partial fixture",
      result: { reviewed: revision, coverage: "partial", verdict: "REQUEST_CHANGES",
        findings: { blocker: 0, major: 1, minor: 1, info: 0 }, report: "Fixture review." },
    });
    directory = store.directory(id);
  } finally {
    store.close();
  }
  const pkg = path.join(directory, "package");
  mkdirSync(pkg, { recursive: true });
  json(path.join(pkg, "manifest.json"), {
    reviewId: "fixture-round", status: "closed",
    target: { kind: "pr", ref: "https://github.com/example/project/pull/7", base: revision.baseSha, head: revision.headSha },
    artifacts: {}, coverage: [],
  });
  json(path.join(pkg, "findings.json"), [
    { id: "F-001", global_id: "fixture#F-001", severity: "major", reviewer: "review-logic", problem: "The filter drops active rows.",
      file: "src/a.ts", line: 1, impact: "Open rows are hidden.", suggested_fix: "Keep active rows." },
    { id: "F-002", global_id: "fixture#F-002", severity: "minor", reviewer: "review-logic", problem: "A label is ambiguous.",
      premise: { verdict: "challenged", question: "Is this label intentional?" } },
  ]);
  writeFileSync(path.join(pkg, "report.md"), "Fixture review.\nEvidence level: static only — did not run: tests\n\nNot verified: 1\n");
  mkdirSync(path.join(project, ".metaproject"));
  writeFileSync(path.join(project, ".metaproject", "review-publish-template.md"), "## Team review\n\n{{review}}\n");
});
afterEach(() => {
  for (const name of envNames) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  restoreGit();
  rmSync(root, { recursive: true, force: true });
});

test("draft questions, template and saved settings are local until one explicit submit", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.settings.verdict).toBe("changes");
  expect(preview.headMoved).toBeUndefined();
  expect(preview.questions).toMatchObject([{ id: "fixture#F-002", text: "Is this label intentional?", recommendation: "dismiss" }]);
  expect(preview.canSubmit).toBe(false);
  expect(preview.overlayAvailable).toBe(true);
  expect(preview.body).toContain("## Team review\n\n**Changes requested — 1 Major.**");
  expect(preview.body).toContain("Evidence level: static only — did not run: tests");
  expect(preview.body).toContain("### Major");
  expect(preview.body).toContain(`/blob/${revision.headSha}/src/a.ts#L1`);
  const draft = await requestDeskPublication(project, key, { kind: "save", id,
    settings: { ...preview.settings, inline: true, overlay: false, keryxTemplate: false, answers: { "fixture#F-002": "dismiss" } } });
  expect(draft.savedAt).toBeDefined();
  expect(draft.settings).toMatchObject({ keryxTemplate: true, overlay: true });
  expect(draft.body).toContain("## Team review");
  expect(draft.body).not.toContain("A label is ambiguous");
  expect(draft.inlineCount).toBe(1);
  expect(draft.canSubmit).toBe(true);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  expect((await requestDeskPublication(project, key, { kind: "preview", id })).settings).toEqual(draft.settings);
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: "0".repeat(64) })).rejects.toThrow("preview changed");
  const published = await requestDeskPublication(project, key,
    { kind: "submit", id, settings: draft.settings, digest: draft.digest }, confirmFixture);
  expect(published.publishedUrl).toBe("https://github.com/example/project/pull/7#pullrequestreview-23");
  expect(JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8"))).toMatchObject({
    event: "REQUEST_CHANGES", commit_id: revision.headSha, comments: [{ path: "src/a.ts", line: 1, side: "RIGHT" }],
  });
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: draft.digest })).rejects.toThrow("already been published");
  expect(reads("FIXTURE_COMPARE_READS")).toBe("");
});

test("partial approval, a changed base and a closed pull request cannot send a review", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, verdictOverride: "suggestions" as const, answers: { "fixture#F-002": "uphold" as const } };
  const approval = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(approval.body).toContain("A label is ambiguous");
  expect(approval.blockedReason).toContain("cannot approve");
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: approval.settings, digest: approval.digest }))
    .rejects.toThrow("cannot approve");
  for (const pull of [{ baseRefOid: "e".repeat(40), headRefOid: movedHead }, { state: "CLOSED", headRefOid: movedHead }, { state: "CLOSED" }]) {
    setPull(pull);
    const stale = await requestDeskPublication(project, key, { kind: "save", id, settings: { ...settings, verdictOverride: "comment" } });
    expect(stale.savedAt).toBeDefined();
    expect(stale.headMoved).toBeUndefined();
    expect(stale.blockedReason).toContain("revision moved");
    await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: stale.settings, digest: stale.digest }, confirmFixture))
      .rejects.toThrow("revision moved");
  }
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
});

test("a moved head publishes as is: a Comment on the reviewed commit whose first line names it", async () => {
  setHead(movedHead);
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.headMoved).toEqual({ reviewedHead: revision.headSha, currentHead: movedHead });
  expect(preview.settings).toMatchObject({ verdict: "comment", verdictOverride: "comment", inline: false });
  expect(preview.body.split("\n")[0]).toBe(movedLine);
  expect(preview.blockedReason).toContain("Answer each finding question");
  const answered = await requestDeskPublication(project, key, { kind: "preview", id,
    settings: { ...preview.settings, answers: { "fixture#F-002": "dismiss" } } });
  expect(answered.canSubmit).toBe(true);
  expect(answered.blockedReason).toBeUndefined();
  const published = await requestDeskPublication(project, key,
    { kind: "submit", id, settings: answered.settings, digest: answered.digest }, confirmFixture);
  expect(published.publishedUrl).toContain("#pullrequestreview-23");
  const sent = posted();
  expect(sent).toMatchObject({ event: "COMMENT", commit_id: revision.headSha, comments: [] });
  expect(sent.body.split("\n")[0]).toBe(movedLine);
  expect(reads("FIXTURE_COMPARE_READS").split("\n")[0])
    .toBe(`repos/${key.repo}/compare/${revision.headSha}...${movedHead}?per_page=1 --jq .status`);
});

test("a head that no longer contains the reviewed commit keeps the refusal and posts nothing", async () => {
  setHead(movedHead);
  const settings = { inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment" as const,
    verdictOverride: "comment" as const, answers: { "fixture#F-002": "dismiss" as const } };
  // A force-push or rebase (diverged), an older head (behind), and a compare call that fails for any reason.
  const statuses = ["diverged", "behind", "fail:HTTP 404: Not Found", "fail:connection reset"];
  for (const status of statuses) {
    setCompare(status);
    // Each status is really previewed: a refresh asks GitHub again instead of reusing the previous definitive answer.
    const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings, refresh: true });
    expect(preview.headMoved).toBeUndefined();
    expect(preview.body).not.toContain("Reviewed commit");
    expect(preview.blockedReason).toBe("The pull request is closed or its revision moved. You can still save this draft locally.");
    await expect(requestDeskPublication(project, key, { kind: "submit", id, settings, digest: preview.digest }, confirmFixture))
      .rejects.toThrow("revision moved");
  }
  // One compare per previewed status, plus one per refused submit whose cached answer was a failure (not cached).
  expect(reads("FIXTURE_COMPARE_READS").trim().split("\n").length).toBeGreaterThanOrEqual(statuses.length);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
});

test("a current head that is not a commit id keeps the refusal without asking GitHub to compare", async () => {
  setHead("not-a-commit");
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.headMoved).toBeUndefined();
  expect(preview.blockedReason).toContain("revision moved");
  expect(reads("FIXTURE_COMPARE_READS")).toBe("");
});

test("a moved head with General comment off names the only control that can unblock it", async () => {
  setHead(movedHead);
  const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: { inline: true, general: false,
    keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: "comment", answers: { "fixture#F-002": "dismiss" } } });
  expect(preview.headMoved).toBeDefined();
  expect(preview.blockedReason).toBe("Enable General comment. Inline comments are not available when publishing for an earlier commit.");
});

test("a moved head re-reads the discussion an overlay requires, and a changed discussion makes the submit stale", async () => {
  installDiscussionOverlay();
  setHead(movedHead);
  const settings = { inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment" as const,
    verdictOverride: "comment" as const, answers: { "fixture#F-002": "dismiss" as const } };
  const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(preview.headMoved).toBeDefined();
  expect(preview.canSubmit).toBe(true);
  expect(reads("FIXTURE_DISCUSSION_READS")).toBe("xxx");
  writeFileSync(process.env.FIXTURE_DISCUSSION!, '[[{"id":1,"body":"A new comment"}]]\n');
  // Changed before the submit: the submit's own render differs from the preview, so the digest refuses it.
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings, digest: preview.digest }, confirmFixture))
    .rejects.toThrow("stale: The review preview changed");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
});

test("a discussion that changes while the operator confirms is caught by the write-time re-read", async () => {
  installDiscussionOverlay();
  setHead(movedHead);
  const settings = { inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment" as const,
    verdictOverride: "comment" as const, answers: { "fixture#F-002": "dismiss" as const } };
  const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(preview.canSubmit).toBe(true);
  const confirmWhileSomeoneComments = async () => {
    writeFileSync(process.env.FIXTURE_DISCUSSION!, '[[{"id":2,"body":"Posted during confirmation"}]]\n');
  };
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings, digest: preview.digest }, confirmWhileSomeoneComments))
    .rejects.toThrow("stale: The pull request discussion changed");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  expect(existsSync(path.join(directory, "publication-receipt.json"))).toBe(false);
});

test("a review GitHub rejects with HTTP 422 is reported with the verdict hint and stays retryable", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id,
    settings: { inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "changes", verdictOverride: "changes",
      answers: { "fixture#F-002": "dismiss" } } });
  expect(preview.canSubmit).toBe(true);
  process.env.FIXTURE_POST_FAIL = "gh: Unprocessable Entity (HTTP 422)";
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: preview.settings, digest: preview.digest }, confirmFixture))
    .rejects.toThrow("configuration: GitHub rejected this review. Check the verdict and inline comments.");
  expect(existsSync(path.join(directory, "publication-receipt.json"))).toBe(false);
});

test("a moved head ignores a requested verdict and inline comments", async () => {
  setHead(movedHead);
  const settings = { inline: true, general: true, keryxTemplate: true, overlay: true, verdict: "changes" as const,
    verdictOverride: "changes" as const, answers: { "fixture#F-002": "uphold" as const } };
  const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(preview.settings).toMatchObject({ verdict: "comment", verdictOverride: "comment", inline: false });
  expect(preview.inlineCount).toBe(0);
  expect(existsSync(process.env.FIXTURE_DIFF_READS!)).toBe(false);
  await requestDeskPublication(project, key, { kind: "submit", id, settings, digest: preview.digest }, confirmFixture);
  expect(posted()).toMatchObject({ event: "COMMENT", commit_id: revision.headSha, comments: [] });
});

test("a head that moves again after the preview or before the write posts nothing", async () => {
  setHead(movedHead);
  const first = await requestDeskPublication(project, key, { kind: "preview", id });
  const preview = await requestDeskPublication(project, key, { kind: "preview", id,
    settings: { ...first.settings, answers: { "fixture#F-002": "dismiss" } } });
  expect(preview.canSubmit).toBe(true);
  const submit = { kind: "submit" as const, id, settings: preview.settings, digest: preview.digest };
  setHead("d".repeat(40));
  await expect(requestDeskPublication(project, key, submit, confirmFixture)).rejects.toThrow(/^stale:/);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  setHead(movedHead);
  await expect(requestDeskPublication(project, key, submit, async () => setHead("d".repeat(40)))).rejects.toThrow(/^stale:/);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  expect(existsSync(path.join(directory, "publication-receipt.json"))).toBe(false);
});

/** A completed auto-publish attempt with a complete package, so only the head decides whether it posts. */
async function automaticRun(): Promise<string> {
  const store = new DeskRunStore();
  let auto: string;
  let autoDirectory: string;
  try {
    auto = store.requestAttempt(project, key, revision, undefined, { mode: "auto", adaptive: false, autoPublish: true,
      modelPools: { strong: [], middle: [], light: [] } })!.id;
    store.end(store.byId(auto)!, { state: "completed", phase: "Complete", reason: "",
      result: { reviewed: revision, coverage: "complete", verdict: "COMMENT", findings: { blocker: 0, major: 1, minor: 0, info: 0 },
        report: "Fixture review." } });
    autoDirectory = store.directory(auto);
  } finally {
    store.close();
  }
  cpSync(path.join(directory, "package"), path.join(autoDirectory, "package"), { recursive: true });
  const findingsFile = path.join(autoDirectory, "package", "findings.json");
  json(findingsFile, JSON.parse(readFileSync(findingsFile, "utf8")).slice(0, 1));
  // A complete package needs coverage.md for readiness; without it automatic publication is refused at any head.
  writeFileSync(path.join(autoDirectory, "package", "coverage.md"), "# Coverage\n");
  json(path.join(autoDirectory, DESK_TEMPLATE_SELECTION), reportTemplateFingerprint((await projectReviewOverlay(project)).overlay));
  return auto;
}

/** A Keryx slots overlay whose instructions require re-reading the PR discussion before posting. */
function installDiscussionOverlay() {
  const templates = path.join(project, ".metaproject", "skills", "gdskills", "review", "review-orchestrator", "templates");
  mkdirSync(templates, { recursive: true });
  writeFileSync(path.join(templates, "review-report.md"), "# Review\n\n<!-- slot:how-run -->\n");
  const overlay = path.join(project, ".metaproject", "project-skills", "orchestration", "fixture-overlay", "templates");
  mkdirSync(overlay, { recursive: true });
  writeFileSync(path.join(overlay, "report-overlay.md"), [
    "```yaml", "extends: review-orchestrator", "overlay: fixture-overlay", "slots: [how-run]", "reread_discussion: true", "```",
    "", "## slot: how-run", "", "Fixture run notes.", "",
  ].join("\n"));
}

test("automatic publication posts at the reviewed head and never after the head moved", async () => {
  const auto = await automaticRun();
  setHead(movedHead);
  await expect(publishCompletedDeskReview(project, key, auto)).rejects.toThrow("publication decision in Desktop");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  setHead(revision.headSha);
  await publishCompletedDeskReview(project, key, auto);
  expect(posted()).toMatchObject({ event: "COMMENT", commit_id: revision.headSha });
});

test("automatic publication after the head moved refuses before any compare or discussion read", async () => {
  installDiscussionOverlay();
  const auto = await automaticRun();
  setHead(movedHead);
  await expect(publishCompletedDeskReview(project, key, auto)).rejects.toThrow("publication decision in Desktop");
  expect(reads("FIXTURE_COMPARE_READS")).toBe("");
  expect(reads("FIXTURE_DISCUSSION_READS")).toBe("");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
});

test("uses the standard report when a project overlay is invalid", async () => {
  writeFileSync(path.join(project, ".metaproject", "review-publish-template.md"), "## No insertion point");
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.body).toStartWith("**Changes requested — 1 Major.**");
  expect(preview.body).not.toContain("No insertion point");
  expect(preview.settings).toMatchObject({ keryxTemplate: true, overlay: false });
  expect(preview.overlayWarning).toContain("{{review}}");
});

test("editing answers recomputes an automatic verdict and preserves only an explicit override", async () => {
  const findingsFile = path.join(directory, "package", "findings.json");
  const [, held] = JSON.parse(readFileSync(findingsFile, "utf8"));
  json(findingsFile, [{ ...held, severity: "major" }]);
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.settings.verdict).toBe("comment");
  const settings = { ...preview.settings, answers: { "fixture#F-002": "uphold" as const } };
  const automatic = await requestDeskPublication(project, key, { kind: "save", id, settings });
  expect(automatic.settings.verdict).toBe("changes");
  expect((await requestDeskPublication(project, key, { kind: "preview", id })).settings.verdictOverride).toBeNull();
  await requestDeskPublication(project, key, { kind: "save", id, settings: { ...settings, verdictOverride: "comment" } });
  expect((await requestDeskPublication(project, key, { kind: "preview", id })).settings.verdict).toBe("comment");
});

test("local answers reopen without storing rendered GitHub content", async () => {
  const findingsFile = path.join(directory, "package", "findings.json");
  const [, held] = JSON.parse(readFileSync(findingsFile, "utf8"));
  json(findingsFile, Array.from({ length: 105 }, (_, index) =>
    ({ ...held, id: `F-${index}`, global_id: `fixture#F-${index}` })));
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(preview.questions).toHaveLength(105);
  const answers = Object.fromEntries(preview.questions.map(question => [question.id, "dismiss" as const]));
  await requestDeskPublication(project, key, { kind: "save", id, settings: { ...preview.settings, answers } });
  const savedDraft = JSON.parse(readFileSync(path.join(directory, "publication-draft.json"), "utf8"));
  expect(Object.keys(savedDraft).sort()).toEqual(["savedAt", "settings"]);
  expect((await requestDeskPublication(project, key, { kind: "preview", id })).settings.answers).toEqual(answers);
});

/** Round 2 of the same Review on `movedHead`: its package holds F-002 again plus a new held finding F-003. */
function updateRound(): { next: string; nextDirectory: string } {
  const moved = { baseSha: revision.baseSha, headSha: movedHead };
  const store = new DeskRunStore();
  let next: string;
  let nextDirectory: string;
  try {
    next = store.request(project, key, moved)!;
    store.end(store.byId(next)!, { state: "partial", phase: "Partial", reason: "Partial fixture",
      result: { reviewed: moved, coverage: "partial", verdict: "REQUEST_CHANGES",
        findings: { blocker: 0, major: 1, minor: 2, info: 0 }, report: "Fixture review." } });
    expect(store.byId(next)!.run.previousRunId).toBe(id);
    nextDirectory = store.directory(next);
  } finally {
    store.close();
  }
  cpSync(path.join(directory, "package"), path.join(nextDirectory, "package"), { recursive: true });
  json(path.join(nextDirectory, "package", "manifest.json"), {
    reviewId: "fixture-round", status: "closed",
    target: { kind: "pr", ref: "https://github.com/example/project/pull/7", base: moved.baseSha, head: moved.headSha },
    artifacts: {}, coverage: [],
  });
  const findingsFile = path.join(nextDirectory, "package", "findings.json");
  json(findingsFile, [...JSON.parse(readFileSync(findingsFile, "utf8")),
    { id: "F-003", global_id: "fixture#F-003", severity: "minor", reviewer: "review-logic", problem: "A new name is unclear.",
      premise: { verdict: "challenged", question: "Is the new name intentional?" } }]);
  setHead(movedHead);
  return { next, nextDirectory };
}

test("an update round pre-selects the previous round's answers by finding id, and its own draft wins", async () => {
  // Round 1's draft: an answer for F-002, an answer for a finding round 2 does not have, and settings that must not carry.
  json(path.join(directory, "publication-draft.json"), { savedAt: "2026-11-24T00:00:00.000Z", settings: {
    inline: true, general: false, keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: "comment",
    answers: { "fixture#F-002": "dismiss", "fixture#F-404": "uphold" } } });
  const { next, nextDirectory } = updateRound();
  const preview = await requestDeskPublication(project, key, { kind: "preview", id: next });
  expect(preview.headMoved).toBeUndefined();
  expect(preview.questions.map(question => question.id)).toEqual(["fixture#F-002", "fixture#F-003"]);
  expect(preview.settings.answers).toEqual({ "fixture#F-002": "dismiss" });
  expect(preview.settings).toMatchObject({ inline: false, general: true, verdictOverride: null });
  expect(preview.blockedReason).toContain("Answer each finding question");
  expect(existsSync(path.join(nextDirectory, "publication-draft.json"))).toBe(false);

  await requestDeskPublication(project, key, { kind: "save", id: next,
    settings: { ...preview.settings, answers: { "fixture#F-002": "uphold" } } });
  const reopened = await requestDeskPublication(project, key, { kind: "preview", id: next });
  expect(reopened.settings.answers).toEqual({ "fixture#F-002": "uphold" });
});

test("an update round carries only answers that are valid for its own questions", async () => {
  json(path.join(directory, "publication-draft.json"), { savedAt: "2026-11-24T00:00:00.000Z", settings: {
    inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: null,
    answers: { "fixture#F-002": "option:not-an-option-here", "fixture#F-003": "dismiss" } } });
  const { next } = updateRound();
  const preview = await requestDeskPublication(project, key, { kind: "preview", id: next });
  // F-003 was not a question in round 1, but an answer under its id is still that finding's answer.
  expect(preview.settings.answers).toEqual({ "fixture#F-003": "dismiss" });
});

const roundOneDraft = (answers: Record<string, string>) => json(path.join(directory, "publication-draft.json"), {
  savedAt: "2026-11-24T00:00:00.000Z", settings: { inline: false, general: true, keryxTemplate: true, overlay: true,
    verdict: "comment", verdictOverride: null, answers } });

/** A finished partial attempt for `forKey` at `head`, with round 1's package copied in; returns its id and directory. */
function finishedAttempt(forKey: typeof key, head: string): { attemptId: string; attemptDirectory: string } {
  const range = { baseSha: revision.baseSha, headSha: head };
  const store = new DeskRunStore();
  try {
    const attemptId = store.request(project, forKey, range)!;
    store.end(store.byId(attemptId)!, { state: "partial", phase: "Partial", reason: "Partial fixture",
      result: { reviewed: range, coverage: "partial", verdict: "REQUEST_CHANGES",
        findings: { blocker: 0, major: 1, minor: 1, info: 0 }, report: "Fixture review." } });
    const attemptDirectory = store.directory(attemptId);
    cpSync(path.join(directory, "package"), path.join(attemptDirectory, "package"), { recursive: true });
    json(path.join(attemptDirectory, "package", "manifest.json"), { reviewId: "fixture-round", status: "closed",
      target: { kind: "pr", ref: `https://github.com/example/project/pull/${forKey.number}`, base: range.baseSha, head },
      artifacts: {}, coverage: [] });
    return { attemptId, attemptDirectory };
  } finally {
    store.close();
  }
}

test("T14: answers come from the newest earlier round that saved a draft, walking past one without", async () => {
  roundOneDraft({ "fixture#F-002": "dismiss" });
  const round2 = finishedAttempt(key, movedHead);
  const round3 = finishedAttempt(key, "d".repeat(40));
  setHead("d".repeat(40));
  expect(existsSync(path.join(round2.attemptDirectory, "publication-draft.json"))).toBe(false);
  const preview = await requestDeskPublication(project, key, { kind: "preview", id: round3.attemptId });
  expect(preview.settings.answers).toEqual({ "fixture#F-002": "dismiss" });
  // Once round 2 saves a draft of its own, round 3 takes that newer one.
  json(path.join(round2.attemptDirectory, "publication-draft.json"), { savedAt: "2026-11-24T00:00:00.000Z", settings: {
    inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: null,
    answers: { "fixture#F-002": "uphold" } } });
  expect((await requestDeskPublication(project, key, { kind: "preview", id: round3.attemptId })).settings.answers)
    .toEqual({ "fixture#F-002": "uphold" });
});

test("T14: an attempt of another account or pull request never lends its answers", async () => {
  // Positive control: the same Review's round 1 answers "uphold"; the newer foreign drafts below answer "dismiss".
  roundOneDraft({ "fixture#F-002": "uphold" });
  for (const other of [{ ...key, viewer: "other-reviewer" }, { ...key, number: 8 }]) {
    const foreign = finishedAttempt(other, revision.headSha);
    json(path.join(foreign.attemptDirectory, "publication-draft.json"), { savedAt: "2026-11-24T00:00:00.000Z", settings: {
      inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: null,
      answers: { "fixture#F-002": "dismiss" } } });
  }
  const { next } = updateRound();
  expect((await requestDeskPublication(project, key, { kind: "preview", id: next })).settings.answers).toEqual({ "fixture#F-002": "uphold" });
});

test("T14 B2: an archived earlier round's draft answers are not carried", async () => {
  roundOneDraft({ "fixture#F-002": "dismiss" });
  const { next } = updateRound();
  const store = new DeskRunStore();
  try {
    const first = store.byId(id)!;
    first.run.decision = { action: "archive", reason: "Withdrawn", at: "2026-11-24T01:00:00.000Z" };
    store.save(first);
  } finally {
    store.close();
  }
  const preview = await requestDeskPublication(project, key, { kind: "preview", id: next });
  expect(preview.settings.answers).toEqual({});
});

test("T14 B2: a retry within the same round does not take answers from its own round", async () => {
  roundOneDraft({ "fixture#F-002": "dismiss" });
  const store = new DeskRunStore();
  let retry: string;
  let retryDirectory: string;
  try {
    retry = store.request(project, key, revision)!;
    expect(retry).not.toBe(id);
    store.end(store.byId(retry)!, { state: "partial", phase: "Partial", reason: "Partial fixture",
      result: { reviewed: revision, coverage: "partial", verdict: "REQUEST_CHANGES",
        findings: { blocker: 0, major: 1, minor: 1, info: 0 }, report: "Fixture review." } });
    expect(store.byId(retry)!.run).toMatchObject({ previousRunId: id, round: store.byId(id)!.run.round });
    retryDirectory = store.directory(retry);
  } finally {
    store.close();
  }
  cpSync(path.join(directory, "package"), path.join(retryDirectory, "package"), { recursive: true });
  const preview = await requestDeskPublication(project, key, { kind: "preview", id: retry });
  expect(preview.settings.answers).toEqual({});
});

test("T14 B5: a definitive diverged head is compared once per current head; a failed compare is asked again", async () => {
  setHead(movedHead);
  setCompare("diverged");
  for (let i = 0; i < 2; i++) expect((await requestDeskPublication(project, key, { kind: "preview", id })).headMoved).toBeUndefined();
  expect(reads("FIXTURE_COMPARE_READS").trim().split("\n")).toHaveLength(1);
  // An explicit refresh asks GitHub again.
  await requestDeskPublication(project, key, { kind: "preview", id, refresh: true });
  expect(reads("FIXTURE_COMPARE_READS").trim().split("\n")).toHaveLength(2);
  rmSync(path.join(directory, "publication-preview-cache.json"));
  rmSync(process.env.FIXTURE_COMPARE_READS!);
  setCompare("fail:connection reset");
  for (let i = 0; i < 2; i++) expect((await requestDeskPublication(project, key, { kind: "preview", id })).headMoved).toBeUndefined();
  expect(reads("FIXTURE_COMPARE_READS").trim().split("\n")).toHaveLength(2);
});

test("T14 B6: an attempt superseded by a newer round of its Review is not offered as is", async () => {
  updateRound();
  const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: { inline: false, general: true,
    keryxTemplate: true, overlay: true, verdict: "comment", verdictOverride: "comment", answers: { "fixture#F-002": "dismiss" } } });
  expect(preview.headMoved).toBeUndefined();
  expect(preview.canSubmit).toBe(false);
  expect(preview.blockedReason).toBe("Round 2 of this review is newer. Publish from that round. You can still save this draft locally.");
  expect(reads("FIXTURE_COMPARE_READS")).toBe("");
});

const answeredComment = { inline: false, general: true, keryxTemplate: true, overlay: true, verdict: "comment" as const,
  verdictOverride: "comment" as const, answers: { "fixture#F-002": "dismiss" as const } };

/** Round 2 of the same Review on `movedHead`, left in `state` (queued when only requested). */
function newerRound(state: "queued" | "failed" | "cancelled"): string {
  const store = new DeskRunStore();
  try {
    const next = store.request(project, key, { baseSha: revision.baseSha, headSha: movedHead })!;
    if (state !== "queued") store.end(store.byId(next)!, { state, phase: state, reason: "Fixture", result: null });
    expect(store.byId(next)!.run.round).toBe(2);
    return next;
  } finally {
    store.close();
  }
}

test("T16 B1: the superseded reason says what the newer round can do", async () => {
  setHead(movedHead);
  newerRound("queued");
  const running = await requestDeskPublication(project, key, { kind: "preview", id, settings: answeredComment });
  expect(running.blockedReason).toBe("Round 2 of this review is still running. Publish from it when it finishes. You can still save this draft locally.");
  expect(running.headMoved).toBeUndefined();
});

test("T16 B1: a newer round that failed or was cancelled has no result to publish from", async () => {
  setHead(movedHead);
  for (const state of ["failed", "cancelled"] as const) {
    const store = new DeskRunStore();
    try {
      for (const row of store.history(key).runs) {
        const attempt = store.byId(row.id)!;
        if (attempt.run.round === 2) { attempt.run.decision = { action: "delete", reason: "reset", at: "2026-11-24T01:00:00.000Z" }; store.save(attempt); }
      }
    } finally {
      store.close();
    }
    newerRound(state);
    const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: answeredComment });
    expect(preview.blockedReason).toBe("Round 2 of this review is newer but has no result. Start a new round or save this draft locally.");
    expect(preview.canSubmit).toBe(false);
  }
});

for (const action of ["archive", "delete"] as const) {
  test(`T16 B1: a newer round withdrawn by ${action} no longer supersedes the round before it`, async () => {
    const { next } = updateRound();
    const store = new DeskRunStore();
    try {
      const newer = store.byId(next)!;
      newer.run.decision = { action, reason: "Withdrawn", at: "2026-11-24T01:00:00.000Z" };
      store.save(newer);
    } finally {
      store.close();
    }
    const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: answeredComment });
    expect(preview.blockedReason).toBeUndefined();
    expect(preview.headMoved).toEqual({ reviewedHead: revision.headSha, currentHead: movedHead });
  });
}

test("T16 B2: a superseded attempt on a closed pull request or a changed base gets the closed or moved reason", async () => {
  updateRound();
  for (const pull of [{ state: "CLOSED", headRefOid: movedHead }, { baseRefOid: "e".repeat(40), headRefOid: movedHead }]) {
    setPull(pull);
    const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: answeredComment, refresh: true });
    expect(preview.blockedReason).toBe("The pull request is closed or its revision moved. You can still save this draft locally.");
  }
});

test("T16: a compare status GitHub does not define is neither trusted nor cached", async () => {
  setHead(movedHead);
  setCompare("unexpected-status");
  for (let i = 0; i < 2; i++) {
    const preview = await requestDeskPublication(project, key, { kind: "preview", id, settings: answeredComment });
    expect(preview.headMoved).toBeUndefined();
    expect(preview.blockedReason).toBe("The pull request is closed or its revision moved. You can still save this draft locally.");
  }
  expect(reads("FIXTURE_COMPARE_READS").trim().split("\n")).toHaveLength(2);
});

test("inline edits reuse placement in preview and explicit refresh rereads the diff", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, inline: true };
  const inline = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(inline.inlineComments).toMatchObject([{ path: "src/a.ts", line: 1, body: expect.stringContaining("Open rows") }]);
  await requestDeskPublication(project, key, { kind: "preview", id, settings: { ...settings, general: false } });
  expect(readFileSync(process.env.FIXTURE_DIFF_READS!, "utf8")).toBe("x");
  await requestDeskPublication(project, key, { kind: "preview", id, settings, refresh: true });
  expect(readFileSync(process.env.FIXTURE_DIFF_READS!, "utf8")).toBe("xx");
});

test("skipping a completed review clears the publication decision without writing to GitHub", async () => {
  const store = new DeskRunStore();
  try {
    const attempt = store.byId(id)!;
    const result = attempt.run.result!;
    store.end(attempt, { state: "completed", phase: "Complete", reason: "", result: { ...result, coverage: "complete" } });
    expect(store.history(key, id).runs[0]?.publication).toBe("pending");
    const skipped = await requestDeskPublication(project, key, { kind: "skip", id });
    expect(skipped.skipped).toBe(true);
    expect(store.history(key, id).runs[0]?.publication).toBe("skipped");
    expect((await requestDeskPublication(project, key, { kind: "preview", id })).skipped).toBe(true);
    await expect(publishCompletedDeskReview(project, key, id)).rejects.toThrow("verified local review");
    expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  } finally {
    store.close();
  }
});

test("a changed effective account or declined confirmation never reaches the write", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, answers: { "fixture#F-002": "dismiss" as const } };
  const reviewed = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  const submit = { kind: "submit" as const, id, settings: reviewed.settings, digest: reviewed.digest };
  await expect(requestDeskPublication(project, key, submit)).rejects.toThrow("Confirm the exact review");
  await expect(requestDeskPublication(project, key, submit, async () => { throw new Error("Declined fixture"); }))
    .rejects.toThrow("Declined fixture");
  process.env.FIXTURE_NAMED_PR = path.join(root, "named-pr.json");
  writeFileSync(process.env.FIXTURE_NAMED_PR, readFileSync(process.env.FIXTURE_PR!));
  setHead(revision.headSha, "new-fixture-reviewer");
  await expect(requestDeskPublication(project, key, submit)).rejects.toThrow("account or repository changed");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  expect(existsSync(path.join(directory, "publication-receipt.json"))).toBe(false);
});

test("a known CLI startup failure leaves the submission retryable", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, answers: { "fixture#F-002": "dismiss" as const } };
  const confirmed = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  const submit = { kind: "submit" as const, id, settings: confirmed.settings, digest: confirmed.digest };
  const realSpawn = Bun.spawn;
  const spawn = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const command = args[0];
    if (Array.isArray(command) && command[1] === "api" && command.includes("POST")) {
      throw new Error("Fixture process did not start");
    }
    return Reflect.apply(realSpawn, Bun, args);
  }) as typeof Bun.spawn);
  try {
    await expect(requestDeskPublication(project, key, submit, confirmFixture)).rejects.toThrow("could not start");
    expect(existsSync(path.join(directory, "publication-receipt.json"))).toBe(false);
    expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  } finally {
    spawn.mockRestore();
  }
  expect((await requestDeskPublication(project, key, submit, confirmFixture)).publishedUrl).toContain("#pullrequestreview-23");
});

test("a concrete report option is saved by identity and published with the finding", async () => {
  const findingsFile = path.join(directory, "package", "findings.json");
  const findings = JSON.parse(readFileSync(findingsFile, "utf8"));
  const options = ["Rename the label.", "Keep the label and add help text."];
  const writeOptions = (labels: string[]) => {
    findings[1].premise = { verdict: "owner-decision", question: "How should we clarify the label?", options: labels };
    json(findingsFile, findings);
  };
  writeOptions(options);

  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const question = preview.questions[0]!;
  expect(question.options?.map(option => option.label)).toEqual(options);
  expect(question.recommendation).toBeUndefined();
  const invalid = await requestDeskPublication(project, key, { kind: "preview", id,
    settings: { ...preview.settings, answers: { [question.id]: "uphold" } } });
  expect(invalid.settings.answers).toEqual({});
  expect(invalid.canSubmit).toBe(false);

  const selected = question.options![1]!;
  const draft = await requestDeskPublication(project, key, { kind: "save", id,
    settings: { ...preview.settings, answers: { [question.id]: selected.id } } });
  expect(draft.body).toContain(`**Selected answer:** ${selected.label}`);
  expect(draft.body).not.toContain(options[0]!);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);

  writeOptions([options[0]!]);
  const removed = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(removed.settings.answers).toEqual({});
  expect(removed.canSubmit).toBe(false);

  writeOptions([...options].reverse());
  const reopened = await requestDeskPublication(project, key, { kind: "preview", id });
  expect(reopened.settings.answers[question.id]).toBe(selected.id);
  expect(reopened.canSubmit).toBe(true);
  await requestDeskPublication(project, key,
    { kind: "submit", id, settings: reopened.settings, digest: reopened.digest }, confirmFixture);
  expect(JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8")).body).toContain(`**Selected answer:** ${selected.label}`);
});
