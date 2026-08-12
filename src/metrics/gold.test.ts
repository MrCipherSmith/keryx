import { describe, expect, test } from "bun:test";
import { type CoChangeCommit, goldAffectedSet, goldTestImpact, parseGitLogNameOnly } from "./gold";

describe("goldAffectedSet", () => {
  test("threshold rule: file above both minSupport and minCoChanges is gold-affected", () => {
    // target = "a.ts" appears in 4 commits. "b.ts" co-changes in 3/4 (support 0.75 >= 0.34,
    // coChanges 3 >= 2) -> gold. "c.ts" co-changes in 1/4 (support 0.25 < 0.34) -> not gold.
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "b.ts"] },
      { sha: "2", files: ["a.ts", "b.ts", "c.ts"] },
      { sha: "3", files: ["a.ts", "b.ts"] },
      { sha: "4", files: ["a.ts", "d.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.commitsWithTarget).toBe(4);
    expect(result.affected).toEqual(["b.ts"]);
    expect(result.support["b.ts"]).toEqual({ coChanges: 3, support: 0.75 });
    expect(result.support["c.ts"]).toEqual({ coChanges: 1, support: 0.25 });
    expect(result.support["d.ts"]).toEqual({ coChanges: 1, support: 0.25 });
  });

  test("minCoChanges floor excludes a file that clears support on a single co-change", () => {
    // target changes twice; "e.ts" co-changes once -> support 0.5 (>= 0.34) but
    // coChanges 1 < minCoChanges 2 -> excluded.
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "e.ts"] },
      { sha: "2", files: ["a.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.affected).toEqual([]);
    expect(result.support["e.ts"]).toEqual({ coChanges: 1, support: 0.5 });
  });

  test("custom thresholds are honored", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "e.ts"] },
      { sha: "2", files: ["a.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 1, minSupport: 0.4 });
    expect(result.affected).toEqual(["e.ts"]);
  });

  test("empty history: no commits, no target evidence -> empty gold set", () => {
    const result = goldAffectedSet([], "a.ts");
    expect(result).toEqual({ affected: [], commitsWithTarget: 0, support: {} });
  });

  test("target with no co-changes: every commit touching target touches only target", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts"] },
      { sha: "2", files: ["a.ts"] },
      { sha: "3", files: ["b.ts", "c.ts"] }, // does not touch target, ignored
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result.commitsWithTarget).toBe(2);
    expect(result.affected).toEqual([]);
    expect(result.support).toEqual({});
  });

  test("target absent from all commits: commitsWithTarget is 0, gold set is empty", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["b.ts", "c.ts"] },
      { sha: "2", files: ["b.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts");
    expect(result).toEqual({ affected: [], commitsWithTarget: 0, support: {} });
  });

  test("duplicate file paths within one commit do not double-count co-changes", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "b.ts", "b.ts"] },
      { sha: "2", files: ["a.ts", "b.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 2, minSupport: 0.5 });
    expect(result.support["b.ts"]).toEqual({ coChanges: 2, support: 1 });
    expect(result.affected).toEqual(["b.ts"]);
  });

  test("result is sorted lexicographically", () => {
    const history: CoChangeCommit[] = [
      { sha: "1", files: ["a.ts", "z.ts", "m.ts"] },
      { sha: "2", files: ["a.ts", "z.ts", "m.ts"] },
    ];
    const result = goldAffectedSet(history, "a.ts", { minCoChanges: 1, minSupport: 0.5 });
    expect(result.affected).toEqual(["m.ts", "z.ts"]);
  });
});

describe("parseGitLogNameOnly", () => {
  test("parses multiple commits with changed files", () => {
    const output = [
      "commit aaa111",
      "",
      "src/a.ts",
      "src/b.ts",
      "commit bbb222",
      "",
      "src/c.ts",
    ].join("\n");
    expect(parseGitLogNameOnly(output)).toEqual([
      { sha: "aaa111", files: ["src/a.ts", "src/b.ts"] },
      { sha: "bbb222", files: ["src/c.ts"] },
    ]);
  });

  test("a commit with zero changed files still emits an entry with an empty files array", () => {
    const output = ["commit aaa111", "", "commit bbb222", "", "src/c.ts"].join("\n");
    expect(parseGitLogNameOnly(output)).toEqual([
      { sha: "aaa111", files: [] },
      { sha: "bbb222", files: ["src/c.ts"] },
    ]);
  });

  test("empty input yields no commits", () => {
    expect(parseGitLogNameOnly("")).toEqual([]);
  });

  test("blank lines are ignored as separators, not paths", () => {
    const output = "commit aaa111\n\n\nsrc/a.ts\n\n\n";
    expect(parseGitLogNameOnly(output)).toEqual([{ sha: "aaa111", files: ["src/a.ts"] }]);
  });
});

describe("goldTestImpact", () => {
  test("a test covering a changed file is gold-impacted", () => {
    const coverage = {
      "test/a.test.ts": ["src/a.ts", "src/util.ts"],
      "test/b.test.ts": ["src/b.ts"],
    };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual(["test/a.test.ts"]);
  });

  test("multiple impacted tests are returned sorted", () => {
    const coverage = {
      "test/z.test.ts": ["src/a.ts"],
      "test/a.test.ts": ["src/a.ts"],
      "test/unrelated.test.ts": ["src/other.ts"],
    };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual(["test/a.test.ts", "test/z.test.ts"]);
  });

  test("empty coverage map yields no impacted tests", () => {
    expect(goldTestImpact({}, ["src/a.ts"])).toEqual([]);
  });

  test("empty changed-files list yields no impacted tests", () => {
    const coverage = { "test/a.test.ts": ["src/a.ts"] };
    expect(goldTestImpact(coverage, [])).toEqual([]);
  });

  test("a test covering zero files never appears in the result", () => {
    const coverage = { "test/empty.test.ts": [] };
    expect(goldTestImpact(coverage, ["src/a.ts"])).toEqual([]);
  });

  test("duplicate changed-file entries do not change the result", () => {
    const coverage = { "test/a.test.ts": ["src/a.ts"] };
    expect(goldTestImpact(coverage, ["src/a.ts", "src/a.ts"])).toEqual(["test/a.test.ts"]);
  });
});
