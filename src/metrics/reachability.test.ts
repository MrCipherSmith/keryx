import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkAnswerReachability } from "./leakage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-reachability-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A worktree an arm may legitimately be run in: it has ordinary source, and
 * nowhere in it is the answer to the task.
 */
async function writeCleanWorktree(): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "beta.ts"), "export const beta = 2;\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# a repo\n", "utf8");
}

const NEEDLE = "resolveGammaOffset";

describe("checkAnswerReachability", () => {
  test("a clean worktree with no answer anywhere in it passes", async () => {
    await writeCleanWorktree();
    const report = checkAnswerReachability(root, {
      goldArtifactPaths: ["scripts/benchmark/ablation-tasks.ts"],
      answerNeedles: [NEEDLE],
    });
    expect(report.status).toBe("clean");
    expect(report.reachable).toEqual([]);
    expect(report.scannedFiles).toBeGreaterThan(0);
  });

  test("a gold artifact file left in the worktree is reachable", async () => {
    await writeCleanWorktree();
    await mkdir(path.join(root, "scripts", "benchmark"), { recursive: true });
    await writeFile(path.join(root, "scripts", "benchmark", "ablation-tasks.ts"), "export const tasks = [];\n", "utf8");

    const report = checkAnswerReachability(root, {
      goldArtifactPaths: ["scripts/benchmark/ablation-tasks.ts"],
      answerNeedles: [NEEDLE],
    });
    expect(report.status).toBe("reachable");
    expect(report.reachable.map((hit) => hit.kind)).toContain("path");
  });

  // The clause that matters most: the answer need not be in a file named "gold".
  // It only has to be *present in what the system under test can see*.
  test("the answer text sitting in an ordinary source file is reachable", async () => {
    await writeCleanWorktree();
    await writeFile(path.join(root, "src", "notes.ts"), `// fix is in ${NEEDLE}\n`, "utf8");

    const report = checkAnswerReachability(root, { answerNeedles: [NEEDLE] });
    expect(report.status).toBe("reachable");
    const hit = report.reachable.find((entry) => entry.kind === "content");
    expect(hit?.where).toBe("src/notes.ts");
    expect(hit?.needle).toBe(NEEDLE);
  });

  test("the answer pre-written into the wiki is reachable and attributed to the wiki", async () => {
    await writeCleanWorktree();
    await mkdir(path.join(root, ".metaproject", "wiki"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "wiki", "domain.md"), `call ${NEEDLE} to fix it\n`, "utf8");

    const report = checkAnswerReachability(
      root,
      { answerNeedles: [NEEDLE], wikiDirs: [".metaproject/wiki"] },
      { extensions: [".ts", ".md"] },
    );
    expect(report.status).toBe("reachable");
    expect(report.reachable.map((hit) => hit.kind)).toContain("wiki");
  });

  // Three import guards in this repository passed with their scan pointed at an
  // empty directory. A scan that saw nothing has not cleared anything.
  test("a scan that matched no files is unverified, never clean", async () => {
    await mkdir(path.join(root, "empty"), { recursive: true });
    const report = checkAnswerReachability(path.join(root, "empty"), { answerNeedles: [NEEDLE] });
    expect(report.status).toBe("unverified");
    expect(report.scannedFiles).toBe(0);
  });

  test("a root that does not exist is unverified, never clean", () => {
    const report = checkAnswerReachability(path.join(root, "gone"), { answerNeedles: [NEEDLE] });
    expect(report.status).toBe("unverified");
  });

  test("a spec with nothing to look for is unverified, never clean", async () => {
    await writeCleanWorktree();
    expect(checkAnswerReachability(root, {}).status).toBe("unverified");
    expect(checkAnswerReachability(root, { answerNeedles: ["", "  "] }).status).toBe("unverified");
  });

  test("a scan truncated by its own file cap is unverified, never clean", async () => {
    await writeCleanWorktree();
    const report = checkAnswerReachability(root, { answerNeedles: [NEEDLE] }, { maxFiles: 1 });
    expect(report.status).toBe("unverified");
    expect(report.problems.join(" ")).toContain("truncated");
  });

  test("a file too large to read is reported, not silently skipped as clean", async () => {
    await writeCleanWorktree();
    await writeFile(path.join(root, "src", "huge.ts"), "x".repeat(4096), "utf8");
    const report = checkAnswerReachability(root, { answerNeedles: [NEEDLE] }, { maxFileBytes: 1024 });
    expect(report.status).toBe("unverified");
    expect(report.problems.join(" ")).toContain("huge.ts");
  });

  test("noise directories are skipped without making the scan unverified", async () => {
    await writeCleanWorktree();
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.ts"), `${NEEDLE}\n`, "utf8");
    const report = checkAnswerReachability(root, { answerNeedles: [NEEDLE] });
    expect(report.status).toBe("clean");
  });
});
