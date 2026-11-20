import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestDeskPublication } from "./desk-publication";
import { DeskRunStore } from "./desk-run-store";
import { isolateGitDiscovery } from "./test-git-fixture";

const key = { repo: "example/project", repositoryId: "fixture-repo-id", viewer: "fixture-reviewer", number: 7 };
const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const envNames = ["KERYX_CONFIG_DIR", "KERYX_DATA_DIR", "PATH", "FIXTURE_BODY", "FIXTURE_PR", "FIXTURE_DIFF"] as const;
let saved: Partial<Record<(typeof envNames)[number], string | undefined>>;
let restoreGit: () => void;
let root: string;
let project: string;
let directory: string;
let id: string;

function json(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value));
}

function setHead(headRefOid: string) {
  json(path.join(root, "pr.json"), { data: { viewer: { login: key.viewer }, repository: { id: key.repositoryId,
    pullRequest: { state: "OPEN", baseRefOid: revision.baseSha, headRefOid } } } });
}

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
  setHead(revision.headSha);
  writeFileSync(process.env.FIXTURE_DIFF, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  const gh = path.join(root, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    'case "$1:$4" in',
    "  auth:*) printf 'fixture-value-only\\n' ;;",
    '  api:graphql) cat "$FIXTURE_PR" ;;',
    '  api:-H) cat "$FIXTURE_DIFF" ;;',
    '  api:--method) cat > "$FIXTURE_BODY"; printf \'{"id":23}\\n\' ;;',
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
  writeFileSync(path.join(pkg, "report.md"), "Fixture review.\n\nNot verified: 1\n");
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
  expect(preview.questions).toMatchObject([{ id: "fixture#F-002", text: "Is this label intentional?", recommendation: "dismiss" }]);
  expect(preview.canSubmit).toBe(false);
  expect(preview.overlayAvailable).toBe(true);
  const draft = await requestDeskPublication(project, key, { kind: "save", id,
    settings: { ...preview.settings, inline: true, overlay: true, answers: { "fixture#F-002": "dismiss" } } });
  expect(draft.savedAt).toBeDefined();
  expect(draft.body).toContain("## Team review");
  expect(draft.body).not.toContain("A label is ambiguous");
  expect(draft.inlineCount).toBe(1);
  expect(draft.canSubmit).toBe(true);
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
  expect((await requestDeskPublication(project, key, { kind: "preview", id })).settings).toEqual(draft.settings);
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: "0".repeat(64) })).rejects.toThrow("preview changed");
  const published = await requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: draft.digest });
  expect(published.publishedUrl).toBe("https://github.com/example/project/pull/7#pullrequestreview-23");
  expect(JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8"))).toMatchObject({
    event: "REQUEST_CHANGES", commit_id: revision.headSha, comments: [{ path: "src/a.ts", line: 1, side: "RIGHT" }],
  });
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: draft.digest })).rejects.toThrow("already been published");
});

test("partial approval and a moved revision cannot send a review", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, verdict: "suggestions" as const, answers: { "fixture#F-002": "uphold" as const } };
  const approval = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(approval.body).toContain("A label is ambiguous");
  expect(approval.blockedReason).toContain("cannot approve");
  setHead("c".repeat(40));
  const stale = await requestDeskPublication(project, key, { kind: "save", id, settings: { ...settings, verdict: "comment" } });
  expect(stale.savedAt).toBeDefined();
  expect(stale.blockedReason).toContain("revision moved");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
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
  await requestDeskPublication(project, key, { kind: "submit", id, settings: reopened.settings, digest: reopened.digest });
  expect(JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8")).body).toContain(`**Selected answer:** ${selected.label}`);
});
