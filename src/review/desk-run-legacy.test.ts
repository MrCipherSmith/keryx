import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readExistingReviews } from "./desk-run-legacy";
import { DeskRunStore } from "./desk-run-store";

test("historical summary, old package and missing evidence stay read-only and scoped", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-legacy-review-"));
  const key = { repo: "org/repo", repositoryId: "node", number: 7, viewer: "me" };
  const ref = "https://github.com/org/repo/pull/7";
  const target = { kind: "pr", ref, repository: key.repo, number: 7, head: "a".repeat(40) };
  const store = new DeskRunStore(path.join(cwd, "state"));
  const write = (rel: string, file: string, data: unknown) => {
    const d = path.join(cwd, ".metaproject", rel);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, file), typeof data === "string" ? data : JSON.stringify(data));
  };
  try {
    write("data/review-autonomous/org-repo-pr7", "summary.json", {
      target,
      reason: "Limited coverage",
      startedAt: "2025-01-01T00:00:00Z",
    });
    write("flows/123-test/reviews/per-flow", "manifest.json", {
      target,
      reviewId: "per-flow",
      status: "closed",
    });
    write("reviews/managed", "manifest.json", { target, reviewId: "managed", status: "closed" });
    write("reviews/managed", "report.md", "A historical finding");
    write("reviews/managed", "findings.json", [{ severity: "major" }]);
    write("reviews/another", "manifest.json", { target: { ...target, ref: ref + "1" }, reviewId: "wrong" });
    symlinkSync(
      path.join(cwd, "state", "runs.sqlite"),
      path.join(cwd, ".metaproject/flows/123-test/reviews/per-flow/report.md"),
    );
    const results = readExistingReviews(cwd, key);
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.result?.report === "A historical finding")?.result).toMatchObject({
      findingsKnown: true,
      findings: { major: 1 },
    });
    expect(results.find((r) => r.result?.report === "")?.result?.findingsKnown).toBe(false);
    expect(results.map((r) => r.result?.report).sort()).toEqual([
      "",
      "A historical finding",
      "Limited coverage",
    ]);
    expect(
      results.every(
        (r) =>
          r.source === "existing" &&
          r.state === "partial" &&
          r.result?.coverage === "unknown" &&
          r.result?.verdict === null,
      ),
    ).toBe(true);
    const usage = { total: { inputTokens: 15, outputTokens: 3, totalTokens: 18 }, coordinator: { inputTokens: 5 },
      reviewers: [{ reviewer: "review-logic", inputTokens: 10, outputTokens: 3 }], partial: true };
    const startedAt = "2025-01-01T00:00:00.000Z", finishedAt = "2025-01-01T00:01:00.000Z";
    const linkedSummary = { target, package: { id: "managed" }, startedAt, finishedAt, usage };
    write("data/review-autonomous/org-repo-pr7", "summary.json", linkedSummary);
    write("reviews/managed", "findings.json", [{ id: "F-1", severity: "major", disposition: { state: "acted-on" } }]);
    const merged = readExistingReviews(cwd, key).find(r => r.result?.report === "A historical finding");
    expect(merged).toMatchObject({ startedAt, finishedAt, usage, state: "partial", result: { findingsKnown: true, findings: { major: 0 } } });
    write("data/review-autonomous/org-repo-pr7", "summary.json", { ...linkedSummary, usage: { total: 12 } });
    expect(readExistingReviews(cwd, key).find(r => r.id === merged?.id)?.usage).toBeUndefined();
    write("data/review-autonomous/org-repo-pr7", "summary.json", { ...linkedSummary, target: { ...target, head: "b".repeat(40) } });
    const distinct = readExistingReviews(cwd, key).find(r => r.id === merged?.id);
    expect(distinct?.usage).toBeUndefined();
    expect(distinct?.startedAt).toBeNull();
    expect(store.claimHistoryScan(cwd, key)).toBe(true);
    expect(store.claimHistoryScan(cwd, key)).toBe(false);
    store.atomic(() => store.recordExisting(cwd, key, results));
    store.atomic(() => store.recordExisting(cwd, key, results));
    expect(store.history(key).runs).toHaveLength(3);
    expect(store.history({ ...key, viewer: "other" }).runs).toEqual([]);
    expect(store.active(key)).toBeUndefined();
    expect(store.queued(key)).toBeUndefined();
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
