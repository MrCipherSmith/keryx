import { describe, expect, test } from "bun:test";
import {
  CORE_MANDATORY_REVIEWER_IDS,
  allKeptFailOpen,
  batchSelectQuestions,
  buildJevSelectState,
  decideCandidates,
  isCoreMandatoryReviewer,
  summarizeDecisions,
  summarizeDiffForSelect,
  upsertJevSelectBlock,
  type ReviewerCandidate,
} from "./jev-select";
import type { ScopedRegion } from "./scope";

const CANDIDATES: ReviewerCandidate[] = [
  { id: "review-logic", description: "logic correctness" },
  { id: "review-security-code", description: "security" },
  { id: "review-style", description: "naming/readability" },
  { id: "review-performance", description: "hot paths" },
];

describe("CORE_MANDATORY_REVIEWER_IDS / isCoreMandatoryReviewer", () => {
  test("names Wave A's core correctness/risk set", () => {
    expect(CORE_MANDATORY_REVIEWER_IDS).toEqual(["review-logic", "review-architecture", "review-security-code", "review-highload"]);
    expect(isCoreMandatoryReviewer("review-logic")).toBe(true);
    expect(isCoreMandatoryReviewer("review-security-code")).toBe(true);
    expect(isCoreMandatoryReviewer("review-style")).toBe(false);
  });
});

describe("decideCandidates", () => {
  test("never skips the core mandatory set, even at probability 0", () => {
    const answers = new Map<string, number>([
      ["review-logic", 0],
      ["review-security-code", 0.01],
      ["review-style", 0.5],
      ["review-performance", 0.01],
    ]);
    const decisions = decideCandidates(CANDIDATES, answers, 0.15);
    const logic = decisions.find((d) => d.reviewer === "review-logic")!;
    const security = decisions.find((d) => d.reviewer === "review-security-code")!;
    const perf = decisions.find((d) => d.reviewer === "review-performance")!;
    const style = decisions.find((d) => d.reviewer === "review-style")!;
    expect(logic.decision).toBe("keep");
    expect(logic.reason).toContain("core safety set");
    expect(security.decision).toBe("keep");
    expect(perf.decision).toBe("skip");
    expect(style.decision).toBe("keep");
  });

  test("skips only strictly below the threshold, never at or above it", () => {
    const answers = new Map<string, number>([["review-style", 0.15]]);
    const decisions = decideCandidates([{ id: "review-style" }], answers, 0.15);
    expect(decisions[0]!.decision).toBe("keep");
  });

  test("a candidate with no answer at all is kept, fail-open, with the given reason", () => {
    const decisions = decideCandidates([{ id: "review-performance" }], new Map(), 0.15, "custom fail-open reason");
    expect(decisions[0]!.decision).toBe("keep");
    expect(decisions[0]!.reason).toBe("custom fail-open reason");
  });
});

describe("allKeptFailOpen", () => {
  test("keeps every candidate with the same reason, regardless of mandatory status", () => {
    const decisions = allKeptFailOpen(CANDIDATES, "disabled");
    expect(decisions).toHaveLength(CANDIDATES.length);
    expect(decisions.every((d) => d.decision === "keep" && d.reason === "disabled")).toBe(true);
  });
});

describe("summarizeDecisions", () => {
  test("counts kept/skipped correctly", () => {
    const decisions = decideCandidates(
      CANDIDATES,
      new Map([
        ["review-style", 0.5],
        ["review-performance", 0.01],
      ]),
      0.15,
    );
    const result = summarizeDecisions(decisions, 0.15);
    expect(result.summary).toContain("4 candidate(s) scored");
    expect(result.summary).toContain("3 kept");
    expect(result.summary).toContain("1 skipped");
  });
});

describe("summarizeDiffForSelect", () => {
  const regions: ScopedRegion[] = [
    { path: "src/a.ts", startLine: 1, endLine: 3, changedLines: 2, contextTruncated: false, text: "+a" },
    { path: "src/b.tsx", startLine: 5, endLine: 8, changedLines: 1, contextTruncated: false, text: "+b" },
  ];

  test("collects file types and samples hunks within budget", () => {
    const summary = summarizeDiffForSelect(regions, ["src/a.ts", "src/b.tsx"], 10_000);
    expect([...summary.fileTypes].sort()).toEqual([".ts", ".tsx"]);
    expect(summary.hunksRetained).toBe(2);
    expect(summary.hunksTotal).toBe(2);
    expect(summary.sampleHunks).toHaveLength(2);
  });

  test("a zero budget retains no hunks but still reports the total", () => {
    const summary = summarizeDiffForSelect(regions, ["src/a.ts", "src/b.tsx"], 0);
    expect(summary.hunksRetained).toBe(0);
    expect(summary.hunksTotal).toBe(2);
    expect(summary.sampleHunks).toHaveLength(0);
  });
});

describe("buildJevSelectState", () => {
  test("names files, file types, and sample count", () => {
    const state = buildJevSelectState({
      files: ["src/a.ts"],
      fileTypes: [".ts"],
      sampleHunks: ["src/a.ts:1-2\n+a"],
      hunksRetained: 1,
      hunksTotal: 1,
    });
    expect(state).toContain("files changed: 1");
    expect(state).toContain("src/a.ts");
  });
});

describe("batchSelectQuestions", () => {
  test("puts every candidate in one batch when the budget is generous", () => {
    const batches = batchSelectQuestions(CANDIDATES, "state", 64_000);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toHaveLength(CANDIDATES.length);
  });

  test("splits into multiple batches under a tight budget, covering every candidate exactly once", () => {
    const batches = batchSelectQuestions(CANDIDATES, "state", 40);
    expect(batches.length).toBeGreaterThan(1);
    const seen = batches.flatMap((batch) => batch.candidates.map((c) => c.id));
    expect(new Set(seen)).toEqual(new Set(CANDIDATES.map((c) => c.id)));
    expect(seen).toHaveLength(CANDIDATES.length);
  });
});

describe("upsertJevSelectBlock", () => {
  test("appends the block to empty text", () => {
    const result = upsertJevSelectBlock("", "## Jev reviewer selection (advisory)\n\nfoo\n");
    expect(result).toContain("## Jev reviewer selection (advisory)");
    expect(result).toContain("foo");
  });

  test("replaces a pre-existing block rather than adding a second one", () => {
    const first = upsertJevSelectBlock("", "## Jev reviewer selection (advisory)\n\nfirst\n");
    const second = upsertJevSelectBlock(first, "## Jev reviewer selection (advisory)\n\nsecond\n");
    expect(second.match(/## Jev reviewer selection \(advisory\)/g)).toHaveLength(1);
    expect(second).toContain("second");
    expect(second).not.toContain("first");
  });

  test("preserves other sections in the file", () => {
    const existing = "## Other section\n\nkeep me\n\n## Jev reviewer selection (advisory)\n\nold\n";
    const result = upsertJevSelectBlock(existing, "## Jev reviewer selection (advisory)\n\nnew\n");
    expect(result).toContain("## Other section");
    expect(result).toContain("keep me");
    expect(result).toContain("new");
    expect(result).not.toContain("old");
  });
});
