// AFC-10 (flow 234, phase 2): the graph "staleness" signal must actually track
// the five triggers the frozen AC3 names — new commit, untracked, delete,
// rename, config change — and a git failure must never collapse into "fresh".
//
// Before this task, `graphMaybeStale` compared `.git/HEAD`'s own mtime to
// `nodes.jsonl`'s. That misses every trigger here: `.git/HEAD` is a symbolic
// ref ("ref: refs/heads/<branch>") whose CONTENT (and often mtime) does not
// change on an ordinary commit to the current branch, and it never reflects
// untracked/deleted/renamed working-tree state or a config-file edit at all.
// These tests build a real git fixture per trigger (never the project repo
// itself) and assert against `checkGraphStaleness`'s structured result.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { checkGraphStaleness, graphMaybeStale } from "./staleness";
import { recordProvenance } from "../sync/provenance";

let root: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * A minimal built-graph fixture: a real git repo with one committed source
 * file, a `nodes.jsonl` "graph storage" file, and recorded build provenance
 * pointing at the current HEAD — i.e. the state right after a clean
 * `keryx gdgraph build` with nothing having moved since.
 */
async function makeBuiltFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-staleness-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(
    path.join(dir, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
    '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial build fixture"]);
  // `recordProvenance` reads `git rev-parse HEAD`, which fails with zero
  // commits — it must run AFTER the first commit exists, or it silently
  // no-ops (by design: "no-op outside a git repo", which a HEAD-less repo
  // with no commits yet also satisfies). It is deliberately left UNCOMMITTED
  // here, matching the real project's own state (`.provenance.json` sits
  // modified/untracked in the working tree right after every build) — the
  // staleness check must treat that as normal build residue, not a trigger.
  await recordProvenance(dir, "gdgraph", new Date().toISOString());
  // Ensure nodes.jsonl's mtime is not accidentally newer than a config file
  // written a moment later in the same test (mtime resolution on some
  // filesystems is coarse) by nudging it slightly into the past.
  const past = new Date(Date.now() - 5000);
  await utimes(path.join(dir, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"), past, past);
  return dir;
}

beforeEach(async () => {
  root = await makeBuiltFixture();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("AFC-10 control — a clean tree right after build reports fresh", async () => {
  const result = await checkGraphStaleness(root);
  expect(result.status).toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(false);
});

test("AFC-10 trigger 1/5 — a new commit since the build invalidates the snapshot", async () => {
  await writeFile(path.join(root, "src", "b.ts"), "export const b = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "a new commit after the graph was built"]);

  const result = await checkGraphStaleness(root);
  expect(result.status).not.toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 trigger 2/5 — an untracked file invalidates the snapshot", async () => {
  await writeFile(path.join(root, "src", "untracked.ts"), "export const u = 1;\n");

  const result = await checkGraphStaleness(root);
  expect(result.status).not.toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 trigger 3/5 — a deleted tracked file invalidates the snapshot", async () => {
  await rm(path.join(root, "src", "a.ts"));

  const result = await checkGraphStaleness(root);
  expect(result.status).not.toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 trigger 4/5 — a rename invalidates the snapshot even though file count and content are unchanged", async () => {
  // The subtle case: `git mv` keeps the file count and byte content identical
  // to the fixture's committed state — only the path moved.
  git(root, ["mv", "src/a.ts", "src/a-renamed.ts"]);

  const result = await checkGraphStaleness(root);
  expect(result.status).not.toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 trigger 5/5 — a gdgraph.config.json change invalidates the snapshot", async () => {
  await writeFile(
    path.join(root, ".metaproject", "gdgraph.config.json"),
    JSON.stringify({ affected: { defaultDepth: 2 } }) + "\n",
  );

  const result = await checkGraphStaleness(root);
  expect(result.status).not.toBe("fresh");
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 group 3 — a git failure is reported as unknown, never as fresh", async () => {
  // Delete the .git directory entirely so every git invocation the check
  // makes fails (spawn succeeds, git exits non-zero / "not a git repository").
  await rm(path.join(root, ".git"), { recursive: true, force: true });

  const result = await checkGraphStaleness(root);
  expect(result.status).toBe("unknown");
  expect(result.reasons.length).toBeGreaterThan(0);
  // The boolean back-compat wrapper must still never read as "fresh" (false)
  // on a git failure — "unknown" collapses to "treat as maybe-stale", not to
  // the safe-looking "false" the old mtime-diff check silently returned.
  expect(await graphMaybeStale(root)).toBe(true);
});

test("AFC-10 — graph never built at all is reported as stale (not fresh), not a git failure", async () => {
  await rm(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"));

  const result = await checkGraphStaleness(root);
  expect(result.status).toBe("stale");
  expect(await graphMaybeStale(root)).toBe(true);
});

// ---------------------------------------------------------------------------
// T19 finding 3 (flow 234 review) — `git status --porcelain` prints paths
// relative to the REPOSITORY ROOT, not to the directory git was invoked in.
// The `.metaproject/` exclusion in `categorizeStatusLines` compared a bare
// `.metaproject/` prefix against those repo-root-relative paths, which only
// ever matches when the project root IS the git root. In a monorepo where the
// project root sits below the git root, the prefix never matches, so the
// graph's own build residue (`.provenance.json`, `artifacts/*` — expected to
// sit modified/untracked right after every build) reads as a real untracked
// file and the graph reports stale immediately after every clean build.
// ---------------------------------------------------------------------------

test("AFC-10 / T19 finding 3 — at the git root, the .metaproject exclusion behaves exactly as before", async () => {
  // `root` (from `makeBuiltFixture`) already IS the git root — this is the
  // control case the fix must not change. `--show-prefix` there resolves to
  // "" and the fix must produce the identical "fresh" result as pre-fix.
  const result = await checkGraphStaleness(root);
  expect(result.status).toBe("fresh");
});

test("T19 finding 3 — a project root below the git root still excludes its own .metaproject build residue", async () => {
  const gitRoot = await mkdtemp(path.join(tmpdir(), "keryx-staleness-monorepo-"));
  try {
    git(gitRoot, ["init", "-q"]);
    git(gitRoot, ["config", "user.email", "test@test.com"]);
    git(gitRoot, ["config", "user.name", "test"]);

    const projectDir = path.join(gitRoot, "packages", "proj");
    await mkdir(path.join(projectDir, "src"), { recursive: true });
    await mkdir(path.join(projectDir, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(path.join(projectDir, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(
      path.join(projectDir, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
    );
    git(gitRoot, ["add", "-A"]);
    git(gitRoot, ["commit", "-q", "-m", "initial monorepo build fixture"]);

    // Mirrors `makeBuiltFixture`: `recordProvenance` leaves `.provenance.json`
    // UNCOMMITTED, exactly like a real `keryx gdgraph build` does — this is
    // the graph's own bookkeeping the exclusion exists to skip, and (per the
    // reviewer's repro) the ONLY dirty entry in the working tree here.
    await recordProvenance(projectDir, "gdgraph", new Date().toISOString());
    const past = new Date(Date.now() - 5000);
    await utimes(
      path.join(projectDir, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      past,
      past,
    );

    const result = await checkGraphStaleness(projectDir);
    // Before the fix: `git status --porcelain` (run with cwd=projectDir)
    // prints "packages/proj/.metaproject/data/gdgraph/.provenance.json",
    // which does not start with the bare ".metaproject/" prefix the old
    // check compared against — so it read as a real untracked file and this
    // was "stale" on a repo with nothing but the graph's own residue dirty.
    expect(result.status).toBe("fresh");
    expect(result.reasons).toEqual([]);
    expect(await graphMaybeStale(projectDir)).toBe(false);
  } finally {
    await rm(gitRoot, { recursive: true, force: true });
  }
});
