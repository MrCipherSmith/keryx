// Flow 451 AC5: the keryx shell refuses a direct GitHub review while a managed review package bound to that PR is not READY.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewPublishAttempts, reviewPublishRefusal } from "./publish-guard";

const PR = "https://github.com/Presight-AI/vantage-frontend/pull/7932";

let root: string;

function makePackage(options: { ready: boolean; pr?: string }): void {
  const pkg = path.join(root, ".metaproject", "reviews", "pr7932-r1");
  mkdirSync(pkg, { recursive: true });
  const write = (name: string, value: unknown): void => writeFileSync(path.join(pkg, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  write("manifest.json", {
    schemaVersion: 1,
    reviewId: "pr7932-r1",
    mode: "review-flow",
    status: "draft",
    target: { kind: "pr", ref: options.pr ?? PR },
    artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
    coverage: [],
  });
  write("findings.json", options.ready ? [] : [{ id: "f-1", severity: "major", title: "unverified claim" }]);
  write("report.md", "# Review\n\nRequest changes.\n");
  write("coverage.md", "# Reviewer Coverage\n\nreviewer: review-logic\nstatus: run\nreason: read the diff\n");
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reviewPublishAttempts", () => {
  test("finds gh pr review in every spelling the shell allows", () => {
    expect(reviewPublishAttempts(`gh pr review 7932 --comment -b "x"`)).toEqual([{ kind: "gh-pr-review", number: 7932 }]);
    expect(reviewPublishAttempts(`gh pr review ${PR} --approve`)).toEqual([{ kind: "gh-pr-review", number: 7932, repo: "Presight-AI/vantage-frontend" }]);
    expect(reviewPublishAttempts(`cd x && gh pr review -R a/b 12 -r -b "x"`)).toEqual([{ kind: "gh-pr-review", number: 12, repo: "a/b" }]);
    expect(reviewPublishAttempts(`bash -c 'gh pr review 5 -c -b hi'`)).toEqual([{ kind: "gh-pr-review", number: 5 }]);
    expect(reviewPublishAttempts(`echo ok | gh pr review 5 -c -F -`)).toEqual([{ kind: "gh-pr-review", number: 5 }]);
  });

  test("finds gh api calls that create a review, and only those", () => {
    expect(reviewPublishAttempts(`gh api repos/a/b/pulls/9/reviews -X POST -f event=COMMENT -f body=hi`)).toEqual([{ kind: "gh-api-review", number: 9, repo: "a/b" }]);
    expect(reviewPublishAttempts(`gh api repos/a/b/pulls/9/reviews -f event=COMMENT`)).toEqual([{ kind: "gh-api-review", number: 9, repo: "a/b" }]);
    expect(reviewPublishAttempts(`gh api --method PUT repos/a/b/pulls/9/reviews/44/events -f event=APPROVE`)).toEqual([{ kind: "gh-api-review", number: 9, repo: "a/b" }]);
    expect(reviewPublishAttempts(`gh api repos/a/b/pulls/9/reviews`)).toEqual([]);
    expect(reviewPublishAttempts(`gh api repos/a/b/pulls/9/reviews -X GET`)).toEqual([]);
    expect(reviewPublishAttempts(`gh api repos/a/b/pulls/9/comments -f body=hi`)).toEqual([]);
  });

  test("ignores other gh commands and text that merely mentions a review", () => {
    expect(reviewPublishAttempts(`gh pr view 7932`)).toEqual([]);
    expect(reviewPublishAttempts(`gh pr checks 7932`)).toEqual([]);
    expect(reviewPublishAttempts(`echo "gh pr review 1"`)).toEqual([]);
    expect(reviewPublishAttempts(`keryx review publish pr7932-r1 --partial`)).toEqual([]);
  });
});

describe("reviewPublishRefusal", () => {
  test("refuses a review of the PR a NOT READY package is bound to, naming keryx review publish", async () => {
    makePackage({ ready: false });
    const refusal = await reviewPublishRefusal(`gh pr review 7932 --comment -b "x"`, root);
    expect(refusal).toContain("pr7932-r1");
    expect(refusal).toContain("NOT READY");
    expect(refusal).toContain("verifier");
    expect(refusal).toContain("keryx review publish pr7932-r1");
    expect(await reviewPublishRefusal(`gh api repos/Presight-AI/vantage-frontend/pulls/7932/reviews -f event=COMMENT`, root)).toContain("keryx review publish");
  });

  test("stays silent for a READY package, another PR, another repository, and a project with no packages", async () => {
    makePackage({ ready: true });
    expect(await reviewPublishRefusal(`gh pr review 7932 --comment -b "x"`, root)).toBeUndefined();
    rmSync(path.join(root, ".metaproject"), { recursive: true, force: true });
    expect(await reviewPublishRefusal(`gh pr review 7932 --comment -b "x"`, root)).toBeUndefined();
    makePackage({ ready: false });
    expect(await reviewPublishRefusal(`gh pr review 7000 --comment -b "x"`, root)).toBeUndefined();
    expect(await reviewPublishRefusal(`gh pr review -R other/repo 7932 --comment -b "x"`, root)).toBeUndefined();
    expect(await reviewPublishRefusal(`gh pr view 7932`, root)).toBeUndefined();
  });
});
