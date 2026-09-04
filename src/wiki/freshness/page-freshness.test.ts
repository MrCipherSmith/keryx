// LWG-4 freshness evaluation (flow 226): AC11, AC12, and the capping rule.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../../gdgraph/types";
import { computeVerifiedScope } from "../provenance";
import { evaluatePageFreshness, type GitRunner } from "./page-freshness";

const SHA = "a".repeat(40);

async function fixture(): Promise<{ cwd: string; graph: GraphData; paths: string[] }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-fresh-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
  await writeFile(path.join(cwd, "src/b.ts"), "export const b = 2;\n");
  const paths = ["src/a.ts", "src/b.ts"];
  return {
    cwd,
    paths,
    graph: {
      nodes: paths.map((p) => ({ id: p, kind: "file" as const, path: p, language: "typescript" as const })),
      edges: [],
    },
  };
}

/** A git that answers scripted commands and returns null for the rest. */
function scriptedGit(script: Record<string, string | null>): GitRunner {
  return async (_cwd, args) => {
    const key = args[0] === "cat-file" ? "cat-file" : args[0] === "log" ? "log" : args[0] === "diff" ? "diff" : args.join(" ");
    return key in script ? (script[key] as string | null) : null;
  };
}

/** A git that is not there at all — every command fails. */
const noGit: GitRunner = async () => null;

describe("git-log basis", () => {
  test("counts commits behind and names the changed files", async () => {
    const { cwd, graph, paths } = await fixture();
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: null },
      describePaths: paths,
      graph,
      git: scriptedGit({ "cat-file": "", log: "c1\nc2\nc3", diff: "src/a.ts" }),
    });

    expect(result.basis).toBe("git-log");
    expect(result.changed).toBe(true);
    expect(result.commitsBehind).toBe(3);
    expect(result.changedFiles).toEqual(["src/a.ts"]);
    // Only this basis may claim the strongest category.
    expect(result.confidenceCap).toBe("must-refresh");
  });

  test("an empty log is `unchanged`, and asks git for no file list", async () => {
    const { cwd, graph, paths } = await fixture();
    let askedForDiff = false;
    const git: GitRunner = async (_cwd, args) => {
      if (args[0] === "diff") askedForDiff = true;
      if (args[0] === "cat-file") return "";
      if (args[0] === "log") return "";
      return null;
    };
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: null },
      describePaths: paths,
      graph,
      git,
    });
    expect(result.changed).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(askedForDiff).toBe(false);
  });
});

describe("scope-hash basis (AC11)", () => {
  test("with no git at all, the hash path decides and caps confidence", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);

    const unchanged = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: null, verifiedScope: scope },
      describePaths: paths,
      graph,
      git: noGit,
    });
    expect(unchanged.basis).toBe("scope-hash");
    expect(unchanged.changed).toBe(false);
    // A binary verdict must not dress itself as the strongest measurement.
    expect(unchanged.confidenceCap).toBe("review-suggested");

    await writeFile(path.join(cwd, "src/b.ts"), "export const b = 99;\n");
    const changed = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: null, verifiedScope: scope },
      describePaths: paths,
      graph,
      git: noGit,
    });
    expect(changed.changed).toBe(true);
    expect(changed.commitsBehind).toBe(0);
  });

  test("a VerifiedAt this history has never heard of falls through, not errors (AC12)", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: scope },
      describePaths: paths,
      // git exists, but the revision is unreachable: cat-file fails.
      git: scriptedGit({ "cat-file": null, log: "c1" }),
      graph,
    });
    expect(result.basis).toBe("scope-hash");
    expect(result.changed).toBe(false);
  });

  test("git present but the log command itself fails still falls back", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: scope },
      describePaths: paths,
      graph,
      git: scriptedGit({ "cat-file": "", log: null }),
    });
    expect(result.basis).toBe("scope-hash");
  });
});

describe("undecidable", () => {
  test("an empty describe-set is undecidable and never claims freshness", async () => {
    const { cwd, graph } = await fixture();
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "architecture/overview.md", verifiedAt: SHA, verifiedScope: null },
      describePaths: [],
      graph,
      git: scriptedGit({ "cat-file": "", log: "c1" }),
    });
    expect(result.basis).toBe("undecidable");
    // `changed: false` here means "no evidence", and the report must not read
    // it as "verified correct".
    expect(result.changed).toBe(false);
  });

  test("no provenance at all is undecidable, not fresh", async () => {
    const { cwd, graph, paths } = await fixture();
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: null, verifiedScope: null },
      describePaths: paths,
      graph,
      git: noGit,
    });
    expect(result.basis).toBe("undecidable");
  });
});
