// LWG-4 freshness evaluation (flow 226): AC11, AC12, and the capping rule.

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../../gdgraph/types";
import { gitCmdResult, type GitCmdResult } from "../../sync/provenance";
import { computeVerifiedScope } from "../provenance";
import { evaluatePageFreshness, type GitRunner } from "./page-freshness";

const SHA = "a".repeat(40);

// `GitRunner` carries `GitCmdResult` rather than `string | null` (AFC-22,
// flow 236 T13): a fixture now has to say WHICH of the three events it is
// modelling, which is the point — `null` could not tell git refusing from git
// answering "no", and neither could the code reading it.
const ok = (stdout: string): GitCmdResult => ({ kind: "ok", stdout });
const refused = (stderr = "fatal: Not a valid object name"): GitCmdResult => ({ kind: "exit-error", code: 128, stderr });
const cannotRun = (): GitCmdResult => ({ kind: "spawn-error", message: "spawn git ENOENT" });

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

/**
 * A git that answers scripted commands and refuses the rest.
 *
 * `rev-parse` defaults to a healthy answer: it is the repository-health
 * re-probe `revisionExists` uses to tell a `cat-file` REFUSAL (AC12's "not in
 * this history") from a `cat-file` FAILURE, and the default models the normal
 * case where the repository is fine. A fixture that means "the repository is
 * broken" overrides it.
 */
function scriptedGit(script: Record<string, GitCmdResult>): GitRunner {
  return async (_cwd, args) => {
    const head = args[0] ?? "";
    const key = ["cat-file", "log", "diff", "rev-parse"].includes(head) ? head : args.join(" ");
    if (key in script) return script[key] as GitCmdResult;
    if (key === "rev-parse") return ok(".git");
    return refused();
  };
}

/** A git that is not there at all — every command fails to start. */
const noGit: GitRunner = async () => cannotRun();

describe("git-log basis", () => {
  test("counts commits behind and names the changed files", async () => {
    const { cwd, graph, paths } = await fixture();
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: null },
      describePaths: paths,
      graph,
      git: scriptedGit({ "cat-file": ok(""), log: ok("c1\nc2\nc3"), diff: ok("src/a.ts") }),
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
      if (args[0] === "cat-file") return ok("");
      if (args[0] === "log") return ok("");
      return refused();
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
      git: scriptedGit({ "cat-file": refused(), log: ok("c1") }),
      graph,
    });
    expect(result.basis).toBe("scope-hash");
    expect(result.changed).toBe(false);
  });

});

// Flow 236, phase 4, T7 (AFC-22 clause 2 / AFC-W05 clause 3: "a git failure
// yields unknown"). Before this task, a `git log`/`git diff` call that FAILED
// outright — as opposed to succeeding with zero matching commits — was
// indistinguishable from "this page has no git evidence at all" and silently
// fell through to the scope-hash basis, dressing a measurement that never ran
// as a legitimate (if weaker) result. And when git could not be asked at all
// (the `revisionExists` cat-file check itself failing) the old code read that
// as AC12's "revision not reachable in this history" and fell through the
// same way — collapsing "git is broken" into "nobody verified this page yet".
describe("a git failure yields unknown (AFC-22 clause 2 / AFC-W05 clause 3)", () => {
  test("git present and the revision resolves, but `git log` itself fails: undecidable, not scope-hash", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: scope },
      describePaths: paths,
      graph,
      // cat-file succeeds (revision exists), but log fails outright — this
      // is NOT the same event as log succeeding with zero commits (""),
      // which is a legitimate, confirmed "unchanged" answer tested above.
      git: scriptedGit({ "cat-file": ok(""), log: refused("fatal: bad object") }),
    });
    expect(result.basis).toBe("undecidable");
    expect(result.changed).toBe(false);
    expect(result.gitFailure).toBeDefined();
  });

  test("`git log` finds commits but the follow-up `git diff` fails: undecidable, not a half-reported git-log result", async () => {
    const { cwd, graph, paths } = await fixture();
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: null },
      describePaths: paths,
      graph,
      git: scriptedGit({ "cat-file": ok(""), log: ok("c1\nc2"), diff: refused("fatal: bad object") }),
    });
    expect(result.basis).toBe("undecidable");
    expect(result.gitFailure).toBeDefined();
  });

  test("git wholly unavailable this run (gitAvailable: false) never silently uses scope-hash for a verified page", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: scope },
      describePaths: paths,
      graph,
      // Even a git that WOULD answer everything correctly must not be
      // consulted once the caller has established git could not be asked
      // this run (the up-front `rev-parse HEAD` probe failed).
      git: scriptedGit({ "cat-file": ok(""), log: ok(""), diff: ok("") }),
      gitAvailable: false,
    });
    expect(result.basis).toBe("undecidable");
    expect(result.changed).toBe(false);
    expect(result.gitFailure).toBeDefined();
  });

  test("git wholly unavailable this run does NOT affect a page with no VerifiedAt at all (scope-hash is git-independent)", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: null, verifiedScope: scope },
      describePaths: paths,
      graph,
      git: noGit,
      gitAvailable: false,
    });
    expect(result.basis).toBe("scope-hash");
    expect(result.gitFailure).toBeUndefined();
  });

  test("a VerifiedAt this history has never heard of (AC12) is still preserved — not confused with a git failure", async () => {
    const { cwd, graph, paths } = await fixture();
    const scope = await computeVerifiedScope(cwd, paths, graph);
    const result = await evaluatePageFreshness({
      cwd,
      page: { path: "components/x.md", verifiedAt: SHA, verifiedScope: scope },
      describePaths: paths,
      graph,
      // git IS available and DID answer cat-file — it just said "no". That
      // is AC12's legitimate fallthrough, not a failure.
      git: scriptedGit({ "cat-file": refused(), log: ok("c1") }),
      gitAvailable: true,
    });
    expect(result.basis).toBe("scope-hash");
    expect(result.gitFailure).toBeUndefined();
  });
});

// AFC-22 (flow 236 T13, F236-01). The scripted fixtures above model the
// distinction; these INDUCE it, in a real repository, through the real
// `gitCmdResult`. That matters because the defect was invisible to a mock:
// `cat-file -e <rev>^{commit}` exits 128 both for "not in this history" and
// for "this repository cannot be read", so only a real repository being
// broken in a real way shows that the old `result !== null` read the second
// as the first. Each test below fails on the pre-fix code with
// `basis: "scope-hash"` and no `gitFailure` — the measured before-state.
describe("a REAL git failure after the up-front probe (F236-01)", () => {
  async function realRepo(): Promise<{ cwd: string; head: string; graph: GraphData; paths: string[] }> {
    const cwd = await mkdtemp(path.join(tmpdir(), "lwg-fresh-real-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src/a.ts"), "export const a = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd });
    execFileSync("git", ["config", "user.name", "test"], { cwd });
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const paths = ["src/a.ts"];
    return {
      cwd,
      head,
      paths,
      graph: {
        nodes: paths.map((p) => ({ id: p, kind: "file" as const, path: p, language: "typescript" as const })),
        edges: [],
      },
    };
  }

  async function evaluateWithRealGit(cwd: string, head: string, graph: GraphData, paths: string[]) {
    return evaluatePageFreshness({
      cwd,
      // A `VerifiedScope` that does NOT match, so the pre-fix fallthrough
      // produced a confident-looking `changed: true` rather than a harmless
      // one — the exact shape the finding measured.
      page: { path: "architecture/overview.md", verifiedAt: head, verifiedScope: `sha256:${"0".repeat(64)}` },
      describePaths: paths,
      graph,
      git: gitCmdResult,
      // The up-front probe succeeded: this is a run that STARTED healthy.
      gitAvailable: true,
    });
  }

  test("the repository is removed mid-run: undecidable with a gitFailure, never a scope-hash measurement", async () => {
    const { cwd, head, graph, paths } = await realRepo();
    try {
      expect((await gitCmdResult(cwd, ["rev-parse", "HEAD"])).kind).toBe("ok");
      await rm(path.join(cwd, ".git"), { recursive: true, force: true });

      const result = await evaluateWithRealGit(cwd, head, graph, paths);
      expect(result.basis).toBe("undecidable");
      expect(result.changed).toBe(false);
      expect(result.gitFailure).toBeDefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the object store becomes unreadable mid-run: undecidable with a gitFailure", async () => {
    const { cwd, head, graph, paths } = await realRepo();
    try {
      expect((await gitCmdResult(cwd, ["rev-parse", "HEAD"])).kind).toBe("ok");
      await chmod(path.join(cwd, ".git", "objects"), 0o000);

      const result = await evaluateWithRealGit(cwd, head, graph, paths);
      expect(result.basis).toBe("undecidable");
      expect(result.gitFailure).toBeDefined();
    } finally {
      await chmod(path.join(cwd, ".git", "objects"), 0o755).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a HEALTHY repository asked about a revision it genuinely does not contain still falls through to scope-hash (AC12 is not collateral damage)", async () => {
    const { cwd, graph, paths } = await realRepo();
    try {
      const result = await evaluateWithRealGit(cwd, "b".repeat(40), graph, paths);
      expect(result.basis).toBe("scope-hash");
      expect(result.gitFailure).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
      git: scriptedGit({ "cat-file": ok(""), log: ok("c1") }),
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
