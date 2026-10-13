import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { legacyParseReviewResult } from "./legacy-result-parser";
import { classify, DECISIONS, decisionFor, decisionKey, outcome, renderReplayReport, REPORT_PATH, replayRaw, replayReport, replayRepository } from "./replay";

const T = "`".repeat(3);
const gitEnv = withoutGitDiscoveryOverrides(process.env);
const git = (dir: string, ...args: string[]) => {
  const run = spawnSync(
    "git",
    ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
    { encoding: "utf8", env: gitEnv },
  );
  expect(run.status).toBe(0);
};
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

  test("the same outcome string with different content is still a difference", () => {
    const row = replayRaw("d.txt", "x", {
      old: () => ({ status: "DONE", reviewer: "r", findings: [{ id: "F-1" }] }),
      next: () => ({ status: "DONE", reviewer: "r", findings: [{ id: "F-2" }] }),
    });
    expect(row.old).toBe(row.next);
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
  test("lists differences with the decision recorded for their cause and counts both groups", () => {
    const rows = [
      replayRaw("same.txt", `${T}REVIEW_RESULT\n${result()}\n${T}\n`),
      replayRaw("diff.txt", `${T}REVIEW_RESULT\n${result(`x ${T}y`)}\n${T}\n`),
      replayRaw("v.txt", `${T}json\n{"status":"DONE","verifier":"review-verifier"}\n${T}\n`),
    ];
    const decisions = { [decisionKey(rows[1]!)]: "accepted (test one)", [decisionKey(rows[2]!)]: "accepted (test two)" };
    const report = renderReplayReport(rows, decisions);
    expect(report).toContain("Files replayed: 3. Same: 1. Differences: 2.");
    expect(report).toMatch(/\| diff\.txt \| [0-9a-f]{12} \| none \| review-logic\\\|DONE\\\|f=1\\\|reviewer-result=true \| fence-inner-backticks \| accepted \(test one\) \|/);
    expect(report).toMatch(/\| v\.txt \| [0-9a-f]{12} \| -\\\|DONE\\\|f=-\\\|reviewer-result=false \| none \| status-only-fragment \| accepted \(test two\) \|/);
    expect(report).toContain("- same.txt (");
    expect(report).not.toMatch(/\| same\.txt \|/);
  });

  test("a difference whose file and hash are not in the decision table stays undecided, whatever its cause", () => {
    const rows = [replayRaw("diff.txt", `${T}REVIEW_RESULT\n${result(`x ${T}y`)}\n${T}\n`)];
    expect(rows[0]!.cause).toBe("fence-inner-backticks");
    expect(renderReplayReport(rows, {})).toMatch(/\| diff\.txt \| [0-9a-f]{12} \| .* \| fence-inner-backticks \| undecided \|/);
    expect(renderReplayReport(rows, { "diff.txt@000000000000": "accepted (other hash)" })).toContain("| undecided |");
  });

  test("a difference the classifier does not explain stays undecided", () => {
    const first = result();
    const rows = [replayRaw("c.txt", `${first}\n\nand then\n\n${first.replace('"DONE"', '"BLOCKED"')}\n`)];
    expect(renderReplayReport(rows)).toMatch(/\| c\.txt \| [0-9a-f]{12} \| .* \| unclassified \| undecided \|/);
  });

  test("names the package whose raws are not on main", () => {
    expect(renderReplayReport([])).toContain("2026-10-13-pr-992-round3-d20089aa");
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

  const lay = () => {
    for (const name of ["m", "c", "x", "a", "q", "f"]) put(`.metaproject/flows/${name}/reviews/r1/raw/review-${name}.txt`, reply);
    put(".metaproject/flows/a/reviews/r1/raw/notes.md", reply);
    put(".metaproject/flows/a/reviews/r1/drivers/raw/review-driver.txt", reply);
    put(".metaproject/flows/a/reviews/r1/research-evidence/raw/review-evidence.txt", reply);
    put(".metaproject/flows/a/node_modules/raw/review-module.txt", reply);
    put(".metaproject/flows/a/reviews/r1/raw/nested/raw/review-nested.txt", reply);
    put(".metaproject/flows/a/reviews/r1/raw/nested/review-below.txt", reply);
    put(".metaproject/data/review/r3/raw/architecture.txt", reply);
    put("src/raw/review-outside.txt", reply);
  };
  const expectedFlowFiles = ["a", "c", "f", "m", "q", "x"].map((name) => `.metaproject/flows/${name}/reviews/r1/raw/review-${name}.txt`);

  test("outside a git checkout it walks the flows, keeps only .txt replies in a raw directory, orders by path, and skips drivers, research-evidence and node_modules", () => {
    lay();
    expect(replayRepository(tmp).map((row) => row.file)).toEqual(expectedFlowFiles);
  });

  test("does not follow a symbolic link to a directory or replay a symbolic link to a file", () => {
    lay();
    symlinkSync(path.join(tmp, ".metaproject/flows"), path.join(tmp, ".metaproject/flows/a/loop"));
    symlinkSync(path.join(tmp, ".metaproject/flows/a/reviews/r1/raw/review-a.txt"), path.join(tmp, ".metaproject/flows/a/reviews/r1/raw/link.txt"));
    expect(replayRepository(tmp).map((row) => row.file)).toEqual(expectedFlowFiles);
  });

  test("inside a git checkout it replays tracked files only and leaves out untracked, ignored and non-flows ones", () => {
    lay();
    put(".gitignore", ".metaproject/flows/q/\n");
    symlinkSync("review-a.txt", path.join(tmp, ".metaproject/flows/a/reviews/r1/raw/tracked-link.txt"));
    git(tmp, "init", "-q");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "tracked");
    put(".metaproject/flows/z/reviews/r1/raw/review-z.txt", reply);
    put(".metaproject/data/review/r4/raw/local.txt", reply);
    const files = replayRepository(tmp).map((row) => row.file);
    expect(files).not.toContain(".metaproject/flows/z/reviews/r1/raw/review-z.txt");
    expect(files).not.toContain(".metaproject/data/review/r4/raw/local.txt");
    expect(files).toEqual(expectedFlowFiles.filter((file) => !file.includes("/q/")));
  });

  test("a root below the top of a git checkout is walked, not read from the checkout's index", () => {
    git(tmp, "init", "-q");
    const sub = path.join(tmp, "sub");
    mkdirSync(path.join(sub, ".metaproject/flows/a/reviews/r1/raw"), { recursive: true });
    writeFileSync(path.join(sub, ".metaproject/flows/a/reviews/r1/raw/review-a.txt"), reply, "utf8");
    expect(replayRepository(sub).map((row) => row.file)).toEqual([".metaproject/flows/a/reviews/r1/raw/review-a.txt"]);
  });

  const commitLaid = () => {
    lay();
    git(tmp, "init", "-q");
    git(tmp, "add", "-A");
    git(tmp, "commit", "-q", "-m", "tracked");
  };

  test("a tracked reply deleted from the working tree but not staged is skipped, not an error", () => {
    commitLaid();
    rmSync(path.join(tmp, ".metaproject/flows/m/reviews/r1/raw/review-m.txt"));
    expect(replayRepository(tmp).map((row) => row.file)).toEqual(expectedFlowFiles.filter((file) => !file.includes("/m/")));
  });

  test("a failing git ls-files inside a checkout is an error, not a silent walk of untracked files", () => {
    commitLaid();
    put(".metaproject/flows/z/reviews/r1/raw/review-z.txt", reply);
    writeFileSync(path.join(tmp, ".git", "index"), "not an index", "utf8");
    expect(() => replayRepository(tmp)).toThrow("git ls-files failed");
  });

  test("a directory replaced by a symbolic link to a place outside the root is not read, in git mode", () => {
    commitLaid();
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-replay-outside-"));
    try {
      mkdirSync(path.join(outside, "reviews/r1/raw"), { recursive: true });
      writeFileSync(path.join(outside, "reviews/r1/raw/review-m.txt"), reply, "utf8");
      rmSync(path.join(tmp, ".metaproject/flows/m"), { recursive: true });
      symlinkSync(outside, path.join(tmp, ".metaproject/flows/m"));
      expect(replayRepository(tmp).map((row) => row.file)).toEqual(expectedFlowFiles.filter((file) => !file.includes("/m/")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a flows directory that is itself a symbolic link to a place outside the root is not read, in walk mode", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-replay-outside-"));
    try {
      mkdirSync(path.join(outside, "a/reviews/r1/raw"), { recursive: true });
      writeFileSync(path.join(outside, "a/reviews/r1/raw/review-a.txt"), reply, "utf8");
      mkdirSync(path.join(tmp, ".metaproject"), { recursive: true });
      symlinkSync(outside, path.join(tmp, ".metaproject/flows"));
      expect(replayRepository(tmp)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("replayReport refuses a root with nothing to replay", () => {
    expect(() => replayReport(tmp)).toThrow("no tracked raw reviewer replies");
  });
});

describe("the replay command", () => {
  test("run from another directory it replays this repository, not the working directory, and writes the report", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "keryx-replay-cwd-"));
    try {
      const script = path.resolve(import.meta.dir, "replay.ts");
      const out = path.join(cwd, "out.md");
      const run = spawnSync(process.execPath, [script, "--write", out], { cwd, encoding: "utf8" });
      expect(run.status).toBe(0);
      const written = readFileSync(out, "utf8");
      const root = path.resolve(import.meta.dir, "..", "..");
      expect(written).toContain(`Files replayed: ${replayRepository(root).length}.`);
      expect(written).toBe(replayReport(root));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a GIT_DIR exported by a hook does not redirect which files git lists", () => {
    const other = mkdtempSync(path.join(tmpdir(), "keryx-replay-other-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "keryx-replay-cwd-"));
    try {
      git(other, "init", "-q");
      const out = path.join(cwd, "out.md");
      const run = spawnSync(process.execPath, [path.resolve(import.meta.dir, "replay.ts"), "--write", out], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: path.join(other, ".git") },
      });
      expect(run.status).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(replayReport(path.resolve(import.meta.dir, "..", "..")));
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("--write without a target is an error", () => {
    const run = spawnSync(process.execPath, [path.resolve(import.meta.dir, "replay.ts"), "--write"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--write needs a target path");
  });
});

describe("legacyParseReviewResult", () => {
  test("a status-bearing object nested in a result is read as part of it, not as a later result", () => {
    const outer = { status: "DONE", reviewer: "review-logic", findings: [{ id: "F-1", status: "open" }] };
    expect(legacyParseReviewResult(`text ${JSON.stringify(outer)} tail`)).toEqual(outer);
  });

  test("reads the last labelled fence when there are two", () => {
    const first = { status: "DONE", reviewer: "first", findings: [] };
    const last = { status: "DONE", reviewer: "last", findings: [] };
    const text = `${T}REVIEW_RESULT\n${JSON.stringify(first)}\n${T}\n\n${T}REVIEW_RESULT\n${JSON.stringify(last)}\n${T}\n`;
    expect(legacyParseReviewResult(text)).toEqual(last);
  });

  test("takes the last of two sibling objects with a string status", () => {
    const text = `${JSON.stringify({ status: "A" })} and ${JSON.stringify({ status: "B" })}`;
    expect(legacyParseReviewResult(text)).toEqual({ status: "B" });
  });

  test("is only imported by the replay and its test", () => {
    const src = path.resolve(import.meta.dir, "..");
    const importers = (readdirSync(src, { recursive: true }) as string[])
      .filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes("node_modules"))
      .filter((file) => readFileSync(path.join(src, file), "utf8").includes("legacy-result-parser"))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual(["review/replay.test.ts", "review/replay.ts"]);
  });
});

describe("decisionFor", () => {
  const row = { file: "a/raw/x.txt", hash: "0123456789ab", old: "none", next: "none", same: true, cause: "none" as const };

  test("a row with the same outcome needs no decision, even when one is listed", () => {
    expect(decisionFor(row, { [decisionKey(row)]: "accepted" })).toBe("none");
    expect(decisionFor(row, {})).toBe("none");
  });

  test("a differing row takes the decision for its file and hash, else is undecided", () => {
    const differing = { ...row, same: false, cause: "unclassified" as const };
    expect(decisionFor(differing, { [decisionKey(differing)]: "accepted" })).toBe("accepted");
    expect(decisionFor(differing, {})).toBe("undecided");
  });
});

describe("closed review rounds of this repository", () => {
  const root = path.resolve(import.meta.dir, "..", "..");
  const reportPath = path.join(root, ".metaproject", "flows", "441-2026-10-13-deferred-majors-of-pr-940-and-pr-975", "replay-report.md");

  test("every tracked raw reply is replayed and the checked-in report lists exactly the differences", () => {
    const rows = replayRepository(root);
    expect(rows.length).toBeGreaterThan(0);
    expect(existsSync(reportPath)).toBe(true);
    const rendered = renderReplayReport(rows);
    if (readFileSync(reportPath, "utf8") !== rendered) {
      throw new Error(`replay-report.md is stale: regenerate it with \`bun src/review/replay.ts --write ${REPORT_PATH}\``);
    }
  });

  test("no difference is left unexplained by the classifier", () => {
    const unexplained = replayRepository(root).filter((row) => !row.same && row.cause === "unclassified");
    expect(unexplained.map((row) => row.file)).toEqual([]);
  });

  test("no difference is undecided: every one has an operator decision for its file and hash", () => {
    const differing = replayRepository(root).filter((row) => !row.same);
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.filter((row) => decisionFor(row) === "undecided").map((row) => row.file)).toEqual([]);
  });

  test("every decision belongs to a row that currently differs, so none is stale or mistyped", () => {
    const keys = replayRepository(root).filter((row) => !row.same).map(decisionKey).sort();
    expect(Object.keys(DECISIONS).sort()).toEqual(keys);
  });
});
