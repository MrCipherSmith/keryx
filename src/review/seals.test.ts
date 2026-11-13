// SEC-1: a waiver, a target head or a verification written straight into the package JSON is refused by both
// `review complete` and `review publish`; the paths keryx itself writes (the waiver, `--head` + `--head-reason`,
// `review ingest --verifications`) still close.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVIDENCE, HEAD, MOVED, OPERATOR_WORDS, PR, UNVERIFIED_MAJOR, VERIFIED, editManifest as editManifestIn, ingestReady, lookup, readManifest, sink, writeFindings } from "./close-gates.test-helpers";
import { READY_COVERAGE_MD, READY_DISPATCH } from "./dispatch.test-helpers";
import { completeManagedReview, createManagedReviewPackage } from "./managed";
import { publishReview } from "./publish";
import { waiveReadiness } from "./readiness";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-seals-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const REASON = "the operator confirms this round ran against the PR head";
/** One reviewer's result, as `reviewer-finding.schema.json` shapes it: a major that enumerates its class. */
const REVIEWER_RESULT = {
  status: "DONE_WITH_CONCERNS", reviewer: "synthetic-reviewer", summary: "one major",
  findings: [{
    id: "F-001", severity: "major", file: "src/a.ts", line: 1, problem: "unverified claim", impact: "a wrong close",
    suggested_fix: "verify it", evidence: "read the site", confidence: "high",
    class_scope: { sites: ["src/a.ts"], enumeration_method: "grep for the shape; one site" },
  }],
  stats: { blocker: 0, major: 1, minor: 0, info: 0 },
};
const editManifest = (ref: string, edit: (manifest: Record<string, any>) => void): Promise<void> => editManifestIn(dir, ref, edit);
const READY_RESEARCH ={ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().then(() => undefined, (e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
};

/** Both commands refuse, each message contains every fragment, nothing is posted and the package stays open. */
async function bothRefuse(ref: string, fragments: string[], prLookup = lookup({})): Promise<void> {
  const out = sink();
  const complete = await messageOf(() => completeManagedReview(dir, ref, { prLookup }));
  const publish = await messageOf(() => publishReview(path.resolve(dir, ref), { readiness: { prLookup }, post: out.post, confirm: out.confirm }));
  for (const fragment of fragments) {
    expect(complete).toContain(fragment);
    expect(publish).toContain(fragment);
  }
  expect(out.posts).toEqual([]);
  expect((await readManifest(dir, ref)).status).not.toBe("closed");
}

describe("seals keep hand-written gate inputs out (SEC-1)", () => {
  test("(a) a waiver written into manifest.json is not honoured by complete or publish", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD });
    await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
    await editManifest(ref, (manifest) => {
      manifest.readiness_waivers = [{ item: "verifier", operator_quote: OPERATOR_WORDS, time: new Date().toISOString() }];
    });
    await bothRefuse(ref, ["verifier", "manifest.json readiness_waivers"]);
  });

  test("(a) the same waiver recorded by keryx closes the package", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD });
    await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
    await waiveReadiness(path.resolve(dir, ref), ["verifier"], OPERATOR_WORDS);
    const out = sink();
    expect((await publishReview(path.resolve(dir, ref), { readiness: { prLookup: lookup({}) }, post: out.post, confirm: out.confirm })).posted).toBe(true);
    expect((await completeManagedReview(dir, ref, { prLookup: lookup({}) })).manifest.status).toBe("closed");
  });

  test("(b) a target head rewritten in manifest.json is refused, even when it now matches the PR head", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    await editManifest(ref, (manifest) => { manifest.target.head = MOVED; });
    await bothRefuse(ref, ["manifest.json target", "does not match the seal"], lookup({ headSha: MOVED }));
  });

  test("(b) --head with --head-reason still relabels the head, and the next close sees the new seal", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    const done = await completeManagedReview(dir, ref, { prLookup: lookup({ headSha: MOVED }), head: MOVED, headReason: REASON });
    expect(done.manifest.status).toBe("closed");
    expect(done.manifest.target.head).toBe(MOVED);
    const out = sink();
    expect((await publishReview(path.resolve(dir, ref), { readiness: { prLookup: lookup({ headSha: MOVED }) }, post: out.post, confirm: out.confirm })).posted).toBe(true);
  });

  test("(b) a head_override written into manifest.json is refused", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    await editManifest(ref, (manifest) => {
      manifest.head_override = { from: HEAD, to: MOVED, operator_quote: REASON, time: new Date().toISOString() };
    });
    await bothRefuse(ref, ["head_override"]);
  });

  test("(c) `\"verification\": {}` in findings.json does not pass item verifier", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD });
    await writeFindings(dir, ref, [{ ...UNVERIFIED_MAJOR, verification: {} }]);
    await bothRefuse(ref, ["verifier", "findings.json"]);
  });

  test("(c) a well-formed verification keryx did not record does not pass item verifier either", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD });
    await writeFindings(dir, ref, [{ ...UNVERIFIED_MAJOR, verification: VERIFIED }]);
    await bothRefuse(ref, ["verifier", "keryx did not record"]);
  });

  test("(c) a verification applied by ingest --verifications closes the package", async () => {
    const result = await createManagedReviewPackage({
      cwd: dir, mode: "ingest", reviewId: "seal-round", target: { kind: "pr", ref: PR, head: HEAD },
      reportText: `# Review\nRequest changes.\n\n${EVIDENCE}\n\n## Major\n\n### [F-001] unverified claim\n- **Severity**: major\n\n\`\`\`json keryx:findings\n${JSON.stringify([REVIEWER_RESULT])}\n\`\`\`\n`,
      verifications: [{ finding: "seal-round#F-001", ...VERIFIED }],
    });
    await writeFile(path.join(path.resolve(dir, result.path), "research.json"), JSON.stringify(READY_RESEARCH));
    await writeFile(path.join(path.resolve(dir, result.path), "coverage.md"), READY_COVERAGE_MD);
    const findings = JSON.parse(await readFile(path.join(path.resolve(dir, result.path), "findings.json"), "utf8")) as Array<{ severity: string; verification?: unknown }>;
    expect(findings.some((finding) => finding.severity === "major" && finding.verification !== undefined)).toBe(true);
    expect((await completeManagedReview(dir, result.path, { prLookup: lookup({}) })).manifest.status).toBe("closed");
  });

  test("(c) a verification missing only its method, or only its evidence, does not pass item verifier", async () => {
    for (const verification of [{ ...VERIFIED, method: "" }, { ...VERIFIED, evidence: " " }]) {
      const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD }, `partial-${verification.method === "" ? "method" : "evidence"}`);
      await writeFindings(dir, ref, [{ ...UNVERIFIED_MAJOR, verification }]);
      await bothRefuse(ref, ["verifier", "without verdict, method and evidence"]);
    }
  });
});

/** A package ingested with one reviewer major (key `seal-round#F-001`), research and coverage ready. */
async function ingestWithMajor(verifications: Array<Record<string, unknown>> = []): Promise<string> {
  const result = await createManagedReviewPackage({
    cwd: dir, mode: "ingest", reviewId: "seal-round", target: { kind: "pr", ref: PR, head: HEAD },
    reportText: `# Review\nRequest changes.\n\n${EVIDENCE}\n\n## Major\n\n### [F-001] unverified claim\n- **Severity**: major\n\n\`\`\`json keryx:findings\n${JSON.stringify([REVIEWER_RESULT])}\n\`\`\`\n`,
    verifications,
  });
  await writeFile(path.join(path.resolve(dir, result.path), "research.json"), JSON.stringify(READY_RESEARCH));
  await writeFile(path.join(path.resolve(dir, result.path), "coverage.md"), READY_COVERAGE_MD);
  return result.path;
}

const findingsOf = async (ref: string): Promise<Array<Record<string, unknown>>> => JSON.parse(await readFile(path.join(path.resolve(dir, ref), "findings.json"), "utf8"));

describe("PR 1166 round 2: removed seals, pre-seal packages and the blocker/major record", () => {
  test("SEC-1: seals deleted and target.head rewritten to the PR head is refused by complete and publish", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    await editManifest(ref, (manifest) => { delete manifest.seals; manifest.target.head = MOVED; });
    await bothRefuse(ref, ["carries no target seal", "--head-reason"], lookup({ headSha: MOVED }));
  });

  test("cluster A: a waiver on a package with no seals is not reported as a target edit; the refusal names the missing seal", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR, head: HEAD });
    await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
    await editManifest(ref, (manifest) => { delete manifest.seals; });
    await waiveReadiness(path.resolve(dir, ref), ["verifier"], OPERATOR_WORDS);
    const manifest = await readManifest(dir, ref);
    expect(manifest.seals?.readinessWaivers?.verifier).toBeDefined();
    expect(manifest.seals?.target).toBeUndefined();
    const message = await messageOf(() => completeManagedReview(dir, ref, { prLookup: lookup({}) }));
    expect(message).toContain("carries no target seal");
    expect(message).not.toContain("does not match the seal");
  });

  test("a package with no target seal: --head of the same SHA without --head-reason is refused, with it the close seals the head", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    // Only the target seal is gone: a package with no blocker/major record is refused until re-ingested (round 3), which --head-reason does not repair.
    await editManifest(ref, (manifest) => { delete manifest.seals.target; });
    expect(await messageOf(() => completeManagedReview(dir, ref, { prLookup: lookup({}), head: HEAD }))).toContain("carries no target seal");
    expect((await readManifest(dir, ref)).seals?.target).toBeUndefined();
    const done = await completeManagedReview(dir, ref, { prLookup: lookup({}), head: HEAD, headReason: REASON });
    expect(done.manifest.status).toBe("closed");
    expect(done.manifest.seals?.target).toBeDefined();
    expect(done.manifest.head_override?.operator_quote).toBe(REASON);
    const out = sink();
    expect((await publishReview(path.resolve(dir, ref), { readiness: { prLookup: lookup({}) }, post: out.post, confirm: out.confirm })).posted).toBe(true);
  });

  test("a close without --head does not seal a target keryx never sealed", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    await editManifest(ref, (manifest) => { manifest.seals = { readinessWaivers: {} }; });
    await messageOf(() => completeManagedReview(dir, ref, { prLookup: lookup({}) }));
    expect((await readManifest(dir, ref)).seals?.target).toBeUndefined();
  });

  test("SEC-2: lowering an unverified major to minor in findings.json does not pass item verifier", async () => {
    const ref = await ingestWithMajor();
    const findings = await findingsOf(ref);
    expect(findings.some((finding) => finding.severity === "major")).toBe(true);
    await writeFindings(dir, ref, findings.map((finding) => ({ ...finding, severity: "minor" })));
    await bothRefuse(ref, ["verifier", "1 of 1 blocker/major"]);
  });

  test("SEC-2: deleting the major from findings.json does not pass item verifier", async () => {
    const ref = await ingestWithMajor();
    await writeFindings(dir, ref, []);
    await bothRefuse(ref, ["verifier", "missing from findings.json"]);
  });

  test("SEC-2: an edited blocker/major record in manifest.json is refused", async () => {
    const ref = await ingestWithMajor();
    await editManifest(ref, (manifest) => { manifest.seals.heavyFindings.keys = []; });
    await bothRefuse(ref, ["seals.heavyFindings"]);
  });

  test("PR 1166 round 3 (cluster A): deleting seals.heavyFindings and lowering the unverified major is refused", async () => {
    const ref = await ingestWithMajor();
    await writeFindings(dir, ref, (await findingsOf(ref)).map((finding) => ({ ...finding, severity: "minor" })));
    await editManifest(ref, (manifest) => {
      expect(manifest.seals.target).toBeDefined();
      delete manifest.seals.heavyFindings;
    });
    await bothRefuse(ref, ["carries no seals.heavyFindings"]);
  });

  test("PR 1166 round 3 (cluster B): a hand-set status closed does not turn the research gate off for complete", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.\n- Not run: mutation pass", { kind: "report", ref: "review.md" });
    const pkg = path.resolve(dir, ref);
    await mkdir(path.join(pkg, "research-evidence"), { recursive: true });
    await writeFile(path.join(pkg, "research-evidence", "mutants.json"), JSON.stringify({ mutants: [{ id: "M1", file: "src/a.ts", anchor: "x", replacement: "y" }] }));
    const open = await messageOf(() => completeManagedReview(dir, ref));
    expect(open).toContain("proposed mutant");
    await editManifest(ref, (manifest) => { manifest.status = "closed"; });
    expect(await messageOf(() => completeManagedReview(dir, ref))).toContain("proposed mutant");
  });

  test("SEC-2: a major verified through ingest still closes", async () => {
    const ref = await ingestWithMajor([{ finding: "seal-round#F-001", ...VERIFIED }]);
    expect((await completeManagedReview(dir, ref, { prLookup: lookup({}) })).manifest.status).toBe("closed");
  });

  test("DEG-1: an unreadable findings.json is an integrity refusal: complete, publish and publish --partial all refuse", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR, head: HEAD });
    await writeFile(path.join(path.resolve(dir, ref), "findings.json"), "[{ truncated");
    await bothRefuse(ref, ["findings.json is missing or not JSON"]);
    const out = sink();
    const partial = await messageOf(() => publishReview(path.resolve(dir, ref), { partial: true, readiness: { prLookup: lookup({}) }, post: out.post, confirm: out.confirm }));
    expect(partial).toContain("findings.json is missing or not JSON");
    expect(out.posts).toEqual([]);
  });
});
