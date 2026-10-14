import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { completeHeadGate, type PrLookup } from "./complete-head-gate";
import { completeManagedReview, createManagedReviewPackage } from "./managed";

const ready = { version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const EVIDENCE = "Evidence level: static only — did not run: tests";
const PR = "https://github.com/acme/app/pull/7";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-head-gate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ingest(report: string, target: { kind: "pr" | "report"; ref: string; head?: string }): Promise<string> {
  const result = await createManagedReviewPackage({ cwd: dir, mode: "ingest", reportText: `${report}\n${EVIDENCE}\n`, reviewId: "head-gate", target });
  await writeFile(path.join(path.resolve(dir, result.path), "research.json"), JSON.stringify(ready));
  return result.path;
}

function lookup(pr: { state?: string; headSha?: string } | null): PrLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (ref: string) => { calls.push(ref); return pr === null ? null : { exists: true, state: pr.state ?? "OPEN", headSha: pr.headSha ?? HEAD }; }) as PrLookup & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("a merged PR refuses a report that does not say so on its first line", async () => {
  const ref = await ingest("# Review of the change\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, ref, { prLookup: lookup({ state: "MERGED" }) })).rejects.toThrow(/merged/i);
});

test("a head that moved since the round refuses, and names both SHAs", async () => {
  const ref = await ingest("# Review of the change\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const error = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }) }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(HEAD.slice(0, 7));
  expect((error as Error).message).toContain(MOVED.slice(0, 7));
});

test("a first line that names the reviewed SHA and says the PR moved lets it through", async () => {
  const ref = await ingest(`Reviewed ${HEAD.slice(0, 7)} — the PR has since merged.\nNo findings.`, { kind: "pr", ref: PR, head: HEAD });
  const done = await completeManagedReview(dir, ref, { prLookup: lookup({ state: "MERGED", headSha: MOVED }) });
  expect(done.manifest.status).toBe("closed");
});

test("naming the SHA without saying the PR moved is not enough, nor is saying it without the SHA", async () => {
  const sha = await ingest(`Reviewed ${HEAD.slice(0, 7)}.\nNo findings.`, { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, sha, { prLookup: lookup({ state: "MERGED" }) })).rejects.toThrow(/first line/);
  const said = await ingest("The PR has since merged.\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, said, { prLookup: lookup({ state: "MERGED" }) })).rejects.toThrow(/first line/);
});

test("an open PR still at the reviewed head completes untouched", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const probe = lookup({});
  const done = await completeManagedReview(dir, ref, { prLookup: probe });
  expect(done.manifest.status).toBe("closed");
  expect(probe.calls).toEqual([PR]);
});

test("a package with no PR binding never asks the tracker", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "report", ref: "review.md" });
  const probe = lookup({ state: "MERGED", headSha: MOVED });
  expect((await completeManagedReview(dir, ref, { prLookup: probe })).manifest.status).toBe("closed");
  expect(probe.calls).toEqual([]);
});

test("a tracker that cannot be reached warns instead of blocking the close", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const done = await completeManagedReview(dir, ref, { prLookup: async () => { throw new Error("offline"); } });
  expect(done.manifest.status).toBe("closed");
  expect(done.warnings.join(" ")).toContain("PR state");
});

test("completeHeadGate compares by prefix, so a short recorded SHA matches the full PR head", async () => {
  const manifest = { target: { kind: "pr", ref: PR, head: HEAD.slice(0, 7) } } as never;
  expect((await completeHeadGate({ manifest, report: "# R", lookup: lookup({ headSha: HEAD }) })).warnings).toEqual([]);
});
