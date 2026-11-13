// SEC-1: a waiver, a target head or a verification written straight into the package JSON is refused by both
// `review complete` and `review publish`; the paths keryx itself writes (the waiver, `--head` + `--head-reason`,
// `review ingest --verifications`) still close.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVIDENCE, HEAD, MOVED, OPERATOR_WORDS, PR, UNVERIFIED_MAJOR, VERIFIED, ingestReady, lookup, readManifest, writeFindings } from "./close-gates.test-helpers";
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
const READY_RESEARCH ={ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: READY_DISPATCH };

const sink = () => {
  const posts: string[] = [];
  return { posts, post: async (_ref: string, _event: string, body: string) => { posts.push(body); return { ok: true, detail: "ok" }; }, confirm: async () => true };
};

async function editManifest(ref: string, edit: (manifest: Record<string, any>) => void): Promise<void> {
  const manifest = await readManifest(dir, ref) as unknown as Record<string, any>;
  edit(manifest);
  await writeFile(path.join(path.resolve(dir, ref), "manifest.json"), JSON.stringify(manifest, null, 2));
}

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
});
