import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classify, outcome, renderReplayReport, replayRaw, replayRepository } from "./replay";

const T = "`".repeat(3);
const result = (extra = "") =>
  `{"status":"DONE","reviewer":"review-logic","findings":[{"id":"F-1","note":${JSON.stringify(extra)}}]}`;

describe("replayRaw", () => {
  test("a plain labelled fence parses the same under both parsers", () => {
    const row = replayRaw("a.txt", `${T}REVIEW_RESULT\n${result()}\n${T}\n`);
    expect(row.same).toBe(true);
    expect(row.cause).toBe("none");
    expect(row.old).toBe("review-logic|DONE|f=1|reviewer-result=true");
    expect(row.next).toBe(row.old);
  });

  test("a triple backtick inside the JSON cut the old lazy fence and is now read whole", () => {
    const row = replayRaw("a.txt", `${T}REVIEW_RESULT\n${result(`quotes ${T}js fence`)}\n${T}\n`);
    expect(row.same).toBe(false);
    expect(row.old).toBe("none");
    expect(row.next).toBe("review-logic|DONE|f=1|reviewer-result=true");
    expect(row.cause).toBe("fence-inner-backticks");
  });

  test("a status-only object was a result before and is no result now", () => {
    const row = replayRaw("v.txt", `${T}json\n{"status":"DONE","verifier":"review-verifier"}\n${T}\n`);
    expect(row.same).toBe(false);
    expect(row.old).toBe("-|DONE|f=-|reviewer-result=false");
    expect(row.next).toBe("none");
    expect(row.cause).toBe("status-only-fragment");
  });

  test("two bare results with different statuses are a difference the classifier does not explain", () => {
    const first = result();
    const second = first.replace('"DONE"', '"BLOCKED"');
    const row = replayRaw("c.txt", `${first}\n\nand then\n\n${second}\n`);
    expect(row.same).toBe(false);
    expect(row.cause).toBe("unclassified");
  });

  test("an empty output is the same under both parsers", () => {
    const row = replayRaw("e.txt", "");
    expect(row.same).toBe(true);
    expect(row.old).toBe("empty");
  });

  test("the hash identifies the content, not the path", () => {
    const body = `${T}REVIEW_RESULT\n${result()}\n${T}\n`;
    expect(replayRaw("a.txt", body).hash).toBe(replayRaw("b.txt", body).hash);
    expect(replayRaw("a.txt", body).hash).not.toBe(replayRaw("a.txt", `${body} `).hash);
    expect(replayRaw("a.txt", body).hash).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("classify", () => {
  const reviewerResult = { status: "DONE", reviewer: "r", findings: [] };
  test("a new result with no labelled fence behind an old none is not explained", () => {
    expect(classify("plain text", undefined, reviewerResult)).toBe("unclassified");
  });
  test("a new result behind a labelled fence whose JSON parses is not explained", () => {
    expect(classify(`${T}REVIEW_RESULT\n{}\n${T}\n`, undefined, reviewerResult)).toBe("unclassified");
  });
  test("only the last labelled fence decides whether the lazy capture was broken", () => {
    const raw = `${T}REVIEW_RESULT\n{"status":"DONE"}\n${T}\n\n${T}REVIEW_RESULT\n${result(`x ${T}y`)}\n${T}\n`;
    expect(classify(raw, undefined, reviewerResult)).toBe("fence-inner-backticks");
  });
  test("a broken fence explains nothing when the old parser did find a result or the new one found none", () => {
    const broken = `${T}REVIEW_RESULT\n${result(`x ${T}y`)}\n${T}\n`;
    expect(classify(broken, { status: "DONE" }, reviewerResult)).toBe("unclassified");
    expect(classify(broken, undefined, undefined)).toBe("unclassified");
  });
  test("an old reviewer result that vanished is not a status-only fragment", () => {
    expect(classify("", reviewerResult, undefined)).toBe("unclassified");
  });
  test("an old status-only fragment that kept a new result is not explained as a fragment", () => {
    expect(classify("", { status: "DONE" }, reviewerResult)).toBe("unclassified");
  });
});

describe("outcome", () => {
  test("names an absent findings array with a dash and counts a present one", () => {
    expect(outcome({ status: "DONE" }, false)).toBe("-|DONE|f=-|reviewer-result=false");
    expect(outcome({ status: "DONE", reviewer: "r", findings: [] }, false)).toBe("r|DONE|f=0|reviewer-result=true");
    expect(outcome(undefined, false)).toBe("none");
    expect(outcome(undefined, true)).toBe("empty");
  });
});

describe("renderReplayReport", () => {
  test("lists differences with an undecided decision and counts both groups", () => {
    const rows = [
      replayRaw("same.txt", `${T}REVIEW_RESULT\n${result()}\n${T}\n`),
      replayRaw("diff.txt", `${T}REVIEW_RESULT\n${result(`x ${T}y`)}\n${T}\n`),
    ];
    const report = renderReplayReport(rows);
    expect(report).toContain("Files replayed: 2. Same: 1. Differences: 1.");
    expect(report).toMatch(/\| diff\.txt \| [0-9a-f]{12} \| none \| review-logic\|DONE\|f=1\|reviewer-result=true \| fence-inner-backticks \| undecided \|/);
    expect(report).toContain("- same.txt (");
    expect(report).not.toMatch(/\| same\.txt \|/);
  });
});

describe("replayRepository", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "keryx-replay-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const put = (relative: string, body: string) => {
    mkdirSync(path.dirname(path.join(tmp, relative)), { recursive: true });
    writeFileSync(path.join(tmp, relative), body, "utf8");
  };
  const reply = `${T}REVIEW_RESULT\n${result()}\n${T}\n`;

  test("a repository without review directories has nothing to replay", () => {
    expect(replayRepository(tmp)).toEqual([]);
  });

  test("walks flows and data/review, keeps only .txt replies, orders by path, and skips drivers and research-evidence", () => {
    for (const name of ["m", "c", "x", "a", "q", "f"]) put(`.metaproject/flows/${name}/reviews/r1/raw/review-${name}.txt`, reply);
    put(".metaproject/flows/a/reviews/r1/raw/notes.md", reply);
    put(".metaproject/flows/a/reviews/r1/drivers/raw/review-driver.txt", reply);
    put(".metaproject/flows/a/reviews/r1/research-evidence/raw/review-evidence.txt", reply);
    put(".metaproject/data/review/r3/raw/architecture.txt", reply);
    put("src/raw/review-outside.txt", reply);
    const files = replayRepository(tmp).map((row) => row.file);
    expect(files).toEqual([
      ".metaproject/data/review/r3/raw/architecture.txt",
      ...["a", "c", "f", "m", "q", "x"].map((name) => `.metaproject/flows/${name}/reviews/r1/raw/review-${name}.txt`),
    ]);
  });
});

describe("closed review rounds of this repository", () => {
  const root = path.resolve(import.meta.dir, "..", "..");
  const reportPath = path.join(root, ".metaproject", "flows", "441-2026-10-13-deferred-majors-of-pr-940-and-pr-975", "replay-report.md");

  test("every tracked raw reply is replayed and the checked-in report lists exactly the differences", () => {
    const rows = replayRepository(root);
    expect(rows.length).toBeGreaterThan(0);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toBe(renderReplayReport(rows));
  });

  test("no difference is left unexplained by the classifier", () => {
    const unexplained = replayRepository(root).filter((row) => !row.same && row.cause === "unclassified");
    expect(unexplained.map((row) => row.file)).toEqual([]);
  });
});
