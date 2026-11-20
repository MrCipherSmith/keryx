import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeskRunStore } from "./desk-run-store";
import { readExistingReviews } from "./desk-run-legacy";
import { collectPrContext, parseProjectPr, prForFlow, readLinkedFlows } from "./pr-context";
import { fixtureGitEnv, isolateGitDiscovery } from "./test-git-fixture";

const url = "https://github.com/example/project/pull/42";
const key = { repo: "example/project", viewer: "alice", repositoryId: "repo1", number: 42 };
const pr = { title: "feature", state: "OPEN", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
let project: string, wt: string, store: DeskRunStore;
let previousDataDir: string | undefined;
const git = (...cmd: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", project, ...cmd], {
  stdio: "ignore", env: fixtureGitEnv(),
});

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-context-")));
  previousDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = path.join(project, "data");
  wt = project + "-wt";
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
  git("worktree", "add", "--detach", wt);
  store = new DeskRunStore(path.join(project, "db"));
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.KERYX_DATA_DIR;
  else process.env.KERYX_DATA_DIR = previousDataDir;
  store.close(); rmSync(wt, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

function flow(root: string, id: string, link: string, plan: string) {
  const dir = path.join(root, ".metaproject/flows", id + "-feature");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "flow.json"), JSON.stringify({ id, title: "Migrate service", status: "done", pr: { url: link },
    acConfirmed: { AC1: { note: "checked persistence" } }, tasks: [{ id: "T1", evidenceRefs: ["db-test.md"] }] }));
  writeFileSync(path.join(dir, "plan.md"), plan);
  writeFileSync(path.join(dir, "journal.md"), "update\n".repeat(800) + "final migration result");
  return dir;
}
test("links by exact repo and PR across the primary and current checkout, with canonical evidence and bounded excerpts", async () => {
  flow(project, "001", url.toUpperCase() + "/", "the primary plan");
  flow(wt, "001", url, "old plan");
  flow(wt, "002", url, "worktree plan");
  flow(project, "003", url.replace("example", "other"), "unrelated");
  flow(wt, "004", url + "0", "unrelated");
  expect(await prForFlow(wt, "1")).toEqual({ repo: key.repo, number: key.number });
  const data = await collectPrContext(wt, key, pr, store);
  expect(data.totalFlows).toBe(2);
  expect(data.flows[0]?.documents["plan.md"]).toBe("the primary plan");
  expect(data.flows[0]?.documents["journal.md"]).toEndWith("final migration result");
  expect(data.flows[0]?.documents.evidence).toContain("T1: db-test.md");
  expect(data.flows[1]?.checkout).toBe("worktree");
  const matches = await readLinkedFlows(wt, key.repo, 42, "persistence");
  expect(Object.keys(matches.flows[0]!.documents)).toEqual(["evidence"]);
});

test("reads PR context from the requested checkout rather than an inherited Git directory", async () => {
  const other = path.join(project, "unrelated-repo");
  execFileSync("git", ["init", "-q", other], { env: fixtureGitEnv() });
  flow(other, "001", url, "unrelated project evidence");
  flow(project, "001", url, "requested project evidence");
  flow(wt, "002", url, "requested worktree evidence");
  const restore = isolateGitDiscovery();
  try {
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    const result = await readLinkedFlows(wt, key.repo, key.number);
    expect(result.flows.map(item => item.documents["plan.md"])).toEqual([
      "requested project evidence", "requested worktree evidence",
    ]);
  } finally {
    restore();
  }
});
test("standalone PR context retains the fixed target and only the authenticated viewer's run history", async () => {
  store.request(wt, key, { headSha: pr.headRefOid, baseSha: pr.baseRefOid });
  store.request(wt, { ...key, repositoryId: "other" }, { headSha: "private", baseSha: "private" });
  const data = await collectPrContext(wt, key, pr, store);
  expect(data.flows).toEqual([]);
  expect(data.pr.headSha).toBe(pr.headRefOid);
  expect(data.history).toHaveLength(1);
  expect(data.history[0]?.requested?.headSha).toBe(pr.headRefOid);
  expect(JSON.stringify(data)).not.toContain("private");
  expect((await collectPrContext(wt, { ...key, viewer: "bob" }, pr, store)).history).toEqual([]);
});
test("rejects ambiguous Flow numbers, foreign PR URLs and symlinks to unrelated documents", async () => {
  const dir = flow(project, "001", url, "safe");
  const other = flow(wt, "001", url.replace("example", "other"), "unrelated");
  renameSync(other, path.join(path.dirname(other), "001-other-flow"));
  await expect(prForFlow(wt, "001")).rejects.toThrow("multiple");
  expect(parseProjectPr(url.replace("github.com", "github.com.evil"))).toBeUndefined();
  expect(parseProjectPr(url + "/files")).toBeUndefined();
  writeFileSync(path.join(project, "private.txt"), "private text");
  symlinkSync(path.join(project, "private.txt"), path.join(dir, "tasks.md"));
  const data = await collectPrContext(wt, key, pr, store);
  expect(data.flows[0]?.documents["tasks.md"]).toBeUndefined();
});

test("a standalone review can search previous reports, with reviewed SHA separate from today's head", async () => {
  const earlier = { headSha: "e".repeat(40), baseSha: pr.baseRefOid };
  store.request(wt, key, earlier);
  const attempt = store.queued(key)!;
  store.end(attempt, { state: "completed", phase: "complete", reason: "", result: {
    reviewed: earlier, verdict: "REQUEST_CHANGES", coverage: "complete",
    findings: { blocker: 0, major: 1, minor: 0, info: 0 }, report: "start ".repeat(95_000) + "Verify migration order",
  } });
  const result = await collectPrContext(wt, key, pr, store, "migration");
  expect(result.pr.headSha).toBe(pr.headRefOid);
  expect(result.history[0]?.reviewed).toEqual(earlier);
  expect(result.history[0]?.findings?.major).toBe(1);
  expect(result.history[0]?.report).toContain("Verify migration order");
  expect(result.history[0]!.report.length).toBeLessThan(2300);
  expect((await collectPrContext(wt, key, pr, store, "missing phrase")).history).toEqual([]);
});


test("the Flow link index follows edits, deletions and newly linked manifests across checkouts", async () => {
  const dir = flow(project, "001", url.replace("/42", "/41"), "old");
  flow(wt, "001", url, "worktree");
  expect((await readLinkedFlows(wt, key.repo, 42)).totalFlows).toBe(0);
  flow(project, "001", url, "updated");
  expect((await readLinkedFlows(wt, key.repo, 42)).flows[0]?.documents["plan.md"]).toBe("updated");
  rmSync(dir, { recursive: true });
  expect((await readLinkedFlows(wt, key.repo, 42)).flows[0]?.documents["plan.md"]).toBe("worktree");
});

test("an unlinked primary Flow does not hide the current worktree's explicit PR link", async () => {
  flow(project, "001", "", "primary plan before linking");
  flow(wt, "001", url, "worktree plan after linking");
  expect(await prForFlow(wt, "1")).toEqual({ repo: key.repo, number: key.number });
  for (let pass = 0; pass < 2; pass++) {
    const result = await readLinkedFlows(wt, key.repo, key.number);
    expect(result.totalFlows).toBe(1);
    expect(result.flows[0]).toMatchObject({ checkout: "worktree", documents: { "plan.md": "worktree plan after linking" } });
  }
});

test("Flow journal search finds a match across chunk boundaries beyond its display preview", async () => {
  const dir = flow(project, "001", url, "plan");
  const sentence = "Подтверждённый результат";
  const marker = "a".repeat(10 * 64 * 1024 - 3);
  writeFileSync(path.join(dir, "journal.md"), marker + sentence);
  const result = await readLinkedFlows(wt, key.repo, key.number, "подтверждённый");
  expect(result.flows[0]?.documents["journal.md"]).toContain(sentence);
  expect(result.flows[0]?.documents["journal.md"]?.length).toBeLessThan(2000);
});

test("Flow journal search fills the excerpt beyond the block that ends with the match", async () => {
  const dir = flow(project, "001", url, "plan");
  const heading = "Accepted decision";
  const next = "Use the existing event journal.";
  writeFileSync(path.join(dir, "journal.md"), "x".repeat(64 * 1024 - heading.length) + heading + "\n" + next);
  const result = await readLinkedFlows(wt, key.repo, key.number, heading);
  expect(result.flows[0]?.documents["journal.md"]).toContain(heading + "\n" + next);
});

test("PR context prefers a refreshed local package to an earlier desktop import", async () => {
  const dir = path.join(project, ".metaproject/reviews/retained-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    reviewId: "retained-review", target: { ref: url, base: pr.baseRefOid, head: pr.headRefOid },
  }));
  const file = path.join(dir, "report.md");
  writeFileSync(file, "Original report");
  store.recordExisting(project, key, readExistingReviews(project, key));
  writeFileSync(file, "Corrected report with follow-up");
  const result = await collectPrContext(wt, key, pr, store, "follow-up");
  expect(result.history).toHaveLength(1);
  expect(result.history[0]?.report).toBe("Corrected report with follow-up");
});

test("the evidence preview stays bounded while search reaches later references", async () => {
  const dir = flow(project, "001", url, "plan");
  writeFileSync(path.join(dir, "flow.json"), JSON.stringify({
    id: "001", title: "Reviewed Flow", pr: { url },
    tasks: [{ id: "Task " + "x".repeat(8000), evidenceRefs: [...Array(40).fill("Earlier reference"), "Later reference"] }],
  }));
  const history = await readLinkedFlows(wt, key.repo, key.number);
  expect(history.flows[0]?.documents.evidence?.length).toBeLessThan(1810);
  const match = await readLinkedFlows(wt, key.repo, key.number, "later reference");
  expect(match.flows[0]?.documents.evidence).toContain("Later reference");
});

test("the explicit launch Flow can be unlinked, narrows evidence and must belong to the project", async () => {
  flow(project, "001", url, "implicitly linked");
  flow(project, "008", "", "explicitly selected");
  const result = await collectPrContext(wt, key, pr, store, undefined, "008");
  expect(result.selectedFlowId).toBe("008");
  expect(result.flows.map(f => f.documents["plan.md"])).toEqual(["explicitly selected"]);
  await expect(collectPrContext(wt, key, pr, store, undefined, "404")).rejects.toThrow("Selected Flow");
  flow(wt, "008", url, "linked locally");
  expect(await prForFlow(wt, "8")).toEqual({ repo: key.repo, number: key.number });
});
