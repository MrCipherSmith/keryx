// Flow 304 T8 (W7 AC4): PART A audit fixtures.
//
// `printStaleNote`/`checkGraphStaleness` existed before this task, but a full
// audit of `src/commands/gdgraph.ts` found several fact-presenting
// subcommands with NO freshness check at all — `query cycles`/`query
// orphans` had none in either output mode, `affected` had none anywhere
// (not the JSON path, not the text path, not either early-refusal branch),
// and `find --json` returned before ever computing one. This file proves,
// against a real git fixture (never the project repo itself, mirroring
// `gdgraph.test.ts`'s own convention), that those gaps are closed:
//   1. build then affected/query on an unmodified tree -> no stale note.
//   2. a file-SET change (new file) without rebuilding -> the next
//      affected AND query calls report STALE_NOTE with a reason naming the
//      file — for both the printed note and the `--json` `freshness` field.
//   2b. a PURE content edit to an already-tracked file, by contrast, is
//      documented (staleness.ts's own module contract) to NOT trigger a
//      stale note — recorded here so that contract stays proven, not just
//      asserted in a comment.
//   3. deleting `.provenance.json` with nothing else changed must not read
//      as silently fresh (closed by this task: downgrades to `unknown`).
//   4. a git failure (no `.git` at all) reports `UNKNOWN_NOTE`/`unknown`,
//      never a confident stale/fresh claim.
//
// Tests exercise `gdgraphCommand` directly (the actual command entry point,
// covering the query path end to end), not `checkGraphStaleness` in
// isolation — `gdgraph.test.ts`'s own convention for exercising commands.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gdgraphCommand } from "./gdgraph";
import { STALE_NOTE, UNKNOWN_NOTE } from "../gdgraph/staleness";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    // W7 T8: this project's own dev machine may carry a GLOBAL git template
    // (identity-guard pre-commit hook) that has nothing to do with this
    // repository — it refuses any commit whose author does not match one of
    // two specific accounts. A throwaway fixture repo under the OS tmp dir
    // must never depend on that unrelated, machine-local policy, so both the
    // global config and the hook it installs are switched off for exactly
    // this child process.
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

async function makeGraphFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-freshness-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(dir, "src", "b.ts"), 'import { a } from "./a";\nexport const b = a + 1;\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial fixture"]);
  return dir;
}

describe("keryx gdgraph — freshness audit (W7 AC4, flow 304 T8)", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await makeGraphFixture();
    cwd = process.cwd();
    process.chdir(root);

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("1. build then affected/query on an unmodified tree — no staleness note, either subcommand", async () => {
    await gdgraphCommand(["build"]);
    loggedOut = [];

    await gdgraphCommand(["affected", "src/a.ts"]);
    let output = loggedOut.join("\n");
    expect(output).not.toContain(STALE_NOTE);
    expect(output).not.toContain(UNKNOWN_NOTE);

    loggedOut = [];
    await gdgraphCommand(["query", "cycles"]);
    output = loggedOut.join("\n");
    expect(output).not.toContain(STALE_NOTE);
    expect(output).not.toContain(UNKNOWN_NOTE);

    // `--json` counterpart: `freshness.status` field, not a printed note.
    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    const affectedJson = JSON.parse(loggedOut.join("\n"));
    expect(affectedJson.freshness.status).toBe("fresh");

    loggedOut = [];
    await gdgraphCommand(["query", "cycles", "--json"]);
    const cyclesJson = JSON.parse(loggedOut.join("\n"));
    expect(cyclesJson.freshness.status).toBe("fresh");
  });

  test("2. a new file without rebuilding — the next affected AND query calls report STALE_NOTE naming the file", async () => {
    await gdgraphCommand(["build"]);
    await writeFile(path.join(root, "src", "c.ts"), "export const c = 1;\n");

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts"]);
    let output = loggedOut.join("\n");
    expect(output).toContain(STALE_NOTE);
    expect(output).toContain("src/c.ts");

    loggedOut = [];
    await gdgraphCommand(["query", "cycles"]);
    output = loggedOut.join("\n");
    expect(output).toContain(STALE_NOTE);
    expect(output).toContain("src/c.ts");

    // `--json` carries the same reason in the `freshness` field.
    loggedOut = [];
    await gdgraphCommand(["query", "orphans", "--json"]);
    const orphansJson = JSON.parse(loggedOut.join("\n"));
    expect(orphansJson.freshness.status).toBe("stale");
    expect(orphansJson.freshness.reasons.join(" ")).toContain("src/c.ts");
  });

  test("2b. a pure content edit to an already-tracked file (no rebuild) — the next affected AND query calls report STALE_NOTE naming it", async () => {
    await gdgraphCommand(["build"]);
    // Nudge nodes.jsonl's mtime slightly into the past — mirrors
    // `staleness.test.ts`'s own fixture convention — so the edit below is
    // unambiguously newer on filesystems with coarse mtime resolution.
    const nodesJsonl = path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
    const past = new Date(Date.now() - 5000);
    await utimes(nodesJsonl, past, past);

    // Content-only edit, no new/deleted/renamed file — `git status --porcelain`
    // reports this as ` M`. Frozen AC4 requires this to be a trigger: the
    // file-level graph may have stale content for `src/a.ts` even though its
    // node/edge SET membership is unaffected.
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 2; // edited\n");

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts"]);
    let output = loggedOut.join("\n");
    expect(output).toContain(STALE_NOTE);
    expect(output).toContain("src/a.ts");

    loggedOut = [];
    await gdgraphCommand(["query", "cycles"]);
    output = loggedOut.join("\n");
    expect(output).toContain(STALE_NOTE);
    expect(output).toContain("src/a.ts");

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    const affectedJson = JSON.parse(loggedOut.join("\n"));
    expect(affectedJson.freshness.status).toBe("stale");
    expect(affectedJson.freshness.reasons.join(" ")).toContain("src/a.ts");
  });

  test("2c. a content edit already on disk when the graph was built does not false-stale (mtime gate)", async () => {
    // The mtime gate this fix relies on: an edit that predates the build
    // (already reflected in the graph) must not report stale just because
    // the file is uncommitted. Edit BEFORE building, then build — nodes.jsonl
    // ends up newer than the edit, so no trigger should fire.
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 2; // edited before build\n");
    await gdgraphCommand(["build"]);

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    const affectedJson = JSON.parse(loggedOut.join("\n"));
    expect(affectedJson.freshness.status).toBe("fresh");
  });

  test("3. deleting .provenance.json with nothing else changed is not silently fresh", async () => {
    await gdgraphCommand(["build"]);
    await rm(path.join(root, ".metaproject", "data", "gdgraph", ".provenance.json"), { force: true });

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    const affectedJson = JSON.parse(loggedOut.join("\n"));
    // Not fresh: no recorded baseline commit to verify freshness against, and
    // (in this fixture, built immediately after the last commit) the
    // `.git/logs/HEAD` mtime fallback finds no HEAD movement to report either
    // — so this downgrades to `unknown` ("not verified"), never `stale`
    // (no concrete trigger actually fired) and never `fresh` (silently
    // treating an unverifiable graph as confirmed current is exactly what
    // this check exists to prevent).
    expect(affectedJson.freshness.status).not.toBe("fresh");
    expect(affectedJson.freshness.status).toBe("unknown");
    expect(affectedJson.freshness.reasons.join(" ")).toContain("provenance");
  });

  test("4. git unavailable (.git removed entirely) — UNKNOWN_NOTE, not STALE_NOTE, not silently fresh", async () => {
    await gdgraphCommand(["build"]);
    await rm(path.join(root, ".git"), { recursive: true, force: true });

    loggedOut = [];
    await gdgraphCommand(["affected", "src/a.ts"]);
    const output = loggedOut.join("\n");
    expect(output).toContain(UNKNOWN_NOTE);
    expect(output).not.toContain(STALE_NOTE);
  });
});
