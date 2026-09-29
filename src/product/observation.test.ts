// Flow 362, AC7: an observation is a line beginning `outcome-observed:` in the
// flow's journal.md. `index` reads it, and a flow with such a line leaves the
// `open` list.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex } from "./corpus";
import { observationFrom, observationProblem, parseVerdict } from "./extract";
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
  test("a line `outcome-observed: <verdict> — <note>` is an observation, with its verdict, date and note", () => {
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - created\noutcome-observed: helped — 2026-02-01 fell from 2.4s to 0.9s\n")).toEqual({
      observed: true,
      verdict: "helped",
      observedAt: "2026-02-01",
      note: "2026-02-01 fell from 2.4s to 0.9s",
    });
  });

  test("each of the four verdicts is read, and only those", () => {
    for (const verdict of ["helped", "no-effect", "harmed", "inconclusive"] as const) {
      expect(observationFrom(`outcome-observed: ${verdict} — checked by hand`)).toEqual({ observed: true, verdict, observedAt: null, note: "checked by hand" });
    }
    for (const verdict of ["worked", "Helped", "no effect", "noeffect", "helped-a-lot", "success"]) {
      expect(observationFrom(`outcome-observed: ${verdict} — checked by hand`).observed).toBe(false);
    }
  });

  test("the em dash and a note are required, a hyphen or a bare verdict is not an observation", () => {
    expect(parseVerdict("helped - a hyphen")).toBeNull();
    expect(parseVerdict("helped")).toBeNull();
    expect(parseVerdict("helped —")).toBeNull();
    expect(parseVerdict("helped — ")).toBeNull();
    expect(parseVerdict("harmed—no space around the dash")).toEqual({ verdict: "harmed", note: "no space around the dash" });
  });

  test("a journal with no such line records no observation", () => {
    const none = { observed: false, verdict: null, observedAt: null, note: null };
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - created\n")).toEqual(none);
    expect(observationFrom(null)).toEqual(none);
  });

  test("the marker must begin the line", () => {
    expect(observationFrom("- 2026-01-01T00:00:00.000Z - outcome-observed: helped — mentioned in passing").observed).toBe(false);
    expect(observationFrom("  outcome-observed: helped — indented").observed).toBe(false);
    expect(observationFrom("outcome-observed").observed).toBe(false);
    expect(observationProblem("- 2026-01-01T00:00:00.000Z - outcome-observed: mentioned in passing")).toBeNull();
    expect(observationProblem("  outcome-observed: indented")).toBeNull();
  });
});

describe("the observation line is fence-aware", () => {
  test("a line inside a fenced code block is ignored, and a real line after the fence is found", () => {
    const journal = "- created\n\n```\noutcome-observed: harmed — quoted example\n```\n\noutcome-observed: helped — the real one\n";
    expect(observationFrom(journal)).toEqual({ observed: true, verdict: "helped", observedAt: null, note: "the real one" });
    expect(observationProblem(journal)).toBeNull();
  });

  test("a fenced line alone is no observation and no failure, with backtick or tilde fences", () => {
    const none = { observed: false, verdict: null, observedAt: null, note: null };
    for (const fence of ["```", "~~~", "````"]) {
      const journal = `${fence}md\noutcome-observed: helped — an example\noutcome-observed: nonsense\n${fence}\n`;
      expect(observationFrom(journal)).toEqual(none);
      expect(observationProblem(journal)).toBeNull();
    }
  });

  test("a fence that is never closed hides the rest of the journal", () => {
    expect(observationFrom("```\noutcome-observed: helped — never closed\n").observed).toBe(false);
  });

  test("a fenced example does not hide a malformed real line", () => {
    const journal = "```\noutcome-observed: helped — example\n```\noutcome-observed: worked — typo\n";
    expect(observationFrom(journal).observed).toBe(false);
    expect(observationProblem(journal)).toContain("no recognized verdict");
  });
});

describe("index and open honour the observation", () => {
  test("the index records the observation on the flow that has one", async () => {
    const index = await buildIntentIndex(await project());
    const observed = index.intents.find((intent) => intent.id === "002");
    expect(observed?.outcome.observed).toBe(true);
    expect(observed?.outcome.observedAt).toBe("2026-02-01");
    expect(observed?.outcome.verdict).toBe("helped");
    expect(observed?.outcome.note).toContain("median load on the pricing page");
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

    await appendFile(journalOf(root, "001-2026-01-01-stated-outcome"), "outcome-observed: helped — 2026-02-15 expired-token errors fell to zero\n");

    const after = buildOpenReport(await buildIntentIndex(root));
    expect(after.entries.map((entry) => entry.id)).not.toContain("001");
    expect(after.neverChecked).toBe(before.neverChecked - 1);
    expect(after.observed).toBe(2);
    expect(after.notObserved).toBe(0);
    expect(after.helped).toBe(2);
  });

  test("the verdict counts partition `observed`", async () => {
    const root = await project();
    await appendFile(journalOf(root, "001-2026-01-01-stated-outcome"), "outcome-observed: harmed — 2026-02-15 errors rose\n");
    await appendFile(journalOf(root, "003-2026-01-03-no-criterion"), "outcome-observed: no-effect — usage unchanged\n");
    const { counts } = await buildIntentIndex(root);
    expect(counts).toMatchObject({ observed: 3, helped: 1, noEffect: 1, harmed: 1, inconclusive: 0 });
    expect(counts.helped + counts.noEffect + counts.harmed + counts.inconclusive).toBe(counts.observed);
  });

  test("an observation on a flow with no stated criterion counts as observed, not as unmeasured", async () => {
    const root = await project();
    await appendFile(journalOf(root, "003-2026-01-03-no-criterion"), "outcome-observed: inconclusive — looked at the export usage\n");
    const report = buildOpenReport(await buildIntentIndex(root));
    expect(report.observed).toBe(2);
    expect(report.noCriterion).toBe(1);
    expect(report.entries.map((entry) => entry.id)).toEqual(["005", "001"]);
  });

  test("observations anywhere else are not read", async () => {
    const root = await project();
    await appendFile(path.join(root, ".metaproject", "flows", "001-2026-01-01-stated-outcome", "description.md"), "\noutcome-observed: helped — 2026-02-15 not a journal\n");
    const index = await buildIntentIndex(root);
    expect(index.intents.find((intent) => intent.id === "001")?.outcome.observed).toBe(false);
  });
});
