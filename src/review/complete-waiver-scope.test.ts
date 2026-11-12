// Flow 488 AC4: a readiness waiver of `files-covered`, `blast-radius`, `reviewers` or `ledger` removes only the research
// errors that belong to that item. Before, any one of the four dropped EVERY research error, an artifact-locator or
// manifest/dispatch mismatch error included.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPERATOR_WORDS, PR, ingestReady, readManifest } from "./close-gates.test-helpers";
import { completeManagedReview } from "./managed";
import { packageResearchErrors, packageResearchErrorsTagged } from "./research";

let dir = "";
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "keryx-waiver-scope-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const waive = (item: string) => [{ items: [item], quote: OPERATOR_WORDS }];

/** An open obligation: a ledger error, and the `ledger` readiness item fails with it. */
async function openObligation(ref: string): Promise<void> {
  const file = path.join(path.resolve(dir, ref), "research.json");
  const research = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...research, obligations: [{ id: "ob-1", source: "raw", question: "is it real?", status: "open" }] }));
}

async function editManifest(ref: string, edit: (manifest: Record<string, any>) => void): Promise<void> {
  const file = path.join(path.resolve(dir, ref), "manifest.json");
  const manifest = await readManifest(dir, ref);
  edit(manifest);
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

describe("a readiness waiver is scoped to its own item (AC4)", () => {
  test("the research errors are tagged by readiness item; integrity errors carry none", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR });
    await openObligation(ref);
    const manifest = await readManifest(dir, ref);
    const tagged = await packageResearchErrorsTagged(path.resolve(dir, ref), manifest.artifacts, []);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every((error) => error.items.includes("ledger"))).toBe(true);
    expect((await packageResearchErrors(path.resolve(dir, ref), manifest.artifacts, [])).length).toBe(tagged.length);

    await editManifest(ref, (value) => { delete value.artifacts.reviewerDispatch; });
    const mismatch = await packageResearchErrorsTagged(path.resolve(dir, ref), (await readManifest(dir, ref)).artifacts, []);
    expect(mismatch.find((error) => error.message.includes("manifest.json does not declare it"))?.items).toEqual([]);

    await editManifest(ref, (value) => { value.artifacts.research = "elsewhere.json"; });
    const locator = await packageResearchErrorsTagged(path.resolve(dir, ref), (await readManifest(dir, ref)).artifacts, []);
    expect(locator).toEqual([{ message: "invalid research artifact locator", items: [] }]);
  });

  test("a waiver of ledger still lets the close through when only ledger errors remain", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR });
    await openObligation(ref);
    await expect(completeManagedReview(dir, ref, {})).rejects.toThrow(/unresolved research/);
    const done = await completeManagedReview(dir, ref, { waiveReadiness: waive("ledger") });
    expect(done.manifest.status).toBe("closed");
  });

  test("a manifest that does not declare the dispatch the research records still refuses, whatever is waived", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR });
    await openObligation(ref);
    await editManifest(ref, (value) => { delete value.artifacts.reviewerDispatch; });
    const error = await completeManagedReview(dir, ref, { waiveReadiness: waive("ledger") }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("manifest.json does not declare it");
    expect((await readManifest(dir, ref)).status).not.toBe("closed");
    expect((await readManifest(dir, ref)).readiness_waivers).toBeUndefined();
  });

  test("an invalid artifact locator still refuses, whatever is waived", async () => {
    const ref = await ingestReady(dir, "# Review", { kind: "pr", ref: PR });
    await openObligation(ref);
    await editManifest(ref, (value) => { value.artifacts.research = "elsewhere.json"; });
    const error = await completeManagedReview(dir, ref, { waiveReadiness: waive("ledger") }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("invalid research artifact locator");
    expect((await readManifest(dir, ref)).status).not.toBe("closed");
  });
});
