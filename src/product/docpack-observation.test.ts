// A requirements package can record what happened after it shipped, as
// `- <verdict> — <note>` lines under `## Outcome observations` in its README.
// The index stores the verdict and note; a malformed line is a failure naming the
// package. A package's status stays `open` whatever it says, so an observation
// never removes it from the `open` list — it is stored and parsed, nothing more.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex, corpusFingerprint } from "./corpus";
import { docpackObservationFrom, docpackObservationProblem, extractDocpackIntent } from "./extract";
import { FIXTURE_COUNTS, copyFixtureRepo } from "./fixtures/repo";
import { buildOpenReport } from "./service";

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function writePackage(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = path.join(root, "docs", "requirements", name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(dir, file), text);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("docpack observations", () => {
  test("the fixture package stores its verdict, date and note", async () => {
    const index = await buildIntentIndex(await project());
    const pack = index.intents.find((intent) => intent.id === "gamma-package");
    expect(pack?.outcome).toMatchObject({
      observed: true,
      verdict: "no-effect",
      observedAt: "2026-03-01",
      note: "2026-03-01 the merge-to-release lag did not change after the feature shipped",
    });
    expect(index.failures).toEqual([]);
    expect(index.counts.docpacks).toBe(FIXTURE_COUNTS.docpacks);
  });

  test("a package without the section records no observation", async () => {
    const index = await buildIntentIndex(await project());
    expect(index.intents.find((intent) => intent.id === "alpha-package")?.outcome).toMatchObject({ observed: false, verdict: null, note: null });
  });

  test("an observed package stays `open` and stays out of the closed counts", async () => {
    const index = await buildIntentIndex(await project());
    const pack = index.intents.find((intent) => intent.id === "gamma-package");
    expect(pack?.status).toBe("open");
    expect(index.counts.closed).toBe(FIXTURE_COUNTS.closed);
    expect(index.counts.observed).toBe(FIXTURE_COUNTS.observed);
    expect(buildOpenReport(index).entries.map((entry) => entry.id)).not.toContain("gamma-package");
  });

  test("a bullet or a plain line reads the same, and the first line decides", () => {
    const pack = (body: string) => ({ name: "p", primary: `# P\n\n## Outcome observations\n\n${body}\n`, specification: null });
    expect(docpackObservationFrom(pack("- helped — it did")).verdict).toBe("helped");
    expect(docpackObservationFrom(pack("* harmed — it broke")).verdict).toBe("harmed");
    expect(docpackObservationFrom(pack("inconclusive — too early")).verdict).toBe("inconclusive");
    expect(docpackObservationFrom(pack("- helped — first\n- harmed — later")).verdict).toBe("helped");
  });

  test("the README carries the section even when a PRD is the primary document", async () => {
    const root = await project();
    await writePackage(root, "delta-package", {
      "prd.md": "# Delta\n\n## Problem\n\nSomething is slow. It has been for a while.\n",
      "README.md": "# Delta\n\n## Outcome observations\n\n- harmed — 2026-04-02 it got slower\n",
    });
    const index = await buildIntentIndex(root);
    expect(index.intents.find((intent) => intent.id === "delta-package")?.outcome).toMatchObject({ observed: true, verdict: "harmed" });
  });

  test("editing the README moves the corpus fingerprint even when a PRD is primary", async () => {
    const root = await project();
    await writePackage(root, "delta-package", { "prd.md": "# Delta\n", "README.md": "# Delta\n" });
    const before = await corpusFingerprint(root);
    await writePackage(root, "delta-package", { "README.md": "# Delta\n\n## Outcome observations\n\n- helped — fine\n" });
    expect(await corpusFingerprint(root)).not.toBe(before);
  });

  test("a heading inside a code fence is not the section", () => {
    const source = { name: "p", primary: "# P\n\n```md\n## Outcome observations\n- not a verdict\n```\n", specification: null };
    expect(docpackObservationFrom(source).observed).toBe(false);
    expect(docpackObservationProblem(source)).toBeNull();
  });
});

describe("a malformed docpack observation", () => {
  for (const line of ["- worked — yes", "- helped", "- helped - a hyphen", "- 2026-03-01 it helped"]) {
    test(`\`${line}\` is a failure naming the package`, async () => {
      const root = await project();
      await writePackage(root, "delta-package", { "README.md": `# Delta\n\n## Outcome observations\n\n${line}\n` });
      const index = await buildIntentIndex(root);
      expect(index.failures).toHaveLength(1);
      expect(index.failures[0]).toStartWith("docs/requirements/delta-package: outcome observation has no recognized verdict");
      const pack = index.intents.find((intent) => intent.id === "delta-package");
      expect(pack).toBeDefined();
      expect(pack?.outcome.observed).toBe(false);
      expect(pack?.status).toBe("open");
    });
  }

  test("extraction of a package is a pure function of its text", () => {
    const source = { name: "p", primary: "# P\n\n## Outcome observations\n\n- helped — fine\n", specification: null };
    expect(extractDocpackIntent(source, "docs/requirements/p")).toEqual(extractDocpackIntent(source, "docs/requirements/p"));
  });
});
