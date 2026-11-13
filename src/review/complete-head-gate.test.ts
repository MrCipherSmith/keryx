import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HEAD, MOVED, PR, ingestReady, lookup } from "./close-gates.test-helpers";
import { completeHeadGate, type PrLookup } from "./complete-head-gate";
import { completeManagedReview } from "./managed";
import { computeReadiness, waiveReadiness } from "./readiness";

const REASON = "the operator confirms this round ran against the PR head";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-head-gate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ingest = (report: string, target: { kind: "pr" | "report"; ref: string; head?: string }, reviewId = "head-gate"): Promise<string> =>
  ingestReady(dir, report, target, reviewId);

const WAIVE_HEAD = [{ items: ["head"], quote: "the operator accepts that the PR moved after the round" }];

test("a merged PR refuses the close, and the repair is the operator waiver, not an edit of report.md", async () => {
  const ref = await ingest("# Review of the change\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const error = await completeManagedReview(dir, ref, { prLookup: lookup({ state: "MERGED" }) }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/merged/i);
  expect((error as Error).message).toContain("--waive head");
  expect((error as Error).message).not.toContain("first line");
});

test("a head that moved since the round refuses, and names both SHAs", async () => {
  const ref = await ingest("# Review of the change\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const error = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }) }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(HEAD.slice(0, 7));
  expect((error as Error).message).toContain(MOVED.slice(0, 7));
});

test("a first line that names the reviewed SHA and says the PR moved no longer lets it through", async () => {
  const ref = await ingest(`Reviewed ${HEAD.slice(0, 7)} — the PR has since merged.\nNo findings.`, { kind: "pr", ref: PR, head: HEAD });
  const error = await completeManagedReview(dir, ref, { prLookup: lookup({ state: "MERGED", headSha: MOVED }) }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  // The refusal is readiness item head's, and its repair is the operator's waiver: the report's line changed nothing.
  expect((error as Error).message).toMatch(/merged/i);
  expect((error as Error).message).toContain("--waive head");
  const onDisk = JSON.parse(await readFile(path.join(path.resolve(dir, ref), "manifest.json"), "utf8"));
  expect(onDisk.status).not.toBe("closed");
});

test("readiness item head fails on a moved head whatever the report's first line says, and its repair is the waiver", async () => {
  const ref = await ingest(`Reviewed ${HEAD.slice(0, 7)} — the PR has since moved on.\nNo findings.`, { kind: "pr", ref: PR, head: HEAD });
  const item = (await computeReadiness(path.resolve(dir, ref), { prLookup: lookup({ headSha: MOVED }) })).items.find((entry) => entry.id === "head");
  expect(item?.status).toBe("fail");
  expect(item?.evidence).toContain(MOVED.slice(0, 7));
  expect(item?.repair).toContain("--waive head");
  expect(item?.repair).toContain("review_waive_readiness");
  expect(item?.repair).not.toContain("first line");
  expect(item?.repair).not.toContain("report.md");
  await waiveReadiness(path.resolve(dir, ref), ["head"], "the operator accepts that the PR moved after the round", { prLookup: lookup({ headSha: MOVED }) });
  expect((await computeReadiness(path.resolve(dir, ref), { prLookup: lookup({ headSha: MOVED }) })).items.find((entry) => entry.id === "head")?.status).toBe("waived");
});

test("the operator's waiver of item head closes a merged or moved PR, and the manifest records it", async () => {
  const ref = await ingest(`Reviewed ${HEAD.slice(0, 7)} — the PR has since merged.\nNo findings.`, { kind: "pr", ref: PR, head: HEAD });
  const done = await completeManagedReview(dir, ref, { prLookup: lookup({ state: "MERGED", headSha: MOVED }), waiveReadiness: WAIVE_HEAD });
  expect(done.manifest.status).toBe("closed");
  expect(done.manifest.readiness_waivers?.map((waiver) => waiver.item)).toEqual(["head"]);
  expect(done.readiness?.items.find((item) => item.id === "head")?.status).toBe("waived");
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

test("a package whose ref is a PR URL is PR-bound whatever kind it was ingested under: a stale head still refuses", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "report", ref: PR, head: MOVED });
  const probe = lookup({ headSha: HEAD });
  const error = await completeManagedReview(dir, ref, { prLookup: probe }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(MOVED.slice(0, 7));
  expect((error as Error).message).toContain(HEAD.slice(0, 7));
  expect(probe.calls).toEqual([PR]);
  const onDisk = JSON.parse(await readFile(path.join(path.resolve(dir, ref), "manifest.json"), "utf8"));
  expect(onDisk.status).not.toBe("closed");
});

test("a PR URL under a non-pr kind completes once the operator waives head, or --head names the PR's head with the operator's reason", async () => {
  const named = await ingest(`Reviewed ${MOVED.slice(0, 7)} — the PR has since moved on.\nNo findings.`, { kind: "report", ref: PR, head: MOVED });
  await expect(completeManagedReview(dir, named, { prLookup: lookup({ headSha: HEAD }) })).rejects.toThrow(/head/);
  expect((await completeManagedReview(dir, named, { prLookup: lookup({ headSha: HEAD }), waiveReadiness: WAIVE_HEAD })).manifest.status).toBe("closed");
  const fixed = await ingest("# Review\nNo findings.", { kind: "report", ref: PR, head: MOVED });
  const done = await completeManagedReview(dir, fixed, { prLookup: lookup({ headSha: HEAD }), head: HEAD, headReason: REASON });
  expect(done.manifest.target.head).toBe(HEAD);
});

test("a tracker that cannot be reached warns instead of blocking the close", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const done = await completeManagedReview(dir, ref, { prLookup: async () => { throw new Error("offline"); } });
  expect(done.manifest.status).toBe("closed");
  expect(done.warnings.join(" ")).toContain("PR state");
});

const gateManifest = (head?: string) => ({ target: { kind: "pr", ref: PR, ...(head === undefined ? {} : { head }) } }) as never;

test("a tracker answer that is empty, not found or a rejection is one warning naming the PR, never a refusal", async () => {
  for (const answer of [async () => null, async () => ({ exists: false }), async () => { throw new Error("offline"); }] as PrLookup[]) {
    const { warnings, refusal } = await completeHeadGate({ manifest: gateManifest(HEAD), lookup: answer });
    expect(refusal).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(PR);
    expect(warnings[0]).toContain("skipped");
  }
});

test("completeHeadGate reports a moved head as a refusal naming both SHAs, whatever a first line says", async () => {
  const { refusal, warnings } = await completeHeadGate({ manifest: gateManifest(HEAD), lookup: lookup({ headSha: MOVED }) });
  expect(warnings).toEqual([]);
  expect(refusal).toContain(HEAD.slice(0, 7));
  expect(refusal).toContain(MOVED.slice(0, 7));
  expect((await completeHeadGate({ manifest: gateManifest(HEAD), lookup: lookup({ state: "MERGED" }) })).refusal).toContain("merged");
});

test("a recorded head that is not a usable SHA is a warning, and an empty one never matches every PR head", async () => {
  for (const head of ["", "0e", "not-a-sha"]) {
    const { warnings } = await completeHeadGate({ manifest: gateManifest(head), lookup: lookup({ headSha: MOVED }) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a commit SHA");
  }
});

test("completeHeadGate compares by prefix, so a short recorded SHA matches the full PR head", async () => {
  const manifest = { target: { kind: "pr", ref: PR, head: HEAD.slice(0, 7) } } as never;
  expect((await completeHeadGate({ manifest, lookup: lookup({ headSha: HEAD }) })).warnings).toEqual([]);
});

test("--head names the reviewed commit: it replaces a wrong recorded head, passes the gate and is what the manifest keeps", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: MOVED });
  const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: HEAD.toUpperCase(), headReason: REASON });
  expect(done.manifest.status).toBe("closed");
  expect(done.manifest.target.head).toBe(HEAD);
  expect(done.warnings.join(" ")).toContain(`replaces the head recorded when the round started (${MOVED.slice(0, 7)})`);
  const onDisk = JSON.parse(await readFile(path.join(path.resolve(dir, ref), "manifest.json"), "utf8"));
  expect(onDisk.target.head).toBe(HEAD);
});

test("--head fills a head the round never recorded, without a warning about replacing one", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR });
  const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: HEAD.slice(0, 7) });
  expect(done.manifest.target.head).toBe(HEAD.slice(0, 7));
  expect(done.warnings.join(" ")).not.toContain("replaces");
});

test("--head does not loosen the gate: a head that is not the PR's head still fails, and the manifest stays as it was", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  // With the relabel's reason given, what is left is readiness item head, which only the operator's waiver lifts.
  const error = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: MOVED, headReason: REASON }).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(MOVED.slice(0, 7));
  expect((error as Error).message).toContain(HEAD.slice(0, 7));
  expect((error as Error).message).toContain("--waive head");
  const onDisk = JSON.parse(await readFile(path.join(path.resolve(dir, ref), "manifest.json"), "utf8"));
  expect(onDisk.status).not.toBe("closed");
  expect(onDisk.target.head).toBe(HEAD);
});

test("a head that is not the PR's head completes only with the operator's waiver of head, besides the reason for the relabel", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: HEAD }), head: MOVED, headReason: REASON, waiveReadiness: WAIVE_HEAD });
  expect(done.manifest.target.head).toBe(MOVED);
  expect(done.manifest.head_override?.to).toBe(MOVED);
});

test("--head must be a commit SHA and needs a pull request package", async () => {
  const pr = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, pr, { prLookup: lookup({}), head: "not-a-sha" })).rejects.toThrow(/not a commit SHA/);
  await expect(completeManagedReview(dir, pr, { prLookup: lookup({}), head: "abc" })).rejects.toThrow(/not a commit SHA/);
  const report = await ingest("# R\nNo findings.", { kind: "report", ref: "review.md" }, "head-report");
  await expect(completeManagedReview(dir, report, { head: HEAD })).rejects.toThrow(/pull request package/);
});

test("--head-reason without a relabel is refused: with no --head, and with --head naming the recorded head", async () => {
  const bare = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, bare, { prLookup: lookup({}), headReason: REASON })).rejects.toThrow(/--head-reason applies only/);
  await expect(completeManagedReview(dir, bare, { prLookup: lookup({}), head: HEAD.toUpperCase(), headReason: REASON })).rejects.toThrow(/--head-reason applies only/);
  const onDisk = JSON.parse(await readFile(path.join(path.resolve(dir, bare), "manifest.json"), "utf8"));
  expect(onDisk.status).not.toBe("closed");
  expect(onDisk.head_override).toBeUndefined();
});

test("without --head the recorded head is what the gate checks, as before", async () => {
  const ref = await ingest("# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
  await expect(completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }) })).rejects.toThrow(/moved/);
});
