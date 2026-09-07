// `runFreshness` (LWG-10 orchestration) — flow 236, phase 4, T7 (AFC-22
// clause 2 / AFC-W05 clause 3: "a git failure yields unknown").
//
// Before this task, the ONLY signal that git was unavailable came from a
// single up-front `rev-parse HEAD` probe done here and reported as a fixed,
// generic `not-a-git-repository` limitation whose text ("fell back to
// VerifiedScope comparison") no longer matches what actually happens: pages
// with a VerifiedAt now report `unknown` instead of silently using the
// weaker VerifiedScope basis. These tests drive `runFreshness` end to end
// against a REAL temporary git repository (never the project repo itself,
// never `keryx wiki freshness` on this tree) so the exact probe this
// function performs is exercised for real, not simulated.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runFreshness } from "./run";

let root: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function makeFixture(): Promise<{ verifiedAt: string }> {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.com"]);
  git(root, ["config", "user.name", "t"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "core.ts"), "export const core = 1;\n");

  const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    `${JSON.stringify({ id: "src/core.ts", kind: "file", path: "src/core.ts", language: "typescript" })}\n`,
  );

  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  const verifiedAt = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

  const dir = path.join(root, ".metaproject", "wiki", "components");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "core.md"),
    [
      "# src/core",
      "Version: 1.0.0",
      "Type: component",
      "Status: accepted",
      `VerifiedAt: ${verifiedAt}`,
      "Describes:",
      "  - src/core.ts",
      "",
      "## Overview",
      "",
      "The core module.",
      "",
    ].join("\n"),
  );

  return { verifiedAt };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-run-freshness-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a healthy repository reports the verified page fresh, with no git-failure limitation", async () => {
  await makeFixture();

  const report = await runFreshness({ cwd: root });

  expect(report.limitations.map((l) => l.code)).not.toContain("not-a-git-repository");
  expect(report.totals.pagesFresh).toBe(1);
});

test("a repository whose .git was removed mid-run declares not-a-git-repository and reports the page unknown, never fresh", async () => {
  await makeFixture();
  // Simulate git having gone away entirely for this run (corruption,
  // permission loss, a mount disappearing) rather than "never a repo at
  // all" — this repository WAS git-tracked; deleting `.git` makes every
  // subsequent invocation fail the same way `staleness.test.ts` uses to
  // exercise the same class of failure for the graph check.
  await rm(path.join(root, ".git"), { recursive: true, force: true });

  const report = await runFreshness({ cwd: root });

  expect(report.limitations.map((l) => l.code)).toContain("not-a-git-repository");
  const limitation = report.limitations.find((l) => l.code === "not-a-git-repository");
  // The detail text must describe what ACTUALLY happens now (unknown), not
  // the old text this task retired ("fell back to VerifiedScope comparison").
  expect(limitation?.detail).toContain("unknown");
  expect(limitation?.detail).not.toContain("fell back to VerifiedScope");

  expect(report.pages[0]?.category).toBe("unknown");
  expect(report.pages[0]?.gitFailure).toBeDefined();
  expect(report.totals.pagesFresh).toBe(0);
});

test("the not-a-git-repository limitation is never duplicated (report.ts is now the single source)", async () => {
  await makeFixture();
  await rm(path.join(root, ".git"), { recursive: true, force: true });

  const report = await runFreshness({ cwd: root });

  const occurrences = report.limitations.filter((l) => l.code === "not-a-git-repository");
  expect(occurrences.length).toBe(1);
});
