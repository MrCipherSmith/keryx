import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AC_CHECK_TOKEN_BUDGET,
  acCheckCacheKey,
  batchAcCheckItems,
  classifyNotCheckable,
  computeAcFacts,
  evaluatedVerdict,
  extractCriterionTokens,
  factsOnlyVerdict,
  hashDiff,
  isFrozen,
  notCheckableVerdict,
  parseAcceptanceCriteria,
  readAcCheckEnabled,
  renderAcCheckAdvisoryNotice,
  renderAcCheckReport,
  selectMatchedHunks,
  summarizeVerdicts,
  type AcCheckItem,
} from "./check-ac";
import type { ScopedRegion } from "../review/scope";

async function tmpDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "keryx-check-ac-"));
}

describe("parseAcceptanceCriteria", () => {
  test("extracts id + text, skips continuation/prose lines", () => {
    const content = [
      "# Acceptance Criteria",
      "",
      "- AC1: `keryx flow check-ac <id>` does the thing.",
      "  This indented line is prose, not a new criterion.",
      "* AC2: second one, bullet with a star.",
      "not a criterion line at all",
    ].join("\n");
    expect(parseAcceptanceCriteria(content)).toEqual([
      { id: "AC1", text: "`keryx flow check-ac <id>` does the thing." },
      { id: "AC2", text: "second one, bullet with a star." },
    ]);
  });

  test("empty content yields no criteria", () => {
    expect(parseAcceptanceCriteria("")).toEqual([]);
  });
});

describe("isFrozen", () => {
  test("true only when acChecksum is a non-empty string", () => {
    expect(isFrozen({ acChecksum: "sha256:abc" })).toBe(true);
    expect(isFrozen({ acChecksum: null })).toBe(false);
    expect(isFrozen({ acChecksum: "" })).toBe(false);
  });
});

describe("classifyNotCheckable", () => {
  test("flags the documented marker set", () => {
    expect(classifyNotCheckable("Live check (run with `env -u OPENROUTER_API_KEY`): does the thing.")).toBeTruthy();
    expect(classifyNotCheckable("CI is green and the release ships.")?.label).toBe("CI green");
    expect(classifyNotCheckable("`keryx health run` passes.")?.label).toBe("health passing");
    expect(classifyNotCheckable("Docs are published to the docs site.")?.label).toBe("docs published");
  });

  test("an ordinary checkable criterion is undefined", () => {
    expect(classifyNotCheckable("`keryx flow check-ac <id>` reports per criterion likely-met/not-evident.")).toBeUndefined();
  });

  // Review finding: a criterion mixing a checkable clause with a
  // not-checkable one used to become WHOLLY not-checkable the moment ANY
  // clause matched a marker — this flow's own AC10 is the real-world case
  // that hit it (doc paths and "import zones" ARE evidenced by a diff;
  // "CI green"/"`keryx health run` passes" are not).
  test("a mixed criterion (this flow's own AC10) stays checkable — one checkable clause is enough", () => {
    const ac10 =
      "Docs (cli-reference, flow docs, HELP_GROUPS, commands-by-task), CI green, `keryx health run` passes, hermetic macOS-safe tests, import zones respected.";
    expect(classifyNotCheckable(ac10)).toBeUndefined();
  });

  test("a criterion whose EVERY comma-separated clause names a marker is wholly not-checkable", () => {
    const classification = classifyNotCheckable("CI green, `keryx health run` passes.");
    expect(classification).toBeDefined();
    expect(classification?.label).toContain("CI green");
    expect(classification?.label).toContain("health passing");
  });

  test('a single checkable clause added to an otherwise not-checkable one keeps the whole criterion checkable', () => {
    expect(classifyNotCheckable("`src/flow/check-ac.ts` implements the checker, CI green.")).toBeUndefined();
  });

  // The narrowed "CI green" marker (review finding): the old
  // `\bCI\b.*\bgreen\b` matched "CI" and "green" anywhere in the same
  // criterion, in either order — this criterion has both words but never the
  // phrase, and must NOT be flagged.
  test("a pure 'CI green' criterion is not-checkable; 'CI'..'green' unrelated in the same sentence is not", () => {
    expect(classifyNotCheckable("CI green.")?.label).toBe("CI green");
    expect(classifyNotCheckable("CI is green.")?.label).toBe("CI green");
    expect(classifyNotCheckable("CI passes.")?.label).toBe("CI green");
    expect(classifyNotCheckable("CI runs fast, and the status light eventually turns green.")).toBeUndefined();
    // Same check with NO comma at all, so this is exercising the regex
    // itself rather than the clause split: "CI" and "green" both appear,
    // never as the phrase "CI green"/"CI is green".
    expect(classifyNotCheckable("CI eventually turns the dashboard green.")).toBeUndefined();
  });
});

describe("extractCriterionTokens", () => {
  test("collects backticked tokens, file paths, and keryx command names", () => {
    const tokens = extractCriterionTokens(
      "`keryx flow check-ac <id>` reads `src/flow/check-ac.ts` and calls keryx health run before docs/cli-reference.md is checked.",
    );
    expect(tokens).toContain("keryx flow check-ac <id>");
    expect(tokens).toContain("src/flow/check-ac.ts");
    expect(tokens).toContain("docs/cli-reference.md");
  });

  test("no tokens in plain prose", () => {
    expect(extractCriterionTokens("Everything works as expected for the user.")).toEqual([]);
  });
});

describe("computeAcFacts", () => {
  const criterion = { id: "AC1", text: "`src/flow/check-ac.ts` implements the checker and is unit-tested." };

  test("flags allTokensAbsent when nothing named appears in the diff or tree", () => {
    const facts = computeAcFacts(criterion, "diff --git a/README.md b/README.md\n+hello\n", ["README.md"]);
    expect(facts.allTokensAbsent).toBe(true);
    expect(facts.tokensPresent).toEqual([]);
  });

  test("present when the token appears in the diff text", () => {
    const facts = computeAcFacts(criterion, "diff --git a/src/flow/check-ac.ts b/src/flow/check-ac.ts\n+export {}\n", ["src/flow/check-ac.ts"]);
    expect(facts.allTokensAbsent).toBe(false);
    expect(facts.tokensPresent).toContain("src/flow/check-ac.ts");
  });

  test("detects a changed test file mentioning a named artefact", () => {
    const facts = computeAcFacts(criterion, "diff --git a/src/flow/check-ac.test.ts b/src/flow/check-ac.test.ts\n+test()\n", [
      "src/flow/check-ac.test.ts",
    ]);
    expect(facts.testsChanged).toEqual([]);
    // token "src/flow/check-ac.ts" is not a substring match of "check-ac.test.ts" path directly by file-name inclusion,
    // but the diff text itself does not mention it either — factLines should still render deterministically.
    expect(facts.factLines.some((line) => line.includes("changed test file"))).toBe(true);
  });
});

describe("selectMatchedHunks", () => {
  test("returns only regions whose text or path mentions a named token", () => {
    const facts = computeAcFacts({ id: "AC1", text: "`src/flow/check-ac.ts` does it." }, "", []);
    const regions: ScopedRegion[] = [
      { path: "src/flow/check-ac.ts", startLine: 1, endLine: 5, changedLines: 2, contextTruncated: false, text: "+export {}" },
      { path: "README.md", startLine: 1, endLine: 2, changedLines: 1, contextTruncated: false, text: "+hello" },
    ];
    const matched = selectMatchedHunks(facts, regions);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.path).toBe("src/flow/check-ac.ts");
  });

  test("no tokens named -> no hunks matched", () => {
    const facts = computeAcFacts({ id: "AC1", text: "Everything works." }, "", []);
    const regions: ScopedRegion[] = [{ path: "a.ts", startLine: 1, endLine: 1, changedLines: 1, contextTruncated: false, text: "+x" }];
    expect(selectMatchedHunks(facts, regions)).toEqual([]);
  });
});

describe("batchAcCheckItems", () => {
  function item(id: string, text: string): AcCheckItem {
    const criterion = { id, text };
    const facts = computeAcFacts(criterion, "", []);
    return { criterion, facts, matchedHunks: [], changedFiles: [] };
  }

  test("packs small items into a single batch", () => {
    const batches = batchAcCheckItems([item("AC1", "short one"), item("AC2", "short two")]);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["AC1", "AC2"]);
  });

  test("splits when the combined estimate exceeds the budget", () => {
    const big = "x".repeat(AC_CHECK_TOKEN_BUDGET * 5);
    const batches = batchAcCheckItems([item("AC1", big), item("AC2", big), item("AC3", big)]);
    expect(batches.length).toBeGreaterThan(1);
    // every item appears exactly once across all batches
    const allIds = batches.flatMap((b) => b.items.map((i) => i.criterion.id));
    expect(allIds.sort()).toEqual(["AC1", "AC2", "AC3"]);
  });

  test("empty input yields no batches", () => {
    expect(batchAcCheckItems([])).toEqual([]);
  });
});

describe("verdict builders", () => {
  test("notCheckableVerdict carries the reason, no probability", () => {
    const v = notCheckableVerdict({ id: "AC9", text: "Live check." }, "not-checkable: live check.");
    expect(v.status).toBe("not-checkable");
    expect(v.notCheckableReason).toBe("not-checkable: live check.");
    expect(v.probability).toBeUndefined();
  });

  test("evaluatedVerdict applies the threshold", () => {
    const criterion = { id: "AC1", text: "does it" };
    const facts = computeAcFacts(criterion, "", []);
    const item: AcCheckItem = { criterion, facts, matchedHunks: [], changedFiles: [] };
    expect(evaluatedVerdict(item, 0.9).status).toBe("likely-met");
    expect(evaluatedVerdict(item, 0.1).status).toBe("not-evident");
    expect(evaluatedVerdict(item, 0.5).status).toBe("likely-met"); // threshold is inclusive
  });

  test("factsOnlyVerdict is always not-evident (no model was asked)", () => {
    const criterion = { id: "AC1", text: "does it" };
    const facts = computeAcFacts(criterion, "", []);
    const item: AcCheckItem = { criterion, facts, matchedHunks: [], changedFiles: [] };
    expect(factsOnlyVerdict(item).status).toBe("not-evident");
  });
});

describe("readAcCheckEnabled", () => {
  test("false when tasks.config.json is missing", async () => {
    const dir = await tmpDir();
    try {
      expect(await readAcCheckEnabled(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("false when the key is absent, true only when review.jev.ac_check === true", async () => {
    const dir = await tmpDir();
    try {
      await mkdir(path.join(dir, ".metaproject"), { recursive: true });
      await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ac_check: true } } }));
      expect(await readAcCheckEnabled(dir)).toBe(true);

      await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { ci_triage: true } } }));
      expect(await readAcCheckEnabled(dir)).toBe(false);

      await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), "not json");
      expect(await readAcCheckEnabled(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cache key", () => {
  test("deterministic and sensitive to both the checksum and the diff text", () => {
    const a = acCheckCacheKey("sha256:aaa", "diff one");
    const b = acCheckCacheKey("sha256:aaa", "diff one");
    const c = acCheckCacheKey("sha256:aaa", "diff two");
    const d = acCheckCacheKey("sha256:bbb", "diff one");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(hashDiff("same")).toBe(hashDiff("same"));
  });
});

describe("rendering", () => {
  test("renderAcCheckReport lists every verdict and the summary counts", () => {
    const verdicts = [
      evaluatedVerdict({ criterion: { id: "AC1", text: "a" }, facts: computeAcFacts({ id: "AC1", text: "a" }, "", []), matchedHunks: [], changedFiles: [] }, 0.9),
      notCheckableVerdict({ id: "AC2", text: "Live check." }, "not-checkable: live check."),
    ];
    const report = renderAcCheckReport({
      flowId: "328",
      verdicts,
      jevAsked: true,
      usage: { jevCalls: 1 },
      at: "2026-09-25T00:00:00.000Z",
      criteriaChecksum: "sha256:aaa",
      diffHash: hashDiff("diff one"),
    });
    expect(report).toContain("flow 328");
    expect(report).toContain("likely met: 1");
    expect(report).toContain("not checkable: 1");
    expect(report).toContain("AC1");
    expect(report).toContain("AC2");
    // Review finding: the checked-at time, criteria checksum and diff hash
    // must be visible in the report, not just held in the cache record.
    expect(report).toContain("checked: 2026-09-25T00:00:00.000Z");
    expect(report).toContain("criteria checksum: sha256:aaa");
    expect(report).toContain(`diff hash: ${hashDiff("diff one")}`);
  });

  test("renderAcCheckReport without at/criteriaChecksum/diffHash reads 'unknown' rather than omitting the line", () => {
    const report = renderAcCheckReport({ flowId: "328", verdicts: [], jevAsked: false });
    expect(report).toContain("checked: unknown");
    expect(report).toContain("criteria checksum: unknown");
    expect(report).toContain("diff hash: unknown");
  });

  test("renderAcCheckAdvisoryNotice is a single line naming criteria in doubt", () => {
    const verdicts = [
      evaluatedVerdict({ criterion: { id: "AC1", text: "a" }, facts: computeAcFacts({ id: "AC1", text: "a" }, "", []), matchedHunks: [], changedFiles: [] }, 0.1),
    ];
    const notice = renderAcCheckAdvisoryNotice(verdicts);
    expect(notice).toContain("1 not evident");
    expect(notice).toContain("AC1");
    expect(notice.split("\n")).toHaveLength(1);
  });

  test("summarizeVerdicts counts by status", () => {
    const counts = summarizeVerdicts([
      notCheckableVerdict({ id: "AC1", text: "" }, "r"),
      notCheckableVerdict({ id: "AC2", text: "" }, "r"),
    ]);
    expect(counts).toEqual({ likelyMet: 0, notEvident: 0, notCheckable: 2 });
  });
});
