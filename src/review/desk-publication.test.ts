import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestDeskPublication } from "./desk-publication";
import { DeskRunStore } from "./desk-run-store";
import { isolateGitDiscovery } from "./test-git-fixture";

const key = { repo: "example/project", repositoryId: "fixture-repo-id", viewer: "fixture-reviewer", number: 7 };
const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
const envNames = ["KERYX_CONFIG_DIR", "KERYX_DATA_DIR", "PATH", "GH_TOKEN", "GITHUB_TOKEN",
  "FIXTURE_BODY", "FIXTURE_PR", "FIXTURE_NAMED_PR", "FIXTURE_DIFF", "FIXTURE_DIFF_READS"] as const;
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

function setHead(headRefOid: string, viewer = key.viewer) {
  json(path.join(root, "pr.json"), { data: { viewer: { login: viewer }, repository: { id: key.repositoryId,
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
  process.env.FIXTURE_DIFF_READS = path.join(root, "diff-reads");
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.FIXTURE_NAMED_PR;
  setHead(revision.headSha);
  writeFileSync(process.env.FIXTURE_DIFF, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  const gh = path.join(root, "gh");
  writeFileSync(gh, [
    "#!/bin/sh",
    'case "$1:$4" in',
    "  auth:*) printf 'fixture-value-only\\n' ;;",
    '  api:graphql) if [ -n "$GH_TOKEN" ] && [ -n "$FIXTURE_NAMED_PR" ]; then cat "$FIXTURE_NAMED_PR"; else cat "$FIXTURE_PR"; fi ;;',
    '  api:-H) printf x >> "$FIXTURE_DIFF_READS"; cat "$FIXTURE_DIFF" ;;',
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
  const published = await requestDeskPublication(project, key,
    { kind: "submit", id, settings: draft.settings, digest: draft.digest }, confirmFixture);
  expect(published.publishedUrl).toBe("https://github.com/example/project/pull/7#pullrequestreview-23");
  expect(JSON.parse(readFileSync(process.env.FIXTURE_BODY!, "utf8"))).toMatchObject({
    event: "REQUEST_CHANGES", commit_id: revision.headSha, comments: [{ path: "src/a.ts", line: 1, side: "RIGHT" }],
  });
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: draft.settings, digest: draft.digest })).rejects.toThrow("already been published");
});

test("partial approval and a moved revision cannot send a review", async () => {
  const preview = await requestDeskPublication(project, key, { kind: "preview", id });
  const settings = { ...preview.settings, verdictOverride: "suggestions" as const, answers: { "fixture#F-002": "uphold" as const } };
  const approval = await requestDeskPublication(project, key, { kind: "preview", id, settings });
  expect(approval.body).toContain("A label is ambiguous");
  expect(approval.blockedReason).toContain("cannot approve");
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: approval.settings, digest: approval.digest }))
    .rejects.toThrow("cannot approve");
  setHead("c".repeat(40));
  const stale = await requestDeskPublication(project, key, { kind: "save", id, settings: { ...settings, verdictOverride: "comment" } });
  expect(stale.savedAt).toBeDefined();
  expect(stale.blockedReason).toContain("revision moved");
  await expect(requestDeskPublication(project, key, { kind: "submit", id, settings: stale.settings, digest: stale.digest }))
    .rejects.toThrow("revision moved");
  expect(existsSync(process.env.FIXTURE_BODY!)).toBe(false);
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
