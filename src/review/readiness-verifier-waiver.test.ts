// Flow 488 AC1: unverified blocker/major findings fail readiness item `verifier` at `review complete` and `review publish`.
// A `Not verified: N` line the agent writes into report.md no longer lifts it; only the verifier's result or the operator's waiver does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPERATOR_WORDS, PR, UNVERIFIED_MAJOR, ingestReady, writeFindings } from "./close-gates.test-helpers";
import { completeManagedReview } from "./managed";
import { publishReview } from "./publish";
import { computeReadiness, waiveReadiness } from "./readiness";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-verifier-waiver-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const io = () => {
  const posts: string[] = [];
  return { posts, post: async (_ref: string, _event: string, body: string) => { posts.push(body); return { ok: true, detail: "ok" }; }, confirm: async () => true };
};

async function unverifiedPackage(): Promise<string> {
  const ref = await ingestReady(dir, "# Review\nRequest changes.\n\nNot verified: 1", { kind: "pr", ref: PR });
  await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
  return ref;
}

describe("readiness item verifier (AC1)", () => {
  test("a `Not verified: N` line in report.md does not pass the item, and its repair offers the waiver, not the line", async () => {
    const ref = await unverifiedPackage();
    const verifier = (await computeReadiness(path.resolve(dir, ref))).items.find((item) => item.id === "verifier");
    expect(verifier?.status).toBe("fail");
    expect(verifier?.repair).toContain("--waive verifier");
    expect(verifier?.repair).toContain("review_waive_readiness");
    expect(verifier?.repair).not.toContain("Not verified");
    expect(verifier?.repair).not.toContain("report.md");
  });

  test("review complete refuses it, names the waiver, and leaves the package open", async () => {
    const ref = await unverifiedPackage();
    const error = await completeManagedReview(dir, ref, {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("verifier");
    expect((error as Error).message).toContain("--waive verifier");
    expect(JSON.parse(await readFile(path.join(path.resolve(dir, ref), "manifest.json"), "utf8")).status).not.toBe("closed");
  });

  test("review complete passes with the operator's waiver of verifier, recorded in the manifest", async () => {
    const ref = await unverifiedPackage();
    const done = await completeManagedReview(dir, ref, { waiveReadiness: [{ items: ["verifier"], quote: OPERATOR_WORDS }] });
    expect(done.manifest.status).toBe("closed");
    expect(done.manifest.readiness_waivers?.map((waiver) => [waiver.item, waiver.operator_quote])).toEqual([["verifier", OPERATOR_WORDS]]);
    expect(done.readiness?.items.find((item) => item.id === "verifier")?.status).toBe("waived");
  });

  test("review publish refuses it despite the line, naming verifier, and posts nothing", async () => {
    const ref = await unverifiedPackage();
    const sink = io();
    await expect(publishReview(path.resolve(dir, ref), { post: sink.post, confirm: sink.confirm })).rejects.toThrow(/cannot publish[\s\S]*verifier/i);
    expect(sink.posts).toEqual([]);
  });

  test("review publish passes once the operator waived verifier", async () => {
    const ref = await unverifiedPackage();
    await waiveReadiness(path.resolve(dir, ref), ["verifier"], OPERATOR_WORDS);
    const sink = io();
    const result = await publishReview(path.resolve(dir, ref), { post: sink.post, confirm: sink.confirm });
    expect(result.posted).toBe(true);
    expect(result.readiness.items.find((item) => item.id === "verifier")?.status).toBe("waived");
  });

  test("a finding that carries a verification passes without a line or a waiver", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR });
    await writeFindings(dir, ref, [{ ...UNVERIFIED_MAJOR, verification: { verdict: "confirmed", method: "site-check", evidence: "enumerated the sites", verifier: "review-verifier" } }]);
    expect((await computeReadiness(path.resolve(dir, ref))).items.find((item) => item.id === "verifier")?.status).toBe("pass");
  });
});
