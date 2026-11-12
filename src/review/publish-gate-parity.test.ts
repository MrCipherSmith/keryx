// Flow 488 AC5: `review publish` runs the same gate evaluation as `review complete`: a package whose round record was
// edited after `review start`, and one whose report has no valid evidence level, are refused by both with the same
// messages. `--partial` relaxes readiness only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PR, UNVERIFIED_MAJOR, ingestReady, readManifest, writeFindings } from "./close-gates.test-helpers";
import { evaluateCloseGates } from "./close-gates";
import { completeManagedReview } from "./managed";
import { publishReview } from "./publish";
import { roundRecordTampered } from "./round-record";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-gate-parity-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const sink = () => {
  const posts: string[] = [];
  return { posts, post: async (_ref: string, _event: string, body: string) => { posts.push(body); return { ok: true, detail: "ok" }; }, confirm: async () => true };
};

async function editManifest(ref: string, edit: (manifest: Record<string, any>) => void): Promise<void> {
  const manifest = await readManifest(dir, ref);
  edit(manifest);
  await writeFile(path.join(path.resolve(dir, ref), "manifest.json"), JSON.stringify(manifest, null, 2));
}

const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().then(() => undefined, (e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
};

describe("publish and complete obtain their refusals from one gate evaluation (AC5)", () => {
  test("a round record edited after review start is refused by both, with the same message, even with --partial", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR });
    await editManifest(ref, (manifest) => { manifest.roundRecord = { roundSha256: "0".repeat(64), priorFindingsSha256: "0".repeat(64) }; });
    const expected = `Cannot complete managed review; ${roundRecordTampered(path.resolve(dir, ref))}`;
    expect(expected).toContain("changed after `keryx review start`");
    const out = sink();
    expect(await messageOf(() => completeManagedReview(dir, ref, {}))).toBe(expected);
    expect(await messageOf(() => publishReview(path.resolve(dir, ref), { post: out.post, confirm: out.confirm }))).toBe(expected);
    expect(await messageOf(() => publishReview(path.resolve(dir, ref), { partial: true, post: out.post, confirm: out.confirm }))).toBe(expected);
    expect(out.posts).toEqual([]);
  });

  test("a report with no valid evidence level is refused by both, with the same message, even with --partial", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR });
    await editManifest(ref, (manifest) => { manifest.report_fields = ["evidence-level"]; });
    await writeFile(path.join(path.resolve(dir, ref), "report.md"), "# Review\nNo findings.\n");
    const out = sink();
    const completeMessage = await messageOf(() => completeManagedReview(dir, ref, {}));
    expect(completeMessage).toContain("the report's evidence level is missing or invalid");
    expect(await messageOf(() => publishReview(path.resolve(dir, ref), { post: out.post, confirm: out.confirm }))).toBe(completeMessage);
    expect(await messageOf(() => publishReview(path.resolve(dir, ref), { partial: true, post: out.post, confirm: out.confirm }))).toBe(completeMessage);
    expect(out.posts).toEqual([]);
  });

  test("a package from before the evidence-level field still publishes: it is a warning there too", async () => {
    const ref = await ingestReady(dir, "# Review\nNo findings.", { kind: "pr", ref: PR });
    await editManifest(ref, (manifest) => { delete manifest.report_fields; });
    await writeFile(path.join(path.resolve(dir, ref), "report.md"), "# Review\nNo findings.\n");
    const out = sink();
    const result = await publishReview(path.resolve(dir, ref), { post: out.post, confirm: out.confirm });
    expect(result.posted).toBe(true);
    const gate = await evaluateCloseGates(path.resolve(dir, ref), { manifest: await readManifest(dir, ref), report: "# Review\n", action: "publish" });
    expect(gate.warnings.join(" ")).toContain("predates the field");
  });

  test("--partial still relaxes readiness: a failing checklist posts with its header", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR });
    await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
    const out = sink();
    await expect(publishReview(path.resolve(dir, ref), { post: out.post, confirm: out.confirm })).rejects.toThrow(/cannot publish[\s\S]*verifier/i);
    const result = await publishReview(path.resolve(dir, ref), { partial: true, post: out.post, confirm: out.confirm });
    expect(result.partial).toBe(true);
    expect(out.posts[0]).toStartWith("**Partial review.**");
  });

  test("the shared function refuses the readiness checklist unless relaxed, naming the action", async () => {
    const ref = await ingestReady(dir, "# Review\nRequest changes.", { kind: "pr", ref: PR });
    await writeFindings(dir, ref, [UNVERIFIED_MAJOR]);
    const manifest = await readManifest(dir, ref);
    const report = "# Review\nEvidence level: static only — did not run: tests\n";
    await expect(evaluateCloseGates(path.resolve(dir, ref), { manifest, report, action: "publish" })).rejects.toThrow(/Cannot publish/);
    await expect(evaluateCloseGates(path.resolve(dir, ref), { manifest, report, action: "complete the review" })).rejects.toThrow(/Cannot complete the review/);
    expect((await evaluateCloseGates(path.resolve(dir, ref), { manifest, report, action: "publish", relaxReadiness: true })).readiness.verdict).toBe("NOT READY");
  });
});
