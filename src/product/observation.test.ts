// Flow 362, AC7: an observation is a line beginning `outcome-observed:` in the
// flow's journal.md. `index` reads it, and a flow with such a line leaves the
// `open` list.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex } from "./corpus";
import { observationFrom } from "./extract";
import { copyFixtureRepo } from "./fixtures/repo";
import { buildOpenReport } from "./service";

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

function journalOf(root: string, flow: string): string {
  return path.join(root, ".metaproject", "flows", flow, "journal.md");
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the observation line", () => {
  test("a line beginning `outcome-observed:` is an observation, with its date and text", () => {
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - created\noutcome-observed: 2026-02-01 fell from 2.4s to 0.9s\n")).toEqual({
      observed: true,
      observedAt: "2026-02-01",
      note: "2026-02-01 fell from 2.4s to 0.9s",
    });
  });

  test("a line without a date is still an observation", () => {
    expect(observationFrom("outcome-observed: checked by hand")).toEqual({ observed: true, observedAt: null, note: "checked by hand" });
  });

  test("a journal with no such line records no observation", () => {
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - created\n")).toEqual({ observed: false, observedAt: null, note: null });
    expect(observationFrom(null)).toEqual({ observed: false, observedAt: null, note: null });
  });

  test("the marker must begin the line", () => {
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - outcome-observed: mentioned in passing").observed).toBe(false);
    expect(observationFrom("  outcome-observed: indented").observed).toBe(false);
    expect(observationFrom("outcome-observed").observed).toBe(false);
  });
});

describe("index and open honour the observation", () => {
  test("the index records the observation on the flow that has one", async () => {
    const index = await buildIntentIndex(await project());
    const observed = index.intents.find((intent) => intent.id === "002");
    expect(observed?.outcome.observed).toBe(true);
    expect(observed?.outcome.observedAt).toBe("2026-02-01");
    expect(index.intents.find((intent) => intent.id === "001")?.outcome.observed).toBe(false);
  });

  test("a flow with the line is not in the open list", async () => {
    const report = buildOpenReport(await buildIntentIndex(await project()));
    expect(report.entries.map((entry) => entry.id)).not.toContain("002");
  });

  test("adding the line to a journal moves that flow out of the open list and into `observed`", async () => {
    const root = await project();
    const before = buildOpenReport(await buildIntentIndex(root));
    expect(before.entries.map((entry) => entry.id)).toContain("001");
    expect(before.observed).toBe(1);

    await appendFile(journalOf(root, "001-2026-01-01-stated-outcome"), "outcome-observed: 2026-02-15 expired-token errors fell to zero\n");

    const after = buildOpenReport(await buildIntentIndex(root));
    expect(after.entries.map((entry) => entry.id)).not.toContain("001");
    expect(after.neverChecked).toBe(before.neverChecked - 1);
    expect(after.observed).toBe(2);
    expect(after.notObserved).toBe(0);
  });

  test("an observation on a flow with no stated criterion counts as observed, not as unmeasured", async () => {
    const root = await project();
    await appendFile(journalOf(root, "003-2026-01-03-no-criterion"), "outcome-observed: looked at the export usage\n");
    const report = buildOpenReport(await buildIntentIndex(root));
    expect(report.observed).toBe(2);
    expect(report.noCriterion).toBe(1);
    expect(report.entries.map((entry) => entry.id)).toEqual(["005", "001"]);
  });

  test("observations anywhere else are not read", async () => {
    const root = await project();
    await appendFile(path.join(root, ".metaproject", "flows", "001-2026-01-01-stated-outcome", "description.md"), "\noutcome-observed: 2026-02-15 not a journal\n");
    const index = await buildIntentIndex(root);
    expect(index.intents.find((intent) => intent.id === "001")?.outcome.observed).toBe(false);
  });
});
